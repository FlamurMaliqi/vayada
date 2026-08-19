"""
Financials section for the PMS — guest invoices + payment ledger.

Invoices are derived from bookings; the only persisted side-effect a
hotel admin can take here is recording a payment, which writes to the
payments table and updates bookings.payment_status.

Out-of-scope work tracked separately: VAY-301 (manual invoices),
VAY-302 (PDF / Resend / Credit Note / Void), VAY-303 (FX), VAY-304 (tax).
"""

import csv
import io
import logging
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from app.channels import is_ota_channel
from app.database import Database
from app.dependencies import require_hotel_admin
from app.models.financials import (
    FinancialsSummary,
    InvoiceDetail,
    InvoiceListResponse,
    PaymentLedgerEntry,
    PaymentLedgerResponse,
    RecordPaymentRequest,
)
from app.repositories.booking_repo import BookingRepository
from app.repositories.payment_repo import PaymentRepository
from app.services.guest_contact_access import (
    fetch_guest_contact_plan,
    mask_booking_guest_contacts,
)
from app.services.invoice_service import (
    _amount_paid,
    derive_payment_status,
    derive_status,
    filter_invoices_by_status,
    index_payments_by_booking,
    status_counts,
    to_detail,
    to_ledger_entry,
    to_list_item,
)
from app.utils import get_hotel_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/financials", tags=["admin-financials"])


VALID_STATUSES = {"draft", "sent", "paid", "partial", "overdue", "voided"}


async def _load_invoice_pairs(
    hotel_id: str,
    *,
    search: str | None = None,
    fetch_limit: int = 500,
) -> list[tuple[dict, list[dict]]]:
    """Load (booking, payments) pairs for a hotel.

    Status filtering is applied in Python because the invoice status is
    derived (not a column). `fetch_limit` caps how many bookings come
    back; pagination + counts are computed against the derived list.
    """
    plan = await fetch_guest_contact_plan(hotel_id)
    bookings = await BookingRepository.list_by_hotel_id(
        hotel_id,
        search=search,
        hide_unaccepted_guest_contact=plan == "commission",
        limit=fetch_limit,
        offset=0,
    )
    if not bookings:
        return []
    booking_ids = [str(b["id"]) for b in bookings]
    payments = await PaymentRepository.list_by_booking_ids(booking_ids)
    grouped = index_payments_by_booking(payments)
    return [(mask_booking_guest_contacts(b, plan), grouped.get(str(b["id"]), [])) for b in bookings]


@router.get("/summary", response_model=FinancialsSummary)
async def get_summary(user_id: str = Depends(require_hotel_admin)):
    hotel_id = await get_hotel_id(user_id)
    today = date.today()
    month_start = today.replace(day=1)
    if month_start.month == 1:
        prev_start = month_start.replace(year=month_start.year - 1, month=12)
    else:
        prev_start = month_start.replace(month=month_start.month - 1)

    rows = await Database.fetch(
        """
        SELECT b.total_amount, b.currency, b.created_at, b.status, b.check_in,
               b.channel, b.payment_status,
               COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('captured', 'authorized')), 0) AS paid
        FROM bookings b
        LEFT JOIN payments p ON p.booking_id = b.id
        WHERE b.hotel_id = $1
          AND b.created_at >= $2
        GROUP BY b.id
        """,
        hotel_id,
        prev_start,
    )

    revenue_mtd = 0.0
    revenue_prev = 0.0
    outstanding = 0.0
    overdue_count = 0
    currency = "EUR"
    for r in rows:
        currency = r["currency"]
        created = r["created_at"]
        total = float(r["total_amount"] or 0)
        paid = float(r["paid"] or 0)
        # Only accepted (confirmed) bookings contribute. Pending host-response
        # requests can still expire or be rejected, so counting their
        # total_amount (which already includes addon/upsell revenue) would
        # show revenue for stays that may never happen — VAY-334.
        if r["status"] != "confirmed":
            continue
        if created.date() >= month_start:
            revenue_mtd += total
        elif created.date() >= prev_start:
            revenue_prev += total
        # OTA bookings are settled by the platform — don't count them as
        # outstanding or overdue unless an admin explicitly overrode
        # payment_status to 'unpaid' (VAY-490).
        ota_settled = is_ota_channel(r["channel"]) and r["payment_status"] != "unpaid"
        if ota_settled:
            continue
        outstanding += max(0.0, total - paid)
        check_in = r["check_in"]
        if isinstance(check_in, date) and check_in < today and paid + 0.01 < total:
            overdue_count += 1

    delta_pct: float | None = None
    if revenue_prev > 0:
        delta_pct = round((revenue_mtd - revenue_prev) / revenue_prev * 100, 1)

    return FinancialsSummary(
        revenue_mtd=round(revenue_mtd, 2),
        revenue_mtd_delta_pct=delta_pct,
        outstanding=round(outstanding, 2),
        overdue_count=overdue_count,
        currency=currency,
    )


@router.get("/invoices", response_model=InvoiceListResponse)
async def list_invoices(
    status: str | None = Query(None),
    search: str | None = Query(None),
    sort: str = Query("date", pattern="^(date|guest|amount)$"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user_id: str = Depends(require_hotel_admin),
):
    if status is not None and status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {status}")

    hotel_id = await get_hotel_id(user_id)
    pairs = await _load_invoice_pairs(hotel_id, search=search)
    counts = status_counts(pairs)
    filtered = filter_invoices_by_status(pairs, status)

    if sort == "guest":
        filtered.sort(
            key=lambda p: (p[0]["guest_last_name"].lower(), p[0]["guest_first_name"].lower())
        )
    elif sort == "amount":
        filtered.sort(key=lambda p: float(p[0]["total_amount"]), reverse=True)
    else:
        filtered.sort(key=lambda p: p[0]["created_at"], reverse=True)

    total = len(filtered)
    paged = filtered[offset : offset + limit]
    return InvoiceListResponse(
        invoices=[to_list_item(b, p) for b, p in paged],
        total=total,
        counts=counts,
        limit=limit,
        offset=offset,
    )


async def _load_invoice_or_404(hotel_id: str, booking_id: str) -> tuple[dict, list[dict]]:
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise HTTPException(status_code=404, detail="Invoice not found")
    payments = await PaymentRepository.list_by_booking_ids([booking_id])
    plan = await fetch_guest_contact_plan(hotel_id)
    return mask_booking_guest_contacts(booking, plan), payments


@router.get("/invoices/export.csv")
async def export_invoices_csv(
    status: str | None = Query(None),
    search: str | None = Query(None),
    user_id: str = Depends(require_hotel_admin),
):
    if status is not None and status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {status}")

    hotel_id = await get_hotel_id(user_id)
    pairs = await _load_invoice_pairs(hotel_id, search=search)
    filtered = filter_invoices_by_status(pairs, status)
    filtered.sort(key=lambda p: p[0]["created_at"], reverse=True)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        [
            "Invoice #",
            "Booking #",
            "Guest",
            "Email",
            "Check-in",
            "Check-out",
            "Room",
            "Currency",
            "Total",
            "Amount Paid",
            "Balance Due",
            "Status",
            "Issued At",
        ]
    )
    for booking, payments in filtered:
        item = to_list_item(booking, payments)
        writer.writerow(
            [
                item.invoice_number,
                item.booking_reference,
                f"{item.guest_first_name} {item.guest_last_name}",
                item.guest_email,
                item.check_in,
                item.check_out,
                f"#{item.room_number} · {item.room_name}" if item.room_number else item.room_name,
                item.currency,
                f"{item.total_amount:.2f}",
                f"{item.amount_paid:.2f}",
                f"{item.balance_due:.2f}",
                item.status,
                item.issued_at,
            ]
        )

    buf.seek(0)
    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    filename = f"invoices-{timestamp}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/invoices/{booking_id}", response_model=InvoiceDetail)
async def get_invoice(
    booking_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking, payments = await _load_invoice_or_404(hotel_id, booking_id)
    return to_detail(booking, payments)


@router.post("/invoices/{booking_id}/payments", response_model=InvoiceDetail, status_code=201)
async def record_payment(
    booking_id: str,
    data: RecordPaymentRequest,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    booking, payments = await _load_invoice_or_404(hotel_id, booking_id)

    paid_so_far = _amount_paid(payments)
    total = float(booking["total_amount"])
    balance = round(total - paid_so_far, 2)
    if balance <= 0:
        raise HTTPException(status_code=400, detail="Invoice has no outstanding balance")
    if data.amount > balance + 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"Amount {data.amount:.2f} exceeds outstanding balance {balance:.2f}",
        )

    await PaymentRepository.create_manual(
        booking_id=booking_id,
        amount=data.amount,
        currency=booking["currency"],
        payment_method=data.payment_method,
        reference=data.reference,
        recorded_by=user_id,
    )

    payments_after = await PaymentRepository.list_by_booking_ids([booking_id])
    new_paid = _amount_paid(payments_after)
    new_status = derive_payment_status(total, new_paid)
    if new_status != booking.get("payment_status"):
        await BookingRepository.update_payment_status(booking_id, new_status)

    booking_after = await BookingRepository.get_by_id(booking_id)
    logger.info(
        "Recorded manual payment booking=%s amount=%.2f method=%s status=%s",
        booking_id,
        data.amount,
        data.payment_method,
        derive_status(booking_after, new_paid),
    )
    plan = await fetch_guest_contact_plan(hotel_id)
    return to_detail(mask_booking_guest_contacts(booking_after, plan), payments_after)


@router.get("/payments", response_model=PaymentLedgerResponse)
async def list_payments(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    payment_rows = await PaymentRepository.list_by_hotel(hotel_id, limit=limit, offset=offset)
    total = await PaymentRepository.count_by_hotel(hotel_id)

    entries: list[PaymentLedgerEntry] = []
    for row in payment_rows:
        # Compose a minimal "booking" dict so to_ledger_entry can derive the invoice number.
        synthetic_booking = {
            "id": row["booking_id"],
            "booking_reference": row.get("booking_reference") or "",
            "guest_first_name": row.get("guest_first_name") or "",
            "guest_last_name": row.get("guest_last_name") or "",
            "created_at": row.get("booking_created_at") or row["created_at"],
        }
        entries.append(to_ledger_entry(row, synthetic_booking))

    return PaymentLedgerResponse(
        payments=entries,
        total=total,
        limit=limit,
        offset=offset,
    )

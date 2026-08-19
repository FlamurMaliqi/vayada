"""
Tests for the PMS Financials section (admin_financials router).

Covers:
- Listing invoices with status filter + counts.
- Invoice detail endpoint.
- Recording manual payments and the resulting status transitions
  (sent → partial → paid).
- Summary aggregation (revenue MTD + outstanding + overdue count).
"""

from datetime import date, datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from app.routers import admin_financials
from app.services.guest_contact_access import HIDDEN_GUEST_CONTACT
from app.services.invoice_service import derive_status

from tests.conftest import (
    create_test_booking,
    create_test_booking_with_payment,
    create_test_hotel,
    create_test_room_type,
    create_test_user,
    get_auth_headers,
)


def test_check_in_today_is_not_overdue():
    today = date(2026, 8, 2)
    booking = {
        "status": "confirmed",
        "total_amount": 100.0,
        "check_in": today,
        "channel": "direct",
        "payment_status": "unpaid",
    }

    assert derive_status(booking, amount_paid=0, today=today) == "sent"
    assert (
        derive_status(
            {**booking, "check_in": today - timedelta(days=1)},
            amount_paid=0,
            today=today,
        )
        == "overdue"
    )


@pytest.mark.asyncio
async def test_invoice_loader_masks_pending_contact_and_protects_email_search():
    booking = {
        "id": "booking-1",
        "status": "pending",
        "guest_email": "secret@example.test",
        "guest_phone": "+491234",
    }
    with (
        patch.object(
            admin_financials,
            "fetch_guest_contact_plan",
            AsyncMock(return_value="commission"),
        ),
        patch.object(
            admin_financials.BookingRepository,
            "list_by_hotel_id",
            AsyncMock(return_value=[booking]),
        ) as list_bookings,
        patch.object(
            admin_financials.PaymentRepository,
            "list_by_booking_ids",
            AsyncMock(return_value=[]),
        ),
    ):
        pairs = await admin_financials._load_invoice_pairs("hotel-1", search="secret@example.test")

    assert pairs[0][0]["guest_email"] == HIDDEN_GUEST_CONTACT
    assert pairs[0][0]["guest_phone"] == HIDDEN_GUEST_CONTACT
    assert list_bookings.await_args.kwargs["hide_unaccepted_guest_contact"] is True


class TestListInvoices:
    async def test_csv_export_masks_pending_contact(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            guest_email="pending-secret@example.test",
            status="pending",
        )

        resp = await client.get(
            "/admin/financials/invoices/export.csv",
            headers=get_auth_headers(user["token"]),
        )

        assert resp.status_code == 200
        assert HIDDEN_GUEST_CONTACT in resp.text
        assert "pending-secret@example.test" not in resp.text

    async def test_lists_invoice_for_each_booking(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-08-01",
            check_out="2026-08-05",
            guest_email="alice@example.com",
            status="confirmed",
        )

        resp = await client.get(
            "/admin/financials/invoices",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert len(body["invoices"]) == 1
        invoice = body["invoices"][0]
        assert invoice["invoiceNumber"].startswith("INV-")
        assert invoice["guestEmail"] == "alice@example.com"
        assert invoice["balanceDue"] == invoice["totalAmount"]
        assert invoice["status"] in {"sent", "overdue", "draft"}

    async def test_status_filter_and_counts(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-08-01",
            check_out="2026-08-05",
            guest_email="confirmed@example.com",
            status="confirmed",
        )
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-09-01",
            check_out="2026-09-05",
            guest_email="pending@example.com",
            status="pending",
        )
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-10-01",
            check_out="2026-10-05",
            guest_email="cancelled@example.com",
            status="cancelled",
        )

        resp = await client.get(
            "/admin/financials/invoices",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        counts = body["counts"]
        assert counts["draft"] == 1
        assert counts["voided"] == 1
        assert counts["sent"] + counts["overdue"] == 1

        resp_voided = await client.get(
            "/admin/financials/invoices?status=voided",
            headers=get_auth_headers(user["token"]),
        )
        assert resp_voided.status_code == 200
        body_voided = resp_voided.json()
        assert body_voided["total"] == 1
        assert body_voided["invoices"][0]["status"] == "voided"

    async def test_other_hotels_invoices_are_isolated(self, client, cleanup_database):
        user_a = await create_test_user()
        hotel_a = await create_test_hotel(str(user_a["id"]))
        room_a = await create_test_room_type(str(hotel_a["id"]))
        await create_test_booking(
            str(hotel_a["id"]),
            str(room_a["id"]),
            guest_email="hotel-a@example.com",
        )

        user_b = await create_test_user()
        await create_test_hotel(str(user_b["id"]))

        # user_b has their own hotel but no bookings, so the list is empty.
        resp = await client.get(
            "/admin/financials/invoices",
            headers=get_auth_headers(user_b["token"]),
        )
        assert resp.status_code == 200
        assert resp.json()["total"] == 0


class TestInvoiceDetail:
    async def test_returns_charges_and_totals(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-08-01",
            check_out="2026-08-05",
            nightly_rate=200.0,
            status="confirmed",
        )

        resp = await client.get(
            f"/admin/financials/invoices/{booking['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["nights"] == 4
        assert body["totalAmount"] == 800.0
        assert body["amountPaid"] == 0
        assert body["balanceDue"] == 800.0
        assert len(body["charges"]) == 1
        assert body["charges"][0]["amount"] == 800.0


class TestRecordPayment:
    async def test_partial_then_full_payment_status_transitions(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        future_check_in = date.today() + timedelta(days=30)
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            check_in=future_check_in.isoformat(),
            check_out=(future_check_in + timedelta(days=4)).isoformat(),
            nightly_rate=250.0,
            status="confirmed",
            payment_method="pay_at_property",
            payment_status="unpaid",
        )

        initial_resp = await client.get(
            f"/admin/financials/invoices/{booking['id']}",
            headers=get_auth_headers(user["token"]),
        )
        assert initial_resp.status_code == 200
        initial_body = initial_resp.json()
        assert initial_body["amountPaid"] == 0
        assert initial_body["payments"] == []
        assert initial_body["status"] == "sent"

        # Partial payment
        resp = await client.post(
            f"/admin/financials/invoices/{booking['id']}/payments",
            json={"amount": 400.0, "paymentMethod": "cash", "reference": "till-1"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["amountPaid"] == 400.0
        assert body["balanceDue"] == 600.0
        assert body["status"] == "partial"
        assert len(body["payments"]) == 1
        assert body["payments"][0]["method"] == "cash"
        assert body["payments"][0]["reference"] == "till-1"

        # Final payment closes the invoice
        resp2 = await client.post(
            f"/admin/financials/invoices/{booking['id']}/payments",
            json={"amount": 600.0, "paymentMethod": "bank_transfer"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp2.status_code == 201
        body2 = resp2.json()
        assert body2["amountPaid"] == 1000.0
        assert body2["balanceDue"] == 0
        assert body2["status"] == "paid"
        assert len(body2["payments"]) == 2

        # Recording extra now is a 400.
        resp3 = await client.post(
            f"/admin/financials/invoices/{booking['id']}/payments",
            json={"amount": 1.0, "paymentMethod": "cash"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp3.status_code == 400

    async def test_overpayment_is_rejected(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            nightly_rate=100.0,
            status="confirmed",
        )
        resp = await client.post(
            f"/admin/financials/invoices/{booking['id']}/payments",
            json={"amount": 999999.0, "paymentMethod": "cash"},
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400


class TestSummary:
    async def test_aggregates_revenue_and_outstanding(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        # Future stay, no payment yet → counts toward outstanding.
        future_start = (date.today() + timedelta(days=30)).isoformat()
        future_end = (date.today() + timedelta(days=33)).isoformat()
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=future_start,
            check_out=future_end,
            nightly_rate=200.0,
            status="confirmed",
        )
        # Past stay, also unpaid → overdue.
        past_start = (date.today() - timedelta(days=30)).isoformat()
        past_end = (date.today() - timedelta(days=27)).isoformat()
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=past_start,
            check_out=past_end,
            nightly_rate=300.0,
            status="confirmed",
            guest_email="past@example.com",
        )

        resp = await client.get(
            "/admin/financials/summary",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        # 200 × 3 + 300 × 3 = 1500 outstanding
        assert body["outstanding"] == 1500.0
        assert body["overdueCount"] == 1
        assert body["currency"] == "EUR"

    async def test_ota_bookings_excluded_from_outstanding_and_overdue(
        self, client, cleanup_database
    ):
        """OTA bookings (Airbnb, Booking.com, …) are settled by the platform,
        so they must not appear as outstanding or overdue in the PMS
        financial dashboard — VAY-490.
        """
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        future_start = (date.today() + timedelta(days=30)).isoformat()
        future_end = (date.today() + timedelta(days=33)).isoformat()
        past_start = (date.today() - timedelta(days=30)).isoformat()
        past_end = (date.today() - timedelta(days=27)).isoformat()
        # Direct future + past → contribute 200×3 + 300×3 = 1500 outstanding,
        # 1 overdue.
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=future_start,
            check_out=future_end,
            nightly_rate=200.0,
            status="confirmed",
            channel="direct",
            guest_email="direct-future@example.com",
        )
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=past_start,
            check_out=past_end,
            nightly_rate=300.0,
            status="confirmed",
            channel="direct",
            guest_email="direct-past@example.com",
        )
        # OTA future + past → must NOT contribute to outstanding/overdue.
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=future_start,
            check_out=future_end,
            nightly_rate=500.0,
            status="confirmed",
            channel="airbnb",
            payment_status="pay_at_property",
            guest_email="airbnb-future@example.com",
        )
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=past_start,
            check_out=past_end,
            nightly_rate=700.0,
            status="confirmed",
            channel="booking.com",
            payment_status="pay_at_property",
            guest_email="bdc-past@example.com",
        )

        resp = await client.get(
            "/admin/financials/summary",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        # OTA bookings still count toward revenue (the property earned it),
        # but outstanding/overdue must only reflect direct bookings.
        assert body["outstanding"] == 1500.0
        assert body["overdueCount"] == 1

    async def test_ota_invoice_shows_as_paid(self, client, cleanup_database):
        """OTA invoices appear in the list as 'paid' with zero balance,
        even though no PMS-side payment row exists — VAY-490."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in="2026-08-01",
            check_out="2026-08-05",
            nightly_rate=200.0,
            status="confirmed",
            channel="airbnb",
            payment_status="pay_at_property",
            guest_email="airbnb-guest@example.com",
        )

        resp = await client.get(
            "/admin/financials/invoices",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        invoice = resp.json()["invoices"][0]
        assert invoice["status"] == "paid"
        assert invoice["amountPaid"] == 800.0
        assert invoice["balanceDue"] == 0

    async def test_ota_booking_with_unpaid_override_still_outstanding(
        self, client, cleanup_database
    ):
        """If an admin explicitly sets payment_status='unpaid' on an OTA
        booking (no-show charge owed to the property), it falls back to
        the normal flow and counts as outstanding — VAY-490."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        future_start = (date.today() + timedelta(days=10)).isoformat()
        future_end = (date.today() + timedelta(days=12)).isoformat()
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=future_start,
            check_out=future_end,
            nightly_rate=400.0,
            status="confirmed",
            channel="booking.com",
            payment_status="unpaid",  # explicit admin override
            guest_email="bdc-noshow@example.com",
        )

        resp = await client.get(
            "/admin/financials/summary",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["outstanding"] == 800.0  # 400 × 2 nights

        resp_list = await client.get(
            "/admin/financials/invoices",
            headers=get_auth_headers(user["token"]),
        )
        invoice = resp_list.json()["invoices"][0]
        assert invoice["status"] in {"sent", "overdue"}
        assert invoice["balanceDue"] == 800.0

    async def test_pending_bookings_excluded_from_summary(self, client, cleanup_database):
        """Pending booking requests (host hasn't accepted yet) must not
        contribute to revenue, outstanding, or overdue counts — VAY-334.

        Their `total_amount` already includes addon/upsell revenue at
        creation time, so counting them would show revenue for stays
        that may still expire or be rejected.
        """
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        future_start = (date.today() + timedelta(days=30)).isoformat()
        future_end = (date.today() + timedelta(days=33)).isoformat()
        # Confirmed → contributes 200 × 3 = 600 to revenue/outstanding.
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=future_start,
            check_out=future_end,
            nightly_rate=200.0,
            status="confirmed",
            guest_email="confirmed@example.com",
        )
        # Pending → must NOT contribute, even though total_amount is set.
        await create_test_booking(
            str(hotel["id"]),
            str(room["id"]),
            check_in=future_start,
            check_out=future_end,
            nightly_rate=500.0,
            status="pending",
            guest_email="pending@example.com",
        )

        resp = await client.get(
            "/admin/financials/summary",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["revenueMtd"] == 600.0
        assert body["outstanding"] == 600.0
        assert body["overdueCount"] == 0

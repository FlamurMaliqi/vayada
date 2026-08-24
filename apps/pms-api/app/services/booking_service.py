import asyncio
import json
import logging
import math
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

import httpx

from app.config import settings
from app.database import Database
from app.models.booking import BookingCreate, BookingQuoteResponse, BookingResponse
from app.repositories.affiliate_repo import AffiliateRepository
from app.repositories.booking_draft_repo import BookingDraftRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.cancellation_policy_repo import CancellationPolicyRepository
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.hotel_repo import HotelRepository
from app.repositories.payment_repo import PaymentRepository
from app.repositories.payout_repo import PayoutRepository
from app.repositories.room_type_repo import RoomTypeRepository
from app.services import hotel_identity_service, stripe_service, xendit_service
from app.services.availability_service import compute_stay_pricing, remaining_for_stay
from app.services.calendar_auto_open_service import is_stay_sellable
from app.services.channex.ari_push import push_availability_for_room_type
from app.services.channex.orchestrator import push_ari_for_booking
from app.services.channex.outbound import handle_vayada_cancellation as channex_handle_cancellation
from app.services.currency_service import get_exchange_rate
from app.services.email_service import (
    booking_host_notification_recipients,
    send_booking_request_notification,
    send_guest_booking_accepted,
    send_guest_booking_expired,
    send_guest_booking_rejected,
    send_guest_booking_requested,
    send_guest_booking_withdrawn,
    send_guest_cancellation_refund,
    send_host_booking_accepted_to,
    send_host_booking_expired,
    send_host_booking_rejected,
    send_host_booking_withdrawn,
    send_host_guest_cancelled,
)
from app.services.occupancy import room_allows_guest_mix
from app.services.payout_service import calculate_split, fetch_billing_config, schedule_payouts
from app.services.promo_usage_reconciliation import claim_promo_use, reverse_promo_use
from app.services.room_assignment import (
    apply_moves_atomic,
    record_auto_rearrange,
    resolve_room_assignments,
    try_place_unassigned_after_cancellation,
)
from app.services.room_type_service import resolve_last_minute_discount
from app.services.same_day_booking import (
    SAME_DAY_BOOKING_CLOSED_MESSAGE,
    is_same_day_booking_closed,
    property_today,
)
from app.utils import get_hotel_id

logger = logging.getLogger(__name__)

# Holds strong references to fire-and-forget tasks so they are not garbage
# collected before completion. Entries are discarded automatically via the
# done callback added in _create_task.
_background_tasks: set = set()


def _create_task(coro) -> asyncio.Task:
    """Schedule a coroutine as a background task, keeping a strong reference."""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


HOST_RESPONSE_HOURS = 24


def _bank_details_complete(details: dict | None) -> bool:
    if not details:
        return False
    account_type = details.get("payout_account_type") or "iban"
    account_identifier = (
        details.get("payout_account_number")
        if account_type == "account_number"
        else details.get("payout_iban")
    )
    required = [
        details.get("payout_bank_name"),
        details.get("payout_account_holder"),
        account_identifier,
        details.get("payout_swift"),
    ]
    return all(bool(str(value or "").strip()) for value in required)


def _log_background_task_result(task: asyncio.Task, label: str) -> None:
    try:
        task.result()
    except asyncio.CancelledError:
        return
    except Exception:
        logger.exception("Background task failed: %s", label)


def _nights(check_in: date, check_out: date) -> int:
    return (check_out - check_in).days


def _booking_to_response(booking: dict) -> BookingResponse:
    ci = booking["check_in"]
    co = booking["check_out"]
    deadline = booking.get("host_response_deadline")
    return BookingResponse(
        id=str(booking["id"]),
        booking_reference=booking["booking_reference"],
        hotel_name=booking["hotel_name"],
        room_name=booking["room_name"],
        guest_first_name=booking["guest_first_name"],
        guest_last_name=booking["guest_last_name"],
        guest_email=booking["guest_email"],
        check_in=str(ci),
        check_out=str(co),
        nights=_nights(ci, co),
        adults=booking["adults"],
        children=booking["children"],
        nightly_rate=float(booking["nightly_rate"]),
        number_of_rooms=int(booking.get("number_of_rooms") or 1),
        total_amount=float(booking["total_amount"]),
        deposit_required=bool(booking.get("deposit_required", False)),
        deposit_percentage=booking.get("deposit_percentage"),
        deposit_amount=float(booking.get("deposit_amount") or 0),
        balance_amount=float(
            booking.get("balance_amount")
            if booking.get("balance_amount") is not None
            else booking["total_amount"]
        ),
        addon_total=float(booking.get("addon_total") or 0),
        addon_ids=booking.get("addon_ids") or [],
        addon_names=booking.get("addon_names") or [],
        addon_quantities=booking.get("addon_quantities") or {},
        addon_dates=booking.get("addon_dates") or {},
        currency=booking["currency"],
        status=booking["status"],
        payment_method=booking.get("payment_method"),
        payment_status=booking.get("payment_status"),
        host_response_deadline=deadline.isoformat() if deadline else None,
        created_at=booking["created_at"].isoformat(),
    )


@dataclass
class BookingPricing:
    """Resolved totals for a booking: nightly rate (post-discount), per-stay
    room cost, addons, promo + last-minute discount, and the final amount."""

    nightly_rate: float
    room_total: float
    addon_total: float
    addon_names: list[str] = field(default_factory=list)
    promo_code: str | None = None
    promo_discount: float = 0.0
    last_minute_discount_pct: int = 0
    last_minute_discount_amount: float = 0.0
    total_amount: float = 0.0


@dataclass
class DepositSnapshot:
    required: bool
    percentage: int | None
    amount: float
    balance: float


@dataclass
class CancellationOutcome:
    refund_amount: float
    refund_pct: float
    free_days_for_display: int
    cancellation_charge: float
    policy_penalty: float
    deposit_retained: float
    additional_amount_due: float
    manual_refund_required: bool = False


@dataclass
class PaymentOutcome:
    """Result of dispatching the chosen payment method."""

    client_secret: str | None = None
    xendit_invoice_url: str | None = None


@dataclass
class StripeIntentSnapshot:
    payment_intent_id: str
    client_secret: str
    account_id: str | None
    application_fee_amount: float = 0
    platform_fee_amount: float = 0
    affiliate_commission_amount: float = 0


@dataclass
class BookingContext:
    hotel: dict
    hotel_id: str
    instant_book: bool
    room: dict
    nights: int


def _parse_rate_deposit_settings(raw) -> dict:
    if not raw:
        return {}
    if isinstance(raw, str):
        try:
            decoded = json.loads(raw)
        except (TypeError, ValueError):
            return {}
    else:
        decoded = raw
    return decoded if isinstance(decoded, dict) else {}


def _resolve_deposit_snapshot(room: dict, rate_type: str, total_amount: float) -> DepositSnapshot:
    settings = _parse_rate_deposit_settings(room.get("rate_deposit_settings"))
    config = settings.get(rate_type) if isinstance(settings, dict) else None
    if not isinstance(config, dict) or not config.get("enabled"):
        return DepositSnapshot(False, None, 0.0, round(float(total_amount), 2))

    try:
        pct = int(config.get("percentage") or 50)
    except (TypeError, ValueError):
        pct = 50
    pct = max(1, min(100, pct))
    deposit = round(float(total_amount) * pct / 100, 2)
    balance = round(max(float(total_amount) - deposit, 0), 2)
    return DepositSnapshot(True, pct, deposit, balance)


def _apply_deposit_snapshot(data: dict, deposit: DepositSnapshot) -> dict:
    data["deposit_required"] = deposit.required
    data["deposit_percentage"] = deposit.percentage
    data["deposit_amount"] = deposit.amount
    data["balance_amount"] = deposit.balance
    return data


def _quote_to_response(
    *,
    data: BookingCreate,
    room: dict,
    pricing: BookingPricing,
    deposit: DepositSnapshot,
) -> BookingQuoteResponse:
    return BookingQuoteResponse(
        room_type_id=data.room_type_id,
        room_name=room["name"],
        rate_type=data.rate_type,
        payment_method=data.payment_method,
        nightly_rate=pricing.nightly_rate,
        number_of_rooms=data.number_of_rooms,
        room_total=pricing.room_total,
        addon_total=pricing.addon_total,
        promo_code=pricing.promo_code,
        promo_discount=pricing.promo_discount,
        last_minute_discount_percent=pricing.last_minute_discount_pct,
        last_minute_discount_amount=pricing.last_minute_discount_amount,
        total_amount=pricing.total_amount,
        currency=room["currency"],
        deposit_required=deposit.required,
        deposit_percentage=deposit.percentage,
        deposit_amount=deposit.amount,
        balance_amount=deposit.balance,
    )


def _ensure_expected_total_matches(data: BookingCreate, pricing: BookingPricing) -> None:
    if data.expected_total_amount is None:
        return
    if not math.isclose(float(data.expected_total_amount), pricing.total_amount, abs_tol=0.01):
        raise ValueError(
            "The booking total changed before submission. "
            "Please refresh the checkout and try again."
        )


def _payment_amount_for_booking(total_amount: float, deposit: DepositSnapshot) -> float:
    return deposit.amount if deposit.required else round(float(total_amount), 2)


def _payment_purpose_for_booking(deposit: DepositSnapshot) -> str:
    return "deposit" if deposit.required else "booking"


async def _assign_room_unit(room_type_id: str, check_in: date, check_out: date) -> str | None:
    """Pick the lowest-numbered available room unit for the stay window.
    Returns the room id, or None if every unit is booked.

    Direct-fit only — does not rearrange existing bookings. Callers that
    want the auto-rearrange behavior should use `resolve_assignment`
    instead, which respects the hotel's `auto_rearrange_enabled` toggle.
    """
    row = await Database.fetchrow(
        """
        SELECT r.id FROM rooms r
        WHERE r.room_type_id = $1
          AND r.status = 'available'
          AND r.id NOT IN (
            SELECT b.room_id FROM bookings b
            WHERE b.room_id IS NOT NULL
              AND b.status IN ('pending', 'confirmed')
              AND b.check_in < $3
              AND b.check_out > $2
          )
        ORDER BY r.sort_order,
                 (COALESCE(NULLIF(regexp_replace(r.room_number, '[^0-9].*', '', 'g'), ''), '0'))::int,
                 r.room_number
        LIMIT 1
        """,
        room_type_id,
        check_in,
        check_out,
    )
    return str(row["id"]) if row else None


async def _fetch_hotel_addons(slug: str) -> list[dict]:
    """Fetch the hotel's addons from the booking-engine API.
    Returns an empty list on any failure (logged)."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{settings.BOOKING_ENGINE_API_URL}/api/hotels/{slug}/addons")
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        logger.warning("Failed to fetch addons for %s: %s", slug, e)
        return []


async def _validate_promo_code(
    slug: str,
    code: str,
    *,
    check_in: date,
    room_type_id: str,
    booking_total: float,
) -> dict:
    """Validate a promo code against the booking-engine API.
    Returns the API response, or ``{"valid": False}`` on failure."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{settings.BOOKING_ENGINE_API_URL}/api/hotels/{slug}/validate-promo",
                params={
                    "code": code,
                    "check_in": check_in.isoformat(),
                    "room_type_id": room_type_id,
                    "booking_total": booking_total,
                },
            )
            resp.raise_for_status()
            return resp.json()
    except Exception as e:
        logger.warning("Failed to validate promo for %s: %s", slug, e)
        return {"valid": False}


async def _prepare_booking_context(slug: str, data: BookingCreate) -> BookingContext:
    """Validate the stay and load the records used by quote + create.

    Keeping this shared prevents the payment page's authoritative quote from
    drifting away from the final booking snapshot.
    """
    hotel = await Database.fetchrow(
        "SELECT id, name, contact_email, last_minute_discount, instant_book, "
        "timezone, same_day_bookings_enabled, same_day_booking_cutoff_time "
        "FROM hotels WHERE slug = $1",
        slug,
    )
    if not hotel:
        raise ValueError("Hotel not found")
    hotel_id = str(hotel["id"])
    instant_book = bool(hotel.get("instant_book"))

    room = await RoomTypeRepository.get_by_id(data.room_type_id)
    if not room or str(room["hotel_id"]) != hotel_id:
        raise ValueError("Room type not found")
    if not room["is_active"]:
        raise ValueError("Room type is not available")
    if not room_allows_guest_mix(room, data.adults, data.children, units=data.number_of_rooms or 1):
        raise ValueError("Guest mix exceeds this room's occupancy limits")
    if is_same_day_booking_closed(
        data.check_in,
        same_day_bookings_enabled=bool(hotel.get("same_day_bookings_enabled", True)),
        same_day_booking_cutoff_time=hotel.get("same_day_booking_cutoff_time"),
        timezone=hotel.get("timezone"),
    ):
        raise ValueError(SAME_DAY_BOOKING_CLOSED_MESSAGE)

    calendar_settings = await HotelRepository.get_calendar_settings(hotel_id)
    if not is_stay_sellable(data.check_in, data.check_out, room, calendar_settings):
        raise ValueError("Room type is not available for the selected dates")

    auto_rearrange_enabled = await HotelRepository.get_auto_rearrange_enabled(hotel_id)
    available = await remaining_for_stay(
        data.room_type_id,
        room["total_rooms"],
        data.check_in,
        data.check_out,
        hotel_id=hotel_id,
        allow_rearrange=data.number_of_rooms <= 1 and auto_rearrange_enabled,
    )
    if available < data.number_of_rooms:
        raise ValueError("Not enough rooms available for the selected dates")

    nights = _nights(data.check_in, data.check_out)
    if nights <= 0:
        raise ValueError("Check-out must be after check-in")

    seasons = RoomTypeRepository._parse_seasons(room)
    min_stay = RoomTypeRepository._find_season_min_stay(seasons, data.check_in)
    if min_stay and nights < min_stay:
        raise ValueError(
            f"This room requires a minimum stay of {min_stay} nights for the selected dates"
        )
    max_stay = RoomTypeRepository._find_stay_max_stay(seasons, data.check_in, data.check_out)
    if max_stay and nights > max_stay:
        raise ValueError(
            f"This room has a maximum stay of {max_stay} nights for the selected dates. "
            "Please shorten your stay."
        )

    min_advance = room.get("minimum_advance_days") or 0
    if min_advance > 0:
        days_until_checkin = (data.check_in - property_today(hotel.get("timezone"))).days
        if days_until_checkin < min_advance:
            raise ValueError(f"This room requires booking at least {min_advance} days in advance")

    rate_methods_raw = room.get("rate_payment_methods")
    if rate_methods_raw:
        rate_methods = (
            json.loads(rate_methods_raw) if isinstance(rate_methods_raw, str) else rate_methods_raw
        )
        allowed = rate_methods.get(data.rate_type) if isinstance(rate_methods, dict) else None
        if allowed is not None and data.payment_method not in allowed:
            raise ValueError(
                f"Payment method '{data.payment_method}' is not allowed for the "
                f"{data.rate_type} rate on this room. Allowed: {', '.join(allowed) or '(none)'}"
            )

    return BookingContext(
        hotel=hotel,
        hotel_id=hotel_id,
        instant_book=instant_book,
        room=room,
        nights=nights,
    )


async def _compute_addon_total(
    slug: str,
    addon_ids: list[str],
    addon_quantities: dict,
    room_currency: str,
    adults: int,
    nights: int,
    addon_dates: dict | None = None,
) -> tuple[float, list[str]]:
    """Sum the addon prices for a stay, converting to ``room_currency`` so the
    booking total matches what the guest saw at checkout. Returns
    (total, addon_names).

    Pricing rules (VAY-360):
    - perPerson: multiply by ``addon_quantities[id]`` (the number of guests
      opting in, clamped to ``adults``). Defaults to ``adults`` for legacy
      bookings that didn't send a quantity.
    - perNight: multiply by the number of selected dates from
      ``addon_dates[id]`` (clamped to ``nights``). Falls back to
      ``addon_quantities[id]`` and finally to ``nights`` for legacy bookings.
    - Both flags: both modifiers compose, so price = unit × people × days.
    - Neither flag: per-booking; multiply by ``addon_quantities[id]`` (default 1).
    """
    if not addon_ids:
        return 0.0, []

    all_addons = await _fetch_hotel_addons(slug)
    addon_map = {a["id"]: a for a in all_addons}
    room_currency = room_currency.upper()
    rate_cache: dict = {}
    addon_total = 0.0
    addon_names: list[str] = []
    addon_dates = addon_dates or {}

    for aid in addon_ids:
        addon = addon_map.get(aid)
        if not addon:
            continue
        addon_names.append(addon.get("name", "Unknown"))
        price = float(addon["price"])
        per_person = bool(addon.get("perPerson"))
        per_night = bool(addon.get("perNight"))

        if per_person:
            people = addon_quantities.get(aid, adults)
            people = max(1, min(int(people), max(1, adults)))
            price *= people

        if per_night:
            dates = addon_dates.get(aid) or []
            if dates:
                days = max(1, min(len(dates), nights))
            else:
                days = int(addon_quantities.get(aid, nights)) if not per_person else nights
                days = max(1, min(days, nights))
            price *= days

        if not per_person and not per_night:
            qty = max(1, int(addon_quantities.get(aid, 1)))
            price *= qty

        addon_currency = (addon.get("currency") or room_currency).upper()
        if addon_currency != room_currency:
            if addon_currency not in rate_cache:
                try:
                    rate_cache[addon_currency] = await get_exchange_rate(
                        addon_currency, room_currency
                    )
                except Exception as e:
                    logger.warning(
                        "Failed to fetch addon exchange rate %s -> %s: %s",
                        addon_currency,
                        room_currency,
                        e,
                    )
                    rate_cache[addon_currency] = 1.0
            price = price * rate_cache[addon_currency]
        addon_total += price

    return round(addon_total, 2), addon_names


async def _compute_booking_pricing(
    slug: str,
    data: BookingCreate,
    hotel: dict,
    room: dict,
    nights: int,
) -> BookingPricing:
    """Resolve the full pricing surface for a booking: nightly rates,
    addons, promo code, and last-minute-discount stacking. Pure-ish: only
    side effect is best-effort HTTP fetches to booking-engine, all of
    which fail open."""
    pricing = compute_stay_pricing(room, data.check_in, data.check_out, data.adults, data.rate_type)
    room_total = round(pricing.room_total * data.number_of_rooms, 2)

    # Last-minute discount based on days before check-in
    days_before = (data.check_in - property_today(hotel.get("timezone"))).days
    hotel_lm_raw = hotel.get("last_minute_discount")
    hotel_lm_config = (
        json.loads(hotel_lm_raw)
        if isinstance(hotel_lm_raw, str)
        else hotel_lm_raw
        if hotel_lm_raw
        else None
    )
    room_lm_raw = room.get("last_minute_discount")
    room_lm_config = (
        json.loads(room_lm_raw)
        if isinstance(room_lm_raw, str)
        else room_lm_raw
        if room_lm_raw
        else None
    )
    lm_pct = resolve_last_minute_discount(hotel_lm_config, room_lm_config, days_before) or 0
    lm_discount_amount = 0.0
    if lm_pct > 0:
        lm_discount_amount = round(room_total * (lm_pct / 100), 2)
        room_total = round(room_total - lm_discount_amount, 2)

    nightly_rate = round(room_total / (nights * data.number_of_rooms), 2)

    # Addons
    addon_total, addon_names = await _compute_addon_total(
        slug,
        data.addon_ids or [],
        data.addon_quantities or {},
        room.get("currency") or "EUR",
        data.adults,
        nights,
        data.addon_dates or {},
    )

    subtotal = room_total + addon_total

    # Promo
    promo_code_str: str | None = None
    promo_discount = 0.0
    if data.promo_code:
        promo_result = await _validate_promo_code(
            slug,
            data.promo_code,
            check_in=data.check_in,
            room_type_id=data.room_type_id,
            booking_total=subtotal,
        )
        if promo_result.get("valid"):
            promo_code_str = promo_result["code"]
            discount_type = promo_result["discountType"]
            discount_value = float(promo_result["discountValue"])
            if discount_type == "percentage":
                promo_discount = round(subtotal * (discount_value / 100), 2)
            else:
                promo_discount = min(discount_value, subtotal)
        else:
            raise ValueError(promo_result.get("message") or "Invalid promo code.")

    # Promo vs last-minute stacking — keep only the larger discount unless
    # the hotel opted in via stackWithPromo.
    stack_with_promo = (hotel_lm_config or {}).get("stackWithPromo", False)
    if not stack_with_promo and lm_discount_amount > 0 and promo_discount > 0:
        if promo_discount > lm_discount_amount:
            # Promo wins — undo the last-minute discount.
            room_total = round(room_total + lm_discount_amount, 2)
            nightly_rate = round(room_total / (nights * data.number_of_rooms), 2)
            subtotal = room_total + addon_total
            lm_pct = 0
            lm_discount_amount = 0.0
        else:
            # Last-minute wins — drop promo.
            promo_discount = 0.0
            promo_code_str = None

    total_amount = round(subtotal - promo_discount, 2)

    return BookingPricing(
        nightly_rate=nightly_rate,
        room_total=room_total,
        addon_total=addon_total,
        addon_names=addon_names,
        promo_code=promo_code_str,
        promo_discount=promo_discount,
        last_minute_discount_pct=lm_pct,
        last_minute_discount_amount=lm_discount_amount,
        total_amount=total_amount,
    )


async def _resolve_card_provider(
    hotel_settings: dict | None,
) -> tuple[str, str | None]:
    """Return (provider, stripe_account). For ``stripe`` Connect we also
    return the connected-account id; for ``vayada`` (platform) we return
    None for the account. Raises ValueError when the hotel hasn't
    finished onboarding so the booking-engine surfaces the same UX
    message it has always shown."""
    provider = hotel_settings.get("payment_provider", "stripe") if hotel_settings else "stripe"
    if provider == "vayada":
        return provider, None

    stripe_account: str | None = None
    if hotel_settings and hotel_settings.get("stripe_connect_account_id"):
        if hotel_settings.get("stripe_connect_onboarded"):
            stripe_account = hotel_settings["stripe_connect_account_id"]

    if not stripe_account:
        # Don't silently downgrade to pay-at-property: the guest picked
        # "card" specifically. If /payment-settings gating is doing its
        # job this branch is unreachable from the UI.
        raise ValueError(
            "This hotel has not finished setting up online payments. "
            "Please contact the hotel or choose another payment method."
        )
    return provider, stripe_account


async def _create_card_payment_intent_for_draft(
    *,
    hotel_id: str,
    hotel_settings: dict | None,
    currency: str,
    charge_amount: float,
    booking_total_amount: float,
    affiliate_id: str | None,
    capture_method: str,
    booking_reference: str,
) -> StripeIntentSnapshot:
    """Create a Stripe PaymentIntent for a booking that hasn't been
    persisted yet (VAY-388).

    Freezes the complete direct-charge fee split so later plan or affiliate
    changes cannot make PMS accounting diverge from the Stripe charge.

    Metadata carries ``booking_reference`` instead of ``booking_id``;
    the webhook + confirm-authorization paths use the PI id to look up
    the draft and materialize the booking lazily.
    """
    provider, stripe_account = await _resolve_card_provider(hotel_settings)
    amount_cents = int(math.ceil(charge_amount * 100))
    application_fee_cents = 0
    split = {"platform_fee": 0.0, "affiliate_commission": 0.0}
    if stripe_account:
        billing = await fetch_billing_config(hotel_id)
        affiliate_commission_pct = 0.0
        if affiliate_id:
            affiliate_commission_pct = (
                await AffiliateRepository.get_effective_commission_pct(affiliate_id) or 0.0
            )
        split = calculate_split(
            booking_total_amount,
            plan=billing["active_plan"],
            channel="direct",
            booking_engine_fee_pct=billing["booking_engine_fee_pct"],
            channel_manager_fee_pct=billing["channel_manager_fee_pct"],
            affiliate_platform_fee_pct=billing["affiliate_platform_fee_pct"],
            has_affiliate=affiliate_id is not None,
            effective_affiliate_commission_pct=affiliate_commission_pct,
        )
        application_fee_cents = round((split["platform_fee"] + split["affiliate_commission"]) * 100)
        if application_fee_cents >= amount_cents:
            raise ValueError("The booking deposit is too small for the configured fees")
    metadata = {
        "booking_reference": booking_reference,
        "hotel_id": hotel_id,
        "vayada_payment_kind": "draft",
    }

    if provider == "vayada":
        pi = await stripe_service.create_payment_intent(
            amount=amount_cents,
            currency=currency,
            metadata=metadata,
            capture_method=capture_method,
        )
    else:
        pi = await stripe_service.create_payment_intent(
            amount=amount_cents,
            currency=currency,
            metadata=metadata,
            stripe_account=stripe_account,
            application_fee_amount=application_fee_cents,
            capture_method=capture_method,
        )
    return StripeIntentSnapshot(
        payment_intent_id=pi["id"],
        client_secret=pi["client_secret"],
        account_id=stripe_account,
        application_fee_amount=application_fee_cents / 100,
        platform_fee_amount=split["platform_fee"],
        affiliate_commission_amount=split["affiliate_commission"],
    )


def _booking_draft_payload(
    *,
    data: BookingCreate,
    hotel_id: str,
    room: dict,
    pricing: BookingPricing,
    affiliate_id: str | None,
    payment_method: str,
    deadline: datetime | None,
    use_request_flow: bool,
    capture_method: str,
    deposit: DepositSnapshot,
) -> dict:
    """Snapshot every field needed to materialize the booking later. Stored
    as JSONB on the draft so the materializer never has to re-resolve
    pricing or addons."""
    return {
        "hotel_id": hotel_id,
        "room_type_id": data.room_type_id,
        "guest_first_name": data.guest_first_name,
        "guest_last_name": data.guest_last_name,
        "guest_email": data.guest_email,
        "guest_phone": data.guest_phone,
        "guest_country": data.guest_country,
        "special_requests": data.special_requests,
        "estimated_arrival_time": data.estimated_arrival_time,
        "number_of_guests": data.number_of_guests,
        "check_in": data.check_in.isoformat(),
        "check_out": data.check_out.isoformat(),
        "adults": data.adults,
        "children": data.children,
        "nightly_rate": pricing.nightly_rate,
        "number_of_rooms": data.number_of_rooms,
        "total_amount": pricing.total_amount,
        "currency": room["currency"],
        "referral_code": data.referral_code,
        "affiliate_id": affiliate_id,
        "payment_method": payment_method,
        "host_response_deadline": deadline.isoformat() if deadline else None,
        # Freeze the checkout decision. Hotel settings can change while the
        # guest is entering card details, but this booking must keep the
        # request/instant semantics and Stripe capture mode it was offered.
        "use_request_flow": use_request_flow,
        "capture_method": capture_method,
        "rate_type": data.rate_type,
        "addon_ids": data.addon_ids or [],
        "addon_names": pricing.addon_names,
        "addon_total": pricing.addon_total,
        "addon_quantities": data.addon_quantities or {},
        "addon_dates": data.addon_dates or {},
        "promo_code": pricing.promo_code,
        "promo_discount": pricing.promo_discount,
        "last_minute_discount_percent": pricing.last_minute_discount_pct,
        "last_minute_discount_amount": pricing.last_minute_discount_amount,
        "deposit_required": deposit.required,
        "deposit_percentage": deposit.percentage,
        "deposit_amount": deposit.amount,
        "balance_amount": deposit.balance,
    }


def _draft_preview_response(
    *,
    draft_id: str,
    booking_reference: str,
    hotel: dict,
    room: dict,
    data: BookingCreate,
    pricing: BookingPricing,
    deadline: datetime | None,
    deposit: DepositSnapshot,
) -> dict:
    """Booking-shaped placeholder returned to the frontend before the real
    row exists. The fields that the booking-engine reads on the payment
    page (totals, dates, hotel/room name) are filled; PMS-only fields
    (status, payment_status) are left as the moral equivalent of pending
    so the UI doesn't render confirmed-state copy by mistake."""
    return {
        "id": "",
        "bookingReference": booking_reference,
        "hotelName": hotel["name"],
        "roomName": room["name"],
        "guestFirstName": data.guest_first_name,
        "guestLastName": data.guest_last_name,
        "guestEmail": data.guest_email,
        "checkIn": data.check_in.isoformat(),
        "checkOut": data.check_out.isoformat(),
        "nights": _nights(data.check_in, data.check_out),
        "adults": data.adults,
        "children": data.children,
        "nightlyRate": pricing.nightly_rate,
        "numberOfRooms": data.number_of_rooms,
        "totalAmount": pricing.total_amount,
        "depositRequired": deposit.required,
        "depositPercentage": deposit.percentage,
        "depositAmount": deposit.amount,
        "balanceAmount": deposit.balance,
        "addonTotal": pricing.addon_total,
        "currency": room["currency"],
        "status": "draft",
        "paymentMethod": "card",
        "paymentStatus": "unpaid",
        "hostResponseDeadline": deadline.isoformat() if deadline else None,
        "createdAt": datetime.now(UTC).isoformat(),
        "draftId": draft_id,
    }


async def _create_booking_draft(
    *,
    slug: str,
    data: BookingCreate,
    hotel: dict,
    hotel_id: str,
    room: dict,
    pricing: BookingPricing,
    affiliate_id: str | None,
    hotel_settings: dict | None,
    deadline: datetime | None,
    capture_method: str,
    instant_book: bool,
    deposit: DepositSnapshot,
) -> dict:
    """Card-path branch of create_booking_request. Skips the booking row
    entirely (no inventory commit, no Channex push, no host email) and
    leaves a soft-hold draft + Stripe PaymentIntent that can be
    materialized once the guest authorizes the card.

    The draft itself is what holds inventory (see availability_service)
    and the booking_reference is generated upfront so emails sent on
    materialization can refer to a stable code.
    """
    booking_reference = await BookingDraftRepository.generate_reference()
    stripe_intent = await _create_card_payment_intent_for_draft(
        hotel_id=hotel_id,
        hotel_settings=hotel_settings,
        currency=room["currency"],
        charge_amount=_payment_amount_for_booking(pricing.total_amount, deposit),
        booking_total_amount=pricing.total_amount,
        affiliate_id=affiliate_id,
        capture_method=capture_method,
        booking_reference=booking_reference,
    )

    payload = _booking_draft_payload(
        data=data,
        hotel_id=hotel_id,
        room=room,
        pricing=pricing,
        affiliate_id=affiliate_id,
        payment_method="card",
        deadline=deadline,
        use_request_flow=not instant_book,
        capture_method=capture_method,
        deposit=deposit,
    )

    draft = await BookingDraftRepository.create(
        hotel_id=hotel_id,
        room_type_id=data.room_type_id,
        check_in=data.check_in,
        check_out=data.check_out,
        number_of_rooms=data.number_of_rooms,
        booking_reference=booking_reference,
        stripe_payment_intent_id=stripe_intent.payment_intent_id,
        stripe_account_id=stripe_intent.account_id,
        stripe_application_fee_amount=stripe_intent.application_fee_amount,
        stripe_platform_fee_amount=stripe_intent.platform_fee_amount,
        stripe_affiliate_commission_amount=stripe_intent.affiliate_commission_amount,
        payload=payload,
    )

    preview = _draft_preview_response(
        draft_id=str(draft["id"]),
        booking_reference=booking_reference,
        hotel=hotel,
        room=room,
        data=data,
        pricing=pricing,
        deadline=deadline,
        deposit=deposit,
    )
    return {
        "booking": preview,
        "clientSecret": stripe_intent.client_secret,
        "xenditInvoiceUrl": None,
        "paymentMethod": "card",
        "draftId": str(draft["id"]),
        "bookingReference": booking_reference,
        "stripeAccountId": stripe_intent.account_id,
        "instantBook": instant_book,
    }


async def quote_booking_request(slug: str, data: BookingCreate) -> BookingQuoteResponse:
    """Return the authoritative checkout quote for the current booking payload.

    The payment page uses this instead of reconstructing totals in the browser,
    and booking creation reruns the same code path before snapshotting the row.
    """
    context = await _prepare_booking_context(slug, data)
    pricing = await _compute_booking_pricing(
        slug,
        data,
        context.hotel,
        context.room,
        context.nights,
    )
    deposit = _resolve_deposit_snapshot(context.room, data.rate_type, pricing.total_amount)
    return _quote_to_response(data=data, room=context.room, pricing=pricing, deposit=deposit)


def _draft_payload_data(draft: dict) -> dict:
    payload = draft.get("payload") or {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError):
            return {}
    return payload if isinstance(payload, dict) else {}


def _draft_uses_request_flow(payload: dict) -> bool:
    if "use_request_flow" in payload:
        return bool(payload["use_request_flow"])
    # Backwards compatibility for drafts created before VAY-1266. The
    # deadline was already frozen at checkout and is safer than rereading the
    # hotel's mutable instant_book setting.
    return bool(payload.get("host_response_deadline"))


def _draft_capture_method(payload: dict) -> str:
    capture_method = payload.get("capture_method")
    if capture_method in ("automatic", "manual"):
        return capture_method
    return (
        "manual"
        if _draft_uses_request_flow(payload) and not payload.get("deposit_required")
        else "automatic"
    )


def _payment_outcome_from_intent(draft: dict, payment_intent: dict) -> str:
    """Validate Stripe's state against the checkout snapshot."""
    if payment_intent.get("id") != draft.get("stripe_payment_intent_id"):
        raise ValueError("Stripe payment does not match this booking")

    payload = _draft_payload_data(draft)
    expected_capture_method = _draft_capture_method(payload)
    actual_capture_method = payment_intent.get("capture_method")
    if actual_capture_method != expected_capture_method:
        raise ValueError("Stripe payment capture mode does not match this booking")

    status = payment_intent.get("status")
    if status == "requires_capture" and actual_capture_method == "manual":
        return "authorized"
    if status == "succeeded":
        return "captured"
    raise ValueError("Stripe payment has not completed")


def _should_advance_card_payment(current_status: str | None, target_status: str) -> bool:
    if target_status == "captured":
        return current_status not in ("captured", "refunded", "partially_refunded")
    return current_status in (None, "unpaid", "pending")


async def _complete_materialized_draft(
    draft: dict,
    booking: dict,
    *,
    payment_status: str,
    newly_materialized: bool,
) -> dict:
    """Apply the frozen request/instant outcome to a materialized draft.

    This runs from both the browser confirmation and Stripe webhook paths.
    Re-entry repairs a captured instant booking left pending by a prior
    finalization failure without replaying request-flow notifications.
    """
    booking_id = str(booking["id"])
    payment = await PaymentRepository.get_by_stripe_pi(draft["stripe_payment_intent_id"])
    if payment and _should_advance_card_payment(payment.get("status"), payment_status):
        await PaymentRepository.update_status(str(payment["id"]), payment_status)
    if _should_advance_card_payment(booking.get("payment_status"), payment_status):
        await BookingRepository.update_payment_status(booking_id, payment_status)
        booking = await BookingRepository.get_by_id(booking_id)

    payload = _draft_payload_data(draft)
    if _draft_uses_request_flow(payload):
        if newly_materialized:
            _create_task(send_guest_booking_requested(booking["guest_email"], booking))
            hotel = await Database.fetchrow(
                "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
            )
            if hotel:
                _create_task(send_booking_request_notification(hotel["contact_email"], booking))
            _create_task(
                push_availability_for_room_type(booking["hotel_id"], booking["room_type_id"])
            )
        return booking

    if payment_status != "captured":
        raise ValueError("Instant booking payment has not been captured")
    return await _finalize_accepted_booking(booking_id, capture_card=False)


async def materialize_draft(
    draft: dict,
    *,
    payment_status: str,
) -> dict | None:
    """Atomically convert a soft-hold draft into a real booking + payment row.

    ``payment_status`` is the new payments.status (typically "authorized"
    for the request flow, "captured" for instant-book). The atomic claim
    stamps the new booking_id onto the draft (rather than DELETEing it),
    so a second caller — sequential retry or webhook racing
    confirm-authorization — can resolve back to the same booking via
    ``draft.materialized_booking_id``.

    Returns the booking row on success, None if another caller already
    materialized this draft.
    """
    # Atomic claim — pre-allocate the booking id and stamp it on the
    # draft. Exactly one concurrent caller wins; the rest see no rows
    # and fall through to the existing get-by-stripe-pi resolution.
    # The draft row is intentionally NOT deleted — keeping it (with the
    # link set) lets a sequential retry of confirm-authorization resolve
    # back to the same booking instead of 400-ing.
    new_booking_id = str(uuid.uuid4())
    claimed = await BookingDraftRepository.claim_for_materialization(
        str(draft["id"]), new_booking_id
    )
    if not claimed:
        return None

    payload = _draft_payload_data(claimed)

    booking_data = dict(payload)
    booking_data["id"] = new_booking_id
    booking_data["check_in"] = date.fromisoformat(booking_data["check_in"])
    booking_data["check_out"] = date.fromisoformat(booking_data["check_out"])
    deadline_str = booking_data.get("host_response_deadline")
    booking_data["host_response_deadline"] = (
        datetime.fromisoformat(deadline_str) if deadline_str else None
    )
    booking_data["payment_status"] = payment_status
    # Materialize first, then let the frozen checkout decision drive the
    # shared finalizer. This keeps request-flow deposits pending and makes an
    # automatically captured instant booking take the full accepted path.
    booking_data["status"] = "pending"

    # The draft already pre-allocated a reference; reuse it so the
    # PaymentIntent metadata + any guest-side links stay consistent.
    booking_data["booking_reference"] = claimed["booking_reference"]

    # Last-mile race: by the time we materialize, another booking may
    # have taken the room (legitimate or not). Prefer assigning a unit,
    # fall back to leaving room_id NULL — host can reassign manually.
    # VAY-397: if no direct fit and the hotel has auto-rearrange on,
    # `resolve_assignment` returns a packing that moves existing future
    # bookings to free a slot.
    # VAY-403: a card multi-room booking must claim one physical room per
    # booked room here too, otherwise only the first is blocked.
    room_id, extra_room_ids, rearrange_moves = await resolve_room_assignments(
        booking_data["hotel_id"],
        booking_data["room_type_id"],
        booking_data["check_in"],
        booking_data["check_out"],
        int(booking_data.get("number_of_rooms") or 1),
    )
    if rearrange_moves:
        # Apply moves before INSERT so the target room is genuinely free
        # at insert time — keeps the bookings table free of any transient
        # double-assignment between INSERT and move-apply.
        await apply_moves_atomic(rearrange_moves)
    if room_id:
        booking_data["room_id"] = room_id
    if extra_room_ids:
        booking_data["extra_room_ids"] = extra_room_ids

    promo_slug = None
    promo_claimed = False
    try:
        if booking_data.get("promo_code"):
            promo_hotel = await Database.fetchrow(
                "SELECT slug FROM hotels WHERE id = $1", booking_data["hotel_id"]
            )
            if not promo_hotel:
                raise ValueError("Promo hotel not found")
            promo_slug = str(promo_hotel["slug"])
            await claim_promo_use(
                hotel_slug=promo_slug,
                promo_code=str(booking_data["promo_code"]),
                booking_reference=str(booking_data["booking_reference"]),
                check_in=booking_data["check_in"],
                room_type_id=str(booking_data["room_type_id"]),
                booking_total=float(booking_data["total_amount"])
                + float(booking_data.get("promo_discount") or 0),
            )
            promo_claimed = True
        booking_row = await BookingRepository.create(booking_data)
    except Exception:
        if promo_claimed and promo_slug:
            try:
                await reverse_promo_use(
                    hotel_slug=promo_slug,
                    promo_code=str(booking_data["promo_code"]),
                    booking_reference=str(booking_data["booking_reference"]),
                )
            except Exception:
                logger.exception("Failed to compensate promo claim after booking insert failure")
        await BookingDraftRepository.release_materialization_claim(
            str(claimed["id"]), new_booking_id
        )
        raise
    booking_id = str(booking_row["id"])

    if rearrange_moves:
        await record_auto_rearrange(
            hotel_id=booking_data["hotel_id"],
            moves=rearrange_moves,
            triggered_by_booking_id=booking_id,
            triggered_by_guest_name=(
                f"{booking_data.get('guest_first_name', '')} "
                f"{booking_data.get('guest_last_name', '')}"
            ).strip()
            or "guest",
        )

    await PaymentRepository.create(
        booking_id=booking_id,
        amount=_payment_amount_for_booking(
            float(booking_data["total_amount"]),
            DepositSnapshot(
                required=bool(booking_data.get("deposit_required")),
                percentage=booking_data.get("deposit_percentage"),
                amount=float(booking_data.get("deposit_amount") or 0),
                balance=float(booking_data.get("balance_amount") or 0),
            ),
        ),
        currency=booking_data["currency"],
        payment_method="card",
        stripe_pi_id=claimed["stripe_payment_intent_id"],
        stripe_account_id=claimed.get("stripe_account_id"),
        stripe_application_fee_amount=float(claimed.get("stripe_application_fee_amount") or 0),
        stripe_platform_fee_amount=float(claimed.get("stripe_platform_fee_amount") or 0),
        stripe_affiliate_commission_amount=float(
            claimed.get("stripe_affiliate_commission_amount") or 0
        ),
        payment_purpose="deposit" if booking_data.get("deposit_required") else "booking",
    )
    payment = await PaymentRepository.get_by_stripe_pi(claimed["stripe_payment_intent_id"])
    if payment:
        status_fields = {"captured_at": datetime.now(UTC)} if payment_status == "captured" else {}
        await PaymentRepository.update_status(str(payment["id"]), payment_status, **status_fields)

    booking = await BookingRepository.get_by_id(booking_id)
    return await _complete_materialized_draft(
        claimed,
        booking,
        payment_status=payment_status,
        newly_materialized=True,
    )


async def _create_xendit_payment(
    booking_id: str,
    booking_reference: str,
    hotel: dict,
    hotel_id: str,
    currency: str,
    charge_amount: float,
    guest_email: str,
    deposit: DepositSnapshot,
) -> str:
    """Create a Xendit invoice, store the payment record, and return the
    hosted-checkout URL. Cleans up the booking on Xendit failure."""
    try:
        invoice = await xendit_service.create_invoice(
            external_id=f"booking-{booking_id}",
            amount=charge_amount,
            currency=currency,
            payer_email=guest_email,
            description=f"Booking {booking_reference} at {hotel['name']}",
            success_redirect_url=(
                f"{settings.BOOKING_ENGINE_URL}/{hotel['slug']}/booking/{booking_id}/confirmation"
            ),
            failure_redirect_url=(
                f"{settings.BOOKING_ENGINE_URL}/{hotel['slug']}/payment?failed=true"
            ),
            metadata={"booking_id": booking_id, "hotel_id": hotel_id},
        )
    except Exception:
        await Database.execute("DELETE FROM bookings WHERE id = $1", booking_id)
        raise

    await PaymentRepository.create(
        booking_id=booking_id,
        amount=charge_amount,
        currency=currency,
        payment_method="xendit",
        xendit_invoice_id=invoice["id"],
        xendit_invoice_url=invoice["invoice_url"],
        payment_purpose=_payment_purpose_for_booking(deposit),
    )
    return invoice["invoice_url"]


async def _process_payment_method(
    payment_method: str,
    booking_id: str,
    booking_row: dict,
    hotel: dict,
    hotel_id: str,
    hotel_settings: dict | None,
    currency: str,
    total_amount: float,
    guest_email: str,
    use_request_flow: bool,
    capture_method: str,
    deposit: DepositSnapshot,
) -> PaymentOutcome:
    """Dispatch the payment-method-specific work after the booking row
    exists. Xendit raises (and cleans up) on provider failure;
    bank-transfer and pay-at-property always succeed but trigger emails.

    The card path is intentionally absent here — VAY-388 defers the
    booking row entirely until the Stripe PaymentIntent succeeds, so
    create_booking_request returns early with a draft handle and never
    reaches this dispatcher when payment_method == 'card'.
    """
    outcome = PaymentOutcome()

    if payment_method == "xendit":
        outcome.xendit_invoice_url = await _create_xendit_payment(
            booking_id,
            booking_row["booking_reference"],
            hotel,
            hotel_id,
            currency,
            _payment_amount_for_booking(total_amount, deposit),
            guest_email,
            deposit,
        )

    elif payment_method == "bank_transfer":
        # Bank transfer — guest transfers directly, hotel verifies manually.
        # Always uses the request flow (no money has moved, so we cannot
        # auto-confirm even when the hotel has instant-book on).
        await PaymentRepository.create(
            booking_id=booking_id,
            amount=_payment_amount_for_booking(total_amount, deposit),
            currency=currency,
            payment_method="bank_transfer",
            payment_purpose=_payment_purpose_for_booking(deposit),
        )
        await BookingRepository.update_payment_status(booking_id, "awaiting_transfer")
        booking = await BookingRepository.get_by_id(booking_id)
        _create_task(send_booking_request_notification(hotel["contact_email"], booking))

    elif payment_method == "paypal":
        await PaymentRepository.create(
            booking_id=booking_id,
            amount=total_amount,
            currency=currency,
            payment_method="paypal",
        )
        await BookingRepository.update_payment_status(booking_id, "awaiting_paypal")
        booking = await BookingRepository.get_by_id(booking_id)
        task = _create_task(send_booking_request_notification(hotel["contact_email"], booking))
        task.add_done_callback(
            lambda t: _log_background_task_result(t, "send_booking_request_notification")
        )

    else:
        # Pay at property
        await PaymentRepository.create(
            booking_id=booking_id,
            amount=total_amount,
            currency=currency,
            payment_method="pay_at_property",
        )
        await BookingRepository.update_payment_status(booking_id, "pay_at_property")
        if use_request_flow:
            booking = await BookingRepository.get_by_id(booking_id)
            _create_task(send_booking_request_notification(hotel["contact_email"], booking))
        else:
            # Instant-book: confirm right away. _finalize_accepted_booking
            # sends the host + guest "accepted" emails.
            await _finalize_accepted_booking(booking_id, capture_card=False)

    return outcome


async def create_booking_request(slug: str, data: BookingCreate) -> dict:
    """New guest-facing flow: validates + prices + creates booking +
    dispatches payment. Returns booking data + provider-specific
    handles (Stripe client_secret or Xendit invoice URL)."""
    context = await _prepare_booking_context(slug, data)
    hotel = context.hotel
    hotel_id = context.hotel_id
    instant_book = context.instant_book
    room = context.room
    nights = context.nights

    # ── Compute pricing (rooms + addons + promo + last-minute discount) ──
    pricing = await _compute_booking_pricing(slug, data, hotel, room, nights)
    _ensure_expected_total_matches(data, pricing)
    deposit = _resolve_deposit_snapshot(room, data.rate_type, pricing.total_amount)

    # ── Resolve affiliate ──────────────────────────────────────────
    affiliate_id = None
    if data.referral_code:
        affiliate = await Database.fetchrow(
            "SELECT id FROM affiliates "
            "WHERE hotel_id = $1 AND referral_code = $2 AND status = 'approved'",
            hotel_id,
            data.referral_code,
        )
        if affiliate:
            affiliate_id = str(affiliate["id"])

    # ── Validate hotel-level payment-method enablement ─────────────
    payment_method = data.payment_method
    hotel_settings = None
    bank_transfer_info = None
    be_payment_info = None
    if payment_method in ("pay_at_property", "xendit", "card", "bank_transfer"):
        hotel_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    be_payment_flags = await hotel_identity_service.get_payment_flags_by_slug(slug)
    pay_at_property_enabled = (
        be_payment_flags.get("pay_at_property_enabled")
        if be_payment_flags is not None
        else (hotel_settings["pay_at_property_enabled"] if hotel_settings else False)
    )
    bank_transfer_enabled = (
        be_payment_flags.get("bank_transfer")
        if be_payment_flags is not None
        else (hotel_settings.get("bank_transfer") if hotel_settings else False)
    )
    if payment_method == "pay_at_property":
        if deposit.required:
            raise ValueError(
                "Pay at property is not available because this rate requires a deposit"
            )
        if not pay_at_property_enabled:
            raise ValueError("Pay at property is not enabled for this hotel")
    elif payment_method == "xendit":
        if not hotel_settings or not hotel_settings.get("xendit_payments_enabled"):
            raise ValueError("Xendit payments are not enabled for this hotel")
    elif payment_method == "bank_transfer":
        if not bank_transfer_enabled:
            raise ValueError("Bank transfer is not enabled for this hotel")
        bank_transfer_info = await hotel_identity_service.get_guest_payment_info_by_slug(slug)
        if not _bank_details_complete(bank_transfer_info):
            raise ValueError("Bank transfer details are incomplete for this hotel")
    elif payment_method == "paypal":
        be_payment_info = await hotel_identity_service.get_guest_payment_info_by_slug(slug)
        if (
            not be_payment_flags
            or not be_payment_flags.get("paypal_enabled")
            or not be_payment_info
            or not be_payment_info.get("paypal_email")
        ):
            raise ValueError("PayPal is not enabled for this hotel")

    # Manual off-platform methods always stay in the request flow,
    # even when instant_book is on — there's no money yet, so we can't
    # auto-confirm.
    use_request_flow = (not instant_book) or payment_method in ("bank_transfer", "paypal")
    payment_window_hours = (
        int(be_payment_info.get("paypal_payment_window_hours") or HOST_RESPONSE_HOURS)
        if payment_method == "paypal"
        else HOST_RESPONSE_HOURS
    )
    deadline = (
        datetime.now(UTC) + timedelta(hours=payment_window_hours) if use_request_flow else None
    )
    # Deposit card payments are captured immediately even in request-flow
    # hotels — the guest pays the deposit upfront and it is refunded on rejection.
    capture_method = "manual" if (use_request_flow and not deposit.required) else "automatic"

    # ── Card path: defer the booking row until Stripe authorizes ──
    # VAY-388: an unauthorized card-payment booking must not exist in
    # the PMS or block inventory. We persist a soft-hold draft instead
    # and let the webhook (or confirm-authorization) materialize it.
    if payment_method == "card":
        return await _create_booking_draft(
            slug=slug,
            data=data,
            hotel=hotel,
            hotel_id=hotel_id,
            room=room,
            pricing=pricing,
            affiliate_id=affiliate_id,
            hotel_settings=hotel_settings,
            deadline=deadline,
            capture_method=capture_method,
            instant_book=instant_book,
            deposit=deposit,
        )

    # ── Persist booking row + auto-assign a room unit ──────────────
    booking_data = {
        "hotel_id": hotel_id,
        "room_type_id": data.room_type_id,
        "guest_first_name": data.guest_first_name,
        "guest_last_name": data.guest_last_name,
        "guest_email": data.guest_email,
        "guest_phone": data.guest_phone,
        "guest_country": data.guest_country,
        "special_requests": data.special_requests,
        "estimated_arrival_time": data.estimated_arrival_time,
        "number_of_guests": data.number_of_guests,
        "check_in": data.check_in,
        "check_out": data.check_out,
        "adults": data.adults,
        "children": data.children,
        "nightly_rate": pricing.nightly_rate,
        "number_of_rooms": data.number_of_rooms,
        "total_amount": pricing.total_amount,
        "currency": room["currency"],
        "referral_code": data.referral_code,
        "affiliate_id": affiliate_id,
        "payment_method": payment_method,
        "payment_status": "unpaid",
        "host_response_deadline": deadline,
        "rate_type": data.rate_type,
        "addon_ids": data.addon_ids or [],
        "addon_names": pricing.addon_names,
        "addon_total": pricing.addon_total,
        "addon_quantities": data.addon_quantities or {},
        "addon_dates": data.addon_dates or {},
        "promo_code": pricing.promo_code,
        "promo_discount": pricing.promo_discount,
        "last_minute_discount_percent": pricing.last_minute_discount_pct,
        "last_minute_discount_amount": pricing.last_minute_discount_amount,
    }
    _apply_deposit_snapshot(booking_data, deposit)
    # VAY-397: same auto-rearrange path as the draft-materialize flow.
    # VAY-403: assign one physical room per booked room, not just one.
    room_id, extra_room_ids, rearrange_moves = await resolve_room_assignments(
        hotel_id,
        data.room_type_id,
        data.check_in,
        data.check_out,
        data.number_of_rooms,
    )
    if rearrange_moves:
        await apply_moves_atomic(rearrange_moves)
    if room_id:
        booking_data["room_id"] = room_id
    if extra_room_ids:
        booking_data["extra_room_ids"] = extra_room_ids

    promo_claimed = False
    if pricing.promo_code:
        booking_data["booking_reference"] = await BookingDraftRepository.generate_reference()
    try:
        if pricing.promo_code:
            await claim_promo_use(
                hotel_slug=slug,
                promo_code=pricing.promo_code,
                booking_reference=str(booking_data["booking_reference"]),
                check_in=data.check_in,
                room_type_id=data.room_type_id,
                booking_total=pricing.total_amount + pricing.promo_discount,
            )
            promo_claimed = True
        booking_row = await BookingRepository.create(booking_data)
    except Exception:
        if promo_claimed:
            try:
                await reverse_promo_use(
                    hotel_slug=slug,
                    promo_code=pricing.promo_code,
                    booking_reference=str(booking_data["booking_reference"]),
                )
            except Exception:
                logger.exception("Failed to compensate promo claim after booking insert failure")
        raise
    booking_id = str(booking_row["id"])

    if rearrange_moves:
        await record_auto_rearrange(
            hotel_id=hotel_id,
            moves=rearrange_moves,
            triggered_by_booking_id=booking_id,
            triggered_by_guest_name=(
                f"{data.guest_first_name} {data.guest_last_name}".strip() or "guest"
            ),
        )

    # ── Dispatch the chosen payment method ─────────────────────────
    try:
        outcome = await _process_payment_method(
            payment_method=payment_method,
            booking_id=booking_id,
            booking_row=booking_row,
            hotel=hotel,
            hotel_id=hotel_id,
            hotel_settings=hotel_settings,
            currency=room["currency"],
            total_amount=pricing.total_amount,
            guest_email=data.guest_email,
            use_request_flow=use_request_flow,
            capture_method=capture_method,
            deposit=deposit,
        )
    except Exception:
        # Xendit removes the booking when invoice creation fails. Release the
        # promo claim only when no discounted booking remains persisted.
        persisted_booking = await BookingRepository.get_by_id(booking_id)
        if promo_claimed and not persisted_booking:
            try:
                await reverse_promo_use(
                    hotel_slug=slug,
                    promo_code=str(pricing.promo_code),
                    booking_reference=str(booking_data["booking_reference"]),
                )
            except Exception:
                logger.exception("Failed to compensate promo claim after payment setup failure")
        raise

    # ── Build response + side effects ──────────────────────────────
    booking = await BookingRepository.get_by_id(booking_id)
    if payment_method == "paypal" and be_payment_info:
        booking = dict(booking)
        booking["paypal_email"] = be_payment_info.get("paypal_email") or ""
    response = _booking_to_response(booking)

    # Guest "request received" email only for the request flow;
    # _finalize_accepted_booking sends the equivalent under instant-book.
    if use_request_flow:
        guest_email_booking = booking
        if payment_method == "bank_transfer" and bank_transfer_info:
            guest_email_booking = {**booking, "bank_details": bank_transfer_info}
        _create_task(send_guest_booking_requested(data.guest_email, guest_email_booking))

    # Push updated availability to Channex so OTAs reflect the reduced inventory
    _create_task(push_availability_for_room_type(hotel_id, data.room_type_id))

    return {
        "booking": response.model_dump(by_alias=True),
        "clientSecret": outcome.client_secret,
        "xenditInvoiceUrl": outcome.xendit_invoice_url,
        "paymentMethod": payment_method,
    }


async def confirm_payment_authorized(handle: str) -> dict:
    """Called by the booking-engine after Stripe.confirmPayment resolves.

    ``handle`` is either a soft-hold draft id (VAY-388 card flow) or a
    legacy booking id. The draft path materializes the booking
    synchronously so the frontend can redirect to the confirmation page
    without polling; the booking-id path keeps working for callers that
    haven't been migrated yet (no current production caller, but tests
    and external integrations may still send a booking id).

    Idempotent on both branches: a second call after the Stripe webhook
    already materialized the draft returns the same booking.
    """
    draft = await BookingDraftRepository.get_by_id(handle)
    if draft:
        try:
            return await _confirm_draft_payment(draft, handle)
        except Exception:
            # The payment and booking are authoritative. Email or ARI delivery
            # may still need a webhook retry, but that must not send a paid
            # guest back to checkout with a payment error.
            booking = await _wait_for_confirmed_draft_booking(handle)
            if booking:
                logger.exception(
                    "Booking %s confirmed with incomplete post-payment effects; "
                    "returning confirmation while Stripe retries delivery",
                    booking["id"],
                )
                return _booking_to_response(booking).model_dump(by_alias=True)
            raise

    booking = await BookingRepository.get_by_id(handle)
    if not booking:
        raise ValueError("Booking not found")
    if booking["payment_status"] == "authorized":
        # Webhook beat us to it — same idempotent shape.
        return _booking_to_response(booking).model_dump(by_alias=True)
    if booking["status"] != "pending":
        raise ValueError("Booking is not in pending state")

    payment = await PaymentRepository.get_by_booking_id(handle)
    if payment:
        await PaymentRepository.update_status(str(payment["id"]), "authorized")

    await BookingRepository.update_payment_status(handle, "authorized")

    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    if hotel:
        _create_task(send_booking_request_notification(hotel["contact_email"], booking))

    booking = await BookingRepository.get_by_id(handle)
    return _booking_to_response(booking).model_dump(by_alias=True)


async def _wait_for_confirmed_draft_booking(
    handle: str, timeout_seconds: float = 3.0
) -> dict | None:
    """Let a concurrent webhook finish a paid booking before returning an error."""
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while True:
        draft = await BookingDraftRepository.get_by_id(handle)
        booking_id = draft.get("materialized_booking_id") if draft else None
        if not booking_id:
            return None
        booking = await BookingRepository.get_by_id(str(booking_id))
        if booking and booking["status"] == "confirmed":
            return booking
        if booking and booking["status"] != "pending":
            return None
        if asyncio.get_running_loop().time() >= deadline:
            return None
        await asyncio.sleep(0.05)


async def _confirm_draft_payment(draft: dict, handle: str) -> dict:
    payment_intent = await stripe_service.retrieve_payment_intent(
        draft["stripe_payment_intent_id"],
        **(
            {"stripe_account": draft["stripe_account_id"]} if draft.get("stripe_account_id") else {}
        ),
    )
    payment_status = _payment_outcome_from_intent(draft, payment_intent)

    # Already materialized (sequential retry, or webhook beat us
    # and we're the second caller) — return the linked booking.
    if draft.get("materialized_booking_id"):
        booking = await BookingRepository.get_by_id(str(draft["materialized_booking_id"]))
        if booking is None:
            raise ValueError("Booking not found")
        booking = await _complete_materialized_draft(
            draft,
            booking,
            payment_status=payment_status,
            newly_materialized=False,
        )
        return _booking_to_response(booking).model_dump(by_alias=True)

    booking = await materialize_draft(
        draft,
        payment_status=payment_status,
    )
    if booking is None:
        # Lost the claim to a concurrent caller — load the booking
        # that the winner just created (link is now set on the draft).
        refetched = await BookingDraftRepository.get_by_id(handle)
        if refetched and refetched.get("materialized_booking_id"):
            booking = await BookingRepository.get_by_id(str(refetched["materialized_booking_id"]))
        if booking is None:
            payment = await PaymentRepository.get_by_stripe_pi(draft["stripe_payment_intent_id"])
            if not payment:
                raise ValueError("Booking materialization failed")
            booking = await BookingRepository.get_by_id(str(payment["booking_id"]))
        booking = await _complete_materialized_draft(
            draft,
            booking,
            payment_status=payment_status,
            newly_materialized=False,
        )
    return _booking_to_response(booking).model_dump(by_alias=True)


async def _deliver_booking_notification_once(
    booking_id: str,
    notification_type: str,
    recipient_email: str,
    sender,
) -> None:
    if await BookingRepository.notification_was_delivered(
        booking_id, notification_type, recipient_email
    ):
        return
    delivered = await sender()
    if delivered is False:
        raise RuntimeError(f"Booking notification failed for {recipient_email}")
    await BookingRepository.mark_notification_delivered(
        booking_id, notification_type, recipient_email
    )


async def _deliver_accepted_booking_effects(booking: dict, finalization_token: str) -> dict:
    """Deliver and checkpoint each accepted-booking side effect."""
    booking_id = str(booking["id"])
    if not booking.get("guest_confirmation_sent_at"):
        await _deliver_booking_notification_once(
            booking_id,
            "accepted_guest",
            booking["guest_email"],
            lambda: send_guest_booking_accepted(booking["guest_email"], booking),
        )
        marked = await BookingRepository.mark_finalization_effect(
            booking_id, finalization_token, "guest"
        )
        if not marked:
            raise RuntimeError("Booking finalization claim was lost")
        booking = {**booking, **marked}

    if not booking.get("host_confirmation_sent_at"):
        hotel = await Database.fetchrow(
            "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
        )
        hotel_email = hotel["contact_email"] if hotel else None
        for recipient in booking_host_notification_recipients(hotel_email):
            await _deliver_booking_notification_once(
                booking_id,
                "accepted_host",
                recipient,
                lambda recipient=recipient: send_host_booking_accepted_to(recipient, booking),
            )
        marked = await BookingRepository.mark_finalization_effect(
            booking_id, finalization_token, "host"
        )
        if not marked:
            raise RuntimeError("Booking finalization claim was lost")
        booking = {**booking, **marked}

    if not booking.get("ari_handoff_completed_at"):
        pushed = await push_ari_for_booking(booking_id)
        if pushed is False:
            raise RuntimeError("Booking availability handoff failed")
        marked = await BookingRepository.mark_finalization_effect(
            booking_id, finalization_token, "ari"
        )
        if not marked:
            raise RuntimeError("Booking finalization claim was lost")
        booking = {**booking, **marked}

    completed = await BookingRepository.complete_finalization(booking_id, finalization_token)
    if not completed:
        raise RuntimeError("Booking finalization could not be completed")
    return {**booking, **completed}


async def _finalize_accepted_booking(booking_id: str, *, capture_card: bool = True) -> dict:
    """Shared accept path: capture payment if needed, compute split, schedule
    payouts, mark booking confirmed, send accepted-emails, push Channex.

    Used by host_accept_booking (request flow) and by the instant-book branch
    in create_booking_request / payment webhooks. ``capture_card=False`` skips
    the manual Stripe capture step (e.g. when the PaymentIntent was created
    with automatic capture and Stripe captured at confirm time).
    """
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking:
        raise ValueError("Booking not found")
    if booking["status"] == "confirmed" and (
        booking.get("finalization_completed_at") or not booking.get("finalization_started_at")
    ):
        return booking

    finalization_token = str(uuid.uuid4())
    if not await BookingRepository.claim_finalization(booking_id, finalization_token):
        current = await BookingRepository.get_by_id(booking_id)
        if current and current.get("finalization_completed_at"):
            return current
        if await PaymentRepository.has_active_stripe_refund(booking_id):
            raise ValueError("A refund is still processing for this booking")
        raise RuntimeError("Booking finalization is already in progress")

    try:
        if booking["status"] == "confirmed":
            return await _deliver_accepted_booking_effects(booking, finalization_token)

        # A previous attempt may have stopped after scheduling one payout. A
        # pending booking cannot have a valid payout yet, so rebuild the set.
        await PayoutRepository.delete_scheduled_by_booking(booking_id)

        hotel_id = str(booking["hotel_id"])
        payment_method = booking.get("payment_method", "card")

        payment = (
            await PaymentRepository.get_by_booking_id(booking_id)
            if payment_method == "card"
            else None
        )
        if payment_method == "card" and capture_card:
            if (
                payment
                and payment.get("stripe_payment_intent_id")
                and payment.get("status") not in ("captured", "refunded", "partially_refunded")
            ):
                await stripe_service.capture_payment_intent(
                    payment["stripe_payment_intent_id"],
                    idempotency_key=f"booking-capture-{booking_id}",
                    **(
                        {"stripe_account": payment["stripe_account_id"]}
                        if payment.get("stripe_account_id")
                        else {}
                    ),
                )
                await PaymentRepository.update_status(
                    str(payment["id"]), "captured", captured_at=datetime.now(UTC)
                )
        elif payment_method == "xendit":
            # Xendit Invoice payments are already captured when guest pays —
            # just make sure the row reflects that.
            payment = await PaymentRepository.get_by_booking_id(booking_id)
            if payment and payment["status"] != "captured":
                await PaymentRepository.update_status(
                    str(payment["id"]), "captured", captured_at=datetime.now(UTC)
                )
        elif payment_method == "paypal":
            payment = await PaymentRepository.get_by_booking_id(booking_id)
            if payment and payment["status"] != "captured":
                await PaymentRepository.update_status(
                    str(payment["id"]), "captured", captured_at=datetime.now(UTC)
                )

        has_affiliate = booking.get("affiliate_id") is not None
        affiliate_id = str(booking["affiliate_id"]) if has_affiliate else None

        total_amount = float(booking["total_amount"])
        if payment_method == "card" and payment and payment.get("stripe_account_id"):
            platform_fee = float(payment.get("stripe_platform_fee_amount") or 0)
            affiliate_commission = float(payment.get("stripe_affiliate_commission_amount") or 0)
            split = {
                "platform_fee": platform_fee,
                "affiliate_commission": affiliate_commission,
                "property_payout": round(total_amount - platform_fee - affiliate_commission, 2),
            }
        else:
            billing = await fetch_billing_config(hotel_id)
            affiliate_commission_pct = 0.0
            if affiliate_id:
                effective = await AffiliateRepository.get_effective_commission_pct(affiliate_id)
                if effective is not None:
                    affiliate_commission_pct = effective
            split = calculate_split(
                total_amount,
                plan=billing["active_plan"],
                channel=booking.get("channel", "direct"),
                booking_engine_fee_pct=billing["booking_engine_fee_pct"],
                channel_manager_fee_pct=billing["channel_manager_fee_pct"],
                affiliate_platform_fee_pct=billing["affiliate_platform_fee_pct"],
                has_affiliate=has_affiliate,
                effective_affiliate_commission_pct=affiliate_commission_pct,
            )

        if payment_method in ("card", "xendit", "paypal"):
            new_payment_status = "captured"
        else:
            new_payment_status = "pay_at_property"

        if payment_method in ("card", "xendit"):
            await schedule_payouts(
                booking_id=booking_id,
                hotel_id=hotel_id,
                total_amount=total_amount,
                currency=booking["currency"],
                affiliate_id=affiliate_id,
                affiliate_commission=split["affiliate_commission"],
                property_payout=split["property_payout"],
                check_out=booking["check_out"],
                schedule_hotel=not (
                    payment_method == "card" and payment and payment.get("stripe_account_id")
                ),
            )

        accepted = await BookingRepository.update_booking_accepted(
            booking_id,
            finalization_token=finalization_token,
            platform_fee=split["platform_fee"],
            affiliate_commission=split["affiliate_commission"],
            property_payout=split["property_payout"],
            payment_status=new_payment_status,
        )
        if not accepted:
            raise RuntimeError("Booking finalization claim was lost")

        updated = {**booking, **accepted}
        return await _deliver_accepted_booking_effects(updated, finalization_token)
    except Exception:
        current = await BookingRepository.get_by_id(booking_id)
        if current and current["status"] == "pending":
            await PayoutRepository.delete_scheduled_by_booking(booking_id)
        await BookingRepository.release_finalization_claim(booking_id, finalization_token)
        raise


def _schedule_unassigned_sweep(booking: dict) -> None:
    """Fire-and-forget the auto-place sweep after a cancellation.

    Only meaningful when the cancelled booking had a room — a previously
    Unassigned booking that just cancelled didn't free any slot. The sweep
    itself is a no-op when the hotel has the toggle off (VAY-397).
    """
    if not booking or not booking.get("room_id"):
        return
    _create_task(
        try_place_unassigned_after_cancellation(
            str(booking["hotel_id"]),
            str(booking["room_type_id"]),
            booking["check_in"],
            booking["check_out"],
        )
    )


async def host_accept_booking(booking_id: str, user_id: str) -> dict:
    """Host accepts a pending booking — captures payment if card."""
    hotel_id = await _get_hotel_id_for_user(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise ValueError("Booking not found")
    if await PaymentRepository.has_active_stripe_refund(booking_id):
        raise ValueError("A refund is still processing for this booking")
    if booking["status"] != "pending" and not (
        booking["status"] == "confirmed"
        and booking.get("finalization_started_at")
        and not booking.get("finalization_completed_at")
    ):
        raise ValueError("Booking is not in pending state")
    return await _finalize_accepted_booking(booking_id, capture_card=True)


def _stripe_refund_options(payment: dict) -> dict:
    account_id = payment.get("stripe_account_id")
    if not account_id:
        return {}
    options = {"stripe_account": account_id}
    if float(payment.get("stripe_application_fee_amount") or 0) > 0:
        options["refund_application_fee"] = True
    return options


def _stripe_refund_idempotency_key(base: str, payment: dict) -> str:
    if payment.get("stripe_refund_status") in ("failed", "canceled") and payment.get(
        "stripe_refund_id"
    ):
        return f"{base}-after-{payment['stripe_refund_id']}"
    return base


async def _create_recorded_stripe_refund(
    payment: dict,
    *,
    amount: int | None,
    refund_amount: float,
    refund_percentage: float,
    target_payment_status: str,
    target_booking_status: str,
    idempotency_key: str,
) -> str:
    booking = await BookingRepository.get_by_id(str(payment["booking_id"]))
    if not booking:
        raise ValueError("Booking not found")
    command_id = _stripe_refund_idempotency_key(idempotency_key, payment)
    refund_amount_minor = amount if amount is not None else int(math.ceil(refund_amount * 100))
    refund_currency = str(payment["currency"]).lower()
    prepared = await PaymentRepository.prepare_stripe_refund(
        str(payment["id"]),
        command_id=command_id,
        target_status=target_payment_status,
        target_booking_status=target_booking_status,
        expected_booking_status=booking["status"],
        refund_amount=refund_amount,
        refund_percentage=refund_percentage,
        refund_amount_minor=refund_amount_minor,
        refund_currency=refund_currency,
    )
    if not prepared:
        raise RuntimeError("Another Stripe refund is already active for this booking")
    refund = await stripe_service.create_refund(
        payment["stripe_payment_intent_id"],
        amount=amount,
        idempotency_key=command_id,
        metadata={
            "booking_id": str(payment["booking_id"]),
            "payment_id": str(payment["id"]),
            "refund_command_id": command_id,
            "refund_amount_minor": str(refund_amount_minor),
            "refund_currency": refund_currency,
        },
        **_stripe_refund_options(payment),
    )
    refund_id = refund.get("id")
    provider_status = refund.get("status")
    if not refund_id or not provider_status:
        raise RuntimeError("Stripe returned an incomplete refund response")
    attached = await PaymentRepository.attach_stripe_refund(
        str(payment["id"]), command_id, refund_id, provider_status
    )
    if not attached:
        raise RuntimeError(f"Stripe refund {refund_id} no longer matches its command")
    await reconcile_stripe_refund(refund_id, provider_status)
    latest = await PaymentRepository.get_by_stripe_refund(refund_id)
    actual_status = latest.get("stripe_refund_status") if latest else None
    if actual_status != "succeeded":
        raise RuntimeError(f"Stripe refund {refund_id} is {actual_status or provider_status}")
    return target_payment_status


async def reconcile_stripe_refund(refund_id: str, provider_status: str) -> dict | None:
    """Resume a known refund from its persisted provider state."""
    payment = await PaymentRepository.update_stripe_refund_status(refund_id, provider_status)
    actual_status = payment.get("stripe_refund_status") if payment else None
    if payment and actual_status in ("failed", "canceled"):
        await BookingRepository.release_stripe_refund_reservation(str(payment["booking_id"]))
    if not payment or actual_status != "succeeded":
        return payment
    return await _finish_succeeded_stripe_refund(payment)


async def reconcile_stripe_refund_event(refund: dict) -> dict | None:
    """Attach Stripe refund events to their pre-recorded command and resume it."""
    refund_id = refund.get("id")
    provider_status = refund.get("status")
    if not refund_id or not provider_status:
        raise RuntimeError("Stripe refund webhook is missing id or status")
    payment = await PaymentRepository.get_by_stripe_refund(refund_id)
    if not payment:
        metadata = refund.get("metadata") or {}
        payment_id = metadata.get("payment_id")
        command_id = metadata.get("refund_command_id")
        payment = await PaymentRepository.get_by_id(str(payment_id)) if payment_id else None
        if not payment or not payment.get("stripe_refund_command_id"):
            raise RuntimeError(f"Stripe refund {refund_id} has no prepared payment command")
        if command_id != payment["stripe_refund_command_id"]:
            logger.info("Ignoring stale Stripe refund event %s for superseded command", refund_id)
            return payment
        if str(refund.get("payment_intent")) != str(payment.get("stripe_payment_intent_id")):
            raise RuntimeError(f"Stripe refund {refund_id} does not match its payment")
        if int(refund.get("amount") or -1) != int(payment["stripe_refund_amount_minor"]):
            raise RuntimeError(f"Stripe refund {refund_id} has an unexpected amount")
        if (
            str(refund.get("currency") or "").lower()
            != str(payment["stripe_refund_currency"]).lower()
        ):
            raise RuntimeError(f"Stripe refund {refund_id} has an unexpected currency")
        if metadata.get("refund_amount_minor") != str(payment["stripe_refund_amount_minor"]):
            raise RuntimeError(f"Stripe refund {refund_id} metadata amount does not match")
        if (
            str(metadata.get("refund_currency") or "").lower()
            != str(payment["stripe_refund_currency"]).lower()
        ):
            raise RuntimeError(f"Stripe refund {refund_id} metadata currency does not match")
        payment = await PaymentRepository.attach_stripe_refund(
            str(payment["id"]), command_id, refund_id, provider_status
        )
        if not payment:
            raise RuntimeError(f"Stripe refund {refund_id} lost its prepared command")
    else:
        payment = await PaymentRepository.update_stripe_refund_status(refund_id, provider_status)
    actual_status = payment.get("stripe_refund_status") if payment else None
    if payment and actual_status in ("failed", "canceled"):
        await BookingRepository.release_stripe_refund_reservation(str(payment["booking_id"]))
    if not payment or actual_status != "succeeded":
        return payment
    return await _finish_succeeded_stripe_refund(payment)


async def _finish_succeeded_stripe_refund(payment: dict) -> dict:
    """Resume every mandatory post-refund effect from persisted checkpoints."""
    refund_id = payment["stripe_refund_id"]

    target_payment_status = payment.get("stripe_refund_target_status")
    target_booking_status = payment.get("stripe_refund_target_booking_status")
    expected_booking_status = payment.get("stripe_refund_expected_booking_status")
    if target_payment_status not in ("refunded", "partially_refunded"):
        raise RuntimeError(f"Refund {refund_id} has no valid payment target")
    if target_booking_status not in ("cancelled", "declined", "expired"):
        raise RuntimeError(f"Refund {refund_id} has no valid booking target")
    if expected_booking_status not in ("pending", "confirmed"):
        raise RuntimeError(f"Refund {refund_id} has no valid booking source")

    booking_id = str(payment["booking_id"])
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking:
        raise RuntimeError(f"Refund {refund_id} booking was not found")
    if booking["status"] not in (expected_booking_status, target_booking_status):
        raise RuntimeError(f"Refund {refund_id} cannot transition booking from {booking['status']}")

    if not payment.get("stripe_refund_payouts_cancelled_at"):
        await PayoutRepository.cancel_by_booking(booking_id)
        payment = await PaymentRepository.mark_stripe_refund_effect(str(payment["id"]), "payouts")

    await PaymentRepository.update_status(
        str(payment["id"]),
        target_payment_status,
        refunded_at=datetime.now(UTC),
        refund_amount=float(payment.get("refund_amount") or 0),
    )
    await BookingRepository.update_payment_status(booking_id, target_payment_status)
    if booking["status"] == expected_booking_status:
        transitioned = await BookingRepository.transition_status(
            booking_id, expected_booking_status, target_booking_status
        )
        if not transitioned:
            booking = await BookingRepository.get_by_id(booking_id)
            if not booking or booking["status"] != target_booking_status:
                raise RuntimeError(f"Refund {refund_id} lost its booking transition")

    updated = await BookingRepository.get_by_id(booking_id)
    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    notification_prefix = f"refund_{target_booking_status}"
    if target_booking_status == "cancelled" and expected_booking_status == "confirmed":
        await _deliver_booking_notification_once(
            booking_id,
            f"{notification_prefix}_guest",
            updated["guest_email"],
            lambda: send_guest_cancellation_refund(
                updated["guest_email"],
                updated,
                float(payment.get("refund_amount") or 0),
                float(payment.get("stripe_refund_percentage") or 0),
            ),
        )
        if hotel:
            await _deliver_booking_notification_once(
                booking_id,
                f"{notification_prefix}_host",
                hotel["contact_email"],
                lambda: send_host_guest_cancelled(hotel["contact_email"], updated),
            )
    elif target_booking_status == "cancelled":
        await Database.execute(
            "UPDATE bookings SET guest_withdrawn = true WHERE id = $1", booking_id
        )
        if hotel:
            await _deliver_booking_notification_once(
                booking_id,
                f"{notification_prefix}_host",
                hotel["contact_email"],
                lambda: send_host_booking_withdrawn(hotel["contact_email"], updated),
            )
        await _deliver_booking_notification_once(
            booking_id,
            f"{notification_prefix}_guest",
            updated["guest_email"],
            lambda: send_guest_booking_withdrawn(updated["guest_email"], updated),
        )
    elif target_booking_status == "declined":
        await _deliver_booking_notification_once(
            booking_id,
            f"{notification_prefix}_guest",
            updated["guest_email"],
            lambda: send_guest_booking_rejected(updated["guest_email"], updated),
        )
        if hotel:
            await _deliver_booking_notification_once(
                booking_id,
                f"{notification_prefix}_host",
                hotel["contact_email"],
                lambda: send_host_booking_rejected(hotel["contact_email"], updated),
            )
    else:
        await _deliver_booking_notification_once(
            booking_id,
            f"{notification_prefix}_guest",
            updated["guest_email"],
            lambda: send_guest_booking_expired(updated["guest_email"], updated),
        )
        if hotel:
            await _deliver_booking_notification_once(
                booking_id,
                f"{notification_prefix}_host",
                hotel["contact_email"],
                lambda: send_host_booking_expired(hotel["contact_email"], updated),
            )

    if not payment.get("stripe_refund_channex_cancelled_at"):
        await channex_handle_cancellation(booking_id)
        payment = await PaymentRepository.mark_stripe_refund_effect(str(payment["id"]), "channex")
    if not payment.get("stripe_refund_ari_handoff_completed_at"):
        pushed = await push_ari_for_booking(booking_id)
        if pushed is False:
            raise RuntimeError(f"Refund {refund_id} availability handoff failed")
        payment = await PaymentRepository.mark_stripe_refund_effect(str(payment["id"]), "ari")
    _schedule_unassigned_sweep(booking)
    completed = await PaymentRepository.complete_stripe_refund(str(payment["id"]))
    if not completed:
        raise RuntimeError(f"Refund {refund_id} effects are incomplete")
    await BookingRepository.release_stripe_refund_reservation(booking_id)
    return updated


async def _release_or_refund_card_payment(
    booking_id: str,
    payment: dict | None,
    *,
    target_booking_status: str,
) -> str:
    """Release an authorization or refund an already-captured request payment."""
    if not payment:
        return "cancelled"

    payment_status = payment.get("status")
    if payment_status in ("refunded", "partially_refunded"):
        if payment.get("stripe_refund_id"):
            await reconcile_stripe_refund(payment["stripe_refund_id"], "succeeded")
        return payment_status
    if payment_status == "cancelled":
        return "cancelled"

    payment_intent_id = payment.get("stripe_payment_intent_id")
    if payment_intent_id:
        if payment_status == "captured":
            return await _create_recorded_stripe_refund(
                payment,
                amount=None,
                refund_amount=float(payment["amount"]),
                refund_percentage=100,
                target_payment_status="refunded",
                target_booking_status=target_booking_status,
                idempotency_key=f"booking-request-refund-{booking_id}",
            )
        await stripe_service.cancel_payment_intent(
            payment_intent_id,
            **(
                {"stripe_account": payment["stripe_account_id"]}
                if payment.get("stripe_account_id")
                else {}
            ),
        )

    await PaymentRepository.update_status(str(payment["id"]), "cancelled")
    return "cancelled"


async def host_reject_booking(booking_id: str, user_id: str, reason: str | None = None) -> dict:
    """Host rejects a pending booking and reverses its pending payment."""
    hotel_id = await _get_hotel_id_for_user(user_id)
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or str(booking["hotel_id"]) != hotel_id:
        raise ValueError("Booking not found")
    if booking["status"] != "pending":
        raise ValueError("Booking is not in pending state")

    # Release payment hold, refund a captured deposit, or expire the invoice.
    payment = await PaymentRepository.get_by_booking_id(booking_id)
    terminal_payment_status = "cancelled"
    if booking.get("payment_method") == "card":
        terminal_payment_status = await _release_or_refund_card_payment(
            booking_id, payment, target_booking_status="declined"
        )
    elif booking.get("payment_method") == "xendit":
        if payment and payment.get("xendit_invoice_id"):
            try:
                await xendit_service.expire_invoice(payment["xendit_invoice_id"])
            except Exception as e:
                logger.warning("Failed to expire Xendit invoice for booking %s: %s", booking_id, e)
            await PaymentRepository.update_status(str(payment["id"]), "cancelled")
    elif booking.get("payment_method") == "paypal":
        if payment:
            await PaymentRepository.update_status(str(payment["id"]), "cancelled")

    if terminal_payment_status == "refunded":
        updated = await BookingRepository.get_by_id(booking_id)
        if updated and updated["status"] == "declined":
            await BookingRepository.cancel_with_promo_reversal(
                booking_id,
                new_status="declined",
                payment_status=terminal_payment_status,
            )
            return await BookingRepository.get_by_id(booking_id)

    # VAY-404: host-rejected requests are stored as 'declined' so the UI can
    # distinguish them from guest-driven cancellations ('cancelled' covers
    # guest withdraw + guest-initiated cancellation of a confirmed booking).
    await BookingRepository.cancel_with_promo_reversal(
        booking_id,
        new_status="declined",
        payment_status=terminal_payment_status,
    )
    await PayoutRepository.cancel_by_booking(booking_id)

    # Notify guest, host, and ops
    updated = await BookingRepository.get_by_id(booking_id)
    _create_task(send_guest_booking_rejected(updated["guest_email"], updated, reason=reason))
    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    if hotel:
        _create_task(send_host_booking_rejected(hotel["contact_email"], updated, reason=reason))

    # Sync cancellation and availability to Channex (fire-and-forget)
    _create_task(channex_handle_cancellation(booking_id))
    _create_task(push_ari_for_booking(booking_id))
    _schedule_unassigned_sweep(booking)

    return updated


async def guest_withdraw_booking(booking_id: str, guest_email: str) -> dict:
    """Guest withdraws a pending booking request."""
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking:
        raise ValueError("Booking not found")
    if booking["status"] != "pending":
        raise ValueError("Booking is not in pending state")
    if booking["guest_email"].lower() != guest_email.lower():
        raise ValueError("Email does not match booking")

    # Release an authorization or refund an already-captured deposit.
    if booking.get("payment_method") == "card":
        payment = await PaymentRepository.get_by_booking_id(booking_id)
        terminal_payment_status = await _release_or_refund_card_payment(
            booking_id, payment, target_booking_status="cancelled"
        )
    else:
        terminal_payment_status = "cancelled"

    if terminal_payment_status == "refunded":
        updated = await BookingRepository.get_by_id(booking_id)
        if updated and updated["status"] == "cancelled":
            await BookingRepository.cancel_with_promo_reversal(
                booking_id,
                payment_status=terminal_payment_status,
                guest_withdrawn=True,
            )
            return await BookingRepository.get_by_id(booking_id)

    await BookingRepository.cancel_with_promo_reversal(
        booking_id,
        payment_status=terminal_payment_status,
        guest_withdrawn=True,
    )

    # Notify host and guest
    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    updated = await BookingRepository.get_by_id(booking_id)
    if hotel:
        _create_task(send_host_booking_withdrawn(hotel["contact_email"], updated))
    _create_task(send_guest_booking_withdrawn(updated["guest_email"], updated))

    # Sync cancellation and availability to Channex (fire-and-forget)
    _create_task(channex_handle_cancellation(booking_id))
    _create_task(push_ari_for_booking(booking_id))
    _schedule_unassigned_sweep(booking)

    return updated


def _parse_partial_refund_tiers(raw) -> list[dict]:
    """Decode partial_refund_tiers from a DB row (string or list)."""
    if not raw:
        return []
    if isinstance(raw, str):
        try:
            decoded = json.loads(raw)
        except (TypeError, ValueError):
            return []
    else:
        decoded = raw
    if not isinstance(decoded, list):
        return []
    return [t for t in decoded if isinstance(t, dict)]


def _resolve_tier_refund(tiers: list[dict], days_until: int) -> tuple[float, int]:
    """Pick the highest tier the cancellation still meets.

    Tiers are stored sorted descending by min_days_before_check_in (the
    Pydantic validator and the migration both enforce this), so the first
    matching tier is the right one. Returns (refund_percent, threshold_days)
    where threshold_days is the matched tier's min_days_before_check_in (0
    when no tier matches, used only for display).
    """
    for tier in tiers:
        threshold = tier.get("min_days_before_check_in", tier.get("minDaysBeforeCheckIn"))
        percent = tier.get("refund_percent", tier.get("refundPercent"))
        if threshold is None or percent is None:
            continue
        try:
            t_days = int(threshold)
            t_pct = int(percent)
        except (TypeError, ValueError):
            continue
        if days_until >= t_days:
            return float(t_pct), t_days
    return 0.0, 0


async def _compute_policy_refund(booking: dict) -> tuple[float, float, int]:
    """Compute the cancellation-policy refund before deposit overrides.

    Non-refundable rate plans always return 0 refund — the guest accepted that
    in exchange for the discounted price. For flexible bookings with the room's
    flexible_cancellation_type set to 'partial_refund', the room's tiered
    schedule (or, when empty, the legacy single-tier window/percent) overrides
    the hotel-wide cancellation policy. Otherwise the hotel-wide policy applies.
    """
    hotel_id = str(booking["hotel_id"])
    policy = await CancellationPolicyRepository.get_by_hotel_id(hotel_id)
    free_days = policy["free_cancellation_days"] if policy else 7
    partial_pct = float(policy["partial_refund_pct"]) if policy else 0.0

    if booking.get("rate_type") == "nonrefundable":
        return 0.0, 0.0, free_days

    check_in = booking["check_in"]
    days_until = (check_in - date.today()).days
    total_amount = float(booking["total_amount"])

    if booking.get("rate_type") == "flexible":
        room_type = await RoomTypeRepository.get_by_id(str(booking["room_type_id"]))
        if room_type and room_type.get("flexible_cancellation_type") == "partial_refund":
            tiers = _parse_partial_refund_tiers(room_type.get("partial_refund_tiers"))
            if tiers:
                percent, threshold = _resolve_tier_refund(tiers, days_until)
                return round(total_amount * percent / 100, 2), percent, threshold
            window = room_type.get("partial_refund_cancel_window_days") or 30
            percent = float(room_type.get("partial_refund_amount_percent") or 50)
            if days_until >= window:
                return round(total_amount * percent / 100, 2), percent, window
            return 0.0, 0.0, window

    if days_until >= free_days:
        return total_amount, 100.0, free_days
    if partial_pct > 0:
        return round(total_amount * partial_pct / 100, 2), partial_pct, free_days
    return 0.0, 0.0, free_days


def _is_deposit_settled(booking: dict) -> bool:
    status = booking.get("payment_status")
    method = booking.get("payment_method")
    if status in ("captured", "refunded", "partially_refunded"):
        return True
    if method == "card" and status == "authorized":
        return True
    return False


async def _compute_cancellation_outcome(booking: dict) -> CancellationOutcome:
    """Compute refund/charge semantics for cancellation.

    For normal bookings, this is the existing policy refund. For deposit
    bookings, the booking's paid exposure is the deposit amount: free
    cancellation refunds that deposit, while paid cancellations retain the
    deposit unless the policy penalty is higher.
    """
    policy_refund, policy_pct, free_days = await _compute_policy_refund(booking)
    total_amount = round(float(booking["total_amount"]), 2)
    policy_penalty = round(max(total_amount - policy_refund, 0), 2)

    if not booking.get("deposit_required"):
        return CancellationOutcome(
            refund_amount=policy_refund,
            refund_pct=policy_pct,
            free_days_for_display=free_days,
            cancellation_charge=policy_penalty,
            policy_penalty=policy_penalty,
            deposit_retained=0.0,
            additional_amount_due=0.0,
        )

    deposit_amount = round(float(booking.get("deposit_amount") or 0), 2)
    paid_deposit = deposit_amount if _is_deposit_settled(booking) else 0.0
    if paid_deposit <= 0:
        return CancellationOutcome(
            refund_amount=0.0,
            refund_pct=0.0,
            free_days_for_display=free_days,
            cancellation_charge=0.0,
            policy_penalty=policy_penalty,
            deposit_retained=0.0,
            additional_amount_due=0.0,
        )
    is_free_cancellation = policy_penalty <= 0.01

    if is_free_cancellation:
        refund_amount = paid_deposit
        return CancellationOutcome(
            refund_amount=refund_amount,
            refund_pct=100.0 if refund_amount > 0 else 0.0,
            free_days_for_display=free_days,
            cancellation_charge=0.0,
            policy_penalty=0.0,
            deposit_retained=0.0,
            additional_amount_due=0.0,
            manual_refund_required=refund_amount > 0 and booking.get("payment_method") != "card",
        )

    cancellation_charge = round(max(deposit_amount, policy_penalty), 2)
    deposit_retained = round(min(paid_deposit, cancellation_charge), 2)
    additional_due = round(max(cancellation_charge - deposit_retained, 0), 2)
    refund_amount = round(max(paid_deposit - cancellation_charge, 0), 2)
    refund_pct = round(refund_amount / paid_deposit * 100, 2) if paid_deposit > 0 else 0.0

    return CancellationOutcome(
        refund_amount=refund_amount,
        refund_pct=refund_pct,
        free_days_for_display=free_days,
        cancellation_charge=cancellation_charge,
        policy_penalty=policy_penalty,
        deposit_retained=deposit_retained,
        additional_amount_due=additional_due,
        manual_refund_required=refund_amount > 0 and booking.get("payment_method") != "card",
    )


async def _compute_cancellation_refund(booking: dict) -> tuple[float, float, int]:
    """Backward-compatible tuple API for existing callers/tests."""
    outcome = await _compute_cancellation_outcome(booking)
    return outcome.refund_amount, outcome.refund_pct, outcome.free_days_for_display


async def get_cancellation_preview(booking_id: str, guest_email: str) -> dict:
    """Calculate refund details without actually cancelling."""
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking:
        raise ValueError("Booking not found")
    if booking["status"] != "confirmed":
        raise ValueError("Only confirmed bookings can be previewed for cancellation")
    if booking["guest_email"].lower() != guest_email.lower():
        raise ValueError("Email does not match booking")

    outcome = await _compute_cancellation_outcome(booking)
    days_until = (booking["check_in"] - date.today()).days

    return {
        "refundAmount": outcome.refund_amount,
        "refundPercentage": outcome.refund_pct,
        "freeCancellationDays": outcome.free_days_for_display,
        "daysUntilCheckIn": days_until,
        "currency": booking["currency"],
        "cancellationCharge": outcome.cancellation_charge,
        "policyPenalty": outcome.policy_penalty,
        "depositRetained": outcome.deposit_retained,
        "additionalAmountDue": outcome.additional_amount_due,
        "manualRefundRequired": outcome.manual_refund_required,
    }


async def handle_guest_cancellation(booking_id: str, guest_email: str) -> dict:
    """Guest cancels a confirmed booking — applies cancellation policy."""
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking:
        raise ValueError("Booking not found")
    if booking["status"] != "confirmed":
        raise ValueError("Only confirmed bookings can be cancelled")
    if booking["guest_email"].lower() != guest_email.lower():
        raise ValueError("Email does not match booking")

    outcome = await _compute_cancellation_outcome(booking)

    # Process refund if card payment
    if booking.get("payment_method") == "card" and outcome.refund_amount > 0:
        payment = (
            await PaymentRepository.get_deposit_by_booking_id(booking_id)
            if booking.get("deposit_required")
            else await PaymentRepository.get_by_booking_id(booking_id)
        )
        if payment and payment.get("stripe_payment_intent_id"):
            refund_cents = (
                int(math.ceil(outcome.refund_amount * 100)) if outcome.refund_pct < 100 else None
            )
            target_payment_status = (
                "refunded" if outcome.refund_pct >= 100 else "partially_refunded"
            )
            await _create_recorded_stripe_refund(
                payment,
                amount=refund_cents,
                refund_amount=outcome.refund_amount,
                refund_percentage=outcome.refund_pct,
                target_payment_status=target_payment_status,
                target_booking_status="cancelled",
                idempotency_key=f"guest-cancellation-refund-{booking_id}-{refund_cents or 'full'}",
            )
            await BookingRepository.cancel_with_promo_reversal(
                booking_id,
                payment_status=target_payment_status,
            )
            return await BookingRepository.get_by_id(booking_id)

    new_payment_status = (
        "refunded"
        if outcome.refund_pct >= 100 and outcome.refund_amount > 0
        else (
            "partially_refunded"
            if outcome.refund_amount > 0
            else (
                "captured"
                if outcome.deposit_retained > 0
                else (
                    "cancelled"
                    if booking.get("deposit_required")
                    else booking.get("payment_status", "captured")
                )
            )
        )
    )
    await BookingRepository.cancel_with_promo_reversal(
        booking_id,
        payment_status=new_payment_status,
    )
    await PayoutRepository.cancel_by_booking(booking_id)

    updated = await BookingRepository.get_by_id(booking_id)
    _create_task(
        send_guest_cancellation_refund(
            updated["guest_email"],
            updated,
            outcome.refund_amount,
            outcome.refund_pct,
        )
    )
    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    if hotel:
        _create_task(send_host_guest_cancelled(hotel["contact_email"], updated))

    # Sync cancellation and availability to Channex (fire-and-forget)
    _create_task(channex_handle_cancellation(booking_id))
    _create_task(push_ari_for_booking(booking_id))
    _schedule_unassigned_sweep(booking)

    return updated


async def expire_booking(booking_id: str) -> None:
    """Called by scheduler when host doesn't respond within 24h."""
    booking = await BookingRepository.get_by_id(booking_id)
    if not booking or booking["status"] != "pending":
        return

    # Release payment hold, refund a captured deposit, or expire the invoice.
    payment = await PaymentRepository.get_by_booking_id(booking_id)
    terminal_payment_status = "cancelled"
    if booking.get("payment_method") == "card":
        terminal_payment_status = await _release_or_refund_card_payment(
            booking_id, payment, target_booking_status="expired"
        )
    elif booking.get("payment_method") == "xendit":
        if payment and payment.get("xendit_invoice_id"):
            try:
                await xendit_service.expire_invoice(payment["xendit_invoice_id"])
            except Exception as e:
                logger.warning(
                    "Failed to expire Xendit invoice for expired booking %s: %s", booking_id, e
                )
            await PaymentRepository.update_status(str(payment["id"]), "cancelled")
    elif booking.get("payment_method") == "paypal":
        if payment:
            await PaymentRepository.update_status(str(payment["id"]), "cancelled")

    if terminal_payment_status == "refunded":
        updated = await BookingRepository.get_by_id(booking_id)
        if updated and updated["status"] == "expired":
            return

    await BookingRepository.update_status(booking_id, "expired")
    await BookingRepository.update_payment_status(booking_id, terminal_payment_status)

    # Notify both parties
    hotel = await Database.fetchrow(
        "SELECT contact_email FROM hotels WHERE id = $1", booking["hotel_id"]
    )
    updated = await BookingRepository.get_by_id(booking_id)
    _create_task(send_guest_booking_expired(updated["guest_email"], updated))
    if hotel:
        _create_task(send_host_booking_expired(hotel["contact_email"], updated))
    _create_task(channex_handle_cancellation(booking_id))
    _create_task(push_ari_for_booking(booking_id))
    _schedule_unassigned_sweep(booking)


async def lookup_booking(
    slug: str, booking_reference: str, guest_email: str
) -> BookingResponse | None:
    booking = await BookingRepository.lookup(booking_reference, guest_email)
    if not booking:
        return None
    hotel = await Database.fetchrow("SELECT id FROM hotels WHERE slug = $1", slug)
    if not hotel or str(booking["hotel_id"]) != str(hotel["id"]):
        return None
    return _booking_to_response(booking)


async def get_booking_status(slug: str, booking_reference: str, guest_email: str) -> dict | None:
    """Get booking status for frontend polling."""
    booking = await BookingRepository.lookup(booking_reference, guest_email)
    if not booking:
        return None
    hotel = await Database.fetchrow("SELECT id FROM hotels WHERE slug = $1", slug)
    if not hotel or str(booking["hotel_id"]) != str(hotel["id"]):
        return None
    return {
        "status": booking["status"],
        "paymentStatus": booking.get("payment_status"),
        "hostResponseDeadline": booking["host_response_deadline"].isoformat()
        if booking.get("host_response_deadline")
        else None,
    }


async def _get_hotel_id_for_user(user_id: str) -> str:
    """Delegate to the central get_hotel_id helper so that the
    X-Hotel-Id header is honored for admin-created bookings too.
    Previously this bypassed the helper and always picked the
    first hotel row — fine for single-hotel accounts, a silent
    data-routing bug for multi-hotel accounts."""
    try:
        return await get_hotel_id(user_id)
    except Exception as e:
        raise ValueError("No hotel found for this account") from e

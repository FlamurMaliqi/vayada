import logging
from datetime import UTC, date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.dependencies import require_internal_key
from app.models.hotel import (
    AddonResponse,
    BankDetails,
    HotelResponse,
    PaymentSettingsResponse,
)
from app.models.promo_code import ValidatePromoCodeResponse
from app.models.utils import parse_json
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.repositories.promo_code_repo import PromoCodeRepository
from app.services.exchange_rate_service import get_rates
from app.services.hotel_service import (
    get_addons_by_hotel_slug,
    get_hotel_by_slug,
    verified_custom_domain_url,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hotels", tags=["hotels"])
exchange_router = APIRouter(prefix="/api", tags=["exchange-rates"])
resolve_router = APIRouter(prefix="/api", tags=["domain-resolution"])


class IncrementPromoResponse(BaseModel):
    ok: bool


def _hotel_local_date(hotel: dict) -> date:
    try:
        timezone = ZoneInfo(str(hotel.get("timezone") or "UTC"))
    except ZoneInfoNotFoundError:
        timezone = ZoneInfo("UTC")
    return datetime.now(UTC).astimezone(timezone).date()


class ExchangeRatesResponse(BaseModel):
    base: str
    rates: dict


class ResolveDomainResponse(BaseModel):
    slug: str


def _bank_details_complete(hotel: dict) -> bool:
    account_type = hotel.get("payout_account_type") or "iban"
    account_identifier = (
        hotel.get("payout_account_number")
        if account_type == "account_number"
        else hotel.get("payout_iban")
    )
    required = [
        hotel.get("payout_bank_name"),
        hotel.get("payout_account_holder"),
        account_identifier,
        hotel.get("payout_swift"),
    ]
    return all(bool(str(value or "").strip()) for value in required)


@router.get("/{slug}", response_model=HotelResponse)
async def get_hotel(slug: str, lang: str = "en"):
    hotel = await get_hotel_by_slug(slug, locale=lang)
    if hotel:
        return hotel
    # VAY-394: caller may be using a slug the property used before being
    # renamed. Redirect to the canonical so old confirmation-email links
    # and shared URLs keep working.
    renamed = await BookingHotelRepository.get_by_previous_slug(slug)
    if renamed:
        return RedirectResponse(
            url=f"/api/hotels/{renamed['slug']}?lang={lang}",
            status_code=301,
        )
    raise HTTPException(status_code=404, detail=f"Hotel '{slug}' not found")


@router.get("/{slug}/addons", response_model=list[AddonResponse])
async def get_addons(slug: str):
    return await get_addons_by_hotel_slug(slug)


@router.get("/{slug}/payment-settings", response_model=PaymentSettingsResponse)
async def get_payment_settings(slug: str):
    hotel = await BookingHotelRepository.get_by_slug(slug)
    if not hotel:
        raise HTTPException(status_code=404, detail=f"Hotel '{slug}' not found")
    bank_transfer = bool(hotel.get("bank_transfer", False)) and _bank_details_complete(hotel)
    paypal_enabled = bool(hotel.get("paypal_enabled", False))
    return PaymentSettingsResponse(
        pay_at_property_enabled=hotel.get("pay_at_property_enabled", False),
        pay_at_hotel_methods=parse_json(
            hotel.get("pay_at_hotel_methods"), default=["cash", "card"]
        ),
        online_card_payment=hotel.get("online_card_payment", False),
        bank_transfer=bank_transfer,
        paypal_enabled=paypal_enabled,
        paypal_email=(hotel.get("paypal_email") or "") if paypal_enabled else "",
        paypal_payment_window_hours=(
            (hotel.get("paypal_payment_window_hours") or 24) if paypal_enabled else 24
        ),
        free_cancellation_days=hotel.get("free_cancellation_days", 7),
        special_requests_enabled=hotel.get("special_requests_enabled", True),
        arrival_time_enabled=hotel.get("arrival_time_enabled", False),
        guest_count_enabled=hotel.get("guest_count_enabled", False),
        terms_text=hotel.get("terms_text") or "",
        cancellation_policy_text=hotel.get("cancellation_policy_text") or "",
        bank_details=BankDetails(
            account_holder=hotel.get("payout_account_holder") or "",
            account_type=hotel.get("payout_account_type") or "iban",
            iban=hotel.get("payout_iban") or "",
            account_number=hotel.get("payout_account_number") or "",
            bank_name=hotel.get("payout_bank_name") or "",
            swift=hotel.get("payout_swift") or "",
        )
        if bank_transfer
        else None,
    )


@router.get("/{slug}/validate-promo", response_model=ValidatePromoCodeResponse)
async def validate_promo_code(
    slug: str,
    code: str = Query(...),
    check_in: date | None = Query(default=None),
    room_type_id: str | None = Query(default=None),
    booking_total: Decimal | None = Query(default=None, ge=0),
):
    hotel = await BookingHotelRepository.get_by_slug(slug)
    if not hotel:
        raise HTTPException(status_code=404, detail=f"Hotel '{slug}' not found")

    promo = await PromoCodeRepository.get_by_code(code.upper(), str(hotel["id"]))
    if not promo:
        return ValidatePromoCodeResponse(
            valid=False, code=code.upper(), message="Invalid promo code"
        )

    if not promo["is_active"]:
        return ValidatePromoCodeResponse(
            valid=False, code=code.upper(), message="This promo code is not active."
        )

    today = _hotel_local_date(hotel)
    if promo["valid_from"] and today < promo["valid_from"]:
        return ValidatePromoCodeResponse(
            valid=False,
            code=code.upper(),
            message="This promo code is not valid for your selected dates.",
        )
    if promo["valid_until"] and today > promo["valid_until"]:
        return ValidatePromoCodeResponse(
            valid=False, code=code.upper(), message="This promo code has expired."
        )

    if promo["current_uses"] >= promo["max_uses"]:
        return ValidatePromoCodeResponse(
            valid=False,
            code=code.upper(),
            message="This promo code has reached its maximum number of uses.",
        )
    if check_in and (
        (promo.get("stay_date_from") and check_in < promo["stay_date_from"])
        or (promo.get("stay_date_until") and check_in > promo["stay_date_until"])
    ):
        return ValidatePromoCodeResponse(
            valid=False,
            code=code.upper(),
            message="This promo code is not valid for your selected dates.",
        )
    if (
        room_type_id
        and promo.get("applicable_room_ids")
        and str(room_type_id) not in {str(room_id) for room_id in promo["applicable_room_ids"]}
    ):
        return ValidatePromoCodeResponse(
            valid=False,
            code=code.upper(),
            message="This promo code is not available for the selected room.",
        )
    minimum = promo.get("min_booking_value")
    if booking_total is not None and minimum is not None and booking_total < minimum:
        currency = hotel.get("default_currency") or "EUR"
        amount = format(Decimal(minimum), "f")
        if "." in amount:
            amount = amount.rstrip("0").rstrip(".")
        return ValidatePromoCodeResponse(
            valid=False,
            code=code.upper(),
            message=f"Your booking must be at least {currency} {amount} to use this code.",
        )

    return ValidatePromoCodeResponse(
        valid=True,
        code=promo["code"],
        discount_type=promo["discount_type"],
        discount_value=float(promo["discount_value"]),
        currency=hotel.get("default_currency") or "EUR",
        message="Promo code applied successfully.",
    )


@router.post(
    "/{slug}/increment-promo",
    response_model=IncrementPromoResponse,
    dependencies=[Depends(require_internal_key)],
)
async def increment_promo_usage(
    slug: str,
    code: str = Query(...),
    redemption_key: str = Query(..., min_length=1, max_length=120),
    check_in: date = Query(...),
    room_type_id: str = Query(...),
    booking_total: Decimal = Query(..., ge=0),
):
    """Server-to-server: atomically reserve a promo use for a PMS booking.
    Gated by INTERNAL_API_KEY when the operator opts into enforcement."""
    hotel = await BookingHotelRepository.get_by_slug(slug)
    if not hotel:
        raise HTTPException(status_code=404, detail="Hotel not found")
    promo = await PromoCodeRepository.get_by_code(code, str(hotel["id"]))
    if not promo:
        raise HTTPException(status_code=404, detail="Promo code not found")
    ledger_key = _promo_redemption_key(str(hotel["id"]), redemption_key)
    promo_id = str(promo["id"])
    redeemed = await PromoCodeRepository.redeem(
        promo_id,
        ledger_key,
        check_in=check_in,
        room_type_id=room_type_id,
        booking_total=float(booking_total),
        property_date=_hotel_local_date(hotel),
    )
    if not redeemed:
        redeemed = await PromoCodeRepository.has_active_redemption(promo_id, ledger_key)
    if not redeemed:
        raise HTTPException(status_code=409, detail="Promo code could not be redeemed")
    return IncrementPromoResponse(ok=True)


@router.post(
    "/{slug}/decrement-promo",
    response_model=IncrementPromoResponse,
    dependencies=[Depends(require_internal_key)],
)
async def decrement_promo_usage(
    slug: str,
    redemption_key: str = Query(..., min_length=1, max_length=120),
):
    hotel = await BookingHotelRepository.get_by_slug(slug)
    if not hotel:
        raise HTTPException(status_code=404, detail="Hotel not found")
    await PromoCodeRepository.reverse_redemption(
        str(hotel["id"]), _promo_redemption_key(str(hotel["id"]), redemption_key)
    )
    return IncrementPromoResponse(ok=True)


def _promo_redemption_key(hotel_id: str, booking_reference: str) -> str:
    return f"{hotel_id}:{booking_reference}"


@exchange_router.get("/exchange-rates", response_model=ExchangeRatesResponse)
async def exchange_rates(base: str = Query(default="EUR")):
    rates = await get_rates(base)
    return ExchangeRatesResponse(base=base.upper(), rates=rates)


@resolve_router.get("/resolve-domain", response_model=ResolveDomainResponse)
async def resolve_domain(domain: str = Query(...)):
    """Resolve a custom domain to the hotel slug.

    Hostnames are case-insensitive per RFC 1035 §2.3.3, and custom_domain
    is stored lowercased on write — normalize the incoming host before
    the lookup so a stray uppercase ``Host`` header still resolves.
    """
    hotel = await BookingHotelRepository.get_by_custom_domain(domain.strip().lower())
    if not hotel:
        raise HTTPException(status_code=404, detail="No hotel found for this domain")
    if not await verified_custom_domain_url(hotel):
        raise HTTPException(status_code=404, detail="No verified hotel found for this domain")
    return ResolveDomainResponse(slug=hotel["slug"])

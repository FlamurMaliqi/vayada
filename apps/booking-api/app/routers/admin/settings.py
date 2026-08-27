import logging
import re
import secrets
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.dependencies import get_current_hotel, require_hotel_admin
from app.models.settings import (
    PropertySettingsResponse,
    PropertySettingsUpdate,
    SettingsPointOfInterest,
    hotel_default,
)
from app.models.utils import parse_json, slugify
from app.repositories.booking_hotel_repo import BookingHotelRepository
from app.services import pms_client
from app.services.billing_service import (
    compute_fixed_plan_projected_fee,
    count_active_rooms,
)
from app.services.pms_client import PmsClientError

logger = logging.getLogger(__name__)

router = APIRouter()

# ── Property settings ──────────────────────────────────────────────

_PROPERTY_FIELD_MAP = {
    "property_name": "name",
    "reservation_email": "contact_email",
    "phone_number": "contact_phone",
    "whatsapp_number": "contact_whatsapp",
    "address": "contact_address",
    "timezone": "timezone",
    "default_currency": "currency",
    "default_language": "default_language",
    "supported_currencies": "supported_currencies",
    "supported_languages": "supported_languages",
    "check_in_time": "check_in_time",
    "check_out_time": "check_out_time",
    "check_in_from": "check_in_from",
    "check_in_until": "check_in_until",
    "check_out_from": "check_out_from",
    "check_out_until": "check_out_until",
    "custom_domain": "custom_domain",
    "pay_at_property_enabled": "pay_at_property_enabled",
    "pay_at_hotel_methods": "pay_at_hotel_methods",
    "online_card_payment": "online_card_payment",
    "bank_transfer": "bank_transfer",
    "paypal_enabled": "paypal_enabled",
    "paypal_email": "paypal_email",
    "paypal_payment_window_hours": "paypal_payment_window_hours",
    "free_cancellation_days": "free_cancellation_days",
    "email_notifications": "email_notifications",
    "new_booking_alerts": "new_booking_alerts",
    "payment_alerts": "payment_alerts",
    "ota_booking_alerts": "ota_booking_alerts",
    "weekly_reports": "weekly_reports",
    "special_requests_enabled": "special_requests_enabled",
    "arrival_time_enabled": "arrival_time_enabled",
    "guest_count_enabled": "guest_count_enabled",
    "instagram": "social_instagram",
    "facebook": "social_facebook",
    "tiktok": "social_tiktok",
    "youtube": "social_youtube",
    # billing_active_plan deliberately omitted — it flips via the pending-switch
    # flow only (see billing_service.apply_pending_plan_switch_if_due), never via PATCH.
    "billing_commission_rate": "billing_commission_rate",
    "billing_fixed_fee": "billing_fixed_fee",
    "payout_account_holder": "payout_account_holder",
    "payout_account_type": "payout_account_type",
    "payout_iban": "payout_iban",
    "payout_account_number": "payout_account_number",
    "payout_bank_name": "payout_bank_name",
    "payout_swift": "payout_swift",
    "refer_a_guest_enabled": "refer_a_guest_enabled",
    "map_view_enabled": "map_view_enabled",
    "terms_text": "terms_text",
    "cancellation_policy_text": "cancellation_policy_text",
    "show_room_detail_map": "show_room_detail_map",
    "points_of_interest": "points_of_interest",
}


def _coalesce(hotel: dict, column: str) -> Any:
    """Read ``column`` from a hotel row, falling back to the centralized
    default in HOTEL_FIELD_DEFAULTS (or '' for unmapped string columns)."""
    val = hotel.get(column)
    if val is None:
        return hotel_default(column)
    return val


async def _hotel_to_property_settings(hotel: dict) -> PropertySettingsResponse:
    hotel_id = str(hotel.get("id")) if hotel.get("id") else None
    if hotel_id:
        room_count = await count_active_rooms(hotel_id)
    else:
        room_count = 0
    fixed_base = float(_coalesce(hotel, "fixed_base_fee"))
    rooms_included = int(_coalesce(hotel, "fixed_rooms_included"))
    per_extra = float(_coalesce(hotel, "fixed_per_extra_room_fee"))
    projected_fee = compute_fixed_plan_projected_fee(
        fixed_base, rooms_included, per_extra, room_count
    )
    return PropertySettingsResponse(
        id=hotel_id,
        slug=_coalesce(hotel, "slug"),
        property_name=_coalesce(hotel, "name"),
        reservation_email=_coalesce(hotel, "contact_email"),
        phone_number=_coalesce(hotel, "contact_phone"),
        whatsapp_number=_coalesce(hotel, "contact_whatsapp"),
        address=_coalesce(hotel, "contact_address"),
        timezone=_coalesce(hotel, "timezone"),
        default_currency=_coalesce(hotel, "currency"),
        default_language=_coalesce(hotel, "default_language"),
        supported_currencies=parse_json(
            hotel.get("supported_currencies"), default=hotel_default("supported_currencies")
        ),
        supported_languages=parse_json(
            hotel.get("supported_languages"), default=hotel_default("supported_languages")
        ),
        check_in_time=_coalesce(hotel, "check_in_time"),
        check_out_time=_coalesce(hotel, "check_out_time"),
        check_in_from=_coalesce(hotel, "check_in_from"),
        check_in_until=_coalesce(hotel, "check_in_until"),
        check_out_from=_coalesce(hotel, "check_out_from"),
        check_out_until=_coalesce(hotel, "check_out_until"),
        custom_domain=hotel.get("custom_domain"),
        pay_at_property_enabled=_coalesce(hotel, "pay_at_property_enabled"),
        pay_at_hotel_methods=parse_json(
            hotel.get("pay_at_hotel_methods"), default=hotel_default("pay_at_hotel_methods")
        ),
        online_card_payment=_coalesce(hotel, "online_card_payment"),
        bank_transfer=_coalesce(hotel, "bank_transfer"),
        paypal_enabled=_coalesce(hotel, "paypal_enabled"),
        paypal_email=_coalesce(hotel, "paypal_email"),
        paypal_payment_window_hours=_coalesce(hotel, "paypal_payment_window_hours"),
        free_cancellation_days=_coalesce(hotel, "free_cancellation_days"),
        email_notifications=_coalesce(hotel, "email_notifications"),
        new_booking_alerts=_coalesce(hotel, "new_booking_alerts"),
        payment_alerts=_coalesce(hotel, "payment_alerts"),
        ota_booking_alerts=_coalesce(hotel, "ota_booking_alerts"),
        weekly_reports=_coalesce(hotel, "weekly_reports"),
        refer_a_guest_enabled=_coalesce(hotel, "refer_a_guest_enabled"),
        map_view_enabled=_coalesce(hotel, "map_view_enabled"),
        special_requests_enabled=_coalesce(hotel, "special_requests_enabled"),
        arrival_time_enabled=_coalesce(hotel, "arrival_time_enabled"),
        guest_count_enabled=_coalesce(hotel, "guest_count_enabled"),
        instagram=_coalesce(hotel, "social_instagram"),
        facebook=_coalesce(hotel, "social_facebook"),
        tiktok=_coalesce(hotel, "social_tiktok"),
        youtube=_coalesce(hotel, "social_youtube"),
        billing_active_plan=_coalesce(hotel, "billing_active_plan"),
        billing_commission_rate=float(_coalesce(hotel, "billing_commission_rate")),
        billing_fixed_fee=float(_coalesce(hotel, "billing_fixed_fee")),
        billing_pending_switch=hotel.get("billing_pending_switch"),
        billing_switch_effective_date=(
            hotel["billing_switch_effective_date"].isoformat()
            if hotel.get("billing_switch_effective_date")
            else None
        ),
        booking_engine_fee_pct=float(_coalesce(hotel, "booking_engine_fee_pct")),
        channel_manager_fee_pct=float(_coalesce(hotel, "channel_manager_fee_pct")),
        affiliate_platform_fee_pct=float(_coalesce(hotel, "affiliate_platform_fee_pct")),
        billing_commission_note=hotel.get("billing_commission_note"),
        active_room_count=room_count,
        fixed_plan_projected_monthly_fee=projected_fee,
        payout_account_holder=_coalesce(hotel, "payout_account_holder"),
        payout_account_type=_coalesce(hotel, "payout_account_type"),
        payout_iban=_coalesce(hotel, "payout_iban"),
        payout_account_number=_coalesce(hotel, "payout_account_number"),
        payout_bank_name=_coalesce(hotel, "payout_bank_name"),
        payout_swift=_coalesce(hotel, "payout_swift"),
        terms_text=_coalesce(hotel, "terms_text"),
        cancellation_policy_text=_coalesce(hotel, "cancellation_policy_text"),
        show_room_detail_map=_coalesce(hotel, "show_room_detail_map"),
        points_of_interest=parse_json(
            hotel.get("points_of_interest"), default=hotel_default("points_of_interest")
        ),
    )


# Zero-state response for users who haven't created a hotel yet. Built
# from an empty dict so every field flows through the same default
# pipeline as a real row would (no risk of drift).
async def _build_default_property_settings() -> PropertySettingsResponse:
    return await _hotel_to_property_settings({})


@router.get("/settings/property", response_model=PropertySettingsResponse)
async def get_property_settings(
    user_id: str = Depends(require_hotel_admin),
    hotel: dict | None = Depends(get_current_hotel),
):
    if not hotel:
        return await _build_default_property_settings()
    full_hotel = await BookingHotelRepository.get_by_id(str(hotel["id"]))
    return await _hotel_to_property_settings(full_hotel)


def _api_to_db_value(api_value, db_column: str):
    """Pull from a PropertySettingsUpdate field into the matching DB
    column, falling back to ``HOTEL_FIELD_DEFAULTS`` when the API value is
    None. Defaults live in one place; new fields just need an entry there."""
    if api_value is not None:
        return api_value
    return hotel_default(db_column)


def _serialize_points_of_interest(
    points: list[SettingsPointOfInterest] | None,
) -> list[dict[str, Any]]:
    return [point.model_dump() for point in (points or [])]


async def _resolve_unique_slug(
    name: str, user_id: str, *, exclude_hotel_id: str | None = None
) -> str:
    """Pick a slug for a booking_hotels row, disambiguating when the
    derived slug is already taken so two users can launch hotels with
    the same display name. Tries: bare slug → `{slug}-{user_id[:8]}` →
    `{slug}-{user_id[:8]}-{random}`. The random tier covers the same
    user creating two hotels with identical names.

    ``exclude_hotel_id`` lets the rename path skip the uniqueness check
    when the bare slug is already held by the hotel being renamed
    (e.g. case-only name change) — otherwise we'd suffix unnecessarily.

    A race between get_by_slug and the eventual INSERT is still possible;
    the caller handles that by catching UniqueViolationError and retrying
    with a random suffix.
    """
    base = slugify(name) if name else f"hotel-{user_id[:8]}"
    existing = await BookingHotelRepository.get_by_slug(base)
    if not existing or (exclude_hotel_id and str(existing["id"]) == exclude_hotel_id):
        return base
    suffixed = f"{base}-{user_id[:8]}"
    existing = await BookingHotelRepository.get_by_slug(suffixed)
    if not existing or (exclude_hotel_id and str(existing["id"]) == exclude_hotel_id):
        return suffixed
    return f"{suffixed}-{secrets.token_hex(3)}"


async def _create_hotel_from_settings(
    data: PropertySettingsUpdate,
    user_id: str,
) -> dict:
    """Create a new booking_hotels row from a PropertySettingsUpdate payload.

    Property names are not unique; we derive a slug from the name and
    auto-disambiguate via _resolve_unique_slug so users can pick whatever
    name they want. Used by both the explicit POST /admin/hotels endpoint
    (multi-hotel-safe) and the legacy auto-create branch in
    PATCH /admin/settings/property.
    """
    _validate_paypal_settings(
        enabled=data.paypal_enabled if data.paypal_enabled is not None else False,
        email=data.paypal_email or "",
        window_hours=(
            data.paypal_payment_window_hours
            if data.paypal_payment_window_hours is not None
            else hotel_default("paypal_payment_window_hours")
        ),
    )
    name = data.property_name or ""
    create_kwargs = dict(
        name=name,
        contact_email=data.reservation_email or "",
        contact_phone=data.phone_number or "",
        timezone=_api_to_db_value(data.timezone, "timezone"),
        currency=_api_to_db_value(data.default_currency, "currency"),
        default_language=_api_to_db_value(data.default_language, "default_language"),
        supported_languages=_api_to_db_value(data.supported_languages, "supported_languages"),
        user_id=user_id,
        supported_currencies=_api_to_db_value(data.supported_currencies, "supported_currencies"),
        contact_whatsapp=data.whatsapp_number or "",
        contact_address=data.address or "",
        check_in_time=_api_to_db_value(data.check_in_time, "check_in_time"),
        check_out_time=_api_to_db_value(data.check_out_time, "check_out_time"),
        check_in_from=data.check_in_from or "",
        check_in_until=data.check_in_until or "",
        check_out_from=data.check_out_from or "",
        check_out_until=data.check_out_until or "",
        pay_at_property_enabled=_api_to_db_value(
            data.pay_at_property_enabled, "pay_at_property_enabled"
        ),
        online_card_payment=_api_to_db_value(data.online_card_payment, "online_card_payment"),
        bank_transfer=_api_to_db_value(data.bank_transfer, "bank_transfer"),
        paypal_enabled=_api_to_db_value(data.paypal_enabled, "paypal_enabled"),
        paypal_email=data.paypal_email or "",
        paypal_payment_window_hours=_api_to_db_value(
            data.paypal_payment_window_hours, "paypal_payment_window_hours"
        ),
        free_cancellation_days=_api_to_db_value(
            data.free_cancellation_days, "free_cancellation_days"
        ),
        email_notifications=_api_to_db_value(data.email_notifications, "email_notifications"),
        new_booking_alerts=_api_to_db_value(data.new_booking_alerts, "new_booking_alerts"),
        payment_alerts=_api_to_db_value(data.payment_alerts, "payment_alerts"),
        ota_booking_alerts=_api_to_db_value(data.ota_booking_alerts, "ota_booking_alerts"),
        weekly_reports=_api_to_db_value(data.weekly_reports, "weekly_reports"),
        special_requests_enabled=_api_to_db_value(
            data.special_requests_enabled, "special_requests_enabled"
        ),
        arrival_time_enabled=_api_to_db_value(data.arrival_time_enabled, "arrival_time_enabled"),
        guest_count_enabled=_api_to_db_value(data.guest_count_enabled, "guest_count_enabled"),
        refer_a_guest_enabled=_api_to_db_value(data.refer_a_guest_enabled, "refer_a_guest_enabled"),
        map_view_enabled=_api_to_db_value(data.map_view_enabled, "map_view_enabled"),
        social_instagram=data.instagram or "",
        social_facebook=data.facebook or "",
        social_tiktok=data.tiktok or "",
        social_youtube=data.youtube or "",
        payout_account_holder=data.payout_account_holder or "",
        payout_account_type=_api_to_db_value(data.payout_account_type, "payout_account_type"),
        payout_iban=data.payout_iban or "",
        payout_account_number=data.payout_account_number or "",
        payout_bank_name=data.payout_bank_name or "",
        payout_swift=data.payout_swift or "",
        show_room_detail_map=_api_to_db_value(data.show_room_detail_map, "show_room_detail_map"),
        points_of_interest=_serialize_points_of_interest(
            _api_to_db_value(data.points_of_interest, "points_of_interest")
        ),
    )
    slug = await _resolve_unique_slug(name, user_id)
    try:
        return await BookingHotelRepository.create(slug=slug, **create_kwargs)
    except asyncpg.UniqueViolationError:
        # _resolve_unique_slug already deduped, but a concurrent create
        # may have grabbed the same slug between our pre-check and the
        # INSERT. Retry once with a guaranteed-unique random-suffixed slug.
        return await BookingHotelRepository.create(
            slug=f"{slug}-{secrets.token_hex(3)}",
            **create_kwargs,
        )


async def _require_owned_hotel(hotel_id: str, user_id: str) -> dict:
    hotel = await BookingHotelRepository.get_by_id_and_user_id(hotel_id, user_id)
    if not hotel:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Hotel not found or access denied",
        )
    return hotel


@router.get("/hotels/{hotel_id}/deletion-impact")
async def get_hotel_deletion_impact(
    hotel_id: str,
    request: Request,
    user_id: str = Depends(require_hotel_admin),
):
    """Counts the Manage Properties dialog shows before the user
    confirms a delete. Proxies to PMS, which owns bookings + channel
    connections."""
    await _require_owned_hotel(hotel_id, user_id)
    auth_header = request.headers.get("authorization", "")
    try:
        return await pms_client.get_deletion_impact(auth_header, hotel_id)
    except PmsClientError as e:
        # PMS row may not exist for a hotel whose setup never completed —
        # treat that as "no impact" rather than failing the dialog.
        if e.status_code in (403, 404):
            return {"upcomingBookingsCount": 0, "connectedChannelsCount": 0}
        logger.error("Failed to fetch deletion impact for hotel %s: %s", hotel_id, e)
        raise HTTPException(status_code=502, detail="Failed to fetch deletion impact") from e


@router.delete("/hotels/{hotel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_hotel(
    hotel_id: str,
    request: Request,
    user_id: str = Depends(require_hotel_admin),
):
    """Permanently delete a property. Calls PMS first (so Channex
    deprovision + PMS cascade run while the booking_hotels row still
    exists for ownership checks), then deletes booking_hotels — which
    cascades to translations, addons, promo codes, etc."""
    await _require_owned_hotel(hotel_id, user_id)
    auth_header = request.headers.get("authorization", "")

    try:
        await pms_client.delete_hotel(auth_header, hotel_id)
    except PmsClientError as e:
        logger.error("PMS delete failed for hotel %s: %s", hotel_id, e)
        raise HTTPException(
            status_code=502,
            detail="Failed to delete the property's PMS data. Please retry.",
        ) from e

    deleted = await BookingHotelRepository.delete(hotel_id)
    if not deleted:
        # Row vanished mid-flight (concurrent delete) — treat as success
        # since the end state is what the caller wanted.
        logger.warning("booking_hotels row %s already gone at delete time", hotel_id)
    logger.info("User %s deleted booking hotel %s", user_id, hotel_id)
    return None


@router.post(
    "/hotels", response_model=PropertySettingsResponse, status_code=status.HTTP_201_CREATED
)
async def create_hotel(
    data: PropertySettingsUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    """Explicitly create a new property for the authenticated user.

    This is the multi-hotel-safe creation path used by the setup
    wizard when adding a new property. Unlike PATCH /settings/property
    (which auto-creates only when no current hotel is selected and
    silently updates the existing one otherwise), this endpoint
    always creates a new booking_hotels row and returns its id so
    the caller can then pass that id to the PMS register-hotel
    endpoint and to X-Hotel-Id headers going forward.

    """
    result = await _create_hotel_from_settings(data, user_id)
    return await _hotel_to_property_settings(result)


@router.patch("/settings/property", response_model=PropertySettingsResponse)
async def update_property_settings(
    data: PropertySettingsUpdate,
    user_id: str = Depends(require_hotel_admin),
    hotel: dict | None = Depends(get_current_hotel),
):
    if hotel:
        updates = {}
        for api_field, db_col in _PROPERTY_FIELD_MAP.items():
            value = getattr(data, api_field)
            if value is not None:
                if api_field == "points_of_interest":
                    value = _serialize_points_of_interest(value)
                updates[db_col] = value

        _validate_paypal_settings(
            enabled=updates.get("paypal_enabled", hotel.get("paypal_enabled", False)),
            email=updates.get("paypal_email", hotel.get("paypal_email") or ""),
            window_hours=updates.get(
                "paypal_payment_window_hours",
                hotel.get("paypal_payment_window_hours") or 24,
            ),
        )

        # VAY-394: when the property name changes, regenerate the URL slug
        # so subdomains and the Preview button track the new name. The old
        # slug is appended to previous_slugs so GET /api/hotels/{old_slug}
        # can 301 to the canonical, keeping confirmation-email and shared
        # links working.
        await _maybe_rotate_slug_on_rename(hotel, updates, user_id)

        if updates:
            try:
                result = await BookingHotelRepository.partial_update(str(hotel["id"]), updates)
            except asyncpg.UniqueViolationError:
                # Slug or other UNIQUE collision — surface as 409 instead of 500.
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="A property with this name or slug already exists. Please choose a different value.",
                ) from None
        else:
            result = await BookingHotelRepository.get_by_id(str(hotel["id"]))
    else:
        # Legacy auto-create branch: only reachable when the user
        # has no hotels at all (otherwise get_current_hotel would
        # have returned one). New callers should use the explicit
        # POST /admin/hotels endpoint above.
        result = await _create_hotel_from_settings(data, user_id)

    return await _hotel_to_property_settings(result)


def _validate_paypal_settings(
    *,
    enabled: bool,
    email: str,
    window_hours: int,
) -> None:
    if window_hours < 1 or window_hours > 168:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="PayPal payment window must be between 1 and 168 hours",
        )
    if enabled and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email.strip()):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A valid PayPal email is required when PayPal is enabled",
        )


async def _maybe_rotate_slug_on_rename(
    hotel: dict,
    updates: dict,
    user_id: str,
) -> None:
    """If ``updates`` includes a name change that produces a different slug,
    mutate ``updates`` in place to also rewrite ``slug`` and append the
    current slug onto ``previous_slugs``. Idempotent — no-op when the new
    name slugifies to the existing slug.
    """
    new_name = updates.get("name")
    if not new_name:
        return
    current_slug = hotel.get("slug") or ""
    desired_base = slugify(new_name) if new_name else ""
    if not desired_base or desired_base == current_slug:
        return
    hotel_id = str(hotel["id"])
    new_slug = await _resolve_unique_slug(new_name, user_id, exclude_hotel_id=hotel_id)
    if new_slug == current_slug:
        return
    updates["slug"] = new_slug
    if current_slug:
        prev = list(hotel.get("previous_slugs") or [])
        if current_slug not in prev:
            prev.append(current_slug)
        updates["previous_slugs"] = prev

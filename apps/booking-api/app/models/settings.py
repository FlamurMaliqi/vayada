import math
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Single source of truth for property defaults, keyed by booking_hotels
# DB column name. Used by the GET (filling NULLs in the row), the
# zero-state default response (when a user has no hotel yet), and the
# create-from-settings path. Adding a new defaulted field means editing
# this dict only — no scattered ``or 'EUR'`` fallbacks across helpers.
HOTEL_FIELD_DEFAULTS: dict[str, Any] = {
    "timezone": "UTC",
    "currency": "EUR",
    "default_language": "en",
    "supported_languages": ["en"],
    "supported_currencies": [],
    "check_in_time": "15:00",
    "check_out_time": "11:00",
    "pay_at_hotel_methods": ["cash", "card"],
    "free_cancellation_days": 7,
    "email_notifications": True,
    "new_booking_alerts": True,
    "payment_alerts": True,
    "ota_booking_alerts": False,
    "weekly_reports": False,
    "refer_a_guest_enabled": False,
    "map_view_enabled": False,
    "special_requests_enabled": True,
    "arrival_time_enabled": False,
    "guest_count_enabled": False,
    "pay_at_property_enabled": False,
    "online_card_payment": False,
    "bank_transfer": False,
    "paypal_enabled": False,
    "paypal_payment_window_hours": 24,
    "payout_account_type": "iban",
    "billing_active_plan": "commission",
    "billing_commission_rate": 5,
    "billing_fixed_fee": 49,
    "booking_engine_fee_pct": 5.0,
    "channel_manager_fee_pct": 3.0,
    "affiliate_platform_fee_pct": 2.0,
    "fixed_base_fee": 30,
    "fixed_rooms_included": 1,
    "fixed_per_extra_room_fee": 5,
    "show_room_detail_map": False,
    "points_of_interest": [],
}


def hotel_default(column: str, fallback: Any = "") -> Any:
    """Return the default for ``column`` from ``HOTEL_FIELD_DEFAULTS``,
    or ``fallback`` (empty string) for unmapped columns — most string
    fields default to empty so listing each one is noise."""
    return HOTEL_FIELD_DEFAULTS.get(column, fallback)


class SettingsPointOfInterest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    travelTime: str
    color: str
    latitude: float
    longitude: float
    position: int = 0

    @field_validator("id", "label", "travelTime", "color")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("must not be empty")
        return trimmed

    @field_validator("latitude")
    @classmethod
    def validate_latitude(cls, value: float) -> float:
        if not math.isfinite(value) or value < -90 or value > 90:
            raise ValueError("latitude must be between -90 and 90")
        return value

    @field_validator("longitude")
    @classmethod
    def validate_longitude(cls, value: float) -> float:
        if not math.isfinite(value) or value < -180 or value > 180:
            raise ValueError("longitude must be between -180 and 180")
        return value

    @field_validator("position")
    @classmethod
    def validate_position(cls, value: int) -> int:
        if value < 0:
            raise ValueError("position must be non-negative")
        return value


class PropertySettingsResponse(BaseModel):
    # booking_hotels.id — the canonical hotel identifier. After the
    # multi-hotel-ids migration this is the same UUID as the PMS
    # hotels.id for this property. Clients use it for the
    # X-Hotel-Id header and for passing to POST /admin/register-hotel.
    id: str | None = None
    slug: str
    property_name: str
    reservation_email: str
    phone_number: str
    whatsapp_number: str
    address: str
    timezone: str
    default_currency: str
    default_language: str
    supported_currencies: list[str]
    supported_languages: list[str]
    check_in_time: str
    check_out_time: str
    check_in_from: str = ""
    check_in_until: str = ""
    check_out_from: str = ""
    check_out_until: str = ""
    custom_domain: str | None
    pay_at_property_enabled: bool
    pay_at_hotel_methods: list[str]
    online_card_payment: bool
    bank_transfer: bool
    paypal_enabled: bool
    paypal_email: str
    paypal_payment_window_hours: int
    free_cancellation_days: int
    email_notifications: bool
    new_booking_alerts: bool
    payment_alerts: bool
    ota_booking_alerts: bool
    weekly_reports: bool
    refer_a_guest_enabled: bool
    map_view_enabled: bool = False
    special_requests_enabled: bool
    arrival_time_enabled: bool
    guest_count_enabled: bool
    instagram: str
    facebook: str
    tiktok: str
    youtube: str
    billing_active_plan: str
    billing_commission_rate: float
    billing_fixed_fee: float
    billing_pending_switch: str | None
    billing_switch_effective_date: str | None = None
    # Direct-booking Commission rate (read-only for the hotel; Vayada admin owns it).
    booking_engine_fee_pct: float = 5.0
    # Channel manager (OTA) and affiliate platform fees are separate platform fees,
    # not part of the hotel-facing Commission card. Admin still controls them.
    channel_manager_fee_pct: float = 3.0
    affiliate_platform_fee_pct: float = 2.0
    # Optional internal note explaining a custom commission rate (admin-only context).
    billing_commission_note: str | None = None
    # Live room count + projected Fixed-plan fee at that count.
    active_room_count: int = 0
    fixed_plan_projected_monthly_fee: float = 0.0
    payout_account_holder: str
    payout_account_type: str
    payout_iban: str
    payout_account_number: str
    payout_bank_name: str
    payout_swift: str
    terms_text: str = ""
    cancellation_policy_text: str = ""
    show_room_detail_map: bool = False
    points_of_interest: list[SettingsPointOfInterest] = Field(default_factory=list, max_length=10)


class PropertySettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    property_name: str | None = None
    reservation_email: str | None = None
    phone_number: str | None = None
    whatsapp_number: str | None = None
    address: str | None = None
    timezone: str | None = None
    default_currency: str | None = None
    default_language: str | None = None
    supported_currencies: list[str] | None = None
    supported_languages: list[str] | None = None
    check_in_time: str | None = None
    check_out_time: str | None = None
    check_in_from: str | None = None
    check_in_until: str | None = None
    check_out_from: str | None = None
    check_out_until: str | None = None
    custom_domain: str | None = None
    pay_at_property_enabled: bool | None = None
    pay_at_hotel_methods: list[str] | None = None
    online_card_payment: bool | None = None
    bank_transfer: bool | None = None
    paypal_enabled: bool | None = None
    paypal_email: str | None = None
    paypal_payment_window_hours: int | None = None
    free_cancellation_days: int | None = None
    email_notifications: bool | None = None
    new_booking_alerts: bool | None = None
    payment_alerts: bool | None = None
    ota_booking_alerts: bool | None = None
    weekly_reports: bool | None = None
    refer_a_guest_enabled: bool | None = None
    map_view_enabled: bool | None = None
    special_requests_enabled: bool | None = None
    arrival_time_enabled: bool | None = None
    guest_count_enabled: bool | None = None
    instagram: str | None = None
    facebook: str | None = None
    tiktok: str | None = None
    youtube: str | None = None
    # Paid plan changes are handled by the legacy Stripe Billing flow in PMS.
    # Neither the active plan nor the retired pending switch is writable here.
    billing_commission_rate: float | None = None
    billing_fixed_fee: float | None = None
    payout_account_holder: str | None = None
    payout_account_type: str | None = None
    payout_iban: str | None = None
    payout_account_number: str | None = None
    payout_bank_name: str | None = None
    payout_swift: str | None = None
    terms_text: str | None = None
    cancellation_policy_text: str | None = None
    show_room_detail_map: bool | None = None
    points_of_interest: list[SettingsPointOfInterest] | None = Field(default=None, max_length=10)

import math
from typing import Any

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

MAX_ROOM_SIZE = 15000

# Booking.com meal_plan_code values that Channex maps for us. 0 = room only
# is the implicit default and never persisted in room_types.meal_plans.
VALID_MEAL_PLAN_CODES = {1, 3, 4, 9}
VALID_MEAL_PLAN_CHARGE_UNITS = {"room", "person"}

MAX_PARTIAL_REFUND_TIERS = 10

RoomImageReference = str | dict[str, Any]


def _validate_partial_refund_tiers(tiers: list) -> list:
    """Normalize and validate a tiered partial-refund schedule.

    Each tier is `{min_days_before_check_in: int, refund_percent: int}`.
    Returns the list sorted descending by `min_days_before_check_in` so
    refund computation can pick the first matching tier without
    re-sorting. Accepts both snake_case and camelCase keys to keep API
    callers (frontend sends camelCase) and DB consumers happy.
    """
    if len(tiers) > MAX_PARTIAL_REFUND_TIERS:
        raise ValueError(
            f"partial_refund_tiers must contain at most {MAX_PARTIAL_REFUND_TIERS} tiers"
        )
    seen_days: set[int] = set()
    normalized: list[dict] = []
    for t in tiers:
        days = t.get("min_days_before_check_in")
        if days is None:
            days = t.get("minDaysBeforeCheckIn")
        percent = t.get("refund_percent")
        if percent is None:
            percent = t.get("refundPercent")
        if days is None or percent is None:
            raise ValueError(
                "partial_refund_tiers entries must have min_days_before_check_in and refund_percent"
            )
        try:
            days_int = int(days)
            percent_int = int(percent)
        except (TypeError, ValueError) as e:
            raise ValueError("partial_refund_tiers entries must be integers") from e
        if days_int < 0 or days_int > 365:
            raise ValueError(
                "partial_refund_tiers[].min_days_before_check_in must be between 0 and 365"
            )
        if percent_int < 0 or percent_int > 100:
            raise ValueError("partial_refund_tiers[].refund_percent must be between 0 and 100")
        if days_int in seen_days:
            raise ValueError(
                f"partial_refund_tiers contains duplicate min_days_before_check_in={days_int}"
            )
        seen_days.add(days_int)
        normalized.append(
            {
                "min_days_before_check_in": days_int,
                "refund_percent": percent_int,
            }
        )
    normalized.sort(key=lambda t: t["min_days_before_check_in"], reverse=True)
    return normalized


def _validate_meal_plans(plans: list) -> list:
    seen: set[int] = set()
    for p in plans:
        code = p.get("code")
        surcharge = p.get("surcharge")
        if code not in VALID_MEAL_PLAN_CODES:
            raise ValueError(
                f"meal_plans[].code must be one of {sorted(VALID_MEAL_PLAN_CODES)}, got {code}"
            )
        if code in seen:
            raise ValueError(f"meal_plans contains duplicate code {code}")
        seen.add(code)
        if surcharge is None or float(surcharge) < 0:
            raise ValueError(f"meal_plans[].surcharge must be >= 0 (code {code})")
        charge_per = p.get("chargePer") or p.get("charge_per") or "room"
        if charge_per not in VALID_MEAL_PLAN_CHARGE_UNITS:
            raise ValueError(
                f"meal_plans[].chargePer must be one of {sorted(VALID_MEAL_PLAN_CHARGE_UNITS)}, "
                f"got {charge_per} (code {code})"
            )
        # Persist canonical snake_case form alongside the original to keep both
        # the camelCase API surface and the snake_case DB consumers happy.
        p["charge_per"] = charge_per
    return plans


def _validate_rate_deposit_settings(settings: dict | None) -> dict | None:
    if settings is None:
        return None
    if not isinstance(settings, dict):
        raise ValueError("rate_deposit_settings must be an object")

    normalized: dict[str, dict] = {}
    for rate_key, raw in settings.items():
        if rate_key not in ("flexible", "nonrefundable"):
            raise ValueError("rate_deposit_settings keys must be 'flexible' or 'nonrefundable'")
        if raw is None:
            continue
        if not isinstance(raw, dict):
            raise ValueError("rate_deposit_settings entries must be objects")
        val = raw.get("enabled", False)
        if not isinstance(val, bool):
            raise ValueError("enabled must be a boolean")
        enabled = val
        percentage = raw.get("percentage", 50 if enabled else None)
        if not enabled:
            normalized[rate_key] = {"enabled": False, "percentage": None}
            continue
        try:
            pct = int(percentage)
        except (TypeError, ValueError) as e:
            raise ValueError("deposit percentage must be an integer") from e
        if pct < 1 or pct > 100:
            raise ValueError("deposit percentage must be between 1 and 100")
        normalized[rate_key] = {"enabled": True, "percentage": pct}
    return normalized


def _validate_latitude(value: float | None) -> float | None:
    if value is not None and (not math.isfinite(value) or value < -90 or value > 90):
        raise ValueError("latitude must be between -90 and 90")
    return value


def _validate_longitude(value: float | None) -> float | None:
    if value is not None and (not math.isfinite(value) or value < -180 or value > 180):
        raise ValueError("longitude must be between -180 and 180")
    return value


def _validate_operating_periods(periods: list) -> list:
    """Raise ValueError if any operating period has end date before start date."""
    for p in periods:
        if p.get("from") and p.get("to") and p["to"] < p["from"]:
            raise ValueError(
                f"Operating period end date must be on or after start date: {p['from']} – {p['to']}"
            )
    return periods


def _normalize_season_date(d: str) -> str:
    """Normalize MM-DD to YYYY-MM-DD using a leap year as reference."""
    if d and len(d) == 5 and d[2] == "-":
        return f"2024-{d}"  # Use leap year so Feb 29 is valid
    return d


def _normalize_season_dates(seasons: list) -> list:
    """Ensure all season from/to dates are full YYYY-MM-DD."""
    for s in seasons:
        if s.get("from"):
            s["from"] = _normalize_season_date(s["from"])
        if s.get("to"):
            s["to"] = _normalize_season_date(s["to"])
    return seasons


def _validate_no_season_overlap(seasons: list) -> list:
    """Raise ValueError if any two seasons have overlapping date ranges."""
    for i, a in enumerate(seasons):
        for b in seasons[i + 1 :]:
            if a.get("from") and a.get("to") and b.get("from") and b.get("to"):
                # Normalize to YYYY-MM-DD for correct string comparison
                af = _normalize_season_date(a["from"])
                at = _normalize_season_date(a["to"])
                bf = _normalize_season_date(b["from"])
                bt = _normalize_season_date(b["to"])
                if af <= bt and bf <= at:
                    raise ValueError(
                        f"Season date ranges overlap: "
                        f"{a.get('name', 'Unnamed')} ({a['from']} – {a['to']}) and "
                        f"{b.get('name', 'Unnamed')} ({b['from']} – {b['to']})"
                    )
    return seasons


def _validate_season_rates(seasons: list) -> list:
    """Raise ValueError if any season has a missing or zero rate."""
    for s in seasons:
        rate = s.get("rate")
        if rate is None or rate == "" or float(rate) <= 0:
            name = s.get("name") or "Unnamed"
            raise ValueError(f'Season "{name}" must have a rate greater than 0')
    return seasons


def _validate_season_stay_restrictions(seasons: list) -> list:
    """Normalize and validate per-season min/max stay restrictions."""
    for s in seasons:
        raw_min = s.get("minStay", s.get("min_stay", 1))
        try:
            min_stay = 1 if raw_min is None or raw_min == "" else int(raw_min)
        except (TypeError, ValueError) as e:
            raise ValueError("Min stay must be a positive integer") from e
        if min_stay < 1:
            raise ValueError("Min stay must be a positive integer")
        s["minStay"] = min_stay

        raw_max = s.get("maxStay", s.get("max_stay"))
        if raw_max in (None, ""):
            s["maxStay"] = None
            continue
        try:
            max_stay = int(raw_max)
        except (TypeError, ValueError) as e:
            raise ValueError("Max stay must be 0 or a positive integer") from e
        if max_stay < 0:
            raise ValueError("Max stay must be 0 or a positive integer")
        if max_stay == 0:
            s["maxStay"] = None
            continue
        if max_stay < min_stay:
            raise ValueError("Max stay cannot be less than min stay.")
        s["maxStay"] = max_stay
    return seasons


_DAYS_IN_MONTH = (31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)  # leap-year so Feb 29 is valid
_TOTAL_DAYS = sum(_DAYS_IN_MONTH)


def _mmdd_to_doy(mmdd: str) -> int:
    """Convert YYYY-MM-DD or MM-DD to day-of-year (1..366) on a leap-year calendar."""
    if len(mmdd) > 5:
        mmdd = mmdd[5:]
    m, d = int(mmdd[:2]), int(mmdd[3:])
    return sum(_DAYS_IN_MONTH[: m - 1]) + d


def _doy_to_mmdd(doy: int) -> str:
    m = 0
    rem = doy
    while m < 12 and rem > _DAYS_IN_MONTH[m]:
        rem -= _DAYS_IN_MONTH[m]
        m += 1
    return f"{m + 1:02d}-{rem:02d}"


def _fill_range(target: list[bool], from_mmdd: str, to_mmdd: str) -> None:
    f = _mmdd_to_doy(from_mmdd)
    t = _mmdd_to_doy(to_mmdd)
    if f <= t:
        for d in range(f, t + 1):
            target[d] = True
    else:
        # Cross-year wrap (e.g. Nov 1 – Feb 28)
        for d in range(f, _TOTAL_DAYS + 1):
            target[d] = True
        for d in range(1, t + 1):
            target[d] = True


def _validate_no_season_gaps(seasons: list, operating_periods: list | None = None) -> list:
    """Raise ValueError if any open day has no season coverage.

    A day is "open" if it falls inside an operating period. Days outside all
    operating periods are intentionally closed and never count as gaps. If no
    operating periods are configured, the property is treated as fully closed
    year-round, so no seasons are required and no gaps are possible.
    """
    valid_seasons = [s for s in seasons if s.get("from") and s.get("to")]
    valid_periods = [p for p in (operating_periods or []) if p.get("from") and p.get("to")]

    if not valid_periods:
        return seasons

    open_days = [False] * (_TOTAL_DAYS + 1)
    for p in valid_periods:
        _fill_range(open_days, p["from"], p["to"])

    covered_days = [False] * (_TOTAL_DAYS + 1)
    for s in valid_seasons:
        _fill_range(covered_days, s["from"], s["to"])

    gaps: list[str] = []
    run_start: int | None = None
    for d in range(1, _TOTAL_DAYS + 1):
        is_gap = open_days[d] and not covered_days[d]
        if is_gap and run_start is None:
            run_start = d
        if not is_gap and run_start is not None:
            gaps.append(f"{_doy_to_mmdd(run_start)} – {_doy_to_mmdd(d - 1)}")
            run_start = None
    if run_start is not None:
        gaps.append(f"{_doy_to_mmdd(run_start)} – {_doy_to_mmdd(_TOTAL_DAYS)}")

    if gaps:
        raise ValueError(f"Season date ranges have gaps (dates with no price): {'; '.join(gaps)}")
    return seasons


def to_camel(string: str) -> str:
    parts = string.split("_")
    return parts[0] + "".join(w.capitalize() for w in parts[1:])


class MonthlyRate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    base_rate: float | None = None
    non_refundable_rate: float | None = None


class RoomTypeCreate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str
    category: str = ""
    description: str = ""
    short_description: str = ""
    max_occupancy: int = 2
    max_adults: int | None = None
    max_children: int | None = None
    bedrooms: int = 1
    bathrooms: int = 1
    size: int = 0
    base_rate: float = 0
    non_refundable_rate: float | None = None
    currency: str = "EUR"
    location_address: str = ""
    latitude: float | None = None
    longitude: float | None = None
    amenities: list[str] = []
    images: list[RoomImageReference] = []
    bed_type: str = ""
    features: list[str] = []
    benefits: list[str] = []
    total_rooms: int = 2
    is_active: bool = True
    sort_order: int = 0
    monthly_rates: dict[str, MonthlyRate] | None = None
    daily_rates: dict[str, float] | None = None
    operating_periods: list[dict] = []
    seasons: list[dict] = []
    weekend_surcharge: str = "+0%"
    cancellation_policy: str = "Free until 7 days before"
    flexible_rate_enabled: bool = True
    flexible_cancellation_type: str = "free"
    partial_refund_cancel_window_days: int = 30
    partial_refund_amount_percent: int = 50
    partial_refund_tiers: list[dict] = []
    non_refundable_enabled: bool = False
    non_refundable_discount: int = 5
    non_refundable_cancellation_policy: str = "Non-refundable from booking"
    last_minute_discount: dict | None = None
    minimum_advance_days: int = 0
    rate_payment_methods: dict[str, list[str]] | None = None
    rate_deposit_settings: dict[str, dict] | None = None
    meal_plans: list[dict] = []

    @field_validator("size")
    @classmethod
    def validate_size(cls, v: int) -> int:
        if v > MAX_ROOM_SIZE:
            raise ValueError(f"Room size must not exceed {MAX_ROOM_SIZE} m²")
        return v

    @field_validator("max_adults")
    @classmethod
    def validate_max_adults(cls, v: int | None) -> int | None:
        if v is not None and v < 1:
            raise ValueError("max_adults must be at least 1")
        return v

    @field_validator("max_children")
    @classmethod
    def validate_max_children(cls, v: int | None) -> int | None:
        if v is not None and v < 0:
            raise ValueError("max_children must be at least 0")
        return v

    @field_validator("latitude")
    @classmethod
    def validate_latitude(cls, v: float | None) -> float | None:
        return _validate_latitude(v)

    @field_validator("longitude")
    @classmethod
    def validate_longitude(cls, v: float | None) -> float | None:
        return _validate_longitude(v)

    @field_validator("meal_plans")
    @classmethod
    def validate_meal_plans(cls, v: list[dict]) -> list[dict]:
        return _validate_meal_plans(v)

    @field_validator("rate_deposit_settings")
    @classmethod
    def validate_rate_deposit_settings(cls, v: dict[str, dict] | None) -> dict | None:
        return _validate_rate_deposit_settings(v)

    @field_validator("flexible_cancellation_type")
    @classmethod
    def validate_flexible_cancellation_type(cls, v: str) -> str:
        if v not in ("free", "partial_refund"):
            raise ValueError("flexible_cancellation_type must be 'free' or 'partial_refund'")
        return v

    @field_validator("partial_refund_cancel_window_days")
    @classmethod
    def validate_partial_refund_window(cls, v: int) -> int:
        if v < 1 or v > 365:
            raise ValueError("partial_refund_cancel_window_days must be between 1 and 365")
        return v

    @field_validator("partial_refund_amount_percent")
    @classmethod
    def validate_partial_refund_percent(cls, v: int) -> int:
        if v < 1 or v > 99:
            raise ValueError("partial_refund_amount_percent must be between 1 and 99")
        return v

    @field_validator("partial_refund_tiers")
    @classmethod
    def validate_partial_refund_tiers(cls, v: list[dict]) -> list[dict]:
        return _validate_partial_refund_tiers(v)

    @field_validator("operating_periods")
    @classmethod
    def validate_operating_periods(cls, v: list[dict]) -> list[dict]:
        return _validate_operating_periods(v)

    @field_validator("seasons")
    @classmethod
    def validate_seasons(cls, v: list[dict]) -> list[dict]:
        _normalize_season_dates(v)
        _validate_season_rates(v)
        _validate_season_stay_restrictions(v)
        _validate_no_season_overlap(v)
        return v

    @model_validator(mode="after")
    def validate_seasons_against_operating_periods(self) -> "RoomTypeCreate":
        _validate_no_season_gaps(self.seasons, self.operating_periods)
        if self.flexible_cancellation_type == "partial_refund" and not self.partial_refund_tiers:
            raise ValueError("partial_refund requires at least one partial_refund_tier")
        return self


class RoomTypeUpdate(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str | None = None
    category: str | None = None
    description: str | None = None
    short_description: str | None = None
    max_occupancy: int | None = None
    max_adults: int | None = None
    max_children: int | None = None
    bedrooms: int | None = None
    bathrooms: int | None = None
    size: int | None = None
    base_rate: float | None = None
    non_refundable_rate: float | None = None
    currency: str | None = None
    location_address: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    amenities: list[str] | None = None
    images: list[RoomImageReference] | None = None
    bed_type: str | None = None
    features: list[str] | None = None
    benefits: list[str] | None = None
    total_rooms: int | None = None
    is_active: bool | None = None
    sort_order: int | None = None
    monthly_rates: dict[str, MonthlyRate] | None = None
    daily_rates: dict[str, float] | None = None
    operating_periods: list[dict] | None = None
    seasons: list[dict] | None = None
    weekend_surcharge: str | None = None
    cancellation_policy: str | None = None
    flexible_rate_enabled: bool | None = None
    flexible_cancellation_type: str | None = None
    partial_refund_cancel_window_days: int | None = None
    partial_refund_amount_percent: int | None = None
    partial_refund_tiers: list[dict] | None = None
    non_refundable_enabled: bool | None = None
    non_refundable_discount: int | None = None
    non_refundable_cancellation_policy: str | None = None
    last_minute_discount: dict | None = None
    minimum_advance_days: int | None = None
    rate_payment_methods: dict[str, list[str]] | None = None
    rate_deposit_settings: dict[str, dict] | None = None
    meal_plans: list[dict] | None = None

    @field_validator("location_address")
    @classmethod
    def validate_location_address(cls, v: str | None) -> str | None:
        if v is None:
            return ""
        return v

    @field_validator("size")
    @classmethod
    def validate_size(cls, v: int | None) -> int | None:
        if v is not None and v > MAX_ROOM_SIZE:
            raise ValueError(f"Room size must not exceed {MAX_ROOM_SIZE} m²")
        return v

    @field_validator("max_adults")
    @classmethod
    def validate_max_adults(cls, v: int | None) -> int | None:
        if v is not None and v < 1:
            raise ValueError("max_adults must be at least 1")
        return v

    @field_validator("max_children")
    @classmethod
    def validate_max_children(cls, v: int | None) -> int | None:
        if v is not None and v < 0:
            raise ValueError("max_children must be at least 0")
        return v

    @field_validator("latitude")
    @classmethod
    def validate_latitude(cls, v: float | None) -> float | None:
        return _validate_latitude(v)

    @field_validator("longitude")
    @classmethod
    def validate_longitude(cls, v: float | None) -> float | None:
        return _validate_longitude(v)

    @field_validator("flexible_cancellation_type")
    @classmethod
    def validate_flexible_cancellation_type(cls, v: str | None) -> str | None:
        if v is not None and v not in ("free", "partial_refund"):
            raise ValueError("flexible_cancellation_type must be 'free' or 'partial_refund'")
        return v

    @field_validator("partial_refund_cancel_window_days")
    @classmethod
    def validate_partial_refund_window(cls, v: int | None) -> int | None:
        if v is not None and (v < 1 or v > 365):
            raise ValueError("partial_refund_cancel_window_days must be between 1 and 365")
        return v

    @field_validator("partial_refund_amount_percent")
    @classmethod
    def validate_partial_refund_percent(cls, v: int | None) -> int | None:
        if v is not None and (v < 1 or v > 99):
            raise ValueError("partial_refund_amount_percent must be between 1 and 99")
        return v

    @field_validator("partial_refund_tiers")
    @classmethod
    def validate_partial_refund_tiers(cls, v: list[dict] | None) -> list[dict] | None:
        if v is None:
            return v
        return _validate_partial_refund_tiers(v)

    @field_validator("operating_periods")
    @classmethod
    def validate_operating_periods(cls, v: list[dict] | None) -> list[dict] | None:
        if v is not None:
            _validate_operating_periods(v)
        return v

    @field_validator("seasons")
    @classmethod
    def validate_seasons(cls, v: list[dict] | None) -> list[dict] | None:
        if v is not None:
            _normalize_season_dates(v)
            _validate_season_rates(v)
            _validate_season_stay_restrictions(v)
            _validate_no_season_overlap(v)
        return v

    @model_validator(mode="after")
    def validate_seasons_against_operating_periods(self) -> "RoomTypeUpdate":
        # Only run gap detection when seasons are being submitted in this update.
        # operating_periods may be None in a partial update — pass it through;
        # the helper treats missing periods as full-year open (legacy behavior).
        if self.seasons is not None:
            _validate_no_season_gaps(self.seasons, self.operating_periods)
        return self

    @field_validator("meal_plans")
    @classmethod
    def validate_meal_plans(cls, v: list[dict] | None) -> list[dict] | None:
        if v is not None:
            _validate_meal_plans(v)
        return v

    @field_validator("rate_deposit_settings")
    @classmethod
    def validate_rate_deposit_settings(cls, v: dict[str, dict] | None) -> dict | None:
        return _validate_rate_deposit_settings(v)


class PartialRefundTierResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    min_days_before_check_in: int
    refund_percent: int


class RoomTypeResponse(BaseModel):
    """Guest-facing response — includes availability."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    name: str
    category: str = ""
    description: str
    short_description: str
    max_occupancy: int
    max_adults: int | None = None
    max_children: int | None = None
    bedrooms: int = 1
    bathrooms: int = 1
    size: int
    base_rate: float
    non_refundable_rate: float | None = None
    nightly_rates: list[float] = []
    non_refundable_nightly_rates: list[float] = []
    original_nightly_rates: list[float] = []
    original_rate: float | None = None
    last_minute_discount_percent: int | None = None
    currency: str
    location_address: str = ""
    latitude: float | None = None
    longitude: float | None = None
    amenities: list[str]
    images: list[str]
    bed_type: str
    remaining_rooms: int
    features: list[str]
    benefits: list[str] = []
    flexible_rate_enabled: bool = True
    cancellation_policy: str = "Free until 7 days before"
    flexible_cancellation_type: str = "free"
    partial_refund_cancel_window_days: int = 30
    partial_refund_amount_percent: int = 50
    partial_refund_tiers: list[PartialRefundTierResponse] = []
    non_refundable_cancellation_policy: str = "Non-refundable from booking"
    rate_payment_methods: dict[str, list[str]] | None = None
    rate_deposit_settings: dict[str, dict] | None = None


class RoomTypeAdminResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    hotel_id: str
    name: str
    category: str = ""
    description: str
    short_description: str
    max_occupancy: int
    max_adults: int | None = None
    max_children: int | None = None
    bedrooms: int = 1
    bathrooms: int = 1
    size: int
    base_rate: float
    non_refundable_rate: float | None = None
    currency: str
    location_address: str = ""
    latitude: float | None = None
    longitude: float | None = None
    amenities: list[str]
    images: list[RoomImageReference]
    bed_type: str
    features: list[str]
    benefits: list[str] = []
    total_rooms: int
    is_active: bool
    sort_order: int
    monthly_rates: dict[str, MonthlyRate] = {}
    daily_rates: dict[str, float] = {}
    operating_periods: list[dict] = []
    seasons: list[dict] = []
    weekend_surcharge: str = "+0%"
    cancellation_policy: str = "Free until 7 days before"
    flexible_rate_enabled: bool = True
    flexible_cancellation_type: str = "free"
    partial_refund_cancel_window_days: int = 30
    partial_refund_amount_percent: int = 50
    partial_refund_tiers: list[PartialRefundTierResponse] = []
    non_refundable_enabled: bool = False
    non_refundable_discount: int = 5
    non_refundable_cancellation_policy: str = "Non-refundable from booking"
    last_minute_discount: dict | None = None
    minimum_advance_days: int = 0
    rate_payment_methods: dict[str, list[str]] | None = None
    rate_deposit_settings: dict[str, dict] | None = None
    meal_plans: list[dict] = []
    created_at: str
    updated_at: str


class UnavailableDatesResponse(BaseModel):
    """Public /api/hotels/{slug}/unavailable-dates: dates where every room
    type is fully booked, plus per-arrival stay-length constraints."""

    dates: list[str] = []
    min_stay_by_arrival: dict[str, int] = {}
    max_stay_by_arrival: dict[str, int] = {}

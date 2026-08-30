"""Channex ARI push — availability, restrictions, and cancellation policy.

These are the outbound writes that publish vayada inventory + rates +
rules to Channex (which fans them out to OTAs)."""

import logging
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from app.repositories.channex_mapping_repo import (
    ChannexChannelMarkupRepository,
    ChannexConnectionRepository,
    ChannexRatePlanMappingRepository,
    ChannexRoomTypeMappingRepository,
)
from app.repositories.hotel_repo import HotelRepository
from app.repositories.linked_inventory_group_repo import LinkedInventoryGroupRepository
from app.repositories.room_type_repo import RoomTypeRepository
from app.services import channex_service
from app.services.availability_service import compute_non_refundable_rate
from app.services.calendar_auto_open_service import has_sellable_rate_on_date, is_date_auto_open
from app.services.channex._common import SYNC_HORIZON_DAYS, _count_local_blocks
from app.utils import parse_jsonb

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AriPushResult:
    ok: bool
    error: str | None = None

    def __bool__(self) -> bool:
        return self.ok


def _push_error_summary(prefix: str, exc: Exception) -> str:
    detail = getattr(exc, "summary", None) or str(exc)
    return f"{prefix}: {detail}" if detail else prefix


# ── Availability ─────────────────────────────────────────────────────


async def _push_availability_for_room_type(
    hotel_id: str,
    room_type_id: str,
    start_date: date | None = None,
    end_date: date | None = None,
) -> AriPushResult:
    """Calculate and push availability for a room type to Channex."""
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"] or not conn.get("channex_property_id"):
        return AriPushResult(True)

    room_mapping = await ChannexRoomTypeMappingRepository.get_by_room_type_id(room_type_id)
    if not room_mapping:
        return AriPushResult(True)

    room_type = await RoomTypeRepository.get_by_id(room_type_id)
    if not room_type:
        return AriPushResult(True)

    if start_date is None:
        start_date = date.today()
    if end_date is None:
        end_date = start_date + timedelta(days=SYNC_HORIZON_DAYS)

    api_key = channex_service.get_platform_api_key()
    channex_property_id = str(conn["channex_property_id"])
    channex_room_type_id = str(room_mapping["channex_room_type_id"])
    total_rooms = room_type["total_rooms"]
    calendar_settings = await HotelRepository.get_calendar_settings(hotel_id)

    # Build per-day availability, batch into date ranges where possible
    values = []
    current = start_date
    batch_start = current
    prev_available = None

    while current <= end_date:
        next_day = current + timedelta(days=1)
        linked_stopped = await LinkedInventoryGroupRepository.has_activity(
            room_type_id,
            current,
            next_day,
            include_soft_holds=False,
        )
        if (
            linked_stopped
            or not is_date_auto_open(calendar_settings, current)
            or not has_sellable_rate_on_date(room_type, current)
        ):
            available = 0
        else:
            booked = await RoomTypeRepository.count_booked(room_type_id, current, next_day)
            blocked = await _count_local_blocks(room_type_id, current, next_day)
            available = max(0, total_rooms - booked - blocked)

        if prev_available is not None and available != prev_available:
            # Flush previous batch
            values.append(
                {
                    "property_id": channex_property_id,
                    "room_type_id": channex_room_type_id,
                    "date_from": batch_start.isoformat(),
                    "date_to": (current - timedelta(days=1)).isoformat(),
                    "availability": prev_available,
                }
            )
            batch_start = current

        prev_available = available
        current = next_day

    # Flush last batch
    if prev_available is not None:
        values.append(
            {
                "property_id": channex_property_id,
                "room_type_id": channex_room_type_id,
                "date_from": batch_start.isoformat(),
                "date_to": (current - timedelta(days=1)).isoformat(),
                "availability": prev_available,
            }
        )

    if not values:
        return AriPushResult(True)

    try:
        await channex_service.push_availability(api_key, values)
        logger.info(
            "Pushed availability for room type %s (%d ranges)",
            room_type_id,
            len(values),
        )
        return AriPushResult(True)
    except Exception as e:
        error = _push_error_summary(
            f"availability push failed for room type {room_type_id}",
            e,
        )
        logger.error(
            error,
            exc_info=True,
        )
        return AriPushResult(False, error)


async def push_availability_for_room_type(
    hotel_id: str,
    room_type_id: str,
    start_date: date | None = None,
    end_date: date | None = None,
) -> AriPushResult:
    """Push one room type, or every member when it uses linked inventory."""
    member_ids = await LinkedInventoryGroupRepository.list_member_ids_for_room_type(room_type_id)
    targets = member_ids or [room_type_id]
    errors = []
    for target_id in targets:
        result = await _push_availability_for_room_type(
            hotel_id,
            target_id,
            start_date=start_date,
            end_date=end_date,
        )
        if not result:
            errors.append(result.error or f"availability push failed for room type {target_id}")
    return AriPushResult(not errors, "; ".join(errors) or None)


# ── Restrictions (rates + rules) ─────────────────────────────────────


def _meal_surcharge_for_code(room_type: dict, meal_plan_code: int) -> Decimal:
    """Look up the per-night meal surcharge for a meal_plan_code.

    When charge_per == 'person' the per-guest amount is multiplied by the
    room type's max_occupancy so the rate Channex pushes to OTAs reflects
    the full board cost for a fully-occupied room.
    """
    if not meal_plan_code:
        return Decimal(0)
    meal_plans = parse_jsonb(room_type.get("meal_plans") or [])
    for entry in meal_plans:
        if int(entry.get("code") or 0) != meal_plan_code:
            continue
        amount = Decimal(str(entry.get("surcharge") or 0))
        # Accept both camelCase (FE-fresh) and snake_case (validator-normalized).
        charge_per = entry.get("charge_per") or entry.get("chargePer") or "room"
        if charge_per == "person":
            occupancy = int(room_type.get("max_occupancy") or 2)
            amount = amount * occupancy
        return amount
    return Decimal(0)


def _build_restriction_entry(
    room_type: dict,
    check_date: date,
    calendar_settings: dict | None = None,
    plan_name: str = "standard",
    markup_pct: Decimal = Decimal(0),
    meal_plan_code: int = 0,
) -> dict:
    """Build a restriction snapshot for a single date.
    Returns dict with rate, min_stay_arrival, max_stay, stop_sell, CTA, CTD."""
    base_rate, non_refundable_rate = RoomTypeRepository.resolve_rate(room_type, check_date)

    # Use non-refundable rate/discount for non_refundable plans
    if plan_name == "non_refundable":
        rate = compute_non_refundable_rate(room_type, base_rate, non_refundable_rate)
    else:
        rate = base_rate

    # Add the per-night meal surcharge before channel markup so the markup
    # also applies to the meal cost (mirrors how OTAs compute commission on
    # the full guest-paid amount).
    surcharge = _meal_surcharge_for_code(room_type, meal_plan_code)
    if surcharge:
        rate = round(float(rate) + float(surcharge), 2)

    # Apply channel markup (direct is always 0%)
    if markup_pct:
        rate = round(float(rate) * (1 + float(markup_pct) / 100), 2)

    # stop_sell: true if the date falls outside all operating periods
    in_operating = RoomTypeRepository.is_date_in_operating_periods(room_type, check_date)
    stop_sell = (
        not in_operating
        or not is_date_auto_open(calendar_settings, check_date)
        or float(base_rate) <= 0
    )
    seasons = RoomTypeRepository._parse_seasons(room_type)
    season_min_stay = RoomTypeRepository._find_season_min_stay(seasons, check_date)
    season_max_stay = RoomTypeRepository._find_season_max_stay(seasons, check_date)

    return {
        "rate": rate,
        "min_stay_arrival": season_min_stay or room_type.get("min_stay", 1) or 1,
        "max_stay": season_max_stay or room_type.get("max_stay", 0) or 0,
        "stop_sell": stop_sell,
        "closed_to_arrival": bool(room_type.get("closed_to_arrival", False)),
        "closed_to_departure": bool(room_type.get("closed_to_departure", False)),
    }


def _restrictions_equal(a: dict, b: dict) -> bool:
    """Check if two restriction snapshots are identical (for batching)."""
    return (
        a["rate"] == b["rate"]
        and a["min_stay_arrival"] == b["min_stay_arrival"]
        and a["max_stay"] == b["max_stay"]
        and a["stop_sell"] == b["stop_sell"]
        and a["closed_to_arrival"] == b["closed_to_arrival"]
        and a["closed_to_departure"] == b["closed_to_departure"]
    )


def _restriction_to_value(
    restr: dict,
    channex_property_id: str,
    channex_rate_plan_id: str,
    date_from: date,
    date_to: date,
) -> dict:
    """Convert a restriction snapshot into a Channex API value entry."""
    entry = {
        "property_id": channex_property_id,
        "rate_plan_id": channex_rate_plan_id,
        "date_from": date_from.isoformat(),
        "date_to": date_to.isoformat(),
        "rate": str(restr["rate"]),
        "min_stay_arrival": restr["min_stay_arrival"],
        "max_stay": restr["max_stay"],
        "stop_sell": 1 if restr["stop_sell"] else 0,
        "closed_to_arrival": 1 if restr["closed_to_arrival"] else 0,
        "closed_to_departure": 1 if restr["closed_to_departure"] else 0,
    }
    return entry


async def push_restrictions_for_rate_plan(
    hotel_id: str,
    room_type_id: str,
    channex_rate_plan_id: str,
    plan_name: str = "standard",
    channel: str = "direct",
    markup_pct: Decimal | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    meal_plan_code: int = 0,
) -> AriPushResult:
    """Calculate and push rates + restrictions for a single rate plan to Channex."""
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"] or not conn.get("channex_property_id"):
        return AriPushResult(True)

    room_type = await RoomTypeRepository.get_by_id(room_type_id)
    if not room_type:
        return AriPushResult(True)
    calendar_settings = await HotelRepository.get_calendar_settings(hotel_id)

    if start_date is None:
        start_date = date.today()
    if end_date is None:
        end_date = start_date + timedelta(days=SYNC_HORIZON_DAYS)

    if markup_pct is None:
        markup_map = await ChannexChannelMarkupRepository.get_markup_map(hotel_id)
        markup_pct = markup_map.get(channel, Decimal(0))

    api_key = channex_service.get_platform_api_key()
    channex_property_id = str(conn["channex_property_id"])

    # Build restriction entries, batching consecutive identical days into ranges
    values = []
    current = start_date
    batch_start = current
    prev_restr = None

    while current <= end_date:
        restr = _build_restriction_entry(
            room_type,
            current,
            calendar_settings,
            plan_name,
            markup_pct,
            meal_plan_code,
        )

        if prev_restr is not None and not _restrictions_equal(prev_restr, restr):
            values.append(
                _restriction_to_value(
                    prev_restr,
                    channex_property_id,
                    channex_rate_plan_id,
                    batch_start,
                    current - timedelta(days=1),
                )
            )
            batch_start = current

        prev_restr = restr
        current = current + timedelta(days=1)

    if prev_restr is not None:
        values.append(
            _restriction_to_value(
                prev_restr,
                channex_property_id,
                channex_rate_plan_id,
                batch_start,
                current - timedelta(days=1),
            )
        )

    if not values:
        return AriPushResult(True)

    # VAY-349: structured payload log so we can verify exactly what leaves
    # our system per (date_from..date_to, channel, plan, meal, markup) →
    # final rate. Lets us tell whether a discrepancy on the OTA side comes
    # from our payload or from a Channex-side transform.
    for v in values:
        logger.info(
            "channex_ari_push room_type=%s channex_rate_plan=%s channel=%s "
            "plan=%s meal_plan_code=%d markup_pct=%s date_from=%s date_to=%s "
            "rate=%s",
            room_type_id,
            channex_rate_plan_id,
            channel,
            plan_name,
            meal_plan_code,
            markup_pct,
            v["date_from"],
            v["date_to"],
            v["rate"],
        )

    try:
        await channex_service.push_restrictions(api_key, values)
        logger.info(
            "Pushed restrictions for room type %s rate plan %s (%d ranges)",
            room_type_id,
            channex_rate_plan_id,
            len(values),
        )
        return AriPushResult(True)
    except Exception as e:
        error = _push_error_summary(
            f"restrictions push failed for room type {room_type_id} "
            f"rate plan {channex_rate_plan_id}",
            e,
        )
        logger.error(
            error,
            exc_info=True,
        )
        return AriPushResult(False, error)


# ── Cancellation policy ──────────────────────────────────────────────
#
# Maps a room type's flexible-rate cancellation settings onto each Channex
# flexible rate plan so OTA guests see the correct refund terms. The
# non_refundable plan keeps its own (separate) policy and is left alone.
#
# Airbnb caveat: Airbnb only accepts a fixed set of preset cancellation
# policies (Flexible / Moderate / Strict / etc.) which Channex exposes via
# the channel iframe rather than the rate-plan API. We skip Airbnb mappings
# here; hosts continue to manage Airbnb's policy through the iframe.


def _build_cancellation_policy(
    room_type: dict,
    channel: str,
) -> list[dict] | None:
    """Build Channex cancellation_policies entries for a flexible rate plan.

    Returns a list of policy entries, or None if the channel can't accept a
    custom policy (currently: airbnb).
    """
    if channel == "airbnb":
        return None

    cancel_type = room_type.get("flexible_cancellation_type") or "free"

    if cancel_type == "partial_refund":
        window = int(room_type.get("partial_refund_cancel_window_days") or 30)
        refund_pct = int(room_type.get("partial_refund_amount_percent") or 50)
        # Channex penalty_value is the amount KEPT, not refunded.
        penalty_pct = max(0, min(100, 100 - refund_pct))
        return [
            # Free refund up to `window` days before arrival.
            {
                "days_before_arrival": window,
                "penalty_type": "percent",
                "penalty_value": 0,
            },
            # Inside the window: keep `penalty_pct`, refund the rest.
            {
                "days_before_arrival": 0,
                "penalty_type": "percent",
                "penalty_value": penalty_pct,
            },
        ]

    # "free" — refund anytime up to arrival.
    return [
        {
            "days_before_arrival": 0,
            "penalty_type": "percent",
            "penalty_value": 0,
        },
    ]


async def push_cancellation_policy_for_room_type(
    hotel_id: str,
    room_type_id: str,
) -> None:
    """Push the room type's flexible-rate cancellation policy to every
    matching Channex rate plan. Skips non_refundable plans and airbnb."""
    conn = await ChannexConnectionRepository.get_by_hotel_id(hotel_id)
    if not conn or not conn["is_active"] or not conn.get("channex_property_id"):
        return

    room_type = await RoomTypeRepository.get_by_id(room_type_id)
    if not room_type:
        return

    rate_plans = await ChannexRatePlanMappingRepository.list_by_room_type_id(room_type_id)
    if not rate_plans:
        return

    api_key = channex_service.get_platform_api_key()

    for rp in rate_plans:
        if rp.get("plan_name", "standard") != "standard":
            continue
        channel = rp.get("channel", "direct")
        policies = _build_cancellation_policy(room_type, channel)
        if policies is None:
            logger.info(
                "Skipping cancellation policy push for room type %s on %s "
                "(channel uses preset policies)",
                room_type_id,
                channel,
            )
            continue

        rate_plan_id = str(rp["channex_rate_plan_id"])
        try:
            await channex_service.update_rate_plan_cancellation_policy(
                api_key,
                rate_plan_id,
                policies=policies,
            )
            logger.info(
                "Pushed cancellation policy for room type %s rate plan %s (%s)",
                room_type_id,
                rate_plan_id,
                channel,
            )
        except Exception as e:
            logger.error(
                "Failed to push cancellation policy for room type %s rate plan %s: %s",
                room_type_id,
                rate_plan_id,
                e,
            )

from datetime import date
from decimal import Decimal
from uuid import UUID

import pytest
from app.models.promo_code import CreatePromoCodeRequest
from app.repositories.promo_code_repo import PromoCodeRepository
from app.routers.hotels import increment_promo_usage, validate_promo_code
from pydantic import ValidationError

ROOM_ID = UUID("1f850001-0000-4000-8000-000000000010")


def promo_row(**overrides):
    return {
        "id": UUID("1f850001-0000-4000-8000-000000000001"),
        "code": "SUMMER20",
        "discount_type": "percentage",
        "discount_value": Decimal("20.00"),
        "min_booking_value": None,
        "applicable_room_ids": None,
        "valid_from": None,
        "valid_until": None,
        "stay_date_from": None,
        "stay_date_until": None,
        "is_active": True,
        "max_uses": 10,
        "current_uses": 0,
        **overrides,
    }


@pytest.mark.parametrize(
    ("promo", "context", "message"),
    [
        (
            promo_row(valid_until=date(2020, 1, 1)),
            {},
            "This promo code has expired.",
        ),
        (
            promo_row(stay_date_from=date(2026, 9, 13)),
            {"check_in": date(2026, 9, 12)},
            "This promo code is not valid for your selected dates.",
        ),
        (
            promo_row(applicable_room_ids=[ROOM_ID]),
            {"room_type_id": "1f850001-0000-4000-8000-000000000099"},
            "This promo code is not available for the selected room.",
        ),
        (
            promo_row(min_booking_value=Decimal("500.00")),
            {"booking_total": Decimal("270.00")},
            "Your booking must be at least EUR 500 to use this code.",
        ),
        (
            promo_row(current_uses=10),
            {},
            "This promo code has reached its maximum number of uses.",
        ),
    ],
)
async def test_public_validation_returns_specific_rule_errors(monkeypatch, promo, context, message):
    async def get_hotel(_slug):
        return {"id": UUID("1f850001-0000-4000-8000-000000000002"), "default_currency": "EUR"}

    async def get_promo(_code, _hotel_id):
        return promo

    monkeypatch.setattr("app.routers.hotels.BookingHotelRepository.get_by_slug", get_hotel)
    monkeypatch.setattr("app.routers.hotels.PromoCodeRepository.get_by_code", get_promo)

    result = await validate_promo_code("alpenrose", "summer20", **context)

    assert result.valid is False
    assert result.message == message


async def test_public_validation_returns_property_currency_on_success(monkeypatch):
    async def get_hotel(_slug):
        return {"id": UUID("1f850001-0000-4000-8000-000000000002"), "default_currency": "CHF"}

    async def get_promo(_code, _hotel_id):
        return promo_row(discount_type="fixed", discount_value=Decimal("50.00"))

    monkeypatch.setattr("app.routers.hotels.BookingHotelRepository.get_by_slug", get_hotel)
    monkeypatch.setattr("app.routers.hotels.PromoCodeRepository.get_by_code", get_promo)

    result = await validate_promo_code(
        "alpenrose",
        "direct50",
        check_in=date(2026, 9, 12),
        room_type_id=str(ROOM_ID),
        booking_total=Decimal("600.00"),
    )

    assert result.valid is True
    assert result.currency == "CHF"


async def test_redemption_is_atomic_and_idempotent(monkeypatch):
    calls = []

    async def fetchrow(query, *values):
        calls.append((query, values))
        return {"id": values[0]}

    monkeypatch.setattr("app.repositories.promo_code_repo.Database.fetchrow", fetchrow)

    redeemed = await PromoCodeRepository.redeem(
        "promo-1",
        "VAY-ABC123",
        check_in=date(2026, 9, 12),
        room_type_id=str(ROOM_ID),
        booking_total=600,
        property_date=date(2026, 8, 24),
    )

    assert redeemed is True
    assert "FOR UPDATE" in calls[0][0]
    assert "stay_date_from" in calls[0][0]
    assert "applicable_room_ids" in calls[0][0]
    assert "min_booking_value" in calls[0][0]
    assert "ON CONFLICT (redemption_key) DO NOTHING" in calls[0][0]
    assert "current_uses = current_uses + 1" in calls[0][0]


async def test_reversal_is_scoped_to_the_resolved_hotel(monkeypatch):
    calls = []

    async def fetchrow(query, *values):
        calls.append((query, values))
        return {"id": "promo-1"}

    monkeypatch.setattr("app.repositories.promo_code_repo.Database.fetchrow", fetchrow)

    reversed_redemption = await PromoCodeRepository.reverse_redemption(
        "hotel-1", "hotel-1:VAY-ABC123"
    )

    assert reversed_redemption is True
    assert "VALUES (NULL, $1, 'reversed', now())" in calls[0][0]
    assert "ON CONFLICT (redemption_key) DO UPDATE" in calls[0][0]
    assert "scoped_promo.hotel_id = $2" in calls[0][0]
    assert calls[0][1] == ("hotel-1:VAY-ABC123", "hotel-1")


async def test_concurrent_redemption_loser_reuses_active_ledger_claim(monkeypatch):
    hotel_id = UUID("1f850001-0000-4000-8000-000000000002")

    async def get_hotel(_slug):
        return {"id": hotel_id}

    async def get_promo(_code, _hotel_id):
        return promo_row()

    async def redeem(_promo_id, _redemption_key, **context):
        property_date = context.pop("property_date")
        assert context == {
            "check_in": date(2026, 9, 12),
            "room_type_id": str(ROOM_ID),
            "booking_total": 600.0,
        }
        assert isinstance(property_date, date)
        return False

    async def has_active(_promo_id, redemption_key):
        return redemption_key == f"{hotel_id}:VAY-ABC123"

    monkeypatch.setattr("app.routers.hotels.BookingHotelRepository.get_by_slug", get_hotel)
    monkeypatch.setattr("app.routers.hotels.PromoCodeRepository.get_by_code", get_promo)
    monkeypatch.setattr("app.routers.hotels.PromoCodeRepository.redeem", redeem)
    monkeypatch.setattr("app.routers.hotels.PromoCodeRepository.has_active_redemption", has_active)

    result = await increment_promo_usage(
        "alpenrose",
        "SUMMER20",
        "VAY-ABC123",
        date(2026, 9, 12),
        str(ROOM_ID),
        Decimal("600.00"),
    )

    assert result.ok is True


def test_creation_contract_rejects_duplicate_room_ids():
    with pytest.raises(ValidationError):
        CreatePromoCodeRequest(
            code="SUMMER20",
            discountType="percentage",
            discountValue="20.00",
            applicableRoomIds=[str(ROOM_ID), str(ROOM_ID)],
            maxUses=1,
        )

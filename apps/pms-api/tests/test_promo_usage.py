from datetime import date

import pytest
from app.repositories.booking_repo import BookingRepository
from app.services import booking_service
from app.services import promo_usage_reconciliation as promo_usage


class _Response:
    def raise_for_status(self):
        return None

    def json(self):
        return {"valid": True, "code": "SUMMER20"}


class _Client:
    calls: list[tuple[str, str, dict]] = []

    def __init__(self, **_kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, url, *, params):
        self.calls.append(("GET", url, params))
        return _Response()

    async def post(self, url, *, params, headers):
        self.calls.append(("POST", url, {"params": params, "headers": headers}))
        return _Response()


async def _async_value(value):
    return value


@pytest.fixture(autouse=True)
def _fake_booking_client(monkeypatch):
    _Client.calls = []
    monkeypatch.setattr(booking_service.httpx, "AsyncClient", _Client)


@pytest.mark.asyncio
async def test_promo_validation_sends_booking_rule_context():
    result = await booking_service._validate_promo_code(
        "alpenrose",
        "summer20",
        check_in=date(2026, 9, 12),
        room_type_id="room-suite",
        booking_total=720,
    )

    assert result == {"valid": True, "code": "SUMMER20"}
    assert _Client.calls == [
        (
            "GET",
            f"{booking_service.settings.BOOKING_ENGINE_API_URL}/api/hotels/alpenrose/validate-promo",
            {
                "code": "summer20",
                "check_in": "2026-09-12",
                "room_type_id": "room-suite",
                "booking_total": 720,
            },
        )
    ]


@pytest.mark.asyncio
async def test_authoritative_claim_replays_full_context_with_internal_auth(monkeypatch):
    monkeypatch.setattr(promo_usage.settings, "INTERNAL_API_KEY", "shared-test-key")
    monkeypatch.setattr(
        promo_usage.Database,
        "fetchrow",
        lambda *_args: _async_value(
            {
                "booking_reference": "VAY-ABC123",
                "hotel_slug": "alpenrose",
                "promo_code": "SUMMER20",
                "check_in": date(2026, 9, 12),
                "room_type_id": "room-suite",
                "booking_total": 720,
                "desired_state": "active",
                "applied_state": "pending",
            }
        ),
    )
    monkeypatch.setattr(promo_usage.Database, "execute", lambda *_args: _async_value("UPDATE 1"))

    await promo_usage.reconcile_promo_reference("VAY-ABC123")

    assert _Client.calls == [
        (
            "POST",
            f"{promo_usage.settings.BOOKING_ENGINE_API_URL}/api/hotels/alpenrose/increment-promo",
            {
                "params": {
                    "code": "SUMMER20",
                    "redemption_key": "VAY-ABC123",
                    "check_in": "2026-09-12",
                    "room_type_id": "room-suite",
                    "booking_total": 720.0,
                },
                "headers": {"X-Internal-Key": "shared-test-key"},
            },
        )
    ]


@pytest.mark.asyncio
async def test_ambiguous_claim_failure_durably_switches_to_reversal(monkeypatch):
    events = []

    async def prepare(**_kwargs):
        events.append("prepare-active")

    async def queue(**_kwargs):
        events.append("queue-reversal")

    async def reconcile(_reference):
        events.append("reconcile")
        raise RuntimeError("network timeout")

    monkeypatch.setattr(promo_usage, "prepare_promo_claim", prepare)
    monkeypatch.setattr(promo_usage, "queue_promo_reversal", queue)
    monkeypatch.setattr(promo_usage, "reconcile_promo_reference", reconcile)

    with pytest.raises(RuntimeError, match="network timeout"):
        await promo_usage.claim_promo_use(
            hotel_slug="alpenrose",
            promo_code="SUMMER20",
            booking_reference="VAY-ABC123",
            check_in=date(2026, 9, 12),
            room_type_id="room-suite",
            booking_total=720,
        )

    assert events == ["prepare-active", "reconcile", "queue-reversal", "reconcile"]


@pytest.mark.asyncio
async def test_cancellation_and_reversal_intent_share_one_statement(monkeypatch):
    calls = []

    async def fetchrow(query, *values):
        calls.append((query, values))
        return {"id": values[0], "status": "cancelled"}

    monkeypatch.setattr("app.repositories.booking_repo.Database.fetchrow", fetchrow)

    result = await BookingRepository.cancel_with_promo_reversal(
        "booking-1", payment_status="refunded", guest_withdrawn=True
    )

    assert result["status"] == "cancelled"
    assert "UPDATE bookings" in calls[0][0]
    assert "INSERT INTO booking_promo_usage_state" in calls[0][0]
    assert calls[0][1] == ("booking-1", "cancelled", "refunded", True)

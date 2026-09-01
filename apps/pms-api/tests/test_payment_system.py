"""
Tests for the payment system: Stripe integration, host approval flow,
payment settings, cancellation policies, and payouts.
"""

from datetime import UTC, date, datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.database import Database

from tests.conftest import (
    create_test_affiliate,
    create_test_booking,
    create_test_booking_with_payment,
    create_test_cancellation_policy,
    create_test_hotel,
    create_test_payment_settings,
    create_test_room_type,
    create_test_user,
    get_auth_headers,
)

# ── Mock Stripe responses ────────────────────────────────────────


def mock_create_payment_intent(**kwargs):
    return {
        "id": "pi_test_123456",
        "client_secret": "pi_test_123456_secret_abc",
        "status": "requires_payment_method",
    }


def mock_capture_payment_intent(pi_id, **kwargs):
    return {"id": pi_id, "status": "succeeded"}


def mock_cancel_payment_intent(pi_id, **kwargs):
    return {"id": pi_id, "status": "canceled"}


def mock_create_refund(pi_id, amount=None, **kwargs):
    return {"id": "re_test_123", "status": "succeeded", "amount": amount or 10000}


STRIPE_MOCKS = {
    "app.services.stripe_service.create_payment_intent": AsyncMock(
        side_effect=mock_create_payment_intent
    ),
    "app.services.stripe_service.capture_payment_intent": AsyncMock(
        side_effect=mock_capture_payment_intent
    ),
    "app.services.stripe_service.cancel_payment_intent": AsyncMock(
        side_effect=mock_cancel_payment_intent
    ),
    "app.services.stripe_service.create_refund": AsyncMock(side_effect=mock_create_refund),
}


def stripe_patches():
    """Return a list of patch context managers for all Stripe calls."""
    return [patch(k, v) for k, v in STRIPE_MOCKS.items()]


# ── Booking Request (Public) ─────────────────────────────────────


class TestCreateBookingRequest:
    """Tests for POST /api/hotels/{slug}/bookings (new payment flow)."""

    @pytest.fixture(autouse=True)
    def isolate_payment_scenarios_from_wall_clock(self, monkeypatch):
        monkeypatch.setattr(
            "app.services.booking_service.property_today", lambda timezone: date(2026, 8, 31)
        )
        monkeypatch.setattr(
            "app.services.booking_service.is_same_day_booking_closed",
            lambda *args, **kwargs: False,
        )

    async def test_create_booking_card_payment(self, client, hotel_with_rooms):
        """Card booking creates a payment intent and returns client_secret."""
        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]
        await create_test_payment_settings(
            str(hotel["id"]),
            stripe_connect_account_id="acct_test_card",
            stripe_connect_onboarded=True,
        )

        with patch(
            "app.services.stripe_service.create_payment_intent", new_callable=AsyncMock
        ) as mock_pi:
            mock_pi.return_value = {
                "id": "pi_test_card",
                "client_secret": "pi_test_card_secret_xyz",
                "status": "requires_payment_method",
            }

            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings",
                json={
                    "roomTypeId": str(room["id"]),
                    "guestFirstName": "Alice",
                    "guestLastName": "Tester",
                    "guestEmail": "alice@test.com",
                    "guestPhone": "+1234567890",
                    "checkIn": "2026-09-01",
                    "checkOut": "2026-09-04",
                    "adults": 2,
                    "children": 0,
                    "paymentMethod": "card",
                },
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["paymentMethod"] == "card"
        assert body["clientSecret"] == "pi_test_card_secret_xyz"
        # VAY-388: card flow returns a draft preview, not a real booking row.
        assert body["booking"]["status"] == "draft"
        assert body["booking"]["guestFirstName"] == "Alice"
        assert body["booking"]["totalAmount"] == 450.0  # 150 * 3 nights
        assert body["draftId"]
        mock_pi.assert_called_once()
        assert mock_pi.call_args.kwargs["amount"] == 45000

    async def test_create_booking_card_deposit_charges_deposit_amount(
        self, client, cleanup_database
    ):
        """Card deposit rates create the PaymentIntent for the deposit only."""
        import json as _json

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(
            str(hotel["id"]),
            stripe_connect_account_id="acct_test_deposit",
            stripe_connect_onboarded=True,
        )
        await Database.execute(
            "UPDATE room_types SET rate_deposit_settings = $1::jsonb WHERE id = $2",
            _json.dumps({"flexible": {"enabled": True, "percentage": 50}}),
            str(room["id"]),
        )

        with patch(
            "app.services.stripe_service.create_payment_intent", new_callable=AsyncMock
        ) as mock_pi:
            mock_pi.return_value = {
                "id": "pi_test_deposit",
                "client_secret": "pi_test_deposit_secret",
                "status": "requires_payment_method",
            }

            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings",
                json={
                    "roomTypeId": str(room["id"]),
                    "guestFirstName": "Dana",
                    "guestLastName": "Deposit",
                    "guestEmail": "dana@test.com",
                    "guestPhone": "+1234567890",
                    "checkIn": "2026-09-01",
                    "checkOut": "2026-09-05",
                    "adults": 2,
                    "paymentMethod": "card",
                    "rateType": "flexible",
                },
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["booking"]["totalAmount"] == 600.0
        assert body["booking"]["depositRequired"] is True
        assert body["booking"]["depositPercentage"] == 50
        assert body["booking"]["depositAmount"] == 300.0
        assert body["booking"]["balanceAmount"] == 300.0
        assert mock_pi.call_args.kwargs["amount"] == 30000
        assert mock_pi.call_args.kwargs["capture_method"] == "automatic"

    async def test_create_booking_manual_deposit_records_deposit_payment(
        self, client, cleanup_database
    ):
        """Manual deposit rates create a pending payment for the deposit only."""
        import json as _json

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]))
        await Database.execute(
            "UPDATE hotel_payment_settings SET bank_transfer = true WHERE hotel_id = $1",
            str(hotel["id"]),
        )
        await Database.execute(
            "UPDATE room_types SET rate_deposit_settings = $1::jsonb WHERE id = $2",
            _json.dumps({"flexible": {"enabled": True, "percentage": 50}}),
            str(room["id"]),
        )

        bank_info = {
            "payout_account_holder": "Test Hotel GmbH",
            "payout_account_type": "iban",
            "payout_iban": "DE89370400440532013000",
            "payout_account_number": "",
            "payout_bank_name": "Test Bank",
            "payout_swift": "TESTDEF0",
        }

        with (
            patch(
                "app.services.booking_service.hotel_identity_service.get_payment_flags_by_slug",
                new_callable=AsyncMock,
                return_value={"bank_transfer": True, "pay_at_property_enabled": False},
            ),
            patch(
                "app.services.booking_service.hotel_identity_service.get_guest_payment_info_by_slug",
                new_callable=AsyncMock,
                return_value=bank_info,
            ),
        ):
            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings",
                json={
                    "roomTypeId": str(room["id"]),
                    "guestFirstName": "Manny",
                    "guestLastName": "Manual",
                    "guestEmail": "manny@test.com",
                    "guestPhone": "+1234567890",
                    "checkIn": "2026-09-01",
                    "checkOut": "2026-09-05",
                    "adults": 2,
                    "paymentMethod": "bank_transfer",
                    "rateType": "flexible",
                },
            )

        assert resp.status_code == 200
        booking = resp.json()["booking"]
        assert booking["depositRequired"] is True
        assert booking["depositAmount"] == 300.0
        assert booking["balanceAmount"] == 300.0

        payment = await Database.fetchrow(
            "SELECT amount, payment_method, payment_purpose, status FROM payments WHERE booking_id = $1",
            booking["id"],
        )
        assert float(payment["amount"]) == 300.0
        assert payment["payment_method"] == "bank_transfer"
        assert payment["payment_purpose"] == "deposit"
        assert payment["status"] == "pending"

    async def test_create_booking_deposit_rejects_pay_at_property(self, client, cleanup_database):
        """A deposit-required rate cannot be booked with pay-at-property."""
        import json as _json

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        await Database.execute(
            "UPDATE room_types SET rate_deposit_settings = $1::jsonb WHERE id = $2",
            _json.dumps({"flexible": {"enabled": True, "percentage": 50}}),
            str(room["id"]),
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Pat",
                "guestLastName": "Property",
                "guestEmail": "pat@test.com",
                "guestPhone": "+1234567890",
                "checkIn": "2026-09-01",
                "checkOut": "2026-09-05",
                "adults": 2,
                "paymentMethod": "pay_at_property",
                "rateType": "flexible",
            },
        )

        assert resp.status_code == 400
        assert "requires a deposit" in resp.json()["detail"].lower()

    async def test_create_booking_pay_at_property(self, client, cleanup_database):
        """Pay-at-property booking requires the setting to be enabled."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Bob",
                "guestLastName": "Property",
                "guestEmail": "bob@test.com",
                "guestPhone": "+9876543210",
                "checkIn": "2026-09-10",
                "checkOut": "2026-09-12",
                "adults": 1,
                "paymentMethod": "pay_at_property",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["paymentMethod"] == "pay_at_property"
        assert body["clientSecret"] is None
        assert body["booking"]["status"] == "pending"

    async def test_booking_quote_matches_created_booking_total(
        self, client, hotel_with_rooms, monkeypatch
    ):
        """VAY-927: payment-step quote and stored booking total use one source."""
        import json as _json

        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        await Database.execute(
            """
            UPDATE hotels
               SET last_minute_discount = $1::jsonb,
                   timezone = 'UTC'
             WHERE id = $2
            """,
            _json.dumps(
                {
                    "enabled": True,
                    "stackWithPromo": False,
                    "tiers": [
                        {"daysBeforeMin": 0, "daysBeforeMax": 7, "discountPercent": 4},
                    ],
                }
            ),
            str(hotel["id"]),
        )
        await Database.execute(
            """
            UPDATE room_types
               SET base_rate = 585000,
                   currency = 'IDR',
                   non_refundable_enabled = true,
                   non_refundable_discount = 15
             WHERE id = $1
            """,
            str(room["id"]),
        )
        monkeypatch.setattr(
            "app.services.booking_service.property_today",
            lambda timezone: date(2026, 6, 28),
        )

        payload = {
            "roomTypeId": str(room["id"]),
            "guestFirstName": "Quote",
            "guestLastName": "Match",
            "guestEmail": "quote-match@test.com",
            "guestPhone": "+1234567890",
            "checkIn": "2026-07-01",
            "checkOut": "2026-07-02",
            "adults": 2,
            "children": 0,
            "paymentMethod": "pay_at_property",
            "rateType": "flexible",
        }

        quote_resp = await client.post(f"/api/hotels/{hotel['slug']}/bookings/quote", json=payload)
        assert quote_resp.status_code == 200, quote_resp.text
        quote = quote_resp.json()
        assert quote["currency"] == "IDR"
        assert quote["roomTotal"] == 561600
        assert quote["totalAmount"] == 561600

        create_resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={**payload, "expectedTotalAmount": quote["totalAmount"]},
        )
        assert create_resp.status_code == 200, create_resp.text
        booking = create_resp.json()["booking"]
        assert booking["paymentMethod"] == "pay_at_property"
        assert booking["totalAmount"] == quote["totalAmount"]

        row = await Database.fetchrow(
            "SELECT total_amount, payment_method FROM bookings WHERE id = $1",
            booking["id"],
        )
        assert float(row["total_amount"]) == quote["totalAmount"]
        assert row["payment_method"] == "pay_at_property"

    async def test_booking_create_rejects_stale_expected_total(
        self, client, hotel_with_rooms, monkeypatch
    ):
        """VAY-927: never silently snapshot a total different from checkout."""
        import json as _json

        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        await Database.execute(
            "UPDATE hotels SET last_minute_discount = $1::jsonb, timezone = 'UTC' WHERE id = $2",
            _json.dumps(
                {
                    "enabled": True,
                    "tiers": [
                        {"daysBeforeMin": 0, "daysBeforeMax": 7, "discountPercent": 4},
                    ],
                }
            ),
            str(hotel["id"]),
        )
        await Database.execute(
            "UPDATE room_types SET base_rate = 585000, currency = 'IDR' WHERE id = $1",
            str(room["id"]),
        )
        monkeypatch.setattr(
            "app.services.booking_service.property_today",
            lambda timezone: date(2026, 6, 28),
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Stale",
                "guestLastName": "Quote",
                "guestEmail": "stale-quote@test.com",
                "guestPhone": "+1234567890",
                "checkIn": "2026-07-01",
                "checkOut": "2026-07-02",
                "adults": 2,
                "children": 0,
                "paymentMethod": "pay_at_property",
                "rateType": "flexible",
                "expectedTotalAmount": 497250,
            },
        )

        assert resp.status_code == 400
        assert "booking total changed" in resp.json()["detail"].lower()
        count = await Database.fetchval(
            "SELECT COUNT(*) FROM bookings WHERE guest_email = $1",
            "stale-quote@test.com",
        )
        assert count == 0

    async def test_booking_rejected_when_method_not_allowed_for_rate(
        self, client, cleanup_database
    ):
        """Rate-level rate_payment_methods list must gate booking creation."""
        import json as _json

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        # Flexible rate allows only card + bank_transfer — NOT pay_at_property
        await Database.execute(
            "UPDATE room_types SET rate_payment_methods = $1::jsonb WHERE id = $2",
            _json.dumps({"flexible": ["card", "bank_transfer"]}),
            str(room["id"]),
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Alice",
                "guestLastName": "Tester",
                "guestEmail": "alice@test.com",
                "guestPhone": "+1234567890",
                "checkIn": "2026-09-01",
                "checkOut": "2026-09-04",
                "adults": 2,
                "paymentMethod": "pay_at_property",
                "rateType": "flexible",
            },
        )
        assert resp.status_code == 400
        assert "not allowed" in resp.json()["detail"].lower()

    async def test_booking_allowed_when_method_in_rate_list(self, client, cleanup_database):
        """An allowed method for the selected rate should go through."""
        import json as _json

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        await Database.execute(
            "UPDATE room_types SET rate_payment_methods = $1::jsonb WHERE id = $2",
            _json.dumps({"flexible": ["card", "pay_at_property"]}),
            str(room["id"]),
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Bob",
                "guestLastName": "Tester",
                "guestEmail": "bob@test.com",
                "guestPhone": "+9876543210",
                "checkIn": "2026-09-10",
                "checkOut": "2026-09-12",
                "adults": 1,
                "paymentMethod": "pay_at_property",
                "rateType": "flexible",
            },
        )
        assert resp.status_code == 200
        assert resp.json()["paymentMethod"] == "pay_at_property"

    async def test_booking_null_rate_methods_uses_hotel_defaults(self, client, cleanup_database):
        """When rate_payment_methods is NULL, hotel-level flags govern — legacy behavior."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        # No rate_payment_methods set — should fall through to hotel defaults.

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Cat",
                "guestLastName": "Tester",
                "guestEmail": "cat@test.com",
                "guestPhone": "+111",
                "checkIn": "2026-09-20",
                "checkOut": "2026-09-22",
                "adults": 1,
                "paymentMethod": "pay_at_property",
            },
        )
        assert resp.status_code == 200

    async def test_card_booking_rejected_when_stripe_not_onboarded(self, client, cleanup_database):
        """Card booking must fail loudly (not silently fall back to pay-at-property)
        when the hotel hasn't finished Stripe Connect onboarding.
        """
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        # Pay-at-property enabled AND online card toggled on, but Connect
        # onboarding never finished — the old code would silently switch to
        # pay-at-property, which is exactly Bug 1.
        await create_test_payment_settings(
            str(hotel["id"]),
            pay_at_property_enabled=True,
            stripe_connect_account_id=None,
            stripe_connect_onboarded=False,
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Alice",
                "guestLastName": "Tester",
                "guestEmail": "alice@test.com",
                "guestPhone": "+1234567890",
                "checkIn": "2026-09-01",
                "checkOut": "2026-09-04",
                "adults": 2,
                "paymentMethod": "card",
            },
        )
        assert resp.status_code == 400

    async def test_pay_at_property_rejected_when_disabled(self, client, hotel_with_rooms):
        """Pay-at-property fails if not enabled for the hotel."""
        hotel = hotel_with_rooms["hotel"]
        room = hotel_with_rooms["room"]

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Fail",
                "guestLastName": "Test",
                "guestEmail": "fail@test.com",
                "guestPhone": "+111",
                "checkIn": "2026-09-10",
                "checkOut": "2026-09-12",
                "adults": 1,
                "paymentMethod": "pay_at_property",
            },
        )
        assert resp.status_code == 400

    async def test_bank_transfer_uses_booking_engine_flags_when_pms_settings_lag(
        self, client, cleanup_database
    ):
        """Booking creation must validate Bank Transfer against the same
        Booking Engine source that checkout uses to render the option."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=False)

        bank_info = {
            "pay_at_hotel_methods": '["cash"]',
            "payout_account_holder": "Hotel Sunshine GmbH",
            "payout_account_type": "iban",
            "payout_iban": "DE89370400440532013000",
            "payout_account_number": "",
            "payout_bank_name": "Vayada Bank",
            "payout_swift": "VAYADEF0",
            "terms_text": "",
            "cancellation_policy_text": "",
        }

        with (
            patch(
                "app.services.booking_service.hotel_identity_service.get_payment_flags_by_slug",
                new_callable=AsyncMock,
            ) as mock_flags,
            patch(
                "app.services.booking_service.hotel_identity_service.get_guest_payment_info_by_slug",
                new_callable=AsyncMock,
            ) as mock_info,
        ):
            mock_flags.return_value = {
                "pay_at_property_enabled": False,
                "online_card_payment": False,
                "bank_transfer": True,
            }
            mock_info.return_value = bank_info
            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings",
                json={
                    "roomTypeId": str(room["id"]),
                    "guestFirstName": "Berta",
                    "guestLastName": "Transfer",
                    "guestEmail": "berta@test.com",
                    "guestPhone": "+491234",
                    "checkIn": "2026-09-10",
                    "checkOut": "2026-09-12",
                    "adults": 1,
                    "paymentMethod": "bank_transfer",
                },
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["paymentMethod"] == "bank_transfer"
        assert body["clientSecret"] is None
        assert body["booking"]["status"] == "pending"
        assert body["booking"]["paymentStatus"] == "awaiting_transfer"

    async def test_bank_transfer_rejected_when_booking_engine_details_incomplete(
        self, client, cleanup_database
    ):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=False)

        with (
            patch(
                "app.services.booking_service.hotel_identity_service.get_payment_flags_by_slug",
                new_callable=AsyncMock,
            ) as mock_flags,
            patch(
                "app.services.booking_service.hotel_identity_service.get_guest_payment_info_by_slug",
                new_callable=AsyncMock,
            ) as mock_info,
        ):
            mock_flags.return_value = {
                "pay_at_property_enabled": False,
                "online_card_payment": False,
                "bank_transfer": True,
            }
            mock_info.return_value = {
                "payout_account_holder": "Hotel Sunshine GmbH",
                "payout_account_type": "iban",
                "payout_iban": "",
                "payout_account_number": "",
                "payout_bank_name": "Vayada Bank",
                "payout_swift": "VAYADEF0",
            }
            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings",
                json={
                    "roomTypeId": str(room["id"]),
                    "guestFirstName": "Berta",
                    "guestLastName": "Transfer",
                    "guestEmail": "berta2@test.com",
                    "guestPhone": "+491234",
                    "checkIn": "2026-10-10",
                    "checkOut": "2026-10-12",
                    "adults": 1,
                    "paymentMethod": "bank_transfer",
                },
            )

        assert resp.status_code == 400
        assert "details are incomplete" in resp.json()["detail"]

    async def test_payment_settings_hide_bank_transfer_without_complete_details(
        self, client, hotel_with_rooms
    ):
        hotel = hotel_with_rooms["hotel"]

        with (
            patch(
                "app.routers.bookings.hotel_identity_service.get_payment_flags_by_slug",
                new_callable=AsyncMock,
            ) as mock_flags,
            patch(
                "app.routers.bookings.hotel_identity_service.get_guest_payment_info_by_slug",
                new_callable=AsyncMock,
            ) as mock_info,
        ):
            mock_flags.return_value = {
                "pay_at_property_enabled": False,
                "online_card_payment": False,
                "bank_transfer": True,
            }
            mock_info.return_value = {
                "pay_at_hotel_methods": '["cash"]',
                "payout_account_holder": "Hotel Sunshine GmbH",
                "payout_account_type": "iban",
                "payout_iban": "",
                "payout_account_number": "",
                "payout_bank_name": "Vayada Bank",
                "payout_swift": "VAYADEF0",
                "terms_text": "",
                "cancellation_policy_text": "",
            }
            resp = await client.get(f"/api/hotels/{hotel['slug']}/payment-settings")

        assert resp.status_code == 200
        body = resp.json()
        assert body["bankTransfer"] is False
        assert "bankDetails" not in body


# ── Confirm Authorization ────────────────────────────────────────


class TestConfirmAuthorization:
    """Tests for POST /api/hotels/{slug}/bookings/{id}/confirm-authorization."""

    async def test_confirm_authorization(self, client, cleanup_database):
        """Confirming authorization on a legacy booking-id handle updates
        payment status (back-compat path; VAY-388 normally goes through
        the draft id)."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            payment_method="card",
            payment_status="unpaid",
        )

        # Insert a payment record
        await Database.execute(
            """INSERT INTO payments (booking_id, amount, currency, payment_method, stripe_payment_intent_id, status)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            str(booking["id"]),
            600.0,
            "EUR",
            "card",
            "pi_test_auth",
            "pending",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/confirm-authorization"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["paymentStatus"] == "authorized"
        assert body["bookingReference"] == booking["booking_reference"]

    async def test_confirm_authorization_non_pending(self, client, cleanup_database):
        """Cannot confirm authorization on non-pending booking."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            status="confirmed",
            payment_status="captured",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/confirm-authorization"
        )
        assert resp.status_code == 400


# ── Card-payment soft-hold draft (VAY-388) ──────────────────────


class TestCardPaymentDraft:
    """The card-payment flow defers the booking row + inventory commit
    until Stripe authorizes the card. The intermediate state is a
    booking_drafts row that holds inventory for ~15 min."""

    async def _create_card_draft(self, client, hotel, room, pi_id="pi_draft_test"):
        await create_test_payment_settings(
            str(hotel["id"]),
            stripe_connect_account_id="acct_draft",
            stripe_connect_onboarded=True,
        )
        with patch(
            "app.services.stripe_service.create_payment_intent",
            new_callable=AsyncMock,
        ) as mock_pi:
            mock_pi.return_value = {
                "id": pi_id,
                "client_secret": f"{pi_id}_secret",
                "status": "requires_payment_method",
            }
            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings",
                json={
                    "roomTypeId": str(room["id"]),
                    "guestFirstName": "Draft",
                    "guestLastName": "Tester",
                    "guestEmail": "draft@test.com",
                    "guestPhone": "+1",
                    "checkIn": "2026-10-01",
                    "checkOut": "2026-10-04",
                    "adults": 2,
                    "paymentMethod": "card",
                },
            )
        assert resp.status_code == 200, resp.text
        return resp.json()

    async def test_card_request_creates_draft_not_booking(self, client, hotel_with_rooms):
        """No booking row should exist at the end of POST /bookings — only
        a draft. Inventory comes from the soft hold, not a pending row."""
        body = await self._create_card_draft(
            client, hotel_with_rooms["hotel"], hotel_with_rooms["room"]
        )
        assert body["draftId"]
        assert body["bookingReference"].startswith("VAY-")

        rows = await Database.fetch(
            "SELECT id FROM bookings WHERE hotel_id = $1",
            str(hotel_with_rooms["hotel"]["id"]),
        )
        assert rows == []

        draft = await Database.fetchrow(
            "SELECT * FROM booking_drafts WHERE id = $1", body["draftId"]
        )
        assert draft is not None
        assert draft["stripe_payment_intent_id"] == "pi_draft_test"
        assert draft["expires_at"] > datetime.now(UTC)

    async def test_draft_holds_inventory(self, client, cleanup_database):
        """A second guest can't book the same date range while a draft is
        live — the draft counts against availability."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=1)
        # First guest holds the only room via a draft.
        await self._create_card_draft(client, hotel, room, pi_id="pi_first")

        # Second guest tries to book — the draft must block them.
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Second",
                "guestLastName": "Guest",
                "guestEmail": "second@test.com",
                "guestPhone": "+2",
                "checkIn": "2026-10-02",
                "checkOut": "2026-10-03",
                "adults": 1,
                "paymentMethod": "pay_at_property",
            },
        )
        assert resp.status_code == 400
        assert "available" in resp.json()["detail"].lower()

    async def test_expired_draft_releases_inventory(self, client, cleanup_database):
        """Once a draft's TTL elapses, count_active_for_stay drops it and
        a fresh guest can book the same room."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]), total_rooms=1)
        body = await self._create_card_draft(client, hotel, room, pi_id="pi_expire")

        # Force-expire the draft (no time machine in tests).
        await Database.execute(
            "UPDATE booking_drafts SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
            body["draftId"],
        )

        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings",
            json={
                "roomTypeId": str(room["id"]),
                "guestFirstName": "Late",
                "guestLastName": "Guest",
                "guestEmail": "late@test.com",
                "guestPhone": "+3",
                "checkIn": "2026-10-02",
                "checkOut": "2026-10-03",
                "adults": 1,
                "paymentMethod": "pay_at_property",
            },
        )
        assert resp.status_code == 200, resp.text

    @patch(
        "app.services.email_service.send_booking_request_notification",
        new_callable=AsyncMock,
    )
    @patch(
        "app.services.email_service.send_guest_booking_requested",
        new_callable=AsyncMock,
    )
    @patch(
        "app.services.channex.ari_push.push_availability_for_room_type",
        new_callable=AsyncMock,
    )
    @patch(
        "app.services.stripe_service.retrieve_payment_intent",
        new_callable=AsyncMock,
    )
    async def test_confirm_authorization_materializes_draft(
        self,
        mock_retrieve_pi,
        mock_channex,
        mock_guest_email,
        mock_host_email,
        client,
        hotel_with_rooms,
    ):
        """POST /confirm-authorization with a draft id materializes the
        booking row + payment row, returns a booking-shaped envelope, and
        is idempotent on a second call."""
        body = await self._create_card_draft(
            client,
            hotel_with_rooms["hotel"],
            hotel_with_rooms["room"],
            pi_id="pi_materialize",
        )
        draft_id = body["draftId"]
        mock_retrieve_pi.return_value = {
            "id": "pi_materialize",
            "status": "requires_capture",
            "capture_method": "manual",
        }

        resp = await client.post(
            f"/api/hotels/{hotel_with_rooms['hotel']['slug']}/bookings/{draft_id}/confirm-authorization"
        )
        assert resp.status_code == 200, resp.text
        booking = resp.json()
        assert booking["bookingReference"] == body["bookingReference"]
        assert booking["paymentStatus"] == "authorized"
        assert booking["status"] == "pending"

        # The draft row is kept as the materialization link so a second
        # confirm-authorization call (or a racing webhook) can resolve
        # back to the same booking. materialized_booking_id points to it.
        booking_row = await Database.fetchrow(
            "SELECT * FROM bookings WHERE booking_reference = $1",
            body["bookingReference"],
        )
        assert booking_row is not None
        assert booking_row["payment_status"] == "authorized"
        draft_row = await Database.fetchrow(
            "SELECT id, materialized_booking_id FROM booking_drafts WHERE id = $1",
            draft_id,
        )
        assert draft_row is not None
        assert draft_row["materialized_booking_id"] == booking_row["id"]
        payment_row = await Database.fetchrow(
            "SELECT * FROM payments WHERE stripe_payment_intent_id = $1",
            "pi_materialize",
        )
        assert payment_row is not None
        assert payment_row["status"] == "authorized"

        # Idempotency: second call returns the same booking instead of a
        # 400/duplicate insert (e.g. webhook retry races confirm-auth).
        second = await client.post(
            f"/api/hotels/{hotel_with_rooms['hotel']['slug']}/bookings/{draft_id}/confirm-authorization"
        )
        assert second.status_code == 200, second.text
        assert second.json()["bookingReference"] == body["bookingReference"]

    @patch(
        "app.services.email_service.send_booking_request_notification",
        new_callable=AsyncMock,
    )
    @patch(
        "app.services.email_service.send_guest_booking_requested",
        new_callable=AsyncMock,
    )
    @patch(
        "app.services.channex.ari_push.push_availability_for_room_type",
        new_callable=AsyncMock,
    )
    async def test_webhook_materializes_draft(
        self,
        mock_channex,
        mock_guest_email,
        mock_host_email,
        client,
        hotel_with_rooms,
    ):
        """The Stripe `payment_intent.amount_capturable_updated` webhook
        materializes the draft when it fires before the frontend's
        confirm-authorization call."""
        body = await self._create_card_draft(
            client,
            hotel_with_rooms["hotel"],
            hotel_with_rooms["room"],
            pi_id="pi_webhook_materialize",
        )

        with patch("app.services.stripe_service.construct_webhook_event") as mock_construct:
            mock_construct.return_value = {
                "type": "payment_intent.amount_capturable_updated",
                "data": {"object": {"id": "pi_webhook_materialize"}},
            }
            resp = await client.post(
                "/webhooks/stripe",
                content=b"{}",
                headers={"stripe-signature": "test"},
            )
        assert resp.status_code == 200

        booking_row = await Database.fetchrow(
            "SELECT * FROM bookings WHERE booking_reference = $1",
            body["bookingReference"],
        )
        assert booking_row is not None
        assert booking_row["payment_status"] == "authorized"
        draft_row = await Database.fetchrow(
            "SELECT id, materialized_booking_id FROM booking_drafts WHERE id = $1",
            body["draftId"],
        )
        assert draft_row is not None
        assert draft_row["materialized_booking_id"] == booking_row["id"]

    async def test_webhook_payment_failed_keeps_retryable_draft(self, client, hotel_with_rooms):
        """A failed payment-method attempt keeps the same checkout retryable."""
        body = await self._create_card_draft(
            client,
            hotel_with_rooms["hotel"],
            hotel_with_rooms["room"],
            pi_id="pi_failed",
        )

        with patch("app.services.stripe_service.construct_webhook_event") as mock_construct:
            mock_construct.return_value = {
                "type": "payment_intent.payment_failed",
                "data": {"object": {"id": "pi_failed"}},
            }
            resp = await client.post(
                "/webhooks/stripe",
                content=b"{}",
                headers={"stripe-signature": "test"},
            )
        assert resp.status_code == 200

        draft_row = await Database.fetchrow(
            "SELECT id FROM booking_drafts WHERE id = $1", body["draftId"]
        )
        assert draft_row is not None
        booking_count = await Database.fetchval(
            "SELECT COUNT(*) FROM bookings WHERE hotel_id = $1",
            str(hotel_with_rooms["hotel"]["id"]),
        )
        assert booking_count == 0


# ── Host Accept/Reject (Admin) ──────────────────────────────────


class TestHostAcceptReject:
    """Tests for POST /admin/bookings/{id}/accept and /reject."""

    async def test_host_accept_captures_payment(self, client, cleanup_database):
        """Accepting a booking captures the Stripe payment."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            payment_method="card",
            payment_status="authorized",
        )
        await Database.execute(
            """INSERT INTO payments (booking_id, amount, currency, payment_method, stripe_payment_intent_id, status)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            str(booking["id"]),
            600.0,
            "EUR",
            "card",
            "pi_test_capture",
            "authorized",
        )

        with patch(
            "app.services.stripe_service.capture_payment_intent", new_callable=AsyncMock
        ) as mock_capture:
            mock_capture.return_value = {"id": "pi_test_capture", "status": "succeeded"}

            resp = await client.post(
                f"/admin/bookings/{booking['id']}/accept",
                headers=get_auth_headers(user["token"]),
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "confirmed"
        assert body["paymentStatus"] == "captured"
        assert body["platformFeeAmount"] is not None
        assert body["propertyPayoutAmount"] is not None
        mock_capture.assert_called_once_with(
            "pi_test_capture",
            idempotency_key=f"booking-capture-{booking['id']}",
        )

    async def test_host_accept_pay_at_property(self, client, cleanup_database):
        """Accepting a pay-at-property booking just confirms it."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            payment_method="pay_at_property",
            payment_status="pay_at_property",
        )

        resp = await client.post(
            f"/admin/bookings/{booking['id']}/accept",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "confirmed"

    async def test_host_reject_releases_hold(self, client, cleanup_database):
        """Rejecting a booking cancels the Stripe payment intent."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            payment_method="card",
            payment_status="authorized",
        )
        await Database.execute(
            """INSERT INTO payments (booking_id, amount, currency, payment_method, stripe_payment_intent_id, status)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            str(booking["id"]),
            600.0,
            "EUR",
            "card",
            "pi_test_reject",
            "authorized",
        )

        with patch(
            "app.services.stripe_service.cancel_payment_intent", new_callable=AsyncMock
        ) as mock_cancel:
            mock_cancel.return_value = {"id": "pi_test_reject", "status": "canceled"}

            resp = await client.post(
                f"/admin/bookings/{booking['id']}/reject",
                headers=get_auth_headers(user["token"]),
            )

        assert resp.status_code == 200
        body = resp.json()
        # VAY-404: host-rejected requests are now stored as 'declined' so the
        # UI can distinguish them from guest cancellations.
        assert body["status"] == "declined"
        mock_cancel.assert_called_once_with("pi_test_reject")

    async def test_accept_non_pending_fails(self, client, cleanup_database):
        """Cannot accept a booking that's already confirmed."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            status="confirmed",
            payment_status="captured",
        )

        resp = await client.post(
            f"/admin/bookings/{booking['id']}/accept",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 400

    async def test_reject_requires_auth(self, client, cleanup_database):
        """Reject endpoint requires authentication."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
        )

        resp = await client.post(f"/admin/bookings/{booking['id']}/reject")
        assert resp.status_code == 401


# ── Guest Withdraw ───────────────────────────────────────────────


class TestGuestWithdraw:
    """Tests for POST /api/hotels/{slug}/bookings/{id}/withdraw."""

    async def test_guest_withdraw(self, client, cleanup_database):
        """Guest can withdraw a pending booking."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            payment_method="card",
            payment_status="authorized",
            guest_email="withdraw@test.com",
        )
        await Database.execute(
            """INSERT INTO payments (booking_id, amount, currency, payment_method, stripe_payment_intent_id, status)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            str(booking["id"]),
            600.0,
            "EUR",
            "card",
            "pi_test_withdraw",
            "authorized",
        )

        with patch(
            "app.services.stripe_service.cancel_payment_intent", new_callable=AsyncMock
        ) as mock_cancel:
            mock_cancel.return_value = {"id": "pi_test_withdraw", "status": "canceled"}

            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/withdraw",
                json={"guest_email": "withdraw@test.com"},
            )

        assert resp.status_code == 200
        assert resp.json()["status"] == "withdrawn"
        mock_cancel.assert_called_once()

    async def test_withdraw_wrong_email(self, client, cleanup_database):
        """Cannot withdraw with wrong email."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            guest_email="correct@test.com",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/withdraw",
            json={"guest_email": "wrong@test.com"},
        )
        assert resp.status_code == 400

    async def test_withdraw_confirmed_booking_fails(self, client, cleanup_database):
        """Cannot withdraw a confirmed booking."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            status="confirmed",
            payment_status="captured",
            guest_email="guest@test.com",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/withdraw",
            json={"guest_email": "guest@test.com"},
        )
        assert resp.status_code == 400


# ── Guest Cancellation ───────────────────────────────────────────


class TestGuestCancellation:
    """Tests for POST /api/hotels/{slug}/bookings/{id}/cancel."""

    async def test_cancel_confirmed_booking_full_refund(self, client, cleanup_database):
        """Cancel far in advance triggers full refund."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=7)

        # Check-in far away (30 days) → full refund
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            check_in=(date.today() + timedelta(days=30)).isoformat(),
            check_out=(date.today() + timedelta(days=34)).isoformat(),
            status="confirmed",
            payment_method="card",
            payment_status="captured",
            guest_email="cancel@test.com",
        )
        await Database.execute(
            """INSERT INTO payments (booking_id, amount, currency, payment_method, stripe_payment_intent_id, status)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            str(booking["id"]),
            600.0,
            "EUR",
            "card",
            "pi_test_refund",
            "captured",
        )

        with patch(
            "app.services.stripe_service.create_refund", new_callable=AsyncMock
        ) as mock_refund:
            mock_refund.return_value = {"id": "re_test", "status": "succeeded", "amount": 60000}

            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel",
                json={"guest_email": "cancel@test.com"},
            )

        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"
        mock_refund.assert_called_once()

    async def test_cancel_card_deposit_inside_free_window_refunds_deposit(
        self, client, cleanup_database
    ):
        """Free cancellation on a deposit booking refunds the paid deposit."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=7)

        check_in = (date.today() + timedelta(days=14)).isoformat()
        check_out = (date.today() + timedelta(days=18)).isoformat()
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            check_in=check_in,
            check_out=check_out,
            status="confirmed",
            payment_method="card",
            payment_status="captured",
            guest_email="deposit-free@test.com",
        )
        await Database.execute(
            """
            UPDATE bookings
            SET deposit_required = true,
                deposit_percentage = 50,
                deposit_amount = 300,
                balance_amount = 300
            WHERE id = $1
            """,
            str(booking["id"]),
        )
        await Database.execute(
            """
            INSERT INTO payments (
                booking_id, amount, currency, payment_method,
                stripe_payment_intent_id, status, payment_purpose
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            str(booking["id"]),
            300.0,
            "EUR",
            "card",
            "pi_test_deposit_refund",
            "captured",
            "deposit",
        )

        with patch(
            "app.services.stripe_service.create_refund", new_callable=AsyncMock
        ) as mock_refund:
            mock_refund.return_value = {"id": "re_deposit", "status": "succeeded"}
            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel",
                json={"guest_email": "deposit-free@test.com"},
            )

        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"
        payment = await Database.fetchrow(
            "SELECT id, status, refund_amount FROM payments "
            "WHERE booking_id = $1 AND payment_purpose = 'deposit'",
            str(booking["id"]),
        )
        command_id = f"guest-cancellation-refund-{booking['id']}-full"
        mock_refund.assert_called_once_with(
            "pi_test_deposit_refund",
            amount=None,
            idempotency_key=command_id,
            metadata={
                "booking_id": str(booking["id"]),
                "payment_id": str(payment["id"]),
                "refund_command_id": command_id,
                "refund_amount_minor": "30000",
                "refund_currency": "eur",
            },
        )
        assert payment["status"] == "refunded"
        assert float(payment["refund_amount"]) == 300.0

    async def test_cancel_preview_deposit_retained_when_policy_penalty_lower(
        self, client, cleanup_database
    ):
        """Outside free cancellation, deposit is retained when it exceeds policy penalty."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_cancellation_policy(
            str(hotel["id"]), free_cancellation_days=7, partial_refund_pct=70
        )

        check_in = (date.today() + timedelta(days=1)).isoformat()
        check_out = (date.today() + timedelta(days=5)).isoformat()
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            check_in=check_in,
            check_out=check_out,
            status="confirmed",
            payment_method="card",
            payment_status="captured",
            guest_email="deposit-retain@test.com",
        )
        await Database.execute(
            """
            UPDATE bookings
            SET deposit_required = true,
                deposit_percentage = 50,
                deposit_amount = 300,
                balance_amount = 300
            WHERE id = $1
            """,
            str(booking["id"]),
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel-preview",
            json={"guest_email": "deposit-retain@test.com"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["refundAmount"] == 0
        assert body["policyPenalty"] == 180.0
        assert body["cancellationCharge"] == 300.0
        assert body["depositRetained"] == 300.0
        assert body["additionalAmountDue"] == 0

    async def test_cancel_preview_deposit_reports_extra_due_when_policy_penalty_higher(
        self, client, cleanup_database
    ):
        """If policy penalty exceeds the deposit, preview exposes the extra due."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_cancellation_policy(
            str(hotel["id"]), free_cancellation_days=7, partial_refund_pct=0
        )

        check_in = (date.today() + timedelta(days=1)).isoformat()
        check_out = (date.today() + timedelta(days=5)).isoformat()
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            check_in=check_in,
            check_out=check_out,
            status="confirmed",
            payment_method="card",
            payment_status="captured",
            guest_email="deposit-extra@test.com",
        )
        await Database.execute(
            """
            UPDATE bookings
            SET deposit_required = true,
                deposit_percentage = 50,
                deposit_amount = 300,
                balance_amount = 300
            WHERE id = $1
            """,
            str(booking["id"]),
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel-preview",
            json={"guest_email": "deposit-extra@test.com"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["policyPenalty"] == 600.0
        assert body["cancellationCharge"] == 600.0
        assert body["depositRetained"] == 300.0
        assert body["additionalAmountDue"] == 300.0

    async def test_cancel_pending_manual_deposit_does_not_refund(self, client, cleanup_database):
        """Pending manual deposits cancel without Stripe refund work."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_cancellation_policy(
            str(hotel["id"]), free_cancellation_days=7, partial_refund_pct=0
        )

        check_in = (date.today() + timedelta(days=1)).isoformat()
        check_out = (date.today() + timedelta(days=5)).isoformat()
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            check_in=check_in,
            check_out=check_out,
            status="confirmed",
            payment_method="bank_transfer",
            payment_status="awaiting_transfer",
            guest_email="manual-pending@test.com",
        )
        await Database.execute(
            """
            UPDATE bookings
            SET deposit_required = true,
                deposit_percentage = 50,
                deposit_amount = 300,
                balance_amount = 300
            WHERE id = $1
            """,
            str(booking["id"]),
        )

        with patch(
            "app.services.stripe_service.create_refund", new_callable=AsyncMock
        ) as mock_refund:
            resp = await client.post(
                f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel",
                json={"guest_email": "manual-pending@test.com"},
            )

        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"
        mock_refund.assert_not_called()
        updated = await Database.fetchrow(
            "SELECT payment_status FROM bookings WHERE id = $1", str(booking["id"])
        )
        assert updated["payment_status"] == "cancelled"

    async def test_cancel_pending_fails(self, client, cleanup_database):
        """Cannot cancel a pending booking (use withdraw instead)."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            guest_email="cancel@test.com",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel",
            json={"guest_email": "cancel@test.com"},
        )
        assert resp.status_code == 400

    async def test_cancel_preview_partial_refund_within_window(self, client, cleanup_database):
        """Room with partial-refund cancellation type returns the configured
        percentage when guest cancels at least N days before check-in."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await Database.execute(
            "UPDATE room_types SET flexible_cancellation_type = 'partial_refund', "
            "partial_refund_cancel_window_days = 30, partial_refund_amount_percent = 50 "
            "WHERE id = $1",
            str(room["id"]),
        )

        check_in = (date.today() + timedelta(days=35)).isoformat()
        check_out = (date.today() + timedelta(days=39)).isoformat()
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            check_in=check_in,
            check_out=check_out,
            status="confirmed",
            payment_method="card",
            payment_status="captured",
            guest_email="partial@test.com",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel-preview",
            json={"guest_email": "partial@test.com"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["refundPercentage"] == 50
        assert body["refundAmount"] == 300.0  # 50% of 4 nights × €150

    async def test_cancel_preview_partial_refund_after_window(self, client, cleanup_database):
        """Cancellation after the window returns 0 refund regardless of
        the hotel-wide free_cancellation_days policy."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=7)
        await Database.execute(
            "UPDATE room_types SET flexible_cancellation_type = 'partial_refund', "
            "partial_refund_cancel_window_days = 30, partial_refund_amount_percent = 50 "
            "WHERE id = $1",
            str(room["id"]),
        )

        check_in = (date.today() + timedelta(days=20)).isoformat()
        check_out = (date.today() + timedelta(days=24)).isoformat()
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            check_in=check_in,
            check_out=check_out,
            status="confirmed",
            payment_method="card",
            payment_status="captured",
            guest_email="partial@test.com",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel-preview",
            json={"guest_email": "partial@test.com"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["refundPercentage"] == 0
        assert body["refundAmount"] == 0

    async def test_cancel_preview_free_cancellation_unchanged(self, client, cleanup_database):
        """Default free-cancellation rooms still use the hotel-wide policy."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=7)

        check_in = (date.today() + timedelta(days=14)).isoformat()
        check_out = (date.today() + timedelta(days=18)).isoformat()
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            check_in=check_in,
            check_out=check_out,
            status="confirmed",
            payment_method="card",
            payment_status="captured",
            guest_email="free@test.com",
        )

        resp = await client.post(
            f"/api/hotels/{hotel['slug']}/bookings/{booking['id']}/cancel-preview",
            json={"guest_email": "free@test.com"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["refundPercentage"] == 100
        assert body["refundAmount"] == 600.0


# ── Booking Status Polling ───────────────────────────────────────


class TestBookingStatus:
    """Tests for GET /api/hotels/{slug}/bookings/status."""

    async def test_get_booking_status(self, client, cleanup_database):
        """Polling endpoint returns current status."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            guest_email="poll@test.com",
            payment_method="card",
            payment_status="authorized",
        )

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/bookings/status",
            params={
                "reference": booking["booking_reference"],
                "email": "poll@test.com",
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "pending"
        assert body["paymentStatus"] == "authorized"
        assert body["hostResponseDeadline"] is not None

    async def test_status_not_found(self, client, hotel_with_rooms):
        """Status endpoint returns 404 for unknown booking."""
        hotel = hotel_with_rooms["hotel"]

        resp = await client.get(
            f"/api/hotels/{hotel['slug']}/bookings/status",
            params={"reference": "VAY-NONEXIST", "email": "nobody@test.com"},
        )
        assert resp.status_code == 404


# ── Payment Settings (Public) ────────────────────────────────────


class TestPaymentSettingsPublic:
    """Tests for GET /api/hotels/{slug}/payment-settings."""

    async def test_payment_settings_defaults(self, client, hotel_with_rooms):
        """Returns defaults when no settings configured."""
        hotel = hotel_with_rooms["hotel"]

        resp = await client.get(f"/api/hotels/{hotel['slug']}/payment-settings")
        assert resp.status_code == 200
        body = resp.json()
        assert body["payAtPropertyEnabled"] is False
        assert body["freeCancellationDays"] == 7

    async def test_payment_settings_with_config(self, client, cleanup_database):
        """Returns configured values."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_payment_settings(str(hotel["id"]), pay_at_property_enabled=True)
        await create_test_cancellation_policy(str(hotel["id"]), free_cancellation_days=14)

        resp = await client.get(f"/api/hotels/{hotel['slug']}/payment-settings")
        assert resp.status_code == 200
        body = resp.json()
        assert body["payAtPropertyEnabled"] is True
        assert body["freeCancellationDays"] == 14

    async def test_payment_settings_unknown_hotel(self, client, init_database):
        resp = await client.get("/api/hotels/nonexistent-slug/payment-settings")
        assert resp.status_code == 404

    async def test_online_card_gated_when_stripe_not_onboarded(self, client, cleanup_database):
        """onlineCardPayment must be false if the hotel turned the flag on
        but never finished Stripe Connect onboarding — otherwise the guest
        sees a card form that can't actually charge.
        """
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await Database.execute(
            """INSERT INTO hotel_payment_settings
                 (hotel_id, online_card_payment, payment_provider,
                  stripe_connect_account_id, stripe_connect_onboarded)
               VALUES ($1, TRUE, 'stripe', NULL, FALSE)""",
            str(hotel["id"]),
        )

        resp = await client.get(f"/api/hotels/{hotel['slug']}/payment-settings")
        assert resp.status_code == 200
        assert resp.json()["onlineCardPayment"] is False

    async def test_online_card_exposed_when_stripe_onboarded(self, client, cleanup_database):
        """onlineCardPayment is true when Stripe Connect onboarding finished."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await Database.execute(
            """INSERT INTO hotel_payment_settings
                 (hotel_id, online_card_payment, payment_provider,
                  stripe_connect_account_id, stripe_connect_onboarded)
               VALUES ($1, TRUE, 'stripe', 'acct_test_onboarded', TRUE)""",
            str(hotel["id"]),
        )

        resp = await client.get(f"/api/hotels/{hotel['slug']}/payment-settings")
        assert resp.status_code == 200
        assert resp.json()["onlineCardPayment"] is True

    async def test_online_card_exposed_for_vayada_provider(self, client, cleanup_database):
        """vayada provider charges on the platform account — no Connect check needed."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await Database.execute(
            """INSERT INTO hotel_payment_settings
                 (hotel_id, online_card_payment, payment_provider,
                  stripe_connect_account_id, stripe_connect_onboarded)
               VALUES ($1, TRUE, 'vayada', NULL, FALSE)""",
            str(hotel["id"]),
        )

        resp = await client.get(f"/api/hotels/{hotel['slug']}/payment-settings")
        assert resp.status_code == 200
        assert resp.json()["onlineCardPayment"] is True


# ── Payment Settings (Admin) ─────────────────────────────────────


class TestPaymentSettingsAdmin:
    """Tests for GET/PATCH /admin/payment-settings."""

    async def test_get_payment_settings(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        await create_test_payment_settings(str(hotel["id"]))

        resp = await client.get(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        ps = body["paymentSettings"]
        assert ps["platformFeeType"] == "percentage"
        assert ps["platformFeeValue"] == 8.0
        cp = body["cancellationPolicy"]
        assert cp["freeCancellationDays"] == 7

    async def test_update_payment_settings(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        resp = await client.patch(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
            json={
                "platformFeeType": "flat",
                "platformFeeValue": 25.0,
                "payAtPropertyEnabled": True,
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "updated"

        # Verify via GET
        resp2 = await client.get(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
        )
        ps = resp2.json()["paymentSettings"]
        assert ps["platformFeeType"] == "flat"
        assert ps["platformFeeValue"] == 25.0
        assert ps["payAtPropertyEnabled"] is True

    async def test_payment_settings_requires_auth(self, client):
        resp = await client.get("/admin/payment-settings")
        assert resp.status_code == 401

    async def test_currency_change_converts_historical_bookings(self, client, cleanup_database):
        """VAY-335: changing the hotel display currency must re-denominate
        bookings (and their payments), not just relabel them. A USD booking
        of 145 must become ~Rp 2_320_000 — not Rp 145 — after switching to IDR.
        """
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        # Seed: USD booking with a captured payment.
        await Database.execute(
            """
            INSERT INTO bookings (
                hotel_id, room_type_id, booking_reference,
                guest_first_name, guest_last_name, guest_email, guest_phone,
                special_requests, check_in, check_out,
                adults, children, nightly_rate, total_amount, balance_amount, currency, status,
                addon_total, promo_discount, last_minute_discount_amount
            ) VALUES (
                $1, $2, 'VAY-USD145',
                'Alice', 'Tester', 'alice@test.com', '+1',
                '', '2026-06-01', '2026-06-02',
                1, 0, 145.00, 145.00, 145.00, 'USD', 'confirmed',
                0, 0, 0
            )
            """,
            str(hotel["id"]),
            str(room["id"]),
        )
        booking_id = await Database.fetchval(
            "SELECT id FROM bookings WHERE booking_reference = 'VAY-USD145'"
        )
        await Database.execute(
            """
            INSERT INTO payments (booking_id, amount, currency, payment_method, status)
            VALUES ($1, 145.00, 'USD', 'card', 'captured')
            """,
            booking_id,
        )

        # Patch the booking-engine currency lookup (USD before the change)
        # and the FX call so the test stays hermetic.
        with (
            patch(
                "app.routers.admin_payments._get_booking_engine_currency",
                new=AsyncMock(return_value="USD"),
            ),
            patch(
                "app.routers.admin_payments.get_exchange_rate",
                new=AsyncMock(return_value=16000.0),
            ),
        ):
            resp = await client.patch(
                "/admin/payment-settings",
                headers=get_auth_headers(user["token"]),
                json={"defaultCurrency": "IDR"},
            )

        assert resp.status_code == 200, resp.text

        bk_row = await Database.fetchrow(
            "SELECT total_amount, nightly_rate, currency FROM bookings WHERE id = $1",
            booking_id,
        )
        # IDR uses 0 decimals — 145 * 16000 = 2,320,000 (no fractional Rp).
        assert bk_row["currency"] == "IDR"
        assert float(bk_row["total_amount"]) == 2_320_000.0
        assert float(bk_row["nightly_rate"]) == 2_320_000.0

        pmt_row = await Database.fetchrow(
            "SELECT amount, currency FROM payments WHERE booking_id = $1",
            booking_id,
        )
        assert pmt_row["currency"] == "IDR"
        assert float(pmt_row["amount"]) == 2_320_000.0

    async def test_currency_change_skips_bookings_already_in_target(self, client, cleanup_database):
        """A booking whose currency already matches the new one is left
        untouched — no FX math, no spurious updates."""
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        await Database.execute(
            """
            INSERT INTO bookings (
                hotel_id, room_type_id, booking_reference,
                guest_first_name, guest_last_name, guest_email, guest_phone,
                special_requests, check_in, check_out,
                adults, children, nightly_rate, total_amount, balance_amount, currency, status
            ) VALUES (
                $1, $2, 'VAY-IDRSKIP',
                'Bob', 'Local', 'bob@test.com', '+1',
                '', '2026-06-01', '2026-06-02',
                1, 0, 1500000.00, 1500000.00, 1500000.00, 'IDR', 'confirmed'
            )
            """,
            str(hotel["id"]),
            str(room["id"]),
        )

        with (
            patch(
                "app.routers.admin_payments._get_booking_engine_currency",
                new=AsyncMock(return_value="USD"),
            ),
            patch(
                "app.routers.admin_payments.get_exchange_rate",
                new=AsyncMock(return_value=16000.0),
            ),
        ):
            resp = await client.patch(
                "/admin/payment-settings",
                headers=get_auth_headers(user["token"]),
                json={"defaultCurrency": "IDR"},
            )

        assert resp.status_code == 200, resp.text
        bk_row = await Database.fetchrow(
            "SELECT total_amount, currency FROM bookings WHERE booking_reference = 'VAY-IDRSKIP'"
        )
        # Untouched: same amount, same currency — not re-multiplied by 16000.
        assert bk_row["currency"] == "IDR"
        assert float(bk_row["total_amount"]) == 1_500_000.0


# ── Cancellation Policy (Admin) ──────────────────────────────────


class TestCancellationPolicyAdmin:
    """Tests for PATCH /admin/cancellation-policy."""

    async def test_update_cancellation_policy(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        resp = await client.patch(
            "/admin/cancellation-policy",
            headers=get_auth_headers(user["token"]),
            json={
                "freeCancellationDays": 14,
                "partialRefundPct": 50.0,
            },
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "updated"

        # Verify via GET
        resp2 = await client.get(
            "/admin/payment-settings",
            headers=get_auth_headers(user["token"]),
        )
        cp = resp2.json()["cancellationPolicy"]
        assert cp["freeCancellationDays"] == 14
        assert cp["partialRefundPct"] == 50.0


# ── Payouts (Admin) ──────────────────────────────────────────────


class TestPayoutsAdmin:
    """Tests for GET /admin/payouts."""

    async def test_list_payouts_empty(self, client, cleanup_database):
        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))

        resp = await client.get(
            "/admin/payouts",
            headers=get_auth_headers(user["token"]),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["payouts"] == []
        assert body["total"] == 0

    async def test_payouts_requires_auth(self, client):
        resp = await client.get("/admin/payouts")
        assert resp.status_code == 401


# ── Payout Service Unit Tests ────────────────────────────────────


class TestPayoutService:
    """Unit tests covering the plan × channel × affiliate fee matrix."""

    def _call(self, **overrides):
        from app.services.payout_service import calculate_split

        defaults = dict(
            total_amount=1000.0,
            plan="commission",
            channel="direct",
            booking_engine_fee_pct=2.0,
            channel_manager_fee_pct=3.0,
            affiliate_platform_fee_pct=2.0,
            has_affiliate=False,
            effective_affiliate_commission_pct=0.0,
        )
        defaults.update(overrides)
        return calculate_split(defaults.pop("total_amount"), **defaults)

    async def test_fixed_plan_direct_no_affiliate(self, init_database):
        result = self._call(plan="fixed")
        assert result == {
            "platform_fee": 0.0,
            "affiliate_commission": 0.0,
            "property_payout": 1000.0,
        }

    async def test_fixed_plan_ota_no_affiliate(self, init_database):
        result = self._call(plan="fixed", channel="booking_com")
        assert result == {
            "platform_fee": 0.0,
            "affiliate_commission": 0.0,
            "property_payout": 1000.0,
        }

    async def test_fixed_plan_direct_with_affiliate(self, init_database):
        result = self._call(
            plan="fixed",
            has_affiliate=True,
            effective_affiliate_commission_pct=5.0,
        )
        # 2% affiliate platform fee + 5% affiliate commission
        assert result == {
            "platform_fee": 20.0,
            "affiliate_commission": 50.0,
            "property_payout": 930.0,
        }

    async def test_commission_plan_direct_no_affiliate(self, init_database):
        result = self._call(plan="commission")
        assert result == {
            "platform_fee": 20.0,  # 2% BE fee
            "affiliate_commission": 0.0,
            "property_payout": 980.0,
        }

    async def test_commission_plan_ota_no_affiliate(self, init_database):
        result = self._call(plan="commission", channel="airbnb")
        assert result == {
            "platform_fee": 30.0,  # 3% channel-manager fee
            "affiliate_commission": 0.0,
            "property_payout": 970.0,
        }

    async def test_commission_plan_direct_with_affiliate(self, init_database):
        result = self._call(
            plan="commission",
            has_affiliate=True,
            effective_affiliate_commission_pct=5.0,
        )
        # 2% BE fee (affiliate fee doesn't stack on commission plan) + 5% commission
        assert result == {
            "platform_fee": 20.0,
            "affiliate_commission": 50.0,
            "property_payout": 930.0,
        }

    async def test_commission_plan_ota_with_affiliate(self, init_database):
        result = self._call(
            plan="commission",
            channel="booking_com",
            has_affiliate=True,
            effective_affiliate_commission_pct=5.0,
        )
        # 3% channel fee (affiliate fee doesn't stack on commission plan) + 5% commission
        assert result == {
            "platform_fee": 30.0,
            "affiliate_commission": 50.0,
            "property_payout": 920.0,
        }

    async def test_affiliate_commission_additive_not_capped(self, init_database):
        """High affiliate commission (10%) is paid in full, on top of the platform fee."""
        result = self._call(
            plan="commission",
            has_affiliate=True,
            effective_affiliate_commission_pct=10.0,
        )
        assert result == {
            "platform_fee": 20.0,  # 2% BE only; affiliate fee doesn't stack
            "affiliate_commission": 100.0,  # 10% of 1000, not clamped
            "property_payout": 880.0,
        }

    async def test_commission_plan_custom_direct_rate(self, init_database):
        """Property-configured 8% direct rate is honoured (regression for VAY-318)."""
        result = self._call(plan="commission", booking_engine_fee_pct=8.0)
        assert result == {
            "platform_fee": 80.0,
            "affiliate_commission": 0.0,
            "property_payout": 920.0,
        }

    async def test_commission_plan_zero_ota_rate(self, init_database):
        """Property-configured 0% OTA rate means no platform fee on channel bookings."""
        result = self._call(
            plan="commission",
            channel="booking_com",
            channel_manager_fee_pct=0.0,
        )
        assert result == {
            "platform_fee": 0.0,
            "affiliate_commission": 0.0,
            "property_payout": 1000.0,
        }

    async def test_empty_channel_falls_back_to_direct(self, init_database):
        """An empty channel falls back to the direct rate (VAY-318 spec)."""
        result = self._call(
            plan="commission",
            channel="",
            booking_engine_fee_pct=8.0,
            channel_manager_fee_pct=15.0,
        )
        # Should use the (lower) direct rate, not the OTA rate.
        assert result["platform_fee"] == 80.0


class TestFetchBillingConfig:
    """Tests for the cross-DB billing-config lookup that backs platform-fee calc.

    Regression for VAY-318: when the booking_hotels row is missing or the
    cross-DB lookup fails, we must NOT silently fall back to a non-zero
    percentage — that historically charged Fixed-plan hotels 2% on top of
    their monthly subscription and under-billed Commission-plan hotels with
    custom rates.
    """

    async def test_default_is_zero_fee(self, init_database):
        """The fallback config charges nothing — safe default for missing rows."""
        from app.services.payout_service import DEFAULT_BILLING_CONFIG

        assert DEFAULT_BILLING_CONFIG["booking_engine_fee_pct"] == 0.0
        assert DEFAULT_BILLING_CONFIG["channel_manager_fee_pct"] == 0.0
        assert DEFAULT_BILLING_CONFIG["affiliate_platform_fee_pct"] == 0.0

    async def test_no_booking_db_url_returns_defaults(self, init_database):
        """Test/dev path: no booking_db configured → defaults."""
        from app.services.payout_service import (
            DEFAULT_BILLING_CONFIG,
            fetch_billing_config,
        )

        with patch("app.services.payout_service.app_settings") as mock_settings:
            mock_settings.BOOKING_ENGINE_DATABASE_URL = ""
            result = await fetch_billing_config("any-hotel-id")

        assert result == DEFAULT_BILLING_CONFIG
        # Must be a copy — callers mutate the dict freely.
        assert result is not DEFAULT_BILLING_CONFIG

    async def test_missing_row_logs_error_and_returns_defaults(self, init_database):
        """A missing booking_hotels row is logged at error level (data-integrity issue)."""
        from app.services.payout_service import (
            DEFAULT_BILLING_CONFIG,
            fetch_billing_config,
        )

        with (
            patch("app.services.payout_service.app_settings") as mock_settings,
            patch(
                "app.services.payout_service.BookingEngineDatabase.fetchrow",
                new=AsyncMock(return_value=None),
            ),
            patch("app.services.payout_service.logger") as mock_logger,
        ):
            mock_settings.BOOKING_ENGINE_DATABASE_URL = "postgres://test"
            result = await fetch_billing_config("missing-hotel-id")

        assert result == DEFAULT_BILLING_CONFIG
        mock_logger.error.assert_called_once()
        assert "missing-hotel-id" in str(mock_logger.error.call_args)

    async def test_query_exception_logs_error_and_returns_defaults(self, init_database):
        """A cross-DB exception is logged at error level and falls back safely."""
        from app.services.payout_service import (
            DEFAULT_BILLING_CONFIG,
            fetch_billing_config,
        )

        with (
            patch("app.services.payout_service.app_settings") as mock_settings,
            patch(
                "app.services.payout_service.BookingEngineDatabase.fetchrow",
                new=AsyncMock(side_effect=RuntimeError("connection refused")),
            ),
            patch("app.services.payout_service.logger") as mock_logger,
        ):
            mock_settings.BOOKING_ENGINE_DATABASE_URL = "postgres://test"
            result = await fetch_billing_config("hotel-with-broken-conn")

        assert result == DEFAULT_BILLING_CONFIG
        mock_logger.error.assert_called_once()

    async def test_row_present_returns_configured_values(self, init_database):
        """A real row returns the per-hotel configured percentages and active plan."""
        from app.services.payout_service import fetch_billing_config

        row = {
            "billing_active_plan": "commission",
            "booking_engine_fee_pct": 8.00,
            "channel_manager_fee_pct": 0.00,
            "affiliate_platform_fee_pct": 2.00,
        }
        with (
            patch("app.services.payout_service.app_settings") as mock_settings,
            patch(
                "app.services.payout_service.BookingEngineDatabase.fetchrow",
                new=AsyncMock(return_value=row),
            ),
        ):
            mock_settings.BOOKING_ENGINE_DATABASE_URL = "postgres://test"
            result = await fetch_billing_config("hotel-id")

        assert result == {
            "active_plan": "commission",
            "booking_engine_fee_pct": 8.0,
            "channel_manager_fee_pct": 0.0,
            "affiliate_platform_fee_pct": 2.0,
        }


# ── Expire Booking (Scheduler) ──────────────────────────────────


class TestExpireBooking:
    """Tests for the booking expiry service function."""

    async def test_expire_pending_booking(self, cleanup_database):
        """Expired booking gets status=expired and hold released."""
        from app.services.booking_service import expire_booking

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))

        # Booking with deadline in the past
        expired_deadline = datetime.now(UTC) - timedelta(hours=1)
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            payment_method="card",
            payment_status="authorized",
            host_response_deadline=expired_deadline,
        )
        await Database.execute(
            """INSERT INTO payments (booking_id, amount, currency, payment_method, stripe_payment_intent_id, status)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            str(booking["id"]),
            600.0,
            "EUR",
            "card",
            "pi_test_expire",
            "authorized",
        )

        with patch(
            "app.services.stripe_service.cancel_payment_intent", new_callable=AsyncMock
        ) as mock_cancel:
            mock_cancel.return_value = {"id": "pi_test_expire", "status": "canceled"}
            await expire_booking(str(booking["id"]))

        # Verify booking is expired
        updated = await Database.fetchrow(
            "SELECT status, payment_status FROM bookings WHERE id = $1",
            booking["id"],
        )
        assert updated["status"] == "expired"
        assert updated["payment_status"] == "cancelled"
        mock_cancel.assert_called_once_with("pi_test_expire")

    async def test_expire_already_confirmed_noop(self, cleanup_database):
        """Expiring a confirmed booking is a no-op."""
        from app.services.booking_service import expire_booking

        user = await create_test_user()
        hotel = await create_test_hotel(str(user["id"]))
        room = await create_test_room_type(str(hotel["id"]))
        booking = await create_test_booking_with_payment(
            str(hotel["id"]),
            str(room["id"]),
            status="confirmed",
            payment_status="captured",
        )

        await expire_booking(str(booking["id"]))

        updated = await Database.fetchrow(
            "SELECT status FROM bookings WHERE id = $1", booking["id"]
        )
        assert updated["status"] == "confirmed"  # unchanged

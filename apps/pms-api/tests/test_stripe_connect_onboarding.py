from unittest.mock import AsyncMock

import pytest
from app.models.payment import StripeConnectAccountRequest
from app.routers import admin_payments


@pytest.mark.asyncio
async def test_retrieve_connect_account_returns_readiness_flags(monkeypatch):
    class FakeStripeAccount:
        id = "acct_ready"
        details_submitted = True
        charges_enabled = True
        payouts_enabled = True

    monkeypatch.setattr(
        admin_payments.stripe_service.stripe.Account,
        "retrieve",
        lambda account_id: FakeStripeAccount(),
    )

    result = await admin_payments.stripe_service.retrieve_connect_account("acct_ready")

    assert result == {
        "id": "acct_ready",
        "details_submitted": True,
        "charges_enabled": True,
        "payouts_enabled": True,
    }


@pytest.mark.asyncio
async def test_reconcile_stripe_connect_status_marks_completed_account(monkeypatch):
    retrieve_account = AsyncMock(
        return_value={
            "details_submitted": True,
            "charges_enabled": True,
            "payouts_enabled": True,
        }
    )
    upsert = AsyncMock()
    monkeypatch.setattr(
        admin_payments.stripe_service,
        "retrieve_connect_account",
        retrieve_account,
    )
    monkeypatch.setattr(admin_payments.HotelPaymentSettingsRepository, "upsert", upsert)

    result = await admin_payments._reconcile_stripe_connect_status(
        "hotel-1",
        {
            "stripe_connect_account_id": "acct_complete",
            "stripe_connect_onboarded": False,
        },
    )

    assert result["stripe_connect_onboarded"] is True
    retrieve_account.assert_awaited_once_with("acct_complete")
    upsert.assert_awaited_once_with(
        "hotel-1",
        {"stripe_connect_onboarded": True},
    )


@pytest.mark.asyncio
async def test_reconcile_stripe_connect_status_clears_disabled_account(monkeypatch):
    monkeypatch.setattr(
        admin_payments.stripe_service,
        "retrieve_connect_account",
        AsyncMock(
            return_value={
                "details_submitted": True,
                "charges_enabled": False,
                "payouts_enabled": True,
            }
        ),
    )
    upsert = AsyncMock()
    monkeypatch.setattr(admin_payments.HotelPaymentSettingsRepository, "upsert", upsert)

    result = await admin_payments._reconcile_stripe_connect_status(
        "hotel-1",
        {
            "stripe_connect_account_id": "acct_disabled",
            "stripe_connect_onboarded": True,
        },
    )

    assert result["stripe_connect_onboarded"] is False
    upsert.assert_awaited_once_with(
        "hotel-1",
        {"stripe_connect_onboarded": False},
    )


@pytest.mark.asyncio
async def test_reconcile_stripe_connect_status_keeps_saved_value_on_stripe_error(monkeypatch):
    monkeypatch.setattr(
        admin_payments.stripe_service,
        "retrieve_connect_account",
        AsyncMock(side_effect=RuntimeError("temporary Stripe failure")),
    )
    upsert = AsyncMock()
    monkeypatch.setattr(admin_payments.HotelPaymentSettingsRepository, "upsert", upsert)
    payment_settings = {
        "stripe_connect_account_id": "acct_retry_later",
        "stripe_connect_onboarded": False,
    }

    result = await admin_payments._reconcile_stripe_connect_status(
        "hotel-1",
        payment_settings,
    )

    assert result == payment_settings
    upsert.assert_not_awaited()


@pytest.mark.asyncio
async def test_onboarding_link_targets_booking_admin_and_saves_stripe_provider(monkeypatch):
    monkeypatch.setattr(admin_payments, "get_hotel_id", AsyncMock(return_value="hotel-1"))
    monkeypatch.setattr(
        admin_payments.HotelPaymentSettingsRepository,
        "get_by_hotel_id",
        AsyncMock(return_value={"stripe_connect_account_id": "acct_existing"}),
    )
    upsert = AsyncMock()
    monkeypatch.setattr(admin_payments.HotelPaymentSettingsRepository, "upsert", upsert)
    create_link = AsyncMock(return_value="https://connect.stripe.test/onboard")
    monkeypatch.setattr(
        admin_payments.stripe_service,
        "create_connect_account_link",
        create_link,
    )
    monkeypatch.setattr(
        admin_payments.app_settings,
        "BOOKING_ADMIN_URL",
        "https://admin.booking.vayada.com/",
    )

    result = await admin_payments.get_stripe_onboarding_link(user_id="user-1")

    assert result == {"url": "https://connect.stripe.test/onboard"}
    upsert.assert_awaited_once_with("hotel-1", {"payment_provider": "stripe"})
    create_link.assert_awaited_once_with(
        "acct_existing",
        return_url=("https://admin.booking.vayada.com/settings?section=payments&stripe=success"),
        refresh_url=("https://admin.booking.vayada.com/settings?section=payments&stripe=refresh"),
    )


@pytest.mark.asyncio
async def test_create_connect_account_saves_stripe_as_provider(monkeypatch):
    monkeypatch.setattr(admin_payments, "get_hotel_id", AsyncMock(return_value="hotel-1"))
    monkeypatch.setattr(
        admin_payments.stripe_service,
        "create_connect_account",
        AsyncMock(return_value={"id": "acct_new"}),
    )
    upsert = AsyncMock()
    monkeypatch.setattr(admin_payments.HotelPaymentSettingsRepository, "upsert", upsert)

    result = await admin_payments.create_stripe_connect_account(
        StripeConnectAccountRequest(email="owner@example.com", country="DE"),
        user_id="user-1",
    )

    assert result == {"accountId": "acct_new"}
    upsert.assert_awaited_once_with(
        "hotel-1",
        {
            "stripe_connect_account_id": "acct_new",
            "stripe_connect_onboarded": False,
            "payment_provider": "stripe",
        },
    )

import json
from unittest.mock import AsyncMock, patch

import pytest
from app.config import settings
from app.main import health
from app.routers import webhooks
from starlette.requests import Request


def _request(path: str, payload: bytes, headers: dict[str, str]) -> Request:
    scope = {
        "type": "http",
        "method": "POST",
        "path": path,
        "headers": [(key.lower().encode(), value.encode()) for key, value in headers.items()],
    }

    async def receive():
        return {"type": "http.request", "body": payload, "more_body": False}

    return Request(scope, receive)


def _set_mode(monkeypatch: pytest.MonkeyPatch, provider: str, mode: str) -> None:
    monkeypatch.setattr(settings, f"PMS_LEGACY_{provider.upper()}_WEBHOOK_MODE", mode)
    monkeypatch.setattr(
        settings,
        f"PMS_{provider.upper()}_WEBHOOK_TARGET_URL",
        f"https://target.example.com/webhooks/{provider}",
    )


@pytest.mark.parametrize("mode", ["ack_only_with_receipt", "proxy_to_target"])
async def test_stripe_cutover_modes_skip_legacy_mutation(monkeypatch, mode):
    _set_mode(monkeypatch, "stripe", mode)
    request = _request("/webhooks/stripe", b"{}", {"stripe-signature": "sig-test"})

    with (
        patch.object(
            webhooks.stripe_service,
            "construct_webhook_event",
            return_value={
                "type": "payment_intent.amount_capturable_updated",
                "data": {"object": {"id": "pi_cutover"}},
            },
        ),
        patch.object(
            webhooks,
            "_materialize_or_get_booking_for_pi",
            new_callable=AsyncMock,
        ) as materialize,
        patch.object(webhooks.PaymentRepository, "update_status", new_callable=AsyncMock) as update,
        patch.object(
            webhooks,
            "_proxy_provider_webhook_to_target",
            new_callable=AsyncMock,
        ) as proxy,
    ):
        proxy.return_value = {"status": "proxied", "mode": "proxy_to_target", "provider": "stripe"}
        response = await webhooks.stripe_webhook(request)

    assert response["mode"] == mode
    assert response["provider"] == "stripe"
    assert response["receipt"].startswith("legacy:stripe:")
    materialize.assert_not_called()
    update.assert_not_called()
    if mode == "proxy_to_target":
        proxy.assert_awaited_once()
    else:
        proxy.assert_not_called()


async def test_connect_webhook_uses_its_own_signing_secret(monkeypatch):
    _set_mode(monkeypatch, "stripe", "ack_only_with_receipt")
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", "whsec_platform")
    monkeypatch.setattr(settings, "STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_connect")
    request = _request("/webhooks/stripe/connect", b"{}", {"stripe-signature": "sig-test"})

    with patch.object(
        webhooks.stripe_service,
        "construct_webhook_event",
        return_value={
            "type": "payment_intent.succeeded",
            "data": {"object": {"id": "pi_connect"}},
        },
    ) as construct:
        response = await webhooks.stripe_connect_webhook(request)

    assert response["mode"] == "ack_only_with_receipt"
    construct.assert_called_once_with(b"{}", "sig-test", "whsec_connect")


@pytest.mark.parametrize("mode", ["ack_only_with_receipt", "proxy_to_target"])
async def test_xendit_cutover_modes_skip_legacy_mutation(monkeypatch, mode):
    _set_mode(monkeypatch, "xendit", mode)
    payload = json.dumps(
        {"event": "payout.succeeded", "data": {"id": "disb_cutover", "status": "SUCCEEDED"}}
    ).encode()
    request = _request(
        "/webhooks/xendit",
        payload,
        {
            "x-callback-token": settings.XENDIT_WEBHOOK_SECRET,
            "content-type": "application/json",
        },
    )

    with (
        patch.object(webhooks.PayoutRepository, "update_status", new_callable=AsyncMock) as update,
        patch.object(
            webhooks,
            "_proxy_provider_webhook_to_target",
            new_callable=AsyncMock,
        ) as proxy,
    ):
        proxy.return_value = {"status": "proxied", "mode": "proxy_to_target", "provider": "xendit"}
        response = await webhooks.xendit_webhook(request)

    assert response["mode"] == mode
    assert response["provider"] == "xendit"
    assert response["receipt"].startswith("legacy:xendit:")
    update.assert_not_called()
    if mode == "proxy_to_target":
        proxy.assert_awaited_once()
    else:
        proxy.assert_not_called()


@pytest.mark.parametrize("mode", ["ack_only_with_receipt", "proxy_to_target"])
async def test_channex_cutover_modes_skip_legacy_receipt_and_processing(monkeypatch, mode):
    _set_mode(monkeypatch, "channex", mode)
    monkeypatch.setattr(settings, "CHANNEX_WEBHOOK_SECRET", "channex-secret")
    payload = json.dumps(
        {
            "event": "message",
            "property_id": "prop-cutover",
            "payload": {"property_id": "prop-cutover", "message_thread_id": "thread-1"},
        }
    ).encode()
    request = _request(
        "/webhooks/channex",
        payload,
        {
            "x-vayada-webhook-token": "channex-secret",
            "content-type": "application/json",
        },
    )

    with (
        patch.object(
            webhooks.ChannexWebhookEventRepository,
            "insert",
            new_callable=AsyncMock,
        ) as insert,
        patch.object(
            webhooks.ChannexWebhookEventRepository,
            "mark_processed",
            new_callable=AsyncMock,
        ) as mark_processed,
        patch(
            "app.services.channex.messaging.process_inbound_message_event",
            new_callable=AsyncMock,
        ) as process,
        patch.object(
            webhooks,
            "_proxy_provider_webhook_to_target",
            new_callable=AsyncMock,
        ) as proxy,
    ):
        insert.return_value = "channex-receipt-1"
        proxy.return_value = {"status": "proxied", "mode": "proxy_to_target", "provider": "channex"}
        response = await webhooks.channex_webhook(request)

    assert response["mode"] == mode
    assert response["provider"] == "channex"
    assert response["receipt"].startswith("legacy:channex:")
    insert.assert_not_called()
    mark_processed.assert_not_called()
    process.assert_not_called()
    if mode == "proxy_to_target":
        proxy.assert_awaited_once()
    else:
        proxy.assert_not_called()


async def test_health_exposes_provider_webhook_cutover_modes(monkeypatch):
    _set_mode(monkeypatch, "stripe", "ack_only_with_receipt")
    _set_mode(monkeypatch, "xendit", "proxy_to_target")
    _set_mode(monkeypatch, "channex", "mutating")

    response = await health()

    modes = response["cutover"]["legacyProviderWebhooks"]
    assert modes["stripe"]["mode"] == "ack_only_with_receipt"
    assert modes["xendit"]["mode"] == "proxy_to_target"
    assert modes["channex"]["mode"] == "mutating"
    assert modes["xendit"]["proxyTargetConfigured"] is True

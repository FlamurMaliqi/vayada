from pathlib import Path

import pytest
from app.services import channex_admin_cutover as cutover
from app.services.channex_admin_cutover import ChannexAdminRouteGroup
from fastapi import HTTPException


class _FakeURL:
    path = "/admin/channex/sync-ari"
    query = "dry_run=true"


class _FakeRequest:
    method = "POST"
    url = _FakeURL()
    headers = {
        "authorization": "Bearer token",
        "host": "legacy.localhost",
        "content-length": "2",
        "content-type": "application/json",
    }

    async def body(self):
        return b"{}"


def _reset_modes(monkeypatch):
    monkeypatch.setattr(cutover.settings, "CHANNEX_ADMIN_DEFAULT_MODE", "legacy-owned")
    monkeypatch.setattr(cutover.settings, "CHANNEX_ADMIN_TARGET_BASE_URL", "")
    for config in cutover.ROUTE_GROUP_CONFIGS:
        monkeypatch.setattr(cutover.settings, config.env_var, "")


@pytest.mark.asyncio
async def test_default_legacy_owned_allows_legacy_route(monkeypatch):
    _reset_modes(monkeypatch)

    result = await cutover.guard_channex_admin_route(
        ChannexAdminRouteGroup.MANUAL_ARI_SYNC,
        _FakeRequest(),
        mutation=True,
    )

    assert result is None


@pytest.mark.asyncio
async def test_read_only_allows_reads_and_blocks_mutations(monkeypatch):
    _reset_modes(monkeypatch)
    monkeypatch.setattr(cutover.settings, "CHANNEX_ADMIN_MARKUPS_MODE", "read-only")

    read_result = await cutover.guard_channex_admin_route(
        ChannexAdminRouteGroup.MARKUPS,
        _FakeRequest(),
        mutation=False,
    )
    assert read_result is None

    with pytest.raises(HTTPException) as exc_info:
        await cutover.guard_channex_admin_route(
            ChannexAdminRouteGroup.MARKUPS,
            _FakeRequest(),
            mutation=True,
        )

    assert exc_info.value.status_code == 423
    assert exc_info.value.detail["route_group"] == "markups"
    assert exc_info.value.detail["mode"] == "read-only"
    assert "mutating legacy action is blocked" in exc_info.value.detail["message"]


@pytest.mark.asyncio
async def test_disabled_blocks_reads_too(monkeypatch):
    _reset_modes(monkeypatch)
    monkeypatch.setattr(cutover.settings, "CHANNEX_ADMIN_READ_MODEL_MODE", "disabled")

    with pytest.raises(HTTPException) as exc_info:
        await cutover.guard_channex_admin_route(
            ChannexAdminRouteGroup.READ_MODEL,
            _FakeRequest(),
            mutation=False,
        )

    assert exc_info.value.status_code == 423
    assert exc_info.value.detail["mode"] == "disabled"
    assert "disabled during cutover" in exc_info.value.detail["message"]


@pytest.mark.asyncio
async def test_target_owned_blocks_legacy_route(monkeypatch):
    _reset_modes(monkeypatch)
    monkeypatch.setattr(cutover.settings, "CHANNEX_ADMIN_MANUAL_BOOKING_SYNC_MODE", "target-owned")

    with pytest.raises(HTTPException) as exc_info:
        await cutover.guard_channex_admin_route(
            ChannexAdminRouteGroup.MANUAL_BOOKING_SYNC,
            _FakeRequest(),
            mutation=True,
        )

    assert exc_info.value.status_code == 423
    assert exc_info.value.detail["route_group"] == "manual-booking-sync"
    assert exc_info.value.detail["mode"] == "target-owned"
    assert "use the target service" in exc_info.value.detail["message"]


@pytest.mark.asyncio
async def test_proxy_to_target_requires_target_base_url(monkeypatch):
    _reset_modes(monkeypatch)
    monkeypatch.setattr(cutover.settings, "CHANNEX_ADMIN_MANUAL_ARI_SYNC_MODE", "proxy-to-target")

    with pytest.raises(HTTPException) as exc_info:
        await cutover.guard_channex_admin_route(
            ChannexAdminRouteGroup.MANUAL_ARI_SYNC,
            _FakeRequest(),
            mutation=True,
        )

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail["code"] == "channex_admin_proxy_target_missing"


@pytest.mark.asyncio
async def test_proxy_to_target_forwards_request(monkeypatch):
    _reset_modes(monkeypatch)
    monkeypatch.setattr(cutover.settings, "CHANNEX_ADMIN_MANUAL_ARI_SYNC_MODE", "proxy")
    monkeypatch.setattr(cutover.settings, "CHANNEX_ADMIN_TARGET_BASE_URL", "https://target.test")

    captured = {}

    class FakeProxyResponse:
        content = b'{"proxied":true}'
        status_code = 202
        headers = {"content-type": "application/json", "content-length": "16"}

    class FakeAsyncClient:
        def __init__(self, timeout):
            captured["timeout"] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def request(self, method, url, *, content, headers):
            captured.update(
                {
                    "method": method,
                    "url": url,
                    "content": content,
                    "headers": headers,
                }
            )
            return FakeProxyResponse()

    monkeypatch.setattr(cutover.httpx, "AsyncClient", FakeAsyncClient)

    response = await cutover.guard_channex_admin_route(
        ChannexAdminRouteGroup.MANUAL_ARI_SYNC,
        _FakeRequest(),
        mutation=True,
    )

    assert response.status_code == 202
    assert response.body == b'{"proxied":true}'
    assert captured["method"] == "POST"
    assert captured["url"] == "https://target.test/admin/channex/sync-ari?dry_run=true"
    assert captured["content"] == b"{}"
    assert captured["headers"]["authorization"] == "Bearer token"
    assert "host" not in captured["headers"]
    assert "content-length" not in captured["headers"]


def test_mode_report_exposes_effective_group_modes(monkeypatch):
    _reset_modes(monkeypatch)
    monkeypatch.setattr(cutover.settings, "CHANNEX_ADMIN_DEFAULT_MODE", "read_only")
    monkeypatch.setattr(cutover.settings, "CHANNEX_ADMIN_WEBHOOK_SETUP_MODE", "target")

    report = cutover.describe_channex_admin_cutover_modes()

    assert report["default_mode"] == "read-only"
    modes_by_group = {row["group"]: row for row in report["modes"]}
    assert modes_by_group["manual-ari-sync"]["mode"] == "read-only"
    assert modes_by_group["manual-ari-sync"]["source"] == "CHANNEX_ADMIN_DEFAULT_MODE"
    assert modes_by_group["webhook-setup"]["mode"] == "target-owned"
    assert modes_by_group["webhook-setup"]["source"] == "CHANNEX_ADMIN_WEBHOOK_SETUP_MODE"


def test_invalid_mode_is_clear(monkeypatch):
    _reset_modes(monkeypatch)
    monkeypatch.setattr(cutover.settings, "CHANNEX_ADMIN_DEFAULT_MODE", "surprise")

    with pytest.raises(HTTPException) as exc_info:
        cutover.mode_for_group(ChannexAdminRouteGroup.PROVISIONING)

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail["code"] == "invalid_channex_admin_cutover_mode"
    assert exc_info.value.detail["env_var"] == "CHANNEX_ADMIN_DEFAULT_MODE"


def test_markup_read_route_uses_read_model_group():
    source = Path("app/routers/admin_channex.py").read_text()
    route_marker = '@router.get("/channex/markups"'
    start = source.index(route_marker)
    end = source.index('@router.put("/channex/markups"', start)
    route_source = source[start:end]

    assert "ChannexAdminRouteGroup.READ_MODEL" in route_source
    assert "ChannexAdminRouteGroup.MARKUPS" not in route_source

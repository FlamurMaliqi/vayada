"""Unit tests for the inbox attachment + message-send paths (VAY-358).

These cover the pure validation helpers and the send-message loop's per-
attachment dispatch behavior. Mocks every external dependency (auth, DB,
Channex) so they can run without the test database stack.
"""

from datetime import UTC, datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from app.models.messaging import SendMessageRequest
from app.repositories.platform_media_repo import PlatformMediaAttachment
from app.routers import admin_messaging
from app.routers.admin_messaging import (
    _mask_thread_guest_contacts,
    max_attachment_bytes_for_channel,
    send_message,
    upload_thread_attachment,
    validate_attachment,
)
from app.services.guest_contact_access import HIDDEN_GUEST_CONTACT
from fastapi import HTTPException

# ── validate_attachment ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_commission_inbox_masks_pending_but_not_previously_accepted_contact():
    rows = [
        {
            "id": "thread-pending",
            "booking_id": "00000000-0000-0000-0000-000000000001",
            "guest_email": "pending@example.test",
        },
        {
            "id": "thread-accepted",
            "booking_id": "00000000-0000-0000-0000-000000000002",
            "guest_email": "accepted@example.test",
        },
        {"id": "thread-unlinked", "booking_id": None, "guest_email": "unlinked@example.test"},
    ]
    with (
        patch.object(
            admin_messaging, "fetch_guest_contact_plan", AsyncMock(return_value="commission")
        ),
        patch.object(
            admin_messaging.Database,
            "fetch",
            AsyncMock(
                return_value=[
                    {"id": "00000000-0000-0000-0000-000000000001", "status": "pending"},
                    {
                        "id": "00000000-0000-0000-0000-000000000002",
                        "status": "cancelled",
                        "contact_details_revealed_at": datetime.now(UTC),
                    },
                ]
            ),
        ),
    ):
        masked = await _mask_thread_guest_contacts(rows, "hotel-1")

    assert masked[0]["guest_email"] == HIDDEN_GUEST_CONTACT
    assert masked[1]["guest_email"] == "accepted@example.test"
    assert masked[2]["guest_email"] == HIDDEN_GUEST_CONTACT


def test_validate_attachment_accepts_image_jpeg():
    validate_attachment(
        content_type="image/jpeg",
        size_bytes=1024,
        channel="airbnb",
    )


def test_validate_attachment_accepts_pdf():
    validate_attachment(
        content_type="application/pdf",
        size_bytes=1024,
        channel="booking.com",
    )


def test_validate_attachment_strips_charset_suffix():
    # Some browsers send `image/jpeg; charset=binary`.
    validate_attachment(
        content_type="image/jpeg; charset=binary",
        size_bytes=1024,
        channel="airbnb",
    )


def test_validate_attachment_is_case_insensitive_on_mime():
    validate_attachment(
        content_type="IMAGE/PNG",
        size_bytes=1024,
        channel="airbnb",
    )


def test_validate_attachment_rejects_zip():
    with pytest.raises(HTTPException) as exc:
        validate_attachment(
            content_type="application/zip",
            size_bytes=1024,
            channel="booking.com",
        )
    assert exc.value.status_code == 415
    assert "booking.com" in exc.value.detail
    assert "application/zip" in exc.value.detail


def test_validate_attachment_rejects_missing_content_type():
    with pytest.raises(HTTPException) as exc:
        validate_attachment(
            content_type=None,
            size_bytes=1024,
            channel="airbnb",
        )
    assert exc.value.status_code == 415


def test_validate_attachment_rejects_empty_file():
    with pytest.raises(HTTPException) as exc:
        validate_attachment(
            content_type="image/jpeg",
            size_bytes=0,
            channel="airbnb",
        )
    assert exc.value.status_code == 400


def test_validate_attachment_rejects_oversize_for_bdc():
    # Booking.com cap is 8MB.
    with pytest.raises(HTTPException) as exc:
        validate_attachment(
            content_type="image/jpeg",
            size_bytes=9 * 1024 * 1024,
            channel="booking.com",
        )
    assert exc.value.status_code == 413
    assert "8 MB" in exc.value.detail


def test_validate_attachment_allows_bdc_at_limit():
    validate_attachment(
        content_type="image/jpeg",
        size_bytes=8 * 1024 * 1024,
        channel="booking.com",
    )


def test_validate_attachment_allows_airbnb_up_to_25mb():
    validate_attachment(
        content_type="image/jpeg",
        size_bytes=25 * 1024 * 1024,
        channel="airbnb",
    )


def test_validate_attachment_rejects_airbnb_above_25mb():
    with pytest.raises(HTTPException) as exc:
        validate_attachment(
            content_type="image/jpeg",
            size_bytes=26 * 1024 * 1024,
            channel="airbnb",
        )
    assert exc.value.status_code == 413
    assert "25 MB" in exc.value.detail


def test_max_attachment_bytes_unknown_channel_uses_default():
    assert max_attachment_bytes_for_channel("nonsense") == 25 * 1024 * 1024
    assert max_attachment_bytes_for_channel(None) == 25 * 1024 * 1024


def test_max_attachment_bytes_is_case_insensitive():
    assert max_attachment_bytes_for_channel("Booking.Com") == 8 * 1024 * 1024


# ── upload_thread_attachment validation ────────────────────────────────


class _FakeUploadFile:
    def __init__(self, data: bytes, *, content_type: str, filename: str):
        self._data = data
        self.content_type = content_type
        self.filename = filename

    async def read(self) -> bytes:
        return self._data


@pytest.mark.asyncio
async def test_upload_rejects_disallowed_mime_before_calling_channex():
    fake_upload_attachment = AsyncMock()
    fake_store_attachment = AsyncMock()
    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(return_value={"channel": "booking.com", "source_thread_id": "t-src"}),
        ),
        patch.object(
            admin_messaging.channex_service,
            "upload_attachment",
            fake_upload_attachment,
        ),
        patch.object(
            admin_messaging.PlatformMediaAttachmentRepository,
            "store_private_attachment",
            fake_store_attachment,
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await upload_thread_attachment(
                thread_id="t1",
                file=_FakeUploadFile(
                    b"data",
                    content_type="application/zip",
                    filename="x.zip",
                ),
                user_id="u1",
            )
    assert exc.value.status_code == 415
    fake_upload_attachment.assert_not_awaited()
    fake_store_attachment.assert_not_awaited()


@pytest.mark.asyncio
async def test_upload_rejects_oversize_before_calling_channex():
    fake_upload_attachment = AsyncMock()
    fake_store_attachment = AsyncMock()
    big = b"\x00" * (9 * 1024 * 1024)  # 9MB > BDC's 8MB
    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(return_value={"channel": "booking.com", "source_thread_id": "t-src"}),
        ),
        patch.object(
            admin_messaging.channex_service,
            "upload_attachment",
            fake_upload_attachment,
        ),
        patch.object(
            admin_messaging.PlatformMediaAttachmentRepository,
            "store_private_attachment",
            fake_store_attachment,
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await upload_thread_attachment(
                thread_id="t1",
                file=_FakeUploadFile(
                    big,
                    content_type="image/jpeg",
                    filename="x.jpg",
                ),
                user_id="u1",
            )
    assert exc.value.status_code == 413
    fake_upload_attachment.assert_not_awaited()
    fake_store_attachment.assert_not_awaited()


@pytest.mark.asyncio
async def test_upload_calls_channex_for_allowed_jpeg():
    calls: list[str] = []

    async def store_attachment(**_kwargs):
        calls.append("platform-media")
        return PlatformMediaAttachment(
            media_id="media-1",
            storage_key="private/pms/messages/t1/media-1/ok.jpg",
            filename="ok.jpg",
            content_type="image/jpeg",
            size_bytes=8,
        )

    async def upload_attachment(*_args, **_kwargs):
        calls.append("channex")
        return {"id": "att-123"}

    fake_upload_attachment = AsyncMock(side_effect=upload_attachment)
    fake_store_attachment = AsyncMock(side_effect=store_attachment)
    fake_record_provider = AsyncMock()
    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(return_value={"channel": "airbnb", "source_thread_id": "t-src"}),
        ),
        patch.object(
            admin_messaging.channex_service,
            "upload_attachment",
            fake_upload_attachment,
        ),
        patch.object(
            admin_messaging.PlatformMediaAttachmentRepository,
            "store_private_attachment",
            fake_store_attachment,
        ),
        patch.object(
            admin_messaging.PlatformMediaAttachmentRepository,
            "record_provider_attachment_id",
            fake_record_provider,
        ),
        patch.object(
            admin_messaging.channex_service,
            "get_platform_api_key",
            return_value="key",
        ),
    ):
        result = await upload_thread_attachment(
            thread_id="t1",
            file=_FakeUploadFile(
                b"jpegdata",
                content_type="image/jpeg",
                filename="ok.jpg",
            ),
            user_id="u1",
        )
    assert result == {"attachment_id": "att-123"}
    assert calls == ["platform-media", "channex"]
    fake_store_attachment.assert_awaited_once_with(
        property_id="h1",
        thread_id="t1",
        actor_user_id="u1",
        file_bytes=b"jpegdata",
        filename="ok.jpg",
        content_type="image/jpeg",
    )
    fake_upload_attachment.assert_awaited_once()
    fake_record_provider.assert_awaited_once_with(
        media_id="media-1",
        source_attachment_id="att-123",
    )


# ── send_message loop dispatch ─────────────────────────────────────────


def _channex_msg(msg_id: str) -> dict:
    return {
        "id": msg_id,
        "attributes": {
            "inserted_at": datetime.now(UTC).isoformat(),
        },
    }


def _inserted_row(row_id: str, body: str = "") -> dict:
    return {
        "id": row_id,
        "thread_id": "t1",
        "direction": "outbound",
        "sender_name": None,
        "body": body,
        "sent_at": datetime.now(UTC),
        "read_at": None,
    }


@pytest.mark.asyncio
async def test_send_message_with_two_attachments_issues_two_channex_calls():
    """Body rides with the first attachment; the second has empty body."""
    post_mock = AsyncMock(side_effect=[_channex_msg("m1"), _channex_msg("m2")])
    insert_mock = AsyncMock(
        side_effect=[
            _inserted_row("row1", "Hello!"),
            _inserted_row("row2"),
        ]
    )

    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(
                return_value={
                    "id": "t1",
                    "channel": "booking.com",
                    "source_thread_id": "t-src",
                }
            ),
        ),
        patch.object(
            admin_messaging.MessageRepository,
            "insert_and_update_thread",
            insert_mock,
        ),
        patch.object(
            admin_messaging.MessageAttachmentRepository,
            "add",
            AsyncMock(),
        ),
        patch.object(
            admin_messaging.MessageAttachmentRepository,
            "list_by_message",
            AsyncMock(return_value=[]),
        ),
        patch.object(
            admin_messaging.PlatformMediaAttachmentRepository,
            "find_by_provider_attachment_id",
            AsyncMock(return_value=None),
        ),
        patch.object(
            admin_messaging.channex_service,
            "post_thread_message",
            post_mock,
        ),
        patch.object(
            admin_messaging.channex_service,
            "get_platform_api_key",
            return_value="key",
        ),
    ):
        await send_message(
            thread_id="t1",
            body=SendMessageRequest(body="Hello!", attachment_ids=["a1", "a2"]),
            user_id="u1",
        )

    assert post_mock.await_count == 2
    first_kwargs = post_mock.await_args_list[0].kwargs
    second_kwargs = post_mock.await_args_list[1].kwargs
    assert first_kwargs["message"] == "Hello!"
    assert first_kwargs["attachment_id"] == "a1"
    assert second_kwargs["message"] == ""
    assert second_kwargs["attachment_id"] == "a2"


@pytest.mark.asyncio
async def test_send_message_attachment_only_issues_one_channex_call():
    post_mock = AsyncMock(return_value=_channex_msg("m1"))
    insert_mock = AsyncMock(return_value=_inserted_row("row1"))

    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(
                return_value={
                    "id": "t1",
                    "channel": "airbnb",
                    "source_thread_id": "t-src",
                }
            ),
        ),
        patch.object(
            admin_messaging.MessageRepository,
            "insert_and_update_thread",
            insert_mock,
        ),
        patch.object(
            admin_messaging.MessageAttachmentRepository,
            "add",
            AsyncMock(),
        ),
        patch.object(
            admin_messaging.MessageAttachmentRepository,
            "list_by_message",
            AsyncMock(return_value=[]),
        ),
        patch.object(
            admin_messaging.PlatformMediaAttachmentRepository,
            "find_by_provider_attachment_id",
            AsyncMock(return_value=None),
        ),
        patch.object(
            admin_messaging.channex_service,
            "post_thread_message",
            post_mock,
        ),
        patch.object(
            admin_messaging.channex_service,
            "get_platform_api_key",
            return_value="key",
        ),
    ):
        await send_message(
            thread_id="t1",
            body=SendMessageRequest(body="", attachment_ids=["a1"]),
            user_id="u1",
        )

    assert post_mock.await_count == 1
    kwargs = post_mock.await_args.kwargs
    assert kwargs["message"] == ""
    assert kwargs["attachment_id"] == "a1"


@pytest.mark.asyncio
async def test_send_message_persists_platform_media_reference_for_attachment():
    post_mock = AsyncMock(return_value=_channex_msg("m1"))
    insert_mock = AsyncMock(return_value=_inserted_row("row1"))
    add_attachment_mock = AsyncMock(return_value={"id": "message-attachment-1"})
    link_attachment_mock = AsyncMock()
    find_media_mock = AsyncMock(
        return_value=PlatformMediaAttachment(
            media_id="media-1",
            storage_key="private/pms/messages/t1/media-1/ok.jpg",
            filename="ok.jpg",
            content_type="image/jpeg",
            size_bytes=8,
        )
    )

    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(
                return_value={
                    "id": "t1",
                    "channel": "airbnb",
                    "source_thread_id": "t-src",
                }
            ),
        ),
        patch.object(
            admin_messaging.MessageRepository,
            "insert_and_update_thread",
            insert_mock,
        ),
        patch.object(
            admin_messaging.MessageAttachmentRepository,
            "add",
            add_attachment_mock,
        ),
        patch.object(
            admin_messaging.MessageAttachmentRepository,
            "list_by_message",
            AsyncMock(return_value=[]),
        ),
        patch.object(
            admin_messaging.PlatformMediaAttachmentRepository,
            "find_by_provider_attachment_id",
            find_media_mock,
        ),
        patch.object(
            admin_messaging.PlatformMediaAttachmentRepository,
            "link_message_attachment",
            link_attachment_mock,
        ),
        patch.object(
            admin_messaging.channex_service,
            "post_thread_message",
            post_mock,
        ),
        patch.object(
            admin_messaging.channex_service,
            "get_platform_api_key",
            return_value="key",
        ),
    ):
        await send_message(
            thread_id="t1",
            body=SendMessageRequest(body="", attachment_ids=["att-123"]),
            user_id="u1",
        )

    find_media_mock.assert_awaited_once_with(
        property_id="h1",
        thread_id="t1",
        source_attachment_id="att-123",
    )
    add_attachment_mock.assert_awaited_once_with(
        message_id="row1",
        platform_media_object_id="media-1",
        s3_key="private/pms/messages/t1/media-1/ok.jpg",
        filename="ok.jpg",
        content_type="image/jpeg",
        size_bytes=8,
        source_attachment_id="att-123",
    )
    link_attachment_mock.assert_awaited_once_with(
        media_id="media-1",
        message_attachment_id="message-attachment-1",
    )


@pytest.mark.asyncio
async def test_send_message_partial_failure_surfaces_count_in_error():
    """If the 2nd attachment's Channex call fails, the user must be told the
    1st already went through so they don't blindly retry both."""
    post_mock = AsyncMock(
        side_effect=[
            _channex_msg("m1"),
            Exception("boom"),
        ]
    )

    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(
                return_value={
                    "id": "t1",
                    "channel": "airbnb",
                    "source_thread_id": "t-src",
                }
            ),
        ),
        patch.object(
            admin_messaging.MessageRepository,
            "insert_and_update_thread",
            AsyncMock(return_value=_inserted_row("row1")),
        ),
        patch.object(
            admin_messaging.MessageAttachmentRepository,
            "add",
            AsyncMock(),
        ),
        patch.object(
            admin_messaging.PlatformMediaAttachmentRepository,
            "find_by_provider_attachment_id",
            AsyncMock(return_value=None),
        ),
        patch.object(
            admin_messaging.channex_service,
            "post_thread_message",
            post_mock,
        ),
        patch.object(
            admin_messaging.channex_service,
            "get_platform_api_key",
            return_value="key",
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await send_message(
                thread_id="t1",
                body=SendMessageRequest(body="", attachment_ids=["a1", "a2"]),
                user_id="u1",
            )

    assert exc.value.status_code == 502
    assert "1 of 2" in exc.value.detail


@pytest.mark.asyncio
async def test_send_message_rejects_empty_payload():
    with (
        patch.object(admin_messaging, "get_hotel_id", AsyncMock(return_value="h1")),
        patch.object(
            admin_messaging.MessageThreadRepository,
            "get_by_id",
            AsyncMock(
                return_value={
                    "id": "t1",
                    "channel": "airbnb",
                    "source_thread_id": "t-src",
                }
            ),
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await send_message(
                thread_id="t1",
                body=SendMessageRequest(body="", attachment_ids=[]),
                user_id="u1",
            )
    assert exc.value.status_code == 400

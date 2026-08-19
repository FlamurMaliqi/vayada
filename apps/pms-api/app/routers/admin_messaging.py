"""Hotel-facing inbox API: list threads, read thread, reply, attachments."""

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile

from app.database import Database
from app.dependencies import require_hotel_admin
from app.models.messaging import (
    Message,
    MessageAttachment,
    MessageThread,
    SendMessageRequest,
    ThreadDetailResponse,
    ThreadListResponse,
    UnreadCountResponse,
)
from app.repositories.messaging_repo import (
    MessageAttachmentRepository,
    MessageRepository,
    MessageThreadRepository,
)
from app.repositories.platform_media_repo import (
    PlatformMediaAttachmentRepository,
    normalize_attachment_content_type,
)
from app.services import channex_service
from app.services.guest_contact_access import (
    HIDDEN_GUEST_CONTACT,
    fetch_guest_contact_plan,
    guest_contacts_are_visible,
)
from app.utils import get_hotel_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-messaging"])


# Channex's Messaging & Reviews app forwards a fixed set of media types to the
# OTAs. Anything outside this list is silently dropped on the OTA side, so we
# reject upfront with a clear error.
ALLOWED_ATTACHMENT_CONTENT_TYPES: frozenset[str] = frozenset(
    {
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/heic",
        "image/heif",
        "image/webp",
        "image/gif",
        "application/pdf",
    }
)

# Per-channel max attachment size. Booking.com's messaging API caps at ~10MB;
# Airbnb tolerates up to 25MB. We use the smaller of the relevant cap so the
# user gets the right limit before they upload.
_DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
_PER_CHANNEL_MAX_ATTACHMENT_BYTES: dict[str, int] = {
    "booking.com": 8 * 1024 * 1024,
    "airbnb": 25 * 1024 * 1024,
    "expedia": 10 * 1024 * 1024,
}


def max_attachment_bytes_for_channel(channel: str | None) -> int:
    if not channel:
        return _DEFAULT_MAX_ATTACHMENT_BYTES
    return _PER_CHANNEL_MAX_ATTACHMENT_BYTES.get(
        channel.lower(),
        _DEFAULT_MAX_ATTACHMENT_BYTES,
    )


def validate_attachment(
    *,
    content_type: str | None,
    size_bytes: int,
    channel: str | None,
) -> None:
    """Raise HTTPException if the file can't be forwarded to the OTA.

    Validation happens up front rather than after upload so the user sees the
    real reason instead of a generic Channex 4xx surfaced as a 502.
    """
    ct = normalize_attachment_content_type(content_type)
    if ct not in ALLOWED_ATTACHMENT_CONTENT_TYPES:
        channel_label = channel or "the OTA"
        raise HTTPException(
            status_code=415,
            detail=(
                f"{channel_label} doesn't accept this file type "
                f"({ct or 'unknown'}). Try JPG, PNG, HEIC, WEBP, GIF or PDF."
            ),
        )

    if size_bytes <= 0:
        raise HTTPException(status_code=400, detail="Attachment file is empty.")

    limit = max_attachment_bytes_for_channel(channel)
    if size_bytes > limit:
        limit_mb = limit // (1024 * 1024)
        channel_label = channel or "this channel"
        raise HTTPException(
            status_code=413,
            detail=(f"Attachment is too large for {channel_label} (max {limit_mb} MB)."),
        )


def _thread_to_model(row: dict) -> MessageThread:
    return MessageThread(
        id=str(row["id"]),
        source=row["source"],
        channel=row.get("channel"),
        booking_id=str(row["booking_id"]) if row.get("booking_id") else None,
        guest_name=row.get("guest_name"),
        guest_email=row.get("guest_email"),
        status=row["status"],
        last_message_at=row.get("last_message_at"),
        last_message_preview=row.get("last_message_preview"),
        last_message_direction=row.get("last_message_direction"),
        unread_count=int(row.get("unread_count") or 0),
    )


async def _mask_thread_guest_contacts(rows: list[dict], hotel_id: str) -> list[dict]:
    plan = await fetch_guest_contact_plan(hotel_id)
    if plan == "fixed":
        return rows
    booking_ids = list({str(row["booking_id"]) for row in rows if row.get("booking_id")})
    booking_rows = (
        await Database.fetch(
            """
            SELECT id, status, contact_details_revealed_at,
                   finalization_started_at, finalization_completed_at
              FROM bookings
             WHERE hotel_id = $1 AND id = ANY($2::uuid[])
            """,
            hotel_id,
            booking_ids,
        )
        if booking_ids
        else []
    )
    bookings = {str(row["id"]): dict(row) for row in booking_rows}
    return [
        row
        if (
            row.get("booking_id")
            and (booking := bookings.get(str(row["booking_id"])))
            and guest_contacts_are_visible(booking, plan)
        )
        else {**row, "guest_email": HIDDEN_GUEST_CONTACT}
        for row in rows
    ]


async def _masked_thread_model(row: dict, hotel_id: str) -> MessageThread:
    return _thread_to_model((await _mask_thread_guest_contacts([row], hotel_id))[0])


def _message_to_model(row: dict, attachments: list) -> Message:
    return Message(
        id=str(row["id"]),
        thread_id=str(row["thread_id"]),
        direction=row["direction"],
        sender_name=row.get("sender_name"),
        body=row.get("body") or "",
        sent_at=row["sent_at"],
        read_at=row.get("read_at"),
        attachments=[
            MessageAttachment(
                id=str(a["id"]),
                filename=a.get("filename"),
                content_type=a.get("content_type"),
                size_bytes=a.get("size_bytes"),
                url=a.get("source_url"),  # phase 1: pass through Channex URL
            )
            for a in attachments
        ],
    )


@router.get("/messaging/threads", response_model=ThreadListResponse)
async def list_threads(
    status: str | None = Query(None, regex="^(open|closed|no_reply_needed)$"),
    limit: int = Query(50, ge=1, le=100),
    before: datetime | None = None,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    rows = await MessageThreadRepository.list_by_hotel(
        hotel_id,
        status=status,
        limit=limit,
        before=before,
    )
    threads = [_thread_to_model(r) for r in await _mask_thread_guest_contacts(rows, hotel_id)]
    next_cursor = (
        rows[-1]["last_message_at"].isoformat()
        if len(rows) == limit and rows[-1].get("last_message_at")
        else None
    )
    return ThreadListResponse(threads=threads, next_cursor=next_cursor)


@router.get("/messaging/threads/{thread_id}", response_model=ThreadDetailResponse)
async def get_thread(
    thread_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    thread_row = await MessageThreadRepository.get_by_id(thread_id, hotel_id)
    if not thread_row:
        raise HTTPException(status_code=404, detail="Thread not found")

    message_rows = await MessageRepository.list_by_thread(thread_id)
    attachments_by_msg: dict[str, list] = {}
    for att in await MessageAttachmentRepository.list_by_thread(thread_id):
        attachments_by_msg.setdefault(str(att["message_id"]), []).append(att)

    messages = [
        _message_to_model(m, attachments_by_msg.get(str(m["id"]), [])) for m in message_rows
    ]
    return ThreadDetailResponse(
        thread=await _masked_thread_model(thread_row, hotel_id),
        messages=messages,
    )


@router.post("/messaging/threads/{thread_id}/messages", response_model=Message)
async def send_message(
    thread_id: str,
    body: SendMessageRequest,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    thread = await MessageThreadRepository.get_by_id(thread_id, hotel_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    if not body.body and not body.attachment_ids:
        raise HTTPException(status_code=400, detail="message body or attachment required")

    api_key = channex_service.get_platform_api_key()
    source_thread_id = thread["source_thread_id"]
    channel = thread.get("channel")

    # Channex accepts one attachment per message; if more were uploaded, send
    # them as separate messages. Body goes with the first.
    attachments = body.attachment_ids or [None]
    last_inserted = None
    for idx, attachment_id in enumerate(attachments):
        msg_body = body.body if idx == 0 else ""
        logger.info(
            "Sending Channex message: thread=%s channel=%s "
            "source_thread_id=%s attachment_id=%s body_len=%d (%d/%d)",
            thread_id,
            channel,
            source_thread_id,
            attachment_id,
            len(msg_body),
            idx + 1,
            len(attachments),
        )
        try:
            channex_msg = await channex_service.post_thread_message(
                api_key,
                source_thread_id,
                message=msg_body,
                attachment_id=attachment_id,
            )
        except Exception as e:
            sent_so_far = idx
            logger.exception(
                "Failed to send Channex message: thread=%s channel=%s "
                "attachment_id=%s sent_before_failure=%d/%d",
                thread_id,
                channel,
                attachment_id,
                sent_so_far,
                len(attachments),
            )
            if sent_so_far > 0:
                detail = (
                    f"Channex send failed after {sent_so_far} of "
                    f"{len(attachments)} attachments delivered: {e}"
                )
            else:
                detail = f"Channex send failed: {e}"
            raise HTTPException(status_code=502, detail=detail) from e
        logger.info(
            "Channex message accepted: thread=%s channel=%s channex_message_id=%s",
            thread_id,
            channel,
            channex_msg.get("id"),
        )

        attrs = channex_msg.get("attributes") or {}
        sent_at_str = attrs.get("inserted_at")
        sent_at = (
            datetime.fromisoformat(sent_at_str.replace("Z", "+00:00"))
            if sent_at_str
            else datetime.now(UTC)
        )
        inserted = await MessageRepository.insert_and_update_thread(
            thread_id=thread_id,
            source_message_id=str(channex_msg["id"]),
            direction="outbound",
            sender_name=None,
            body=msg_body,
            sent_at=sent_at,
            raw_payload=channex_msg,
        )
        if inserted and attachment_id:
            media = await PlatformMediaAttachmentRepository.find_by_provider_attachment_id(
                property_id=hotel_id,
                thread_id=thread_id,
                source_attachment_id=attachment_id,
            )
            attachment = await MessageAttachmentRepository.add(
                message_id=str(inserted["id"]),
                platform_media_object_id=media.media_id if media else None,
                s3_key=media.storage_key if media else None,
                filename=media.filename if media else None,
                content_type=media.content_type if media else None,
                size_bytes=media.size_bytes if media else None,
                source_attachment_id=attachment_id,
            )
            if media:
                await PlatformMediaAttachmentRepository.link_message_attachment(
                    media_id=media.media_id,
                    message_attachment_id=str(attachment["id"]),
                )
        last_inserted = inserted

    if not last_inserted:
        # All sends collided with prior records — return the latest existing.
        rows = await MessageRepository.list_by_thread(thread_id)
        if not rows:
            raise HTTPException(
                status_code=500, detail="Send appeared to succeed but message not found"
            )
        last_inserted = rows[-1]

    atts = await MessageAttachmentRepository.list_by_message(str(last_inserted["id"]))
    return _message_to_model(last_inserted, atts)


@router.post("/messaging/threads/{thread_id}/attachments")
async def upload_thread_attachment(
    thread_id: str,
    file: UploadFile = File(...),
    user_id: str = Depends(require_hotel_admin),
):
    """Upload an attachment to Channex; returns the attachment_id to pass to
    the send-message endpoint."""
    hotel_id = await get_hotel_id(user_id)
    thread = await MessageThreadRepository.get_by_id(thread_id, hotel_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")

    contents = await file.read()
    channel = thread.get("channel")
    validate_attachment(
        content_type=file.content_type,
        size_bytes=len(contents),
        channel=channel,
    )

    try:
        media = await PlatformMediaAttachmentRepository.store_private_attachment(
            property_id=hotel_id,
            thread_id=thread_id,
            actor_user_id=user_id,
            file_bytes=contents,
            filename=file.filename or "attachment",
            content_type=file.content_type,
        )
    except Exception as e:
        logger.exception(
            "Platform media attachment storage failed: thread=%s channel=%s "
            "filename=%s content_type=%s size=%d",
            thread_id,
            channel,
            file.filename,
            file.content_type,
            len(contents),
        )
        raise HTTPException(status_code=503, detail=f"Platform media storage failed: {e}") from e

    api_key = channex_service.get_platform_api_key()
    try:
        result = await channex_service.upload_attachment(
            api_key,
            file_bytes=contents,
            filename=file.filename or "attachment",
            content_type=media.content_type or "application/octet-stream",
        )
    except Exception as e:
        logger.exception(
            "Channex attachment upload failed: thread=%s channel=%s "
            "filename=%s content_type=%s size=%d",
            thread_id,
            channel,
            file.filename,
            file.content_type,
            len(contents),
        )
        raise HTTPException(status_code=502, detail=f"Upload failed: {e}") from e

    attachment_id = result.get("id")
    if not attachment_id:
        raise HTTPException(status_code=502, detail="Upload failed: provider did not return an id")
    await PlatformMediaAttachmentRepository.record_provider_attachment_id(
        media_id=media.media_id,
        source_attachment_id=str(attachment_id),
    )
    logger.info(
        "Channex attachment uploaded: thread=%s channel=%s filename=%s "
        "content_type=%s size=%d attachment_id=%s media_id=%s",
        thread_id,
        channel,
        file.filename,
        file.content_type,
        len(contents),
        attachment_id,
        media.media_id,
    )
    return {"attachment_id": attachment_id}


@router.post("/messaging/threads/{thread_id}/read", response_model=MessageThread)
async def mark_thread_read(
    thread_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    row = await MessageThreadRepository.mark_all_read(thread_id, hotel_id)
    if not row:
        raise HTTPException(status_code=404, detail="Thread not found")
    return await _masked_thread_model(row, hotel_id)


@router.post("/messaging/threads/{thread_id}/close", response_model=MessageThread)
async def close_thread(
    thread_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    thread = await MessageThreadRepository.get_by_id(thread_id, hotel_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")

    api_key = channex_service.get_platform_api_key()
    try:
        await channex_service.close_thread(api_key, thread["source_thread_id"])
    except Exception as e:
        logger.warning("Channex close_thread failed (continuing locally): %s", e)

    row = await MessageThreadRepository.update_status(thread_id, hotel_id, "closed")
    return await _masked_thread_model(row or thread, hotel_id)


@router.post("/messaging/threads/{thread_id}/no-reply-needed", response_model=MessageThread)
async def mark_no_reply_needed(
    thread_id: str,
    user_id: str = Depends(require_hotel_admin),
):
    """Booking.com only — tells BDC the conversation needs no reply (counts
    toward response-time SLA)."""
    hotel_id = await get_hotel_id(user_id)
    thread = await MessageThreadRepository.get_by_id(thread_id, hotel_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    if thread.get("channel") != "booking.com":
        raise HTTPException(status_code=400, detail="Only available for Booking.com threads")

    api_key = channex_service.get_platform_api_key()
    try:
        await channex_service.mark_thread_no_reply_needed(api_key, thread["source_thread_id"])
    except Exception as e:
        logger.exception("Channex no_reply_needed failed")
        raise HTTPException(status_code=502, detail=f"Channex call failed: {e}") from e

    row = await MessageThreadRepository.update_status(thread_id, hotel_id, "no_reply_needed")
    return await _masked_thread_model(row or thread, hotel_id)


@router.get("/messaging/unread-count", response_model=UnreadCountResponse)
async def unread_count(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    n = await MessageThreadRepository.hotel_unread_count(hotel_id)
    return UnreadCountResponse(unread_count=n)

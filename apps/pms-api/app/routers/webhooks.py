import hashlib
import hmac
import logging
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, HTTPException, Request

from app.config import settings
from app.repositories.affiliate_repo import AffiliateRepository
from app.repositories.booking_draft_repo import BookingDraftRepository
from app.repositories.booking_repo import BookingRepository
from app.repositories.channex_webhook_event_repo import ChannexWebhookEventRepository
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.payment_repo import PaymentRepository
from app.repositories.payout_repo import PayoutRepository
from app.services import stripe_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["webhooks"])


def _webhook_receipt_id(provider: str, payload: bytes) -> str:
    digest = hashlib.sha256(payload).hexdigest()
    return f"legacy:{provider}:{digest}"


async def _proxy_provider_webhook_to_target(
    provider: str, request: Request, payload: bytes
) -> dict:
    target_url = settings.provider_webhook_target_url(provider)
    if not target_url:
        logger.error(
            "Legacy provider webhook proxy requested without target URL provider=%s",
            provider,
        )
        raise HTTPException(status_code=503, detail="Webhook proxy target not configured")

    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in {"host", "content-length"}
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(target_url, content=payload, headers=headers)
    except httpx.RequestError as e:
        logger.exception("Legacy provider webhook proxy failed provider=%s: %s", provider, e)
        raise HTTPException(status_code=502, detail="Webhook proxy failed") from e

    if response.status_code >= 400:
        logger.warning(
            "Legacy provider webhook proxy target rejected provider=%s status=%s",
            provider,
            response.status_code,
        )
        raise HTTPException(status_code=502, detail="Webhook proxy target rejected request")

    logger.info(
        "Legacy provider webhook proxied provider=%s mode=proxy_to_target target_status=%s",
        provider,
        response.status_code,
    )
    return {
        "status": "proxied",
        "mode": "proxy_to_target",
        "provider": provider,
        "target_status": response.status_code,
    }


async def _non_mutating_webhook_response(
    provider: str,
    mode: str,
    request: Request,
    payload: bytes,
    *,
    receipt_id: str | None = None,
) -> dict | None:
    if mode == "mutating":
        return None

    receipt_id = receipt_id or _webhook_receipt_id(provider, payload)
    logger.info(
        "Legacy provider webhook accepted without local mutation provider=%s mode=%s receipt=%s",
        provider,
        mode,
        receipt_id,
    )

    if mode == "ack_only_with_receipt":
        return {
            "status": "accepted",
            "mode": mode,
            "provider": provider,
            "receipt": receipt_id,
        }

    result = await _proxy_provider_webhook_to_target(provider, request, payload)
    result["receipt"] = receipt_id
    return result


async def _materialize_or_get_booking_for_pi(pi_id: str, payment_status: str) -> dict | None:
    """Resolve the booking that a Stripe webhook pertains to.

    With VAY-388 the booking row may not exist yet at the time the first
    Stripe event arrives — the create-booking flow leaves a soft-hold
    draft instead. This helper materializes that draft (idempotently)
    if one exists, otherwise falls back to looking up by an existing
    payment row. Returns None when neither path resolves to a booking.
    """
    draft = await BookingDraftRepository.get_by_payment_intent(pi_id)
    if draft:
        from app.services.booking_service import _complete_materialized_draft, materialize_draft

        booking = await materialize_draft(draft, payment_status=payment_status)
        if booking:
            return booking
        # Lost the race to confirm-authorization — fall through and look
        # up the booking that the other caller just created.

    payment = await PaymentRepository.get_by_stripe_pi(pi_id)
    if payment:
        booking = await BookingRepository.get_by_id(str(payment["booking_id"]))
        if booking and draft:
            return await _complete_materialized_draft(
                draft,
                booking,
                payment_status=payment_status,
                newly_materialized=False,
            )
        return booking
    return None


@router.post("/webhooks/stripe")
async def stripe_webhook(request: Request):
    """Handle platform-account Stripe events during the compatibility window."""
    return await _handle_stripe_webhook(request, settings.STRIPE_WEBHOOK_SECRET)


@router.post("/webhooks/stripe/connect")
async def stripe_connect_webhook(request: Request):
    """Handle events emitted by direct charges on connected accounts."""
    if not settings.STRIPE_CONNECT_WEBHOOK_SECRET:
        raise HTTPException(status_code=503, detail="Connect webhook is not configured")
    return await _handle_stripe_webhook(request, settings.STRIPE_CONNECT_WEBHOOK_SECRET)


async def _handle_stripe_webhook(request: Request, webhook_secret: str):
    payload = await request.body()
    sig = request.headers.get("stripe-signature")

    if not sig:
        raise HTTPException(status_code=400, detail="Missing stripe-signature header")

    try:
        event = stripe_service.construct_webhook_event(payload, sig, webhook_secret)
    except Exception as e:
        logger.warning("Webhook signature verification failed: %s", e)
        raise HTTPException(status_code=400, detail="Invalid signature") from e

    event_type = event["type"]
    data = event["data"]["object"]
    if hasattr(data, "to_dict_recursive"):
        data = data.to_dict_recursive()
    elif hasattr(data, "to_dict"):
        data = data.to_dict()
    mode = settings.provider_webhook_cutover_mode("stripe")
    non_mutating_response = await _non_mutating_webhook_response(
        "stripe",
        mode,
        request,
        payload,
    )
    if non_mutating_response is not None:
        return non_mutating_response

    if event_type == "payment_intent.amount_capturable_updated":
        # Payment authorized (hold placed) — request flow.
        pi_id = data["id"]
        booking = await _materialize_or_get_booking_for_pi(pi_id, "authorized")
        if booking is None:
            logger.warning("PI auth webhook with no draft or payment row: %s", pi_id)
        else:
            payment = await PaymentRepository.get_by_stripe_pi(pi_id)
            if payment and payment["status"] in ("pending", "unpaid"):
                await PaymentRepository.update_status(str(payment["id"]), "authorized")
            if booking.get("payment_status") in (None, "pending", "unpaid"):
                await BookingRepository.update_payment_status(str(booking["id"]), "authorized")
            logger.info("Payment authorized via webhook: %s", pi_id)

    elif event_type == "payment_intent.succeeded":
        # Payment captured — instant-book path (also fires on manual
        # capture later, in which case the booking already exists).
        pi_id = data["id"]
        draft = await BookingDraftRepository.get_by_payment_intent(pi_id)
        booking = await _materialize_or_get_booking_for_pi(pi_id, "captured")
        payment = await PaymentRepository.get_by_stripe_pi(pi_id)

        if booking and payment:
            payment_was_settled = payment["status"] in (
                "captured",
                "refunded",
                "partially_refunded",
            )
            card = (
                data.get("charges", {})
                .get("data", [{}])[0]
                .get("payment_method_details", {})
                .get("card", {})
            )
            if payment["status"] not in ("refunded", "partially_refunded"):
                await PaymentRepository.update_status(
                    str(payment["id"]),
                    "captured",
                    captured_at=payment.get("captured_at") or datetime.now(UTC),
                    card_last_four=card.get("last4"),
                    card_brand=card.get("brand"),
                )
            if booking.get("payment_status") not in (
                "captured",
                "refunded",
                "partially_refunded",
            ):
                await BookingRepository.update_payment_status(str(booking["id"]), "captured")
            logger.info("Payment captured via webhook: %s", pi_id)

            # Send payment confirmation email to guest
            # Draft flows send exactly one request or confirmation email from
            # their frozen completion path. Keep this receipt only for legacy
            # bookings, and only on the captured transition so retries do not
            # duplicate it.
            if not draft and not payment_was_settled and booking.get("guest_email"):
                import asyncio

                from app.services.email_service import send_guest_payment_confirmed

                asyncio.create_task(
                    send_guest_payment_confirmed(
                        booking["guest_email"],
                        booking,
                        float(payment["amount"]),
                        "card",
                    )
                )
        else:
            logger.warning("PI succeeded webhook with no draft or payment row: %s", pi_id)

    elif event_type == "payment_intent.canceled":
        pi_id = data["id"]
        # Drop any pending soft hold so inventory frees up immediately.
        await BookingDraftRepository.delete_by_payment_intent(pi_id)
        payment = await PaymentRepository.get_by_stripe_pi(pi_id)
        if payment:
            await PaymentRepository.update_status(str(payment["id"]), "cancelled")
            logger.info("Payment cancelled via webhook: %s", pi_id)

    elif event_type == "payment_intent.payment_failed":
        pi_id = data["id"]
        # A PaymentIntent remains reusable after a failed payment-method
        # attempt. Keep its draft so the guest can retry the same checkout;
        # only the terminal `payment_intent.canceled` event releases the hold.
        draft = await BookingDraftRepository.get_by_payment_intent(pi_id)
        if draft:
            if draft.get("materialized_booking_id"):
                logger.info("Stale PI failure ignored after draft materialization: %s", pi_id)
            else:
                logger.info("Draft kept for PI payment-method retry: %s", pi_id)
            return {"received": True}
        payment = await PaymentRepository.get_by_stripe_pi(pi_id)
        if payment and payment["status"] in ("pending", "unpaid", "authorized"):
            await PaymentRepository.update_status(str(payment["id"]), "failed")
            await BookingRepository.update_payment_status(str(payment["booking_id"]), "failed")
            logger.info("Payment failed via webhook: %s", pi_id)
        elif payment:
            logger.info(
                "Stale PI failure ignored for payment %s in terminal state %s",
                pi_id,
                payment["status"],
            )

    elif event_type in ("refund.created", "refund.updated", "refund.failed"):
        from app.services.booking_service import reconcile_stripe_refund_event

        refund_id = data["id"]
        if not data.get("status"):
            data["status"] = "failed" if event_type == "refund.failed" else "pending"
        payment = await reconcile_stripe_refund_event(data)
        if payment:
            logger.info("Stripe refund %s reconciled as %s", refund_id, data["status"])
        else:
            raise RuntimeError(f"Stripe refund {refund_id} could not be reconciled")

    elif event_type == "account.updated":
        # Stripe Connect account status update
        account_id = data["id"]
        charges_enabled = data.get("charges_enabled", False)
        if charges_enabled:
            # Mark hotel as onboarded
            from app.database import Database

            row = await Database.fetchrow(
                "SELECT hotel_id FROM hotel_payment_settings WHERE stripe_connect_account_id = $1",
                account_id,
            )
            if row:
                await HotelPaymentSettingsRepository.upsert(
                    str(row["hotel_id"]),
                    {"stripe_connect_onboarded": True},
                )
                logger.info("Stripe Connect account onboarded (hotel): %s", account_id)
            else:
                # Check if this is an affiliate Connect account
                affiliate = await AffiliateRepository.get_by_stripe_account_id(account_id)
                if affiliate:
                    await AffiliateRepository.mark_stripe_onboarded(account_id)
                    logger.info("Stripe Connect account onboarded (affiliate): %s", account_id)

    return {"status": "ok"}


@router.post("/webhooks/xendit")
async def xendit_webhook(request: Request):
    """Handle Xendit webhook events for payouts and invoice payments."""
    payload = await request.body()
    callback_token = request.headers.get("x-callback-token")

    if not callback_token:
        raise HTTPException(status_code=400, detail="Missing x-callback-token header")

    if not hmac.compare_digest(callback_token, settings.XENDIT_WEBHOOK_SECRET):
        logger.warning("Xendit webhook token verification failed")
        raise HTTPException(status_code=400, detail="Invalid callback token")

    import json

    data = json.loads(payload)
    event_type = data.get("event")
    mode = settings.provider_webhook_cutover_mode("xendit")
    non_mutating_response = await _non_mutating_webhook_response(
        "xendit",
        mode,
        request,
        payload,
    )
    if non_mutating_response is not None:
        return non_mutating_response

    # ── Invoice callbacks (payment acceptance) ────────────────────
    # Xendit Invoice callbacks have top-level "id", "status", "external_id"
    if data.get("external_id") and data.get("id") and not event_type:
        await _handle_invoice_callback(data)
        return {"status": "ok"}

    # ── Payout callbacks ─────────────────────────────────────────
    payout_data = data.get("data", {})
    xendit_payout_id = payout_data.get("id")
    status = payout_data.get("status")

    if not xendit_payout_id:
        return {"status": "ok"}

    if event_type == "payout.succeeded" or status == "SUCCEEDED":
        from app.database import Database
        from app.repositories.affiliate_repo import AffiliateRepository
        from app.services.email_service import send_affiliate_payout_notification

        row = await Database.fetchrow(
            "SELECT id, recipient_type, recipient_id, amount, currency FROM payouts WHERE xendit_payout_id = $1",
            xendit_payout_id,
        )
        if row:
            await PayoutRepository.update_status(
                str(row["id"]), "completed", xendit_payout_id=xendit_payout_id
            )
            logger.info("Xendit payout completed: %s", xendit_payout_id)

            if row["recipient_type"] == "affiliate":
                affiliate = await AffiliateRepository.get_by_id(str(row["recipient_id"]))
                if affiliate:
                    await send_affiliate_payout_notification(
                        affiliate_email=affiliate["email"],
                        affiliate_name=affiliate["full_name"],
                        payout_amount=float(row["amount"]),
                        currency=row["currency"],
                        payout_method="xendit",
                    )

    elif event_type == "payout.failed" or status == "FAILED":
        from app.database import Database

        row = await Database.fetchrow(
            "SELECT id FROM payouts WHERE xendit_payout_id = $1",
            xendit_payout_id,
        )
        if row:
            await PayoutRepository.update_status(str(row["id"]), "failed")
            logger.warning("Xendit payout failed: %s", xendit_payout_id)

    return {"status": "ok"}


async def _handle_invoice_callback(data: dict):
    """Handle Xendit Invoice payment callback (guest paid via QRIS/ewallet/VA)."""
    import asyncio

    xendit_invoice_id = data.get("id")
    invoice_status = data.get("status")
    payment_method = data.get("payment_method")
    payment_channel = data.get("payment_channel")

    payment = await PaymentRepository.get_by_xendit_invoice(xendit_invoice_id)
    if not payment:
        logger.warning("No payment found for Xendit invoice %s", xendit_invoice_id)
        return

    payment_id = str(payment["id"])
    booking_id = str(payment["booking_id"])

    if invoice_status == "PAID":
        # Guest has paid — mark payment as captured.
        await PaymentRepository.update_status(payment_id, "captured")
        await BookingRepository.update_payment_status(booking_id, "authorized")

        booking = await BookingRepository.get_by_id(booking_id)
        if booking:
            from app.database import Database

            hotel = await Database.fetchrow(
                "SELECT contact_email, instant_book FROM hotels WHERE id = $1",
                booking["hotel_id"],
            )
            if hotel and hotel.get("instant_book") and booking["status"] == "pending":
                # Skip the request flow; finalize and email guest+host as accepted.
                from app.services.booking_service import _finalize_accepted_booking

                try:
                    await _finalize_accepted_booking(booking_id, capture_card=False)
                except Exception as e:
                    logger.error("Instant-book finalize failed for %s: %s", booking_id, e)
            elif hotel:
                # Request flow — notify host to accept/reject
                from app.services.email_service import send_booking_request_notification

                asyncio.create_task(
                    send_booking_request_notification(hotel["contact_email"], booking)
                )

        # Send payment confirmation email to guest
        if booking and booking.get("guest_email"):
            from app.services.email_service import send_guest_payment_confirmed

            xendit_label = (
                f"{payment_method}/{payment_channel}"
                if payment_channel
                else (payment_method or "xendit")
            )
            asyncio.create_task(
                send_guest_payment_confirmed(
                    booking["guest_email"],
                    booking,
                    float(payment["amount"]),
                    xendit_label,
                )
            )

        logger.info(
            "Xendit invoice paid: %s method=%s channel=%s booking=%s",
            xendit_invoice_id,
            payment_method,
            payment_channel,
            booking_id,
        )

    elif invoice_status == "EXPIRED":
        await PaymentRepository.update_status(payment_id, "cancelled")
        await BookingRepository.cancel_with_promo_reversal(
            booking_id,
            payment_status="cancelled",
        )
        logger.info("Xendit invoice expired: %s booking=%s", xendit_invoice_id, booking_id)

    else:
        logger.debug("Xendit invoice status %s for %s", invoice_status, xendit_invoice_id)


@router.post("/webhooks/channex")
async def channex_webhook(request: Request):
    """Handle Channex webhook events. Channex doesn't sign webhooks natively —
    we register the webhook with a custom X-Vayada-Webhook-Token header set to
    settings.CHANNEX_WEBHOOK_SECRET, and verify it here.

    Phase 1 only handles the `message` event; other events are logged but not
    processed yet (see /admin/channex/webhook-events/summary)."""
    if not settings.CHANNEX_WEBHOOK_SECRET:
        logger.error("Channex webhook hit but CHANNEX_WEBHOOK_SECRET not configured")
        raise HTTPException(status_code=503, detail="Webhook not configured")

    token = request.headers.get("x-vayada-webhook-token", "")
    if not hmac.compare_digest(token, settings.CHANNEX_WEBHOOK_SECRET):
        logger.warning("Channex webhook auth failed (token mismatch)")
        raise HTTPException(status_code=401, detail="Invalid webhook token")

    import json

    payload = await request.body()
    try:
        event = json.loads(payload)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail="Invalid JSON") from e

    event_type = event.get("event") or "unknown"
    event_payload = event.get("payload") or {}
    property_id = event.get("property_id") or event_payload.get("property_id")

    mode = settings.provider_webhook_cutover_mode("channex")
    non_mutating_response = await _non_mutating_webhook_response(
        "channex",
        mode,
        request,
        payload,
    )
    if non_mutating_response is not None:
        return non_mutating_response

    # Always log the receipt — gives us "did the message webhook fire today?"
    # observability now that the safety-net poll is gone.
    try:
        event_id = await ChannexWebhookEventRepository.insert(
            event_type=event_type,
            property_id=str(property_id) if property_id else None,
            payload=event,
        )
    except Exception as e:
        # Never let logging failure break webhook ingest — Channel retries
        # cause cascading volume.
        logger.exception("Failed to log Channex webhook event: %s", e)
        event_id = None

    if event_type == "message":
        from app.services.channex.messaging import process_inbound_message_event

        ok, err = True, None
        try:
            await process_inbound_message_event(event_payload, event)
        except Exception as e:
            logger.exception("Failed to process Channex message event: %s", e)
            ok, err = False, str(e)[:500]
        if event_id:
            try:
                await ChannexWebhookEventRepository.mark_processed(event_id, ok, err)
            except Exception:
                logger.exception("Failed to mark Channex webhook event processed")
        # Still 200 even on failure — Channex retries indefinitely otherwise.
        return {"status": "ok" if ok else "error_logged"}

    logger.debug("Ignoring Channex webhook event=%r", event_type)
    return {"status": "ignored", "event": event_type}

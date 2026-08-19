"""Unit tests for the host/ops booking-request lifecycle email renderer."""

from unittest.mock import AsyncMock, patch

import pytest
from app.services import email_service
from app.services.email_service import (
    _email_message_id,
    _render_request_status_email,
    send_booking_request_notification,
    send_guest_booking_accepted,
    send_guest_booking_expired,
    send_guest_booking_rejected,
    send_guest_booking_requested,
    send_guest_booking_withdrawn,
    send_guest_payment_confirmed,
    send_host_booking_accepted,
    send_host_booking_expired,
    send_host_booking_rejected,
    send_host_booking_withdrawn,
    send_host_guest_cancelled,
)
from app.services.guest_contact_access import HIDDEN_GUEST_CONTACT

BOOKING = {
    "id": "booking-uuid-1",
    "booking_reference": "VAY-ABC123",
    "hotel_name": "Hotel Sunshine",
    "hotel_slug": "hotel-sunshine",
    "guest_first_name": "Alice",
    "guest_last_name": "Smith",
    "guest_email": "alice@example.com",
    "payment_method": "card",
    "room_name": "Deluxe Suite",
    "check_in": "2026-06-01",
    "check_out": "2026-06-04",
    "adults": 2,
    "children": 1,
    "addon_names": ["Breakfast", "Airport pickup"],
    "currency": "USD",
    "total_amount": 450.00,
}


def test_email_message_id_is_stable_for_delivery_retries():
    first = _email_message_id("guest@example.com", "Confirmed", "<p>Booked</p>")
    retry = _email_message_id("guest@example.com", "Confirmed", "<p>Booked</p>")
    different_recipient = _email_message_id("host@example.com", "Confirmed", "<p>Booked</p>")

    assert first == retry
    assert first != different_recipient


def _shared_assertions(subject: str, html: str, expected_headline: str):
    """Every status email must contain the canonical detail block."""
    assert expected_headline in html
    assert f"<h2>{expected_headline}</h2>" in html
    assert "Hotel Sunshine" in html
    assert "Alice Smith" in html
    assert "alice@example.com" in html
    assert "Card (authorization hold)" in html
    assert "VAY-ABC123" in html
    assert "Deluxe Suite" in html
    assert "2026-06-01" in html
    assert "2026-06-04" in html
    assert "2 adults, 1 children" in html
    assert "Breakfast, Airport pickup" in html
    assert "USD 450.0" in html


def test_render_pending_has_full_structure_and_24h_alert():
    subject, html = _render_request_status_email(BOOKING, "pending")
    assert subject == "New Booking Request: Hotel Sunshine — VAY-ABC123"
    _shared_assertions(subject, html, "New Booking Request")
    assert "24 hours" in html
    assert "Review &amp; Respond" in html


def test_render_accepted():
    subject, html = _render_request_status_email(BOOKING, "accepted")
    assert subject == "Booking Confirmed: Hotel Sunshine — VAY-ABC123"
    _shared_assertions(subject, html, "Booking Confirmed")
    assert "Payment has been captured" in html


def test_render_accepted_pay_at_property():
    booking = {**BOOKING, "payment_method": "pay_at_property"}
    _, html = _render_request_status_email(booking, "accepted")
    assert "guest will pay at the property" in html.lower()
    assert "Pay at property" in html


def test_render_declined():
    subject, html = _render_request_status_email(BOOKING, "declined")
    assert subject == "Booking Request Declined: Hotel Sunshine — VAY-ABC123"
    _shared_assertions(subject, html, "Booking Request Declined")
    assert "declined the request" in html.lower()


def test_render_cancelled():
    subject, html = _render_request_status_email(BOOKING, "cancelled")
    assert subject == "Booking Request Cancelled: Hotel Sunshine — VAY-ABC123"
    _shared_assertions(subject, html, "Booking Request Cancelled")
    assert "available for new bookings" in html


def test_render_expired():
    subject, html = _render_request_status_email(BOOKING, "expired")
    assert subject == "Booking Request Expired: Hotel Sunshine — VAY-ABC123"
    _shared_assertions(subject, html, "Booking Request Expired")
    assert "24 hours" in html


def test_render_unknown_status_raises():
    with pytest.raises(ValueError):
        _render_request_status_email(BOOKING, "bogus")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "sender,expected_headline",
    [
        (send_booking_request_notification, "New Booking Request"),
        (send_host_booking_accepted, "Booking Confirmed"),
        (send_host_booking_rejected, "Booking Request Declined"),
        (send_host_booking_withdrawn, "Booking Request Cancelled"),
        (send_host_guest_cancelled, "Booking Request Cancelled"),
        (send_host_booking_expired, "Booking Request Expired"),
    ],
)
async def test_host_emails_cc_ops_recipients(sender, expected_headline):
    """Every host-facing lifecycle email must be CC'd to the Vayada ops list."""
    sent = []

    async def fake_send(to, subject, html_body, reply_to=None):
        sent.append((to, subject, html_body))

    with (
        patch.object(email_service, "_send_email", side_effect=fake_send),
        patch.object(email_service.settings, "VAYADA_OPS_EMAIL", "ops@vayada.com"),
    ):
        if sender is send_host_booking_rejected:
            await sender("host@example.com", BOOKING, reason="No availability")
        else:
            await sender("host@example.com", BOOKING)

    recipients = [to for (to, _s, _h) in sent]
    assert "host@example.com" in recipients
    assert "ops@vayada.com" in recipients
    assert "p.paetzold@vayada.com" in recipients
    assert "t.schreyer@vayada.com" in recipients
    # Same body delivered to every recipient
    bodies = {html for (_t, _s, html) in sent}
    assert len(bodies) == 1
    assert f"<h2>{expected_headline}</h2>" in bodies.pop()


@pytest.mark.asyncio
async def test_guest_bank_transfer_request_email_includes_full_bank_details():
    sent = []
    booking = {
        **BOOKING,
        "payment_method": "bank_transfer",
        "bank_details": {
            "payout_bank_name": "Vayada Bank",
            "payout_account_holder": "Hotel Sunshine GmbH",
            "payout_account_type": "iban",
            "payout_iban": "DE89370400440532013000",
            "payout_swift": "VAYADEF0",
        },
    }

    async def fake_send(to, subject, html_body, reply_to=None):
        sent.append((to, subject, html_body))

    with patch.object(email_service, "_send_email", side_effect=fake_send):
        await send_guest_booking_requested("alice@example.com", booking)

    assert len(sent) == 1
    html = sent[0][2]
    assert "Bank Transfer Details" in html
    assert "Vayada Bank" in html
    assert "Hotel Sunshine GmbH" in html
    assert "DE89370400440532013000" in html
    assert "VAYADEF0" in html
    assert "VAY-ABC123" in html
    assert "Your booking will be confirmed once we verify the payment." in html
    assert "once the hotel verifies the payment" not in html


@pytest.mark.asyncio
async def test_guest_booking_request_email_uses_property_voice():
    sent = []

    async def fake_send(to, subject, html_body, reply_to=None):
        sent.append((to, subject, html_body))

    with patch.object(email_service, "_send_email", side_effect=fake_send):
        await send_guest_booking_requested("alice@example.com", BOOKING)

    html = sent[0][2]
    assert "We'll review your request and respond" in html
    assert "once we respond" in html
    assert "The host will review" not in html
    assert "once the host responds" not in html


@pytest.mark.asyncio
async def test_guest_paypal_request_email_uses_property_voice():
    sent = []
    booking = {
        **BOOKING,
        "payment_method": "paypal",
        "paypal_email": "pay@hotel.example",
        "host_response_deadline": "2026-06-02T12:00:00Z",
    }

    async def fake_send(to, subject, html_body, reply_to=None):
        sent.append((to, subject, html_body))

    with patch.object(email_service, "_send_email", side_effect=fake_send):
        await send_guest_booking_requested("alice@example.com", booking)

    html = sent[0][2]
    assert "so we can match it" in html
    assert "We'll confirm your booking once we verify the payment" in html
    assert "so the property can match it" not in html
    assert "The property will confirm" not in html


@pytest.mark.asyncio
async def test_guest_lifecycle_emails_use_property_voice():
    sent = []

    async def fake_send(to, subject, html_body, reply_to=None):
        sent.append((subject, html_body))

    with patch.object(email_service, "_send_email", side_effect=fake_send):
        await send_guest_booking_accepted("alice@example.com", BOOKING)
        await send_guest_booking_rejected("alice@example.com", BOOKING)
        await send_guest_booking_expired("alice@example.com", BOOKING)
        await send_guest_payment_confirmed("alice@example.com", BOOKING, 450.0, "card")

    html = "\n".join(body for (_subject, body) in sent)
    assert "we have accepted your booking" in html
    assert "we declined your booking request" in html
    assert "because we did not respond" in html
    assert "once we review your booking" in html
    assert "accepted by the host" not in html
    assert "declined by the host" not in html
    assert "because the host did not respond" not in html
    assert "once the host reviews" not in html


@pytest.mark.asyncio
async def test_closed_captured_request_email_says_payment_was_refunded():
    sent = []

    async def fake_send(to, subject, html_body, reply_to=None):
        sent.append(html_body)

    refunded_booking = {
        **BOOKING,
        "payment_status": "refunded",
        "deposit_required": True,
        "deposit_amount": 225,
        "balance_amount": 225,
    }
    with patch.object(email_service, "_send_email", side_effect=fake_send):
        await send_guest_booking_rejected("alice@example.com", refunded_booking)
        await send_guest_booking_withdrawn("alice@example.com", refunded_booking)
        await send_guest_booking_expired("alice@example.com", refunded_booking)

    guest_html = "\n".join(sent)
    host_html = "\n".join(
        _render_request_status_email(refunded_booking, event)[1]
        for event in ("declined", "cancelled", "expired")
    )
    assert guest_html.count("Your card payment has been refunded.") == 3
    assert host_html.count("The captured card deposit has been refunded.") == 3
    assert "Deposit refunded" in guest_html
    assert "Deposit refunded" in host_html
    assert "authorization hold" not in guest_html
    assert "authorization hold" not in host_html


@pytest.mark.asyncio
async def test_no_duplicate_when_host_email_matches_ops_email():
    """If the hotel contact_email is the same as an ops recipient, don't double-send."""
    sent = []

    async def fake_send(to, subject, html_body, reply_to=None):
        sent.append(to)

    with (
        patch.object(email_service, "_send_email", side_effect=fake_send),
        patch.object(email_service.settings, "VAYADA_OPS_EMAIL", "host@example.com"),
    ):
        await send_booking_request_notification("host@example.com", BOOKING)

    # host@example.com appears exactly once (deduplicated against ops list)
    assert sent.count("host@example.com") == 1


@pytest.mark.asyncio
async def test_missing_hotel_email_still_sends_to_ops():
    sent = []

    async def fake_send(to, subject, html_body, reply_to=None):
        sent.append(to)

    with (
        patch.object(email_service, "_send_email", side_effect=fake_send),
        patch.object(email_service.settings, "VAYADA_OPS_EMAIL", "ops@vayada.com"),
    ):
        await send_booking_request_notification("", BOOKING)

    assert "" not in sent
    assert "ops@vayada.com" in sent


# ── Reply-To on direct Booking Engine "New Booking Request" (VAY-502) ──


@pytest.mark.asyncio
async def test_booking_request_sets_reply_to_guest_email():
    """Fixed-plan hosts may reply directly to the guest before acceptance."""
    sent = []

    async def fake_send(to, subject, html_body, reply_to=None):
        sent.append((to, reply_to))

    with (
        patch.object(email_service, "_send_email", side_effect=fake_send),
        patch.object(email_service, "_booking_for_host", AsyncMock(return_value=BOOKING)),
        patch.object(email_service.settings, "VAYADA_OPS_EMAIL", "ops@vayada.com"),
    ):
        await send_booking_request_notification("host@example.com", BOOKING)

    # Every recipient (host + ops) gets Reply-To set to the guest.
    assert sent, "no emails sent"
    assert all(reply_to == "alice@example.com" for (_to, reply_to) in sent)


@pytest.mark.asyncio
async def test_commission_booking_request_masks_body_and_reply_to():
    sent = []
    booking = {**BOOKING, "hotel_id": "hotel-1", "status": "pending"}

    async def fake_send(to, subject, html_body, reply_to=None):
        sent.append((html_body, reply_to))

    with (
        patch.object(email_service, "_send_email", side_effect=fake_send),
        patch.object(
            email_service,
            "fetch_guest_contact_plan",
            AsyncMock(return_value="commission"),
        ),
        patch.object(email_service.settings, "VAYADA_OPS_EMAIL", "ops@vayada.com"),
    ):
        await send_booking_request_notification("host@example.com", booking)

    assert sent
    assert all(HIDDEN_GUEST_CONTACT in html for html, _reply_to in sent)
    assert all("alice@example.com" not in html for html, _reply_to in sent)
    assert all(reply_to == "ops@vayada.com" for _html, reply_to in sent)


@pytest.mark.asyncio
async def test_commission_host_email_keeps_contact_revealed_after_cancellation():
    sent = []
    booking = {
        **BOOKING,
        "hotel_id": "hotel-1",
        "status": "cancelled",
        "contact_details_revealed_at": "2026-06-01T12:00:00Z",
    }

    async def fake_send(to, subject, html_body, reply_to=None):
        sent.append(html_body)

    with (
        patch.object(email_service, "_send_email", side_effect=fake_send),
        patch.object(
            email_service,
            "fetch_guest_contact_plan",
            AsyncMock(return_value="commission"),
        ),
    ):
        await send_host_guest_cancelled("host@example.com", booking)

    assert sent
    assert all("alice@example.com" in html for html in sent)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_email", [None, "", "   ", "not-an-email", "missing@nodot", "a b@c.com"]
)
async def test_booking_request_falls_back_to_ops_when_guest_email_invalid(bad_email, caplog):
    """Don't silently route Reply to noreply@ when the guest email is bad."""
    sent = []

    async def fake_send(to, subject, html_body, reply_to=None):
        sent.append((to, reply_to))

    booking = {**BOOKING, "guest_email": bad_email}

    with (
        patch.object(email_service, "_send_email", side_effect=fake_send),
        patch.object(email_service.settings, "VAYADA_OPS_EMAIL", "ops@vayada.com"),
        caplog.at_level("WARNING", logger="app.services.email_service"),
    ):
        await send_booking_request_notification("host@example.com", booking)

    assert sent, "no emails sent"
    assert all(reply_to == "ops@vayada.com" for (_to, reply_to) in sent)
    assert any("missing/invalid guest_email" in rec.message for rec in caplog.records)


@pytest.mark.asyncio
async def test_other_host_lifecycle_emails_do_not_set_reply_to():
    """Reply-To override is scoped to the pending notification only —
    accepted/declined/cancelled/expired emails keep the default behavior."""
    sent = []

    async def fake_send(to, subject, html_body, reply_to=None):
        sent.append((to, reply_to))

    with (
        patch.object(email_service, "_send_email", side_effect=fake_send),
        patch.object(email_service.settings, "VAYADA_OPS_EMAIL", "ops@vayada.com"),
    ):
        await send_host_booking_accepted("host@example.com", BOOKING)
        await send_host_booking_rejected("host@example.com", BOOKING, reason="full")
        await send_host_booking_withdrawn("host@example.com", BOOKING)
        await send_host_booking_expired("host@example.com", BOOKING)
        await send_host_guest_cancelled("host@example.com", BOOKING)

    assert sent
    assert all(reply_to is None for (_to, reply_to) in sent)


@pytest.mark.asyncio
async def test_send_email_writes_reply_to_header():
    """The MIME message must carry a Reply-To header when one is provided."""
    captured = {}

    class _FakeAioSmtplib:
        async def send(self, msg, **_kwargs):
            captured["msg"] = msg

    fake_module = _FakeAioSmtplib()

    import sys

    with (
        patch.object(email_service.settings, "SMTP_HOST", "smtp.example.com"),
        patch.object(email_service.settings, "SMTP_PORT", 587),
        patch.object(email_service.settings, "SMTP_USERNAME", "u"),
        patch.object(email_service.settings, "SMTP_PASSWORD", "p"),
        patch.object(email_service.settings, "SMTP_USE_TLS", True),
        patch.object(email_service.settings, "SMTP_FROM", "noreply@vayada.com"),
        patch.dict(sys.modules, {"aiosmtplib": fake_module}),
    ):
        await email_service._send_email(
            "host@example.com", "subj", "<p>body</p>", reply_to="guest@example.com"
        )

    msg = captured.get("msg")
    assert msg is not None
    assert msg["Reply-To"] == "guest@example.com"
    assert msg["From"] == "noreply@vayada.com"

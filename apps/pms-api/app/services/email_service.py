import json
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from urllib.parse import quote, urlparse

from app.channels import channel_label as _ota_channel_label  # re-exported for tests
from app.config import settings

logger = logging.getLogger(__name__)

STYLE = """
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background: #f4f4f7; }
  .wrapper { max-width: 600px; margin: 0 auto; padding: 24px; }
  .card { background: #ffffff; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  h2 { color: #1a1a2e; margin-top: 0; font-size: 22px; }
  .detail { margin: 6px 0; color: #333; font-size: 15px; line-height: 1.6; }
  .detail strong { color: #1a1a2e; }
  .divider { border: none; border-top: 1px solid #e8e8ed; margin: 20px 0; }
  .btn { display: inline-block; padding: 12px 28px; background: #1a1a2e; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; margin-top: 16px; }
  .btn-accept { background: #16a34a; }
  .btn-reject { background: #dc2626; margin-left: 12px; }
  .footer { text-align: center; color: #888; font-size: 12px; margin-top: 24px; }
  .alert { background: #fef3c7; border: 1px solid #fbbf24; border-radius: 6px; padding: 12px 16px; margin: 16px 0; font-size: 14px; color: #92400e; }
</style>
"""


def _my_booking_url(booking: dict, guest_email: str | None = None) -> str | None:
    slug = booking.get("hotel_slug")
    reference = booking.get("booking_reference")
    if not slug or not reference:
        return None
    parsed = urlparse(settings.BOOKING_ENGINE_URL)
    base = f"{parsed.scheme}://{slug}.{parsed.netloc}/booking/{reference}"
    # Append the guest email so the confirmation page can hydrate booking
    # details via the lookup endpoint when the guest opens the link on a
    # different device than they booked from (sessionStorage is per-tab and
    # otherwise leaves all fields blank).
    if guest_email:
        return f"{base}?email={quote(guest_email, safe='')}"
    return base


def _my_booking_button_html(booking: dict, guest_email: str | None = None) -> str:
    url = _my_booking_url(booking, guest_email)
    if not url:
        return ""
    return f"""
    <hr class="divider">
    <a href="{url}" class="btn">View My Booking</a>
    """


def _wrap_html(content: str) -> str:
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">{STYLE}</head>
<body><div class="wrapper"><div class="card">{content}</div>
<p class="footer">vayada &mdash; Hotel Management Platform</p>
</div></body></html>"""


def _booking_details_html(booking: dict) -> str:
    addon_names = booking.get("addon_names") or []
    if isinstance(addon_names, str):
        addon_names = json.loads(addon_names)
    addons_html = ""
    if addon_names:
        addons_list = ", ".join(addon_names)
        addons_html = f'\n    <p class="detail"><strong>Add-ons:</strong> {addons_list}</p>'
    # VAY-403: a multi-room booking must read "2× Two-Bedroom Pool Villa",
    # not a bare singular, so the guest/host see how many rooms are booked.
    rooms = int(booking.get("number_of_rooms") or 1)
    accommodation = f"{rooms}× {booking['room_name']}" if rooms > 1 else booking["room_name"]
    deposit_html = ""
    if booking.get("deposit_required"):
        deposit_status = (
            "Deposit paid"
            if booking.get("payment_status") in ("captured", "refunded", "partially_refunded")
            else "Deposit pending"
        )
        deposit_html = f"""
    <p class="detail"><strong>{deposit_status}:</strong> {booking["currency"]} {float(booking.get("deposit_amount", 0)):.2f}</p>
    <p class="detail"><strong>Remaining balance:</strong> {booking["currency"]} {float(booking.get("balance_amount", 0)):.2f} — due at the property upon check-in</p>
    """
    return f"""
    <p class="detail"><strong>Reference:</strong> {booking["booking_reference"]}</p>
    <p class="detail"><strong>Accommodation:</strong> {accommodation}</p>
    <p class="detail"><strong>Check-in:</strong> {booking["check_in"]}</p>
    <p class="detail"><strong>Check-out:</strong> {booking["check_out"]}</p>
    <p class="detail"><strong>Guests:</strong> {booking["adults"]} adults, {booking["children"]} children</p>{addons_html}
    <p class="detail"><strong>Total:</strong> {booking["currency"]} {booking["total_amount"]}</p>{deposit_html}
    """


async def _send_email(to: str, subject: str, html_body: str, reply_to: str | None = None):
    if not settings.SMTP_HOST:
        logger.debug("SMTP not configured — skipping email to %s", to)
        return

    try:
        import aiosmtplib

        msg = MIMEMultipart("alternative")
        msg["From"] = settings.SMTP_FROM
        msg["To"] = to
        msg["Subject"] = subject
        if reply_to:
            msg["Reply-To"] = reply_to
        msg.attach(MIMEText(html_body, "html"))

        await aiosmtplib.send(
            msg,
            hostname=settings.SMTP_HOST,
            port=settings.SMTP_PORT,
            username=settings.SMTP_USERNAME or None,
            password=settings.SMTP_PASSWORD or None,
            # IMPORTANT: port 587 requires start_tls (STARTTLS), NOT use_tls
            # (direct TLS for port 465). Do not change this to use_tls.
            start_tls=settings.SMTP_USE_TLS,
        )
        logger.info("Email sent to %s: %s", to, subject)
    except Exception as e:
        logger.warning("Failed to send email to %s: %s", to, e)


async def send_guest_confirmation(guest_email: str, booking: dict):
    subject = f"Booking Confirmed — {booking['booking_reference']}"
    content = f"""
    <h2>Your Booking is Confirmed!</h2>
    <p class="detail">Great news — we have confirmed your booking at <strong>{booking["hotel_name"]}</strong>.</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">You can look up your booking anytime using your reference number and email address.</p>
    {_my_booking_button_html(booking, guest_email)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_guest_cancellation(guest_email: str, booking: dict):
    subject = f"Booking Cancelled — {booking['booking_reference']}"
    content = f"""
    <h2>Booking Cancelled</h2>
    <p class="detail">Unfortunately, your booking at <strong>{booking["hotel_name"]}</strong> has been cancelled.</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">If you have any questions, please contact us directly.</p>
    {_my_booking_button_html(booking, guest_email)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


# ── Host + ops booking-request lifecycle emails ─────────────────────
#
# All host-facing booking-request notifications share one structure: a status
# headline, the full booking detail block (hotel, guest, email, payment,
# reference, accommodation, dates, guests, addons, total), and a CTA back into
# the PMS. Every host email is also CC'd to the Vayada ops team so we have a
# single inbox view of every request's lifecycle.
#
# Idempotence: the booking_service transition functions (host_accept,
# host_reject, expire_booking, guest_withdraw_booking, handle_guest_cancellation)
# all gate on the current status before transitioning, and the expire
# scheduler filters on `status='pending'`. A booking can only ever land in one
# terminal state, so exactly one terminal-status email fires per booking.


_PAYMENT_LABELS = {
    "card": "Card (authorization hold)",
    "pay_at_property": "Pay at property",
    "bank_transfer": "Bank transfer",
    "paypal": "PayPal",
    "xendit": "Online payment (Xendit)",
}


def _payment_label(booking: dict) -> str:
    method = booking.get("payment_method", "card")
    return _PAYMENT_LABELS.get(method, method)


def _render_request_status_email(booking: dict, status_event: str) -> tuple[str, str]:
    """Build (subject, html) for a host/ops booking-request lifecycle email.

    status_event is one of: pending, accepted, declined, cancelled, expired.
    """
    booking_id = booking.get("id", "")
    pms_link = f"https://pms.vayada.com/bookings/{booking_id}"
    guest_name = (
        f"{booking.get('guest_first_name', '')} {booking.get('guest_last_name', '')}".strip()
    )
    ref = booking["booking_reference"]
    hotel_name = booking["hotel_name"]

    if status_event == "pending":
        headline = "New Booking Request"
        subject = f"New Booking Request: {hotel_name} — {ref}"
        trailing = f"""
    <div class="alert">
        You have <strong>24 hours</strong> to accept or reject this booking.
        If no action is taken, the booking will expire automatically.
    </div>
    <hr class="divider">
    <a href="{pms_link}" class="btn btn-accept">Review &amp; Respond</a>
    """
    elif status_event == "accepted":
        headline = "Booking Confirmed"
        subject = f"Booking Confirmed: {hotel_name} — {ref}"
        payment_method = booking.get("payment_method", "card")
        payment_note = (
            "Payment has been captured."
            if payment_method == "card"
            else "The guest will pay at the property."
        )
        trailing = f"""
    <p class="detail">{payment_note}</p>
    <hr class="divider">
    <a href="{pms_link}" class="btn">View in PMS</a>
    """
    elif status_event == "declined":
        headline = "Booking Request Declined"
        subject = f"Booking Request Declined: {hotel_name} — {ref}"
        trailing = f"""
    <p class="detail">You declined the request from <strong>{guest_name}</strong>. Any payment hold has been released.</p>
    <hr class="divider">
    <a href="{pms_link}" class="btn">View in PMS</a>
    """
    elif status_event == "cancelled":
        headline = "Booking Request Cancelled"
        subject = f"Booking Request Cancelled: {hotel_name} — {ref}"
        trailing = f"""
    <p class="detail">The room is now available for new bookings. No action is required on your part.</p>
    <hr class="divider">
    <a href="{pms_link}" class="btn">View in PMS</a>
    """
    elif status_event == "expired":
        headline = "Booking Request Expired"
        subject = f"Booking Request Expired: {hotel_name} — {ref}"
        trailing = f"""
    <div class="alert">
        This request expired because no action was taken within 24 hours.
        Please review and respond to booking requests promptly to avoid losing potential guests.
    </div>
    <hr class="divider">
    <a href="{pms_link}" class="btn">View in PMS</a>
    """
    else:
        raise ValueError(f"Unknown status_event: {status_event}")

    content = f"""
    <h2>{headline}</h2>
    <p class="detail"><strong>Hotel:</strong> {hotel_name}</p>
    <p class="detail"><strong>Guest:</strong> {guest_name}</p>
    <p class="detail"><strong>Email:</strong> {booking["guest_email"]}</p>
    <p class="detail"><strong>Payment:</strong> {_payment_label(booking)}</p>
    {_booking_details_html(booking)}{trailing}"""
    return subject, _wrap_html(content)


async def _send_to_host_and_ops(
    hotel_email: str, subject: str, html_body: str, reply_to: str | None = None
):
    """Send to the hotel host and the Vayada ops watchlist."""
    if hotel_email:
        await _send_email(hotel_email, subject, html_body, reply_to=reply_to)
    ops_recipients = [
        settings.VAYADA_OPS_EMAIL,
        "p.paetzold@vayada.com",
        "t.schreyer@vayada.com",
    ]
    for recipient in ops_recipients:
        if recipient and recipient != hotel_email:
            await _send_email(recipient, subject, html_body, reply_to=reply_to)


def _looks_like_email(value: str | None) -> bool:
    if not value or not isinstance(value, str):
        return False
    value = value.strip()
    if "@" not in value or " " in value:
        return False
    local, _, domain = value.rpartition("@")
    return bool(local) and "." in domain


def _booking_request_reply_to(booking: dict) -> str:
    """Reply-To for the host's "New Booking Request" email so a plain Reply
    in the host's mail client reaches the guest, not the unmonitored
    noreply@ inbox. Falls back to the monitored ops address (and logs)
    when the guest email is missing or malformed, so a reply is never
    silently lost. From stays noreply@; Reply-To doesn't affect SPF/DKIM/DMARC."""
    guest_email = booking.get("guest_email")
    if _looks_like_email(guest_email):
        return guest_email.strip()
    logger.warning(
        "Booking %s has missing/invalid guest_email (%r); falling back to %s for Reply-To",
        booking.get("booking_reference") or booking.get("id"),
        guest_email,
        settings.VAYADA_OPS_EMAIL,
    )
    return settings.VAYADA_OPS_EMAIL


def _bank_transfer_details_html(booking: dict) -> str:
    details = booking.get("bank_details") or {}
    if booking.get("payment_method") != "bank_transfer" or not details:
        return ""

    from html import escape

    account_type = details.get("payout_account_type") or details.get("account_type") or "iban"
    account_label = "Account Number" if account_type == "account_number" else "IBAN"
    if account_type == "account_number":
        account_value = details.get("payout_account_number") or details.get("account_number")
    else:
        account_value = details.get("payout_iban") or details.get("iban")
    rows = [
        ("Bank", details.get("payout_bank_name") or details.get("bank_name")),
        ("Account Holder", details.get("payout_account_holder") or details.get("account_holder")),
        (account_label, account_value),
        ("BIC/SWIFT", details.get("payout_swift") or details.get("swift")),
    ]
    rows_html = "\n".join(
        f'<p class="detail"><strong>{label}:</strong> {escape(str(value).strip())}</p>'
        for label, value in rows
        if str(value or "").strip()
    )
    if not rows_html:
        return ""
    reference = escape(str(booking.get("booking_reference") or ""))
    amount = escape(f"{booking.get('currency', '')} {float(booking.get('total_amount') or 0):.2f}")
    return f"""
    <h3>Bank Transfer Details</h3>
    <p class="detail">Please include your booking reference <strong>{reference}</strong> with the transfer.</p>
    <p class="detail"><strong>Amount:</strong> {amount}</p>
    {rows_html}
    """


async def send_booking_request_notification(hotel_email: str, booking: dict):
    """Notify host of new booking request with Accept/Reject actions."""
    subject, html_body = _render_request_status_email(booking, "pending")
    reply_to = _booking_request_reply_to(booking)
    await _send_to_host_and_ops(hotel_email, subject, html_body, reply_to=reply_to)


async def send_guest_booking_requested(guest_email: str, booking: dict):
    """Confirm to guest that their booking request has been submitted."""
    if booking.get("payment_method") == "paypal":
        deadline = booking.get("host_response_deadline")
        paypal_email = booking.get("paypal_email") or ""
        deadline_html = (
            f'<p class="detail"><strong>Payment deadline:</strong> {deadline}</p>'
            if deadline
            else ""
        )
        subject = f"Action needed: complete your PayPal payment for booking {booking['booking_reference']}"
        content = f"""
        <h2>PayPal Payment Pending</h2>
        <p class="detail">Your booking at <strong>{booking["hotel_name"]}</strong> is not confirmed yet.</p>
        {f'<p class="detail"><strong>Send payment to:</strong> {paypal_email}</p>' if paypal_email else ""}
        <p class="detail">Please send the total amount by PayPal and include your booking reference in the PayPal note so we can match it.</p>
        <hr class="divider">
        {_booking_details_html(booking)}
        {deadline_html}
        <hr class="divider">
        <p class="detail">We'll confirm your booking once we verify the payment. If payment is not received by the deadline, the booking will be cancelled automatically.</p>
        {_my_booking_button_html(booking, guest_email)}
        """
        await _send_email(guest_email, subject, _wrap_html(content))
        return

    is_bank_transfer = booking.get("payment_method") == "bank_transfer"
    next_step_html = (
        '<p class="detail">Please transfer the required amount using the bank details below. '
        "Your booking will be confirmed once we verify the payment.</p>"
        if is_bank_transfer
        else '<p class="detail">We\'ll review your request and respond within <strong>24 hours</strong>.</p>'
    )
    status_followup = (
        "You can also check your booking status using your reference number."
        if is_bank_transfer
        else "You will receive an email once we respond. You can also check your booking status using your reference number."
    )

    subject = f"Booking Request Submitted — {booking['booking_reference']}"
    content = f"""
    <h2>Booking Request Submitted</h2>
    <p class="detail">Your booking request at <strong>{booking["hotel_name"]}</strong> has been submitted successfully.</p>
    {next_step_html}
    {_bank_transfer_details_html(booking)}
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">{status_followup}</p>
    {_my_booking_button_html(booking, guest_email)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_guest_booking_accepted(guest_email: str, booking: dict):
    """Notify guest that their booking has been accepted and payment captured."""
    subject = f"Booking Confirmed — {booking['booking_reference']}"
    payment_method = booking.get("payment_method", "card")
    payment_note = (
        "Your card has been charged."
        if payment_method == "card"
        else "Please pay at the property upon arrival."
    )

    content = f"""
    <h2>Your Booking is Confirmed!</h2>
    <p class="detail">Great news — we have accepted your booking at <strong>{booking["hotel_name"]}</strong>.</p>
    <p class="detail">{payment_note}</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">We look forward to welcoming you!</p>
    <p class="detail">We'll contact you shortly with your confirmation documents and all the details for your stay.</p>
    {_my_booking_button_html(booking, guest_email)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_guest_booking_rejected(guest_email: str, booking: dict, reason: str | None = None):
    """Notify guest that their booking has been declined."""
    payment_method = booking.get("payment_method", "card")
    refund_note = (
        "Any authorization hold on your card has been released." if payment_method == "card" else ""
    )
    from html import escape

    reason_html = (
        f"<p class='detail'><strong>Reason:</strong> {escape(reason)}</p>" if reason else ""
    )

    subject = f"Booking Request Declined — {booking['booking_reference']}"
    content = f"""
    <h2>Booking Request Declined</h2>
    <p class="detail">Unfortunately, we declined your booking request at <strong>{booking["hotel_name"]}</strong>.</p>
    {"<p class='detail'>" + refund_note + "</p>" if refund_note else ""}
    {reason_html}
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">We encourage you to search for alternative dates or properties.</p>
    {_my_booking_button_html(booking, guest_email)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_guest_booking_expired(guest_email: str, booking: dict):
    """Notify guest that their booking request expired (host didn't respond)."""
    payment_method = booking.get("payment_method", "card")
    refund_note = (
        "Any authorization hold on your card has been released." if payment_method == "card" else ""
    )

    subject = f"Booking Request Expired — {booking['booking_reference']}"
    content = f"""
    <h2>Booking Request Expired</h2>
    <p class="detail">Your booking request at <strong>{booking["hotel_name"]}</strong> has expired because we did not respond within 24 hours.</p>
    {"<p class='detail'>" + refund_note + "</p>" if refund_note else ""}
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">We apologize for the inconvenience. Please try booking again or explore other properties.</p>
    {_my_booking_button_html(booking, guest_email)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_host_booking_withdrawn(hotel_email: str, booking: dict):
    """Notify host that guest withdrew their pending booking request."""
    subject, html_body = _render_request_status_email(booking, "cancelled")
    await _send_to_host_and_ops(hotel_email, subject, html_body)


async def send_host_booking_expired(hotel_email: str, booking: dict):
    """Notify host that a booking expired because they didn't respond."""
    subject, html_body = _render_request_status_email(booking, "expired")
    await _send_to_host_and_ops(hotel_email, subject, html_body)


async def send_host_booking_rejected(hotel_email: str, booking: dict, reason: str | None = None):
    """Notify host (and ops) that they declined the booking request."""
    subject, html_body = _render_request_status_email(booking, "declined")
    await _send_to_host_and_ops(hotel_email, subject, html_body)


async def send_guest_cancellation_refund(
    guest_email: str, booking: dict, refund_amount: float, refund_pct: float
):
    """Notify guest of cancellation with refund details."""
    if refund_pct >= 100:
        refund_text = f"A full refund of <strong>{booking['currency']} {refund_amount:.2f}</strong> will be processed to your original payment method."
    elif refund_amount > 0:
        refund_text = f"A partial refund of <strong>{booking['currency']} {refund_amount:.2f}</strong> ({refund_pct:.0f}%) will be processed to your original payment method."
    else:
        refund_text = (
            "Based on the cancellation policy, no refund is applicable for this cancellation."
        )

    subject = f"Booking Cancelled — {booking['booking_reference']}"
    content = f"""
    <h2>Booking Cancelled</h2>
    <p class="detail">Your booking at <strong>{booking["hotel_name"]}</strong> has been cancelled.</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">{refund_text}</p>
    <p class="detail">If you have any questions, please contact us directly.</p>
    {_my_booking_button_html(booking, guest_email)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


# ── New notification emails ────────────────────────────────────────


async def send_guest_booking_withdrawn(guest_email: str, booking: dict):
    """Confirm to guest that they withdrew their booking request."""
    payment_method = booking.get("payment_method", "card")
    release_note = (
        "Any authorization hold on your card has been released." if payment_method == "card" else ""
    )

    subject = f"Booking Withdrawn — {booking['booking_reference']}"
    content = f"""
    <h2>Booking Withdrawn</h2>
    <p class="detail">Your booking request at <strong>{booking["hotel_name"]}</strong> has been withdrawn.</p>
    {"<p class='detail'>" + release_note + "</p>" if release_note else ""}
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">If you change your mind, you're welcome to submit a new booking request anytime.</p>
    {_my_booking_button_html(booking, guest_email)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_host_booking_accepted(hotel_email: str, booking: dict):
    """Confirm to host that they accepted the booking."""
    subject, html_body = _render_request_status_email(booking, "accepted")
    await _send_to_host_and_ops(hotel_email, subject, html_body)


async def send_guest_admin_booking_confirmed(guest_email: str, booking: dict):
    """Notify guest that an admin has created and confirmed their booking."""
    subject = f"Booking Confirmed — {booking['booking_reference']}"
    content = f"""
    <h2>Your Booking is Confirmed!</h2>
    <p class="detail">Your booking at <strong>{booking["hotel_name"]}</strong> has been confirmed.</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">We look forward to welcoming you!</p>
    <p class="detail">We'll contact you shortly with your confirmation documents and all the details for your stay.</p>
    {_my_booking_button_html(booking, guest_email)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_affiliate_approved(
    affiliate_email: str, affiliate_name: str, hotel_name: str, referral_code: str
):
    """Notify affiliate that they have been approved by the hotel."""
    subject = f"You're Approved — Start Referring Guests to {hotel_name}"
    content = f"""
    <h2>Congratulations, {affiliate_name}!</h2>
    <p class="detail">Great news — <strong>{hotel_name}</strong> has approved your referral application.</p>
    <p class="detail">You can now start sharing your unique referral link and earn commissions on every booking.</p>
    <hr class="divider">
    <p class="detail"><strong>Your Referral Code:</strong> {referral_code}</p>
    <hr class="divider">
    <p class="detail">Make sure to set up your payout method so you can receive your commissions.</p>
    """
    await _send_email(affiliate_email, subject, _wrap_html(content))


async def send_affiliate_registration_received(
    affiliate_email: str, affiliate_name: str, hotel_name: str
):
    """Confirm to a brand-new affiliate that their referral application
    was received and is awaiting hotel approval."""
    subject = f"Application Received — {hotel_name}"
    content = f"""
    <h2>Thanks, {affiliate_name}!</h2>
    <p class="detail">Your referral application for <strong>{hotel_name}</strong> has been received.</p>
    <p class="detail">The hotel team will review your application and get back to you. Once approved, you'll receive another email with a link to set up your affiliate dashboard and start sharing your referral link.</p>
    <hr class="divider">
    <p class="detail" style="font-size: 13px; color: #888;">No action is needed from your side right now — sit tight, we'll be in touch.</p>
    """
    await _send_email(affiliate_email, subject, _wrap_html(content))


async def send_hotel_new_affiliate_application(
    hotel_email: str,
    hotel_name: str,
    affiliate_name: str,
    affiliate_email: str,
    social_media: str,
    user_type: str,
    payment_method: str,
):
    """Notify the hotel admin that a new affiliate has applied and is
    waiting for approval in the PMS dashboard."""
    subject = f"New Affiliate Application — {affiliate_name}"
    social_row = (
        f'<p class="detail"><strong>Channel:</strong> {social_media}</p>' if social_media else ""
    )
    content = f"""
    <h2>New affiliate application</h2>
    <p class="detail">A new referrer has applied to promote <strong>{hotel_name}</strong> and is waiting for your approval.</p>
    <hr class="divider">
    <p class="detail"><strong>Name:</strong> {affiliate_name}</p>
    <p class="detail"><strong>Email:</strong> {affiliate_email}</p>
    <p class="detail"><strong>Type:</strong> {user_type.capitalize()}</p>
    {social_row}
    <p class="detail"><strong>Payout method:</strong> {payment_method.capitalize()}</p>
    <hr class="divider">
    <p class="detail">Open the Affiliates → Applications tab in your dashboard to approve or reject this request.</p>
    """
    await _send_email(hotel_email, subject, _wrap_html(content))


async def send_vayada_new_affiliate_application(
    hotel_name: str,
    hotel_slug: str,
    affiliate_name: str,
    affiliate_email: str,
    social_media: str,
    user_type: str,
    payment_method: str,
):
    """Internal heads-up to the Vayada team for every new Refer-a-Guest
    signup, so we don't miss applications when the hotel admin is slow
    to act. Recipient is configurable via VAYADA_AFFILIATE_NOTIFICATION_EMAIL."""
    recipient = settings.VAYADA_AFFILIATE_NOTIFICATION_EMAIL
    if not recipient:
        return
    subject = f"New Affiliate Application — {hotel_name} — {affiliate_name}"
    social_row = (
        f'<p class="detail"><strong>Channel:</strong> {social_media}</p>' if social_media else ""
    )
    content = f"""
    <h2>New affiliate application</h2>
    <p class="detail">A guest just submitted the Refer-a-Guest form on the booking engine.</p>
    <hr class="divider">
    <p class="detail"><strong>Hotel:</strong> {hotel_name} ({hotel_slug})</p>
    <p class="detail"><strong>Name:</strong> {affiliate_name}</p>
    <p class="detail"><strong>Email:</strong> {affiliate_email}</p>
    <p class="detail"><strong>Type:</strong> {user_type.capitalize()}</p>
    {social_row}
    <p class="detail"><strong>Payout method:</strong> {payment_method.capitalize()}</p>
    <hr class="divider">
    <p class="detail">The hotel admin has been notified separately and is expected to approve or reject in their PMS dashboard.</p>
    """
    await _send_email(recipient, subject, _wrap_html(content))


async def send_affiliate_invite(
    affiliate_email: str, affiliate_name: str, hotel_name: str, set_password_url: str
):
    """Send affiliate an invite email with a link to set their password and access the dashboard."""
    subject = f"Set Up Your Affiliate Dashboard — {hotel_name}"
    content = f"""
    <h2>Welcome, {affiliate_name}!</h2>
    <p class="detail">An affiliate dashboard account has been created for you at <strong>{hotel_name}</strong>.</p>
    <p class="detail">Click the button below to set your password and access your affiliate dashboard where you can track earnings, clicks, and payouts.</p>
    <hr class="divider">
    <a href="{set_password_url}" class="btn">Set Your Password</a>
    <hr class="divider">
    <p class="detail" style="font-size: 13px; color: #888;">This link expires in 24 hours. If it has expired, contact the hotel to resend it.</p>
    """
    await _send_email(affiliate_email, subject, _wrap_html(content))


async def send_guest_payment_confirmed(
    guest_email: str, booking: dict, payment_amount: float, payment_method: str
):
    """Notify guest that their payment has been successfully received."""
    method_labels = {
        "card": "Credit/Debit Card",
        "xendit": "Online Payment",
        "bank_transfer": "Bank Transfer",
    }
    method_label = method_labels.get(payment_method, payment_method.replace("_", " ").title())

    currency = booking.get("currency", "USD")

    subject = f"Payment Received — {booking['booking_reference']}"
    content = f"""
    <h2>Payment Received</h2>
    <p class="detail">Your payment of <strong>{currency} {payment_amount:.2f}</strong> for your booking at <strong>{booking["hotel_name"]}</strong> has been successfully processed.</p>
    <p class="detail"><strong>Payment Method:</strong> {method_label}</p>
    <hr class="divider">
    {_booking_details_html(booking)}
    <hr class="divider">
    <p class="detail">Thank you for your payment. You will receive a separate confirmation once we review your booking.</p>
    {_my_booking_button_html(booking, guest_email)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_affiliate_payout_notification(
    affiliate_email: str,
    affiliate_name: str,
    payout_amount: float,
    currency: str,
    payout_method: str,
):
    """Notify affiliate that a payout has been processed."""
    method_labels = {
        "stripe": "Stripe Connect",
        "paypal": "PayPal",
        "bank_transfer": "Bank Transfer",
        "xendit": "Xendit",
    }
    method_label = method_labels.get(payout_method, payout_method or "N/A")

    subject = f"Payout Processed — {currency} {payout_amount:.2f}"
    content = f"""
    <h2>Payout Processed</h2>
    <p class="detail">Hi <strong>{affiliate_name}</strong>,</p>
    <p class="detail">Your affiliate payout has been successfully processed. Here are the details:</p>
    <hr class="divider">
    <p class="detail"><strong>Amount:</strong> {currency} {payout_amount:.2f}</p>
    <p class="detail"><strong>Method:</strong> {method_label}</p>
    <hr class="divider">
    <p class="detail">Funds will arrive in your account according to the processing times of your payout method.</p>
    <p class="detail">If you have any questions, please don't hesitate to reach out.</p>
    """
    await _send_email(affiliate_email, subject, _wrap_html(content))


async def send_fixed_plan_payment_failed_notification(
    *, hotel_id: str, hotel_name: str, subscription_id: str
):
    subject = f"Fixed Plan payment failed — {hotel_name}"
    content = f"""
    <h2>Fixed Plan Payment Failed</h2>
    <p class="detail">Stripe could not collect a recurring Fixed Plan payment.</p>
    <hr class="divider">
    <p class="detail"><strong>Hotel:</strong> {hotel_name}</p>
    <p class="detail"><strong>Hotel ID:</strong> {hotel_id}</p>
    <p class="detail"><strong>Subscription:</strong> {subscription_id}</p>
    <p class="detail">The hotel remains on the Fixed Plan while Stripe retries the payment.</p>
    """
    await _send_email(settings.VAYADA_OPS_EMAIL, subject, _wrap_html(content))


async def send_host_ota_booking_imported(
    hotel_email: str, booking: dict, *, event: str = "imported"
):
    """Notify host that an OTA booking arrived (or was modified/cancelled)
    via Channex. Gated by the ``ota_booking_alerts`` toggle in
    booking_hotels — callers must check that before invoking."""
    if not hotel_email:
        return

    channel_label = _ota_channel_label(booking.get("channel"))
    guest_name = (
        f"{booking.get('guest_first_name', '') or ''} {booking.get('guest_last_name', '') or ''}"
    ).strip() or "Guest"

    booking_id = booking.get("id", "")
    pms_link = f"https://pms.vayada.com/bookings/{booking_id}"

    if event == "modified":
        subject = f"OTA booking modified — {channel_label} — {guest_name}"
        heading = "OTA Booking Modified"
        body_intro = (
            f"A booking from <strong>{channel_label}</strong> for "
            f"<strong>{guest_name}</strong> was modified."
        )
    elif event == "cancelled":
        subject = f"OTA booking cancelled — {channel_label} — {guest_name}"
        heading = "OTA Booking Cancelled"
        body_intro = (
            f"A booking from <strong>{channel_label}</strong> for "
            f"<strong>{guest_name}</strong> was cancelled."
        )
    else:
        subject = f"New booking from {channel_label} — {guest_name}"
        heading = "New OTA Booking"
        body_intro = f"A new booking has been imported from <strong>{channel_label}</strong>."

    content = f"""
    <h2>{heading}</h2>
    <p class="detail">{body_intro}</p>
    <hr class="divider">
    <p class="detail"><strong>Source:</strong> {channel_label}</p>
    <p class="detail"><strong>Guest:</strong> {guest_name}</p>
    {_booking_details_html(booking)}
    <hr class="divider">
    <a href="{pms_link}" class="btn">View in PMS</a>
    """
    await _send_email(hotel_email, subject, _wrap_html(content))


async def send_host_guest_cancelled(hotel_email: str, booking: dict):
    """Notify host that a guest cancelled their confirmed booking."""
    subject, html_body = _render_request_status_email(booking, "cancelled")
    await _send_to_host_and_ops(hotel_email, subject, html_body)


# ── Booking change requests (VAY-379) ──────────────────────────────


def _format_addons_list(names) -> str:
    if isinstance(names, str):
        try:
            names = json.loads(names)
        except (TypeError, ValueError):
            names = []
    if not names:
        return "None"
    return ", ".join(names)


def _change_diff_html(booking: dict, change_request: dict) -> str:
    """Render the side-by-side current vs requested table used in every
    change-request email."""
    currency = change_request["currency"]
    old_total = change_request["old_total"]
    new_total = change_request["new_total"]
    diff = change_request["price_difference"]
    diff_label = "Price difference"
    if diff > 0:
        diff_text = f"+{currency} {diff:.2f} (additional payment required)"
    elif diff < 0:
        diff_text = f"{currency} {diff:.2f} (refund where applicable)"
    else:
        diff_text = f"{currency} 0.00 (no change in total)"

    new_addon_names = _format_addons_list(change_request.get("requested_addon_names"))

    return f"""
    <p class="detail"><strong>Current dates:</strong> {change_request["old_check_in"]} → {change_request["old_check_out"]}</p>
    <p class="detail"><strong>Requested dates:</strong> {change_request["requested_check_in"]} → {change_request["requested_check_out"]}</p>
    <p class="detail"><strong>Requested add-ons:</strong> {new_addon_names}</p>
    <hr class="divider">
    <p class="detail"><strong>Old total:</strong> {currency} {old_total:.2f}</p>
    <p class="detail"><strong>New total:</strong> {currency} {new_total:.2f}</p>
    <p class="detail"><strong>{diff_label}:</strong> {diff_text}</p>
    """


async def send_host_change_request(hotel_email: str, booking: dict, change_request: dict):
    """Notify host of a guest's change request, with a deep link into PMS
    and approve/decline shortcut buttons."""
    booking_id = booking.get("id", "")
    pms_link = f"https://pms.vayada.com/bookings/{booking_id}"
    subject = f"Booking Change Requested — {booking['booking_reference']}"
    content = f"""
    <h2>Booking Change Requested</h2>
    <p class="detail">The guest <strong>{booking.get("guest_first_name", "")} {booking.get("guest_last_name", "")}</strong> has requested a change to their booking at <strong>{booking["hotel_name"]}</strong>.</p>
    <p class="detail"><strong>Reference:</strong> {booking["booking_reference"]}</p>
    <p class="detail"><strong>Guest email:</strong> {booking["guest_email"]}</p>
    <hr class="divider">
    {_change_diff_html(booking, change_request)}
    <hr class="divider">
    <a href="{pms_link}" class="btn">Review &amp; Respond in PMS</a>
    <p class="detail" style="margin-top: 16px;">The change is not applied until you approve it. The guest's booking remains as-is until then.</p>
    """
    await _send_to_host_and_ops(hotel_email, subject, _wrap_html(content))


async def send_guest_change_request_received(guest_email: str, booking: dict, change_request: dict):
    """Confirm to the guest that we received their change request."""
    subject = f"Change Request Received — {booking['booking_reference']}"
    content = f"""
    <h2>Change Request Received</h2>
    <p class="detail">We've received your change request for booking <strong>{booking["booking_reference"]}</strong> at <strong>{booking["hotel_name"]}</strong>.</p>
    <p class="detail">We'll review it shortly and email you as soon as we respond.</p>
    <hr class="divider">
    {_change_diff_html(booking, change_request)}
    <hr class="divider">
    <p class="detail">Until we approve it, your booking remains as it currently is.</p>
    {_my_booking_button_html(booking, guest_email)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_guest_change_request_approved(guest_email: str, booking: dict, change_request: dict):
    """Tell the guest their change request was approved + apply to booking."""
    diff = change_request["price_difference"]
    if diff > 0:
        payment_note = (
            f"Your booking total increased by {change_request['currency']} "
            f"{diff:.2f}. Please open your booking page to complete the additional "
            f"payment using the same payment method as the original booking."
        )
    elif diff < 0:
        payment_note = "Your booking total decreased. We'll process any refund."
    else:
        payment_note = ""

    subject = f"Change Request Approved — {booking['booking_reference']}"
    content = f"""
    <h2>Change Request Approved</h2>
    <p class="detail">Good news — we approved your change for booking <strong>{booking["booking_reference"]}</strong> at <strong>{booking["hotel_name"]}</strong>.</p>
    <hr class="divider">
    {_change_diff_html(booking, change_request)}
    <hr class="divider">
    {f'<p class="detail">{payment_note}</p>' if payment_note else ""}
    {_my_booking_button_html(booking, guest_email)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_guest_change_request_declined(guest_email: str, booking: dict, change_request: dict):
    """Tell the guest their change request was declined; original booking unchanged."""
    from html import escape

    reason = change_request.get("decline_reason")
    reason_html = (
        f"<p class='detail'><strong>Reason:</strong> {escape(str(reason))}</p>" if reason else ""
    )
    subject = f"Change Request Declined — {booking['booking_reference']}"
    content = f"""
    <h2>Change Request Declined</h2>
    <p class="detail">We declined your change request for booking <strong>{booking["booking_reference"]}</strong> at <strong>{booking["hotel_name"]}</strong>.</p>
    {reason_html}
    <p class="detail">Your original booking remains unchanged.</p>
    <hr class="divider">
    {_change_diff_html(booking, change_request)}
    {_my_booking_button_html(booking, guest_email)}
    """
    await _send_email(guest_email, subject, _wrap_html(content))


async def send_host_change_request_decision(
    hotel_email: str, booking: dict, change_request: dict, *, approved: bool
):
    """Confirm to the host (and ops) that the change-request decision was recorded."""
    booking_id = booking.get("id", "")
    pms_link = f"https://pms.vayada.com/bookings/{booking_id}"
    label = "Approved" if approved else "Declined"
    subject = f"Change Request {label} — {booking['booking_reference']}"
    content = f"""
    <h2>Change Request {label}</h2>
    <p class="detail">The booking change for <strong>{booking["booking_reference"]}</strong> has been recorded as <strong>{label.lower()}</strong>.</p>
    <hr class="divider">
    {_change_diff_html(booking, change_request)}
    <hr class="divider">
    <a href="{pms_link}" class="btn">View in PMS</a>
    """
    await _send_to_host_and_ops(hotel_email, subject, _wrap_html(content))

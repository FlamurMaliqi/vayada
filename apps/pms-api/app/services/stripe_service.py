import logging

import stripe

from app.config import settings

logger = logging.getLogger(__name__)

stripe.api_key = settings.STRIPE_SECRET_KEY


async def create_payment_intent(
    amount: int,
    currency: str,
    metadata: dict,
    stripe_account: str | None = None,
    capture_method: str = "manual",
) -> dict:
    """Create a PaymentIntent.

    Defaults to manual capture (the request flow holds an authorization until
    the host accepts). Pass ``capture_method="automatic"`` for instant-book
    hotels that capture as soon as the guest confirms payment.
    """
    params = {
        "amount": amount,
        "currency": currency.lower(),
        "capture_method": capture_method,
        "metadata": metadata,
    }
    if stripe_account:
        params["transfer_data"] = {"destination": stripe_account}

    pi = stripe.PaymentIntent.create(**params)
    return {
        "id": pi.id,
        "client_secret": pi.client_secret,
        "status": pi.status,
    }


async def retrieve_payment_intent(payment_intent_id: str) -> dict:
    """Load the authoritative Stripe state after client-side confirmation."""
    pi = stripe.PaymentIntent.retrieve(payment_intent_id)
    return {
        "id": pi.id,
        "status": pi.status,
        "capture_method": pi.capture_method,
    }


async def capture_payment_intent(payment_intent_id: str, amount: int | None = None) -> dict:
    """Capture a previously authorized PaymentIntent."""
    params = {}
    if amount is not None:
        params["amount_to_capture"] = amount
    pi = stripe.PaymentIntent.capture(payment_intent_id, **params)
    return {"id": pi.id, "status": pi.status}


async def cancel_payment_intent(payment_intent_id: str) -> dict:
    """Cancel (release hold on) a PaymentIntent."""
    pi = stripe.PaymentIntent.cancel(payment_intent_id)
    return {"id": pi.id, "status": pi.status}


async def create_refund(
    payment_intent_id: str,
    amount: int | None = None,
    idempotency_key: str | None = None,
) -> dict:
    """Create a full or partial refund."""
    params = {"payment_intent": payment_intent_id}
    if amount is not None:
        params["amount"] = amount
    if idempotency_key:
        params["idempotency_key"] = idempotency_key
    refund = stripe.Refund.create(**params)
    return {"id": refund.id, "status": refund.status, "amount": refund.amount}


async def create_transfer(
    amount: int, currency: str, destination_account: str, metadata: dict
) -> dict:
    """Create a Stripe Connect transfer to a connected account."""
    transfer = stripe.Transfer.create(
        amount=amount,
        currency=currency.lower(),
        destination=destination_account,
        metadata=metadata,
    )
    return {"id": transfer.id, "amount": transfer.amount}


async def create_connect_account(email: str, country: str = "AT") -> dict:
    """Create a new Stripe Connect Express account."""
    account = stripe.Account.create(
        type="express",
        email=email,
        country=country,
        capabilities={
            "card_payments": {"requested": True},
            "transfers": {"requested": True},
        },
    )
    return {"id": account.id, "email": account.email}


async def create_connect_account_link(account_id: str, return_url: str, refresh_url: str) -> str:
    """Generate an onboarding link for a Connect account."""
    link = stripe.AccountLink.create(
        account=account_id,
        return_url=return_url,
        refresh_url=refresh_url,
        type="account_onboarding",
    )
    return link.url


def construct_webhook_event(payload: bytes, signature: str) -> stripe.Event:
    """Verify and parse a Stripe webhook event."""
    return stripe.Webhook.construct_event(payload, signature, settings.STRIPE_WEBHOOK_SECRET)

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
    application_fee_amount: int = 0,
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
    if stripe_account and application_fee_amount > 0:
        params["application_fee_amount"] = application_fee_amount

    pi = stripe.PaymentIntent.create(
        **params,
        **({"stripe_account": stripe_account} if stripe_account else {}),
    )
    return {
        "id": pi.id,
        "client_secret": pi.client_secret,
        "status": pi.status,
    }


async def retrieve_payment_intent(
    payment_intent_id: str, stripe_account: str | None = None
) -> dict:
    """Load the authoritative Stripe state after client-side confirmation."""
    pi = stripe.PaymentIntent.retrieve(
        payment_intent_id,
        **({"stripe_account": stripe_account} if stripe_account else {}),
    )
    return {
        "id": pi.id,
        "status": pi.status,
        "capture_method": pi.capture_method,
    }


async def capture_payment_intent(
    payment_intent_id: str,
    amount: int | None = None,
    stripe_account: str | None = None,
    idempotency_key: str | None = None,
) -> dict:
    """Capture a previously authorized PaymentIntent."""
    params = {}
    if amount is not None:
        params["amount_to_capture"] = amount
    if idempotency_key:
        params["idempotency_key"] = idempotency_key
    pi = stripe.PaymentIntent.capture(
        payment_intent_id,
        **params,
        **({"stripe_account": stripe_account} if stripe_account else {}),
    )
    return {"id": pi.id, "status": pi.status}


async def cancel_payment_intent(payment_intent_id: str, stripe_account: str | None = None) -> dict:
    """Cancel (release hold on) a PaymentIntent."""
    pi = stripe.PaymentIntent.cancel(
        payment_intent_id,
        **({"stripe_account": stripe_account} if stripe_account else {}),
    )
    return {"id": pi.id, "status": pi.status}


async def create_refund(
    payment_intent_id: str,
    amount: int | None = None,
    idempotency_key: str | None = None,
    stripe_account: str | None = None,
    refund_application_fee: bool = False,
    metadata: dict | None = None,
) -> dict:
    """Create a full or partial refund."""
    params = {"payment_intent": payment_intent_id}
    if amount is not None:
        params["amount"] = amount
    if idempotency_key:
        params["idempotency_key"] = idempotency_key
    if stripe_account:
        params["stripe_account"] = stripe_account
    if refund_application_fee:
        params["refund_application_fee"] = True
    if metadata:
        params["metadata"] = metadata
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


async def create_billing_customer(email: str, hotel_id: str) -> str:
    customer = stripe.Customer.create(
        email=email,
        metadata={"hotel_id": hotel_id, "vayada_payment_kind": "fixed_plan"},
        idempotency_key=f"vayada-fixed-customer:{hotel_id}",
    )
    return customer.id


async def create_fixed_plan_checkout(
    *,
    customer_id: str,
    hotel_id: str,
    amount_cents: int,
    success_url: str,
    cancel_url: str,
    idempotency_key: str,
) -> dict:
    metadata = {"hotel_id": hotel_id, "vayada_payment_kind": "fixed_plan"}
    session = stripe.checkout.Session.create(
        mode="subscription",
        customer=customer_id,
        payment_method_types=["card"],
        client_reference_id=hotel_id,
        line_items=[
            {
                "price_data": {
                    "currency": "eur",
                    "product_data": {"name": "Vayada Fixed Plan"},
                    "recurring": {"interval": "day", "interval_count": 30},
                    "unit_amount": amount_cents,
                },
                "quantity": 1,
            }
        ],
        metadata=metadata,
        subscription_data={"metadata": metadata},
        success_url=success_url,
        cancel_url=cancel_url,
        idempotency_key=idempotency_key,
    )
    return {"id": session.id, "url": session.url, "status": session.status}


async def retrieve_checkout_session(session_id: str) -> dict:
    session = stripe.checkout.Session.retrieve(session_id)
    return {
        "id": session.id,
        "url": session.url,
        "status": session.status,
        "payment_status": session.payment_status,
    }


async def retrieve_billing_subscription(subscription_id: str) -> dict:
    subscription = stripe.Subscription.retrieve(
        subscription_id,
        expand=["items.data.price.product"],
    )
    item = subscription["items"]["data"][0]
    product = item["price"]["product"]
    product_id = (
        product
        if isinstance(product, str)
        else product.get("id")
        if isinstance(product, dict)
        else getattr(product, "id", None)
    )
    if not product_id:
        raise RuntimeError("Stripe subscription price has no product")
    period_end = subscription.get("current_period_end") or item.get("current_period_end")
    return {
        "id": subscription.id,
        "customer_id": subscription.customer,
        "metadata": dict(subscription.metadata or {}),
        "status": subscription.status,
        "cancel_at_period_end": bool(subscription.cancel_at_period_end),
        "current_period_end": period_end,
        "item_id": item["id"],
        "product_id": product_id,
        "unit_amount": item["price"].get("unit_amount"),
    }


async def update_fixed_plan_price(
    *,
    hotel_id: str,
    subscription_item_id: str,
    product_id: str,
    amount_cents: int,
    room_count: int,
) -> None:
    price = stripe.Price.create(
        currency="eur",
        product=product_id,
        recurring={"interval": "day", "interval_count": 30},
        unit_amount=amount_cents,
        metadata={"hotel_id": hotel_id, "active_room_count": str(room_count)},
    )
    stripe.SubscriptionItem.modify(
        subscription_item_id,
        price=price.id,
        proration_behavior="none",
    )


async def create_billing_portal_session(customer_id: str, return_url: str) -> str:
    session = stripe.billing_portal.Session.create(
        customer=customer_id,
        return_url=return_url,
    )
    return session.url


async def cancel_billing_subscription_at_period_end(subscription_id: str) -> dict:
    subscription = stripe.Subscription.modify(subscription_id, cancel_at_period_end=True)
    items = (subscription.get("items") or {}).get("data") or []
    period_end = subscription.get("current_period_end")
    if not period_end and items:
        period_end = items[0].get("current_period_end")
    return {
        "cancel_at_period_end": bool(subscription.cancel_at_period_end),
        "current_period_end": period_end,
    }


def construct_webhook_event(
    payload: bytes, signature: str, webhook_secret: str | None = None
) -> stripe.Event:
    """Verify and parse a Stripe webhook event."""
    return stripe.Webhook.construct_event(
        payload,
        signature,
        webhook_secret or settings.STRIPE_WEBHOOK_SECRET,
    )

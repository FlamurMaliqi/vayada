from types import SimpleNamespace
from unittest.mock import patch

from app.services import stripe_service


async def test_payment_intent_is_created_on_connected_account_with_application_fee():
    with patch.object(stripe_service.stripe.PaymentIntent, "create") as create:
        create.return_value = SimpleNamespace(
            id="pi_direct",
            client_secret="pi_direct_secret",
            status="requires_payment_method",
        )

        await stripe_service.create_payment_intent(
            amount=10_000,
            currency="EUR",
            metadata={"booking_reference": "VAY-DIRECT"},
            stripe_account="acct_property",
            application_fee_amount=500,
        )

    create.assert_called_once()
    params = create.call_args.kwargs
    assert params["stripe_account"] == "acct_property"
    assert params["application_fee_amount"] == 500
    assert "transfer_data" not in params


async def test_zero_application_fee_is_omitted_for_fixed_plan():
    with patch.object(stripe_service.stripe.PaymentIntent, "create") as create:
        create.return_value = SimpleNamespace(
            id="pi_fixed",
            client_secret="pi_fixed_secret",
            status="requires_payment_method",
        )

        await stripe_service.create_payment_intent(
            amount=10_000,
            currency="EUR",
            metadata={"booking_reference": "VAY-FIXED"},
            stripe_account="acct_property",
        )

    params = create.call_args.kwargs
    assert params["stripe_account"] == "acct_property"
    assert "application_fee_amount" not in params
    assert "transfer_data" not in params


async def test_connected_account_context_is_used_for_payment_lifecycle():
    with (
        patch.object(stripe_service.stripe.PaymentIntent, "retrieve") as retrieve,
        patch.object(stripe_service.stripe.PaymentIntent, "capture") as capture,
        patch.object(stripe_service.stripe.PaymentIntent, "cancel") as cancel,
        patch.object(stripe_service.stripe.Refund, "create") as refund,
    ):
        retrieve.return_value = SimpleNamespace(
            id="pi_lifecycle", status="requires_capture", capture_method="manual"
        )
        capture.return_value = SimpleNamespace(id="pi_lifecycle", status="succeeded")
        cancel.return_value = SimpleNamespace(id="pi_lifecycle", status="canceled")
        refund.return_value = SimpleNamespace(id="re_lifecycle", status="succeeded", amount=500)

        await stripe_service.retrieve_payment_intent("pi_lifecycle", stripe_account="acct_property")
        await stripe_service.capture_payment_intent(
            "pi_lifecycle",
            stripe_account="acct_property",
            idempotency_key="booking-capture-booking-id",
        )
        await stripe_service.cancel_payment_intent("pi_lifecycle", stripe_account="acct_property")
        await stripe_service.create_refund(
            "pi_lifecycle",
            amount=500,
            stripe_account="acct_property",
            refund_application_fee=True,
        )

    retrieve.assert_called_once_with("pi_lifecycle", stripe_account="acct_property")
    capture.assert_called_once_with(
        "pi_lifecycle",
        stripe_account="acct_property",
        idempotency_key="booking-capture-booking-id",
    )
    cancel.assert_called_once_with("pi_lifecycle", stripe_account="acct_property")
    refund.assert_called_once_with(
        payment_intent="pi_lifecycle",
        amount=500,
        stripe_account="acct_property",
        refund_application_fee=True,
    )

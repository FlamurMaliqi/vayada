import logging

from fastapi import APIRouter, Depends, HTTPException

from app.config import settings as app_settings
from app.dependencies import require_hotel_admin
from app.models.payment import (
    CancellationPolicy,
    CancellationPolicyUpdate,
    HotelPaymentSettings,
    HotelPaymentSettingsUpdate,
    PaymentSettingsResponse,
    StripeConnectAccountRequest,
    XenditBankDetailsRequest,
)
from app.repositories.booking_repo import BookingRepository
from app.repositories.cancellation_policy_repo import CancellationPolicyRepository
from app.repositories.hotel_payment_settings_repo import HotelPaymentSettingsRepository
from app.repositories.payment_repo import PaymentRepository
from app.repositories.room_type_repo import RoomTypeRepository
from app.services import hotel_identity_service, stripe_service, xendit_service
from app.services.currency_service import (
    convert_amount,
    convert_room_type_rates,
    decimals_for_currency,
    get_exchange_rate,
)
from app.services.hotel_identity_service import get_currency as get_be_currency
from app.services.xendit_service import XenditError
from app.utils import get_hotel_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin-payments"])


async def _reconcile_stripe_connect_status(
    hotel_id: str, payment_settings: dict | None
) -> dict | None:
    """Refresh the legacy onboarding flag from Stripe when an account exists.

    The original flow only updated this flag through ``account.updated``. The
    production endpoint was not receiving connected-account events, so a
    completed account could remain pending forever. Payment settings reads are
    a natural, low-frequency repair point and also keep disabled accounts from
    remaining incorrectly marked as ready.
    """
    if not payment_settings or not payment_settings.get("stripe_connect_account_id"):
        return payment_settings

    account_id = payment_settings["stripe_connect_account_id"]
    try:
        account = await stripe_service.retrieve_connect_account(account_id)
        onboarded = bool(
            account.get("details_submitted")
            and account.get("charges_enabled")
            and account.get("payouts_enabled")
        )
        if bool(payment_settings.get("stripe_connect_onboarded")) != onboarded:
            await HotelPaymentSettingsRepository.upsert(
                hotel_id,
                {"stripe_connect_onboarded": onboarded},
            )
            payment_settings = {
                **payment_settings,
                "stripe_connect_onboarded": onboarded,
            }
            logger.info(
                "Reconciled Stripe Connect onboarding status hotel=%s account=%s onboarded=%s",
                hotel_id,
                account_id,
                onboarded,
            )
    except Exception as e:
        # A transient Stripe failure must not make the entire settings page
        # unavailable. Keep the last persisted value and try again next load.
        logger.warning(
            "Unable to reconcile Stripe Connect status account=%s: %s",
            account_id,
            e,
        )

    return payment_settings


async def _get_booking_engine_currency(user_id: str) -> str:
    """Resolve the user's hotel-id (honoring X-Hotel-Id) then fetch the
    authoritative currency from booking_db."""
    hotel_id = await get_hotel_id(user_id)
    return await get_be_currency(hotel_id)


# ── Payment Settings ──────────────────────────────────────────────


@router.get("/payment-settings", response_model=PaymentSettingsResponse)
async def get_payment_settings(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    settings = await _reconcile_stripe_connect_status(hotel_id, settings)
    policy = await CancellationPolicyRepository.get_by_hotel_id(hotel_id)

    # Currency is owned by the booking engine (booking_hotels.currency).
    # PMS never reads it from its own hotel_payment_settings column; see
    # memory/project_hotel_data_ownership.md.
    currency = await _get_booking_engine_currency(user_id)

    return PaymentSettingsResponse(
        payment_settings=HotelPaymentSettings(
            stripe_connect_account_id=settings["stripe_connect_account_id"] if settings else None,
            stripe_connect_onboarded=settings["stripe_connect_onboarded"] if settings else False,
            platform_fee_type=settings["platform_fee_type"] if settings else "percentage",
            platform_fee_value=float(settings["platform_fee_value"]) if settings else 8.00,
            platform_fee_with_affiliate=float(settings["platform_fee_with_affiliate"])
            if settings
            else 2.00,
            pay_at_property_enabled=settings["pay_at_property_enabled"] if settings else False,
            online_card_payment=settings.get("online_card_payment", False) if settings else False,
            bank_transfer=settings.get("bank_transfer", False) if settings else False,
            xendit_payments_enabled=settings.get("xendit_payments_enabled", False)
            if settings
            else False,
            payment_provider=settings["payment_provider"] if settings else "stripe",
            xendit_channel_code=settings.get("xendit_channel_code") if settings else None,
            xendit_account_number=settings.get("xendit_account_number") if settings else None,
            xendit_account_holder_name=settings.get("xendit_account_holder_name")
            if settings
            else None,
            default_currency=currency,
        ),
        cancellation_policy=CancellationPolicy(
            free_cancellation_days=policy["free_cancellation_days"] if policy else 7,
            partial_refund_pct=float(policy["partial_refund_pct"]) if policy else 0.00,
        ),
    )


@router.patch("/payment-settings")
async def update_payment_settings(
    data: HotelPaymentSettingsUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    updates = data.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    # When switching to xendit, require all bank details
    if updates.get("payment_provider") == "xendit":
        existing = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
        final_code = updates.get("xendit_channel_code") or (existing or {}).get(
            "xendit_channel_code"
        )
        final_number = updates.get("xendit_account_number") or (existing or {}).get(
            "xendit_account_number"
        )
        final_name = updates.get("xendit_account_holder_name") or (existing or {}).get(
            "xendit_account_holder_name"
        )
        missing = []
        if not final_code:
            missing.append("xenditChannelCode")
        if not final_number:
            missing.append("xenditAccountNumber")
        if not final_name:
            missing.append("xenditAccountHolderName")
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Xendit bank details required: {', '.join(missing)}",
            )

    # Convert room type rates when currency changes. Currency is owned by
    # the booking engine, so the authoritative "old" value comes from
    # booking_hotels.currency, not from hotel_payment_settings.
    new_currency = updates.get("default_currency")
    if new_currency:
        old_currency = await _get_booking_engine_currency(user_id)
        if old_currency != new_currency:
            try:
                rate = await get_exchange_rate(old_currency, new_currency)
            except Exception as e:
                logger.error(
                    "Failed to fetch exchange rate %s → %s: %s", old_currency, new_currency, e
                )
                raise HTTPException(
                    status_code=502,
                    detail=f"Failed to fetch exchange rate for {old_currency} → {new_currency}. Currency not updated.",
                )
            try:
                decimals = decimals_for_currency(new_currency)
                room_types = await RoomTypeRepository.list_by_hotel_id(hotel_id)
                converted_count = 0
                for rt in room_types:
                    room_currency = rt.get("currency") or old_currency
                    if room_currency == new_currency:
                        # Room is already in the target currency — just update
                        # the currency field, do NOT apply exchange-rate math.
                        await RoomTypeRepository.update(str(rt["id"]), {"currency": new_currency})
                        continue
                    # If the room's currency differs from the old payment currency,
                    # fetch the correct rate for this specific room
                    if room_currency != old_currency:
                        try:
                            room_rate = await get_exchange_rate(room_currency, new_currency)
                        except Exception:
                            logger.warning(
                                "Skipping conversion for room type %s: cannot get rate %s → %s",
                                rt["id"],
                                room_currency,
                                new_currency,
                            )
                            await RoomTypeRepository.update(
                                str(rt["id"]), {"currency": new_currency}
                            )
                            continue
                    else:
                        room_rate = rate
                    rt_updates = await convert_room_type_rates(rt, room_rate, decimals)
                    rt_updates["currency"] = new_currency
                    if rt_updates:
                        await RoomTypeRepository.update(str(rt["id"]), rt_updates)
                    converted_count += 1
                logger.info(
                    "Converted %d/%d room type rates from %s to %s (rate=%.6f)",
                    converted_count,
                    len(room_types),
                    old_currency,
                    new_currency,
                    rate,
                )
            except Exception as e:
                logger.error(
                    "Failed to convert room rates %s → %s: %s", old_currency, new_currency, e
                )
                raise HTTPException(
                    status_code=502,
                    detail=f"Failed to convert room rates to {new_currency}. Currency not updated.",
                )

    # Currency is owned by booking_db, so never write it to pms_db.
    # The column still exists until Stage 3 drops it, but Stage 1 keeps
    # it dead so new writes can't re-introduce drift.
    pms_updates = {k: v for k, v in updates.items() if k != "default_currency"}
    if pms_updates:
        await HotelPaymentSettingsRepository.upsert(hotel_id, pms_updates)

    # Write currency to the authoritative store (booking_db). If this
    # fails we raise, because the FX room-rate conversion above has
    # already run — leaving rates converted but currency unchanged is
    # exactly the drift we're trying to eliminate.
    if new_currency:
        try:
            await hotel_identity_service.set_currency(hotel_id, new_currency)
        except Exception as e:
            logger.error("Failed to write currency to booking engine: %s", e)
            raise HTTPException(
                status_code=502,
                detail="Failed to update currency in booking engine. Room rates may be in an inconsistent state — please retry.",
            )

        # Convert addon prices in the booking engine DB for the
        # currently-selected hotel (unified id).
        if old_currency != new_currency:
            try:
                addons = await hotel_identity_service.list_addons(hotel_id)
                addon_decimals = decimals_for_currency(new_currency)
                converted_count = 0
                for addon in addons:
                    addon_currency = addon["currency"]
                    if addon_currency == new_currency:
                        continue  # already in the right currency
                    try:
                        if addon_currency == old_currency:
                            addon_rate = rate  # reuse the rate we already fetched
                        else:
                            addon_rate = await get_exchange_rate(addon_currency, new_currency)
                        new_price = round(float(addon["price"]) * addon_rate, addon_decimals)
                        await hotel_identity_service.update_addon_price(
                            str(addon["id"]),
                            new_price,
                            new_currency,
                        )
                        converted_count += 1
                    except Exception as ae:
                        logger.warning("Failed to convert addon %s: %s", addon["id"], ae)
                if converted_count:
                    logger.info("Converted %d addon prices to %s", converted_count, new_currency)
            except Exception as e:
                logger.warning("Failed to convert addon prices: %s", e)

            # VAY-335: Re-denominate historical bookings + payments so the
            # PMS Dashboard / Financials revenue KPIs reflect the new
            # display currency. Without this, a $145 booking still reads
            # as 145 in the new currency (e.g. "Rp 145" instead of the
            # converted ~Rp 2.4M).
            try:
                booking_decimals = decimals_for_currency(new_currency)
                rate_cache: dict = {old_currency: rate}
                bookings_converted = 0
                bookings_to_convert = await BookingRepository.list_for_currency_conversion(hotel_id)
                for bk in bookings_to_convert:
                    booking_currency = bk.get("currency") or old_currency
                    if booking_currency == new_currency:
                        continue
                    try:
                        if booking_currency not in rate_cache:
                            rate_cache[booking_currency] = await get_exchange_rate(
                                booking_currency,
                                new_currency,
                            )
                        bk_rate = rate_cache[booking_currency]
                        await BookingRepository.update_amounts_and_currency(
                            str(bk["id"]),
                            total_amount=convert_amount(
                                float(bk["total_amount"] or 0), bk_rate, booking_decimals
                            ),
                            nightly_rate=convert_amount(
                                float(bk["nightly_rate"] or 0), bk_rate, booking_decimals
                            ),
                            addon_total=convert_amount(
                                float(bk.get("addon_total") or 0), bk_rate, booking_decimals
                            ),
                            promo_discount=convert_amount(
                                float(bk.get("promo_discount") or 0), bk_rate, booking_decimals
                            ),
                            last_minute_discount_amount=convert_amount(
                                float(bk.get("last_minute_discount_amount") or 0),
                                bk_rate,
                                booking_decimals,
                            ),
                            currency=new_currency,
                        )
                        bookings_converted += 1
                    except Exception as be:
                        logger.warning("Failed to convert booking %s: %s", bk["id"], be)
                if bookings_converted:
                    logger.info(
                        "Converted %d/%d booking amounts to %s",
                        bookings_converted,
                        len(bookings_to_convert),
                        new_currency,
                    )

                payments_converted = 0
                payments_to_convert = await PaymentRepository.list_for_hotel_currency_conversion(
                    hotel_id
                )
                for pmt in payments_to_convert:
                    payment_currency = pmt.get("currency") or old_currency
                    if payment_currency == new_currency:
                        continue
                    try:
                        if payment_currency not in rate_cache:
                            rate_cache[payment_currency] = await get_exchange_rate(
                                payment_currency,
                                new_currency,
                            )
                        pmt_rate = rate_cache[payment_currency]
                        refund = pmt.get("refund_amount")
                        await PaymentRepository.update_amounts_and_currency(
                            str(pmt["id"]),
                            amount=convert_amount(
                                float(pmt["amount"] or 0), pmt_rate, booking_decimals
                            ),
                            refund_amount=(
                                convert_amount(float(refund), pmt_rate, booking_decimals)
                                if refund is not None
                                else None
                            ),
                            currency=new_currency,
                        )
                        payments_converted += 1
                    except Exception as pe:
                        logger.warning("Failed to convert payment %s: %s", pmt["id"], pe)
                if payments_converted:
                    logger.info(
                        "Converted %d/%d payment amounts to %s",
                        payments_converted,
                        len(payments_to_convert),
                        new_currency,
                    )
            except Exception as e:
                logger.warning("Failed to convert booking/payment amounts: %s", e)

    # Match on hotel id (unified across PMS and booking_db — see
    # memory/project_hotel_data_ownership.md) rather than user_id, which
    # would clobber every hotel owned by a multi-hotel operator.
    # Surface failures: silent drift here is the root cause of guests
    # seeing the wrong payment options at checkout.
    try:
        await hotel_identity_service.set_payment_flags(hotel_id, updates)
    except Exception as e:
        logger.error("Failed to sync payment methods to booking engine: %s", e)
        raise HTTPException(
            status_code=502,
            detail="Failed to sync payment methods to booking engine. Please retry.",
        )

    return {"status": "updated"}


@router.patch("/cancellation-policy")
async def update_cancellation_policy(
    data: CancellationPolicyUpdate,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    updates = data.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    await CancellationPolicyRepository.upsert(hotel_id, updates)
    return {"status": "updated"}


# ── Stripe Connect ────────────────────────────────────────────────


@router.post("/stripe/connect-account")
async def create_stripe_connect_account(
    data: StripeConnectAccountRequest,
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    try:
        account = await stripe_service.create_connect_account(data.email, data.country)
    except Exception as e:
        error_msg = str(e)
        logger.error("Stripe Connect account creation failed: %s", error_msg)
        if "signed up for Connect" in error_msg:
            raise HTTPException(
                status_code=502,
                detail="Stripe Connect is not enabled on the platform account. Please activate it at https://dashboard.stripe.com/connect",
            )
        raise HTTPException(status_code=502, detail=f"Stripe error: {error_msg}")
    await HotelPaymentSettingsRepository.upsert(
        hotel_id,
        {
            "stripe_connect_account_id": account["id"],
            "stripe_connect_onboarded": False,
            "payment_provider": "stripe",
        },
    )
    return {"accountId": account["id"]}


@router.get("/stripe/connect-onboarding-link")
async def get_stripe_onboarding_link(
    user_id: str = Depends(require_hotel_admin),
):
    hotel_id = await get_hotel_id(user_id)
    payment_settings = await HotelPaymentSettingsRepository.get_by_hotel_id(hotel_id)
    if not payment_settings or not payment_settings.get("stripe_connect_account_id"):
        raise HTTPException(status_code=400, detail="No Stripe Connect account found")

    # Starting or resuming Stripe onboarding is an explicit provider choice.
    # Persist it before leaving Vayada so returning to the settings page cannot
    # fall back to the previously stored provider.
    await HotelPaymentSettingsRepository.upsert(hotel_id, {"payment_provider": "stripe"})

    booking_admin_settings_url = f"{app_settings.BOOKING_ADMIN_URL.rstrip('/')}/settings"

    url = await stripe_service.create_connect_account_link(
        payment_settings["stripe_connect_account_id"],
        return_url=f"{booking_admin_settings_url}?section=payments&stripe=success",
        refresh_url=f"{booking_admin_settings_url}?section=payments&stripe=refresh",
    )
    return {"url": url}


# ── Xendit ────────────────────────────────────────────────────────


@router.post("/xendit/validate-bank-account")
async def validate_xendit_bank_account(
    data: XenditBankDetailsRequest,
    user_id: str = Depends(require_hotel_admin),
):
    """Validate a bank account via Xendit before saving it."""
    try:
        result = await xendit_service.validate_bank_account(
            channel_code=data.channel_code,
            account_number=data.account_number,
        )
    except XenditError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result


@router.post("/xendit/reconcile-payouts")
async def reconcile_xendit_payouts(
    user_id: str = Depends(require_hotel_admin),
):
    """Manually reconcile all Xendit payouts stuck in 'processing' for this hotel."""
    hotel_id = await get_hotel_id(user_id)
    from app.repositories.payout_repo import PayoutRepository

    stale = await PayoutRepository.list_processing_xendit(older_than_minutes=0)
    # Filter to this hotel's payouts
    hotel_payouts = [
        p
        for p in stale
        if str(p.get("recipient_id")) == hotel_id and p.get("recipient_type") == "hotel"
    ]

    results = []
    for payout in hotel_payouts:
        payout_id = str(payout["id"])
        xendit_id = payout["xendit_payout_id"]
        try:
            status_data = await xendit_service.get_payout(xendit_id)
            xendit_status = status_data["status"]

            if xendit_status == "SUCCEEDED":
                await PayoutRepository.update_status(
                    payout_id, "completed", xendit_payout_id=xendit_id
                )
                results.append({"payoutId": payout_id, "status": "completed"})
            elif xendit_status in ("FAILED", "REVERSED"):
                await PayoutRepository.update_status(payout_id, "failed")
                results.append({"payoutId": payout_id, "status": "failed"})
            else:
                results.append({"payoutId": payout_id, "status": xendit_status.lower()})
        except XenditError as e:
            results.append({"payoutId": payout_id, "status": "error", "error": str(e)})

    return {"reconciled": len(results), "payouts": results}

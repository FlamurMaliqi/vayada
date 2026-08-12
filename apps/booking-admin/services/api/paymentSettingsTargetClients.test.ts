import { describe, expect, it } from "vitest";

import {
  getBookingHotelPropertyLink,
  type BookingHotelPropertyLink,
} from "./bookingPropertyLinkClient";
import { omitHotelContext, type ApiClient } from "./client";
import {
  buildFinancePaymentSettingsBody,
  createFinanceStripeProviderAccount,
  getFinancePaymentSettings,
  issueFinanceStripeOnboardingLink,
  payAtHotelMethodsFromFinance,
  updateFinancePaymentSettings,
  type UpdateFinancePaymentSettingsBody,
} from "./financePaymentSettingsClient";

describe("payment settings target clients", () => {
  it("resolves the booking hotel property link without legacy hotel context", async () => {
    const calls: Array<{ endpoint: string; options?: RequestInit }> = [];
    const link: BookingHotelPropertyLink = {
      hotelId: "hotel/with space",
      propertyId: "property_target_123",
      resourceLinks: {
        bookingHotel: true,
        pmsProperty: true,
        financeProperty: true,
      },
    };
    const client = {
      get: async <T>(endpoint: string, options?: RequestInit) => {
        calls.push({ endpoint, options });
        return link as T;
      },
    } satisfies Pick<ApiClient, "get">;

    const result = await getBookingHotelPropertyLink({ hotelId: " hotel/with space " }, client);

    expect(result).toBe(link);
    expect(calls).toEqual([
      {
        endpoint: "/api/booking/hotels/hotel%2Fwith%20space/property-link",
        options: omitHotelContext,
      },
    ]);
  });

  it("patches Finance payment settings without legacy hotel context", async () => {
    const body: UpdateFinancePaymentSettingsBody = {
      commandId: "cmd-payment-settings",
      idempotencyKey: "idem-payment-settings",
      paymentSettings: {
        paymentsEnabled: true,
        paymentProvider: "stripe",
        acceptedMethods: ["card"],
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR"],
      },
    };
    const calls: Array<{ endpoint: string; body?: unknown; options?: RequestInit }> = [];
    const client = {
      patch: async <T>(endpoint: string, payload?: unknown, options?: RequestInit) => {
        calls.push({ endpoint, body: payload, options });
        return {
          contractVersion: "finance-route-contracts.v1",
          propertyId: "property/with space",
          paymentSettings: {},
          commandMeta: {
            commandId: body.commandId,
            idempotencyKey: body.idempotencyKey,
            sideEffects: ["audit_event"],
            outboxEvents: [],
            jobs: [],
          },
        } as T;
      },
    } satisfies Pick<ApiClient, "patch">;

    await updateFinancePaymentSettings({ propertyId: " property/with space ", body }, client);

    expect(calls).toEqual([
      {
        endpoint: "/api/finance/properties/property%2Fwith%20space/payment-settings",
        body,
        options: omitHotelContext,
      },
    ]);
  });

  it("reads Finance payment settings without legacy hotel context", async () => {
    const calls: Array<{ endpoint: string; options?: RequestInit }> = [];
    const response = {
      contractVersion: "finance-route-contracts.v1",
      propertyId: "property_target_123",
      paymentSettings: {
        paymentsEnabled: true,
        paymentProvider: "stripe" as const,
        acceptedMethods: ["card" as const],
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR"],
        requiresManualReview: false,
        providerAccount: {
          providerAccountId: "provider_account_123",
          provider: "stripe" as const,
          status: "setup_incomplete",
          onboardingStatus: "invited",
          chargesEnabled: false,
          payoutsEnabled: false,
          capabilities: [],
        },
      },
    };
    const client = {
      get: async <T>(endpoint: string, options?: RequestInit) => {
        calls.push({ endpoint, options });
        return response as T;
      },
    } satisfies Pick<ApiClient, "get">;

    await getFinancePaymentSettings({ propertyId: " property_target_123 " }, client);

    expect(calls).toEqual([
      {
        endpoint: "/api/finance/properties/property_target_123/payment-settings",
        options: omitHotelContext,
      },
    ]);
  });

  it("creates Stripe provider accounts and onboarding links through Finance", async () => {
    const calls: Array<{ endpoint: string; body?: unknown; options?: RequestInit }> = [];
    const client = {
      post: async <T>(endpoint: string, body?: unknown, options?: RequestInit) => {
        calls.push({ endpoint, body, options });
        return {
          contractVersion: "finance-route-contracts.v1",
          providerAccountId: "provider_account_123",
          provider: "stripe",
          providerAccountRef: "acct_123",
          status: "setup_incomplete",
          onboardingStatus: "invited",
          onboardingUrl: "https://connect.stripe.test/onboard/acct_123",
        } as T;
      },
    } satisfies Pick<ApiClient, "post">;

    await createFinanceStripeProviderAccount(
      {
        propertyId: " property/with space ",
        email: "owner@example.com",
        country: "AT",
        commandPrefix: "stripe-account-test",
      },
      client,
    );
    await issueFinanceStripeOnboardingLink(
      {
        propertyId: " property/with space ",
        providerAccountId: " provider/with space ",
        commandPrefix: "stripe-link-test",
      },
      client,
    );

    expect(calls).toMatchObject([
      {
        endpoint: "/api/finance/properties/property%2Fwith%20space/provider-accounts/stripe",
        body: {
          email: "owner@example.com",
          country: "AT",
          returnSurface: "booking_admin",
        },
        options: omitHotelContext,
      },
      {
        endpoint:
          "/api/finance/properties/property%2Fwith%20space/provider-accounts/provider%2Fwith%20space/onboarding-link",
        options: omitHotelContext,
      },
    ]);
    expect(calls[0]!.body).toMatchObject({
      commandId: expect.stringMatching(/^stripe-account-test-/),
      idempotencyKey: expect.stringMatching(/^stripe-account-test-/),
    });
    expect(calls[1]!.body).toMatchObject({
      commandId: expect.stringMatching(/^stripe-link-test-/),
      idempotencyKey: expect.stringMatching(/^stripe-link-test-/),
      returnSurface: "booking_admin",
    });
  });

  it("maps Booking Admin toggles to strict Finance payment methods", () => {
    const body = buildFinancePaymentSettingsBody({
      payAtPropertyEnabled: true,
      payAtHotelMethods: ["cash", "card"],
      onlineCardPayment: false,
      bankTransfer: true,
      payoutAccountHolder: "Hotel Alpenrose GmbH",
      payoutAccountType: "iban",
      payoutIban: "DE89370400440532013000",
      payoutBankName: "Commerzbank",
      payoutSwift: "COBADEFFXXX",
      paymentProvider: "stripe",
      defaultCurrency: "chf",
      commandPrefix: "test-command",
    });

    expect(body.commandId).toMatch(/^test-command-/);
    expect(body.idempotencyKey).toBe(body.commandId);
    expect(body.paymentSettings).toMatchObject({
      paymentsEnabled: true,
      paymentProvider: "stripe",
      acceptedMethods: ["pay_at_property", "cash", "manual_card", "bank_transfer"],
      defaultCurrency: "CHF",
      supportedCurrencies: ["CHF"],
      requiresManualReview: false,
      depositPolicy: {
        bankTransferInstructions:
          "Account holder: Hotel Alpenrose GmbH\nIBAN: DE89370400440532013000\nBank: Commerzbank\nSWIFT/BIC: COBADEFFXXX",
      },
    });
  });

  it("round-trips a cash-only onboarding choice without adding card at hotel", () => {
    const payAtHotelMethods = payAtHotelMethodsFromFinance(["pay_at_property", "cash"]);
    const body = buildFinancePaymentSettingsBody({
      payAtPropertyEnabled: true,
      payAtHotelMethods,
      onlineCardPayment: false,
      bankTransfer: false,
      paymentProvider: "stripe",
      defaultCurrency: "EUR",
      commandPrefix: "cash-only-round-trip",
    });

    expect(payAtHotelMethods).toEqual(["cash"]);
    expect(body.paymentSettings.acceptedMethods).toEqual(["pay_at_property", "cash"]);
  });

  it("does not enable incomplete manual payment methods", () => {
    expect(() =>
      buildFinancePaymentSettingsBody({
        payAtPropertyEnabled: false,
        onlineCardPayment: false,
        bankTransfer: true,
        payoutAccountHolder: "Hotel One",
        payoutAccountType: "iban",
        payoutIban: "DE123",
        paymentProvider: "stripe",
        defaultCurrency: "EUR",
      }),
    ).toThrow("Bank name is required.");

    expect(() =>
      buildFinancePaymentSettingsBody({
        payAtPropertyEnabled: false,
        onlineCardPayment: false,
        bankTransfer: false,
        paypalEnabled: true,
        paypalEmail: "not-an-email",
        paymentProvider: "stripe",
        defaultCurrency: "EUR",
      }),
    ).toThrow("PayPal email must be a valid email address.");
  });

  it("requires at least one public payment method", () => {
    expect(() =>
      buildFinancePaymentSettingsBody({
        payAtPropertyEnabled: false,
        payAtHotelMethods: [],
        onlineCardPayment: false,
        bankTransfer: false,
        paypalEnabled: false,
        paymentProvider: "stripe",
        defaultCurrency: "EUR",
      }),
    ).toThrow("Choose at least one payment method.");
  });
});

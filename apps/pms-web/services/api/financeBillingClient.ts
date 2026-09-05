import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";
import { resolveSelectedPmsPropertyId } from "./pmsPropertyClient";

export type BillingPlan = "commission" | "fixed";
export type BillingPaymentMethod = "card" | "bank_transfer";

export type BillingOverview = {
  propertyId: string;
  planStatus: {
    plan: BillingPlan;
    status: "commission" | "checkout_pending" | "active" | "past_due" | "cancel_at_period_end";
    currency: string;
    activeRoomCount: number;
    amountMinor: number;
    fixedPlanAvailable: boolean;
    nextBillingDate: string | null;
    checkoutPending: boolean;
    customerPortalAvailable: boolean;
  };
  paymentMethod: BillingPaymentMethod;
  savedCard: {
    brand: string;
    last4: string;
    expiryMonth: number;
    expiryYear: number;
  } | null;
  billingDetails: {
    companyName: string;
    billingEmail: string;
    taxId: string | null;
  };
  invoices: Array<{
    id: string;
    number: string;
    issuedAt: string;
    amountMinor: number;
    currency: string;
    status: "paid" | "pending" | "failed";
    pdfUrl: string | null;
  }>;
};

type BillingResponse = BillingOverview & { contractVersion: "finance-billing.v1" };

export async function getFinanceBilling(): Promise<BillingOverview> {
  const propertyId = await resolveSelectedPmsPropertyId("loading billing settings");
  return pmsOperationsClient.get<BillingResponse>(endpoint(propertyId, "billing"), requestOptions);
}

export async function startFixedPlanCheckout(): Promise<string> {
  const propertyId = await resolveSelectedPmsPropertyId("switching billing plans");
  const response = await pmsOperationsClient.post<{
    checkout: { checkoutUrl: string };
  }>(
    endpoint(propertyId, "fixed-plan/checkout"),
    { ...command("fixed-plan"), returnSurface: "pms" },
    requestOptions,
  );
  return response.checkout.checkoutUrl;
}

export async function activateFixedPlanByInvoice(): Promise<BillingOverview> {
  const propertyId = await resolveSelectedPmsPropertyId("switching billing plans");
  return pmsOperationsClient.post<BillingResponse>(
    endpoint(propertyId, "fixed-plan/invoice"),
    command("fixed-plan-invoice"),
    requestOptions,
  );
}

export async function activateFixedPlanByCard(): Promise<BillingOverview> {
  const propertyId = await resolveSelectedPmsPropertyId("switching billing plans");
  return pmsOperationsClient.post<BillingResponse>(
    endpoint(propertyId, "fixed-plan/card"),
    command("fixed-plan-card"),
    requestOptions,
  );
}

export async function switchToCommissionNow(): Promise<void> {
  const propertyId = await resolveSelectedPmsPropertyId("switching billing plans");
  await pmsOperationsClient.post(
    endpoint(propertyId, "switch-to-commission-now"),
    command("commission-plan"),
    requestOptions,
  );
}

export async function saveBillingDetails(details: {
  companyName: string;
  billingEmail: string;
  taxId: string | null;
}): Promise<BillingOverview> {
  const propertyId = await resolveSelectedPmsPropertyId("saving billing details");
  return pmsOperationsClient.patch<BillingResponse>(
    endpoint(propertyId, "billing-details"),
    { ...command("billing-details"), ...details },
    requestOptions,
  );
}

export async function savePaymentMethod(
  paymentMethod: BillingPaymentMethod,
): Promise<BillingOverview> {
  const propertyId = await resolveSelectedPmsPropertyId("saving the payment method");
  return pmsOperationsClient.patch<BillingResponse>(
    endpoint(propertyId, "payment-method"),
    { ...command("payment-method"), paymentMethod },
    requestOptions,
  );
}

export async function openBillingPortal(): Promise<string> {
  const propertyId = await resolveSelectedPmsPropertyId("opening secure card settings");
  const response = await pmsOperationsClient.post<{
    customerPortal: { portalUrl: string };
  }>(
    endpoint(propertyId, "customer-portal"),
    { ...command("customer-portal"), returnSurface: "pms" },
    requestOptions,
  );
  return response.customerPortal.portalUrl;
}

function endpoint(propertyId: string, path: string): string {
  return `/api/finance/properties/${encodeURIComponent(propertyId)}/${path}`;
}

function command(scope: string): { commandId: string; idempotencyKey: string } {
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
  return { commandId: `${scope}-${id}`, idempotencyKey: `${scope}-${id}` };
}

const requestOptions: RequestInit = {
  ...pmsOperationsRequestOptions,
  cache: "no-store",
};

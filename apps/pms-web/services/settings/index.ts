import { pmsOperationsClient, pmsOperationsRequestOptions } from "../api/pmsOperationsClient";
import {
  getPmsPropertyProfile,
  listPmsProperties,
  resolveSelectedPmsPropertyId,
} from "../api/pmsPropertyClient";
import { unsupportedPmsNextStackFeature } from "../api/unsupported";

export interface HotelSummary {
  id: string;
  name: string;
  slug: string;
  location: string;
  country: string;
}

export interface HotelDetails extends HotelSummary {
  timezone: string;
}

// Slice of the booking-engine PropertySettings the PMS reads/writes —
// shared with BE Admin so the currency selector hits the same field.
export interface PropertySettings {
  default_currency: string;
}

export type PropertySettingsUpdate = Partial<PropertySettings>;

export type BookingAcceptanceMode = "instant" | "request";

export interface BookingAcceptanceSettings {
  contractVersion: "booking-acceptance.v1";
  propertyId: string;
  acceptanceMode: BookingAcceptanceMode;
  instantBook: boolean;
}

export type CheckinStepType = "checkbox" | "text" | "amount";
export type CheckinChecklistStepType = CheckinStepType;

export interface CheckinChecklistStep {
  id: string;
  label: string;
  prompt?: string;
  type: CheckinChecklistStepType;
  required: boolean;
  system?: boolean;
  position: number;
}

export interface CheckinChecklistTemplate {
  steps: CheckinChecklistStep[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface CheckoutInspectionStep {
  id: string;
  label: string;
  okLabel: string;
  negativeLabel: string;
  notePrompt: string;
  required: boolean;
  position: number;
}

export interface CheckoutInspectionTemplate {
  steps: CheckoutInspectionStep[];
  updatedAt: string | null;
  updatedBy: string | null;
}

interface PmsOperationsTemplateStep {
  stepId: string;
  label: string;
  required: boolean;
}

interface PmsOperationsTemplateResponse {
  template: {
    steps: PmsOperationsTemplateStep[];
    updatedAt: string | null;
    updatedByUserId: string | null;
  };
}

function propertyTemplateEndpoint(propertyId: string, suffix: string): string {
  return `/api/pms/properties/${encodeURIComponent(propertyId)}/${suffix}`;
}

function commandId(prefix: string): string {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${id}`;
}

function toOperationsSteps(
  steps: Array<{ id: string; label: string; required: boolean }>,
): PmsOperationsTemplateStep[] {
  return steps.map((step) => ({
    stepId: step.id,
    label: step.label,
    required: step.required,
  }));
}

function toCheckinTemplate(response: PmsOperationsTemplateResponse): CheckinChecklistTemplate {
  return {
    steps: response.template.steps.map((step, position) => ({
      id: step.stepId,
      label: step.label,
      prompt: "",
      type: "checkbox",
      required: step.required,
      system: false,
      position,
    })),
    updatedAt: response.template.updatedAt,
    updatedBy: response.template.updatedByUserId,
  };
}

function toCheckoutTemplate(response: PmsOperationsTemplateResponse): CheckoutInspectionTemplate {
  return {
    steps: response.template.steps.map((step, position) => ({
      id: step.stepId,
      label: step.label,
      okLabel: "OK",
      negativeLabel: "Issue",
      notePrompt: "Add details...",
      required: step.required,
      position,
    })),
    updatedAt: response.template.updatedAt,
    updatedBy: response.template.updatedByUserId,
  };
}

async function getOperationsTemplate(
  suffix: "check-in-checklist" | "check-out-inspection",
): Promise<PmsOperationsTemplateResponse> {
  const propertyId = await resolveSelectedPmsPropertyId(`loading ${suffix}`);
  return pmsOperationsClient.get<PmsOperationsTemplateResponse>(
    propertyTemplateEndpoint(propertyId, suffix),
    pmsOperationsRequestOptions,
  );
}

async function updateOperationsTemplate(
  suffix: "check-in-checklist" | "check-out-inspection",
  steps: PmsOperationsTemplateStep[],
): Promise<PmsOperationsTemplateResponse> {
  const propertyId = await resolveSelectedPmsPropertyId(`saving ${suffix}`);
  const id = commandId(`pms.${suffix}`);
  return pmsOperationsClient.put<PmsOperationsTemplateResponse>(
    propertyTemplateEndpoint(propertyId, suffix),
    { commandId: id, idempotencyKey: id, steps },
    pmsOperationsRequestOptions,
  );
}

export const pmsSettingsService = {
  listHotels: () => listPmsProperties(),

  getHotelDetails: () => getPmsPropertyProfile(),
};

export const settingsService = {
  getBookingAcceptance: async () => {
    const propertyId = await resolveSelectedPmsPropertyId("loading booking acceptance settings");
    return pmsOperationsClient.get<BookingAcceptanceSettings>(
      propertyTemplateEndpoint(propertyId, "booking-acceptance"),
      pmsOperationsRequestOptions,
    );
  },

  updateBookingAcceptance: async (acceptanceMode: BookingAcceptanceMode) => {
    const propertyId = await resolveSelectedPmsPropertyId("saving booking acceptance settings");
    return pmsOperationsClient.put<BookingAcceptanceSettings>(
      propertyTemplateEndpoint(propertyId, "booking-acceptance"),
      { acceptanceMode },
      pmsOperationsRequestOptions,
    );
  },

  getPropertySettings: () =>
    unsupportedPmsNextStackFeature<PropertySettings>("Property currency settings"),

  updatePropertySettings: (_data: PropertySettingsUpdate) =>
    unsupportedPmsNextStackFeature<PropertySettings>("Property currency settings"),

  getCheckinChecklist: async () =>
    toCheckinTemplate(await getOperationsTemplate("check-in-checklist")),

  updateCheckinChecklist: (steps: CheckinChecklistStep[]) =>
    updateOperationsTemplate("check-in-checklist", toOperationsSteps(steps)).then(
      toCheckinTemplate,
    ),

  getCheckoutInspection: () =>
    getOperationsTemplate("check-out-inspection").then(toCheckoutTemplate),

  updateCheckoutInspection: (steps: CheckoutInspectionStep[]) =>
    updateOperationsTemplate("check-out-inspection", toOperationsSteps(steps)).then(
      toCheckoutTemplate,
    ),
};

"use client";

import { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowRightIcon,
  CheckIcon,
  ExclamationCircleIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";

import {
  SHARED_HOTEL_SETUP_PRODUCTS,
  canOpenMarketplaceProfileTools,
  isSharedHotelSetupProductSelectable,
  resolveSharedFirstRunSetupView,
  selectedProductsForProperty,
  type SharedFirstRunSetupViewModel,
  type SharedHotelSetupEntryProduct,
  type SharedHotelSetupProduct,
  type SharedHotelSetupStatus,
  type SharedProductActivation,
  type SharedPropertyProfile,
  type SharedPropertyProfileInput,
  type SharedSetupProperty,
} from "./sharedFirstRunSetupFlow";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";

type ProductLabels = Record<SharedHotelSetupProduct, string>;

export type SharedFirstRunProductContinueInput = {
  product: SharedHotelSetupProduct;
  productStatus: SharedProductActivation<SharedHotelSetupProduct>["status"] | null;
  propertyId: string;
  missingSteps: string[];
  returnTo: string | null;
  action: "complete_product_activation" | "enter_product";
};

export type SharedFirstRunPropertySetupWizardProps = {
  api: SharedHotelSetupApi;
  entryProduct: SharedHotelSetupEntryProduct;
  returnTo?: string | null;
  initialAddProperty?: boolean;
  embedded?: boolean;
  productLabels?: Partial<ProductLabels>;
  onProductContinue: (input: SharedFirstRunProductContinueInput) => void;
};

type ProfileDraft = {
  displayName: string;
  countryCode: string;
  region: string;
  city: string;
  rawMarketplaceLocation: string;
  streetAddress: string;
  postalCode: string;
  timezone: string;
  website: string;
  phone: string;
  shortDescription: string;
  longDescription: string;
  mediaUrl: string;
};

const DEFAULT_PRODUCT_LABELS: ProductLabels = {
  booking: "Booking Engine",
  pms: "PMS",
  marketplace: "Creator Marketplace",
};

const MARKETPLACE_ACTIVATION_STEPS: Record<string, { title: string; description: string }> = {
  productEntitlement: {
    title: "Marketplace access",
    description: "Confirm this property is enabled for Creator Marketplace.",
  },
  creatorPitch: {
    title: "Creator-facing pitch",
    description: "Add the message creators should see when evaluating this property.",
  },
  collaborationOffer: {
    title: "Collaboration offer",
    description: "Define what you offer creators, including availability and terms.",
  },
  creatorRequirements: {
    title: "Creator requirements",
    description: "Set the platforms, audience, and creator profile you want to work with.",
  },
  marketplaceListing: {
    title: "Marketplace listing setup",
    description: "Add the listing details and photos creators use for discovery.",
  },
};

const SETUP_STEPS = [
  { label: "Property", description: "Shared profile and location" },
  { label: "Products", description: "Choose enabled products" },
  { label: "Continue", description: "Open the selected product" },
] as const;

const PRODUCT_DESCRIPTIONS: Record<SharedHotelSetupProduct, string> = {
  booking: "Direct booking pages, checkout, and guest-facing availability.",
  pms: "Rooms, calendar, reservations, and daily property operations.",
  marketplace: "Creator discovery, collaboration offers, and listing tools.",
};

const EMPTY_DRAFT: ProfileDraft = {
  displayName: "",
  countryCode: "",
  region: "",
  city: "",
  rawMarketplaceLocation: "",
  streetAddress: "",
  postalCode: "",
  timezone: "",
  website: "",
  phone: "",
  shortDescription: "",
  longDescription: "",
  mediaUrl: "",
};

export default function SharedFirstRunPropertySetupWizard({
  api,
  entryProduct,
  returnTo = null,
  initialAddProperty = false,
  embedded = false,
  productLabels,
  onProductContinue,
}: SharedFirstRunPropertySetupWizardProps) {
  const labels = { ...DEFAULT_PRODUCT_LABELS, ...productLabels };
  const [status, setStatus] = useState<SharedHotelSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [forceCreateProperty, setForceCreateProperty] = useState(initialAddProperty);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileLoadFailed, setProfileLoadFailed] = useState(false);
  const [profileReloadToken, setProfileReloadToken] = useState(0);
  const [loadedProfile, setLoadedProfile] = useState<SharedPropertyProfile | null>(null);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [selectedProducts, setSelectedProducts] = useState<SharedHotelSetupProduct[]>([
    entryProduct,
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const view = useMemo(
    () => resolveSharedFirstRunSetupView(status, { forceCreateProperty }),
    [forceCreateProperty, status],
  );

  useEffect(() => {
    setForceCreateProperty(initialAddProperty);
  }, [initialAddProperty]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    api
      .getStatus({ entryProduct, returnTo })
      .then((nextStatus) => {
        if (cancelled) return;
        setStatus(nextStatus);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, entryProduct, returnTo]);

  useEffect(() => {
    const propertyId = view.profileMode === "update" ? view.selectedPropertyId : null;
    if (!propertyId) {
      setProfileLoadFailed(false);
      setLoadedProfile(null);
      setDraft(EMPTY_DRAFT);
      return;
    }

    let cancelled = false;
    setProfileLoading(true);
    setProfileLoadFailed(false);
    setError("");

    api
      .getPropertyProfile(propertyId)
      .then((nextProfile) => {
        if (cancelled) return;
        setLoadedProfile(nextProfile);
        setDraft(draftFromProfile(nextProfile));
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadedProfile(null);
        setProfileLoadFailed(true);
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, profileReloadToken, view.profileMode, view.selectedPropertyId]);

  useEffect(() => {
    if (view.screen !== "product_selection") return;
    setSelectedProducts(selectedProductsForProperty(view.selectedProperty, entryProduct));
  }, [entryProduct, view.screen, view.selectedProperty]);

  const reloadStatus = async (propertyId?: string | null) => {
    const nextStatus = await api.getStatus({ entryProduct, returnTo, propertyId });
    setStatus(nextStatus);
    return nextStatus;
  };

  const handleSelectProperty = async (propertyId: string) => {
    setError("");
    setForceCreateProperty(false);
    setLoading(true);
    try {
      await reloadStatus(propertyId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfile = async () => {
    setError("");
    setFieldErrors({});
    const nextFieldErrors = validateProfileDraft(draft);
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      return;
    }

    setSaving(true);
    try {
      if (view.profileMode === "update" && !loadedProfile) {
        setError("The existing property profile could not be loaded.");
        return;
      }
      const input = profileInputFromDraft(draft, loadedProfile);
      const saved =
        view.profileMode === "update" && view.selectedPropertyId
          ? await api.updatePropertyProfile(view.selectedPropertyId, input)
          : await api.createPropertyProfile(input);
      setLoadedProfile(saved);
      setForceCreateProperty(false);
      await reloadStatus(saved.propertyId);
    } catch (err) {
      setFieldErrors(fieldErrorsFromError(err));
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveProducts = async () => {
    if (!view.selectedPropertyId) return;
    setError("");
    setSaving(true);
    try {
      const selectableProducts = selectedProducts.filter((product) =>
        isSharedHotelSetupProductSelectable(view.selectedProperty, product),
      );
      await api.saveProductSelection(view.selectedPropertyId, selectableProducts);
      await reloadStatus(view.selectedPropertyId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleContinueProduct = () => {
    if (!view.selectedPropertyId || !view.product) return;
    const activation = view.selectedProperty?.products[view.product] ?? null;
    onProductContinue({
      product: view.product,
      productStatus: activation?.status ?? null,
      propertyId: view.selectedPropertyId,
      missingSteps: activation?.missingSteps ?? [],
      returnTo: status?.entry.returnTo ?? returnTo,
      action: view.screen === "enter_product" ? "enter_product" : "complete_product_activation",
    });
  };

  if (loading || !status) {
    if (!loading && error) {
      return (
        <WizardShell title="Setup unavailable" view={view} embedded={embedded}>
          <div
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            role="alert"
          >
            {error}
          </div>
        </WizardShell>
      );
    }

    return <WizardShell title="Setting up your property" view={view} loading embedded={embedded} />;
  }

  return (
    <WizardShell title={view.title} view={view} status={status} embedded={embedded}>
      {error && !(view.screen === "property_profile" && profileLoadFailed) && (
        <div
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          role="alert"
        >
          {error}
        </div>
      )}

      {view.screen === "property_selection" && (
        <PropertySelection
          properties={status.properties}
          onSelect={handleSelectProperty}
          onAdd={() => {
            setDraft(EMPTY_DRAFT);
            setLoadedProfile(null);
            setForceCreateProperty(true);
          }}
        />
      )}

      {view.screen === "property_profile" && profileLoadFailed && (
        <ProfileLoadError
          error={error}
          onRetry={() => setProfileReloadToken((value) => value + 1)}
        />
      )}

      {view.screen === "property_profile" && !profileLoadFailed && (
        <ProfileForm
          draft={draft}
          mode={view.profileMode ?? "create"}
          loading={profileLoading}
          saving={saving}
          selectedProperty={view.selectedProperty}
          fieldErrors={fieldErrors}
          onChange={setDraft}
          onCancel={
            status.properties.length > 0 && view.profileMode === "create"
              ? () => setForceCreateProperty(false)
              : undefined
          }
          onSave={handleSaveProfile}
        />
      )}

      {view.screen === "product_selection" && (
        <ProductSelection
          labels={labels}
          selectedProducts={selectedProducts}
          selectedProperty={view.selectedProperty}
          saving={saving}
          onToggle={(product) => {
            setSelectedProducts((current) =>
              current.includes(product)
                ? current.filter((item) => item !== product)
                : [...current, product],
            );
          }}
          onSave={handleSaveProducts}
        />
      )}

      {(view.screen === "product_activation" || view.screen === "enter_product") && (
        <ProductContinue labels={labels} view={view} onContinue={handleContinueProduct} />
      )}
    </WizardShell>
  );
}

function WizardShell({
  children,
  title,
  view,
  status,
  loading = false,
  embedded = false,
}: {
  children?: React.ReactNode;
  title: string;
  view: SharedFirstRunSetupViewModel;
  status?: SharedHotelSetupStatus;
  loading?: boolean;
  embedded?: boolean;
}) {
  const progress =
    view.screen === "product_selection"
      ? 2
      : view.screen === "product_activation" || view.screen === "enter_product"
        ? 3
        : 1;
  const currentStep = SETUP_STEPS[progress - 1];
  const nextStep = SETUP_STEPS.at(progress) ?? null;

  if (embedded) {
    return (
      <section className="min-w-0 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-100 px-5 py-4 sm:px-6">
          <p className="text-xs font-semibold text-primary-600">
            {status?.hotelGroup.displayName ?? "Hotel setup"}
          </p>
          <div className="mt-1 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-950">{title}</h2>
              <p className="mt-1 text-sm text-gray-500">
                Step {progress} of {SETUP_STEPS.length}: {currentStep.description}
              </p>
            </div>
            {nextStep && <p className="text-sm text-gray-500">Next: {nextStep.label}</p>}
          </div>

          <ol className="mt-4 grid gap-2 sm:grid-cols-3" aria-label="Property setup progress">
            {SETUP_STEPS.map((step, index) => {
              const stepNumber = index + 1;
              const complete = stepNumber < progress;
              const current = stepNumber === progress;
              return (
                <li
                  key={step.label}
                  aria-current={current ? "step" : undefined}
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${
                    current ? "border-primary-200 bg-primary-50" : "border-gray-100"
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold ${
                      complete || current
                        ? "bg-primary-600 text-white"
                        : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {complete ? <CheckIcon className="h-4 w-4" aria-hidden="true" /> : stepNumber}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-950">{step.label}</span>
                    <span className="block text-xs text-gray-500">{step.description}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
        {loading ? (
          <div className="flex min-h-80 items-center justify-center p-5 sm:p-6">
            <LoadingSpinner label="Loading setup" />
          </div>
        ) : (
          <div className="p-5 sm:p-6">{children}</div>
        )}
      </section>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-6 text-gray-900 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="rounded-lg border border-gray-200 bg-white shadow-sm lg:self-start">
          <div className="border-b border-gray-100 p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">
              {status?.hotelGroup.displayName ?? "Hotel setup"}
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-normal text-gray-950">{title}</h1>
            <p className="mt-2 text-sm text-gray-500">
              Step {progress} of {SETUP_STEPS.length}: {currentStep.description}
            </p>
          </div>

          <ol className="space-y-1 p-4" aria-label="Setup progress">
            {SETUP_STEPS.map((step, index) => {
              const stepNumber = index + 1;
              const complete = stepNumber < progress;
              const current = stepNumber === progress;
              return (
                <li
                  key={step.label}
                  aria-current={current ? "step" : undefined}
                  className={`flex items-start gap-3 rounded-lg px-3 py-3 ${
                    current ? "bg-primary-50" : ""
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                      complete
                        ? "bg-primary-600 text-white"
                        : current
                          ? "bg-gray-950 text-white"
                          : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {complete ? <CheckIcon className="h-4 w-4" aria-hidden="true" /> : stepNumber}
                  </span>
                  <span>
                    <span
                      className={`block text-sm font-medium ${
                        current || complete ? "text-gray-950" : "text-gray-500"
                      }`}
                    >
                      {step.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-gray-500">{step.description}</span>
                  </span>
                </li>
              );
            })}
          </ol>

          {status?.entry.entryProduct && (
            <p className="mx-5 mb-5 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
              Started from {DEFAULT_PRODUCT_LABELS[status.entry.entryProduct]}.
            </p>
          )}
        </aside>

        <section className="min-w-0 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-5 py-4 sm:px-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Current step
            </p>
            <div className="mt-1 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <h2 className="text-lg font-semibold text-gray-950">{currentStep.label}</h2>
              {nextStep && <p className="text-sm text-gray-500">Next: {nextStep.label}</p>}
            </div>
          </div>
          {loading ? (
            <div className="flex min-h-80 items-center justify-center p-5 sm:p-6">
              <LoadingSpinner label="Loading setup" />
            </div>
          ) : (
            <div className="p-5 sm:p-6">{children}</div>
          )}
        </section>
      </div>
    </main>
  );
}

function LoadingSpinner({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label}>
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-950" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

function PropertySelection({
  properties,
  onSelect,
  onAdd,
}: {
  properties: SharedSetupProperty[];
  onSelect: (propertyId: string) => void;
  onAdd: () => void;
}) {
  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-950">Select a property</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Pick an existing property to finish setup, or add a new one to this hotel group.
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
        >
          <PlusIcon className="h-4 w-4" aria-hidden="true" />
          Add property
        </button>
      </div>

      <div className="grid gap-3">
        {properties.map((property) => (
          <button
            key={property.propertyId}
            type="button"
            onClick={() => onSelect(property.propertyId)}
            className="rounded-lg border border-gray-200 p-4 text-left transition hover:border-gray-950 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-950"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium text-gray-950">
                  {property.displayName ?? "Unnamed property"}
                </p>
                {property.locationSummary && (
                  <p className="mt-1 text-sm text-gray-500">{property.locationSummary}</p>
                )}
              </div>
              <span className="inline-flex w-fit items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
                {property.sharedProfile.completionPercent}% profile complete
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ProfileLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4" role="alert">
      <div className="flex gap-3">
        <ExclamationCircleIcon
          className="mt-0.5 h-5 w-5 shrink-0 text-red-600"
          aria-hidden="true"
        />
        <div>
          <h2 className="text-lg font-semibold text-red-900">Property profile unavailable</h2>
          <p className="mt-2 text-sm text-red-700">
            {error || "The existing property profile could not be loaded."}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-lg bg-red-900 px-4 py-2 text-sm font-medium text-white hover:bg-red-800"
      >
        Retry
      </button>
    </div>
  );
}

function ProfileForm({
  draft,
  mode,
  loading,
  saving,
  selectedProperty,
  fieldErrors,
  onChange,
  onCancel,
  onSave,
}: {
  draft: ProfileDraft;
  mode: "create" | "update";
  loading: boolean;
  saving: boolean;
  selectedProperty: SharedSetupProperty | null;
  fieldErrors: Record<string, string[]>;
  onChange: (draft: ProfileDraft) => void;
  onCancel?: () => void;
  onSave: () => void;
}) {
  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center">
        <LoadingSpinner label="Loading property profile" />
      </div>
    );
  }

  const setField = (field: keyof ProfileDraft, value: string) => {
    onChange({ ...draft, [field]: value });
  };
  const showRawLocation = Boolean(
    draft.rawMarketplaceLocation && !draft.city.trim() && !draft.countryCode.trim(),
  );

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
      className="space-y-6"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-950">Property details</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Complete the shared information needed before products can open. Required fields are
            marked.
          </p>
        </div>
        {selectedProperty && (
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
            {selectedProperty.sharedProfile.completionPercent}% complete
          </span>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-950">Identity</h3>
        <p className="mt-1 text-sm text-gray-500">
          These details are shared by PMS, Booking Engine, and Marketplace.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <TextField
            label="Property name"
            value={draft.displayName}
            placeholder="Alpenrose Munich"
            helper="Use the name staff and guests recognize."
            required
            error={fieldErrors.displayName?.[0]}
            onChange={(value) => setField("displayName", value)}
          />
          <TextField
            label="Website"
            type="url"
            value={draft.website}
            placeholder="https://alpenrose.example"
            helper="Public website used by guest and creator-facing products."
            required
            error={fieldErrors.website?.[0]}
            onChange={(value) => setField("website", value)}
          />
          <TextField
            label="Phone"
            value={draft.phone}
            placeholder="+49 89 123456"
            helper="Contact number shown where products need it."
            required
            error={fieldErrors.phone?.[0]}
            onChange={(value) => setField("phone", value)}
          />
          <TextField
            label="Photo URL"
            type="url"
            value={draft.mediaUrl}
            placeholder="https://images.example/alpenrose.jpg"
            helper="First image for shared product setup."
            required
            error={fieldErrors["media.0.url"]?.[0] ?? fieldErrors.media?.[0]}
            onChange={(value) => setField("mediaUrl", value)}
          />
        </div>
      </div>

      <div className="border-t border-gray-100 pt-6">
        <h3 className="text-sm font-semibold text-gray-950">Location</h3>
        <p className="mt-1 text-sm text-gray-500">
          City or country code is required to continue; exact public map settings can be refined
          later.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <TextField
            label="Country code"
            value={draft.countryCode}
            placeholder="DE"
            helper="Two-letter ISO code."
            requirementLabel="One required"
            error={fieldErrors["location.countryCode"]?.[0]}
            onChange={(value) => setField("countryCode", value.toUpperCase().slice(0, 2))}
          />
          <TextField
            label="City"
            value={draft.city}
            placeholder="Munich"
            requirementLabel="One required"
            error={fieldErrors["location.city"]?.[0]}
            onChange={(value) => setField("city", value)}
          />
          <TextField
            label="Region"
            value={draft.region}
            placeholder="Bavaria"
            error={fieldErrors["location.region"]?.[0]}
            onChange={(value) => setField("region", value)}
          />
          <TextField
            label="Timezone"
            value={draft.timezone}
            placeholder="Europe/Berlin"
            helper="IANA timezone used for calendars and operations."
            error={fieldErrors["location.timezone"]?.[0]}
            onChange={(value) => setField("timezone", value)}
          />
          {showRawLocation && (
            <div className="md:col-span-2">
              <TextField
                label="Imported location"
                value={draft.rawMarketplaceLocation}
                readOnly
                helper="Read-only location imported from the existing marketplace profile."
                onChange={() => undefined}
              />
            </div>
          )}
          <TextField
            label="Street address"
            value={draft.streetAddress}
            placeholder="Marienplatz 1"
            error={fieldErrors["location.streetAddress"]?.[0]}
            onChange={(value) => setField("streetAddress", value)}
          />
          <TextField
            label="Postal code"
            value={draft.postalCode}
            placeholder="80331"
            error={fieldErrors["location.postalCode"]?.[0]}
            onChange={(value) => setField("postalCode", value)}
          />
        </div>
      </div>

      <div className="border-t border-gray-100 pt-6">
        <h3 className="text-sm font-semibold text-gray-950">Description</h3>
        <p className="mt-1 text-sm text-gray-500">
          Keep the short version scannable; use the long description for details.
        </p>
        <div className="mt-4 grid gap-4">
          <TextArea
            label="Short description"
            value={draft.shortDescription}
            placeholder="A city hotel close to the old town."
            helper="One description is required. Use this for a scannable summary."
            requirementLabel="One required"
            error={fieldErrors.shortDescription?.[0]}
            onChange={(value) => setField("shortDescription", value)}
          />
          <TextArea
            label="Long description"
            value={draft.longDescription}
            placeholder="Add guest-facing details, amenities, and useful context."
            helper="Use this instead of the short description if more context is needed."
            requirementLabel="One required"
            error={fieldErrors.longDescription?.[0]}
            onChange={(value) => setField("longDescription", value)}
          />
        </div>
      </div>

      <div className="flex flex-col-reverse gap-3 border-t border-gray-100 pt-5 sm:flex-row sm:justify-end">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Back to properties
          </button>
        )}
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving && (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
              aria-hidden="true"
            />
          )}
          <span>{saving ? "Saving..." : "Save and continue"}</span>
          {!saving && <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
    </form>
  );
}

function ProductSelection({
  labels,
  selectedProducts,
  selectedProperty,
  saving,
  onToggle,
  onSave,
}: {
  labels: ProductLabels;
  selectedProducts: SharedHotelSetupProduct[];
  selectedProperty: SharedSetupProperty | null;
  saving: boolean;
  onToggle: (product: SharedHotelSetupProduct) => void;
  onSave: () => void;
}) {
  const needsSelection = selectedProducts.length === 0;

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-950">Choose products</h2>
        <p className="mt-1 max-w-2xl text-sm text-gray-500">
          Select the products this property should use. Disabled products are not available for this
          property.
        </p>
        {selectedProperty?.displayName && (
          <p className="mt-2 text-sm font-medium text-gray-700">{selectedProperty.displayName}</p>
        )}
      </div>

      <div className="grid gap-3">
        {SHARED_HOTEL_SETUP_PRODUCTS.map((product) => {
          const checked = selectedProducts.includes(product);
          const disabled = !isSharedHotelSetupProductSelectable(selectedProperty, product);
          return (
            <label
              key={product}
              className={`flex items-center justify-between rounded-lg border p-4 transition ${
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
              } ${
                checked
                  ? "border-primary-600 bg-primary-50"
                  : disabled
                    ? "border-gray-200"
                    : "border-gray-200 hover:border-gray-400"
              }`}
            >
              <span className="min-w-0 pr-4">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-gray-950">{labels[product]}</span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-gray-600 ring-1 ring-inset ring-gray-200">
                    {productStatusLabel(selectedProperty, product, checked)}
                  </span>
                </span>
                <span className="mt-1 block text-xs text-gray-500">
                  {PRODUCT_DESCRIPTIONS[product]}
                </span>
              </span>
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 rounded border-gray-300 text-primary-600 focus:ring-primary-600"
                checked={checked}
                disabled={disabled}
                onChange={() => {
                  if (!disabled) onToggle(product);
                }}
              />
            </label>
          );
        })}
      </div>

      {needsSelection && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          Select at least one available product to continue.
        </p>
      )}

      <div className="mt-5 flex flex-col gap-3 border-t border-gray-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-gray-500">
          {selectedProducts.length} product{selectedProducts.length === 1 ? "" : "s"} selected
        </p>
        <button
          type="button"
          disabled={saving || needsSelection}
          onClick={onSave}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving && (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
              aria-hidden="true"
            />
          )}
          <span>{saving ? "Saving..." : "Save products"}</span>
          {!saving && <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

function ProductContinue({
  labels,
  view,
  onContinue,
}: {
  labels: ProductLabels;
  view: SharedFirstRunSetupViewModel;
  onContinue: () => void;
}) {
  const product = view.product;
  const isMarketplaceActivation = view.screen === "product_activation" && product === "marketplace";
  const activation = product ? (view.selectedProperty?.products[product] ?? null) : null;
  const missingSteps = activation?.missingSteps ?? [];
  const isBlockedMarketplaceActivation =
    isMarketplaceActivation &&
    !canOpenMarketplaceProfileTools({
      product,
      productStatus: activation?.status ?? null,
      missingSteps,
    });
  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-950">
          {isBlockedMarketplaceActivation
            ? "Marketplace activation unavailable"
            : isMarketplaceActivation
              ? "Activate Creator Marketplace"
              : product
                ? labels[product]
                : "Product setup"}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-gray-500">
          {isMarketplaceActivation
            ? `Set up Marketplace for ${view.selectedProperty?.displayName ?? "this property"}.`
            : (view.selectedProperty?.displayName ?? "Selected property")}
        </p>
      </div>
      <div
        className={`rounded-lg border p-4 ${
          isBlockedMarketplaceActivation ? "border-red-200 bg-red-50" : "border-gray-200 bg-gray-50"
        }`}
      >
        <p className="text-sm text-gray-700">
          {isBlockedMarketplaceActivation
            ? marketplaceBlockedActivationCopy(activation?.status)
            : isMarketplaceActivation
              ? "The shared property profile is ready. Finish the Marketplace-specific setup below; you do not need to re-enter hotel name, location, website, phone, or the shared property description."
              : view.screen === "enter_product"
                ? "This property is ready for the selected product."
                : "The shared profile is ready. Continue into the selected product setup."}
        </p>
        {isMarketplaceActivation && missingSteps.length > 0 && (
          <div className="mt-4 grid gap-3">
            {missingSteps.map((step) => {
              const item = marketplaceActivationStepCopy(step);
              return (
                <div key={step} className="rounded-lg border border-gray-200 bg-white p-3">
                  <p className="text-sm font-medium text-gray-950">{item.title}</p>
                  <p className="mt-1 text-xs text-gray-500">{item.description}</p>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="mt-5 flex justify-end border-t border-gray-100 pt-5">
        <button
          type="button"
          disabled={!product || isBlockedMarketplaceActivation}
          onClick={onContinue}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span>
            {isBlockedMarketplaceActivation
              ? "Marketplace unavailable"
              : isMarketplaceActivation
                ? "Open Marketplace listing tools"
                : "Continue"}
          </span>
          {!isBlockedMarketplaceActivation && (
            <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}

function marketplaceBlockedActivationCopy(
  status: SharedProductActivation<"marketplace">["status"] | undefined,
): string {
  if (status === "suspended") {
    return "Marketplace access is currently suspended for this property. Contact support before continuing setup.";
  }
  if (status === "unavailable") {
    return "Marketplace activation is not available for this property. Contact support if this looks wrong.";
  }
  return "Marketplace activation is not ready for this property yet.";
}

function marketplaceActivationStepCopy(step: string): { title: string; description: string } {
  return (
    MARKETPLACE_ACTIVATION_STEPS[step] ?? {
      title: step,
      description: "Complete this Marketplace activation item.",
    }
  );
}

function validateProfileDraft(draft: ProfileDraft): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  const hasLocation = Boolean(
    draft.city.trim() || draft.countryCode.trim() || draft.rawMarketplaceLocation.trim(),
  );
  const hasDescription = Boolean(draft.shortDescription.trim() || draft.longDescription.trim());

  if (!draft.displayName.trim()) errors.displayName = ["Property name is required."];
  if (!hasLocation) {
    errors["location.countryCode"] = ["Enter a country code or city to continue."];
    errors["location.city"] = ["Enter a city or country code to continue."];
  }
  if (!draft.website.trim()) {
    errors.website = ["Website is required to complete setup."];
  } else if (!isHttpUrl(draft.website)) {
    errors.website = ["Enter a valid website URL."];
  }
  if (!draft.phone.trim()) errors.phone = ["Phone is required to complete setup."];
  if (!hasDescription) {
    errors.shortDescription = ["Add a short or long description to continue."];
    errors.longDescription = ["Add a long or short description to continue."];
  }
  if (!draft.mediaUrl.trim()) {
    errors["media.0.url"] = ["Photo URL is required to complete setup."];
  } else if (!isHttpUrl(draft.mediaUrl)) {
    errors["media.0.url"] = ["Enter a valid photo URL."];
  }

  return errors;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function TextField({
  label,
  value,
  onChange,
  error,
  helper,
  requirementLabel,
  placeholder,
  type = "text",
  readOnly = false,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  helper?: string;
  requirementLabel?: string;
  placeholder?: string;
  type?: string;
  readOnly?: boolean;
  required?: boolean;
}) {
  const generatedId = useId();
  const inputId = `setup-${generatedId}`;
  const helperId = helper ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div>
      <label
        htmlFor={inputId}
        className="flex items-center gap-2 text-sm font-medium text-gray-700"
      >
        <span>{label}</span>
        <span
          aria-hidden="true"
          className={required ? "text-xs font-medium text-red-600" : "text-xs text-gray-400"}
        >
          {requirementLabel ?? (required ? "Required" : "Optional")}
        </span>
      </label>
      {helper && (
        <p id={helperId} className="mt-1 text-xs text-gray-500">
          {helper}
        </p>
      )}
      <input
        id={inputId}
        type={type}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        aria-required={required}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-2 w-full rounded-lg border px-3 py-2 text-sm outline-none transition focus:border-gray-950 focus:ring-2 focus:ring-gray-950 ${
          error ? "border-red-300 bg-red-50" : "border-gray-200"
        } ${readOnly ? "bg-gray-50 text-gray-600" : ""}`}
      />
      {error && (
        <p id={errorId} className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function TextArea({
  label,
  value,
  onChange,
  error,
  helper,
  requirementLabel,
  placeholder,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  helper?: string;
  requirementLabel?: string;
  placeholder?: string;
  required?: boolean;
}) {
  const generatedId = useId();
  const inputId = `setup-${generatedId}`;
  const helperId = helper ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div>
      <label
        htmlFor={inputId}
        className="flex items-center gap-2 text-sm font-medium text-gray-700"
      >
        <span>{label}</span>
        <span
          aria-hidden="true"
          className={required ? "text-xs font-medium text-red-600" : "text-xs text-gray-400"}
        >
          {requirementLabel ?? (required ? "Required" : "Optional")}
        </span>
      </label>
      {helper && (
        <p id={helperId} className="mt-1 text-xs text-gray-500">
          {helper}
        </p>
      )}
      <textarea
        id={inputId}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        aria-required={required}
        rows={3}
        className={`mt-2 w-full rounded-lg border px-3 py-2 text-sm outline-none transition focus:border-gray-950 focus:ring-2 focus:ring-gray-950 ${
          error ? "border-red-300 bg-red-50" : "border-gray-200"
        }`}
      />
      {error && (
        <p id={errorId} className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function productStatusLabel(
  property: SharedSetupProperty | null,
  product: SharedHotelSetupProduct,
  checked: boolean,
): string {
  const status = property?.products[product].status ?? "not_selected";
  if (checked && status === "not_selected") return "Selected";
  if (!checked && (status === "active" || status === "selected_incomplete")) return "Not selected";
  if (status === "active") return "Active";
  if (status === "selected_incomplete") return "Setup needed";
  if (status === "suspended") return "Suspended";
  if (status === "unavailable") return "Unavailable";
  return "Not selected";
}

function draftFromProfile(profile: SharedPropertyProfile): ProfileDraft {
  const firstMedia = profile.media[0];
  return {
    displayName: profile.displayName,
    countryCode: profile.location.countryCode ?? "",
    region: profile.location.region ?? "",
    city: profile.location.city ?? "",
    rawMarketplaceLocation: profile.location.rawMarketplaceLocation ?? "",
    streetAddress: profile.location.streetAddress ?? "",
    postalCode: profile.location.postalCode ?? "",
    timezone: profile.location.timezone ?? "",
    website: profile.website ?? "",
    phone: profile.phone ?? "",
    shortDescription: profile.shortDescription ?? "",
    longDescription: profile.longDescription ?? "",
    mediaUrl: firstMedia?.url ?? "",
  };
}

function profileInputFromDraft(
  draft: ProfileDraft,
  existingProfile: SharedPropertyProfile | null,
): SharedPropertyProfileInput {
  const existingLocation = existingProfile?.location;
  return {
    displayName: draft.displayName.trim(),
    location: {
      countryCode: nullIfBlank(draft.countryCode.toUpperCase()),
      region: nullIfBlank(draft.region),
      city: nullIfBlank(draft.city),
      streetAddress: nullIfBlank(draft.streetAddress),
      postalCode: nullIfBlank(draft.postalCode),
      rawMarketplaceLocation: existingLocation?.rawMarketplaceLocation ?? null,
      timezone: nullIfBlank(draft.timezone),
      latitude: existingLocation?.latitude ?? null,
      longitude: existingLocation?.longitude ?? null,
      addressPublic: existingLocation?.addressPublic ?? true,
      mapDisplayMode: existingLocation?.mapDisplayMode ?? "hidden",
    },
    website: nullIfBlank(draft.website),
    phone: nullIfBlank(draft.phone),
    shortDescription: nullIfBlank(draft.shortDescription),
    longDescription: nullIfBlank(draft.longDescription),
    media: mediaFromDraft(draft, existingProfile),
  };
}

function mediaFromDraft(
  draft: ProfileDraft,
  existingProfile: SharedPropertyProfile | null,
): SharedPropertyProfileInput["media"] {
  const mediaUrl = nullIfBlank(draft.mediaUrl);
  const [firstMedia, ...remainingMedia] = existingProfile?.media ?? [];

  if (!mediaUrl) {
    return remainingMedia;
  }

  if (firstMedia) {
    return [{ ...firstMedia, url: mediaUrl }, ...remainingMedia];
  }

  return [
    {
      mediaType: "gallery_image",
      url: mediaUrl,
      altText: null,
      sortOrder: 0,
    },
  ];
}

function nullIfBlank(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Please try again.";
}

function fieldErrorsFromError(error: unknown): Record<string, string[]> {
  if (!error || typeof error !== "object") return {};
  const data = (error as { data?: { fields?: unknown } }).data;
  if (!data || !data.fields || typeof data.fields !== "object" || Array.isArray(data.fields)) {
    return {};
  }
  return data.fields as Record<string, string[]>;
}

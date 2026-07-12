"use client";

import {
  type ComponentType,
  type SVGProps,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowRightIcon,
  CheckIcon,
  ExclamationCircleIcon,
  GlobeAltIcon,
  PlusIcon,
  RocketLaunchIcon,
  SparklesIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";

import { HotelIcon } from "./HotelIcon";
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
type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

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
  initialSelectedProducts?: SharedHotelSetupProduct[];
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
  marketplaceOffer: {
    title: "Collaboration offer",
    description: "Create the offer creators can review and apply to.",
  },
  offerDeliverables: {
    title: "Requested content",
    description: "Describe the posts, photos, or videos you want from creators.",
  },
  compensationOptions: {
    title: "Compensation options",
    description: "Choose the collaboration terms you are open to considering.",
  },
  creatorRequirements: {
    title: "Creator requirements",
    description: "Set the platforms, audience, and creator profile you want to work with.",
  },
};

const SETUP_STEPS: ReadonlyArray<{
  label: string;
  description: string;
  icon: IconComponent;
}> = [
  { label: "Property", description: "Choose where setup applies", icon: HotelIcon },
  { label: "Basics", description: "Profile, location, and hero image", icon: SparklesIcon },
  { label: "Products", description: "Pick what this property uses", icon: Squares2X2Icon },
  { label: "Launch", description: "Open the right workspace", icon: RocketLaunchIcon },
];

const PRODUCT_DESCRIPTIONS: Record<SharedHotelSetupProduct, string> = {
  booking: "Direct booking pages, checkout, and guest-facing availability.",
  pms: "Rooms, calendar, reservations, and daily property operations.",
  marketplace: "Creator discovery and collaboration offer tools.",
};

const PRODUCT_UNLOCKS: Record<SharedHotelSetupProduct, string> = {
  booking: "Launch direct bookings",
  pms: "Run daily operations",
  marketplace: "Invite creator demand",
};

const EMPTY_SELECTED_PRODUCTS: SharedHotelSetupProduct[] = [];

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
  initialSelectedProducts = EMPTY_SELECTED_PRODUCTS,
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
  const seededInitialSelectionPropertyIds = useRef<Set<string>>(new Set());

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
    if (view.screen !== "product_selection" || !view.selectedPropertyId) return;
    if (seededInitialSelectionPropertyIds.current.has(view.selectedPropertyId)) return;

    const nextSelectedProducts = selectedProductsForProperty(view.selectedProperty, entryProduct);
    seededInitialSelectionPropertyIds.current.add(view.selectedPropertyId);
    for (const product of initialSelectedProducts) {
      if (
        !nextSelectedProducts.includes(product) &&
        isSharedHotelSetupProductSelectable(view.selectedProperty, product)
      ) {
        nextSelectedProducts.push(product);
      }
    }
    setSelectedProducts(nextSelectedProducts);
  }, [
    entryProduct,
    initialSelectedProducts,
    view.screen,
    view.selectedProperty,
    view.selectedPropertyId,
  ]);

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
            className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
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
          className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
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
    view.screen === "property_selection"
      ? 1
      : view.screen === "product_selection"
        ? 3
        : view.screen === "product_activation" || view.screen === "enter_product"
          ? 4
          : 2;
  const subtitle =
    view.screen === "property_selection"
      ? "Pick an existing property or add a new one to this hotel group."
      : "Add the basics once. Vayada reuses them across PMS, Booking Engine, and Marketplace.";

  if (embedded) {
    return (
      <section className="min-w-0 overflow-hidden rounded-3xl border border-gray-100 bg-white shadow-[0_24px_80px_-50px_rgba(15,23,42,0.55)]">
        <div className="border-b border-gray-100 px-5 py-6 sm:px-7">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary-600">
            {status?.hotelGroup.displayName ?? "Hotel setup"}
          </p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-gray-950">{title}</h2>
              <p className="mt-1 max-w-2xl text-sm text-gray-500">{subtitle}</p>
            </div>
            <span className="w-fit rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
              Step {progress} of {SETUP_STEPS.length}
            </span>
          </div>
          <SetupProgress progress={progress} compact />
        </div>
        {loading ? (
          <div className="flex min-h-80 items-center justify-center p-5 sm:p-6">
            <LoadingSpinner label="Loading setup" />
          </div>
        ) : (
          <div className="p-5 sm:p-7">{children}</div>
        )}
      </section>
    );
  }

  return (
    <main className="min-h-screen bg-white px-4 py-8 text-gray-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-7 grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">
              {status?.hotelGroup.displayName ?? "Hotel setup"}
            </p>
            <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-normal text-gray-950 sm:text-5xl">
              {title}
            </h1>
            <p className="mt-3 max-w-2xl text-base text-gray-500">{subtitle}</p>
          </div>
          {status?.entry.entryProduct && (
            <div className="rounded-3xl border border-gray-100 bg-gray-50 p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                Started from
              </p>
              <p className="mt-1 text-sm font-semibold text-gray-950">
                {DEFAULT_PRODUCT_LABELS[status.entry.entryProduct]}
              </p>
              <p className="mt-2 text-xs text-gray-500">
                Complete setup here, then continue into the selected workspace.
              </p>
            </div>
          )}
        </header>

        <SetupProgress progress={progress} />

        <section className="mt-7 min-w-0 overflow-hidden rounded-3xl border border-gray-100 bg-white shadow-[0_24px_80px_-50px_rgba(15,23,42,0.55)]">
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

function SetupProgress({ progress, compact = false }: { progress: number; compact?: boolean }) {
  return (
    <ol
      className={`grid gap-2 ${compact ? "mt-5 sm:grid-cols-4" : "sm:grid-cols-4"}`}
      aria-label="Property setup progress"
    >
      {SETUP_STEPS.map((step, index) => {
        const stepNumber = index + 1;
        const complete = stepNumber < progress;
        const current = stepNumber === progress;
        const Icon = step.icon;
        return (
          <li
            key={step.label}
            aria-current={current ? "step" : undefined}
            className={`rounded-2xl border px-3 py-3 ${
              current
                ? "border-primary-200 bg-primary-50/70"
                : complete
                  ? "border-primary-100 bg-white"
                  : "border-gray-100 bg-white"
            }`}
          >
            <div className="flex items-start gap-3">
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  complete
                    ? "bg-primary-600 text-white"
                    : current
                      ? "bg-primary-600 text-white"
                      : "bg-gray-100 text-gray-500"
                }`}
              >
                {complete ? (
                  <CheckIcon className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Icon className="h-4 w-4" aria-hidden="true" />
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-gray-950">{step.label}</span>
                <span className="mt-1 block text-xs text-gray-500">{step.description}</span>
              </span>
            </div>
          </li>
        );
      })}
    </ol>
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
          className="inline-flex items-center justify-center gap-2 rounded-full bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-700"
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
            className="rounded-3xl border border-gray-100 p-4 text-left transition hover:border-primary-200 hover:bg-primary-50/40 focus:outline-none focus:ring-2 focus:ring-primary-100"
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
    <div className="rounded-3xl border border-red-200 bg-red-50 p-5" role="alert">
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
        className="mt-4 rounded-full bg-red-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-red-800"
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
  const hasAdvancedLocationErrors = Boolean(
    fieldErrors["location.region"]?.[0] ||
    fieldErrors["location.timezone"]?.[0] ||
    fieldErrors["location.streetAddress"]?.[0] ||
    fieldErrors["location.postalCode"]?.[0],
  );
  const hasAdvancedDescriptionErrors = Boolean(fieldErrors.longDescription?.[0]);

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
            Start with the details guests, staff, and creators will recognize.
          </p>
        </div>
        {selectedProperty && (
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
            {selectedProperty.sharedProfile.completionPercent}% complete
          </span>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
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
          helper="Used by guest and creator-facing products."
          required
          error={fieldErrors.website?.[0]}
          onChange={(value) => setField("website", value)}
        />
        <TextField
          label="Phone"
          value={draft.phone}
          placeholder="+49 89 123456"
          helper="Shown where products need a contact number."
          required
          error={fieldErrors.phone?.[0]}
          onChange={(value) => setField("phone", value)}
        />
        <TextField
          label="City"
          value={draft.city}
          placeholder="Munich"
          helper="City or country code is enough to continue."
          requirementLabel="One required"
          error={fieldErrors["location.city"]?.[0]}
          onChange={(value) => setField("city", value)}
        />
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
          label="Hero photo URL"
          type="url"
          value={draft.mediaUrl}
          placeholder="https://images.example/alpenrose.jpg"
          helper="First image used for shared product setup."
          required
          error={fieldErrors["media.0.url"]?.[0] ?? fieldErrors.media?.[0]}
          onChange={(value) => setField("mediaUrl", value)}
        />
        <div className="md:col-span-2">
          <TextArea
            label="Short intro"
            value={draft.shortDescription}
            placeholder="A city hotel close to the old town."
            helper="One guest-facing description is required."
            requirementLabel="Required"
            required
            error={fieldErrors.shortDescription?.[0]}
            onChange={(value) => setField("shortDescription", value)}
          />
        </div>
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
      </div>

      <details
        className="rounded-3xl border border-gray-100 bg-gray-50/80"
        open={hasAdvancedLocationErrors || undefined}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-medium text-gray-950">
          <span>Exact address and operations</span>
          <span className="text-xs font-medium text-gray-500">Optional</span>
        </summary>
        <div className="grid gap-4 border-t border-gray-100 bg-white p-5 md:grid-cols-2">
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
      </details>

      <details
        className="rounded-3xl border border-gray-100 bg-gray-50/80"
        open={hasAdvancedDescriptionErrors || undefined}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-medium text-gray-950">
          <span>Long description</span>
          <span className="text-xs font-medium text-gray-500">Optional</span>
        </summary>
        <div className="border-t border-gray-100 bg-white p-5">
          <TextArea
            label="Long description"
            value={draft.longDescription}
            placeholder="Add guest-facing details, amenities, and useful context."
            helper="Use this when the short intro needs more context."
            error={fieldErrors.longDescription?.[0]}
            rows={5}
            onChange={(value) => setField("longDescription", value)}
          />
        </div>
      </details>

      <div className="flex flex-col-reverse gap-3 border-t border-gray-100 pt-5 sm:flex-row sm:justify-end">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-gray-200 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Back to properties
          </button>
        )}
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
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
        <h2 className="text-lg font-semibold text-gray-950">Choose your products</h2>
        <p className="mt-1 max-w-2xl text-sm text-gray-500">
          Start with the surfaces this property needs now. You can add more after launch.
        </p>
        {selectedProperty?.displayName && (
          <p className="mt-2 text-sm font-medium text-gray-700">{selectedProperty.displayName}</p>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {SHARED_HOTEL_SETUP_PRODUCTS.map((product) => {
          const checked = selectedProducts.includes(product);
          const disabled = !isSharedHotelSetupProductSelectable(selectedProperty, product);
          const Icon = productIcon(product);
          return (
            <label
              key={product}
              className={`flex min-h-48 flex-col rounded-3xl border p-5 transition ${
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
              } ${
                checked
                  ? "border-primary-500 bg-primary-50/70 shadow-[0_18px_50px_-38px_rgba(29,78,216,0.9)]"
                  : disabled
                    ? "border-gray-100"
                    : "border-gray-100 hover:border-primary-200 hover:bg-primary-50/30"
              }`}
            >
              <span className="flex items-start justify-between gap-3">
                <span
                  className={`flex h-10 w-10 items-center justify-center rounded-full ${
                    checked ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-600"
                  }`}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300 text-primary-600 focus:ring-primary-600"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    if (!disabled) onToggle(product);
                  }}
                />
              </span>
              <span className="mt-4 min-w-0">
                <span className="block text-sm font-semibold text-gray-950">{labels[product]}</span>
                <span className="mt-2 block text-sm text-gray-500">
                  {PRODUCT_DESCRIPTIONS[product]}
                </span>
              </span>
              <span className="mt-auto pt-4">
                <span className="block text-xs font-medium uppercase tracking-wide text-gray-400">
                  Unlocks
                </span>
                <span className="mt-1 block text-sm font-medium text-gray-700">
                  {PRODUCT_UNLOCKS[product]}
                </span>
                <span
                  className={`mt-3 inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${
                    checked
                      ? "bg-white text-primary-700 ring-primary-200"
                      : "bg-white text-gray-600 ring-gray-200"
                  }`}
                >
                  {productStatusLabel(selectedProperty, product, checked)}
                </span>
              </span>
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
          className="inline-flex items-center justify-center gap-2 rounded-full bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
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

function productIcon(product: SharedHotelSetupProduct): IconComponent {
  if (product === "booking") return GlobeAltIcon;
  if (product === "pms") return HotelIcon;
  return SparklesIcon;
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
  const launchTitle = isBlockedMarketplaceActivation
    ? "Launch blocked"
    : view.screen === "enter_product"
      ? "Ready to open"
      : "Product setup needed";
  const launchDescription = isBlockedMarketplaceActivation
    ? marketplaceBlockedActivationCopy(activation?.status)
    : isMarketplaceActivation
      ? "Finish the Marketplace-specific profile tools next."
      : view.screen === "enter_product"
        ? "Open the selected workspace for this property."
        : "Continue into the selected product setup.";

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-950">
          {isBlockedMarketplaceActivation
            ? "Marketplace activation unavailable"
            : isMarketplaceActivation
              ? "Activate Creator Marketplace"
              : product
                ? `Launch ${labels[product]}`
                : "Launch product"}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-gray-500">
          Profile and product selection are saved for{" "}
          {view.selectedProperty?.displayName ?? "this property"}.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <ReadinessItem
          icon={HotelIcon}
          complete
          title="Basics saved"
          description="Name, location, contact, image, and description are ready."
        />
        <ReadinessItem
          icon={Squares2X2Icon}
          complete
          title="Products selected"
          description={
            product ? `${labels[product]} is the next workspace.` : "A product is selected."
          }
        />
        <ReadinessItem
          icon={RocketLaunchIcon}
          complete={!isBlockedMarketplaceActivation && Boolean(product)}
          title={launchTitle}
          description={launchDescription}
        />
      </div>

      <div
        className={`mt-5 rounded-3xl border p-5 ${
          isBlockedMarketplaceActivation ? "border-red-200 bg-red-50" : "border-gray-100 bg-gray-50"
        }`}
      >
        {(isBlockedMarketplaceActivation ||
          !isMarketplaceActivation ||
          missingSteps.length === 0) && (
          <p className="text-sm text-gray-700">{launchDescription}</p>
        )}
        {isMarketplaceActivation && missingSteps.length > 0 && (
          <div className={isBlockedMarketplaceActivation ? "mt-4 grid gap-3" : "grid gap-3"}>
            {missingSteps.map((step) => {
              const item = marketplaceActivationStepCopy(step);
              return (
                <div key={step} className="rounded-2xl border border-gray-100 bg-white p-4">
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
          className="inline-flex items-center justify-center gap-2 rounded-full bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span>
            {isBlockedMarketplaceActivation
              ? "Marketplace unavailable"
              : isMarketplaceActivation
                ? "Open Marketplace offer tools"
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

function ReadinessItem({
  icon: Icon,
  complete,
  title,
  description,
}: {
  icon: IconComponent;
  complete: boolean;
  title: string;
  description: string;
}) {
  return (
    <div
      className={`rounded-3xl border p-5 ${
        complete ? "border-gray-100 bg-white" : "border-red-200 bg-red-50"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            complete ? "bg-primary-600 text-white" : "bg-red-100 text-red-700"
          }`}
        >
          {complete ? (
            <CheckIcon className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Icon className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-gray-950">{title}</span>
          <span className="mt-1 block text-xs text-gray-500">{description}</span>
        </span>
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
          className={required ? "text-xs font-medium text-gray-500" : "text-xs text-gray-400"}
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
        className={`mt-2 w-full rounded-2xl border px-4 py-3 text-sm outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100 ${
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
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  helper?: string;
  requirementLabel?: string;
  placeholder?: string;
  required?: boolean;
  rows?: number;
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
          className={required ? "text-xs font-medium text-gray-500" : "text-xs text-gray-400"}
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
        rows={rows}
        className={`mt-2 w-full rounded-2xl border px-4 py-3 text-sm outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100 ${
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

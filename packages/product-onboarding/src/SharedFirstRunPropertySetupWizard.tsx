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
  BuildingOffice2Icon,
  BuildingOfficeIcon,
  BuildingStorefrontIcon,
  CakeIcon,
  CheckIcon,
  EllipsisHorizontalIcon,
  ExclamationCircleIcon,
  GlobeAltIcon,
  HomeModernIcon,
  KeyIcon,
  MapPinIcon,
  PlusIcon,
  RocketLaunchIcon,
  SparklesIcon,
  Squares2X2Icon,
  SunIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { COUNTRY_OPTIONS, TIMEZONE_OPTIONS } from "@vayada/locale-constants";

import { HotelIcon } from "./HotelIcon";
import {
  SHARED_HOTEL_SETUP_PRODUCTS,
  canOpenMarketplaceProfileTools,
  isSharedHotelSetupProductSelectable,
  resolveSharedFirstRunSetupView,
  type SharedFirstRunSetupViewModel,
  type SharedHotelSetupEntryProduct,
  type SharedHotelSetupProduct,
  type SharedHotelSetupStatus,
  type SharedProductActivation,
  type SharedPropertyProfile,
  type SharedPropertyProfileInput,
  type SharedSetupProperty,
} from "./sharedFirstRunSetupFlow";
import type { SharedHotelSetupApi, SharedPropertyTypeOption } from "./sharedHotelSetupApi";

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
  initialPropertyId?: string | null;
  returnTo?: string | null;
  initialAddProperty?: boolean;
  embedded?: boolean;
  autoContinueToProduct?: boolean;
  productLabels?: Partial<ProductLabels>;
  accountContactEmail?: string | null;
  accountContactPhone?: string | null;
  onProductContinue: (input: SharedFirstRunProductContinueInput) => void;
};

type ProfileDraft = {
  displayName: string;
  propertyType: string;
  countryCode: string;
  region: string;
  city: string;
  rawMarketplaceLocation: string;
  streetAddress: string;
  postalCode: string;
  timezone: string;
  website: string;
  contactEmail: string;
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

const PROFILE_STEP_FIELDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["displayName", "propertyType"],
  [
    "location.streetAddress",
    "location.postalCode",
    "location.city",
    "location.countryCode",
    "location.timezone",
  ],
  ["contactEmail", "phone", "website"],
];
const PROFILE_STEP_TITLES = ["About your hotel", "Location", "Hotel contact"] as const;

const PROPERTY_TYPE_ICONS = new Map<string, IconComponent>([
  ["hotel", HotelIcon],
  ["resort", SunIcon],
  ["hostel", UsersIcon],
  ["apartment", BuildingOffice2Icon],
  ["aparthotel", BuildingOfficeIcon],
  ["guesthouse", BuildingStorefrontIcon],
  ["bed_and_breakfast", CakeIcon],
  ["villa", HomeModernIcon],
  ["vacation_rental", KeyIcon],
  ["motel", MapPinIcon],
  ["other", EllipsisHorizontalIcon],
]);

const TIMEZONE_DATALIST_OPTIONS = TIMEZONE_OPTIONS.map((timezone) =>
  timezone === "UTC" ? "Etc/UTC" : timezone,
);

export default function SharedFirstRunPropertySetupWizard({
  api,
  entryProduct,
  initialSelectedProducts = EMPTY_SELECTED_PRODUCTS,
  initialPropertyId = null,
  returnTo = null,
  initialAddProperty = false,
  embedded = false,
  autoContinueToProduct = false,
  productLabels,
  accountContactEmail = null,
  accountContactPhone = null,
  onProductContinue,
}: SharedFirstRunPropertySetupWizardProps) {
  const labels = { ...DEFAULT_PRODUCT_LABELS, ...productLabels };
  const [status, setStatus] = useState<SharedHotelSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [forceCreateProperty, setForceCreateProperty] = useState(initialAddProperty);
  const [profileLoadFailed, setProfileLoadFailed] = useState(false);
  const [profileReloadToken, setProfileReloadToken] = useState(0);
  const [loadedProfile, setLoadedProfile] = useState<SharedPropertyProfile | null>(null);
  const [propertyTypeOptions, setPropertyTypeOptions] = useState<SharedPropertyTypeOption[] | null>(
    null,
  );
  const [draft, setDraft] = useState<ProfileDraft>(() =>
    newPropertyDraft(accountContactEmail, accountContactPhone),
  );
  const [selectedProducts, setSelectedProducts] = useState<SharedHotelSetupProduct[]>(() =>
    uniqueSelectedProducts([entryProduct, ...initialSelectedProducts]),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const seededInitialSelectionPropertyIds = useRef<Set<string>>(new Set());
  const automaticContinueKey = useRef<string | null>(null);

  const view = useMemo(
    () => resolveSharedFirstRunSetupView(status, { forceCreateProperty }),
    [forceCreateProperty, status],
  );
  const productContinueInput = useMemo(
    () => buildProductContinueInput(view, status?.entry.returnTo ?? returnTo),
    [returnTo, status?.entry.returnTo, view],
  );
  const productContinueBlocked = isProductContinueBlocked(view);

  useEffect(() => {
    setForceCreateProperty(initialAddProperty);
  }, [initialAddProperty]);

  useEffect(() => {
    setSelectedProducts(uniqueSelectedProducts([entryProduct, ...initialSelectedProducts]));
    seededInitialSelectionPropertyIds.current.clear();
  }, [entryProduct, initialSelectedProducts]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    api
      .getStatus({ entryProduct, returnTo, propertyId: initialPropertyId })
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
  }, [api, entryProduct, initialPropertyId, returnTo]);

  useEffect(() => {
    if (view.screen !== "property_profile") return;

    const propertyId = view.profileMode === "update" ? view.selectedPropertyId : null;
    let cancelled = false;
    setProfileLoadFailed(false);
    setPropertyTypeOptions(null);
    setError("");

    Promise.all([
      api.getPropertyTypes(),
      propertyId
        ? api.getPropertyProfile(propertyId)
        : Promise.resolve<SharedPropertyProfile | null>(null),
    ])
      .then(([catalog, nextProfile]) => {
        if (cancelled) return;
        setPropertyTypeOptions(propertyTypeOptionsFromCatalog(catalog.propertyTypes));
        setLoadedProfile(nextProfile);
        setDraft(
          nextProfile
            ? draftFromProfile(nextProfile)
            : newPropertyDraft(accountContactEmail, accountContactPhone, browserTimezone()),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadedProfile(null);
        setProfileLoadFailed(true);
        setError(errorMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [
    accountContactEmail,
    accountContactPhone,
    api,
    profileReloadToken,
    view.profileMode,
    view.screen,
    view.selectedPropertyId,
  ]);

  useEffect(() => {
    if (!status || view.screen !== "product_selection" || !view.selectedPropertyId) return;
    if (seededInitialSelectionPropertyIds.current.has(view.selectedPropertyId)) return;

    const nextSelectedProducts = [...status.hotelGroup.selectedProducts];
    seededInitialSelectionPropertyIds.current.add(view.selectedPropertyId);
    for (const product of [entryProduct, ...initialSelectedProducts]) {
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
    status?.hotelGroup.selectedProducts,
    view.screen,
    view.selectedProperty,
    view.selectedPropertyId,
  ]);

  useEffect(() => {
    if (!autoContinueToProduct || !productContinueInput || productContinueBlocked) return;
    const key = `${productContinueInput.action}:${productContinueInput.product}:${productContinueInput.propertyId}`;
    if (automaticContinueKey.current === key) return;
    automaticContinueKey.current = key;
    onProductContinue(productContinueInput);
  }, [autoContinueToProduct, onProductContinue, productContinueBlocked, productContinueInput]);

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
    const nextFieldErrors = validateProfileDraft(draft, view.profileMode ?? "create");
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
      await api.saveAccountProductSelection(selectedProducts);
      await reloadStatus(view.selectedPropertyId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleContinueProduct = () => {
    if (productContinueInput) onProductContinue(productContinueInput);
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
    <WizardShell title={view.title} view={view} embedded={embedded}>
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
            setDraft(newPropertyDraft(accountContactEmail, accountContactPhone, browserTimezone()));
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
          hasAccountSuggestions={Boolean(accountContactEmail || accountContactPhone)}
          loading={!propertyTypeOptions}
          saving={saving}
          fieldErrors={fieldErrors}
          propertyTypeOptions={propertyTypeOptions ?? []}
          onChange={setDraft}
          onFieldErrors={setFieldErrors}
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
        <>
          {autoContinueToProduct && productContinueInput && !productContinueBlocked ? (
            <ProductRedirecting labels={labels} product={productContinueInput.product} />
          ) : (
            <ProductContinue labels={labels} view={view} onContinue={handleContinueProduct} />
          )}
        </>
      )}
    </WizardShell>
  );
}

function WizardShell({
  children,
  title,
  view,
  loading = false,
  embedded = false,
}: {
  children?: React.ReactNode;
  title: string;
  view: SharedFirstRunSetupViewModel;
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
      : view.screen === "property_profile"
        ? null
        : "We’ll ask for the basics once and keep them consistent across PMS, Booking Engine, and Marketplace.";
  const isProfileScreen = view.screen === "property_profile";

  if (embedded) {
    return (
      <section className="min-w-0">
        <div className="mb-4 px-1 sm:px-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-950">{title}</h2>
              {subtitle && <p className="mt-1 max-w-2xl text-sm text-gray-500">{subtitle}</p>}
            </div>
            <span className="w-fit rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
              Step {progress} of 4
            </span>
          </div>
        </div>
        {loading ? (
          <div className="overflow-hidden rounded-3xl border border-gray-100 bg-white shadow-[0_24px_80px_-50px_rgba(15,23,42,0.55)]">
            <div className="flex min-h-80 items-center justify-center p-5 sm:p-6">
              <LoadingSpinner label="Loading setup" />
            </div>
          </div>
        ) : (
          <div className="min-w-0">{children}</div>
        )}
      </section>
    );
  }

  return (
    <main
      className={`flex min-h-screen items-center px-4 py-6 text-gray-900 sm:px-6 lg:px-8 ${
        isProfileScreen ? "bg-gray-50" : "bg-white"
      }`}
    >
      <div className={`mx-auto w-full ${isProfileScreen ? "max-w-7xl" : "max-w-5xl"}`}>
        <header
          className={`mx-auto text-center ${isProfileScreen ? "mb-4 max-w-2xl" : "mb-5 max-w-xl"}`}
        >
          <h1 className="text-3xl font-semibold tracking-tight text-gray-950">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-gray-500">{subtitle}</p>}
        </header>

        {loading ? (
          <div className="flex min-h-80 items-center justify-center">
            <LoadingSpinner label="Loading setup" />
          </div>
        ) : (
          children
        )}
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
          <h2 className="text-lg font-semibold text-red-900">Property setup unavailable</h2>
          <p className="mt-2 text-sm text-red-700">
            {error || "The property setup details could not be loaded."}
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

const ONBOARDING_ILLUSTRATION_CLASS = "mx-auto h-auto w-full max-w-[32rem] text-gray-900";

function HotelFacadeIllustration() {
  return (
    <svg
      viewBox="0 0 260 220"
      className={ONBOARDING_ILLUSTRATION_CLASS}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M29 190h202" />
      <path d="M76 81v109h109V81" />
      <rect x="68" y="65" width="125" height="20" rx="3" fill="white" />
      <path d="M130 65V31" />
      <path d="m130 33 30 5v20l-30-5" fill="#2948E8" />
      <path d="M111 190v-48a19 19 0 0 1 38 0v48" fill="#2948E8" />
      <circle cx="141" cy="166" r="2" fill="currentColor" stroke="none" />
      <path d="M91 118V99a11 11 0 0 1 22 0v19Z" fill="#EEF1FF" />
      <path d="M148 118V99a11 11 0 0 1 22 0v19Z" fill="#EEF1FF" />
      <path d="M199 190h28l-4-30h-20Z" fill="white" />
      <path d="M213 160v-31M213 148l-13-14M213 143l13-16" />
      <path
        d="M200 134c9 0 13 5 13 14-9 0-13-5-13-14ZM226 127c0 9-4 14-13 16 0-9 4-14 13-16Z"
        fill="#2948E8"
      />
    </svg>
  );
}

function LocationIllustration() {
  return (
    <svg
      viewBox="0 0 260 220"
      className={ONBOARDING_ILLUSTRATION_CLASS}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m37 64 56-19 57 20 73-20v119l-73 20-57-20-56 19Z" fill="white" />
      <path d="M93 45v119M150 65v119M37 125c20-1 35-24 56-25 17-1 34 20 57 19 25-1 48-23 73-23" />
      <path
        d="M61 153c29-3 48 0 65-17 15-15 20-30 49-31"
        stroke="#2948E8"
        strokeDasharray="8 10"
        strokeWidth="5"
      />
      <path
        d="M190 70c-20 0-34 15-34 34 0 25 34 57 34 57s34-32 34-57c0-19-14-34-34-34Z"
        fill="#2948E8"
      />
      <circle cx="190" cy="104" r="11" fill="white" />
    </svg>
  );
}

function ContactIllustration() {
  return (
    <svg
      viewBox="0 0 260 220"
      className={ONBOARDING_ILLUSTRATION_CLASS}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="31" y="92" width="108" height="77" rx="4" fill="white" />
      <path d="m34 96 51 42 51-42M34 165l37-40M136 165l-37-40" />
      <path
        d="M169 84c7-7 18-5 23 2l10 16c4 6 2 14-4 18l-12 8c8 15 20 26 35 34l8-12c4-6 12-8 18-4l16 10c7 5 9 16 2 23l-8 8c-8 8-21 11-32 6-43-18-77-52-95-95-5-11-2-24 6-32Z"
        fill="#2948E8"
        transform="translate(-5 -2) scale(.78) translate(52 29)"
      />
      <path
        d="M204 53c0 14-7 22-20 24 13 2 20 10 20 24 0-14 7-22 20-24-13-2-20-10-20-24Z"
        stroke="#2948E8"
      />
    </svg>
  );
}

function ProfileIllustrationPanel({
  children,
  title,
  description,
}: {
  children: React.ReactNode;
  title?: string;
  description?: string;
}) {
  return (
    <aside className="hidden min-h-[32rem] items-center justify-center p-8 xl:flex">
      <div className="w-full max-w-lg text-center">
        {children}
        {title && <h2 className="mt-5 text-xl font-semibold text-gray-950">{title}</h2>}
        {description && (
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-gray-600">{description}</p>
        )}
      </div>
    </aside>
  );
}

function ProfileForm({
  draft,
  mode,
  hasAccountSuggestions,
  loading,
  saving,
  fieldErrors,
  propertyTypeOptions,
  onChange,
  onFieldErrors,
  onCancel,
  onSave,
}: {
  draft: ProfileDraft;
  mode: "create" | "update";
  hasAccountSuggestions: boolean;
  loading: boolean;
  saving: boolean;
  fieldErrors: Record<string, string[]>;
  propertyTypeOptions: SharedPropertyTypeOption[];
  onChange: (draft: ProfileDraft) => void;
  onFieldErrors: (errors: Record<string, string[]>) => void;
  onCancel?: () => void;
  onSave: () => void;
}) {
  const [step, setStep] = useState(0);
  const stepHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const errorStep = PROFILE_STEP_FIELDS.findIndex((fields) =>
      fields.some((field) => fieldErrors[field]),
    );
    if (errorStep >= 0 && errorStep !== step) {
      setStep(errorStep);
      requestAnimationFrame(() => stepHeading.current?.focus());
    }
  }, [fieldErrors, step]);

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
  const changeStep = (nextStep: number) => {
    onFieldErrors({});
    setStep(nextStep);
    requestAnimationFrame(() => stepHeading.current?.focus());
  };
  const continueToNextStep = () => {
    const currentFields = new Set(PROFILE_STEP_FIELDS[step]);
    const currentErrors = Object.fromEntries(
      Object.entries(validateProfileDraft(draft, mode)).filter(([field]) =>
        currentFields.has(field),
      ),
    );
    onFieldErrors(currentErrors);
    if (Object.keys(currentErrors).length === 0) changeStep(step + 1);
  };
  const showRawLocation = Boolean(
    draft.rawMarketplaceLocation && !draft.city.trim() && !draft.countryCode.trim(),
  );
  const visiblePropertyTypeOptions =
    draft.propertyType && !propertyTypeOptions.some(({ value }) => value === draft.propertyType)
      ? [
          { value: draft.propertyType, label: `${draft.propertyType} (existing)` },
          ...propertyTypeOptions,
        ]
      : propertyTypeOptions;
  const actions = (
    <div className="flex w-full flex-col-reverse items-center gap-3 sm:flex-row sm:justify-center">
      {(step > 0 || onCancel) && (
        <button
          type="button"
          disabled={saving}
          onClick={() => (step > 0 ? changeStep(step - 1) : onCancel?.())}
          className="w-full rounded-full border border-gray-200 bg-white px-5 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          {step > 0 ? "Back" : "Back to properties"}
        </button>
      )}
      <button
        type="submit"
        disabled={step === PROFILE_STEP_FIELDS.length - 1 && saving}
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {step === PROFILE_STEP_FIELDS.length - 1 && saving && (
          <span
            className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
            aria-hidden="true"
          />
        )}
        <span>
          {step === PROFILE_STEP_FIELDS.length - 1
            ? saving
              ? "Saving..."
              : "Save and continue"
            : "Continue"}
        </span>
        {!(step === PROFILE_STEP_FIELDS.length - 1 && saving) && (
          <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );

  return (
    <form
      noValidate
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault();
        if (step === PROFILE_STEP_FIELDS.length - 1) onSave();
        else continueToNextStep();
      }}
      className="mx-auto max-w-7xl space-y-8"
    >
      <div className="flex flex-col items-center gap-2">
        <p className="text-sm font-semibold text-gray-600" aria-live="polite">
          Step {step + 1} of {PROFILE_STEP_FIELDS.length} · {PROFILE_STEP_TITLES[step]}
        </p>
        <ol
          className="grid w-full max-w-[12rem] grid-cols-3 gap-2"
          aria-label="Hotel setup progress"
        >
          {PROFILE_STEP_TITLES.map((title, index) => {
            const isCurrent = index === step;
            const isComplete = index < step;

            return (
              <li
                key={title}
                aria-current={isCurrent ? "step" : undefined}
                title={title}
                className={`h-1.5 rounded-full transition-colors duration-300 ${
                  isCurrent || isComplete ? "bg-primary-600" : "bg-primary-100"
                }`}
              >
                <span className="sr-only">{title}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <section
        inert={saving ? true : undefined}
        className={`${step === 0 ? "grid" : "hidden"} gap-6 xl:grid-cols-2`}
      >
        <div className="flex flex-col rounded-[2rem] bg-white p-5 text-left shadow-[0_30px_90px_-50px_rgba(15,23,42,0.45)] sm:p-6 xl:min-h-[32rem] xl:p-8">
          <div className="mb-4">
            <h3
              ref={step === 0 ? stepHeading : undefined}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight text-gray-950 outline-none"
            >
              {mode === "create"
                ? "What should we call your hotel?"
                : "Are these hotel details correct?"}
            </h3>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              We’ll use this name and property type wherever your hotel appears.
            </p>
          </div>
          <div className="space-y-4">
            <TextField
              label="Hotel name"
              value={draft.displayName}
              placeholder="Hotel Alpenrose"
              required
              error={fieldErrors.displayName?.[0]}
              onChange={(value) => setField("displayName", value)}
            />
            <PropertyTypeField
              value={draft.propertyType}
              required={mode === "create"}
              error={fieldErrors.propertyType?.[0]}
              options={visiblePropertyTypeOptions}
              onChange={(value) => setField("propertyType", value)}
            />
          </div>
        </div>
        <ProfileIllustrationPanel>
          <HotelFacadeIllustration />
        </ProfileIllustrationPanel>
      </section>

      <section
        inert={saving ? true : undefined}
        className={`${step === 2 ? "grid" : "hidden"} gap-6 xl:grid-cols-2`}
      >
        <div className="flex flex-col rounded-[2rem] bg-white p-5 text-left shadow-[0_30px_90px_-50px_rgba(15,23,42,0.45)] sm:p-6 xl:min-h-[32rem] xl:p-8">
          <div className="mb-4">
            <h3
              ref={step === 2 ? stepHeading : undefined}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight text-gray-950 outline-none"
            >
              How can guests reach you?
            </h3>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              We’ll show these details wherever guests may need to get in touch.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {mode === "create" && hasAccountSuggestions && (
              <p className="rounded-xl bg-primary-50 px-3 py-2 text-xs text-primary-800 md:col-span-2">
                We suggested details from your account. Edit them if this hotel uses a different
                contact; saving confirms these as the hotel contact.
              </p>
            )}
            <TextField
              label="Contact email"
              value={draft.contactEmail}
              placeholder="hello@hotel-alpenrose.com"
              type="email"
              required={mode === "create"}
              error={fieldErrors.contactEmail?.[0]}
              onChange={(value) => setField("contactEmail", value)}
            />
            <TextField
              label="Phone number"
              value={draft.phone}
              placeholder="+49 89 123456"
              type="tel"
              required={mode === "create"}
              error={fieldErrors.phone?.[0]}
              onChange={(value) => setField("phone", value)}
            />
            <div className="md:col-span-2">
              <TextField
                label="Website"
                value={draft.website}
                placeholder="https://hotel-alpenrose.com"
                type="url"
                error={fieldErrors.website?.[0]}
                onChange={(value) => setField("website", value)}
              />
            </div>
          </div>
        </div>
        <ProfileIllustrationPanel
          title="Keep guests connected"
          description="Use the right contact details wherever guests need to reach your team."
        >
          <ContactIllustration />
        </ProfileIllustrationPanel>
      </section>

      <section
        inert={saving ? true : undefined}
        className={`${step === 1 ? "grid" : "hidden"} gap-6 xl:grid-cols-2`}
      >
        <div className="flex flex-col rounded-[2rem] bg-white p-5 text-left shadow-[0_30px_90px_-50px_rgba(15,23,42,0.45)] sm:p-6 xl:min-h-[32rem] xl:p-8">
          <div className="mb-4">
            <h3
              ref={step === 1 ? stepHeading : undefined}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight text-gray-950 outline-none"
            >
              Where can guests find you?
            </h3>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              We’ll use this location for bookings and daily hotel operations.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <TextField
                label="Street address"
                value={draft.streetAddress}
                placeholder="Marienplatz 1"
                required={mode === "create"}
                error={fieldErrors["location.streetAddress"]?.[0]}
                onChange={(value) => setField("streetAddress", value)}
              />
            </div>
            <TextField
              label="Postal code"
              value={draft.postalCode}
              placeholder="80331"
              required={mode === "create"}
              error={fieldErrors["location.postalCode"]?.[0]}
              onChange={(value) => setField("postalCode", value)}
            />
            <TextField
              label="City"
              value={draft.city}
              placeholder="Munich"
              required
              error={fieldErrors["location.city"]?.[0]}
              onChange={(value) => setField("city", value)}
            />
            <SelectField
              label="Country"
              value={draft.countryCode}
              placeholder="Select a country"
              required
              error={fieldErrors["location.countryCode"]?.[0]}
              options={COUNTRY_OPTIONS.map((country) => ({
                value: country.code,
                label: `${country.flag} ${country.name}`,
              }))}
              onChange={(value) => setField("countryCode", value)}
            />
            <TextField
              label="Time zone"
              value={draft.timezone}
              placeholder="Europe/Berlin"
              helper="Detected automatically. Change it if needed."
              required={mode === "create"}
              error={fieldErrors["location.timezone"]?.[0]}
              listOptions={TIMEZONE_DATALIST_OPTIONS}
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
          </div>
        </div>
        <ProfileIllustrationPanel
          title="Put your hotel on the map"
          description="Accurate location details keep bookings and daily operations running smoothly."
        >
          <LocationIllustration />
        </ProfileIllustrationPanel>
      </section>

      {actions}

      <span className="sr-only" role="status" aria-live="polite">
        {saving ? "Saving hotel details." : ""}
      </span>
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
        <h2 className="text-lg font-semibold text-gray-950">Choose account systems</h2>
        <p className="mt-1 max-w-2xl text-sm text-gray-500">
          These systems apply to every property and listing in this hotel group.
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
              className={`flex min-h-44 flex-col rounded-2xl border p-4 transition ${
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
          {selectedProducts.length} system{selectedProducts.length === 1 ? "" : "s"} selected
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
          <span>{saving ? "Saving..." : "Save systems"}</span>
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
  const isBlockedMarketplaceActivation = isMarketplaceActivation && isProductContinueBlocked(view);
  const isBlockedActivation = isProductContinueBlocked(view);
  const launchTitle = isBlockedActivation
    ? "Launch blocked"
    : view.screen === "enter_product"
      ? "Ready to open"
      : "Product setup needed";
  const launchDescription = isBlockedActivation
    ? blockedActivationCopy(product, activation?.status)
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
          description="Hotel name and location are saved."
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
          complete={!isBlockedActivation && Boolean(product)}
          title={launchTitle}
          description={launchDescription}
        />
      </div>

      <div
        className={`mt-5 rounded-3xl border p-5 ${
          isBlockedActivation ? "border-red-200 bg-red-50" : "border-gray-100 bg-gray-50"
        }`}
      >
        {(isBlockedActivation || !isMarketplaceActivation || missingSteps.length === 0) && (
          <p className="text-sm text-gray-700">{launchDescription}</p>
        )}
        {isMarketplaceActivation && missingSteps.length > 0 && (
          <div className={isBlockedActivation ? "mt-4 grid gap-3" : "grid gap-3"}>
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
          disabled={!product || isBlockedActivation}
          onClick={onContinue}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span>
            {isBlockedActivation
              ? `${product ? labels[product] : "Product"} unavailable`
              : isMarketplaceActivation
                ? "Open Marketplace offer tools"
                : "Continue"}
          </span>
          {!isBlockedActivation && <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

function ProductRedirecting({
  labels,
  product,
}: {
  labels: ProductLabels;
  product: SharedHotelSetupProduct;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
      <LoadingSpinner label={`Opening ${labels[product]}`} />
      <p className="text-sm text-gray-500">Opening {labels[product]}...</p>
    </div>
  );
}

function buildProductContinueInput(
  view: SharedFirstRunSetupViewModel,
  returnTo: string | null,
): SharedFirstRunProductContinueInput | null {
  if (!view.selectedPropertyId || !view.product) return null;
  if (view.screen !== "product_activation" && view.screen !== "enter_product") return null;
  const activation = view.selectedProperty?.products[view.product] ?? null;
  return {
    product: view.product,
    productStatus: activation?.status ?? null,
    propertyId: view.selectedPropertyId,
    missingSteps: activation?.missingSteps ?? [],
    returnTo,
    action: view.screen === "enter_product" ? "enter_product" : "complete_product_activation",
  };
}

function isProductContinueBlocked(view: SharedFirstRunSetupViewModel): boolean {
  const product = view.product;
  if (!product) return true;
  const activation = view.selectedProperty?.products[product] ?? null;
  if (activation?.status === "suspended" || activation?.status === "unavailable") return true;
  return (
    view.screen === "product_activation" &&
    product === "marketplace" &&
    !canOpenMarketplaceProfileTools({
      product,
      productStatus: activation?.status ?? null,
      missingSteps: activation?.missingSteps ?? [],
    })
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
      className={`rounded-2xl border p-4 ${
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

function blockedActivationCopy(
  product: SharedHotelSetupProduct | null,
  status: SharedProductActivation<SharedHotelSetupProduct>["status"] | undefined,
): string {
  const productName = product ? DEFAULT_PRODUCT_LABELS[product] : "This product";
  if (status === "suspended") {
    return `${productName} access is currently suspended for this account. Contact support before continuing setup.`;
  }
  if (status === "unavailable") {
    return `${productName} is not available for this hotel. Contact support if this looks wrong.`;
  }
  return `${productName} is not ready for this hotel yet.`;
}

function marketplaceActivationStepCopy(step: string): { title: string; description: string } {
  return (
    MARKETPLACE_ACTIVATION_STEPS[step] ?? {
      title: step,
      description: "Complete this Marketplace activation item.",
    }
  );
}

function validateProfileDraft(
  draft: ProfileDraft,
  mode: "create" | "update",
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};

  if (!draft.displayName.trim()) errors.displayName = ["Hotel name is required."];
  if (!draft.city.trim()) {
    errors["location.city"] = ["City is required."];
  }
  if (!draft.countryCode.trim()) {
    errors["location.countryCode"] = ["Country is required."];
  } else if (!COUNTRY_OPTIONS.some((country) => country.code === draft.countryCode)) {
    errors["location.countryCode"] = ["Select a valid country."];
  }
  if (mode === "create") {
    if (!draft.propertyType) errors.propertyType = ["Property type is required."];
    if (!draft.streetAddress.trim()) {
      errors["location.streetAddress"] = ["Street address is required."];
    }
    if (!draft.postalCode.trim()) {
      errors["location.postalCode"] = ["Postal code is required."];
    }
    if (!draft.timezone.trim()) {
      errors["location.timezone"] = ["Time zone is required."];
    }
    if (!draft.contactEmail.trim()) {
      errors.contactEmail = ["Contact email is required."];
    }
    if (!draft.phone.trim()) errors.phone = ["Phone number is required."];
  }
  if (draft.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.contactEmail)) {
    errors.contactEmail = ["Enter a valid email address."];
  }
  if (draft.phone && draft.phone.trim().length < 5) {
    errors.phone = ["Enter a valid phone number."];
  }
  if (draft.website && !isHttpUrl(draft.website)) {
    errors.website = ["Enter a complete website URL, including https://."];
  }

  return errors;
}

function uniqueSelectedProducts(products: SharedHotelSetupProduct[]): SharedHotelSetupProduct[] {
  const selected = new Set(products);
  return SHARED_HOTEL_SETUP_PRODUCTS.filter((product) => selected.has(product));
}

function TextField({
  label,
  value,
  onChange,
  error,
  helper,
  placeholder,
  type = "text",
  readOnly = false,
  required = false,
  listOptions,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  helper?: string;
  placeholder?: string;
  type?: string;
  readOnly?: boolean;
  required?: boolean;
  listOptions?: string[];
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
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700"
      >
        <span>{label}</span>
        {!required && (
          <span aria-hidden="true" className="text-xs text-gray-400">
            Optional
          </span>
        )}
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
        list={listOptions ? `${inputId}-options` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-2 w-full rounded-xl border px-4 py-2.5 text-base outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100 sm:text-sm ${
          error ? "border-red-300 bg-red-50" : "border-gray-200"
        } ${readOnly ? "bg-gray-50 text-gray-600" : ""}`}
      />
      {listOptions && (
        <datalist id={`${inputId}-options`}>
          {listOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PropertyTypeField({
  value,
  options,
  onChange,
  error,
  required = false,
}: {
  value: string;
  options: SharedPropertyTypeOption[];
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
}) {
  const generatedId = useId();
  const groupName = `property-type-${generatedId}`;
  const errorId = error ? `${groupName}-error` : undefined;

  return (
    <fieldset aria-describedby={errorId} aria-invalid={Boolean(error)}>
      <legend className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700">
        <span>Property type</span>
        {!required && (
          <span aria-hidden="true" className="text-xs text-gray-400">
            Optional
          </span>
        )}
      </legend>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {options.map((option) => {
          const checked = value === option.value;
          const Icon = PROPERTY_TYPE_ICONS.get(option.value) ?? EllipsisHorizontalIcon;

          return (
            <label key={option.value} className="relative block cursor-pointer">
              <input
                type="radio"
                name={groupName}
                value={option.value}
                checked={checked}
                required={required}
                aria-invalid={Boolean(error)}
                aria-describedby={errorId}
                onChange={(event) => onChange(event.target.value)}
                className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
              />
              <span
                className={`relative flex min-h-16 items-center gap-2 rounded-xl border p-2.5 transition peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-primary-600 peer-focus-visible:ring-offset-2 ${
                  checked
                    ? "border-primary-500 bg-primary-50 shadow-[0_12px_30px_-24px_rgba(30,62,219,0.8)]"
                    : "border-gray-200 bg-white hover:border-primary-300 hover:bg-primary-50/40"
                }`}
              >
                <span
                  className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    checked ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-700"
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {checked && (
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary-700 text-white ring-2 ring-white">
                      <CheckIcon className="h-3 w-3" aria-hidden="true" />
                    </span>
                  )}
                </span>
                <span className="text-sm font-medium leading-5 text-gray-900">{option.label}</span>
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p id={errorId} className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

function SelectField({
  label,
  value,
  placeholder,
  options,
  onChange,
  error,
  required = false,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
}) {
  const generatedId = useId();
  const inputId = `setup-${generatedId}`;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div>
      <label
        htmlFor={inputId}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700"
      >
        <span>{label}</span>
        {!required && (
          <span aria-hidden="true" className="text-xs text-gray-400">
            Optional
          </span>
        )}
      </label>
      <select
        id={inputId}
        value={value}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={errorId}
        aria-required={required}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-2 w-full rounded-xl border bg-white px-4 py-2.5 text-base outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100 sm:text-sm ${
          error ? "border-red-300 bg-red-50" : "border-gray-200"
        }`}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
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
    propertyType: profile.propertyType ?? "",
    countryCode: profile.location.countryCode ?? "",
    region: profile.location.region ?? "",
    city: profile.location.city ?? "",
    rawMarketplaceLocation: profile.location.rawMarketplaceLocation ?? "",
    streetAddress: profile.location.streetAddress ?? "",
    postalCode: profile.location.postalCode ?? "",
    timezone: profile.location.timezone ?? "",
    website: profile.website ?? "",
    contactEmail: profile.contactEmail ?? "",
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
    propertyType: draft.propertyType || null,
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
    contactEmail: nullIfBlank(draft.contactEmail),
    phone: nullIfBlank(draft.phone),
    shortDescription: nullIfBlank(draft.shortDescription),
    longDescription: nullIfBlank(draft.longDescription),
    media: mediaFromDraft(draft, existingProfile),
  };
}

function newPropertyDraft(
  accountContactEmail: string | null,
  accountContactPhone: string | null,
  timezone = "",
): ProfileDraft {
  return {
    displayName: "",
    propertyType: "",
    countryCode: "",
    region: "",
    city: "",
    rawMarketplaceLocation: "",
    streetAddress: "",
    postalCode: "",
    timezone,
    website: "",
    contactEmail: accountContactEmail?.trim() ?? "",
    phone: accountContactPhone?.trim() ?? "",
    shortDescription: "",
    longDescription: "",
    mediaUrl: "",
  };
}

function browserTimezone(): string {
  if (typeof window === "undefined") return "";
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone === "UTC" ? "Etc/UTC" : timezone;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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

function propertyTypeOptionsFromCatalog(options: unknown): SharedPropertyTypeOption[] {
  if (
    !Array.isArray(options) ||
    options.length === 0 ||
    !options.every(
      (option) =>
        typeof option === "object" &&
        option !== null &&
        typeof option.value === "string" &&
        option.value.length > 0 &&
        typeof option.label === "string" &&
        option.label.length > 0,
    )
  ) {
    throw new Error("Property types are unavailable. Please try again.");
  }
  return options as SharedPropertyTypeOption[];
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

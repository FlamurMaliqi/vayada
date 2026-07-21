"use client";

import {
  type ComponentType,
  type RefObject,
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
  SparklesIcon,
  SunIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { COUNTRY_OPTIONS, TIMEZONE_OPTIONS } from "@vayada/locale-constants";

import { HotelIcon } from "./HotelIcon";
import GoogleAddressMap from "./GoogleAddressMap";
import GooglePlacesAddressField from "./GooglePlacesAddressField";
import { isValidSharedAccountPhone } from "./sharedAccountDetails";
import {
  SHARED_HOTEL_SETUP_PRODUCTS,
  isActionableSharedProductActivation,
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
  organizationId: string;
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
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  website: string;
  contactEmail: string;
  phone: string;
  shortDescription: string;
  longDescription: string;
  mediaUrl: string;
};

type ManualAddressReset = {
  latitude?: null;
  longitude?: null;
  region?: "";
};

export function locationResetForManualAddressEdit(field: string): ManualAddressReset {
  if (!["streetAddress", "postalCode", "city", "countryCode"].includes(field)) return {};

  return {
    latitude: null,
    longitude: null,
    ...(field === "city" || field === "countryCode" ? { region: "" as const } : {}),
  };
}

export function canConfirmLocation(
  location: Pick<
    ProfileDraft,
    "streetAddress" | "postalCode" | "city" | "countryCode" | "timezone"
  >,
): boolean {
  return Boolean(
    location.streetAddress.trim() &&
    location.postalCode.trim() &&
    location.city.trim() &&
    COUNTRY_OPTIONS.some((country) => country.code === location.countryCode) &&
    isValidIanaTimezone(location.timezone.trim()),
  );
}

function isValidIanaTimezone(value: string): boolean {
  if (!/^[A-Za-z_]+\/[A-Za-z0-9_+./-]+$/.test(value)) return false;

  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function hasMapCoordinates(location: Pick<ProfileDraft, "latitude" | "longitude">): boolean {
  return (
    typeof location.latitude === "number" &&
    Number.isFinite(location.latitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    typeof location.longitude === "number" &&
    Number.isFinite(location.longitude) &&
    location.longitude >= -180 &&
    location.longitude <= 180
  );
}

const DEFAULT_PRODUCT_LABELS: ProductLabels = {
  booking: "Booking Engine",
  pms: "PMS",
  marketplace: "Creator Marketplace",
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

type ProductSetupTaskDefinition = {
  id: string;
  title: string;
  description: string;
  missingSteps: readonly string[];
};

const PRODUCT_SETUP_TASKS: Record<SharedHotelSetupProduct, readonly ProductSetupTaskDefinition[]> =
  {
    booking: [
      {
        id: "booking-settings",
        title: "Configure booking settings",
        description: "Review booking preferences, policies, and guest-facing details.",
        missingSteps: ["bookingSettings"],
      },
      {
        id: "booking-readiness",
        title: "Prepare to accept direct bookings",
        description: "Publish live availability and finish guest payment setup.",
        missingSteps: ["publicBookability", "bookabilityFreshness", "paymentReadiness"],
      },
    ],
    pms: [
      {
        id: "rooms-and-rates",
        title: "Set up rooms & rates",
        description: "Create a room type, add physical rooms, and set its first rate plan.",
        missingSteps: ["roomTypes", "rooms", "ratePlans"],
      },
    ],
    marketplace: [
      {
        id: "creator-profile",
        title: "Introduce your hotel to creators",
        description: "Write the creator-facing pitch shown on your hotel profile.",
        missingSteps: ["creatorPitch"],
      },
      {
        id: "collaboration-offer",
        title: "Prepare your collaboration offer",
        description: "Add or review requested content, compensation, and creator requirements.",
        missingSteps: [
          "marketplaceOffer",
          "offerDeliverables",
          "compensationOptions",
          "creatorRequirements",
        ],
      },
    ],
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
  const [showProductSetupHubAfterSelection, setShowProductSetupHubAfterSelection] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [profileStep, setProfileStep] = useState(0);
  const profileHeading = useRef<HTMLHeadingElement>(null);
  const seededInitialSelectionPropertyIds = useRef<Set<string>>(new Set());
  const automaticContinueKey = useRef<string | null>(null);

  const view = useMemo(
    () => resolveSharedFirstRunSetupView(status, { forceCreateProperty }),
    [forceCreateProperty, status],
  );
  const productContinueReturnTo = status?.entry.returnTo ?? returnTo;
  const productContinueInput = useMemo(
    () =>
      buildProductContinueInput(
        view,
        status?.hotelGroup.organizationId ?? null,
        productContinueReturnTo,
      ),
    [productContinueReturnTo, status?.hotelGroup.organizationId, view],
  );
  const productContinueBlocked = isProductContinueBlocked(view);
  const isProductSetupScreen =
    view.screen === "product_activation" || view.screen === "enter_product";
  const shouldAutoContinueToProduct = autoContinueToProduct && !showProductSetupHubAfterSelection;
  const productSetupHub = !shouldAutoContinueToProduct && isProductSetupScreen;
  const productSetupProducts = productSetupHub
    ? uniqueSelectedProducts([
        ...(status?.hotelGroup.selectedProducts ?? []),
        ...(view.product && view.selectedProperty?.products[view.product].status !== "not_selected"
          ? [view.product]
          : []),
      ])
    : view.product
      ? [view.product]
      : [];
  const shellTitle = productSetupHub
    ? `Finish setting up ${view.selectedProperty?.displayName ?? "your hotel"}`
    : view.title;

  useEffect(() => {
    setForceCreateProperty(initialAddProperty);
  }, [initialAddProperty]);

  useEffect(() => {
    setProfileStep(0);
  }, [view.profileMode, view.selectedPropertyId]);

  useEffect(() => {
    setSelectedProducts(uniqueSelectedProducts([entryProduct, ...initialSelectedProducts]));
    setShowProductSetupHubAfterSelection(false);
    seededInitialSelectionPropertyIds.current.clear();
  }, [entryProduct, initialPropertyId, initialSelectedProducts]);

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
    if (
      loading ||
      error ||
      !shouldAutoContinueToProduct ||
      !productContinueInput ||
      productContinueBlocked
    ) {
      return;
    }
    const key = `${productContinueInput.action}:${productContinueInput.product}:${productContinueInput.propertyId}`;
    if (automaticContinueKey.current === key) return;
    automaticContinueKey.current = key;
    onProductContinue(productContinueInput);
  }, [
    error,
    loading,
    onProductContinue,
    productContinueBlocked,
    productContinueInput,
    shouldAutoContinueToProduct,
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
      setShowProductSetupHubAfterSelection(true);
      await reloadStatus(view.selectedPropertyId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleContinueProduct = (product: SharedHotelSetupProduct) => {
    const input = buildProductContinueInput(
      view,
      status?.hotelGroup.organizationId ?? null,
      productContinueReturnTo,
      product,
    );
    if (input) onProductContinue(input);
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
    <WizardShell
      title={shellTitle}
      view={view}
      embedded={embedded}
      mapFirst={view.screen === "property_profile" && profileStep === 1}
      productSetupHub={productSetupHub}
      headingRef={view.screen === "property_profile" ? profileHeading : undefined}
    >
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
          step={profileStep}
          mode={view.profileMode ?? "create"}
          hasAccountSuggestions={Boolean(accountContactEmail || accountContactPhone)}
          embedded={embedded}
          loading={!propertyTypeOptions}
          saving={saving}
          fieldErrors={fieldErrors}
          propertyTypeOptions={propertyTypeOptions ?? []}
          pageHeadingRef={profileHeading}
          onChange={setDraft}
          onFieldErrors={setFieldErrors}
          onStepChange={setProfileStep}
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
          {shouldAutoContinueToProduct && productContinueInput && !productContinueBlocked ? (
            <ProductRedirecting labels={labels} product={productContinueInput.product} />
          ) : (
            <ProductContinue
              labels={labels}
              view={view}
              selectedProducts={productSetupProducts}
              onContinue={handleContinueProduct}
            />
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
  headingRef,
  loading = false,
  embedded = false,
  mapFirst = false,
  productSetupHub = false,
}: {
  children?: React.ReactNode;
  title: string;
  view: SharedFirstRunSetupViewModel;
  headingRef?: RefObject<HTMLHeadingElement>;
  loading?: boolean;
  embedded?: boolean;
  mapFirst?: boolean;
  productSetupHub?: boolean;
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
        : view.screen === "product_selection"
          ? null
          : productSetupHub
            ? "Your hotel details are saved. Continue in each selected workspace to get every product ready."
            : "Your hotel details are saved. Continue in this workspace to finish product setup.";
  const isProfileScreen = view.screen === "property_profile";
  const isProductSelectionScreen = view.screen === "product_selection";
  const useWideSetupLayout = isProductSelectionScreen || productSetupHub;

  if (embedded) {
    return (
      <section className="min-w-0">
        {!mapFirst && (
          <div className="mb-4 px-1 sm:px-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2
                  ref={headingRef}
                  tabIndex={headingRef ? -1 : undefined}
                  className="text-lg font-semibold text-gray-950 outline-none"
                >
                  {title}
                </h2>
                {subtitle && <p className="mt-1 max-w-2xl text-sm text-gray-500">{subtitle}</p>}
              </div>
              <span className="w-fit rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
                Step {progress} of 4
              </span>
            </div>
          </div>
        )}
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
      className={`flex min-h-screen text-gray-900 ${
        mapFirst ? "" : "items-center px-4 py-6 sm:px-6 lg:px-8"
      } ${isProfileScreen || useWideSetupLayout ? "bg-gray-50" : "bg-white"}`}
    >
      <div
        className={`mx-auto w-full ${
          mapFirst
            ? "max-w-none"
            : isProfileScreen
              ? "max-w-7xl"
              : useWideSetupLayout
                ? "max-w-6xl"
                : "max-w-5xl"
        }`}
      >
        {!mapFirst && (
          <header
            className={`mx-auto text-center ${
              isProfileScreen
                ? "mb-4 max-w-2xl"
                : useWideSetupLayout
                  ? "mb-8 max-w-2xl"
                  : "mb-5 max-w-xl"
            }`}
          >
            <h1
              ref={headingRef}
              tabIndex={headingRef ? -1 : undefined}
              className="text-3xl font-semibold tracking-tight text-gray-950 outline-none"
            >
              {title}
            </h1>
            {subtitle && <p className="mt-2 text-sm text-gray-500">{subtitle}</p>}
          </header>
        )}

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

function HotelFacadeIllustration() {
  return (
    <svg
      viewBox="0 0 260 220"
      className="mx-auto h-auto w-full max-w-[32rem] text-gray-900"
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

function ProfileForm({
  draft,
  step,
  mode,
  hasAccountSuggestions,
  embedded,
  loading,
  saving,
  fieldErrors,
  propertyTypeOptions,
  pageHeadingRef,
  onChange,
  onFieldErrors,
  onStepChange,
  onCancel,
  onSave,
}: {
  draft: ProfileDraft;
  step: number;
  mode: "create" | "update";
  hasAccountSuggestions: boolean;
  embedded: boolean;
  loading: boolean;
  saving: boolean;
  fieldErrors: Record<string, string[]>;
  propertyTypeOptions: SharedPropertyTypeOption[];
  pageHeadingRef: RefObject<HTMLHeadingElement>;
  onChange: (draft: ProfileDraft) => void;
  onFieldErrors: (errors: Record<string, string[]>) => void;
  onStepChange: (step: number) => void;
  onCancel?: () => void;
  onSave: () => void;
}) {
  const googleMapsApiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim();
  const LocationHeading = embedded ? "h2" : "h1";
  const [showAddressFields, setShowAddressFields] = useState(
    () =>
      !googleMapsApiKey ||
      (mode === "update" && !(canConfirmLocation(draft) && hasMapCoordinates(draft))),
  );
  const [addressSearchUnavailable, setAddressSearchUnavailable] = useState(false);
  const addressRevision = useRef(0);
  const addressFields = useRef<HTMLDivElement>(null);
  const addressFieldsId = useId();
  const addressFieldsWereLoading = useRef(loading);
  const editAddressButton = useRef<HTMLButtonElement>(null);
  const focusAddressFieldsWhenShown = useRef(false);
  const stepHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const errorStep = PROFILE_STEP_FIELDS.findIndex((fields) =>
      fields.some((field) => fieldErrors[field]),
    );
    if (errorStep >= 0 && errorStep !== step) {
      onStepChange(errorStep);
      requestAnimationFrame(() =>
        (errorStep === 1 ? pageHeadingRef.current : stepHeading.current)?.focus(),
      );
    }
  }, [fieldErrors, onStepChange, pageHeadingRef, step]);

  useEffect(() => {
    if (PROFILE_STEP_FIELDS[1].some((field) => fieldErrors[field])) {
      setShowAddressFields(true);
      requestAnimationFrame(() =>
        addressFields.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
    }
  }, [fieldErrors]);

  useEffect(() => {
    const finishedLoading = addressFieldsWereLoading.current && !loading;
    addressFieldsWereLoading.current = loading;
    if (finishedLoading && googleMapsApiKey && mode === "update") {
      setShowAddressFields(!(canConfirmLocation(draft) && hasMapCoordinates(draft)));
    }
  }, [draft, googleMapsApiKey, loading, mode]);

  useEffect(() => {
    if (showAddressFields && focusAddressFieldsWhenShown.current) {
      focusAddressFieldsWhenShown.current = false;
      focusFirstIncompleteAddressField(addressFields.current);
    }
  }, [showAddressFields]);

  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center">
        <LoadingSpinner label="Loading property profile" />
      </div>
    );
  }

  const setField = (field: keyof ProfileDraft, value: string) => {
    const locationReset = locationResetForManualAddressEdit(field);
    if ("latitude" in locationReset) addressRevision.current += 1;
    onChange({
      ...draft,
      [field]: value,
      ...locationReset,
    });
  };
  const changeStep = (nextStep: number) => {
    onFieldErrors({});
    onStepChange(nextStep);
    requestAnimationFrame(() =>
      (nextStep === 1 ? pageHeadingRef.current : stepHeading.current)?.focus(),
    );
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
  const country = COUNTRY_OPTIONS.find((option) => option.code === draft.countryCode);
  const countryName = country?.name ?? draft.countryCode;
  const hasCompleteLocation = canConfirmLocation(draft);
  const hasMappedLocation = hasCompleteLocation && hasMapCoordinates(draft);
  const timezoneMatchesBrowser =
    mode === "create" && draft.timezone && draft.timezone === browserTimezone();
  const profileProgress = (
    <div
      className={
        step === 1
          ? "flex shrink-0 items-center gap-2 rounded-full bg-primary-50 px-3 py-1.5"
          : "flex flex-col items-center gap-2"
      }
    >
      <p
        className={`shrink-0 font-semibold text-gray-500 ${step === 1 ? "text-xs" : "text-sm"}`}
        aria-live="polite"
      >
        Step {step + 1} of {PROFILE_STEP_FIELDS.length}
        {step !== 1 && ` · ${PROFILE_STEP_TITLES[step]}`}
      </p>
      <ol
        className={`grid w-full grid-cols-3 ${
          step === 1 ? "max-w-10 gap-1" : "max-w-[12rem] gap-2"
        }`}
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
  );
  const actions = (
    <div
      className={
        step === 1
          ? "grid w-full grid-cols-2 gap-3 sm:w-auto sm:grid-cols-[auto_auto]"
          : "flex w-full flex-col-reverse items-center gap-3 sm:flex-row sm:justify-center"
      }
    >
      {(step > 0 || onCancel) && (
        <button
          type="button"
          disabled={saving}
          onClick={() => (step > 0 ? changeStep(step - 1) : onCancel?.())}
          className={`w-full rounded-full border border-gray-200 bg-white px-5 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto ${
            step === 1 ? "sm:min-w-32" : ""
          }`}
        >
          {step > 0 ? "Back" : "Back to properties"}
        </button>
      )}
      <button
        type="submit"
        disabled={step === PROFILE_STEP_FIELDS.length - 1 && saving}
        className={`inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto ${
          step === 1 ? "sm:min-w-32" : ""
        }`}
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
      className={`mx-auto ${step === 1 ? "max-w-none" : "max-w-7xl space-y-8"}`}
    >
      {step !== 1 && profileProgress}

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
        <aside className="hidden min-h-[32rem] items-center justify-center p-8 xl:flex">
          <HotelFacadeIllustration />
        </aside>
      </section>

      <section inert={saving ? true : undefined} className={step === 2 ? "block" : "hidden"}>
        <div className="mx-auto max-w-3xl rounded-[2rem] bg-white p-5 text-left shadow-[0_30px_90px_-50px_rgba(15,23,42,0.45)] sm:p-8">
          <div className="mb-4">
            <h3
              ref={step === 2 ? stepHeading : undefined}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight text-gray-950 outline-none"
            >
              How can guests reach you?
            </h3>
            {mode === "create" && hasAccountSuggestions && (
              <p className="mt-2 text-sm text-gray-500">
                Pre-filled from your account. Edit if needed.
              </p>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
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
      </section>

      <section inert={saving ? true : undefined} className={step === 1 ? "block" : "hidden"}>
        <div className="relative isolate min-h-[100dvh] overflow-hidden bg-slate-100 text-left">
          {googleMapsApiKey && (
            <GoogleAddressMap
              active={step === 1}
              apiKey={googleMapsApiKey}
              latitude={draft.latitude}
              longitude={draft.longitude}
            />
          )}

          <div className="pointer-events-none absolute inset-0 z-10 flex items-end p-3 sm:block sm:p-0">
            <div className="pointer-events-auto flex max-h-[calc(100dvh-1.5rem)] w-full flex-col rounded-3xl border border-white/80 bg-white/95 shadow-[0_18px_50px_-20px_rgba(15,23,42,0.35)] backdrop-blur focus-within:self-start sm:contents">
              <div
                data-testid="location-search-panel"
                className={`pointer-events-auto min-h-0 flex-1 p-4 sm:absolute sm:left-6 sm:top-6 sm:flex-none sm:rounded-2xl sm:border sm:border-white/80 sm:bg-white/95 sm:shadow-[0_18px_50px_-20px_rgba(15,23,42,0.35)] sm:backdrop-blur lg:left-8 lg:top-8 ${
                  showAddressFields
                    ? "overflow-y-auto sm:max-h-[calc(100dvh-10rem)] sm:w-[calc(100%-3rem)] sm:max-w-md"
                    : "sm:w-[calc(100%-3rem)] sm:max-w-lg"
                }`}
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <LocationHeading
                    ref={step === 1 ? pageHeadingRef : undefined}
                    tabIndex={-1}
                    className="text-xl font-semibold tracking-tight text-gray-950 outline-none"
                  >
                    Where is your property?
                  </LocationHeading>
                  {step === 1 && profileProgress}
                </div>

                {googleMapsApiKey && !showAddressFields && (
                  <GooglePlacesAddressField
                    addressRevision={addressRevision}
                    apiKey={googleMapsApiKey}
                    onUnavailable={(autocompleteWasFocused) => {
                      setAddressSearchUnavailable(true);
                      if (!showAddressFields) focusAddressFieldsWhenShown.current = true;
                      setShowAddressFields(true);
                      if (showAddressFields && autocompleteWasFocused) {
                        requestAnimationFrame(() =>
                          focusFirstIncompleteAddressField(addressFields.current),
                        );
                      }
                    }}
                    onSelect={(address, isExactAddress) => {
                      setAddressSearchUnavailable(false);
                      const nextDraft = { ...draft, ...address };
                      const canCollapse =
                        isExactAddress &&
                        canConfirmLocation(nextDraft) &&
                        hasMapCoordinates(nextDraft);
                      onChange(nextDraft);
                      setShowAddressFields(!canCollapse);
                      if (!canCollapse) {
                        requestAnimationFrame(() =>
                          focusFirstIncompleteAddressField(addressFields.current),
                        );
                      }
                    }}
                  />
                )}

                {!showAddressFields && (
                  <button
                    ref={editAddressButton}
                    type="button"
                    aria-controls={addressFieldsId}
                    aria-expanded={false}
                    onClick={() => {
                      setShowAddressFields(true);
                      requestAnimationFrame(() =>
                        focusFirstIncompleteAddressField(addressFields.current),
                      );
                    }}
                    className="mt-2 text-sm font-semibold text-primary-700 transition hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
                  >
                    {hasCompleteLocation ? "Edit address details" : "Enter address manually"}
                  </button>
                )}

                {showAddressFields && (
                  <div
                    ref={addressFields}
                    id={addressFieldsId}
                    className="border-t border-gray-100 pt-4"
                  >
                    {addressSearchUnavailable && (
                      <p
                        className="mb-4 rounded-xl bg-gray-50 px-3 py-2.5 text-sm text-gray-600"
                        role="status"
                      >
                        Address suggestions are unavailable. Enter the address manually.
                      </p>
                    )}
                    {googleMapsApiKey && hasCompleteLocation && (
                      <div className="mb-3 flex justify-end">
                        <button
                          type="button"
                          aria-controls={addressFieldsId}
                          aria-expanded={true}
                          onClick={() => {
                            setShowAddressFields(false);
                            requestAnimationFrame(() => editAddressButton.current?.focus());
                          }}
                          className="text-sm font-semibold text-primary-700 transition hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
                        >
                          Done editing
                        </button>
                      </div>
                    )}
                    <div className="grid gap-4">
                      <TextField
                        label="Street address"
                        value={draft.streetAddress}
                        placeholder="Marienplatz 1"
                        required={mode === "create"}
                        error={fieldErrors["location.streetAddress"]?.[0]}
                        onChange={(value) => setField("streetAddress", value)}
                      />
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
                        <TextField
                          label="Imported location"
                          value={draft.rawMarketplaceLocation}
                          readOnly
                          helper="Read-only location imported from the existing marketplace profile."
                          onChange={() => undefined}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div
                data-testid="location-action-bar"
                className={`pointer-events-auto shrink-0 border-t border-gray-100 p-4 sm:absolute sm:bottom-8 sm:left-1/2 sm:flex sm:-translate-x-1/2 sm:items-center sm:justify-between sm:rounded-2xl sm:border sm:border-white/80 sm:bg-white/95 sm:shadow-[0_18px_50px_-20px_rgba(15,23,42,0.35)] sm:backdrop-blur ${
                  !showAddressFields && hasCompleteLocation
                    ? "sm:w-[calc(100%-3rem)] sm:max-w-4xl"
                    : "sm:w-auto sm:min-w-[19rem]"
                }`}
              >
                {!showAddressFields && hasCompleteLocation && (
                  <div
                    className="flex min-w-0 items-start gap-3 sm:flex-1 sm:items-center"
                    aria-live="polite"
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-600 text-white sm:mt-0">
                      <MapPinIcon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-950">
                        {hasMappedLocation
                          ? "Is this the right location?"
                          : "Address details entered"}
                      </p>
                      <p className="mt-0.5 text-sm text-gray-700 sm:truncate">
                        {[
                          draft.streetAddress,
                          [draft.postalCode, draft.city].filter(Boolean).join(" "),
                          countryName,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </p>
                      {draft.timezone && (
                        <p className="mt-0.5 text-xs text-gray-500">Time zone · {draft.timezone}</p>
                      )}
                      {timezoneMatchesBrowser && (
                        <p className="mt-0.5 text-xs text-gray-500">
                          This matches your device. Verify it if the hotel is elsewhere.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                <div
                  className={
                    !showAddressFields && hasCompleteLocation
                      ? "mt-4 sm:ml-6 sm:mt-0 sm:shrink-0"
                      : ""
                  }
                >
                  {actions}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {step !== 1 && actions}

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
  const statusDescriptionId = useId();

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-col items-center text-center">
        {selectedProperty?.displayName && (
          <span className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm ring-1 ring-gray-200">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-white">
              <CheckIcon className="h-3 w-3" aria-hidden="true" />
            </span>
            {selectedProperty.displayName} details saved
          </span>
        )}
        <h2 className="mt-4 text-2xl font-semibold tracking-tight text-gray-950">
          Choose account systems
        </h2>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {SHARED_HOTEL_SETUP_PRODUCTS.map((product) => {
          const checked = selectedProducts.includes(product);
          const disabled = !isSharedHotelSetupProductSelectable(selectedProperty, product);
          const Icon = productIcon(product);
          const statusLabel = productStatusLabel(selectedProperty, product, checked);
          const showStatus = statusLabel !== "Selected" && statusLabel !== "Not selected";
          const productStatusDescriptionId = `${statusDescriptionId}-${product}`;
          return (
            <label
              key={product}
              className={`group flex flex-col rounded-3xl bg-white p-5 text-left shadow-sm transition duration-200 focus-within:outline-none focus-within:ring-2 focus-within:ring-primary-600 focus-within:ring-offset-2 focus-within:ring-offset-gray-50 ${
                disabled
                  ? "cursor-not-allowed opacity-60 ring-1 ring-gray-200"
                  : checked
                    ? "cursor-pointer ring-2 ring-primary-500 shadow-md motion-safe:hover:-translate-y-1"
                    : "cursor-pointer ring-1 ring-gray-200 motion-safe:hover:-translate-y-1 motion-safe:hover:shadow-md motion-safe:hover:ring-primary-200"
              }`}
            >
              <span className="flex items-center justify-between">
                <span
                  className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
                    checked ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-600"
                  }`}
                >
                  <Icon className="h-6 w-6" aria-hidden="true" />
                </span>
                <input
                  type="checkbox"
                  className="sr-only"
                  aria-label={labels[product]}
                  aria-describedby={showStatus ? productStatusDescriptionId : undefined}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    if (!disabled) onToggle(product);
                  }}
                />
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full border-2 transition-colors ${
                    checked
                      ? "border-primary-600 bg-primary-600 text-white"
                      : "border-gray-300 bg-white text-transparent"
                  }`}
                  aria-hidden="true"
                >
                  <CheckIcon className="h-3.5 w-3.5" />
                </span>
              </span>
              <span className="flex min-w-0 flex-1 flex-col pt-4">
                <span className="block text-lg font-semibold text-gray-950">{labels[product]}</span>
                <span className="mt-1.5 block text-sm leading-5 text-gray-600">
                  {PRODUCT_DESCRIPTIONS[product]}
                </span>
                <span className="mt-auto flex items-center gap-2 pt-4 text-sm font-medium text-gray-800">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary-700">
                    <CheckIcon className="h-3 w-3" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="sr-only">Unlocks: </span>
                    {PRODUCT_UNLOCKS[product]}
                  </span>
                </span>
                {showStatus && (
                  <span
                    id={productStatusDescriptionId}
                    className="mt-3 w-fit rounded-full bg-gray-50 px-2.5 py-1 text-[11px] font-medium text-gray-600 ring-1 ring-inset ring-gray-200"
                  >
                    {statusLabel}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>

      {needsSelection && (
        <p className="mt-5 text-center text-sm text-red-600" role="alert">
          Select at least one available product to continue.
        </p>
      )}

      <div className="mt-6 flex flex-col items-center gap-3">
        <button
          type="button"
          disabled={saving || needsSelection}
          onClick={onSave}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          {saving && (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
              aria-hidden="true"
            />
          )}
          <span>{saving ? "Saving..." : "Continue setup"}</span>
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
  selectedProducts: products,
  onContinue,
}: {
  labels: ProductLabels;
  view: SharedFirstRunSetupViewModel;
  selectedProducts: SharedHotelSetupProduct[];
  onContinue: (product: SharedHotelSetupProduct) => void;
}) {
  const property = view.selectedProperty;
  if (!property) {
    return (
      <div
        className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        role="alert"
      >
        The selected hotel could not be loaded. Refresh the page to try again.
      </div>
    );
  }
  const readyCount = products.filter(
    (product) => property.products[product].status === "active",
  ).length;
  const progress = products.length === 0 ? 0 : Math.round((readyCount / products.length) * 100);

  return (
    <div>
      <section
        aria-label="Shared hotel setup complete"
        className="flex flex-col gap-3 rounded-2xl border border-primary-100 bg-primary-50/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-600 text-white">
            <CheckIcon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-gray-950">Hotel details saved</h2>
            <p className="mt-0.5 text-xs text-gray-600">
              Name, location, and contact details are shared across your products.
            </p>
          </div>
        </div>
        <span className="w-fit rounded-full bg-white px-3 py-1 text-xs font-medium text-gray-700 ring-1 ring-inset ring-primary-100">
          {products.length} product{products.length === 1 ? "" : "s"} selected
        </span>
      </section>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-950">Your product setup</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Complete the required steps in each workspace. Advanced settings can be configured
            later.
          </p>
        </div>
        <p className="shrink-0 text-sm font-semibold text-gray-700" aria-live="polite">
          {readyCount} of {products.length} products ready
        </p>
      </div>

      <div
        className="mt-3 h-2 overflow-hidden rounded-full bg-gray-200"
        role="progressbar"
        aria-label="Selected products ready"
        aria-valuemin={0}
        aria-valuemax={products.length}
        aria-valuenow={readyCount}
      >
        <div
          className="h-full rounded-full bg-primary-600 transition-[width] duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div
        className={`mt-5 grid gap-4 ${
          products.length === 1 ? "mx-auto max-w-2xl" : "md:grid-cols-2 xl:grid-cols-3"
        }`}
      >
        {products.map((product) => (
          <ProductSetupCard
            key={product}
            product={product}
            label={labels[product]}
            activation={property.products[product]}
            onContinue={() => onContinue(product)}
          />
        ))}
      </div>

      {products.length === 0 && (
        <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Select at least one product to continue setup.
        </div>
      )}
    </div>
  );
}

type ProductSetupTask = Omit<ProductSetupTaskDefinition, "missingSteps"> & {
  complete: boolean;
};

export function productSetupTasks(
  product: SharedHotelSetupProduct,
  activation: Pick<SharedProductActivation<SharedHotelSetupProduct>, "status" | "missingSteps">,
): ProductSetupTask[] {
  const definitions = PRODUCT_SETUP_TASKS[product];
  const missingSteps = new Set(activation.missingSteps);
  const tasks = definitions.map(({ missingSteps: taskSteps, ...task }) => ({
    ...task,
    complete: activation.status === "active" || !taskSteps.some((step) => missingSteps.has(step)),
  }));
  const knownSteps = new Set(definitions.flatMap((task) => task.missingSteps));
  const hasUnknownStep = activation.missingSteps.some(
    (step) => step !== "productEntitlement" && !knownSteps.has(step),
  );

  if (activation.status !== "active" && hasUnknownStep) {
    tasks.push({
      id: "additional-setup",
      title: "Complete product setup",
      description: "Review the remaining requirements in this product workspace.",
      complete: false,
    });
  }

  return tasks;
}

function ProductSetupCard({
  product,
  label,
  activation,
  onContinue,
}: {
  product: SharedHotelSetupProduct;
  label: string;
  activation: SharedProductActivation<SharedHotelSetupProduct>;
  onContinue: () => void;
}) {
  const Icon = productIcon(product);
  const tasks = productSetupTasks(product, activation);
  const completedTasks = tasks.filter((task) => task.complete).length;
  const canContinue = canContinueProductSetup(activation);
  const statusLabel = productSetupStatusLabel(product, activation);
  const notice = productSetupNotice(product, activation, canContinue);
  const blocked = activation.status === "suspended" || activation.status === "unavailable";

  return (
    <article className="flex min-w-0 flex-col rounded-3xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary-50 text-primary-700">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
            activation.status === "active"
              ? "bg-emerald-50 text-emerald-700"
              : blocked
                ? "bg-red-50 text-red-700"
                : activation.missingSteps.includes("productEntitlement")
                  ? "bg-amber-50 text-amber-800"
                  : "bg-primary-50 text-primary-700"
          }`}
        >
          {statusLabel}
        </span>
      </div>

      <h2 className="mt-4 text-lg font-semibold text-gray-950">{label}</h2>
      <p className="mt-1 text-sm leading-5 text-gray-600">{PRODUCT_DESCRIPTIONS[product]}</p>

      {!blocked && (
        <div className="mt-5 flex-1 border-t border-gray-100 pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            {completedTasks} of {tasks.length} required step{tasks.length === 1 ? "" : "s"} complete
          </p>
          <ol className="mt-3 space-y-3">
            {tasks.map((task, index) => (
              <li key={task.id} className="flex gap-3">
                <span
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    task.complete
                      ? "bg-emerald-100 text-emerald-700"
                      : "border border-gray-300 bg-white text-gray-600"
                  }`}
                >
                  {task.complete ? (
                    <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    index + 1
                  )}
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">{task.title}</h3>
                  <p className="mt-0.5 text-xs leading-5 text-gray-500">{task.description}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {notice && (
        <p
          className={`mt-4 rounded-xl px-3 py-2.5 text-xs leading-5 ${
            blocked ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"
          }`}
          role={blocked ? "alert" : undefined}
        >
          {notice}
        </p>
      )}

      <button
        type="button"
        disabled={!canContinue}
        onClick={onContinue}
        className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-500"
      >
        <span>{productSetupActionLabel(product, label, activation, canContinue)}</span>
        {canContinue && <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />}
      </button>
    </article>
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
  organizationId: string | null,
  returnTo: string | null,
  requestedProduct: SharedHotelSetupProduct | null = view.product,
): SharedFirstRunProductContinueInput | null {
  if (!view.selectedPropertyId || !organizationId || !requestedProduct) return null;
  if (view.screen !== "product_activation" && view.screen !== "enter_product") return null;
  const activation = view.selectedProperty?.products[requestedProduct] ?? null;
  return {
    product: requestedProduct,
    productStatus: activation?.status ?? null,
    organizationId,
    propertyId: view.selectedPropertyId,
    missingSteps: activation?.missingSteps ?? [],
    returnTo,
    action:
      activation?.status === "active" ||
      (activation?.status === "selected_incomplete" && activation.missingSteps.length === 0)
        ? "enter_product"
        : "complete_product_activation",
  };
}

function isProductContinueBlocked(view: SharedFirstRunSetupViewModel): boolean {
  const product = view.product;
  if (!product) return true;
  const activation = view.selectedProperty?.products[product] ?? null;
  return !activation || !canContinueProductSetup(activation);
}

export function canContinueProductSetup(
  activation: Pick<SharedProductActivation<SharedHotelSetupProduct>, "status" | "missingSteps">,
): boolean {
  if (activation.status === "active") return true;
  if (activation.status === "selected_incomplete" && activation.missingSteps.length === 0) {
    return true;
  }
  return isActionableSharedProductActivation({
    productStatus: activation.status,
    missingSteps: activation.missingSteps,
  });
}

function productSetupStatusLabel(
  product: SharedHotelSetupProduct,
  activation: Pick<SharedProductActivation<SharedHotelSetupProduct>, "status" | "missingSteps">,
): string {
  if (activation.status === "active") return "Ready";
  if (activation.status === "suspended") return "Suspended";
  if (activation.status === "unavailable") return "Unavailable";
  if (activation.missingSteps.includes("productEntitlement")) return "Access pending";
  if (isMarketplaceVerificationPending(product, activation)) return "Verification pending";
  return "Setup needed";
}

function productSetupNotice(
  product: SharedHotelSetupProduct,
  activation: Pick<SharedProductActivation<SharedHotelSetupProduct>, "status" | "missingSteps">,
  canContinue: boolean,
): string | null {
  const productName = DEFAULT_PRODUCT_LABELS[product];
  if (activation.status === "suspended") {
    return `${productName} access is currently suspended for this account. Contact support before continuing setup.`;
  }
  if (activation.status === "unavailable") {
    return `${productName} is not available for this hotel. Contact support if this looks wrong.`;
  }
  if (activation.missingSteps.includes("productEntitlement")) {
    return `${DEFAULT_PRODUCT_LABELS[product]} access is still being enabled for this hotel.`;
  }
  if (activation.status === "selected_incomplete" && !canContinue) {
    return isMarketplaceVerificationPending(product, activation)
      ? "Marketplace verification is still in progress. No action is needed right now."
      : "This setup needs attention before it can continue. Please try again later.";
  }
  if (isMarketplaceVerificationPending(product, activation)) {
    return "Your Marketplace profile is under review. You can still open the workspace and manage it.";
  }
  return null;
}

function productSetupActionLabel(
  product: SharedHotelSetupProduct,
  label: string,
  activation: Pick<SharedProductActivation<SharedHotelSetupProduct>, "status" | "missingSteps">,
  canContinue: boolean,
): string {
  if (!canContinue) {
    if (activation.status === "suspended" || activation.status === "unavailable") {
      return `${label} unavailable`;
    }
    if (isMarketplaceVerificationPending(product, activation)) return "Verification pending";
    return activation.missingSteps.includes("productEntitlement")
      ? "Access pending"
      : "Setup pending";
  }
  if (activation.status === "active") return `Open ${label}`;
  if (isMarketplaceVerificationPending(product, activation)) return `Open ${label}`;
  if (product === "booking") return "Continue in Booking Admin";
  if (product === "pms") return "Continue in PMS";
  return "Continue Marketplace setup";
}

function isMarketplaceVerificationPending(
  product: SharedHotelSetupProduct,
  activation: Pick<SharedProductActivation<SharedHotelSetupProduct>, "status" | "missingSteps">,
): boolean {
  return (
    product === "marketplace" &&
    activation.status === "selected_incomplete" &&
    activation.missingSteps.length === 0
  );
}

export function validateProfileDraft(
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
  if (draft.timezone.trim() && !isValidIanaTimezone(draft.timezone.trim())) {
    errors["location.timezone"] = ["Enter a valid IANA time zone."];
  }
  if (draft.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.contactEmail)) {
    errors.contactEmail = ["Enter a valid email address."];
  }
  if (!isValidSharedAccountPhone(draft.phone)) {
    errors.phone = ["Enter a valid phone number."];
  }
  if (draft.website && !isHttpUrl(draft.website)) {
    errors.website = ["Enter a complete website URL, including https://."];
  }

  return errors;
}

function focusFirstIncompleteAddressField(container: HTMLDivElement | null) {
  const fields = Array.from(
    container?.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select") ?? [],
  );
  (fields.find((field) => !field.value.trim()) ?? fields[0])?.focus();
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
    latitude: profile.location.latitude,
    longitude: profile.location.longitude,
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
      latitude: draft.latitude,
      longitude: draft.longitude,
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
    latitude: null,
    longitude: null,
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

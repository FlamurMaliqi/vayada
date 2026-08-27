"use client";

import {
  type ComponentType,
  type ReactNode,
  type RefObject,
  type SVGProps,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BuildingOffice2Icon,
  BuildingOfficeIcon,
  BuildingStorefrontIcon,
  CakeIcon,
  CheckIcon,
  EllipsisHorizontalIcon,
  ExclamationCircleIcon,
  HomeModernIcon,
  KeyIcon,
  MapPinIcon,
  PhotoIcon,
  PlusIcon,
  SparklesIcon,
  SunIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import type {
  AdaptiveHotelSetupStatus,
  CreatePropertyProfileRequest,
  PropertyProfileContact,
  PropertyProfilePatch,
  PropertyProfileResponse,
  PublicPropertyProfileResponse,
  SetupComponentProduct,
  SetupTask,
  SetupTaskId,
  SetupTrack,
  UpdatePropertyProfileRequest,
} from "@vayada/domain-hotels";
import {
  COUNTRY_OPTIONS,
  CURRENCY_OPTIONS,
  LANGUAGE_OPTIONS,
  POPULAR_CURRENCY_CODES,
  POPULAR_LANGUAGE_CODES,
} from "@vayada/locale-constants";
import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/min";

import { HotelIcon } from "./HotelIcon";
import { LocalizationMultiSelect } from "./LocalizationMultiSelect";
import GoogleAddressMap from "./GoogleAddressMap";
import GooglePlacesAddressField from "./GooglePlacesAddressField";
import TimezoneField from "./TimezoneField";
import { availableTimezones, defaultTimezoneForCountry, timezoneForCoordinates } from "./timezones";
import {
  isSetupTaskActionable,
  resolveSharedFirstRunSetupView,
  toggleSetupTrackSelection,
  type SharedFirstRunSetupViewModel,
  type SharedHotelSetupEntryProduct,
  type SharedSetupProperty,
} from "./sharedFirstRunSetupFlow";
import type { SharedHotelSetupApi, SharedPropertyTypeOption } from "./sharedHotelSetupApi";
import {
  clearPendingPropertyLogo,
  readPendingPropertyLogo,
  sharedPropertyLogoError,
  writePendingPropertyLogo,
  type PendingPropertyLogoAssignment,
} from "./sharedPropertyLogo";
import {
  propertyLaunchSettingsDefaults,
  validatePropertyLaunchSettings,
  type PropertyLaunchSettings,
  type PropertyLaunchSettingsApi,
} from "./propertyLaunchSettings";

type ProductLabels = Record<SetupComponentProduct, string>;
type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export type SharedFirstRunContinueInput = {
  action: "enter_product";
  product: SetupComponentProduct;
  propertyId: string;
  returnTo: string | null;
};

export type SharedFirstRunPropertySetupWizardProps = {
  api: SharedHotelSetupApi;
  entryProduct: SharedHotelSetupEntryProduct;
  initialPropertyId?: string | null;
  returnTo?: string | null;
  initialAddProperty?: boolean;
  embedded?: boolean;
  productLabels?: Partial<ProductLabels>;
  onContinue: (input: SharedFirstRunContinueInput) => void | Promise<void>;
  renderTaskForm: (context: SharedSetupTaskFormContext) => ReactNode;
  propertyLaunchSettingsApi?: PropertyLaunchSettingsApi;
  onPropertySelected?: (propertyId: string) => void | Promise<void>;
  onExit?: (propertyId: string | null) => void;
};

export type SharedSetupTaskFormContext = {
  task: SetupTask;
  propertyId: string;
  selectedTracks: readonly SetupTrack[];
  onBeforeSave: () => Promise<void>;
  onComplete: () => Promise<void>;
  onBack: (() => void) | null;
  onDirty: () => void;
};

type ProfileDraft = {
  displayName: string;
  propertyType: string;
  countryCode: string;
  city: string;
  streetAddress: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  contactEmail: string;
  phone: string;
  whatsapp: string;
  localityPublic: boolean;
  logoFile: File | null;
  logoMediaObjectId: string | null;
  logoPublicUrl: string;
};

type ManualAddressReset = {
  latitude?: null;
  longitude?: null;
};

export function locationResetForManualAddressEdit(field: string): ManualAddressReset {
  if (!["streetAddress", "postalCode", "city", "countryCode"].includes(field)) return {};

  return {
    latitude: null,
    longitude: null,
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

const TRACK_CONTENT: Record<
  SetupTrack,
  { title: string; subtitle: string | null; description: string; icon: IconComponent }
> = {
  hotel_operations: {
    title: "Hotel Operations",
    subtitle: "PMS + Booking Engine",
    description: "Manage rooms, rates, reservations, and direct bookings.",
    icon: HotelIcon,
  },
  creator_marketplace: {
    title: "Creator Marketplace",
    subtitle: null,
    description: "Create your hotel profile and prepare a collaboration offer.",
    icon: SparklesIcon,
  },
};

const TASK_CONTENT: Record<
  SetupTaskId,
  {
    title: string;
    description: string;
  }
> = {
  shared_identity: {
    title: "Add your hotel basics",
    description: "Confirm the hotel name, type, address, timezone, and contact details.",
  },
  public_profile: {
    title: "Describe your hotel",
    description: "Add one description and cover that guests and creators will see.",
  },
  creator_offer: {
    title: "Prepare your collaboration offer",
    description: "Choose deliverables, compensation, and creator requirements.",
  },
  rooms_rates_availability: {
    title: "Add your first room type",
    description:
      "Just the basics to get started. You can add more rooms and fine-tune pricing anytime.",
  },
  guest_settings_policies: {
    title: "Review guest settings and policies",
    description: "Set check-in details, booking preferences, and cancellation terms.",
  },
  billing_plan: {
    title: "Choose your plan",
    description: "How you pay for vayada.",
  },
  payment: {
    title: "How guests can pay",
    description: "Choose which payment options to offer. You can enable multiple.",
  },
  direct_booking_publication: {
    title: "Design your booking page",
    description: "Set up the look and feel of your direct booking site.",
  },
};

type TaskStateCopy = {
  label: string;
  description: string;
  tone: "neutral" | "success" | "warning" | "danger";
};

export const INLINE_SETUP_STALE_SAVE_MESSAGE =
  "Your setup changed in another session. We refreshed the latest step—review it before saving again.";
export const INLINE_SETUP_UNSAVED_CHANGES_MESSAGE =
  "You have unsaved changes. Leave this step and discard them?";

export function canLeaveInlineSetupTask(
  hasUnsavedChanges: boolean,
  confirmDiscard: () => boolean,
): boolean {
  return !hasUnsavedChanges || confirmDiscard();
}

export function blockInlineSetupUnload(
  event: Pick<BeforeUnloadEvent, "preventDefault" | "returnValue">,
) {
  event.preventDefault();
  event.returnValue = "";
}

const BASE_PROFILE_STEP_FIELDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["displayName", "propertyType", "logo"],
  [
    "location.streetAddress",
    "location.postalCode",
    "location.city",
    "location.countryCode",
    "location.timezone",
  ],
  ["phone", "whatsapp", "contactEmail"],
];
const LAUNCH_SETTINGS_STEP_FIELDS = [
  "defaultCurrency",
  "defaultLanguage",
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
] as const;
const BASE_PROFILE_STEP_TITLES = ["About your hotel", "Location", "Contact information"] as const;
const PROFILE_STEP_FIELDS_WITH_LAUNCH: ReadonlyArray<ReadonlyArray<string>> = [
  BASE_PROFILE_STEP_FIELDS[0],
  BASE_PROFILE_STEP_FIELDS[1],
  LAUNCH_SETTINGS_STEP_FIELDS,
  BASE_PROFILE_STEP_FIELDS[2],
];
const PROFILE_STEP_TITLES_WITH_LAUNCH = [
  "About your hotel",
  "Location",
  "Guest preferences",
  "Contact information",
] as const;

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

const TIMEZONE_PICKER_OPTIONS = availableTimezones();

export default function SharedFirstRunPropertySetupWizard({
  api,
  entryProduct,
  initialPropertyId = null,
  returnTo = null,
  initialAddProperty = false,
  embedded = false,
  productLabels,
  onContinue,
  renderTaskForm,
  propertyLaunchSettingsApi,
  onPropertySelected,
  onExit,
}: SharedFirstRunPropertySetupWizardProps) {
  const labels = { ...DEFAULT_PRODUCT_LABELS, ...productLabels };
  const [status, setStatus] = useState<AdaptiveHotelSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [forceCreateProperty, setForceCreateProperty] = useState(initialAddProperty);
  const [forceTrackSelection, setForceTrackSelection] = useState(false);
  const [editPropertyProfile, setEditPropertyProfile] = useState(false);
  const [profileLoadFailed, setProfileLoadFailed] = useState(false);
  const [profileReloadToken, setProfileReloadToken] = useState(0);
  const [loadedProfile, setLoadedProfile] = useState<PropertyProfileResponse | null>(null);
  const [propertyTypeOptions, setPropertyTypeOptions] = useState<SharedPropertyTypeOption[] | null>(
    null,
  );
  const [draft, setDraft] = useState<ProfileDraft>(() => newPropertyDraft());
  const [launchSettings, setLaunchSettings] = useState<PropertyLaunchSettings>(() =>
    propertyLaunchSettingsDefaults(""),
  );
  const [launchSettingsTouched, setLaunchSettingsTouched] = useState(false);
  const [skipLaunchSettings, setSkipLaunchSettings] = useState(false);
  const [selectedTracks, setSelectedTracks] = useState<SetupTrack[]>([]);
  const [saving, setSaving] = useState(false);
  const [selectedPlanTaskId, setSelectedPlanTaskId] = useState<SetupTaskId | null>(null);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [profileStep, setProfileStep] = useState(0);
  const profileHeading = useRef<HTMLHeadingElement>(null);
  const trackCommandKey = useRef<string | null>(null);
  const createPropertyCommandKey = useRef<string | null>(null);
  const logoUploadKey = useRef<string | null>(null);
  const logoAssignmentKey = useRef<string | null>(null);
  const profileSaveInFlight = useRef(false);

  const view = useMemo(
    () =>
      resolveSharedFirstRunSetupView(status, {
        forceCreateProperty,
        forceTrackSelection,
        editPropertyProfile,
      }),
    [editPropertyProfile, forceCreateProperty, forceTrackSelection, status],
  );
  const entryContinueInput = useMemo(
    () => buildEntryContinueInput(status, returnTo),
    [returnTo, status],
  );

  useEffect(() => {
    setForceCreateProperty(initialAddProperty);
    setEditPropertyProfile(false);
  }, [initialAddProperty]);

  useEffect(() => {
    setProfileStep(0);
  }, [view.profileMode, view.selectedPropertyId]);

  useEffect(() => {
    setSelectedPlanTaskId(status?.setupPlan?.recommendedTaskId ?? null);
  }, [status?.setupPlan?.planRevision, status?.setupPlan?.recommendedTaskId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    api
      .getStatus({ entryProduct, propertyId: initialPropertyId })
      .then((nextStatus) => {
        if (cancelled) return;
        setStatus(nextStatus);
        setSelectedTracks(nextStatus.organization.selectedTracks);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(setupErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, entryProduct, initialPropertyId]);

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
        : Promise.resolve<PropertyProfileResponse | null>(null),
      propertyId
        ? api.getPublicPropertyProfile(propertyId)
        : Promise.resolve<PublicPropertyProfileResponse | null>(null),
      propertyId && propertyLaunchSettingsApi
        ? propertyLaunchSettingsApi.get(propertyId)
        : Promise.resolve<PropertyLaunchSettings | null>(null),
    ])
      .then(([catalog, nextProfile, publicProfile, existingLaunchSettings]) => {
        if (cancelled) return;
        setPropertyTypeOptions(propertyTypeOptionsFromCatalog(catalog.propertyTypes));
        setLoadedProfile(nextProfile);
        const pendingLogo =
          propertyId && typeof window !== "undefined"
            ? readPendingPropertyLogo(window.localStorage, propertyId)
            : null;
        const publicLogo = publicProfile?.publicProfile.media.find(
          ({ mediaType }) => mediaType === "logo",
        );
        if (
          propertyId &&
          pendingLogo &&
          publicLogo?.mediaObjectId === pendingLogo.mediaObjectId &&
          typeof window !== "undefined"
        ) {
          clearPendingPropertyLogo(window.localStorage, propertyId);
        }
        const unconfirmedPendingLogo =
          pendingLogo && publicLogo?.mediaObjectId !== pendingLogo.mediaObjectId
            ? pendingLogo
            : null;
        setDraft(
          nextProfile
            ? draftFromProfile(nextProfile, publicProfile, unconfirmedPendingLogo)
            : newPropertyDraft(),
        );
        setLaunchSettings(
          existingLaunchSettings ??
            propertyLaunchSettingsDefaults(nextProfile?.profile.location.countryCode ?? ""),
        );
        setLaunchSettingsTouched(Boolean(existingLaunchSettings));
        setSkipLaunchSettings(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadedProfile(null);
        setProfileLoadFailed(true);
        setError(setupErrorMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, [
    api,
    profileReloadToken,
    propertyLaunchSettingsApi,
    view.profileMode,
    view.screen,
    view.selectedPropertyId,
  ]);

  const reloadStatus = async (propertyId?: string | null) => {
    const nextStatus = await api.getStatus({ entryProduct, propertyId });
    setStatus(nextStatus);
    setSelectedTracks(nextStatus.organization.selectedTracks);
    return nextStatus;
  };

  const handleSelectProperty = async (propertyId: string) => {
    setError("");
    setForceCreateProperty(false);
    setEditPropertyProfile(false);
    setLoading(true);
    try {
      await reloadStatus(propertyId);
      await onPropertySelected?.(propertyId);
    } catch (err) {
      setError(setupErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfile = async () => {
    if (profileSaveInFlight.current) return;
    setError("");
    setFieldErrors({});
    const nextFieldErrors = validateProfileDraft(draft);
    if (propertyLaunchSettingsApi && !skipLaunchSettings) {
      Object.assign(nextFieldErrors, validatePropertyLaunchSettings(launchSettings));
    }
    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors);
      return;
    }

    profileSaveInFlight.current = true;
    setSaving(true);
    try {
      if (view.profileMode === "update" && !loadedProfile) {
        setError("The existing property profile could not be loaded.");
        return;
      }
      let saved: PropertyProfileResponse;
      if (view.profileMode === "update" && view.selectedPropertyId && loadedProfile) {
        const update = profileUpdateFromDraft(draft, loadedProfile);
        saved = update
          ? await api.updatePropertyProfile(view.selectedPropertyId, update)
          : loadedProfile;
      } else if (loadedProfile) {
        saved = loadedProfile;
      } else {
        const profile = createProfileFromDraft(draft);
        const idempotencyKey = (createPropertyCommandKey.current = idempotencyKeyForRetry(
          createPropertyCommandKey.current,
        ));
        try {
          saved = await api.createPropertyProfile(profile, idempotencyKey);
        } catch (createError) {
          const code = setupErrorCode(createError);
          if (code !== "idempotency_key_conflict" && code !== "command_in_progress") {
            throw createError;
          }

          const createdPropertyId = setupErrorPropertyId(createError);
          if (!createdPropertyId) throw createError;
          saved = await api.getPropertyProfile(createdPropertyId);
          const recoveredUpdate = profileUpdateFromDraft(draft, saved);
          if (recoveredUpdate) {
            saved = await api.updatePropertyProfile(createdPropertyId, recoveredUpdate);
          }
        }
      }
      setLoadedProfile(saved);
      saved = await savePropertyLogo({
        api,
        draft,
        profile: saved,
        uploadKey: logoUploadKey,
        assignmentKey: logoAssignmentKey,
      });
      setLoadedProfile(saved);
      if (propertyLaunchSettingsApi && !skipLaunchSettings) {
        await propertyLaunchSettingsApi.update(
          saved.propertyId,
          normalizedPropertyLaunchSettings(launchSettings),
        );
      }
      setForceCreateProperty(false);
      setEditPropertyProfile(false);
      await reloadStatus(saved.propertyId);
      if (view.profileMode === "create") {
        await onPropertySelected?.(saved.propertyId);
      }
      createPropertyCommandKey.current = null;
      logoUploadKey.current = null;
      logoAssignmentKey.current = null;
    } catch (err) {
      if (
        setupErrorCode(err) === "profile_revision_conflict" &&
        view.profileMode === "update" &&
        view.selectedPropertyId
      ) {
        try {
          const latestProfile = await api.getPropertyProfile(view.selectedPropertyId);
          setLoadedProfile(latestProfile);
          setError(
            "These hotel details changed in another session. We refreshed the latest version—review your entries and save again.",
          );
        } catch (refreshError) {
          setError(setupErrorMessage(refreshError));
        }
      } else {
        setFieldErrors(fieldErrorsFromError(err));
        setError(setupErrorMessage(err));
      }
    } finally {
      profileSaveInFlight.current = false;
      setSaving(false);
    }
  };

  const handleSaveTracks = async () => {
    if (!status || selectedTracks.length === 0 || !status.organization.canManageTracks) return;
    setError("");
    setSaving(true);
    try {
      await api.updateTracks(
        {
          selectedTracks,
          expectedRevision: status.organization.trackRevision,
        },
        (trackCommandKey.current = idempotencyKeyForRetry(trackCommandKey.current)),
      );
      setForceTrackSelection(false);
      await reloadStatus(status.propertySelection.selectedPropertyId);
      trackCommandKey.current = null;
    } catch (err) {
      if (setupErrorCode(err) === "track_revision_conflict") {
        try {
          const latestStatus = await api.getStatus({
            entryProduct,
            propertyId: status.propertySelection.selectedPropertyId,
          });
          setStatus(latestStatus);
          trackCommandKey.current = null;
          if (sameTrackSelection(selectedTracks, latestStatus.organization.selectedTracks)) {
            setSelectedTracks(latestStatus.organization.selectedTracks);
            setForceTrackSelection(false);
          } else {
            setSelectedTracks(
              mergeTrackSelectionAfterConflict(
                selectedTracks,
                latestStatus.organization.selectedTracks,
              ),
            );
            setError(
              "Your hotel group’s services changed in another session. We refreshed them—review your selection and continue.",
            );
          }
        } catch (refreshError) {
          setError(setupErrorMessage(refreshError));
        }
      } else {
        setError(setupErrorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCompleteTask = async (task: SetupTask) => {
    setError("");
    try {
      const nextStatus = await reloadStatus(task.propertyId);
      setSelectedPlanTaskId(recommendedInlineSetupTaskId(nextStatus));
    } catch (err) {
      setError(setupErrorMessage(err));
      throw err;
    }
  };

  const handleBeforeSaveTask = async (task: SetupTask, planRevision: string) => {
    setError("");
    try {
      const nextStatus = await reloadStatus(task.propertyId);
      if (
        isInlineSetupTaskSaveCurrent(nextStatus, {
          propertyId: task.propertyId,
          taskId: task.taskId,
          planRevision,
        })
      ) {
        return;
      }

      setSelectedPlanTaskId(recommendedInlineSetupTaskId(nextStatus));
      setError(INLINE_SETUP_STALE_SAVE_MESSAGE);
      throw new Error(INLINE_SETUP_STALE_SAVE_MESSAGE);
    } catch (err) {
      if (setupErrorMessage(err) !== INLINE_SETUP_STALE_SAVE_MESSAGE) {
        setError(setupErrorMessage(err));
      }
      throw err;
    }
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
      title={view.title}
      view={view}
      embedded={embedded}
      mapFirst={view.screen === "property_profile" && profileStep === 1}
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
          properties={status.propertySelection.availableProperties}
          onSelect={handleSelectProperty}
          onAdd={() => {
            setDraft(newPropertyDraft());
            setLaunchSettings(propertyLaunchSettingsDefaults(""));
            setLaunchSettingsTouched(false);
            setSkipLaunchSettings(false);
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
          embedded={embedded}
          loading={!propertyTypeOptions}
          saving={saving}
          fieldErrors={fieldErrors}
          launchSettings={propertyLaunchSettingsApi ? launchSettings : null}
          skipLaunchSettings={skipLaunchSettings}
          launchSettingsTouched={launchSettingsTouched}
          propertyTypeOptions={propertyTypeOptions ?? []}
          pageHeadingRef={profileHeading}
          onChange={(nextDraft) => {
            if (view.profileMode === "create") createPropertyCommandKey.current = null;
            if (nextDraft.logoFile !== draft.logoFile) {
              logoUploadKey.current = null;
              logoAssignmentKey.current = null;
            }
            setDraft(nextDraft);
          }}
          onFieldErrors={setFieldErrors}
          onLaunchSettingsChange={(nextSettings) => {
            setLaunchSettings(nextSettings);
            setLaunchSettingsTouched(true);
            setSkipLaunchSettings(false);
          }}
          onPrepareLaunchSettings={(countryCode) => {
            if (!launchSettingsTouched) {
              setLaunchSettings(propertyLaunchSettingsDefaults(countryCode));
            }
          }}
          onConfirmLaunchSettings={() => setSkipLaunchSettings(false)}
          onSkipLaunchSettings={() => setSkipLaunchSettings(true)}
          onStepChange={setProfileStep}
          onCancel={
            editPropertyProfile
              ? () => setEditPropertyProfile(false)
              : status.propertySelection.availableProperties.length > 0 &&
                  view.profileMode === "create"
                ? () => setForceCreateProperty(false)
                : undefined
          }
          cancelLabel={editPropertyProfile ? "Back to setup" : undefined}
          onSave={handleSaveProfile}
        />
      )}

      {view.screen === "track_selection" && (
        <TrackSelection
          selectedTracks={selectedTracks}
          lockedTracks={status.organization.selectedTracks}
          canManageTracks={status.organization.canManageTracks}
          saving={saving}
          onToggle={(track) => {
            trackCommandKey.current = null;
            setSelectedTracks((current) =>
              toggleSetupTrackSelection(current, status.organization.selectedTracks, track),
            );
          }}
          onSave={handleSaveTracks}
          onCancel={
            status.organization.selectedTracks.length > 0
              ? () => {
                  setSelectedTracks(status.organization.selectedTracks);
                  setForceTrackSelection(false);
                }
              : undefined
          }
        />
      )}

      {view.screen === "setup_plan" && (
        <SetupPlan
          status={status}
          labels={labels}
          renderTaskForm={renderTaskForm}
          onCompleteTask={handleCompleteTask}
          onBeforeSaveTask={handleBeforeSaveTask}
          selectedTaskId={selectedPlanTaskId}
          onSelectTask={setSelectedPlanTaskId}
          onEditHotelBasics={() => setEditPropertyProfile(true)}
          onExit={onExit ? () => onExit(view.selectedPropertyId) : undefined}
          onEnterProduct={entryContinueInput ? () => onContinue(entryContinueInput) : undefined}
          onAddTrack={
            status.organization.selectedTracks.length < 2 && status.organization.canManageTracks
              ? () => setForceTrackSelection(true)
              : undefined
          }
        />
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
}: {
  children?: React.ReactNode;
  title: string;
  view: SharedFirstRunSetupViewModel;
  headingRef?: RefObject<HTMLHeadingElement>;
  loading?: boolean;
  embedded?: boolean;
  mapFirst?: boolean;
}) {
  const progress =
    view.screen === "track_selection"
      ? 1
      : view.screen === "property_selection" || view.screen === "property_profile"
        ? 2
        : 3;
  const subtitle =
    view.screen === "track_selection"
      ? "Choose one or both. Your selection applies to every hotel in this group."
      : view.screen === "property_selection"
        ? "Pick an existing property or add a new one to this hotel group."
        : view.screen === "property_profile"
          ? null
          : "Complete one guided step at a time. We only include tasks for the services you selected.";
  const isProfileScreen = view.screen === "property_profile";
  const isSetupPlan = view.screen === "setup_plan";
  const useWideSetupLayout = view.screen === "track_selection" || view.screen === "setup_plan";

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
              {view.screen !== "setup_plan" && (
                <span className="w-fit rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
                  Step {progress} of 3
                </span>
              )}
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
      className={`flex min-h-[100dvh] text-gray-900 ${
        mapFirst ? "" : `${isSetupPlan ? "items-start" : "items-center"} px-4 py-6 sm:px-6 lg:px-8`
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
        {!mapFirst && !isSetupPlan && (
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
              <ArrowRightIcon className="h-4 w-4 text-gray-400" aria-hidden="true" />
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
  launchSettings,
  skipLaunchSettings,
  launchSettingsTouched,
  step,
  mode,
  embedded,
  loading,
  saving,
  fieldErrors,
  propertyTypeOptions,
  pageHeadingRef,
  onChange,
  onLaunchSettingsChange,
  onPrepareLaunchSettings,
  onConfirmLaunchSettings,
  onSkipLaunchSettings,
  onFieldErrors,
  onStepChange,
  onCancel,
  cancelLabel = "Back to properties",
  onSave,
}: {
  draft: ProfileDraft;
  launchSettings: PropertyLaunchSettings | null;
  skipLaunchSettings: boolean;
  launchSettingsTouched: boolean;
  step: number;
  mode: "create" | "update";
  embedded: boolean;
  loading: boolean;
  saving: boolean;
  fieldErrors: Record<string, string[]>;
  propertyTypeOptions: SharedPropertyTypeOption[];
  pageHeadingRef: RefObject<HTMLHeadingElement>;
  onChange: (draft: ProfileDraft) => void;
  onLaunchSettingsChange: (settings: PropertyLaunchSettings) => void;
  onPrepareLaunchSettings: (countryCode: string) => void;
  onConfirmLaunchSettings: () => void;
  onSkipLaunchSettings: () => void;
  onFieldErrors: (errors: Record<string, string[]>) => void;
  onStepChange: (step: number) => void;
  onCancel?: () => void;
  cancelLabel?: string;
  onSave: () => void;
}) {
  const profileStepFields = launchSettings
    ? PROFILE_STEP_FIELDS_WITH_LAUNCH
    : BASE_PROFILE_STEP_FIELDS;
  const profileStepTitles = launchSettings
    ? PROFILE_STEP_TITLES_WITH_LAUNCH
    : BASE_PROFILE_STEP_TITLES;
  const contactStep = launchSettings ? 3 : 2;
  const finalStep = profileStepFields.length - 1;
  const googleMapsApiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim();
  const LocationHeading = embedded ? "h2" : "h1";
  const [showAddressFields, setShowAddressFields] = useState(
    () =>
      !googleMapsApiKey ||
      (mode === "update" && !(canConfirmLocation(draft) && hasMapCoordinates(draft))),
  );
  const [addressSearchUnavailable, setAddressSearchUnavailable] = useState(false);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState(draft.logoPublicUrl);
  const addressRevision = useRef(0);
  const addressFields = useRef<HTMLDivElement>(null);
  const addressFieldsId = useId();
  const addressFieldsWereLoading = useRef(loading);
  const editAddressButton = useRef<HTMLButtonElement>(null);
  const focusAddressFieldsWhenShown = useRef(false);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const timezoneWasAutoDetected = useRef(false);
  const [whatsappFollowsPhone, setWhatsappFollowsPhone] = useState(
    () => !draft.whatsapp || draft.whatsapp === draft.phone,
  );

  useEffect(() => {
    const errorStep = profileStepFields.findIndex((fields) =>
      fields.some((field) => fieldErrors[field]),
    );
    if (errorStep >= 0 && errorStep !== step) {
      onStepChange(errorStep);
      requestAnimationFrame(() =>
        (errorStep === 1 ? pageHeadingRef.current : stepHeading.current)?.focus(),
      );
    }
  }, [fieldErrors, onStepChange, pageHeadingRef, profileStepFields, step]);

  useEffect(() => {
    if (BASE_PROFILE_STEP_FIELDS[1].some((field) => fieldErrors[field])) {
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

  useEffect(() => {
    if (!draft.logoFile) {
      setLogoPreviewUrl(draft.logoPublicUrl);
      return;
    }
    const previewUrl = URL.createObjectURL(draft.logoFile);
    setLogoPreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [draft.logoFile, draft.logoPublicUrl]);

  useEffect(() => {
    if (
      step === contactStep &&
      whatsappFollowsPhone &&
      draft.phone &&
      draft.whatsapp !== draft.phone
    ) {
      onChange({ ...draft, whatsapp: draft.phone });
    }
  }, [contactStep, draft, onChange, step, whatsappFollowsPhone]);

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
    if (field === "timezone") timezoneWasAutoDetected.current = false;
    onChange({
      ...draft,
      [field]: value,
      ...(timezoneWasAutoDetected.current && "latitude" in locationReset
        ? { timezone: defaultTimezoneForCountry(draft.countryCode) }
        : {}),
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
    const currentFields = new Set(profileStepFields[step]);
    const allErrors = {
      ...validateProfileDraft(draft),
      ...(launchSettings && (step === 2 || !skipLaunchSettings)
        ? validatePropertyLaunchSettings(launchSettings)
        : {}),
    };
    const currentErrors = Object.fromEntries(
      Object.entries(allErrors).filter(([field]) => currentFields.has(field)),
    );
    onFieldErrors(currentErrors);
    if (Object.keys(currentErrors).length === 0) {
      if (step === 1 && launchSettings && mode === "create" && !launchSettingsTouched) {
        onPrepareLaunchSettings(draft.countryCode);
      }
      if (step === 2 && launchSettings) onConfirmLaunchSettings();
      changeStep(step + 1);
    }
  };
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
        Step {step + 1} of {profileStepFields.length}
        {step !== 1 && ` · ${profileStepTitles[step]}`}
      </p>
      <ol
        className={`grid w-full ${step === 1 ? "max-w-10 gap-1" : "max-w-[12rem] gap-2"}`}
        style={{ gridTemplateColumns: `repeat(${profileStepTitles.length}, minmax(0, 1fr))` }}
        aria-label="Hotel setup progress"
      >
        {profileStepTitles.map((title, index) => {
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
          {step > 0 ? "Back" : cancelLabel}
        </button>
      )}
      <button
        type="submit"
        disabled={step === finalStep && saving}
        className={`inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto ${
          step === 1 ? "sm:min-w-32" : ""
        }`}
      >
        {step === finalStep && saving && (
          <span
            className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
            aria-hidden="true"
          />
        )}
        <span>
          {step === finalStep ? (saving ? "Saving..." : "Save and continue") : "Continue"}
        </span>
        {!(step === finalStep && saving) && (
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
        if (step === finalStep) onSave();
        else continueToNextStep();
      }}
      className={`mx-auto ${step === 1 ? "max-w-none" : "max-w-7xl space-y-8"}`}
    >
      {step !== 1 && profileProgress}

      <section
        aria-busy={saving}
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
              required
              error={fieldErrors.propertyType?.[0]}
              options={visiblePropertyTypeOptions}
              onChange={(value) => setField("propertyType", value)}
            />
            <PropertyLogoField
              previewUrl={logoPreviewUrl}
              pending={Boolean(draft.logoMediaObjectId && !draft.logoPublicUrl && !draft.logoFile)}
              error={fieldErrors.logo?.[0]}
              onChange={(file) => {
                const validationError = sharedPropertyLogoError(file);
                if (validationError) {
                  onFieldErrors({ ...fieldErrors, logo: [validationError] });
                  return;
                }
                const { logo: _logoError, ...remainingErrors } = fieldErrors;
                onFieldErrors(remainingErrors);
                onChange({
                  ...draft,
                  logoFile: file,
                  logoMediaObjectId: null,
                  logoPublicUrl: "",
                });
              }}
            />
          </div>
        </div>
        <aside className="hidden min-h-[32rem] items-center justify-center p-8 xl:flex">
          <HotelFacadeIllustration />
        </aside>
      </section>

      <section aria-busy={saving} className={step === contactStep ? "block" : "hidden"}>
        <div className="mx-auto max-w-3xl rounded-[2rem] bg-white p-5 text-left shadow-[0_30px_90px_-50px_rgba(15,23,42,0.45)] sm:p-8">
          <div className="mb-4">
            <h3
              ref={step === contactStep ? stepHeading : undefined}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight text-gray-950 outline-none"
            >
              How can guests reach you?
            </h3>
            <p className="mt-2 text-sm text-gray-500">
              This information is shown when guests click &apos;Contact&apos; on your booking page.
            </p>
          </div>
          <div className="space-y-4">
            <PhoneField
              label="Phone number"
              value={draft.phone}
              countryCode={draft.countryCode}
              placeholder="+94 77 123 4567"
              required
              error={fieldErrors.phone?.[0]}
              onChange={(value) =>
                onChange({
                  ...draft,
                  phone: value,
                  whatsapp: whatsappFollowsPhone ? value : draft.whatsapp,
                })
              }
            />
            <PhoneField
              label="WhatsApp number"
              value={draft.whatsapp}
              countryCode={draft.countryCode}
              placeholder="Same as phone or a different number."
              helper="Leave blank if you don't use WhatsApp."
              error={fieldErrors.whatsapp?.[0]}
              onChange={(value) => {
                setWhatsappFollowsPhone(value === draft.phone && Boolean(value));
                setField("whatsapp", value);
              }}
            />
            <TextField
              label="Email"
              value={draft.contactEmail}
              placeholder="hello@yourhotel.com"
              type="email"
              required
              error={fieldErrors.contactEmail?.[0]}
              onChange={(value) => setField("contactEmail", value)}
            />
          </div>
        </div>
      </section>

      {launchSettings && (
        <section aria-busy={saving} className={step === 2 ? "block" : "hidden"}>
          <div className="mx-auto max-w-4xl rounded-[2rem] bg-white p-5 text-left shadow-[0_30px_90px_-50px_rgba(15,23,42,0.45)] sm:p-8">
            <div className="mb-6">
              <h3
                ref={step === 2 ? stepHeading : undefined}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight text-gray-950 outline-none"
              >
                Set up guest preferences
              </h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
                We suggested a currency and language from your location. You can change these now or
                later in Booking settings.
              </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="space-y-5 rounded-2xl border border-gray-100 p-4 sm:p-5">
                <SelectField
                  label="Default currency"
                  value={launchSettings.defaultCurrency}
                  placeholder="Select a currency"
                  required
                  error={fieldErrors.defaultCurrency?.[0]}
                  options={CURRENCY_OPTIONS.map((option) => ({
                    value: option.code,
                    label: `${option.flag} ${option.code} · ${option.name}`,
                  }))}
                  onChange={(defaultCurrency) =>
                    onLaunchSettingsChange({
                      ...launchSettings,
                      defaultCurrency,
                      supportedCurrencies: launchSettings.supportedCurrencies.filter(
                        (code) => code !== defaultCurrency,
                      ),
                    })
                  }
                />
                <div>
                  <label
                    htmlFor="hotel-setup-additional-currencies"
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700"
                  >
                    <span>Additional currencies</span>
                    <span aria-hidden="true" className="text-xs text-gray-400">
                      Optional
                    </span>
                  </label>
                  <p className="mt-1 text-xs text-gray-500">
                    Guests can view prices in these currencies.
                  </p>
                  <div className="mt-3">
                    <LocalizationMultiSelect
                      id="hotel-setup-additional-currencies"
                      selected={launchSettings.supportedCurrencies}
                      onToggle={(code) =>
                        onLaunchSettingsChange({
                          ...launchSettings,
                          supportedCurrencies: launchSettings.supportedCurrencies.includes(code)
                            ? launchSettings.supportedCurrencies.filter((value) => value !== code)
                            : [...launchSettings.supportedCurrencies, code],
                        })
                      }
                      options={CURRENCY_OPTIONS}
                      excludeCode={launchSettings.defaultCurrency}
                      placeholder={`Search currencies, e.g. "Dollar" or "USD"...`}
                      getLabel={(option) => option.code}
                      getSearchLabel={(option) => `${option.name} · ${option.code}`}
                      popularCodes={POPULAR_CURRENCY_CODES}
                      emptyMessage={`No additional currencies added — your booking page will show only ${launchSettings.defaultCurrency}`}
                      comfortable
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-5 rounded-2xl border border-gray-100 p-4 sm:p-5">
                <SelectField
                  label="Default language"
                  value={launchSettings.defaultLanguage}
                  placeholder="Select a language"
                  required
                  error={fieldErrors.defaultLanguage?.[0]}
                  options={LANGUAGE_OPTIONS.map((option) => ({
                    value: option.code,
                    label: `${option.flag} ${option.name} · ${option.nativeName}`,
                  }))}
                  onChange={(defaultLanguage) =>
                    onLaunchSettingsChange({
                      ...launchSettings,
                      defaultLanguage,
                      supportedLanguages: launchSettings.supportedLanguages.filter(
                        (code) => code !== defaultLanguage,
                      ),
                    })
                  }
                />
                <div>
                  <label
                    htmlFor="hotel-setup-additional-languages"
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-700"
                  >
                    <span>Additional languages</span>
                    <span aria-hidden="true" className="text-xs text-gray-400">
                      Optional
                    </span>
                  </label>
                  <p className="mt-1 text-xs text-gray-500">
                    Add languages you can support for international guests.
                  </p>
                  <div className="mt-3">
                    <LocalizationMultiSelect
                      id="hotel-setup-additional-languages"
                      selected={launchSettings.supportedLanguages}
                      onToggle={(code) =>
                        onLaunchSettingsChange({
                          ...launchSettings,
                          supportedLanguages: launchSettings.supportedLanguages.includes(code)
                            ? launchSettings.supportedLanguages.filter((value) => value !== code)
                            : [...launchSettings.supportedLanguages, code],
                        })
                      }
                      options={LANGUAGE_OPTIONS}
                      excludeCode={launchSettings.defaultLanguage}
                      placeholder={`Search languages, e.g. "German" or "Deutsch"...`}
                      getLabel={(option) => option.nativeName}
                      getSearchLabel={(option) => `${option.name} · ${option.nativeName}`}
                      popularCodes={POPULAR_LANGUAGE_CODES}
                      emptyMessage={`No additional languages added — your booking page will show only ${launchSettings.defaultLanguage.toUpperCase()}`}
                      comfortable
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 rounded-2xl border border-gray-100 p-4 sm:p-5">
              <h4 className="text-base font-semibold text-gray-950">Social media</h4>
              <p className="mt-1 text-sm text-gray-500">
                Optional links help guests and creators discover your hotel.
              </p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {(
                  [
                    ["instagram", "Instagram", "https://instagram.com/yourhotel"],
                    ["facebook", "Facebook", "https://facebook.com/yourhotel"],
                    ["tiktok", "TikTok", "https://tiktok.com/@yourhotel"],
                    ["youtube", "YouTube", "https://youtube.com/@yourhotel"],
                  ] as const
                ).map(([field, label, placeholder]) => (
                  <TextField
                    key={field}
                    label={label}
                    value={launchSettings[field]}
                    placeholder={placeholder}
                    type="url"
                    error={fieldErrors[field]?.[0]}
                    onChange={(value) =>
                      onLaunchSettingsChange({ ...launchSettings, [field]: value })
                    }
                  />
                ))}
              </div>
              <p className="mt-4 text-xs leading-5 text-gray-500">
                You can add, remove, or update these links later in Booking settings.
              </p>
            </div>

            <div className="mt-6 text-center">
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  onSkipLaunchSettings();
                  changeStep(3);
                }}
                className="text-sm font-semibold text-gray-600 underline decoration-gray-300 underline-offset-4 transition hover:text-gray-950 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Skip for now, configure later
              </button>
            </div>
          </div>
        </section>
      )}

      <section aria-busy={saving} className={step === 1 ? "block" : "hidden"}>
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
                      const timezone =
                        typeof address.latitude === "number" &&
                        typeof address.longitude === "number"
                          ? timezoneForCoordinates(address.latitude, address.longitude)
                          : defaultTimezoneForCountry(address.countryCode);
                      timezoneWasAutoDetected.current = true;
                      const nextDraft = { ...draft, ...address, timezone };
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
                        required
                        error={fieldErrors["location.streetAddress"]?.[0]}
                        onChange={(value) => setField("streetAddress", value)}
                      />
                      <TextField
                        label="Postal code"
                        value={draft.postalCode}
                        placeholder="80331"
                        required
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
                        onChange={(value) => {
                          addressRevision.current += 1;
                          timezoneWasAutoDetected.current = true;
                          onChange({
                            ...draft,
                            countryCode: value,
                            timezone: defaultTimezoneForCountry(value),
                            ...locationResetForManualAddressEdit("countryCode"),
                          });
                        }}
                      />
                      <TimezoneField
                        value={draft.timezone}
                        error={fieldErrors["location.timezone"]?.[0]}
                        options={TIMEZONE_PICKER_OPTIONS}
                        onChange={(value) => setField("timezone", value)}
                      />
                    </div>
                  </div>
                )}
                <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3 text-left">
                  <input
                    type="checkbox"
                    checked={draft.localityPublic}
                    onChange={(event) =>
                      onChange({ ...draft, localityPublic: event.target.checked })
                    }
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-gray-900">
                      Show city and country publicly
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-gray-600">
                      Street address, postal code, and map coordinates stay private.
                    </span>
                  </span>
                </label>
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

function TrackSelection({
  selectedTracks,
  lockedTracks,
  canManageTracks,
  saving,
  onToggle,
  onSave,
  onCancel,
}: {
  selectedTracks: SetupTrack[];
  lockedTracks: SetupTrack[];
  canManageTracks: boolean;
  saving: boolean;
  onToggle: (track: SetupTrack) => void;
  onSave: () => void;
  onCancel?: () => void;
}) {
  const needsSelection = selectedTracks.length === 0;

  return (
    <section className="mx-auto max-w-5xl">
      <div className="grid gap-5 md:grid-cols-2">
        {(["hotel_operations", "creator_marketplace"] as const).map((track) => {
          const content = TRACK_CONTENT[track];
          const checked = selectedTracks.includes(track);
          const locked = lockedTracks.includes(track);
          const disabled = locked || !canManageTracks;
          const Icon = content.icon;
          return (
            <label
              key={track}
              className={`flex min-h-64 flex-col rounded-3xl bg-white p-6 text-left shadow-sm transition focus-within:outline-none focus-within:ring-2 focus-within:ring-primary-600 focus-within:ring-offset-2 ${
                disabled
                  ? "cursor-not-allowed ring-1 ring-gray-200"
                  : checked
                    ? "cursor-pointer ring-2 ring-primary-500"
                    : "cursor-pointer ring-1 ring-gray-200 hover:ring-primary-200"
              }`}
            >
              <span className="flex items-start justify-between gap-4">
                <span
                  className={`flex h-12 w-12 items-center justify-center rounded-2xl ${
                    checked ? "bg-primary-600 text-white" : "bg-primary-50 text-primary-700"
                  }`}
                >
                  <Icon className="h-6 w-6" aria-hidden="true" />
                </span>
                <input
                  type="checkbox"
                  className="sr-only"
                  aria-label={content.title}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggle(track)}
                />
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${
                    checked
                      ? "border-primary-600 bg-primary-600 text-white"
                      : "border-gray-300 text-transparent"
                  }`}
                  aria-hidden="true"
                >
                  <CheckIcon className="h-3.5 w-3.5" />
                </span>
              </span>
              <span className="mt-5 text-xl font-semibold text-gray-950">{content.title}</span>
              {content.subtitle && (
                <span className="mt-1 text-sm font-semibold text-primary-700">
                  {content.subtitle}
                </span>
              )}
              <span className="mt-3 text-sm leading-6 text-gray-600">{content.description}</span>
              {locked && (
                <span className="mt-auto pt-5 text-xs font-medium text-gray-500">
                  Already added. Remove or change this service from service management.
                </span>
              )}
            </label>
          );
        })}
      </div>

      {!canManageTracks && (
        <div
          className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center text-sm text-amber-900"
          role="status"
        >
          Ask a hotel group owner to choose or add Vayada services.
        </div>
      )}

      <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-full px-6 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-60"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          disabled={saving || needsSelection || !canManageTracks}
          onClick={onSave}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-500 disabled:hover:bg-gray-200 sm:w-auto"
        >
          {saving && (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
              aria-hidden="true"
            />
          )}
          <span>{saving ? "Saving..." : "Continue"}</span>
          {!saving && <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
    </section>
  );
}

type InlineSetupTaskCandidate = Pick<
  SetupTask,
  "taskId" | "track" | "readiness" | "callerCapability"
>;

export function isInlineSetupTaskEditable(
  task: Pick<SetupTask, "taskId" | "track" | "readiness" | "callerCapability">,
): boolean {
  if (task.taskId === "shared_identity") {
    return (
      task.callerCapability === "allowed" &&
      (task.readiness === "actionable" || task.readiness === "complete")
    );
  }
  return (
    isSetupTaskActionable(task) ||
    (task.readiness === "complete" && task.callerCapability === "allowed")
  );
}

export function isInlineSetupTaskSelectable(
  task: InlineSetupTaskCandidate,
  recommendedTaskId: SetupTaskId | null,
): boolean {
  if (!isInlineSetupTaskEditable(task)) return false;
  return task.taskId === recommendedTaskId || task.readiness === "complete";
}

export function previousEditableSetupTaskId(
  tasks: readonly InlineSetupTaskCandidate[],
  currentTaskId: SetupTaskId,
): SetupTaskId | null {
  const currentIndex = tasks.findIndex(({ taskId }) => taskId === currentTaskId);
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const task = tasks[index];
    if (task && isInlineSetupTaskEditable(task)) return task.taskId;
  }
  return null;
}

export function recommendedInlineSetupTaskId(status: AdaptiveHotelSetupStatus): SetupTaskId | null {
  const plan = status.setupPlan;
  if (!plan?.recommendedTaskId) return null;
  const recommendedTask = plan.tasks.find(({ taskId }) => taskId === plan.recommendedTaskId);
  return recommendedTask &&
    recommendedTask.taskId !== "shared_identity" &&
    isInlineSetupTaskEditable(recommendedTask)
    ? recommendedTask.taskId
    : null;
}

export function isInlineSetupTaskSaveCurrent(
  status: AdaptiveHotelSetupStatus,
  expected: {
    propertyId: string;
    taskId: SetupTaskId;
    planRevision: string;
  },
): boolean {
  const plan = status.setupPlan;
  if (
    !plan ||
    plan.propertyId !== expected.propertyId ||
    plan.planRevision !== expected.planRevision
  ) {
    return false;
  }
  const task = plan.tasks.find(({ taskId }) => taskId === expected.taskId);
  return Boolean(
    task &&
    task.taskId !== "shared_identity" &&
    isInlineSetupTaskSelectable(task, plan.recommendedTaskId),
  );
}

function SetupPlan({
  status,
  labels,
  renderTaskForm,
  onCompleteTask,
  onBeforeSaveTask,
  selectedTaskId,
  onSelectTask,
  onEditHotelBasics,
  onExit,
  onEnterProduct,
  onAddTrack,
}: {
  status: AdaptiveHotelSetupStatus;
  labels: ProductLabels;
  renderTaskForm: (context: SharedSetupTaskFormContext) => ReactNode;
  onCompleteTask: (task: SetupTask) => Promise<void>;
  onBeforeSaveTask: (task: SetupTask, planRevision: string) => Promise<void>;
  selectedTaskId: SetupTaskId | null;
  onSelectTask: (taskId: SetupTaskId | null) => void;
  onEditHotelBasics: () => void;
  onExit?: () => void;
  onEnterProduct?: () => void;
  onAddTrack?: () => void;
}) {
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => blockInlineSetupUnload(event);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const plan = status.setupPlan;
  if (!plan) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Choose a hotel to see its setup plan.
      </div>
    );
  }

  const entryDecision = status.entryDecision;
  const requestedProduct = entryDecision?.requestedProduct;
  const recommendedTask = plan.recommendedTaskId
    ? (plan.tasks.find(
        (task) =>
          task.taskId === plan.recommendedTaskId &&
          task.taskId !== "shared_identity" &&
          isInlineSetupTaskEditable(task),
      ) ?? null)
    : null;
  const selectedTask = selectedTaskId
    ? (plan.tasks.find(
        (task) =>
          task.taskId === selectedTaskId &&
          task.taskId !== "shared_identity" &&
          isInlineSetupTaskSelectable(task, plan.recommendedTaskId),
      ) ?? null)
    : null;
  const currentTask = selectedTask ?? recommendedTask;
  const attentionTask =
    currentTask === null && plan.ownerProgress.complete < plan.ownerProgress.total
      ? (plan.tasks.find(({ ownerProgress }) => ownerProgress !== "owner_complete") ?? null)
      : null;
  const activeTask = currentTask ?? attentionTask;
  const currentTaskIndex = activeTask
    ? plan.tasks.findIndex(({ taskId }) => taskId === activeTask.taskId)
    : -1;
  const reviewActive = activeTask === null;
  const totalSteps = plan.tasks.length + 1;
  const currentStepNumber = reviewActive ? totalSteps : currentTaskIndex + 1;
  const previousTaskId = activeTask
    ? previousEditableSetupTaskId(plan.tasks, activeTask.taskId)
    : null;
  const reviewBackTaskId = reviewActive
    ? ([...plan.tasks].reverse().find((task) => isInlineSetupTaskEditable(task))?.taskId ?? null)
    : null;
  const navigateFromTask = (navigate: () => void) => {
    if (
      !canLeaveInlineSetupTask(hasUnsavedChanges, () =>
        window.confirm(INLINE_SETUP_UNSAVED_CHANGES_MESSAGE),
      )
    ) {
      return;
    }
    setHasUnsavedChanges(false);
    navigate();
  };
  const selectTask = (taskId: SetupTaskId) => {
    navigateFromTask(() => {
      if (taskId === "shared_identity") {
        onEditHotelBasics();
        return;
      }
      onSelectTask(taskId);
    });
  };
  const currentStepTitle = activeTask
    ? TASK_CONTENT[activeTask.taskId].title
    : "Review and next steps";
  const canReturnToReview =
    plan.ownerProgress.complete === plan.ownerProgress.total &&
    recommendedTask === null &&
    selectedTask?.readiness === "complete";
  const showReviewAddTrackHelp =
    !onAddTrack &&
    status.organization.selectedTracks.length < 2 &&
    !status.organization.canManageTracks;

  return (
    <section className="mx-auto max-w-5xl">
      <div className="mb-3 flex justify-center">
        <img src="/vayada-logo.png" alt="vayada" width={120} height={40} className="h-7 w-auto" />
      </div>
      <div className="relative mx-auto mb-10 w-full" data-testid="hotel-setup-progress">
        <div className="mx-auto w-full max-w-xl">
          <div
            className={`flex items-center ${
              onExit ? "justify-between sm:justify-center" : "justify-center"
            }`}
          >
            <p className="text-xs font-semibold text-gray-500">
              Step {currentStepNumber} of {totalSteps}
            </p>
            {onExit && (
              <button
                type="button"
                onClick={() => navigateFromTask(onExit)}
                className="text-xs font-semibold text-gray-500 transition hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 sm:absolute sm:right-0 sm:top-0 sm:text-sm"
              >
                Exit setup
              </button>
            )}
          </div>
          <div
            className="mt-3 flex w-full gap-2"
            role="progressbar"
            aria-label="Hotel setup progress"
            aria-valuemin={1}
            aria-valuemax={totalSteps}
            aria-valuenow={currentStepNumber}
            aria-valuetext={`Step ${currentStepNumber} of ${totalSteps}: ${currentStepTitle}`}
          >
            {Array.from({ length: totalSteps }, (_, index) => {
              const reached = index < currentStepNumber;
              return (
                <span
                  key={index}
                  className={`h-2 flex-1 rounded-full transition-colors duration-300 motion-reduce:transition-none ${
                    reached ? "bg-primary-600" : "bg-primary-100"
                  }`}
                  data-state={reached ? "reached" : "upcoming"}
                  aria-hidden="true"
                />
              );
            })}
          </div>
        </div>
      </div>

      {entryDecision?.decision === "unavailable" && requestedProduct && (
        <div
          className="mb-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          role="alert"
        >
          {labels[requestedProduct]} is not available for this hotel right now. You can continue any
          setup task below or ask an owner or support for help.
        </div>
      )}

      <div className="min-w-0" onChangeCapture={() => setHasUnsavedChanges(true)}>
        <div
          className={`mx-auto ${
            currentTask?.taskId === "direct_booking_publication" ? "max-w-5xl" : "max-w-3xl"
          }`}
        >
          {currentTask ? (
            <InlineSetupTaskStep
              key={currentTask.taskId}
              task={currentTask}
              onReturnToReview={
                canReturnToReview ? () => navigateFromTask(() => onSelectTask(null)) : null
              }
              form={renderTaskForm({
                task: currentTask,
                propertyId: plan.propertyId,
                selectedTracks: status.organization.selectedTracks,
                onBeforeSave: () => onBeforeSaveTask(currentTask, plan.planRevision),
                onComplete: () => {
                  setHasUnsavedChanges(false);
                  return onCompleteTask(currentTask);
                },
                onBack: previousTaskId ? () => selectTask(previousTaskId) : null,
                onDirty: () => setHasUnsavedChanges(true),
              })}
            />
          ) : attentionTask ? (
            <SetupAttentionStep
              key={attentionTask.taskId}
              task={attentionTask}
              onBack={previousTaskId ? () => selectTask(previousTaskId) : null}
            />
          ) : (
            <>
              <SetupReview
                launchReadiness={plan.launchReadiness}
                onBack={reviewBackTaskId ? () => selectTask(reviewBackTaskId) : null}
              />
              {(onEnterProduct || onAddTrack || showReviewAddTrackHelp) && (
                <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
                  {onEnterProduct && requestedProduct && (
                    <button
                      type="button"
                      onClick={onEnterProduct}
                      className="inline-flex items-center justify-center gap-2 rounded-full bg-gray-950 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950 focus-visible:ring-offset-2"
                    >
                      Open {labels[requestedProduct]}
                      <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                  {onAddTrack && (
                    <button
                      type="button"
                      onClick={onAddTrack}
                      className="text-sm font-semibold text-primary-700 transition hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
                    >
                      Add another service
                    </button>
                  )}
                  {showReviewAddTrackHelp && (
                    <p className="max-w-xs text-xs text-gray-500">
                      Ask a hotel group owner if you want to add another service.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function SetupAttentionStep({ task, onBack }: { task: SetupTask; onBack: (() => void) | null }) {
  const headingRef = useSetupStepHeadingFocus();
  const content = TASK_CONTENT[task.taskId];
  const state = setupTaskStateCopy(task);
  const toneClass = {
    neutral: "border-gray-200 bg-gray-50 text-gray-700",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-red-200 bg-red-50 text-red-800",
  }[state.tone];

  return (
    <section aria-labelledby="current-setup-step-title">
      <h1
        ref={headingRef}
        id="current-setup-step-title"
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight text-gray-950 outline-none"
      >
        {content.title}
      </h1>
      <p className="mt-3 max-w-2xl text-base leading-7 text-gray-600">{content.description}</p>
      {onBack && <SetupBackButton onClick={onBack} />}
      <div className={`mt-7 rounded-2xl border px-4 py-3 text-sm ${toneClass}`} role="status">
        <p className="font-semibold">{state.label}</p>
        <p className="mt-1 leading-6">{state.description}</p>
      </div>
      <p className="mt-5 max-w-xl text-sm leading-6 text-gray-600">
        Your saved work is safe. Return later or ask the indicated person to resolve this step.
      </p>
    </section>
  );
}

function InlineSetupTaskStep({
  task,
  form,
  onReturnToReview,
}: {
  task: SetupTask;
  form: ReactNode;
  onReturnToReview: (() => void) | null;
}) {
  const headingRef = useSetupStepHeadingFocus();
  const content = TASK_CONTENT[task.taskId];

  return (
    <section aria-labelledby="current-setup-step-title">
      <div className="text-center">
        <h1
          ref={headingRef}
          id="current-setup-step-title"
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight text-gray-950 outline-none sm:text-3xl"
        >
          {content.title}
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-base leading-7 text-gray-600">
          {content.description}
        </p>
        {onReturnToReview && (
          <button
            type="button"
            onClick={onReturnToReview}
            className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-primary-700 transition hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
          >
            Return to review
            <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <div
        className="mt-8 rounded-3xl border border-gray-200 bg-white p-5 shadow-sm sm:p-8"
        data-testid="hotel-setup-form-card"
      >
        {form}
      </div>
    </section>
  );
}

function SetupReview({
  launchReadiness,
  onBack,
}: {
  launchReadiness: NonNullable<AdaptiveHotelSetupStatus["setupPlan"]>["launchReadiness"];
  onBack: (() => void) | null;
}) {
  const headingRef = useSetupStepHeadingFocus();
  const readinessItems = [
    {
      label: "Creator Marketplace",
      description: "Your public profile and creator collaboration offer.",
      value: launchReadiness.marketplacePublish,
    },
    {
      label: "Hotel operations",
      description: "Your PMS rooms, rates, availability, and operating settings.",
      value: launchReadiness.operationsUse,
    },
    {
      label: "Direct booking",
      description: "Your guest-facing booking page, policies, and payment setup.",
      value: launchReadiness.directBookingPublish,
    },
  ] as const;

  return (
    <section aria-labelledby="setup-review-title">
      <h1
        ref={headingRef}
        id="setup-review-title"
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight text-gray-950 outline-none"
      >
        Review and next steps
      </h1>
      <p className="mt-3 max-w-2xl text-base leading-7 text-gray-600">
        Each Vayada service has its own readiness status. You can use ready services while another
        one is still being reviewed.
      </p>
      {onBack && <SetupBackButton onClick={onBack} />}

      <dl className="mt-8 divide-y divide-gray-200 border-y border-gray-200">
        {readinessItems.map((item) => {
          const copy = launchReadinessCopy(item.value);
          return (
            <div
              key={item.label}
              className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <dt className="text-sm font-semibold text-gray-950">{item.label}</dt>
                <dd className="mt-1 text-sm leading-6 text-gray-600">{item.description}</dd>
              </div>
              <dd className={`shrink-0 text-sm font-semibold ${copy.className}`}>{copy.label}</dd>
            </div>
          );
        })}
      </dl>

      <p className="mt-6 text-sm leading-6 text-gray-600">
        Your saved progress is safe. You can leave setup and return whenever a pending service is
        ready.
      </p>
    </section>
  );
}

function SetupBackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-gray-600 transition hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
    >
      <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
      Back
    </button>
  );
}

function useSetupStepHeadingFocus(): RefObject<HTMLHeadingElement> {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return headingRef;
}

function launchReadinessCopy(
  readiness: NonNullable<
    AdaptiveHotelSetupStatus["setupPlan"]
  >["launchReadiness"][keyof NonNullable<AdaptiveHotelSetupStatus["setupPlan"]>["launchReadiness"]],
): { label: string; className: string } {
  if (readiness === "ready") return { label: "Ready", className: "text-emerald-700" };
  if (readiness === "pending") {
    return { label: "Pending", className: "text-amber-800" };
  }
  if (readiness === "blocked") {
    return { label: "Needs attention", className: "text-red-700" };
  }
  return { label: "Not selected", className: "text-gray-500" };
}

function setupTaskStateCopy(task: SetupTask): TaskStateCopy {
  if (task.readiness === "complete") {
    return {
      label: "Complete",
      description: "Nothing else is needed for this step.",
      tone: "success",
    };
  }
  if (task.readiness === "pending_sync") {
    return {
      label: "Syncing",
      description: "Vayada is checking the latest saved information. No action is needed yet.",
      tone: "neutral",
    };
  }
  if (task.readiness === "pending_review") {
    return {
      label: "Under review",
      description: "This step is waiting for review. You can continue with another task.",
      tone: "neutral",
    };
  }
  if (task.readiness === "rejected") {
    return {
      label: "Needs changes",
      description: "Review the feedback in this workspace before submitting again.",
      tone: "danger",
    };
  }
  if (task.callerCapability === "ask_owner") {
    return {
      label: "Ask an owner",
      description: "A hotel group owner has permission to complete this step.",
      tone: "warning",
    };
  }
  if (task.callerCapability === "forbidden") {
    return {
      label: "Permission required",
      description: "You do not have permission to complete this step.",
      tone: "warning",
    };
  }
  if (task.callerCapability === "waiting") {
    return {
      label: "Waiting",
      description: "Another team or an automated process needs to finish this step.",
      tone: "neutral",
    };
  }
  if (task.readiness === "blocked") {
    return {
      label: "Blocked",
      description:
        "A prerequisite or service issue must be resolved before this step can continue.",
      tone: "danger",
    };
  }
  return {
    label: "Ready",
    description: recommendedActionDescription(task),
    tone: "success",
  };
}

function recommendedActionDescription(task: SetupTask): string {
  if (task.actionableBy === "operator") return "You can complete this step now.";
  if (task.actionableBy === "support") return "Vayada support can complete this step.";
  if (task.actionableBy === "system") return "Vayada will complete this step automatically.";
  return "A hotel group owner can complete this step now.";
}

function buildEntryContinueInput(
  status: AdaptiveHotelSetupStatus | null,
  returnTo: string | null,
): SharedFirstRunContinueInput | null {
  if (!status) return null;
  const decision = status.entryDecision;
  if (decision?.decision !== "enter" || !decision.propertyId) {
    return null;
  }
  return {
    product: decision.requestedProduct,
    propertyId: decision.propertyId,
    returnTo,
    action: "enter_product",
  };
}

export function idempotencyKeyForRetry(
  current: string | null,
  create: () => string = () => globalThis.crypto.randomUUID(),
): string {
  return current ?? create();
}

async function savePropertyLogo({
  api,
  draft,
  profile,
  uploadKey,
  assignmentKey,
}: {
  api: SharedHotelSetupApi;
  draft: ProfileDraft;
  profile: PropertyProfileResponse;
  uploadKey: { current: string | null };
  assignmentKey: { current: string | null };
}): Promise<PropertyProfileResponse> {
  if (draft.logoPublicUrl && !draft.logoFile) return profile;
  const storage = window.localStorage;
  let pending = readPendingPropertyLogo(storage, profile.propertyId);

  if (draft.logoFile) {
    const mediaObjectId = await api.uploadPropertyLogo(
      profile.propertyId,
      draft.logoFile,
      (uploadKey.current = idempotencyKeyForRetry(uploadKey.current)),
    );
    pending = {
      mediaObjectId,
      expectedProfileRevision: profile.profileRevision,
      assignmentIdempotencyKey: (assignmentKey.current = idempotencyKeyForRetry(
        assignmentKey.current,
      )),
    };
    writePendingPropertyLogo(storage, profile.propertyId, pending);
  }

  if (!pending || (pending.mediaObjectId !== draft.logoMediaObjectId && !draft.logoFile)) {
    throw new Error("Choose a hotel logo before continuing.");
  }
  let assigned: Awaited<ReturnType<SharedHotelSetupApi["assignPropertyLogo"]>>;
  try {
    assigned = await api.assignPropertyLogo(
      profile.propertyId,
      {
        expectedProfileRevision: pending.expectedProfileRevision,
        mediaObjectId: pending.mediaObjectId,
        altText: null,
      },
      pending.assignmentIdempotencyKey,
    );
  } catch (error) {
    if (setupErrorCode(error) === "profile_revision_conflict") {
      const latest = await api.getPropertyProfile(profile.propertyId);
      const retry = {
        ...pending,
        expectedProfileRevision: latest.profileRevision,
        assignmentIdempotencyKey: idempotencyKeyForRetry(null),
      };
      assignmentKey.current = retry.assignmentIdempotencyKey;
      writePendingPropertyLogo(storage, profile.propertyId, retry);
      throw new Error(
        "These hotel details changed in another session. Review them, then save the logo again.",
      );
    }
    throw error;
  }
  if (assigned.logoAssignment?.mediaObjectId !== pending.mediaObjectId) {
    throw new Error("The hotel logo assignment could not be confirmed.");
  }
  clearPendingPropertyLogo(storage, profile.propertyId);
  return { ...profile, profileRevision: assigned.profileRevision };
}

export function validateProfileDraft(draft: ProfileDraft): Record<string, string[]> {
  const errors: Record<string, string[]> = {};

  if (!draft.displayName.trim()) errors.displayName = ["Hotel name is required."];
  if (!draft.propertyType) errors.propertyType = ["Property type is required."];
  if (!draft.logoFile && !draft.logoMediaObjectId && !draft.logoPublicUrl) {
    errors.logo = ["Hotel logo is required."];
  }
  if (!draft.streetAddress.trim()) {
    errors["location.streetAddress"] = ["Street address is required."];
  }
  if (!draft.postalCode.trim()) {
    errors["location.postalCode"] = ["Postal code is required."];
  }
  if (!draft.city.trim()) {
    errors["location.city"] = ["City is required."];
  }
  if (!draft.countryCode.trim()) {
    errors["location.countryCode"] = ["Country is required."];
  } else if (!COUNTRY_OPTIONS.some((country) => country.code === draft.countryCode)) {
    errors["location.countryCode"] = ["Select a valid country."];
  }
  if (!draft.timezone.trim()) {
    errors["location.timezone"] = ["Time zone is required."];
  }
  if (!draft.contactEmail.trim()) errors.contactEmail = ["Email is required."];
  if (!draft.phone.trim()) errors.phone = ["Phone number is required."];
  if (draft.timezone.trim() && !isValidIanaTimezone(draft.timezone.trim())) {
    errors["location.timezone"] = ["Enter a valid IANA time zone."];
  }
  if (draft.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.contactEmail)) {
    errors.contactEmail = ["Enter a valid email address."];
  }
  if (draft.phone.trim() && !isValidInternationalPhone(draft.phone)) {
    errors.phone = ["Enter a valid phone number."];
  }
  if (draft.whatsapp && !isValidInternationalPhone(draft.whatsapp)) {
    errors.whatsapp = ["Enter a valid WhatsApp number."];
  }

  return errors;
}

function focusFirstIncompleteAddressField(container: HTMLDivElement | null) {
  const fields = Array.from(
    container?.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select") ?? [],
  );
  (fields.find((field) => !field.value.trim()) ?? fields[0])?.focus();
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

const SUPPORTED_PHONE_COUNTRIES = new Set(getCountries());
const PHONE_COUNTRY_OPTIONS = COUNTRY_OPTIONS.filter(({ code }) =>
  SUPPORTED_PHONE_COUNTRIES.has(code as CountryCode),
).map((country) => ({
  ...country,
  callingCode: `+${getCountryCallingCode(country.code as CountryCode)}`,
}));

function phoneCountry(value: string, fallback: string): CountryCode {
  const parsed = parsePhoneNumberFromString(value);
  if (parsed?.country) return parsed.country;
  const normalizedFallback = fallback.trim().toUpperCase() as CountryCode;
  return SUPPORTED_PHONE_COUNTRIES.has(normalizedFallback) ? normalizedFallback : "US";
}

export function normalizedPhoneNumber(value: string, countryCode?: CountryCode): string {
  const parsed = parsePhoneNumberFromString(value, countryCode);
  return parsed?.isValid() ? parsed.formatInternational() : value;
}

function isValidInternationalPhone(value: string): boolean {
  return value.trim().startsWith("+") && Boolean(parsePhoneNumberFromString(value)?.isValid());
}

export function phoneWithCountryCallingCode(
  value: string,
  countryCode: CountryCode,
  previousCountryCode?: CountryCode,
): string {
  const callingCode = `+${getCountryCallingCode(countryCode)}`;
  const parsed = parsePhoneNumberFromString(value);
  if (parsed?.nationalNumber) return `${callingCode} ${parsed.nationalNumber}`;

  const digits = value.replace(/\D/g, "");
  const previousCallingCode = previousCountryCode
    ? getCountryCallingCode(previousCountryCode)
    : undefined;
  const nationalNumber =
    previousCallingCode && digits.startsWith(previousCallingCode)
      ? digits.slice(previousCallingCode.length)
      : digits.replace(/^0+/, "");
  return nationalNumber ? `${callingCode} ${nationalNumber}` : `${callingCode} `;
}

function PhoneField({
  label,
  value,
  countryCode,
  onChange,
  error,
  helper,
  placeholder,
  required = false,
}: {
  label: string;
  value: string;
  countryCode: string;
  onChange: (value: string) => void;
  error?: string;
  helper?: string;
  placeholder: string;
  required?: boolean;
}) {
  const generatedId = useId();
  const inputId = `setup-${generatedId}`;
  const helperId = helper ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [helperId, errorId].filter(Boolean).join(" ") || undefined;
  const [selectedCountry, setSelectedCountry] = useState<CountryCode>(() =>
    phoneCountry(value, countryCode),
  );

  useEffect(() => {
    const parsedCountry = parsePhoneNumberFromString(value)?.country;
    if (parsedCountry) {
      setSelectedCountry((current) => (current === parsedCountry ? current : parsedCountry));
    } else if (!value.trim()) {
      const fallbackCountry = phoneCountry("", countryCode);
      setSelectedCountry((current) => (current === fallbackCountry ? current : fallbackCountry));
    }
  }, [countryCode, value]);

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
      <div
        className={`mt-2 flex overflow-hidden rounded-xl border transition focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-100 ${
          error ? "border-red-300 bg-red-50" : "border-gray-200 bg-white"
        }`}
      >
        <select
          aria-label={`${label} country code`}
          value={selectedCountry}
          onChange={(event) => {
            const nextCountry = event.target.value as CountryCode;
            const previousCountry = selectedCountry;
            setSelectedCountry(nextCountry);
            onChange(phoneWithCountryCallingCode(value, nextCountry, previousCountry));
          }}
          className="w-32 shrink-0 border-0 border-r border-gray-200 bg-gray-50 px-3 py-2.5 text-sm outline-none"
        >
          {PHONE_COUNTRY_OPTIONS.map((country) => (
            <option key={country.code} value={country.code}>
              {country.flag} {country.callingCode}
            </option>
          ))}
        </select>
        <input
          id={inputId}
          type="tel"
          value={value}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          aria-required={required}
          onChange={(event) => onChange(normalizedPhoneNumber(event.target.value, selectedCountry))}
          onBlur={() => {
            const normalized = normalizedPhoneNumber(value, selectedCountry);
            if (normalized !== value) onChange(normalized);
          }}
          className="min-w-0 flex-1 border-0 bg-transparent px-4 py-2.5 text-base outline-none sm:text-sm"
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

function PropertyLogoField({
  previewUrl,
  pending,
  error,
  onChange,
}: {
  previewUrl: string;
  pending: boolean;
  error?: string;
  onChange: (file: File) => void;
}) {
  const inputId = `property-logo-${useId()}`;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div>
      <p className="text-sm font-medium text-gray-700">
        Hotel logo
        <span className="ml-1 text-red-500" aria-hidden="true">
          *
        </span>
        <span className="sr-only"> (required)</span>
      </p>
      <label
        htmlFor={inputId}
        className={`mt-2 flex cursor-pointer items-center gap-4 rounded-xl border bg-white p-3 transition hover:border-primary-300 focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-2 ${
          error ? "border-red-300 bg-red-50" : "border-gray-200"
        }`}
      >
        <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gray-100 text-gray-500">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Hotel logo preview"
              className="h-full w-full object-contain"
            />
          ) : pending ? (
            <CheckIcon className="h-7 w-7 text-primary-700" aria-hidden="true" />
          ) : (
            <PhotoIcon className="h-7 w-7" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-gray-900">
            {previewUrl
              ? "Change hotel logo"
              : pending
                ? "Logo ready to finish"
                : "Choose hotel logo"}
          </span>
          <span className="mt-1 block text-xs leading-5 text-gray-500">
            JPG, PNG, or WebP. Max 10 MB. The logo is published only after assignment.
          </span>
        </span>
        <input
          id={inputId}
          type="file"
          aria-label="Hotel logo file"
          accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
          aria-invalid={Boolean(error)}
          aria-describedby={errorId}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onChange(file);
            event.target.value = "";
          }}
        />
      </label>
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

function draftFromProfile(
  response: PropertyProfileResponse,
  publicResponse: PublicPropertyProfileResponse | null,
  pendingLogo: PendingPropertyLogoAssignment | null,
): ProfileDraft {
  const profile = response.profile;
  const publicLogo = publicResponse?.publicProfile.media.find(
    ({ mediaType }) => mediaType === "logo",
  );
  const phone = contactValue(profile.contacts, "phone");
  const whatsapp = contactValue(profile.contacts, "whatsapp");
  const profileCountry = profile.location.countryCode.trim().toUpperCase() as CountryCode;
  const profilePhoneCountry = SUPPORTED_PHONE_COUNTRIES.has(profileCountry)
    ? profileCountry
    : undefined;
  return {
    displayName: profile.displayName,
    propertyType: profile.propertyType,
    countryCode: profile.location.countryCode,
    city: profile.location.city,
    streetAddress: profile.location.streetAddress,
    postalCode: profile.location.postalCode,
    latitude: profile.location.latitude,
    longitude: profile.location.longitude,
    timezone: profile.location.timezone,
    contactEmail: contactValue(profile.contacts, "email"),
    phone: normalizedPhoneNumber(phone, profilePhoneCountry),
    whatsapp: normalizedPhoneNumber(whatsapp, profilePhoneCountry),
    localityPublic: profile.location.localityPublic,
    logoFile: null,
    logoMediaObjectId: pendingLogo?.mediaObjectId ?? publicLogo?.mediaObjectId ?? null,
    logoPublicUrl: pendingLogo ? "" : (publicLogo?.url ?? ""),
  };
}

export function createProfileFromDraft(draft: ProfileDraft): CreatePropertyProfileRequest {
  return {
    displayName: draft.displayName.trim(),
    propertyType: draft.propertyType,
    location: {
      countryCode: draft.countryCode.trim().toUpperCase(),
      city: draft.city.trim(),
      streetAddress: draft.streetAddress.trim(),
      postalCode: draft.postalCode.trim(),
      timezone: draft.timezone.trim(),
      latitude: draft.latitude,
      longitude: draft.longitude,
      localityPublic: draft.localityPublic,
      geoPublic: false,
      mapDisplayMode: "hidden",
    },
    contacts: contactsFromDraft(draft),
  };
}

export function profileUpdateFromDraft(
  draft: ProfileDraft,
  existing: PropertyProfileResponse,
): UpdatePropertyProfileRequest | null {
  const profile = existing.profile;
  const patch: PropertyProfilePatch = {};
  const displayName = draft.displayName.trim();
  const propertyType = draft.propertyType;
  if (displayName !== profile.displayName) patch.displayName = displayName;
  if (propertyType !== profile.propertyType) patch.propertyType = propertyType;

  const location = {
    countryCode: draft.countryCode.trim().toUpperCase(),
    city: draft.city.trim(),
    streetAddress: draft.streetAddress.trim(),
    postalCode: draft.postalCode.trim(),
    timezone: draft.timezone.trim(),
    latitude: draft.latitude,
    longitude: draft.longitude,
    localityPublic: draft.localityPublic,
    geoPublic: false,
    mapDisplayMode: "hidden" as const,
  };
  const locationPatch = Object.fromEntries(
    Object.entries(location).filter(
      ([key, value]) => value !== profile.location[key as keyof typeof location],
    ),
  ) as NonNullable<PropertyProfilePatch["location"]>;
  if (Object.keys(locationPatch).length > 0) patch.location = locationPatch;

  const contacts = contactsFromDraft(draft, profile.contacts);
  if (!sameContacts(contacts, profile.contacts)) patch.contacts = contacts;
  if (Object.keys(patch).length === 0) return null;

  return {
    expectedProfileRevision: existing.profileRevision,
    patch,
  };
}

function newPropertyDraft(timezone = ""): ProfileDraft {
  return {
    displayName: "",
    propertyType: "",
    countryCode: "",
    city: "",
    streetAddress: "",
    postalCode: "",
    latitude: null,
    longitude: null,
    timezone,
    contactEmail: "",
    phone: "",
    whatsapp: "",
    localityPublic: false,
    logoFile: null,
    logoMediaObjectId: null,
    logoPublicUrl: "",
  };
}

function normalizedPropertyLaunchSettings(
  settings: PropertyLaunchSettings,
): PropertyLaunchSettings {
  return {
    defaultCurrency: settings.defaultCurrency,
    supportedCurrencies: Array.from(new Set(settings.supportedCurrencies)).filter(
      (code) => code !== settings.defaultCurrency,
    ),
    defaultLanguage: settings.defaultLanguage,
    supportedLanguages: Array.from(new Set(settings.supportedLanguages)).filter(
      (code) => code !== settings.defaultLanguage,
    ),
    instagram: settings.instagram.trim(),
    facebook: settings.facebook.trim(),
    tiktok: settings.tiktok.trim(),
    youtube: settings.youtube.trim(),
  };
}

function contactsFromDraft(
  draft: ProfileDraft,
  existing: PropertyProfileContact[] = [],
): PropertyProfileContact[] {
  return (
    [
      ["phone", draft.phone],
      ["whatsapp", draft.whatsapp],
      ["email", draft.contactEmail],
    ] as const
  ).reduce<PropertyProfileContact[]>(
    (contacts, [channelType, value]) => replaceContact(contacts, channelType, value),
    existing,
  );
}

function replaceContact(
  contacts: PropertyProfileContact[],
  channelType: PropertyProfileContact["channelType"],
  rawValue: string,
): PropertyProfileContact[] {
  const trimmed = rawValue.trim();
  const exactIndex = contacts.findIndex(
    (contact) => contact.channelType === channelType && contact.value === trimmed,
  );
  if (!trimmed) {
    return contacts.filter((contact) => contact.channelType !== channelType || !contact.isPublic);
  }

  if (exactIndex >= 0) {
    return contacts.flatMap((contact, contactIndex) => {
      if (contactIndex === exactIndex) {
        return [{ ...contact, purpose: "general" as const, isPublic: true }];
      }
      return contact.channelType === channelType && contact.isPublic ? [] : [contact];
    });
  }

  return [
    ...contacts.filter((contact) => contact.channelType !== channelType || !contact.isPublic),
    {
      channelType,
      value: trimmed,
      purpose: "general",
      isPublic: true,
    },
  ];
}

function contactValue(
  contacts: PropertyProfileContact[],
  channelType: PropertyProfileContact["channelType"],
): string {
  return (
    contacts.find(
      (contact) =>
        contact.channelType === channelType && contact.purpose === "general" && contact.isPublic,
    )?.value ??
    contacts.find((contact) => contact.channelType === channelType && contact.isPublic)?.value ??
    contacts.find((contact) => contact.channelType === channelType && contact.purpose === "general")
      ?.value ??
    contacts.find((contact) => contact.channelType === channelType)?.value ??
    ""
  );
}

function sameContacts(
  left: readonly PropertyProfileContact[],
  right: readonly PropertyProfileContact[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (contact, index) =>
        contact.channelType === right[index]?.channelType &&
        contact.value === right[index]?.value &&
        contact.purpose === right[index]?.purpose &&
        contact.isPublic === right[index]?.isPublic,
    )
  );
}

export function mergeTrackSelectionAfterConflict(
  intended: readonly SetupTrack[],
  current: readonly SetupTrack[],
): SetupTrack[] {
  return (["hotel_operations", "creator_marketplace"] as const).filter(
    (track) => intended.includes(track) || current.includes(track),
  );
}

function sameTrackSelection(left: readonly SetupTrack[], right: readonly SetupTrack[]): boolean {
  return left.length === right.length && left.every((track, index) => track === right[index]);
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

export function setupErrorMessage(error: unknown): string {
  const status = setupErrorStatus(error);
  if (status !== null && status >= 500) {
    return "Something went wrong on our end. Please try again.";
  }

  const code = setupErrorCode(error);
  if (code === "command_in_progress") {
    return "We're still finishing your setup. Please try again in a moment.";
  }
  if (code === "idempotency_key_conflict") {
    return "Your setup changed during this save. Review it and try again.";
  }

  const data =
    error && typeof error === "object"
      ? (error as { data?: { detail?: unknown; message?: unknown; error?: unknown } }).data
      : null;
  const serverMessage = [data?.detail, data?.message, data?.error].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (serverMessage && !isRawApiErrorMessage(serverMessage)) return serverMessage;

  if (status === 409) {
    return "We couldn't save because your setup changed elsewhere. Refresh and try again.";
  }
  if (
    error instanceof TypeError ||
    (error instanceof Error && /failed to fetch|network/i.test(error.message))
  ) {
    return "Couldn't save. Check your connection and try again.";
  }
  if (error instanceof Error && error.message && !isRawApiErrorMessage(error.message)) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function setupErrorStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status)) return status;
  }
  if (error instanceof Error) {
    const match = /^API Error: (\d{3})$/i.exec(error.message.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

function setupErrorPropertyId(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: { propertyId?: unknown } }).data;
  return typeof data?.propertyId === "string" && data.propertyId.length > 0
    ? data.propertyId
    : null;
}

function isRawApiErrorMessage(message: string): boolean {
  return /^API Error: \d{3}$/i.test(message.trim());
}

function setupErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: { code?: unknown } }).data;
  return typeof data?.code === "string" ? data.code : null;
}

function fieldErrorsFromError(error: unknown): Record<string, string[]> {
  if (!error || typeof error !== "object") return {};
  const data = (error as { data?: { fields?: unknown } }).data;
  if (!data || !data.fields || typeof data.fields !== "object" || Array.isArray(data.fields)) {
    return {};
  }
  return data.fields as Record<string, string[]>;
}

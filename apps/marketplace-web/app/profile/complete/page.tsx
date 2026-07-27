"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon } from "@heroicons/react/24/outline";
import { splitSharedAccountName } from "@vayada/product-onboarding";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { ROUTES } from "@/lib/constants/routes";
import { STORAGE_KEYS } from "@/lib/constants";
import { checkProfileStatus, isProfileComplete } from "@/lib/utils";
import type {
  UserType,
  CreatorFormState,
  CreatorPlatformConnection,
  CreatorPlatformPendingAuthorization,
  CreatorPlatformProvider,
  CreatorProfileStatus,
  HotelProfileStatus,
  HotelProfile,
  HotelListing,
  ListingFormData,
  Platform,
  PlatformFormData,
} from "@/lib/types";
import { creatorService } from "@/services/api/creators";
import {
  advanceHotelProfileRevisionsAfterCoverUpload,
  CanonicalHotelPhotoReuseError,
  hotelService,
  type HotelProfileRevisionSnapshot,
} from "@/services/api/hotels";
import { ApiErrorResponse } from "@/services/api/client";
import { authService } from "@/services/auth";
import { useCreatorProfileForm } from "@/hooks/useCreatorProfileForm";
import { useHotelProfileForm } from "@/hooks/useHotelProfileForm";
import { formatErrorDetail } from "@/hooks/useErrorModal";
import {
  marketplaceSetupRedirectPath,
  resolveMarketplaceActivationGuard,
  SELECTED_SHARED_PROPERTY_ID_KEY,
} from "@/lib/utils/sharedSetupGuard";
import {
  creatorIdentityPhotoPatch,
  hasRequiredCreatorAccountDetails,
  resolveCreatorContactDetails,
} from "@/lib/utils/creatorAccountRequirements";
import { mergeCreatorPlatformDraft } from "@/lib/utils/mergeCreatorPlatformDraft";
import {
  clearHotelMarketplaceDraft,
  createHotelMarketplaceDraft,
  ensureHotelMarketplaceOfferIdempotency,
  initialHotelMarketplaceOfferImages,
  markHotelMarketplaceDraftOfferProgress,
  readHotelMarketplaceDraft,
  recoverHotelMarketplaceDraftFromSourceMediaFailure,
  recoverHotelMarketplaceOfferFromSourceMediaFailure,
  replaceFirstOfferPhotoWithCanonicalCover,
  resolveHotelMarketplaceCoverSource,
  resolveHotelMarketplaceDraftResume,
  restoreHotelMarketplaceDraftForm,
  saveHotelMarketplaceDraft,
} from "@/lib/utils/hotelMarketplaceDraft";
import {
  LoadingScreen,
  ProfileCompletionScreen,
  StepIndicators,
  CreatorProfileForm,
  HotelProfileForm,
} from "@/components/profile-complete";
import {
  hotelTaskFlow,
  hotelTaskResumeStep,
  parseMarketplaceHotelTaskHandoff,
  type MarketplaceHotelTaskHandoff,
  type MarketplaceHotelSetupTaskId,
} from "./hotelTaskFlow";

const CREATOR_PLATFORM_DRAFT_KEY = "vayada_creator_platform_connection_draft";
const PLATFORM_CONNECTIONS_LOAD_ERROR =
  "Connected accounts could not be loaded. Retry before changing platform details.";

type CreatorPlatformCallback = {
  status: "success" | "select" | "error";
  platform: CreatorPlatformProvider;
  authorizationId: string | null;
  connectionId: string | null;
};

type CreatorPlatformDraft = {
  form: CreatorFormState;
  platforms: PlatformFormData[];
  managePlatforms?: boolean;
};

type ExistingOfferCoverSelection = {
  file: File | null;
  previewUrl: string | null;
};

class HotelCoverPhotoRequiredError extends Error {
  constructor() {
    super("Choose a hotel cover photo to continue.");
    this.name = "HotelCoverPhotoRequiredError";
  }
}

export default function ProfileCompletePage() {
  const router = useRouter();
  const [userType, setUserType] = useState<UserType | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [profileStatus, setProfileStatus] = useState<
    CreatorProfileStatus | HotelProfileStatus | null
  >(null);
  const [profileStatusLoadFailed, setProfileStatusLoadFailed] = useState(false);
  const [error, setError] = useState("");
  const [profileCompleted, setProfileCompleted] = useState(false);
  const [hasExistingMarketplaceOffer, setHasExistingMarketplaceOffer] = useState(false);
  const marketplacePropertyIdRef = useRef<string | null>(null);
  const hotelProfileRevisionsRef = useRef<HotelProfileRevisionSnapshot | null>(null);
  const [hotelTaskHandoff, setHotelTaskHandoff] = useState<MarketplaceHotelTaskHandoff | null>(
    null,
  );
  const [canonicalHotelCoverUrl, setCanonicalHotelCoverUrl] = useState<string | null>(null);
  const [existingMarketplaceOfferCoverUrl, setExistingMarketplaceOfferCoverUrl] = useState<
    string | null
  >(null);
  const existingOfferCoverInputRef = useRef<HTMLInputElement>(null);
  const [existingOfferCoverPicker, setExistingOfferCoverPicker] =
    useState<ExistingOfferCoverSelection>({
      file: null,
      previewUrl: null,
    });
  const [hotelDraftPropertyId, setHotelDraftPropertyId] = useState<string | null>(null);
  const [hotelDraftReady, setHotelDraftReady] = useState(false);
  const creatorProfilePhotoRef = useRef<{
    profilePicture?: string | null;
    profilePictureMediaObjectId?: string | null;
  }>({});
  const [managingPlatforms, setManagingPlatforms] = useState(false);
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [initialCreatorPlatformsSignature, setInitialCreatorPlatformsSignature] = useState("[]");
  const [platformConnections, setPlatformConnections] = useState<
    CreatorPlatformConnection[] | null
  >(null);
  const [platformConnectionsError, setPlatformConnectionsError] = useState("");
  const [pendingAuthorization, setPendingAuthorization] =
    useState<CreatorPlatformPendingAuthorization | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [connectingPlatform, setConnectingPlatform] = useState<CreatorPlatformProvider | null>(
    null,
  );
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
  const [selectingExternalAccountId, setSelectingExternalAccountId] = useState<string | null>(null);
  const [reviewingConnectionCallback, setReviewingConnectionCallback] = useState(false);

  const creatorSteps = ["Creator category", "About your work", "Audience & platforms"];
  const activeHotelTaskFlow = hotelTaskFlow(hotelTaskHandoff?.taskId ?? "public_profile");
  const hotelSteps = activeHotelTaskFlow.steps.map(({ title }) => title);
  const activeHotelSection =
    activeHotelTaskFlow.steps[currentStep - 1]?.section ?? activeHotelTaskFlow.steps[0]!.section;
  const showExistingOfferCoverPicker = activeHotelTaskFlow.ensureCover && !canonicalHotelCoverUrl;
  const requiresExistingOfferCoverSelection =
    showExistingOfferCoverPicker && !existingMarketplaceOfferCoverUrl;

  // Initialize hooks with error handler
  const creatorForm = useCreatorProfileForm({ onError: setError });
  const hotelForm = useHotelProfileForm({ onError: setError });

  useEffect(() => {
    if (
      userType !== "hotel" ||
      hotelTaskHandoff?.taskId !== "creator_offer" ||
      !hotelDraftReady ||
      !hotelDraftPropertyId
    ) {
      return;
    }

    const saveTimeout = window.setTimeout(() => {
      try {
        saveHotelMarketplaceDraft(
          localStorage,
          hotelDraftPropertyId,
          createHotelMarketplaceDraft(hotelForm.form, hotelForm.listings, currentStep),
        );
      } catch (draftError) {
        console.warn("Could not save the Marketplace setup draft", draftError);
      }
    }, 250);

    return () => window.clearTimeout(saveTimeout);
  }, [
    currentStep,
    hotelDraftPropertyId,
    hotelDraftReady,
    hotelTaskHandoff?.taskId,
    hotelForm.form,
    hotelForm.listings,
    userType,
  ]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const storedUserType = localStorage.getItem(STORAGE_KEYS.USER_TYPE) as UserType | null;
      setUserType(storedUserType);

      if (storedUserType === "hotel") {
        localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "false");
        const activationParams = new URLSearchParams(window.location.search);
        const taskHandoff = parseMarketplaceHotelTaskHandoff(
          activationParams,
          localStorage,
          window.location.origin,
        );
        if (!taskHandoff) {
          router.replace(marketplaceSetupRedirectPath(ROUTES.MARKETPLACE));
          return;
        }
        const requestedPropertyId = taskHandoff.propertyId;
        setHotelTaskHandoff(taskHandoff);

        const hydrationController = new AbortController();
        const hydrationTimeout = window.setTimeout(() => hydrationController.abort(), 5_000);
        let cancelled = false;
        let navigatingAway = false;
        setLoading(true);
        void (async () => {
          try {
            const savedDraft =
              taskHandoff.taskId === "creator_offer"
                ? readHotelMarketplaceDraft(localStorage, requestedPropertyId)
                : null;
            const decision = await resolveMarketplaceActivationGuard(
              ROUTES.MARKETPLACE,
              requestedPropertyId,
              { signal: hydrationController.signal },
            );
            if (cancelled) return;

            if (decision.propertyId !== requestedPropertyId) {
              navigatingAway = true;
              router.replace(marketplaceSetupRedirectPath(ROUTES.MARKETPLACE));
              return;
            }
            if (decision.action !== "enter_product") {
              navigatingAway = true;
              router.replace(decision.redirectPath);
              return;
            }

            marketplacePropertyIdRef.current = requestedPropertyId;
            localStorage.setItem(SELECTED_SHARED_PROPERTY_ID_KEY, requestedPropertyId);
            const profile = await hotelService.getMyProfile(requestedPropertyId, {
              signal: hydrationController.signal,
            });
            if (cancelled) return;

            hotelProfileRevisionsRef.current = {
              canonicalProfileRevision: profile.canonicalProfileRevision,
              publicProfileRevision: profile.publicProfileRevision,
            };
            const hasExistingOffer = hydrateHotelMarketplaceProfile(profile, taskHandoff.taskId);
            if (savedDraft) {
              const resumedDraft = resolveHotelMarketplaceDraftResume(savedDraft, hasExistingOffer);
              const pendingListings = resumedDraft.listings;
              hotelForm.setForm(
                restoreHotelMarketplaceDraftForm(savedDraft.form, profile.localityPublic),
              );
              if (pendingListings.length > 0) {
                setHasExistingMarketplaceOffer(resumedDraft.hasExistingMarketplaceOffer);
                hotelForm.setListings(pendingListings);
                const needsPhotos =
                  savedDraft.omittedLocalPhotos &&
                  pendingListings.some((listing) => listing.images.length === 0);
                setCurrentStep(
                  hotelTaskResumeStep({
                    taskId: taskHandoff.taskId,
                    savedStep: savedDraft.currentStep,
                    authoritativeLocalityPublic: profile.localityPublic,
                    needsPhotos,
                  }),
                );
                if (needsPhotos) {
                  setError(
                    "Your Marketplace setup details were restored. Please select your offer photos again to continue.",
                  );
                }
              } else if (hasExistingOffer) {
                clearHotelMarketplaceDraft(localStorage, requestedPropertyId);
              }
            }
            setHotelDraftPropertyId(requestedPropertyId);
            setHotelDraftReady(true);
          } catch {
            if (cancelled) return;
            setProfileStatusLoadFailed(true);
            setError(
              hydrationController.signal.aborted
                ? "Loading Marketplace setup took too long. Please refresh and try again."
                : "Failed to load Marketplace setup. Please refresh and try again.",
            );
          }
        })().finally(() => {
          window.clearTimeout(hydrationTimeout);
          if (!cancelled && !navigatingAway) setLoading(false);
        });
        return () => {
          cancelled = true;
          window.clearTimeout(hydrationTimeout);
          hydrationController.abort();
        };
      }

      if (storedUserType === "admin") {
        router.replace(ROUTES.MARKETPLACE);
        return;
      }

      const userName = localStorage.getItem(STORAGE_KEYS.USER_NAME) || "";

      if (storedUserType === "creator") {
        const connectionCallback = readCreatorPlatformCallback();
        const connectionDraft = connectionCallback ? readCreatorPlatformDraft() : null;
        const managementRequested =
          new URLSearchParams(window.location.search).get("manage-platforms") === "1" ||
          connectionDraft?.managePlatforms === true;
        if (managementRequested) {
          setManagingPlatforms(true);
          setCurrentStep(3);
        }
        if (connectionCallback) {
          setCurrentStep(3);
          setReviewingConnectionCallback(true);
        }
        creatorForm.setForm((prev) => ({ ...prev, name: userName }));
        const hydrationController = new AbortController();
        const hydrationTimeout = window.setTimeout(() => hydrationController.abort(), 5_000);
        let cancelled = false;
        setLoading(true);
        void (async () => {
          try {
            const authenticated = await authService.ensureSession(hydrationController.signal);
            if (cancelled) return;
            if (!authenticated) {
              router.replace(ROUTES.LOGIN);
              return;
            }
            const [hydrationResult, statusResult, connectionsResult] = await Promise.allSettled([
              hydrateCreatorProfile(
                userName,
                authService.getSessionUser(),
                hydrationController.signal,
              ),
              loadProfileStatus("creator", true, false, hydrationController.signal),
              creatorService.getPlatformConnections({ signal: hydrationController.signal }),
            ]);
            if (cancelled) return;
            if (connectionsResult.status === "fulfilled") {
              setPlatformConnections(connectionsResult.value);
              setPlatformConnectionsError("");
            } else {
              setPlatformConnections(null);
              setPlatformConnectionsError(PLATFORM_CONNECTIONS_LOAD_ERROR);
            }
            if (hydrationResult.status === "rejected") {
              setProfileStatusLoadFailed(true);
              setError(
                hydrationController.signal.aborted
                  ? "Loading your creator profile took too long. Please refresh and try again."
                  : "Failed to load your creator profile. Please refresh and try again.",
              );
              return;
            }
            if (
              !hasRequiredCreatorAccountDetails(authService.getSessionUser(), hydrationResult.value)
            ) {
              router.replace(ROUTES.ONBOARDING);
              return;
            }
            if (statusResult.status === "rejected") {
              setProfileStatusLoadFailed(true);
              setError(
                hydrationController.signal.aborted
                  ? "Loading your creator profile took too long. Please refresh and try again."
                  : "Failed to load profile status. Please try again.",
              );
              return;
            }
            if (connectionDraft) {
              creatorForm.setForm(connectionDraft.form);
              creatorForm.setPlatforms(
                connectionsResult.status === "fulfilled"
                  ? mergeCreatorPlatformDraft(
                      connectionDraft.platforms,
                      hydrationResult.value.platforms.map(toPlatformFormData),
                      connectionsResult.value,
                    )
                  : connectionDraft.platforms,
              );
            }
            if (connectionCallback) {
              if (connectionsResult.status === "rejected") return;
              await handleCreatorPlatformCallback(
                connectionCallback,
                connectionsResult.value,
                hydrationController.signal,
              );
              clearCreatorPlatformCallback(managementRequested);
              sessionStorage.removeItem(CREATOR_PLATFORM_DRAFT_KEY);
            }
          } catch {
            if (cancelled) return;
            setProfileStatusLoadFailed(true);
            setError(
              hydrationController.signal.aborted
                ? "Loading your creator profile took too long. Please refresh and try again."
                : "Failed to load your session. Please refresh and try again.",
            );
          } finally {
            window.clearTimeout(hydrationTimeout);
            if (!cancelled) setLoading(false);
          }
        })();
        return () => {
          cancelled = true;
          window.clearTimeout(hydrationTimeout);
          hydrationController.abort();
        };
      }

      if (storedUserType) {
        void loadProfileStatus(storedUserType, true);
      } else {
        router.push(ROUTES.LOGIN);
      }
    }
  }, [router]);

  const hydrateCreatorProfile = async (
    fallbackName: string,
    identity: ReturnType<typeof authService.getSessionUser>,
    signal: AbortSignal,
  ) => {
    const profile = await creatorService.getMyProfile({ signal });
    const contact = resolveCreatorContactDetails(identity, profile);
    const hasStartedCreatorProfile = Boolean(
      profile.location.trim() ||
      profile.shortDescription?.trim() ||
      profile.portfolioLink?.trim() ||
      profile.platforms.length,
    );
    creatorForm.setForm((prev) => ({
      ...prev,
      name: contact.name || fallbackName || prev.name,
      location: profile.location.trim() || prev.location,
      short_description: profile.shortDescription?.trim() || prev.short_description,
      portfolio_link: profile.portfolioLink?.trim() || prev.portfolio_link,
      phone: contact.phone || prev.phone,
      creator_type: hasStartedCreatorProfile ? profile.creatorType : prev.creator_type,
    }));
    const hydratedPlatforms = profile.platforms.map(toPlatformFormData);
    creatorForm.setPlatforms(hydratedPlatforms);
    setInitialCreatorPlatformsSignature(
      JSON.stringify(hydratedPlatforms.map(toCreatorPlatformUpdate)),
    );
    creatorProfilePhotoRef.current = {
      profilePicture: profile.profilePicture,
      profilePictureMediaObjectId: profile.profilePictureMediaObjectId,
    };
    return profile;
  };

  const hydrateHotelMarketplaceProfile = (
    profile: HotelProfile,
    taskId: MarketplaceHotelSetupTaskId,
  ): boolean => {
    const profileCoverUrl = profile.picture?.trim() || null;
    const existingOffer = profile.listings.find(
      (listing) => listing.status === "pending" || listing.status === "verified",
    );
    const coverSourceOffer =
      existingOffer ?? profile.listings.find((listing) => listing.status === "rejected");
    const existingOfferCoverUrl =
      coverSourceOffer?.images.find((image) => image.trim())?.trim() || null;
    setCanonicalHotelCoverUrl(profileCoverUrl);
    setExistingMarketplaceOfferCoverUrl(existingOfferCoverUrl);
    const hasExistingOffer = Boolean(existingOffer);
    const needsExistingOfferCover = Boolean(existingOfferCoverUrl) && !profileCoverUrl;
    setExistingOfferCoverPicker({
      file: null,
      previewUrl: needsExistingOfferCover ? existingOfferCoverUrl : null,
    });
    hotelForm.setForm({
      about:
        taskId === "public_profile"
          ? (profile.publicAbout ?? "")
          : taskId === "creator_profile"
            ? (profile.marketplaceAbout ?? "")
            : "",
      localityPublic: profile.localityPublic,
    });
    setHasExistingMarketplaceOffer(hasExistingOffer);
    hotelForm.setListings(
      taskId !== "creator_offer"
        ? []
        : existingOffer
          ? [existingMarketplaceOfferDraft(existingOffer)]
          : [newMarketplaceOffer(profile)],
    );
    return hasExistingOffer;
  };

  const ensureCanonicalHotelCover = async (
    listings: ListingFormData[],
    propertyId: string,
  ): Promise<ListingFormData[]> => {
    if (canonicalHotelCoverUrl) return listings;
    const revisions = hotelProfileRevisionsRef.current;
    if (!revisions) {
      throw new Error("Marketplace setup is missing the hotel profile revision");
    }

    const firstListing = listings[0];
    const source = resolveHotelMarketplaceCoverSource({
      listing: firstListing,
      selectedFile: existingOfferCoverPicker.file,
      existingOfferCoverUrl: existingMarketplaceOfferCoverUrl,
    });
    if (!source) throw new HotelCoverPhotoRequiredError();

    const uploaded =
      source.kind === "file"
        ? await hotelService.uploadProfileImage(
            source.file,
            propertyId,
            revisions.canonicalProfileRevision,
          )
        : await hotelService.uploadProfileImageFromSource(
            source.url,
            propertyId,
            revisions.canonicalProfileRevision,
          );
    hotelProfileRevisionsRef.current = advanceHotelProfileRevisionsAfterCoverUpload(revisions);
    setCanonicalHotelCoverUrl(uploaded.url);
    setExistingOfferCoverPicker((current) => ({
      ...current,
      previewUrl: uploaded.url,
    }));
    if (!firstListing) return listings;

    const preparedListings = [
      replaceFirstOfferPhotoWithCanonicalCover(firstListing, uploaded.url),
      ...listings.slice(1),
    ];
    hotelForm.setListings(preparedListings);
    saveHotelMarketplaceDraft(
      localStorage,
      propertyId,
      createHotelMarketplaceDraft(hotelForm.form, preparedListings, currentStep),
    );
    return preparedListings;
  };

  const handleExistingOfferCoverChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Choose a JPG, PNG, or WEBP hotel cover photo.");
      event.target.value = "";
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Hotel cover photo must be 10 MB or smaller.");
      event.target.value = "";
      return;
    }

    setError("");
    setExistingOfferCoverPicker((current) => ({
      ...current,
      file,
    }));
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result !== "string") return;
      setExistingOfferCoverPicker((current) =>
        current.file === file ? { ...current, previewUrl: reader.result as string } : current,
      );
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const clearExistingOfferCoverSelection = () => {
    setExistingOfferCoverPicker({
      file: null,
      previewUrl: existingMarketplaceOfferCoverUrl,
    });
    if (existingOfferCoverInputRef.current) {
      existingOfferCoverInputRef.current.value = "";
    }
  };

  const refreshCreatorPlatformData = async () => {
    const draftForm = creatorForm.form;
    const draftPlatforms = creatorForm.platforms;
    setPlatformConnections(null);
    setPlatformConnectionsError("");
    try {
      const [profile, connections] = await Promise.all([
        creatorService.getMyProfile(),
        creatorService.getPlatformConnections(),
      ]);
      const hydratedPlatforms = profile.platforms.map(toPlatformFormData);
      creatorForm.setForm(draftForm);
      creatorForm.setPlatforms(
        mergeCreatorPlatformDraft(draftPlatforms, hydratedPlatforms, connections),
      );
      setInitialCreatorPlatformsSignature(
        JSON.stringify(hydratedPlatforms.map(toCreatorPlatformUpdate)),
      );
      setPlatformConnections(connections);
      return profile;
    } catch (err) {
      setPlatformConnections(null);
      setPlatformConnectionsError(PLATFORM_CONNECTIONS_LOAD_ERROR);
      throw err;
    }
  };

  const handleCreatorPlatformCallback = async (
    callback: CreatorPlatformCallback,
    connections: CreatorPlatformConnection[],
    signal: AbortSignal,
  ) => {
    const platformName = creatorPlatformDisplayName(callback.platform);
    if (callback.status === "error") {
      setConnectionNotice({
        tone: "error",
        message: `${platformName} could not be connected. Try again or enter the account manually.`,
      });
      return;
    }

    if (callback.status === "success") {
      const connectedAccount = connections.find(
        (connection) =>
          connection.connectionId === callback.connectionId &&
          connection.platform === callback.platform &&
          connection.status === "active",
      );
      if (!connectedAccount) {
        setConnectionNotice({
          tone: "error",
          message: `${platformName} returned to Vayada, but the connected account could not be confirmed. Try connecting it again.`,
        });
        return;
      }
      setConnectionNotice({
        tone: "success",
        message: `${platformName} is connected. Vayada is importing the available statistics.`,
      });
      return;
    }

    const authorization = await creatorService.getPendingPlatformAuthorization({ signal });
    if (!authorization || authorization.authorizationId !== callback.authorizationId) {
      setConnectionNotice({
        tone: "error",
        message: `The ${platformName} account selection expired. Start the connection again.`,
      });
      return;
    }
    setPendingAuthorization(authorization);
  };

  const handleRetryPlatformConnections = async () => {
    if (readCreatorPlatformCallback()) {
      window.location.reload();
      return;
    }
    setConnectionNotice(null);
    try {
      await refreshCreatorPlatformData();
    } catch {
      // The persistent connection error provides the retry state.
    }
  };

  const handleConnectPlatform = async (platform: CreatorPlatformProvider, platformId?: string) => {
    if (platformConnections === null) return;
    setError("");
    setConnectionNotice(null);
    setConnectingPlatform(platform);
    sessionStorage.setItem(
      CREATOR_PLATFORM_DRAFT_KEY,
      JSON.stringify({
        form: creatorForm.form,
        platforms: creatorForm.platforms,
        managePlatforms: managingPlatforms,
      }),
    );
    try {
      const { authorizationUrl } = await creatorService.startPlatformAuthorization(
        platform,
        platformId,
      );
      window.location.assign(authorizationUrl);
    } catch (err) {
      sessionStorage.removeItem(CREATOR_PLATFORM_DRAFT_KEY);
      setConnectionNotice({
        tone: "error",
        message: creatorPlatformErrorMessage(
          err,
          "The platform connection could not be started. Try again or enter it manually.",
        ),
      });
      setConnectingPlatform(null);
    }
  };

  const handleSelectAuthorizedAccount = async (externalAccountId: string) => {
    if (!pendingAuthorization || platformConnections === null) return;
    const pendingPlatform = pendingAuthorization.platform;
    setSelectingExternalAccountId(externalAccountId);
    setConnectionNotice(null);
    try {
      await creatorService.selectPlatformAuthorizationAccount(
        pendingAuthorization.authorizationId,
        externalAccountId,
      );
      setPendingAuthorization(null);
      await refreshCreatorPlatformData();
      setConnectionNotice({
        tone: "success",
        message: `${creatorPlatformDisplayName(pendingPlatform)} is connected. The available statistics were imported.`,
      });
    } catch (err) {
      setConnectionNotice({
        tone: "error",
        message: creatorPlatformErrorMessage(
          err,
          "The account could not be connected. Please try again.",
        ),
      });
    } finally {
      setSelectingExternalAccountId(null);
    }
  };

  const handleSyncConnection = async (connectionId: string) => {
    if (platformConnections === null) return;
    setBusyConnectionId(connectionId);
    setConnectionNotice(null);
    try {
      await creatorService.syncPlatformConnection(connectionId);
      await refreshCreatorPlatformData();
      setConnectionNotice({
        tone: "success",
        message: "The latest available statistics were imported.",
      });
    } catch (err) {
      setConnectionNotice({
        tone: "error",
        message: creatorPlatformErrorMessage(
          err,
          "The account could not be synced. Please try again.",
        ),
      });
    } finally {
      setBusyConnectionId(null);
    }
  };

  const handleDisconnectConnection = async (connectionId: string) => {
    if (platformConnections === null) return;
    if (!window.confirm("Disconnect this account and stop importing its statistics?")) return;
    setBusyConnectionId(connectionId);
    setConnectionNotice(null);
    try {
      await creatorService.disconnectPlatformConnection(connectionId);
      setPlatformConnections(
        (current) =>
          current?.filter((connection) => connection.connectionId !== connectionId) ?? null,
      );
      setConnectionNotice({ tone: "success", message: "The account was disconnected." });
    } catch (err) {
      setConnectionNotice({
        tone: "error",
        message: creatorPlatformErrorMessage(
          err,
          "The account could not be disconnected. Please try again.",
        ),
      });
    } finally {
      setBusyConnectionId(null);
    }
  };

  const loadProfileStatus = async (
    type: "creator" | "hotel",
    skipRedirect = false,
    manageLoading = true,
    signal?: AbortSignal,
  ): Promise<CreatorProfileStatus | HotelProfileStatus | null> => {
    if (manageLoading) setLoading(true);
    setProfileStatusLoadFailed(false);
    try {
      const status = await checkProfileStatus(type, { signal });
      setProfileStatus(status);
      if (status?.profile_complete && !skipRedirect && !profileCompleted) {
        setProfileCompleted(true);
      }
      return status;
    } catch (err) {
      if (signal?.aborted) throw err;
      console.error("Failed to load profile status:", err);
      setProfileStatusLoadFailed(true);
      setError(
        err instanceof ApiErrorResponse
          ? formatErrorDetail(err.data.detail) || "Failed to load profile status."
          : "Failed to load profile status. Please try again.",
      );
      return null;
    } finally {
      if (manageLoading) setLoading(false);
    }
  };

  const nextStep = () => {
    const steps = userType === "creator" ? creatorSteps : hotelSteps;
    if (currentStep < steps.length) {
      if (userType === "hotel") hotelForm.expandAllListings();
      setCurrentStep(currentStep + 1);
      setError("");
    }
  };

  const prevStep = () => {
    if (managingPlatforms && currentStep === 3) {
      router.push(ROUTES.PROFILE);
      return;
    }
    if (currentStep > 1) {
      if (userType === "hotel") hotelForm.expandAllListings();
      setCurrentStep(currentStep - 1);
      setError("");
    }
  };

  const canProceedToNextStep = (): boolean => {
    if (userType === "creator") {
      if (currentStep === 1) return creatorForm.canProceedCreatorType();
      if (currentStep === 2) return creatorForm.canProceedStep1();
      return true;
    }
    if (userType === "hotel") {
      if (activeHotelSection === "public_profile") {
        return (
          hotelForm.canProceedStep1(true) &&
          (!requiresExistingOfferCoverSelection || Boolean(existingOfferCoverPicker.file))
        );
      }
      if (activeHotelSection === "creator_profile") return hotelForm.canProceedStep1(false);
      if (activeHotelSection === "offer_details") return hotelForm.canProceedListingStep("details");
      if (activeHotelSection === "offerings") return hotelForm.canProceedListingStep("offerings");
      return hotelForm.canProceedListingStep("requirements");
    }
    return false;
  };

  const handleCreatorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (platformConnections === null) {
      setPlatformConnectionsError(PLATFORM_CONNECTIONS_LOAD_ERROR);
      return;
    }
    if (!creatorForm.validateForm()) return;

    setSubmitting(true);
    try {
      const platforms = creatorForm.platforms.map(toCreatorPlatformUpdate);
      const platformsChanged = JSON.stringify(platforms) !== initialCreatorPlatformsSignature;
      const identityPhotoPatch = creatorIdentityPhotoPatch(
        authService.getSessionUser(),
        creatorProfilePhotoRef.current,
      );
      const updatePayload = {
        name: creatorForm.form.name,
        location: creatorForm.form.location,
        ...(platformsChanged && { platforms }),
        creatorType: creatorForm.form.creator_type,
        portfolioLink: creatorForm.form.portfolio_link.trim() || null,
        ...(creatorForm.form.short_description?.trim() && {
          shortDescription: creatorForm.form.short_description.trim(),
        }),
        ...(creatorForm.form.phone?.trim() && { phone: creatorForm.form.phone.trim() }),
        ...identityPhotoPatch,
      };

      const updatedProfile = await creatorService.updateMyProfile(updatePayload);
      creatorProfilePhotoRef.current = {
        profilePicture: updatedProfile.profilePicture,
        profilePictureMediaObjectId: updatedProfile.profilePictureMediaObjectId,
      };
      if (platformsChanged) setInitialCreatorPlatformsSignature(JSON.stringify(platforms));

      const complete = await isProfileComplete("creator");
      if (complete) {
        localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "true");
        if (managingPlatforms) {
          router.push(ROUTES.PROFILE);
          return;
        }
        setReviewingConnectionCallback(false);
        setProfileCompleted(true);
      } else {
        const updatedStatus = await loadProfileStatus("creator", true);
        handleIncompleteProfile(updatedStatus as CreatorProfileStatus);
      }
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        setError(formatErrorDetail(err.data.detail) || "Failed to update profile");
      } else {
        setError("Failed to update profile. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleHotelSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (
      !hotelForm.validateForm({
        validateProfile:
          activeHotelTaskFlow.submitPublicProfile || activeHotelTaskFlow.submitMarketplaceProfile,
        requireLocalityConsent: activeHotelTaskFlow.submitPublicProfile,
        validateOffers: activeHotelTaskFlow.submitOffers,
        profileFieldName: activeHotelTaskFlow.submitPublicProfile
          ? "Public hotel description"
          : undefined,
      })
    ) {
      return;
    }
    const propertyId = marketplacePropertyIdRef.current;
    const revisions = hotelProfileRevisionsRef.current;
    if (!propertyId || !hotelTaskHandoff) {
      setError("Marketplace setup is missing its hotel. Return to setup and try again.");
      return;
    }
    if (activeHotelTaskFlow.submitPublicProfile && !revisions) {
      setError("Marketplace setup is missing the hotel profile revision. Refresh and try again.");
      return;
    }

    setSubmitting(true);
    try {
      let submissionListings = activeHotelTaskFlow.submitOffers
        ? hotelForm.listings.map(ensureHotelMarketplaceOfferIdempotency)
        : [];
      if (activeHotelTaskFlow.submitOffers) {
        hotelForm.setListings(submissionListings);
        saveHotelMarketplaceDraft(
          localStorage,
          propertyId,
          createHotelMarketplaceDraft(hotelForm.form, submissionListings, currentStep),
        );
      }
      if (activeHotelTaskFlow.ensureCover) {
        submissionListings = await ensureCanonicalHotelCover(submissionListings, propertyId);
      }
      if (activeHotelTaskFlow.submitPublicProfile) {
        await hotelService.updatePublicSetupProfile(
          {
            about: hotelForm.form.about.trim(),
            localityPublic: hotelForm.form.localityPublic,
          },
          propertyId,
          hotelProfileRevisionsRef.current!,
        );
      }
      if (activeHotelTaskFlow.submitMarketplaceProfile) {
        await hotelService.updateMarketplaceHostSummary(hotelForm.form.about.trim(), propertyId);
      }

      if (activeHotelTaskFlow.submitOffers) {
        for (const listing of submissionListings) {
          const onboarding = listing.marketplaceOnboarding!;
          if (
            onboarding.createdOfferId &&
            onboarding.mediaPending !== true &&
            !onboarding.existingOffer
          ) {
            continue;
          }
          const offerings = buildListingOfferings(listing);
          let imageUrls = listing.images.filter((img) => !img.startsWith("data:"));
          let imageMediaObjectIds = listing.imageMediaObjectIds ?? [];

          if (imageUrls.length === 0 && !listing.imageFiles?.length) {
            setError(`Offer "${listing.name}": At least one image is required`);
            setSubmitting(false);
            return;
          }

          const offerPayload = {
            name: listing.name,
            location: listing.location,
            description: listing.description,
            accommodation_type: listing.accommodation_type || undefined,
            images: imageUrls,
            image_media_object_ids: imageMediaObjectIds,
            deliverables: listing.platforms.map((platform) => ({
              platform,
              deliverable_type: "content",
              quantity: 1,
              timing_guidance: null,
            })),
            collaboration_offerings: offerings,
            creator_requirements: buildCreatorRequirements(listing),
          };
          let createdOfferId = onboarding.createdOfferId;
          let mediaResourceId = onboarding.createdOfferMediaResourceId;

          const copiedImageUrls = imageUrls.slice(imageMediaObjectIds.length);
          const mediaPending = copiedImageUrls.length > 0 || Boolean(listing.imageFiles?.length);
          if (!createdOfferId) {
            const createdListing = await hotelService.createListing(offerPayload, propertyId, {
              idempotencyKey: onboarding.idempotencyKey,
            });
            createdOfferId = createdListing.id;
            mediaResourceId = createdListing.media_resource_id;
            const progress = {
              idempotencyKey: onboarding.idempotencyKey,
              createdOfferId,
              createdOfferMediaResourceId: mediaResourceId,
              mediaPending,
            };
            markHotelMarketplaceDraftOfferProgress(
              localStorage,
              propertyId,
              onboarding.idempotencyKey,
              progress,
            );
            hotelForm.setListings((current) =>
              current.map((currentListing) =>
                currentListing.marketplaceOnboarding?.idempotencyKey === onboarding.idempotencyKey
                  ? { ...currentListing, marketplaceOnboarding: progress }
                  : currentListing,
              ),
            );
          } else {
            await hotelService.updateListing(createdOfferId, offerPayload, propertyId);
          }

          if (mediaPending) {
            try {
              if (!mediaResourceId) {
                throw new Error("The listing media resource is unavailable");
              }
              const uploadResponse = await hotelService.uploadListingImagesFromSources(
                copiedImageUrls,
                listing.imageFiles ?? [],
                mediaResourceId,
              );
              imageUrls = [
                ...imageUrls.slice(0, imageMediaObjectIds.length),
                ...uploadResponse.images.map((img) => img.url),
              ];
              imageMediaObjectIds = [
                ...imageMediaObjectIds,
                ...uploadResponse.images.map((img) => img.mediaObjectId),
              ];

              await hotelService.updateListing(
                createdOfferId,
                {
                  images: imageUrls,
                  image_media_object_ids: imageMediaObjectIds,
                },
                propertyId,
              );
            } catch (err) {
              if (err instanceof CanonicalHotelPhotoReuseError) {
                const recoveryProgress = {
                  idempotencyKey: onboarding.idempotencyKey,
                  createdOfferId,
                  ...(mediaResourceId ? { createdOfferMediaResourceId: mediaResourceId } : {}),
                  mediaPending: true,
                };
                const recoverListing = (currentListing: ListingFormData) =>
                  currentListing.marketplaceOnboarding?.idempotencyKey === onboarding.idempotencyKey
                    ? recoverHotelMarketplaceOfferFromSourceMediaFailure(
                        currentListing,
                        copiedImageUrls,
                        recoveryProgress,
                      )
                    : currentListing;

                hotelForm.setListings((current) => current.map(recoverListing));
                const latestDraft = readHotelMarketplaceDraft(localStorage, propertyId);
                const recoveredDraft = latestDraft
                  ? recoverHotelMarketplaceDraftFromSourceMediaFailure(
                      latestDraft,
                      onboarding.idempotencyKey,
                      copiedImageUrls,
                      recoveryProgress,
                    )
                  : createHotelMarketplaceDraft(
                      hotelForm.form,
                      submissionListings.map(recoverListing),
                      1,
                    );
                saveHotelMarketplaceDraft(localStorage, propertyId, recoveredDraft);
                setCurrentStep(1);
                setError(
                  `We couldn't reuse the shared hotel photo for offer "${listing.name}". Please upload the photo manually to continue.`,
                );
              } else if (err instanceof ApiErrorResponse) {
                setError(
                  formatErrorDetail(err.data.detail) ||
                    `Failed to upload images for offer "${listing.name}"`,
                );
              } else {
                setError(`Failed to upload images for offer "${listing.name}". Please try again.`);
              }
              setSubmitting(false);
              return;
            }
          }

          const completedProgress = {
            idempotencyKey: onboarding.idempotencyKey,
            createdOfferId,
            ...(mediaResourceId ? { createdOfferMediaResourceId: mediaResourceId } : {}),
            mediaPending: false,
            ...(onboarding.existingOffer ? { existingOffer: true } : {}),
          };
          markHotelMarketplaceDraftOfferProgress(
            localStorage,
            propertyId,
            onboarding.idempotencyKey,
            completedProgress,
          );
          hotelForm.setListings((current) =>
            current.map((currentListing) =>
              currentListing.marketplaceOnboarding?.idempotencyKey === onboarding.idempotencyKey
                ? { ...currentListing, marketplaceOnboarding: completedProgress }
                : currentListing,
            ),
          );
        }
      }

      if (activeHotelTaskFlow.submitOffers) {
        clearHotelMarketplaceDraft(localStorage, propertyId);
      }
      window.location.href = hotelTaskHandoff.returnUrl;
    } catch (err) {
      if (err instanceof HotelCoverPhotoRequiredError) {
        setExistingOfferCoverPicker((current) => ({
          ...current,
          previewUrl: null,
        }));
        setError(err.message);
      } else if (err instanceof CanonicalHotelPhotoReuseError) {
        if (hasExistingMarketplaceOffer) {
          setExistingMarketplaceOfferCoverUrl(null);
          setCurrentStep(1);
          setExistingOfferCoverPicker({
            file: null,
            previewUrl: null,
          });
          setError(
            "We couldn't reuse the existing offer photo as your hotel cover. Choose a replacement in the Public hotel cover section.",
          );
        } else {
          setCurrentStep(Math.min(currentStep, 2));
          setError(
            "We couldn't reuse the first offer photo as your hotel cover. Please select the photo again.",
          );
        }
      } else if (err instanceof ApiErrorResponse) {
        setError(
          err.data.code === "profile_revision_conflict"
            ? "This hotel profile changed in another tab. Refresh the page before choosing the cover photo again."
            : formatErrorDetail(err.data.detail) || err.message || "Failed to update profile",
        );
      } else {
        setError("Failed to update profile. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleIncompleteProfile = (status: CreatorProfileStatus | HotelProfileStatus | null) => {
    if (!status || status.profile_complete) {
      setError(
        "Profile updated, but some fields may still be missing. Please check the requirements.",
      );
      return;
    }
    const { missing_fields = [], completion_steps = [] } = status;
    let errorMessage =
      "Profile updated successfully, but some required information is still missing:\n\n";
    if (completion_steps.length > 0) {
      errorMessage += completion_steps
        .slice(0, 5)
        .map((step, idx) => `${idx + 1}. ${step}`)
        .join("\n");
      if (completion_steps.length > 5) {
        errorMessage += `\n...and ${completion_steps.length - 5} more requirement${completion_steps.length - 5 > 1 ? "s" : ""}`;
      }
    } else if (missing_fields.length > 0) {
      errorMessage += "Missing fields: " + missing_fields.join(", ");
    } else {
      errorMessage += "Please review all sections and ensure all required fields are completed.";
    }
    setError(errorMessage);
  };

  const buildListingOfferings = (listing: (typeof hotelForm.listings)[0]) => {
    const offerings: Array<{
      collaboration_type: "Free Stay" | "Paid" | "Discount" | "Affiliate";
      availability_months: string[];
      platforms: string[];
      free_stay_min_nights?: number;
      free_stay_max_nights?: number;
      paid_max_amount?: number;
      currency?: string;
      discount_percentage?: number;
      commission_percentage?: number;
    }> = [];

    if (listing.collaborationTypes.includes("Free Stay")) {
      offerings.push({
        collaboration_type: "Free Stay",
        availability_months: listing.availability,
        platforms: listing.platforms,
        free_stay_min_nights: listing.freeStayMinNights,
        free_stay_max_nights: listing.freeStayMaxNights,
      });
    }
    if (listing.collaborationTypes.includes("Paid")) {
      offerings.push({
        collaboration_type: "Paid",
        availability_months: listing.availability,
        platforms: listing.platforms,
        paid_max_amount: listing.paidMaxAmount,
        currency: listing.currency || "USD",
      });
    }
    if (listing.collaborationTypes.includes("Discount")) {
      offerings.push({
        collaboration_type: "Discount",
        availability_months: listing.availability,
        platforms: listing.platforms,
        discount_percentage: listing.discountPercentage,
      });
    }
    if (listing.collaborationTypes.includes("Affiliate")) {
      offerings.push({
        collaboration_type: "Affiliate",
        availability_months: listing.availability,
        platforms: listing.platforms,
        commission_percentage: listing.commissionPercentage,
      });
    }
    return offerings;
  };

  const buildCreatorRequirements = (listing: (typeof hotelForm.listings)[0]) => {
    const ageGroups = listing.targetGroupAgeGroups || [];
    let targetAgeMin: number | undefined;
    let targetAgeMax: number | undefined;

    if (ageGroups.length > 0) {
      let min = Infinity,
        max = -Infinity,
        has55Plus = false;
      ageGroups.forEach((g) => {
        if (g === "18-24") {
          min = Math.min(min, 18);
          max = Math.max(max, 24);
        } else if (g === "25-34") {
          min = Math.min(min, 25);
          max = Math.max(max, 34);
        } else if (g === "35-44") {
          min = Math.min(min, 35);
          max = Math.max(max, 44);
        } else if (g === "45-54") {
          min = Math.min(min, 45);
          max = Math.max(max, 54);
        } else if (g === "55+") {
          min = Math.min(min, 55);
          has55Plus = true;
        }
      });
      targetAgeMin = min === Infinity ? undefined : min;
      targetAgeMax = has55Plus ? undefined : max === -Infinity ? undefined : max;
    } else {
      targetAgeMin = listing.targetGroupAgeMin;
      targetAgeMax = listing.targetGroupAgeMax;
    }

    return {
      platforms: listing.lookingForPlatforms,
      target_countries: listing.targetGroupCountries,
      target_age_min: targetAgeMin,
      target_age_max: targetAgeMax,
      target_age_groups: ageGroups,
      creator_types: listing.lookingForCreatorTypes ?? [],
    };
  };

  if (loading) return <LoadingScreen />;
  if (!userType) return null;
  if (userType !== "creator" && userType !== "hotel") return null;
  if (profileStatusLoadFailed) {
    if (userType === "hotel") {
      return (
        <HotelMarketplaceSetupLayout
          steps={hotelSteps}
          currentStep={currentStep}
          activeSection={activeHotelSection}
          returnUrl={hotelTaskHandoff?.returnUrl}
        >
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {error || "Failed to load Marketplace setup. Please refresh the page."}
          </div>
        </HotelMarketplaceSetupLayout>
      );
    }

    return (
      <OnboardingShell
        currentStep={2}
        title={profileShellTitle(userType)}
        description={profileShellDescription(userType)}
        compact
        showProgress={false}
      >
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error || "Failed to load profile status. Please refresh the page."}
        </div>
      </OnboardingShell>
    );
  }
  const effectiveProfileStatus = profileStatus ?? emptyProfileStatus(userType);

  if (
    profileCompleted ||
    (effectiveProfileStatus.profile_complete && !reviewingConnectionCallback && !managingPlatforms)
  ) {
    return (
      <ProfileCompletionScreen
        userType={userType}
        onGoHome={() => router.push(ROUTES.MARKETPLACE)}
        onEditProfile={() => router.push(ROUTES.PROFILE)}
      />
    );
  }

  const steps = userType === "creator" ? creatorSteps : hotelSteps;
  const totalSteps = steps.length;
  const isCreatorCategoryStep = userType === "creator" && currentStep === 1;
  const isCreatorAboutStep = userType === "creator" && currentStep === 2;
  const isCreatorPlatformsStep = userType === "creator" && currentStep === 3;
  const platformActionsDisabled =
    platformConnections === null ||
    connectingPlatform !== null ||
    busyConnectionId !== null ||
    selectingExternalAccountId !== null;
  const creatorFirstName = splitSharedAccountName(creatorForm.form.name).firstName;
  const creatorCategoryTitle = creatorFirstName
    ? `Hi, ${creatorFirstName}! What kind of creator are you?`
    : "Which creator type are you?";
  const creatorProfileTitle =
    currentStep === 2 ? "Tell hotels about your work" : "Show hotels your reach";
  const creatorProfileDescription =
    currentStep === 2
      ? ""
      : "Add the audience and platform details hotels use to assess a collaboration.";

  if (userType === "hotel") {
    return (
      <HotelMarketplaceSetupLayout
        steps={hotelSteps}
        currentStep={currentStep}
        activeSection={activeHotelSection}
        returnUrl={hotelTaskHandoff?.returnUrl}
      >
        <HotelProfileForm
          form={hotelForm.form}
          listings={hotelForm.listings}
          currentStep={currentStep}
          totalSteps={totalSteps}
          activeSection={activeHotelSection}
          error={error}
          submitting={submitting}
          canProceed={canProceedToNextStep()}
          collapsedCards={hotelForm.collapsedCards}
          countryInputs={hotelForm.countryInputs}
          countries={hotelForm.countries}
          showCoverPhotoPicker={showExistingOfferCoverPicker}
          coverPhotoPreview={existingOfferCoverPicker.previewUrl}
          coverPhotoRequired={requiresExistingOfferCoverSelection}
          hasSelectedCoverPhoto={Boolean(existingOfferCoverPicker.file)}
          showLocalityConsent={activeHotelSection === "public_profile"}
          submitLabel={
            activeHotelSection === "public_profile"
              ? "Save public profile"
              : activeHotelSection === "creator_profile"
                ? "Save creator profile"
                : "Save collaboration offer"
          }
          imageInputRefs={hotelForm.listingImageInputRefs}
          coverPhotoInputRef={existingOfferCoverInputRef}
          onFormChange={hotelForm.handleFormChange}
          onCoverPhotoChange={handleExistingOfferCoverChange}
          onClearCoverPhoto={clearExistingOfferCoverSelection}
          onToggleCollapse={hotelForm.toggleListingCollapse}
          onUpdateListing={hotelForm.updateListing}
          onImageChange={hotelForm.handleListingImageChange}
          onRemoveImage={hotelForm.removeListingImage}
          onCountryInputChange={hotelForm.handleCountryInputChange}
          onPrevStep={prevStep}
          onNextStep={nextStep}
          onSubmit={handleHotelSubmit}
        />
      </HotelMarketplaceSetupLayout>
    );
  }

  return (
    <OnboardingShell
      currentStep={2}
      title={isCreatorCategoryStep ? creatorCategoryTitle : creatorProfileTitle}
      description={isCreatorCategoryStep ? "" : creatorProfileDescription}
      compact={!isCreatorCategoryStep}
      centerContent={isCreatorAboutStep || isCreatorPlatformsStep}
      showProgress={false}
      wideContent={isCreatorCategoryStep}
    >
      <div
        className={
          isCreatorCategoryStep
            ? "mx-auto w-full xl:pt-5"
            : isCreatorAboutStep
              ? "mx-auto w-full max-w-2xl space-y-2"
              : isCreatorPlatformsStep
                ? "mx-auto w-full max-w-2xl space-y-2"
                : "space-y-2"
        }
      >
        {!isCreatorCategoryStep && <StepIndicators steps={steps} currentStep={currentStep} />}

        <div
          className={
            isCreatorCategoryStep
              ? ""
              : "overflow-hidden rounded-3xl border border-gray-100 bg-white shadow-[0_24px_80px_-50px_rgba(15,23,42,0.55)]"
          }
        >
          {/* Forms */}
          <CreatorProfileForm
            form={creatorForm.form}
            platforms={creatorForm.platforms}
            currentStep={currentStep}
            totalSteps={totalSteps}
            error={error}
            submitting={submitting}
            canProceed={canProceedToNextStep()}
            expandedPlatforms={creatorForm.expandedPlatforms}
            platformCountryInputs={creatorForm.platformCountryInputs}
            connections={platformConnections ?? []}
            connectionsLoading={platformConnections === null && !platformConnectionsError}
            connectionsError={platformConnectionsError}
            platformActionsDisabled={platformActionsDisabled}
            pendingAuthorization={pendingAuthorization}
            connectionNotice={connectionNotice}
            connectingPlatform={connectingPlatform}
            busyConnectionId={busyConnectionId}
            selectingExternalAccountId={selectingExternalAccountId}
            onFormChange={creatorForm.handleFormChange}
            onAddPlatform={creatorForm.addPlatform}
            onConnectPlatform={handleConnectPlatform}
            onSyncConnection={handleSyncConnection}
            onDisconnectConnection={handleDisconnectConnection}
            onSelectAuthorizedAccount={handleSelectAuthorizedAccount}
            onRetryConnections={handleRetryPlatformConnections}
            onRemovePlatform={creatorForm.removePlatform}
            onUpdatePlatform={creatorForm.updatePlatform}
            onTogglePlatformExpanded={creatorForm.togglePlatformExpanded}
            onCountryInputChange={creatorForm.handleCountryInputChange}
            onAddCountry={creatorForm.addCountryFromInput}
            onRemoveCountry={creatorForm.removeCountry}
            onUpdateCountryPercentage={creatorForm.updateCountryPercentage}
            getAvailableCountries={creatorForm.getAvailableCountries}
            onToggleAgeGroup={creatorForm.toggleAgeGroup}
            onUpdateGenderSplit={creatorForm.updateGenderSplit}
            onPrevStep={prevStep}
            onNextStep={nextStep}
            onSubmit={handleCreatorSubmit}
            submitLabel={managingPlatforms ? "Save platform changes" : undefined}
          />
        </div>
      </div>
    </OnboardingShell>
  );
}

function HotelMarketplaceSetupLayout({
  steps,
  currentStep,
  activeSection,
  returnUrl,
  children,
}: {
  steps: string[];
  currentStep: number;
  activeSection: import("./hotelTaskFlow").HotelTaskSection;
  returnUrl?: string;
  children: React.ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const currentTitle = steps[currentStep - 1] ?? steps[0];
  const currentDescription =
    activeSection === "public_profile"
      ? "Add the description, locality visibility, and cover used across Vayada’s public surfaces."
      : activeSection === "creator_profile"
        ? "Write the short introduction creators will see on your Marketplace profile."
        : activeSection === "offer_details"
          ? "Give creators a clear title, short description, and photos of the experience."
          : activeSection === "offerings"
            ? "Choose how you want to collaborate, when the offer is available, and where creators should publish content."
            : "Choose the creator platforms and audience fit that best match this collaboration.";

  useEffect(() => {
    headingRef.current?.focus();
  }, [currentStep]);

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b border-gray-200 bg-white px-4 py-3 sm:px-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-600 text-white">
              <CheckIcon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="text-[15px] font-semibold text-gray-900">
              Creator Marketplace Setup
            </span>
          </div>
          <div className="flex items-center gap-4">
            {returnUrl && (
              <a
                href={returnUrl}
                className="text-xs font-semibold text-primary-700 hover:text-primary-800"
              >
                Back to setup plan
              </a>
            )}
            <span className="whitespace-nowrap text-xs text-gray-500 sm:text-[13px]">
              Step {currentStep} of {steps.length}
            </span>
          </div>
        </div>
      </header>

      <div className="h-[3px] bg-gray-100" aria-hidden="true">
        <div
          className="h-full bg-primary-600 transition-all duration-300"
          style={{ width: `${(currentStep / steps.length) * 100}%` }}
        />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <HotelMarketplaceStepIndicators steps={steps} currentStep={currentStep} />
        <header className="mx-auto max-w-2xl text-center">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight text-gray-950 outline-none"
          >
            {currentTitle}
          </h1>
          <p className="mt-2 text-sm text-gray-500">{currentDescription}</p>
        </header>
        <div className="mx-auto mt-4 max-w-3xl">{children}</div>
      </div>
    </main>
  );
}

function HotelMarketplaceStepIndicators({
  steps,
  currentStep,
}: {
  steps: string[];
  currentStep: number;
}) {
  return (
    <ol
      className="mb-5 flex items-center justify-center sm:mb-6"
      aria-label="Creator Marketplace setup progress"
    >
      {steps.map((step, index) => {
        const stepNumber = index + 1;
        const isComplete = currentStep > stepNumber;
        const isActive = currentStep === stepNumber;
        return (
          <li key={step} className="flex items-center" aria-current={isActive ? "step" : undefined}>
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition-colors ${
                  isComplete || isActive ? "bg-primary-600 text-white" : "bg-gray-200 text-gray-500"
                }`}
              >
                {isComplete ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : stepNumber}
              </span>
              <span
                className={`sr-only whitespace-nowrap text-xs font-medium lg:not-sr-only ${
                  isComplete || isActive ? "text-gray-900" : "text-gray-400"
                }`}
              >
                {step}
              </span>
            </span>
            {index < steps.length - 1 && (
              <span
                className={`mx-2 h-px w-8 shrink-0 sm:mx-3 sm:w-10 lg:w-14 ${
                  isComplete ? "bg-primary-600" : "bg-gray-300"
                }`}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function toCreatorPlatformUpdate(platform: PlatformFormData) {
  const validAgeGroups =
    platform.top_age_groups
      ?.filter((tag) => tag.ageRange?.trim())
      .map((tag) => ({ ageRange: tag.ageRange.trim(), percentage: tag.percentage })) || [];

  return {
    id: platform.id ?? null,
    name: platform.name,
    handle: platform.handle,
    ...(platform.profile_url !== undefined
      ? { profileUrl: platform.profile_url.trim() || null }
      : {}),
    followers: Number(platform.followers),
    engagementRate: Number(platform.engagement_rate),
    ...(platform.top_countries !== undefined
      ? {
          topCountries: platform.top_countries.map((country) => ({
            country: country.country,
            percentage: country.percentage,
          })),
        }
      : {}),
    ...(platform.top_age_groups !== undefined ? { topAgeGroups: validAgeGroups } : {}),
    ...(platform.gender_split !== undefined ? { genderSplit: platform.gender_split } : {}),
  };
}

function toPlatformFormData(platform: Platform): PlatformFormData {
  return {
    id: platform.id,
    name: platform.name,
    handle: platform.handle,
    profile_url: platform.profileUrl ?? "",
    followers: platform.followers,
    engagement_rate: platform.engagementRate,
    top_countries: platform.topCountries,
    top_age_groups: platform.topAgeGroups,
    gender_split: platform.genderSplit,
  };
}

function readCreatorPlatformCallback(): CreatorPlatformCallback | null {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("connection");
  const platform = params.get("platform");
  if (status !== "success" && status !== "select" && status !== "error") {
    return null;
  }
  if (
    platform !== "instagram" &&
    platform !== "tiktok" &&
    platform !== "youtube" &&
    platform !== "facebook"
  ) {
    return null;
  }
  return {
    status,
    platform,
    authorizationId: params.get("authorization_id"),
    connectionId: params.get("connection_id"),
  };
}

function clearCreatorPlatformCallback(managePlatforms: boolean): void {
  const url = new URL(window.location.href);
  for (const key of ["connection", "platform", "authorization_id", "connection_id", "error_code"]) {
    url.searchParams.delete(key);
  }
  if (managePlatforms) url.searchParams.set("manage-platforms", "1");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function readCreatorPlatformDraft(): CreatorPlatformDraft | null {
  const stored = sessionStorage.getItem(CREATOR_PLATFORM_DRAFT_KEY);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<CreatorPlatformDraft>;
    if (!parsed.form || !Array.isArray(parsed.platforms)) return null;
    return parsed as CreatorPlatformDraft;
  } catch {
    return null;
  }
}

function creatorPlatformDisplayName(platform: CreatorPlatformProvider): string {
  if (platform === "instagram") return "Instagram";
  if (platform === "tiktok") return "TikTok";
  if (platform === "youtube") return "YouTube";
  return "Facebook";
}

function creatorPlatformErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiErrorResponse)) return fallback;
  return formatErrorDetail(error.data.detail) || fallback;
}

function profileShellTitle(userType: "creator" | "hotel"): string {
  return userType === "creator" ? "Create your creator profile" : "Set up Creator Marketplace";
}

function profileShellDescription(userType: "creator" | "hotel"): string {
  return userType === "creator"
    ? "Build the profile hotels use to decide whether to collaborate with you."
    : "Introduce your hotel to creators, then create your first collaboration offer.";
}

function newMarketplaceOffer(profile: HotelProfile): ListingFormData {
  return ensureHotelMarketplaceOfferIdempotency({
    name: "",
    location: profile.location,
    description: "",
    accommodation_type: profile.propertyType ?? "",
    // Reuse the canonical hotel hero by default so Marketplace activation does
    // not ask the hotel to upload the same property photo a second time.
    images: initialHotelMarketplaceOfferImages(profile.picture),
    imageMediaObjectIds: [],
    imageFiles: [],
    collaborationTypes: [],
    availability: [],
    platforms: [],
    lookingForPlatforms: [],
    targetGroupCountries: [],
    targetGroupAgeGroups: [],
  });
}

function existingMarketplaceOfferDraft(listing: HotelListing): ListingFormData {
  const offerings = listing.collaboration_offerings;
  return ensureHotelMarketplaceOfferIdempotency({
    name: listing.name,
    location: listing.location,
    description: listing.description,
    accommodation_type: listing.accommodation_type ?? "",
    images: listing.images,
    imageMediaObjectIds: listing.image_media_object_ids ?? [],
    imageFiles: [],
    collaborationTypes: Array.from(
      new Set(offerings.map(({ collaboration_type }) => collaboration_type)),
    ),
    availability: Array.from(
      new Set(offerings.flatMap(({ availability_months }) => availability_months)),
    ),
    platforms: Array.from(new Set(offerings.flatMap(({ platforms }) => platforms))),
    freeStayMinNights:
      offerings.find(({ collaboration_type }) => collaboration_type === "Free Stay")
        ?.free_stay_min_nights ?? undefined,
    freeStayMaxNights:
      offerings.find(({ collaboration_type }) => collaboration_type === "Free Stay")
        ?.free_stay_max_nights ?? undefined,
    paidMaxAmount:
      offerings.find(({ collaboration_type }) => collaboration_type === "Paid")?.paid_max_amount ??
      undefined,
    currency:
      offerings.find(({ collaboration_type }) => collaboration_type === "Paid")?.currency ??
      undefined,
    discountPercentage:
      offerings.find(({ collaboration_type }) => collaboration_type === "Discount")
        ?.discount_percentage ?? undefined,
    commissionPercentage:
      offerings.find(({ collaboration_type }) => collaboration_type === "Affiliate")
        ?.commission_percentage ?? undefined,
    lookingForPlatforms: listing.creator_requirements.platforms,
    targetGroupCountries: listing.creator_requirements.target_countries,
    targetGroupAgeMin: listing.creator_requirements.target_age_min ?? undefined,
    targetGroupAgeMax: listing.creator_requirements.target_age_max ?? undefined,
    targetGroupAgeGroups: listing.creator_requirements.target_age_groups ?? [],
    lookingForCreatorTypes: (listing.creator_requirements.creator_types ??
      []) as ListingFormData["lookingForCreatorTypes"],
    marketplaceOnboarding: {
      idempotencyKey: `marketplace.hotel-offer.edit:${listing.id}:v1`,
      createdOfferId: listing.id,
      ...(listing.media_resource_id
        ? { createdOfferMediaResourceId: listing.media_resource_id }
        : {}),
      mediaPending: false,
      existingOffer: true,
    },
  });
}

function emptyProfileStatus(
  userType: "creator" | "hotel",
): CreatorProfileStatus | HotelProfileStatus {
  if (userType === "creator") {
    return {
      profile_photo_required: true,
      profile_complete: false,
      missing_fields: [],
      missing_platforms: true,
      completion_steps: [],
    };
  }
  return {
    profile_complete: false,
    missing_fields: [],
    has_defaults: { location: false },
    missing_offers: true,
    completion_steps: [],
  };
}

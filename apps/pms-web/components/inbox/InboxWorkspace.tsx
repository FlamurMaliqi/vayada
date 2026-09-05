"use client";
import { formatTimezoneLabel } from "@/lib/timezoneLabel";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  EllipsisHorizontalIcon,
  EnvelopeIcon,
  FunnelIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
  PaperAirplaneIcon,
  PaperClipIcon,
  SparklesIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  type ChangeEvent,
  forwardRef,
  type ForwardedRef,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import Modal from "@/components/Modal";
import { cn } from "@/lib/utils";
import { getPmsStaffRoster, type PmsStaffMember } from "@/services/api/pmsStaffClient";
import {
  getPmsPropertyProfile,
  resolveSelectedPmsPropertyId,
} from "@/services/api/pmsPropertyClient";
import { getAuthSessionUser } from "@/services/auth/sessionStore";
import {
  inboxError,
  messagingService,
  type InboxAssistanceResponse,
  type InboxAttentionState,
  type InboxChannel,
  type InboxDirectBooking,
  type InboxMessage,
  type InboxQuickReply,
  type InboxThread,
  type InboxThreadDetailResponse,
  type InboxTimelineItem,
} from "@/services/messaging";
import {
  type PmsInboxAttachmentUploadResult,
  uploadPmsInboxAttachment,
} from "@/services/platform-media";

import {
  formatFileSize,
  formatInboxDate,
  formatInboxDateTime,
  formatInboxTime,
  formatPropertyDateTimeInput,
  inboxContextLabel,
  inboxGuestName,
  inboxPreview,
  inboxRouteLabel,
  inboxSourceLabel,
  propertyLocalDateTimeToIso,
} from "./inboxFormat";
import { useTranslation } from "@/lib/i18n";

type ComposerMode = "reply" | "note";
type Draft = {
  reply: string;
  note: string;
  attachments: PmsInboxAttachmentUploadResult[];
  assisted: InboxAssistanceResponse | null;
};
type Drafts = Record<string, Draft>;
type Toast = { threadId: string; version: number; guestName: string };

const EMPTY_DRAFT: Draft = { reply: "", note: "", attachments: [], assisted: null };
const ATTENTION_OPTIONS: Array<{
  value: InboxAttentionState;
  labelKey: string;
  shortKey: string;
}> = [
  {
    value: "needs_attention",
    labelKey: "inbox.attentionNeedsAttention",
    shortKey: "inbox.attentionNeeds",
  },
  {
    value: "follow_up",
    labelKey: "inbox.attentionFollowUp",
    shortKey: "inbox.attentionFollowUp",
  },
  { value: "done", labelKey: "inbox.attentionDone", shortKey: "inbox.attentionDone" },
];

const ASSISTANCE_LANGUAGES = [
  { value: "English", labelKey: "inbox.languageEnglish" },
  { value: "German", labelKey: "inbox.languageGerman" },
  { value: "Spanish", labelKey: "inbox.languageSpanish" },
  { value: "French", labelKey: "inbox.languageFrench" },
  { value: "Italian", labelKey: "inbox.languageItalian" },
  { value: "Dutch", labelKey: "inbox.languageDutch" },
  { value: "Indonesian", labelKey: "inbox.languageIndonesian" },
] as const;

export default function InboxWorkspace() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const attentionState = parseAttentionState(searchParams.get("attentionState"));
  const unreadOnly = searchParams.get("unread") === "true";
  const channel = parseChannel(searchParams.get("channel"));
  const assignee = searchParams.get("assignee") || "";
  const selectedThreadId = searchParams.get("thread");
  const bookingFromUrl = searchParams.get("booking");

  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listAppending, setListAppending] = useState(false);
  const [listError, setListError] = useState<ReturnType<typeof inboxError> | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [search, setSearch] = useState("");
  const [serverSearch, setServerSearch] = useState("");
  const [reloadList, setReloadList] = useState(0);
  const [reloadCapabilities, setReloadCapabilities] = useState(0);

  const [detail, setDetail] = useState<InboxThreadDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<ReturnType<typeof inboxError> | null>(null);
  const [earlierLoading, setEarlierLoading] = useState(false);
  const [canReply, setCanReply] = useState<boolean | null>(null);
  const [staff, setStaff] = useState<PmsStaffMember[]>([]);
  const [quickReplies, setQuickReplies] = useState<InboxQuickReply[]>([]);
  const [propertyTimezone, setPropertyTimezone] = useState(browserTimeZone);
  const [currentUserEmail, setCurrentUserEmail] = useState("");

  const [composerMode, setComposerMode] = useState<ComposerMode>("reply");
  const [drafts, setDrafts] = useState<Drafts>({});
  const [composerBusy, setComposerBusy] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [summary, setSummary] = useState<InboxAssistanceResponse | null>(null);
  const [translations, setTranslations] = useState<Record<string, InboxAssistanceResponse>>({});
  const [assistBusy, setAssistBusy] = useState<string | null>(null);
  const [assistLanguage, setAssistLanguage] = useState("English");

  const [contextOpen, setContextOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [followUpAt, setFollowUpAt] = useState(() => defaultFollowUpTime(browserTimeZone()));
  const [quickManagerOpen, setQuickManagerOpen] = useState(false);
  const [directOpen, setDirectOpen] = useState(false);
  const [directBookings, setDirectBookings] = useState<InboxDirectBooking[]>([]);
  const [directBookingId, setDirectBookingId] = useState("");
  const [directLoading, setDirectLoading] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const [providerActionPendingThreads, setProviderActionPendingThreads] = useState<Set<string>>(
    () => new Set(),
  );
  const [mutationBusy, setMutationBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const queueRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusThreadId = useRef<string | null>(null);
  const restoreQueueFocus = useRef(false);
  const markedReadBoundary = useRef<string | null>(null);
  const listRequestSequence = useRef(0);
  const firstPageThreadIds = useRef<Set<string>>(new Set());
  const hasAppendedThreadPages = useRef(false);
  const detailRequestSequence = useRef(0);
  const capabilityRequestSequence = useRef(0);
  const directRequestSequence = useRef(0);
  const attachmentUploadInFlight = useRef(false);
  const mutationInFlight = useRef(false);
  const selectedThreadIdRef = useRef(selectedThreadId);
  selectedThreadIdRef.current = selectedThreadId;

  const draft = selectedThreadId ? (drafts[selectedThreadId] ?? EMPTY_DRAFT) : EMPTY_DRAFT;
  const activeDetail = detail?.thread.id === selectedThreadId ? detail : null;
  const providerActionPending = Boolean(
    selectedThreadId && providerActionPendingThreads.has(selectedThreadId),
  );
  const eligibleStaff = useMemo(
    () =>
      staff.filter(
        (member) =>
          member.status === "active" &&
          Boolean(propertyId && member.propertyIds.includes(propertyId)),
      ),
    [propertyId, staff],
  );
  const selfMembershipId = useMemo(
    () =>
      eligibleStaff.find((member) => member.email.toLowerCase() === currentUserEmail.toLowerCase())
        ?.id ?? null,
    [currentUserEmail, eligibleStaff],
  );
  const latestInbound = useMemo(
    () =>
      [...(activeDetail?.timeline ?? [])]
        .reverse()
        .find(
          (item): item is Extract<InboxTimelineItem, { kind: "message" }> =>
            item.kind === "message" && item.message.direction === "inbound",
        )?.message ?? null,
    [activeDetail?.timeline],
  );

  const updateUrl = useCallback(
    (changes: Record<string, string | null>, push = false) => {
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const destination = next.size ? `${pathname}?${next}` : pathname;
      if (push) router.push(destination, { scroll: false });
      else router.replace(destination, { scroll: false });
    },
    [pathname, router],
  );

  const clearPropertyData = useCallback(() => {
    listRequestSequence.current += 1;
    firstPageThreadIds.current.clear();
    hasAppendedThreadPages.current = false;
    detailRequestSequence.current += 1;
    capabilityRequestSequence.current += 1;
    directRequestSequence.current += 1;
    setThreads([]);
    setDetail(null);
    setDrafts({});
    setSummary(null);
    setTranslations({});
    setQuickReplies([]);
    setStaff([]);
    setDirectBookings([]);
    setDirectBookingId("");
    setSearch("");
    setServerSearch("");
    setCanReply(null);
    setComposerError(null);
    setUploadingName(null);
    setProviderActionPendingThreads(new Set());
    setFollowUpOpen(false);
    setQuickManagerOpen(false);
    setDirectOpen(false);
    setToast(null);
    setNotice(null);
    setCurrentUserEmail("");
    markedReadBoundary.current = null;
    updateUrl({ thread: null, booking: null });
  }, [updateUrl]);

  const loadDirectBookings = useCallback(
    async (id = propertyId) => {
      if (!id) return;
      const requestSequence = ++directRequestSequence.current;
      setDirectLoading(true);
      setDirectError(null);
      try {
        const bookings = await messagingService.listDirectBookings(id);
        if (requestSequence === directRequestSequence.current) setDirectBookings(bookings);
      } catch (error) {
        if (requestSequence !== directRequestSequence.current) return;
        const parsed = inboxError(error);
        if (isEntitlementOrResourceDenial(parsed)) {
          clearPropertyData();
          setAccessDenied(true);
        } else if (isReplyPermissionDenial(parsed)) {
          try {
            await messagingService.listThreads(id, { attentionState, limit: 1 });
            if (requestSequence !== directRequestSequence.current) return;
            setCanReply(false);
            setDirectOpen(false);
            setComposerError(t("inbox.errorReplyAccessRemovedInbox"));
          } catch {
            clearPropertyData();
            setAccessDenied(true);
          }
        } else {
          setDirectError(parsed.message);
        }
      } finally {
        if (requestSequence === directRequestSequence.current) setDirectLoading(false);
      }
    },
    [attentionState, clearPropertyData, propertyId, t],
  );

  useEffect(() => {
    let cancelled = false;
    void resolveSelectedPmsPropertyId(t("inbox.loadingContext"))
      .then((id) => {
        if (!cancelled) setPropertyId(id);
      })
      .catch((error) => {
        if (!cancelled) {
          setListError(inboxError(error));
          setListLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    if (!propertyId) return;
    setCurrentUserEmail(
      getAuthSessionUser()?.email ?? window.localStorage.getItem("userEmail") ?? "",
    );
    void getPmsPropertyProfile()
      .then((profile) => {
        const timeZone = profile.timezone || browserTimeZone();
        setPropertyTimezone(timeZone);
        setFollowUpAt(defaultFollowUpTime(timeZone));
      })
      .catch(() => setPropertyTimezone(browserTimeZone()));
  }, [propertyId]);

  useEffect(() => {
    const timer = window.setTimeout(() => setServerSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadThreads = useCallback(
    async (cursor?: string, silent = false) => {
      if (!propertyId) return;
      const requestSequence = ++listRequestSequence.current;
      if (cursor) setListAppending(true);
      else if (!silent) setListLoading(true);
      if (!silent) setListError(null);
      try {
        const response = await messagingService.listThreads(propertyId, {
          attentionState,
          unread: unreadOnly || undefined,
          channel: channel || undefined,
          assignee: assignee || undefined,
          search: serverSearch || undefined,
          cursor,
        });
        if (requestSequence !== listRequestSequence.current) return;
        if (cursor) {
          hasAppendedThreadPages.current = true;
          setThreads((current) => uniqueThreads([...current, ...response.items]));
          setNextCursor(response.nextCursor);
        } else if (silent) {
          const previousFirstPage = firstPageThreadIds.current;
          const refreshedFirstPage = new Set(response.items.map((thread) => thread.id));
          setThreads((current) =>
            uniqueThreads([
              ...response.items,
              ...current.filter(
                (thread) => !previousFirstPage.has(thread.id) && !refreshedFirstPage.has(thread.id),
              ),
            ]),
          );
          firstPageThreadIds.current = refreshedFirstPage;
          if (!hasAppendedThreadPages.current) setNextCursor(response.nextCursor);
        } else {
          firstPageThreadIds.current = new Set(response.items.map((thread) => thread.id));
          hasAppendedThreadPages.current = false;
          setThreads(response.items);
          setNextCursor(response.nextCursor);
        }
        setAccessDenied(false);
      } catch (error) {
        if (requestSequence !== listRequestSequence.current) return;
        const parsed = inboxError(error);
        if (isReadAccessDenial(parsed)) {
          clearPropertyData();
          setAccessDenied(true);
        } else if (!silent) {
          setListError(parsed);
        }
      } finally {
        if (requestSequence === listRequestSequence.current) {
          if (!silent) setListLoading(false);
          setListAppending(false);
        }
      }
    },
    [assignee, attentionState, channel, clearPropertyData, propertyId, serverSearch, unreadOnly],
  );

  useEffect(() => {
    void loadThreads();
  }, [loadThreads, reloadList]);

  useEffect(() => {
    if (!propertyId) return;
    const requestSequence = ++capabilityRequestSequence.current;
    let cancelled = false;
    void Promise.allSettled([
      messagingService.getQuickReplies(propertyId),
      getPmsStaffRoster(),
    ]).then(async ([quickReplyResult, staffResult]) => {
      if (cancelled || requestSequence !== capabilityRequestSequence.current) return;
      if (quickReplyResult.status === "fulfilled") {
        setQuickReplies(quickReplyResult.value.items);
        setCanReply(true);
      } else {
        const error = inboxError(quickReplyResult.reason);
        if (isEntitlementOrResourceDenial(error)) {
          clearPropertyData();
          setAccessDenied(true);
          return;
        }
        if (isReplyPermissionDenial(error)) {
          try {
            await messagingService.listThreads(propertyId, { attentionState, limit: 1 });
          } catch {
            if (cancelled || requestSequence !== capabilityRequestSequence.current) return;
            clearPropertyData();
            setAccessDenied(true);
            return;
          }
          if (cancelled || requestSequence !== capabilityRequestSequence.current) return;
          setCanReply(false);
        } else {
          setCanReply(true);
        }
      }
      if (staffResult.status === "fulfilled") setStaff(staffResult.value);
    });
    return () => {
      cancelled = true;
    };
  }, [attentionState, clearPropertyData, propertyId, reloadCapabilities]);

  const loadDetail = useCallback(
    async (silent = false) => {
      const requestSequence = ++detailRequestSequence.current;
      const threadId = selectedThreadId;
      if (!propertyId || !threadId) {
        setDetail(null);
        setDetailLoading(false);
        return;
      }
      setDetail((current) => (current?.thread.id === threadId ? current : null));
      if (!silent) {
        setDetailLoading(true);
        setDetailError(null);
      }
      try {
        const response = await messagingService.getThread(propertyId, threadId);
        if (requestSequence !== detailRequestSequence.current) return;
        setDetail((current) =>
          current?.thread.id === response.thread.id
            ? {
                ...response,
                timeline: mergeTimeline(current.timeline, response.timeline),
                previousCursor: current.previousCursor,
              }
            : response,
        );
        if (!response.availableProviderActions.includes("booking_com_no_reply_needed")) {
          setProviderActionPendingThreads((current) => {
            if (!current.has(response.thread.id)) return current;
            const next = new Set(current);
            next.delete(response.thread.id);
            return next;
          });
        }
        setThreads((items) =>
          items.map((item) => (item.id === response.thread.id ? response.thread : item)),
        );
      } catch (error) {
        if (requestSequence !== detailRequestSequence.current) return;
        const parsed = inboxError(error);
        if (parsed.code === "thread_not_found" || isReadAccessDenial(parsed)) {
          setDetail(null);
          if (parsed.code === "thread_not_found") {
            setThreads((items) => items.filter((item) => item.id !== threadId));
            returnFocusThreadId.current = threadId;
            restoreQueueFocus.current = true;
            setReloadList((value) => value + 1);
            setNotice(t("inbox.noticeConversationUnavailable"));
          }
          updateUrl({ thread: null });
          if (isReadAccessDenial(parsed)) {
            clearPropertyData();
            setAccessDenied(true);
          }
        } else if (!silent) {
          setDetailError(parsed);
        }
      } finally {
        if (!silent && requestSequence === detailRequestSequence.current) setDetailLoading(false);
      }
    },
    [clearPropertyData, propertyId, selectedThreadId, t, updateUrl],
  );

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    const deliveryPending = activeDetail?.timeline.some(
      (item) =>
        item.kind === "message" &&
        item.message.direction === "outbound" &&
        (item.message.delivery?.state === "queued" || item.message.delivery?.state === "retrying"),
    );
    if (!deliveryPending && !providerActionPending) return;
    let cancelled = false;
    let timer = window.setTimeout(poll, 5_000);
    async function poll() {
      await loadDetail(true);
      if (!cancelled) timer = window.setTimeout(poll, 5_000);
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeDetail?.timeline, loadDetail, providerActionPending]);

  useEffect(() => {
    if (!propertyId || accessDenied || listLoading || listAppending || detailLoading) return;
    let cancelled = false;
    let timer = window.setTimeout(refresh, 30_000);
    async function refresh() {
      if (document.visibilityState === "visible") {
        await Promise.allSettled([
          loadThreads(undefined, true),
          selectedThreadId ? loadDetail(true) : Promise.resolve(),
        ]);
        window.dispatchEvent(new Event("pms-inbox-unread-changed"));
      }
      if (!cancelled) timer = window.setTimeout(refresh, 30_000);
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    accessDenied,
    detailLoading,
    listAppending,
    listLoading,
    loadDetail,
    loadThreads,
    propertyId,
    selectedThreadId,
  ]);

  useEffect(() => {
    if (selectedThreadId) {
      window.setTimeout(() => headingRef.current?.focus(), 0);
      return;
    }
    if (!restoreQueueFocus.current || listLoading) return;
    const focusId = returnFocusThreadId.current;
    const timer = window.setTimeout(() => {
      const exact = focusId
        ? queueRef.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(focusId)}"]`)
        : null;
      const target = exact ?? queueRef.current?.querySelector<HTMLElement>("[data-thread-id]");
      if (target) {
        target.focus();
        restoreQueueFocus.current = false;
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [listLoading, selectedThreadId, threads]);

  useEffect(() => {
    setSummary(null);
    setTranslations({});
    setComposerError(null);
  }, [selectedThreadId]);

  useEffect(() => {
    if (!propertyId || !activeDetail || !latestInbound || activeDetail.thread.unreadCount === 0)
      return;
    const boundary = `${propertyId}:${activeDetail.thread.id}:${latestInbound.id}`;
    if (markedReadBoundary.current === boundary) return;
    markedReadBoundary.current = boundary;
    void messagingService
      .markRead(propertyId, activeDetail.thread.id, latestInbound.id)
      .then((response) => {
        const markedAt = new Date().toISOString();
        setThreads((items) =>
          response.unreadCount === 0 && unreadOnly
            ? items.filter((item) => item.id !== activeDetail.thread.id)
            : items.map((item) =>
                item.id === activeDetail.thread.id
                  ? { ...item, unreadCount: response.unreadCount }
                  : item,
              ),
        );
        setDetail((current) => {
          if (current?.thread.id !== activeDetail.thread.id) return current;
          let reachedBoundary = false;
          return {
            ...current,
            thread: { ...current.thread, unreadCount: response.unreadCount },
            timeline: current.timeline.map((item) => {
              if (reachedBoundary || item.kind !== "message") return item;
              if (item.message.direction !== "inbound") return item;
              const marked = {
                ...item,
                message: { ...item.message, readAt: item.message.readAt ?? markedAt },
              };
              if (item.message.id === latestInbound.id) reachedBoundary = true;
              return marked;
            }),
          };
        });
        window.dispatchEvent(new Event("pms-inbox-unread-changed"));
      })
      .catch((error) => {
        markedReadBoundary.current = null;
        if (isReadAccessDenial(inboxError(error))) {
          clearPropertyData();
          setAccessDenied(true);
        }
      });
  }, [activeDetail, clearPropertyData, latestInbound, propertyId, unreadOnly]);

  useEffect(() => {
    if (!bookingFromUrl || !propertyId || canReply !== true) return;
    setDirectBookingId(bookingFromUrl);
    setDirectOpen(true);
    void loadDirectBookings(propertyId);
  }, [bookingFromUrl, canReply, loadDirectBookings, propertyId]);

  function updateDraft(patch: Partial<Draft>) {
    if (!selectedThreadId) return;
    setDrafts((current) => ({
      ...current,
      [selectedThreadId]: { ...(current[selectedThreadId] ?? EMPTY_DRAFT), ...patch },
    }));
  }

  function openThread(threadId: string) {
    setNotice(null);
    returnFocusThreadId.current = threadId;
    updateUrl({ thread: threadId }, true);
  }

  function closeThread() {
    returnFocusThreadId.current = returnFocusThreadId.current ?? selectedThreadId;
    restoreQueueFocus.current = true;
    updateUrl({ thread: null }, true);
  }

  async function loadEarlier() {
    if (!propertyId || !detail?.previousCursor || earlierLoading) return;
    const threadId = detail.thread.id;
    const previousHeight = timelineRef.current?.scrollHeight ?? 0;
    const previousTop = timelineRef.current?.scrollTop ?? 0;
    setEarlierLoading(true);
    try {
      const response = await messagingService.getThread(
        propertyId,
        threadId,
        detail.previousCursor,
      );
      setDetail((current) =>
        current?.thread.id === threadId
          ? {
              ...current,
              thread: response.thread,
              timeline: [...response.timeline, ...current.timeline],
              previousCursor: response.previousCursor,
            }
          : current,
      );
      if (selectedThreadIdRef.current !== threadId) return;
      window.requestAnimationFrame(() => {
        if (timelineRef.current) {
          timelineRef.current.scrollTop =
            previousTop + timelineRef.current.scrollHeight - previousHeight;
        }
      });
    } catch (error) {
      const parsed = inboxError(error);
      if (isReadAccessDenial(parsed)) {
        clearPropertyData();
        setAccessDenied(true);
      } else if (selectedThreadIdRef.current === threadId) {
        setDetailError(parsed);
      }
    } finally {
      setEarlierLoading(false);
    }
  }

  async function handleMutation(
    name: string,
    mutation: () => Promise<void>,
    fallback: string,
    targetThreadId = selectedThreadId,
  ) {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setMutationBusy(name);
    setComposerError(null);
    try {
      await mutation();
    } catch (error) {
      const parsed = inboxError(error);
      if (await handleCommandAccessDenial(parsed, t("inbox.errorReplyAccessRemovedReadOnly"))) {
        return;
      }
      if (targetThreadId && selectedThreadIdRef.current !== targetThreadId) {
        setReloadList((value) => value + 1);
      } else if (parsed.code === "thread_version_conflict") {
        await loadDetail();
        setComposerError(t("inbox.errorConversationChanged"));
      } else {
        setComposerError(parsed.message || fallback);
      }
    } finally {
      mutationInFlight.current = false;
      setMutationBusy(null);
    }
  }

  async function handleCommandAccessDenial(
    error: ReturnType<typeof inboxError>,
    replyMessage: string,
  ): Promise<boolean> {
    if (isReplyPermissionDenial(error)) {
      await handleReplyPermissionDenied(replyMessage);
      return true;
    }
    if (isReadAccessDenial(error)) {
      clearPropertyData();
      setAccessDenied(true);
      return true;
    }
    return false;
  }

  async function handleReplyPermissionDenied(message: string) {
    setFollowUpOpen(false);
    setQuickManagerOpen(false);
    setDirectOpen(false);
    if (!propertyId) {
      clearPropertyData();
      setAccessDenied(true);
      return;
    }
    try {
      const currentThreadId = selectedThreadIdRef.current;
      if (currentThreadId) {
        const response = await messagingService.getThread(propertyId, currentThreadId);
        if (selectedThreadIdRef.current !== currentThreadId) return;
        setDetail(response);
        setThreads((items) =>
          items.map((item) => (item.id === response.thread.id ? response.thread : item)),
        );
      } else {
        const response = await messagingService.listThreads(propertyId, {
          attentionState,
          unread: unreadOnly || undefined,
          channel: channel || undefined,
          assignee: assignee || undefined,
          search: serverSearch || undefined,
        });
        if (selectedThreadIdRef.current) return;
        setThreads(response.items);
        setNextCursor(response.nextCursor);
      }
      setCanReply(false);
      setComposerError(message);
    } catch {
      clearPropertyData();
      setAccessDenied(true);
    }
  }

  async function markDone() {
    if (!propertyId || !detail) return;
    const thread = detail.thread;
    await handleMutation(
      "done",
      async () => {
        const result = await messagingService.triage(propertyId, thread.id, "done", thread.version);
        if (selectedThreadIdRef.current !== thread.id) {
          setReloadList((value) => value + 1);
          return;
        }
        setToast({
          threadId: thread.id,
          version: result.threadVersion,
          guestName: inboxGuestName(thread),
        });
        if (attentionState !== "done") {
          setThreads((items) => items.filter((item) => item.id !== thread.id));
          closeThread();
        } else {
          applyThreadUpdate({
            attentionState: "done",
            followUpAt: null,
            version: result.threadVersion,
          });
        }
      },
      t("inbox.errorMarkDone"),
      thread.id,
    );
  }

  async function undoDone() {
    if (!propertyId || !toast) return;
    const current = toast;
    await handleMutation(
      "undo",
      async () => {
        await messagingService.triage(propertyId, current.threadId, "reopen", current.version);
        setToast(null);
        updateUrl({ attentionState: "needs_attention", thread: current.threadId }, true);
        setReloadList((value) => value + 1);
      },
      t("inbox.errorReopen"),
    );
  }

  async function submitFollowUp() {
    if (!propertyId || !detail) return;
    const thread = detail.thread;
    const followUpInstant = propertyLocalDateTimeToIso(followUpAt, propertyTimezone);
    if (!followUpInstant || new Date(followUpInstant).getTime() <= Date.now()) {
      setComposerError(
        t("inbox.errorFutureTime", { timezone: formatTimezoneLabel(propertyTimezone) }),
      );
      return;
    }
    await handleMutation(
      "follow-up",
      async () => {
        const result = await messagingService.triage(
          propertyId,
          thread.id,
          "follow-up",
          thread.version,
          followUpInstant,
        );
        if (selectedThreadIdRef.current !== thread.id) {
          setReloadList((value) => value + 1);
          return;
        }
        setFollowUpOpen(false);
        if (attentionState !== "follow_up") {
          setThreads((items) => items.filter((item) => item.id !== thread.id));
          closeThread();
        } else {
          applyThreadUpdate({
            attentionState: "follow_up",
            followUpAt: result.followUpAt,
            version: result.threadVersion,
          });
        }
      },
      t("inbox.errorScheduleFollowUp"),
      thread.id,
    );
  }

  async function reopenThread() {
    if (!propertyId || !detail) return;
    const thread = detail.thread;
    await handleMutation(
      "reopen",
      async () => {
        await messagingService.triage(propertyId, thread.id, "reopen", thread.version);
        if (selectedThreadIdRef.current !== thread.id) {
          setReloadList((value) => value + 1);
          return;
        }
        setThreads((items) => items.filter((item) => item.id !== thread.id));
        closeThread();
      },
      t("inbox.errorReopen"),
      thread.id,
    );
  }

  async function assignThread(membershipId: string) {
    if (!propertyId || !detail) return;
    const thread = detail.thread;
    await handleMutation(
      "assign",
      async () => {
        const result = await messagingService.assign(
          propertyId,
          thread.id,
          thread.version,
          membershipId || null,
        );
        applyThreadUpdate({ assignedTo: result.assignedTo, version: result.threadVersion });
      },
      t("inbox.errorUpdateAssignee"),
      thread.id,
    );
  }

  function applyThreadUpdate(patch: Partial<InboxThread>) {
    if (!detail) return;
    const threadId = detail.thread.id;
    setDetail((current) =>
      current?.thread.id === threadId
        ? { ...current, thread: { ...current.thread, ...patch } }
        : current,
    );
    setThreads((items) =>
      items.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread)),
    );
  }

  async function submitComposer() {
    if (!propertyId || !detail || composerBusy) return;
    const threadId = detail.thread.id;
    const text = composerMode === "reply" ? draft.reply.trim() : draft.note.trim();
    if (!text && (composerMode === "note" || draft.attachments.length === 0)) return;
    setComposerBusy(true);
    setComposerError(null);
    try {
      if (composerMode === "note") {
        const response = await messagingService.addNote(
          propertyId,
          threadId,
          detail.thread.version,
          text,
        );
        setDetail((current) =>
          current?.thread.id === threadId
            ? {
                ...current,
                thread: { ...current.thread, version: response.threadVersion },
                timeline: [...current.timeline, { kind: "internal_note", note: response.note }],
              }
            : current,
        );
        setDrafts((current) => {
          const currentDraft = current[threadId] ?? EMPTY_DRAFT;
          return {
            ...current,
            [threadId]: {
              ...currentDraft,
              note: currentDraft.note === draft.note ? "" : currentDraft.note,
            },
          };
        });
      } else {
        const response = await messagingService.reply(propertyId, threadId, {
          expectedThreadVersion: detail.thread.version,
          text: text || null,
          attachmentMediaIds: draft.attachments.map((attachment) => attachment.mediaId),
        });
        const optimisticMessage: InboxMessage = {
          id: response.messageId,
          direction: "outbound",
          sender: { type: "property_user", name: "You" },
          text: text || null,
          occurredAt: response.acceptedAt,
          readAt: null,
          attachments: draft.attachments.map((attachment) => ({
            id: `prepared-${attachment.mediaId}`,
            availability: "available",
            ...attachment,
            accessPath: "",
          })),
          delivery: response.delivery,
        };
        setDetail((current) =>
          current?.thread.id === threadId
            ? {
                ...current,
                thread: {
                  ...current.thread,
                  version: response.threadVersion,
                  attentionState: "needs_attention",
                  followUpAt: null,
                },
                timeline: [...current.timeline, { kind: "message", message: optimisticMessage }],
              }
            : current,
        );
        if (response.delivery.state === "held") {
          if (selectedThreadIdRef.current === threadId) {
            setComposerError(t("inbox.errorAcceptedNotDelivered"));
          }
        } else {
          const acceptedMediaIds = new Set(
            draft.attachments.map((attachment) => attachment.mediaId),
          );
          setDrafts((current) => {
            const currentDraft = current[threadId] ?? EMPTY_DRAFT;
            const replyUnchanged = currentDraft.reply === draft.reply;
            return {
              ...current,
              [threadId]: {
                ...currentDraft,
                reply: replyUnchanged ? "" : currentDraft.reply,
                attachments: currentDraft.attachments.filter(
                  (attachment) => !acceptedMediaIds.has(attachment.mediaId),
                ),
                assisted: replyUnchanged ? null : currentDraft.assisted,
              },
            };
          });
        }
        if (selectedThreadIdRef.current === threadId) await loadDetail(true);
      }
      setReloadList((value) => value + 1);
    } catch (error) {
      const parsed = inboxError(error);
      if (await handleCommandAccessDenial(parsed, t("inbox.errorReplyAccessRemovedDraftPreserved")))
        return;
      if (selectedThreadIdRef.current !== threadId) return;
      if (parsed.code === "thread_version_conflict") {
        await loadDetail();
        setComposerError(t("inbox.errorConversationChangedDraftPreserved"));
      } else {
        setComposerError(parsed.message || t("inbox.errorMessageNotAccepted"));
      }
    } finally {
      setComposerBusy(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      composerMode === "reply" &&
      (event.metaKey || event.ctrlKey) &&
      event.key === "Enter" &&
      detail?.thread.replyRoute.state === "ready"
    ) {
      event.preventDefault();
      void submitComposer();
    }
  }

  async function prepareAttachment(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !propertyId || !detail || attachmentUploadInFlight.current) return;
    const threadId = detail.thread.id;
    attachmentUploadInFlight.current = true;
    setUploadingName(file.name);
    setComposerError(null);
    try {
      const prepared = await uploadPmsInboxAttachment({
        propertyId,
        threadId,
        file,
      });
      setDrafts((current) => {
        const currentDraft = current[threadId] ?? EMPTY_DRAFT;
        return {
          ...current,
          [threadId]: {
            ...currentDraft,
            attachments: [...currentDraft.attachments, prepared],
          },
        };
      });
    } catch (error) {
      const parsed = inboxError(error);
      if (
        !(await handleCommandAccessDenial(parsed, t("inbox.errorReplyAccessRemovedDraftPreserved")))
      ) {
        if (selectedThreadIdRef.current !== threadId) return;
        setComposerError(parsed.message || t("inbox.errorAttachmentPrepare"));
      }
    } finally {
      attachmentUploadInFlight.current = false;
      setUploadingName(null);
    }
  }

  async function insertQuickReply(quickReplyId: string) {
    if (!propertyId || !detail) return;
    const threadId = detail.thread.id;
    setAssistBusy(`quick-${quickReplyId}`);
    setComposerError(null);
    try {
      const preview = await messagingService.previewQuickReply(propertyId, threadId, quickReplyId);
      if (selectedThreadIdRef.current !== threadId) return;
      if (!preview.composerUseAllowed || preview.unresolvedVariables.length) {
        setComposerError(
          t("inbox.errorQuickReplyVariables", {
            variables: preview.unresolvedVariables.join(", "),
          }),
        );
        return;
      }
      updateDraft({ reply: preview.renderedText, assisted: null });
    } catch (error) {
      const parsed = inboxError(error);
      if (
        !(await handleCommandAccessDenial(parsed, t("inbox.errorReplyAccessRemovedDraftPreserved")))
      ) {
        if (selectedThreadIdRef.current !== threadId) return;
        setComposerError(parsed.message);
      }
    } finally {
      setAssistBusy(null);
    }
  }

  async function assist(
    kind: "draft_reply" | "summarize" | "translate_draft" | "translate_message",
    message?: InboxMessage,
  ) {
    if (!propertyId || !detail) return;
    const threadId = detail.thread.id;
    const throughMessageId = latestInbound?.id;
    if ((kind === "draft_reply" || kind === "summarize") && !throughMessageId) return;
    const sourceText = kind === "translate_message" ? message?.text : draft.reply;
    if ((kind === "translate_message" || kind === "translate_draft") && !sourceText?.trim()) return;
    setAssistBusy(message ? `${kind}-${message.id}` : kind);
    setComposerError(null);
    try {
      const response = await messagingService.assist(
        propertyId,
        threadId,
        kind === "draft_reply" || kind === "summarize"
          ? { kind, throughMessageId: throughMessageId! }
          : { kind, sourceText: sourceText!, targetLanguage: assistLanguage },
      );
      if (selectedThreadIdRef.current !== threadId) return;
      if (kind === "summarize") setSummary(response);
      else if (kind === "translate_message" && message) {
        setTranslations((current) => ({ ...current, [message.id]: response }));
      } else {
        updateDraft({ reply: response.assistedText, assisted: response });
      }
    } catch (error) {
      const parsed = inboxError(error);
      if (
        !(await handleCommandAccessDenial(parsed, t("inbox.errorReplyAccessRemovedDraftPreserved")))
      ) {
        if (selectedThreadIdRef.current !== threadId) return;
        setComposerError(t("inbox.errorAssistManualFallback", { error: parsed.message }));
      }
    } finally {
      setAssistBusy(null);
    }
  }

  async function noReplyNeeded() {
    if (!propertyId || !detail || providerActionPending || mutationInFlight.current) return;
    const threadId = detail.thread.id;
    setProviderActionPendingThreads((current) => new Set(current).add(threadId));
    await handleMutation(
      "provider-action",
      async () => {
        try {
          await messagingService.providerNoReplyNeeded(propertyId, threadId);
        } catch (error) {
          if (inboxError(error).status !== null) {
            setProviderActionPendingThreads((current) => {
              const next = new Set(current);
              next.delete(threadId);
              return next;
            });
          }
          throw error;
        }
        if (selectedThreadIdRef.current === threadId) await loadDetail(true);
        else setReloadList((value) => value + 1);
      },
      t("inbox.errorBookingComUpdate"),
      threadId,
    );
  }

  async function startDirectThread() {
    if (!propertyId || !directBookingId) return;
    setDirectLoading(true);
    setDirectError(null);
    try {
      const response = await messagingService.startDirectEmail(propertyId, directBookingId);
      setDirectOpen(false);
      updateUrl(
        { booking: null, thread: response.thread.id, attentionState: "needs_attention" },
        true,
      );
      setReloadList((value) => value + 1);
    } catch (error) {
      const parsed = inboxError(error);
      if (!(await handleCommandAccessDenial(parsed, t("inbox.errorReplyAccessRemovedReadOnly")))) {
        setDirectError(parsed.message);
      }
    } finally {
      setDirectLoading(false);
    }
  }

  if (accessDenied) {
    return (
      <InboxDenied
        onRetry={() => {
          setAccessDenied(false);
          setReloadList((value) => value + 1);
          setReloadCapabilities((value) => value + 1);
        }}
      />
    );
  }

  return (
    <section
      className="relative h-[calc(100dvh-3rem)] min-h-0 overflow-hidden bg-white md:min-h-[480px]"
      aria-label={t("inbox.guestInbox")}
    >
      <div className="grid h-full min-w-0 grid-cols-1 md:grid-cols-[88px_280px_minmax(0,1fr)] min-[1280px]:grid-cols-[96px_280px_minmax(420px,1fr)_272px]">
        <AttentionRail
          value={attentionState}
          onChange={(value) => updateUrl({ attentionState: value, thread: null }, true)}
        />

        <div
          className={cn(
            "flex h-full min-w-0 flex-col border-r border-gray-200 bg-white",
            selectedThreadId && "hidden md:block",
          )}
        >
          <QueueHeader
            search={search}
            onSearch={setSearch}
            unreadOnly={unreadOnly}
            channel={channel}
            assignee={assignee}
            staff={eligibleStaff}
            canReply={canReply === true}
            onFilter={(key, value) => updateUrl({ [key]: value || null, thread: null })}
            onNewMessage={() => {
              setDirectError(null);
              setDirectOpen(true);
              void loadDirectBookings();
            }}
            attentionState={attentionState}
            onAttention={(value) => updateUrl({ attentionState: value, thread: null }, true)}
          />
          <ForwardedThreadQueue
            ref={queueRef}
            threads={threads}
            selectedThreadId={selectedThreadId}
            loading={listLoading}
            appending={listAppending}
            error={listError}
            nextCursor={nextCursor}
            attentionState={attentionState}
            onOpen={openThread}
            onRetry={() => void loadThreads()}
            onLoadMore={() => nextCursor && void loadThreads(nextCursor)}
          />
        </div>

        <div className={cn("min-w-0 bg-[#F9FAFB]", !selectedThreadId && "hidden md:block")}>
          {!selectedThreadId ? (
            <NoSelection />
          ) : detailLoading && !activeDetail ? (
            <ConversationSkeleton />
          ) : detailError && !activeDetail ? (
            <PaneError error={detailError} onRetry={() => void loadDetail()} />
          ) : activeDetail ? (
            <div className="flex h-full min-w-0 flex-col">
              <ForwardedConversationHeader
                ref={headingRef}
                thread={activeDetail.thread}
                canReply={canReply === true}
                staff={eligibleStaff}
                selfMembershipId={selfMembershipId}
                mutationBusy={mutationBusy}
                providerActionAvailable={activeDetail.availableProviderActions.includes(
                  "booking_com_no_reply_needed",
                )}
                providerActionPending={providerActionPending}
                onBack={closeThread}
                onContext={() => setContextOpen(true)}
                onDone={() => void markDone()}
                onFollowUp={() => {
                  setComposerError(null);
                  setFollowUpOpen(true);
                }}
                onReopen={() => void reopenThread()}
                onAssign={(id) => void assignThread(id)}
                onNoReplyNeeded={() => void noReplyNeeded()}
              />
              <ForwardedConversationTimeline
                ref={timelineRef}
                timeline={activeDetail.timeline}
                previousCursor={activeDetail.previousCursor}
                earlierLoading={earlierLoading}
                summary={summary}
                latestInboundId={latestInbound?.id ?? null}
                translations={translations}
                assistBusy={assistBusy}
                canAssist={canReply === true}
                onLoadEarlier={() => void loadEarlier()}
                onDismissSummary={() => setSummary(null)}
                onDismissTranslation={(id) =>
                  setTranslations((current) => {
                    const next = { ...current };
                    delete next[id];
                    return next;
                  })
                }
                onTranslate={(message) => void assist("translate_message", message)}
                onCopyToDraft={(text) => updateDraft({ reply: text })}
              />
              {canReply === false ? (
                <div className="shrink-0 border-t border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
                  <LockClosedIcon className="mr-2 inline h-4 w-4" />
                  {t("inbox.replyAccessRequired")}
                </div>
              ) : canReply === null ? (
                <div className="shrink-0 border-t border-gray-200 bg-white px-4 py-4 text-sm text-gray-500">
                  {t("inbox.checkingReplyAccess")}
                </div>
              ) : (
                <Composer
                  mode={composerMode}
                  draft={draft}
                  route={activeDetail.thread.replyRoute}
                  quickReplies={quickReplies}
                  busy={composerBusy}
                  uploadName={uploadingName}
                  assistBusy={assistBusy}
                  assistLanguage={assistLanguage}
                  error={composerError}
                  latestInboundId={latestInbound?.id ?? null}
                  onMode={setComposerMode}
                  onReply={(reply) => updateDraft({ reply })}
                  onNote={(note) => updateDraft({ note })}
                  onRemoveAttachment={(mediaId) =>
                    updateDraft({
                      attachments: draft.attachments.filter((item) => item.mediaId !== mediaId),
                    })
                  }
                  onAttachment={prepareAttachment}
                  onQuickReply={(id) => void insertQuickReply(id)}
                  onManageQuickReplies={() => setQuickManagerOpen(true)}
                  onAssist={(kind) => void assist(kind)}
                  onAssistLanguage={setAssistLanguage}
                  onSubmit={() => void submitComposer()}
                  onKeyDown={handleComposerKeyDown}
                />
              )}
            </div>
          ) : null}
        </div>

        <aside className="hidden min-w-0 border-l border-gray-200 bg-white min-[1280px]:block">
          {activeDetail ? <ConversationContext thread={activeDetail.thread} /> : null}
        </aside>
      </div>

      {notice && (
        <div
          role="status"
          className="absolute left-1/2 top-3 z-40 -translate-x-1/2 rounded-md bg-gray-950 px-3 py-2 text-xs font-semibold text-white shadow-lg"
        >
          {notice}
        </div>
      )}

      {toast && (
        <div
          role="status"
          className="absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-gray-950 px-4 py-3 text-sm text-white shadow-xl"
        >
          <span>{t("inbox.markedDone", { guestName: toast.guestName })}</span>
          <button
            type="button"
            className="font-semibold text-white underline underline-offset-2"
            onClick={() => void undoDone()}
            disabled={mutationBusy === "undo"}
          >
            {t("inbox.undo")}
          </button>
        </div>
      )}

      {contextOpen && activeDetail && (
        <ContextDrawer thread={activeDetail.thread} onClose={() => setContextOpen(false)} />
      )}

      {followUpOpen && activeDetail && (
        <FollowUpDialog
          value={followUpAt}
          timezone={propertyTimezone}
          busy={mutationBusy === "follow-up"}
          error={composerError}
          onChange={setFollowUpAt}
          onClose={() => setFollowUpOpen(false)}
          onSubmit={() => void submitFollowUp()}
        />
      )}

      {quickManagerOpen && propertyId && (
        <QuickReplyManager
          propertyId={propertyId}
          items={quickReplies}
          onItems={setQuickReplies}
          onAccessDenied={(error) =>
            handleCommandAccessDenial(error, t("inbox.errorReplyAccessRemovedReadOnly"))
          }
          onClose={() => setQuickManagerOpen(false)}
        />
      )}

      {directOpen && (
        <DirectThreadDialog
          bookings={directBookings}
          value={directBookingId}
          loading={directLoading}
          error={directError}
          onChange={setDirectBookingId}
          onClose={() => {
            setDirectOpen(false);
            setDirectError(null);
            updateUrl({ booking: null });
          }}
          onSubmit={() => void startDirectThread()}
        />
      )}
    </section>
  );
}

function AttentionRail({
  value,
  onChange,
}: {
  value: InboxAttentionState;
  onChange: (value: InboxAttentionState) => void;
}) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("inbox.attentionNavigation")}
      className="hidden border-r border-gray-200 bg-gray-50 px-2 py-4 md:block"
    >
      <p className="mb-3 px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-400">
        {t("inbox.attention")}
      </p>
      <div className="space-y-1">
        {ATTENTION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-current={value === option.value ? "page" : undefined}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex min-h-11 w-full flex-col justify-center rounded-md px-2 text-left text-[11px] font-semibold leading-4 transition",
              value === option.value
                ? "bg-white text-[#2F52F5] shadow-sm ring-1 ring-gray-200"
                : "text-gray-500 hover:bg-white hover:text-gray-900",
            )}
          >
            {t(option.shortKey)}
          </button>
        ))}
      </div>
    </nav>
  );
}

function QueueHeader(props: {
  search: string;
  onSearch: (value: string) => void;
  unreadOnly: boolean;
  channel: InboxChannel | "";
  assignee: string;
  staff: PmsStaffMember[];
  canReply: boolean;
  onFilter: (key: string, value: string) => void;
  onNewMessage: () => void;
  attentionState: InboxAttentionState;
  onAttention: (value: InboxAttentionState) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="border-b border-gray-200">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">{t("inbox.title")}</h1>
          <p className="mt-0.5 text-xs text-gray-500">{t("inbox.guestConversations")}</p>
        </div>
        {props.canReply && (
          <button
            type="button"
            onClick={props.onNewMessage}
            className="rounded-md bg-gray-950 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-800"
          >
            {t("inbox.newMessage")}
          </button>
        )}
      </div>
      <div className="flex gap-1 overflow-x-auto border-y border-gray-100 px-3 py-2 md:hidden">
        {ATTENTION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-current={props.attentionState === option.value ? "page" : undefined}
            onClick={() => props.onAttention(option.value)}
            className={cn(
              "min-h-11 shrink-0 rounded-md px-3 text-xs font-semibold",
              props.attentionState === option.value
                ? "bg-gray-950 text-white"
                : "text-gray-600 hover:bg-gray-100",
            )}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>
      <div className="space-y-2 px-3 py-3">
        <label className="relative block">
          <span className="sr-only">{t("inbox.searchConversations")}</span>
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={props.search}
            onChange={(event) => props.onSearch(event.target.value)}
            placeholder={t("inbox.searchConversations")}
            autoComplete="off"
            className="min-h-11 w-full rounded-md border border-gray-200 bg-white py-2 pl-9 pr-3 text-base outline-none focus:border-[#2F52F5] focus:ring-2 focus:ring-[#2F52F5]/15 sm:text-sm"
          />
        </label>
        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            aria-pressed={props.unreadOnly}
            onClick={() => props.onFilter("unread", props.unreadOnly ? "" : "true")}
            className={filterClass(props.unreadOnly)}
          >
            <FunnelIcon className="h-3.5 w-3.5" />
            {t("inbox.unread")}
          </button>
          <select
            aria-label={t("inbox.channel")}
            value={props.channel}
            onChange={(event) => props.onFilter("channel", event.target.value)}
            className="min-h-11 rounded-md border border-gray-200 bg-white px-2 text-base text-gray-600 outline-none focus:border-[#2F52F5] sm:text-xs md:min-h-9"
          >
            <option value="">{t("inbox.allChannels")}</option>
            <option value="ota">{t("inbox.channelOta")}</option>
            <option value="email">{t("inbox.channelEmail")}</option>
          </select>
          <select
            aria-label={t("inbox.assignee")}
            value={props.assignee}
            onChange={(event) => props.onFilter("assignee", event.target.value)}
            className="min-h-11 min-w-0 rounded-md border border-gray-200 bg-white px-2 text-base text-gray-600 outline-none focus:border-[#2F52F5] sm:text-xs md:min-h-9"
          >
            <option value="">{t("inbox.anyone")}</option>
            <option value="me">{t("inbox.me")}</option>
            <option value="unassigned">{t("inbox.unassigned")}</option>
            {props.staff.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name || member.email}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

const ThreadQueue = function ThreadQueue(
  {
    threads,
    selectedThreadId,
    loading,
    appending,
    error,
    nextCursor,
    attentionState,
    onOpen,
    onRetry,
    onLoadMore,
  }: {
    threads: InboxThread[];
    selectedThreadId: string | null;
    loading: boolean;
    appending: boolean;
    error: ReturnType<typeof inboxError> | null;
    nextCursor: string | null;
    attentionState: InboxAttentionState;
    onOpen: (id: string) => void;
    onRetry: () => void;
    onLoadMore: () => void;
  },
  ref: ForwardedRef<HTMLDivElement>,
) {
  const { t } = useTranslation();
  if (loading) return <QueueSkeleton />;
  if (error) return <PaneError error={error} onRetry={onRetry} />;
  if (!threads.length) return <EmptyQueue state={attentionState} />;
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto">
      {threads.map((thread) => {
        const selected = selectedThreadId === thread.id;
        return (
          <button
            key={thread.id}
            data-thread-id={thread.id}
            type="button"
            aria-current={selected ? "true" : undefined}
            aria-label={t("inbox.threadAriaLabel", {
              guestName: inboxGuestName(thread),
              source: inboxSourceLabel(thread),
              unreadCount: thread.unreadCount,
            })}
            onClick={() => onOpen(thread.id)}
            className={cn(
              "relative min-h-[108px] w-full border-b border-gray-100 px-4 py-3 text-left outline-none transition hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2F52F5]",
              selected && "bg-[#F5F7FF]",
            )}
          >
            {selected && <span className="absolute inset-y-0 left-0 w-[3px] bg-[#2F52F5]" />}
            <span className="flex items-baseline gap-2">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm text-gray-900",
                  thread.unreadCount ? "font-bold" : "font-semibold",
                )}
              >
                {inboxGuestName(thread)}
              </span>
              <span className="shrink-0 text-[11px] text-gray-400">
                {formatInboxTime(thread.activityAt)}
              </span>
            </span>
            <span className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-500">
              <SourceDot thread={thread} />
              {inboxSourceLabel(thread)}
              <span aria-hidden="true">·</span>
              <span className="truncate">{inboxContextLabel(thread)}</span>
            </span>
            <span
              className={cn(
                "mt-1.5 line-clamp-2 block text-xs leading-5",
                thread.unreadCount ? "font-medium text-gray-800" : "text-gray-500",
              )}
            >
              {inboxPreview(thread)}
            </span>
            <span className="mt-2 flex min-h-4 items-center gap-2 text-[10px] text-gray-500">
              {thread.unreadCount > 0 && (
                <span className="rounded-full bg-[#2F52F5] px-1.5 py-0.5 font-bold text-white">
                  {t("inbox.unreadCount", { count: thread.unreadCount })}
                </span>
              )}
              {thread.followUpAt && (
                <span>
                  <ClockIcon className="mr-1 inline h-3 w-3" />
                  {formatInboxDateTime(thread.followUpAt)}
                </span>
              )}
              {thread.assignedTo && (
                <span className="truncate">{thread.assignedTo.displayName}</span>
              )}
              {thread.lastMessage.hasAttachments && (
                <PaperClipIcon
                  className="ml-auto h-3.5 w-3.5"
                  aria-label={t("inbox.hasAttachment")}
                />
              )}
            </span>
          </button>
        );
      })}
      {nextCursor && (
        <button
          type="button"
          disabled={appending}
          onClick={onLoadMore}
          className="m-3 min-h-11 w-[calc(100%-1.5rem)] rounded-md border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          {appending ? t("inbox.loading") : t("inbox.loadMoreConversations")}
        </button>
      )}
    </div>
  );
};
const ForwardedThreadQueue = forwardRef(ThreadQueue);

function ConversationHeader(
  props: {
    thread: InboxThread;
    canReply: boolean;
    staff: PmsStaffMember[];
    selfMembershipId: string | null;
    mutationBusy: string | null;
    providerActionAvailable: boolean;
    providerActionPending: boolean;
    onBack: () => void;
    onContext: () => void;
    onDone: () => void;
    onFollowUp: () => void;
    onReopen: () => void;
    onAssign: (id: string) => void;
    onNoReplyNeeded: () => void;
  },
  ref: ForwardedRef<HTMLHeadingElement>,
) {
  const { t } = useTranslation();
  const [moreOpen, setMoreOpen] = useState(false);
  const { triggerRef: moreTriggerRef, panelRef: morePanelRef } = usePopoverFocus(moreOpen);
  return (
    <header className="shrink-0 border-b border-gray-200 bg-white px-3 py-3 sm:px-4">
      <div className="flex min-w-0 items-start gap-2">
        <button
          type="button"
          onClick={props.onBack}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 md:hidden"
          aria-label={t("inbox.backToInbox")}
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2
            ref={ref}
            tabIndex={-1}
            className="truncate text-sm font-bold text-gray-950 outline-none"
          >
            {inboxGuestName(props.thread)}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-gray-500">
            <span>{inboxSourceLabel(props.thread)}</span>
            <span>·</span>
            <span>{inboxContextLabel(props.thread)}</span>
            <span>·</span>
            <span
              className={
                props.thread.replyRoute.state === "ready" ? "text-emerald-700" : "text-amber-700"
              }
            >
              {props.thread.replyRoute.state === "ready"
                ? t("inbox.replyReady")
                : t("inbox.replyHeld")}
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={props.onContext}
          className="min-h-11 rounded-md px-2 text-xs font-semibold text-gray-600 hover:bg-gray-100 min-[1280px]:hidden"
        >
          {t("inbox.guestAndStay")}
        </button>
      </div>
      {props.canReply && (
        <div className="mt-3 flex items-center gap-1.5 overflow-x-auto pb-0.5">
          {props.thread.attentionState === "done" ? (
            <ActionButton
              label={t("common.reopen")}
              busy={props.mutationBusy === "reopen"}
              onClick={props.onReopen}
            />
          ) : (
            <ActionButton
              label={t("inbox.attentionDone")}
              busy={props.mutationBusy === "done"}
              onClick={props.onDone}
              icon={<CheckIcon className="h-4 w-4" />}
            />
          )}
          <ActionButton
            label={t("inbox.attentionFollowUp")}
            busy={props.mutationBusy === "follow-up"}
            onClick={props.onFollowUp}
            icon={<ClockIcon className="h-4 w-4" />}
          />
          <label className="relative hidden shrink-0 sm:block">
            <span className="sr-only">{t("inbox.assignConversation")}</span>
            <select
              value={props.thread.assignedTo?.membershipId ?? ""}
              disabled={props.mutationBusy === "assign"}
              onChange={(event) => props.onAssign(event.target.value)}
              className="min-h-11 appearance-none rounded-md border border-gray-200 bg-white py-1.5 pl-2.5 pr-7 text-xs font-semibold text-gray-600 outline-none hover:bg-gray-50 focus:border-[#2F52F5] md:min-h-9"
            >
              <option value="">{t("inbox.unassigned")}</option>
              {props.selfMembershipId && (
                <option value={props.selfMembershipId}>
                  {t("inbox.me")}
                  {props.staff.find((member) => member.id === props.selfMembershipId)?.name
                    ? ` · ${props.staff.find((member) => member.id === props.selfMembershipId)?.name}`
                    : ""}
                </option>
              )}
              {props.staff
                .filter((member) => member.id !== props.selfMembershipId)
                .map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name || member.email}
                  </option>
                ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400" />
          </label>
          <div
            className={cn(
              "relative ml-auto shrink-0",
              !props.providerActionAvailable && "sm:hidden",
            )}
          >
            <button
              ref={moreTriggerRef}
              type="button"
              aria-label={t("inbox.moreConversationActions")}
              onClick={() => setMoreOpen((open) => !open)}
              className="flex h-11 w-11 items-center justify-center rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50 md:h-9 md:w-9"
            >
              <EllipsisHorizontalIcon className="h-5 w-5" />
            </button>
            {moreOpen && (
              <div
                ref={morePanelRef}
                onKeyDown={(event) =>
                  trapFocus(event, morePanelRef.current, () => setMoreOpen(false))
                }
                className="absolute right-0 top-10 z-30 w-64 rounded-lg border border-gray-200 bg-white p-2 shadow-lg"
              >
                <label className="block px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 sm:hidden">
                  {t("inbox.assignment")}
                  <select
                    value={props.thread.assignedTo?.membershipId ?? ""}
                    disabled={props.mutationBusy === "assign"}
                    onChange={(event) => {
                      setMoreOpen(false);
                      props.onAssign(event.target.value);
                    }}
                    className="mt-1 min-h-11 w-full rounded-md border border-gray-200 bg-white px-2 text-base font-semibold normal-case tracking-normal text-gray-700 outline-none focus:border-[#2F52F5] sm:text-xs"
                  >
                    <option value="">{t("inbox.unassigned")}</option>
                    {props.selfMembershipId && (
                      <option value={props.selfMembershipId}>{t("inbox.me")}</option>
                    )}
                    {props.staff
                      .filter((member) => member.id !== props.selfMembershipId)
                      .map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.name || member.email}
                        </option>
                      ))}
                  </select>
                </label>
                {props.providerActionAvailable && (
                  <>
                    <button
                      type="button"
                      disabled={props.providerActionPending}
                      onClick={() => {
                        setMoreOpen(false);
                        props.onNoReplyNeeded();
                      }}
                      className="w-full rounded-md px-3 py-2 text-left text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:text-gray-400"
                    >
                      {props.providerActionPending
                        ? t("inbox.updatingBookingCom")
                        : t("inbox.bookingComNoReplyNeeded")}
                    </button>
                    <p className="px-3 pb-2 text-[11px] leading-4 text-gray-500">
                      {t("inbox.bookingComUpdateExplanation")}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
const ForwardedConversationHeader = forwardRef(ConversationHeader);

function ConversationTimeline(
  props: {
    timeline: InboxTimelineItem[];
    previousCursor: string | null;
    earlierLoading: boolean;
    summary: InboxAssistanceResponse | null;
    latestInboundId: string | null;
    translations: Record<string, InboxAssistanceResponse>;
    assistBusy: string | null;
    canAssist: boolean;
    onLoadEarlier: () => void;
    onDismissSummary: () => void;
    onDismissTranslation: (id: string) => void;
    onTranslate: (message: InboxMessage) => void;
    onCopyToDraft: (text: string) => void;
  },
  ref: ForwardedRef<HTMLDivElement>,
) {
  const { t } = useTranslation();
  let lastDate = "";
  const unreadBoundaryId = props.timeline.find(
    (item): item is Extract<InboxTimelineItem, { kind: "message" }> =>
      item.kind === "message" &&
      item.message.direction === "inbound" &&
      item.message.readAt === null,
  )?.message.id;
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
      {props.summary && (
        <AssistedBlock
          label={t("inbox.aiAssistedSummary")}
          response={props.summary}
          stale={Boolean(
            props.latestInboundId && props.summary.basedThroughMessageId !== props.latestInboundId,
          )}
          onDismiss={props.onDismissSummary}
        />
      )}
      {props.previousCursor && (
        <div className="mb-4 text-center">
          <button
            type="button"
            disabled={props.earlierLoading}
            onClick={props.onLoadEarlier}
            className="min-h-11 rounded-md px-3 text-xs font-semibold text-[#2F52F5] hover:bg-blue-50"
          >
            {props.earlierLoading ? t("inbox.loading") : t("inbox.loadEarlierMessages")}
          </button>
        </div>
      )}
      {!props.timeline.length ? (
        <div className="flex min-h-[220px] items-center justify-center text-center">
          <div>
            <EnvelopeIcon className="mx-auto h-8 w-8 text-gray-300" />
            <p className="mt-3 text-sm font-semibold text-gray-700">{t("inbox.noMessagesYet")}</p>
            <p className="mt-1 text-xs text-gray-500">{t("inbox.startConversationBelow")}</p>
          </div>
        </div>
      ) : (
        props.timeline.map((item) => {
          const occurredAt =
            item.kind === "message" ? item.message.occurredAt : item.note.occurredAt;
          const date = formatInboxDate(occurredAt);
          const showDate = date !== lastDate;
          lastDate = date;
          return (
            <div key={`${item.kind}-${item.kind === "message" ? item.message.id : item.note.id}`}>
              {showDate && (
                <div className="my-4 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                  <span className="h-px flex-1 bg-gray-200" />
                  <span>{date}</span>
                  <span className="h-px flex-1 bg-gray-200" />
                </div>
              )}
              {item.kind === "message" && item.message.id === unreadBoundaryId && (
                <div
                  role="separator"
                  aria-label={t("inbox.unreadMessages")}
                  className="my-4 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wider text-[#2F52F5]"
                >
                  <span className="h-px flex-1 bg-[#C7D2FE]" />
                  <span>{t("inbox.unread")}</span>
                  <span className="h-px flex-1 bg-[#C7D2FE]" />
                </div>
              )}
              {item.kind === "internal_note" ? (
                <InternalNoteItem note={item.note} />
              ) : (
                <MessageItem
                  message={item.message}
                  translation={props.translations[item.message.id]}
                  translateBusy={props.assistBusy === `translate_message-${item.message.id}`}
                  canTranslate={props.canAssist}
                  onTranslate={() => props.onTranslate(item.message)}
                  onDismissTranslation={() => props.onDismissTranslation(item.message.id)}
                  onCopyToDraft={() => item.message.text && props.onCopyToDraft(item.message.text)}
                />
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
const ForwardedConversationTimeline = forwardRef(ConversationTimeline);

function MessageItem({
  message,
  translation,
  translateBusy,
  canTranslate,
  onTranslate,
  onDismissTranslation,
  onCopyToDraft,
}: {
  message: InboxMessage;
  translation?: InboxAssistanceResponse;
  translateBusy: boolean;
  canTranslate: boolean;
  onTranslate: () => void;
  onDismissTranslation: () => void;
  onCopyToDraft: () => void;
}) {
  const { t } = useTranslation();
  const outbound = message.direction === "outbound";
  return (
    <article className={cn("mb-3 flex", outbound ? "justify-end" : "justify-start")}>
      <div className="max-w-[88%] md:max-w-[72%]">
        <div
          className={cn(
            "rounded-xl border px-3 py-2.5 text-sm leading-6 shadow-sm",
            outbound
              ? "border-[#DDE3FF] bg-[#F3F5FF] text-gray-900"
              : "border-gray-200 bg-white text-gray-900",
          )}
        >
          <div className="mb-1 flex items-center gap-2 text-[11px] text-gray-500">
            <span className="font-semibold">
              {message.sender.name === "You"
                ? t("inbox.you")
                : message.sender.name || (outbound ? t("inbox.property") : t("inbox.guest"))}
            </span>
            <span>{formatInboxDateTime(message.occurredAt)}</span>
          </div>
          {message.text && <p className="whitespace-pre-wrap break-words">{message.text}</p>}
          {message.attachments.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {message.attachments.map((attachment) =>
                attachment.availability === "available" && attachment.accessPath ? (
                  <a
                    key={attachment.id}
                    href={attachment.accessPath}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-h-11 items-center gap-2 rounded-md border border-gray-200 bg-white px-2.5 text-xs text-gray-700 hover:border-[#2F52F5]"
                  >
                    <PaperClipIcon className="h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
                    <span className="text-gray-400">{formatFileSize(attachment.size)}</span>
                  </a>
                ) : attachment.availability === "available" ? (
                  <div
                    key={attachment.id}
                    className="flex min-h-11 items-center gap-2 rounded-md border border-gray-200 bg-white px-2.5 text-xs text-gray-600"
                  >
                    <PaperClipIcon className="h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
                    <span>{t("inbox.attachmentAccepted")}</span>
                  </div>
                ) : (
                  <div
                    key={attachment.id}
                    aria-disabled="true"
                    className="flex min-h-11 items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2.5 text-xs text-gray-400"
                  >
                    <PaperClipIcon className="h-4 w-4" />
                    {t("inbox.fileUnavailable")}
                  </div>
                ),
              )}
            </div>
          )}
          {!outbound && message.text && canTranslate && (
            <button
              type="button"
              disabled={translateBusy}
              onClick={onTranslate}
              className="mt-2 text-[11px] font-semibold text-[#2F52F5] hover:underline disabled:opacity-50"
            >
              {translateBusy ? t("inbox.translating") : t("inbox.translate")}
            </button>
          )}
        </div>
        {message.delivery && (
          <DeliveryLabel
            delivery={message.delivery}
            onCopy={message.text ? onCopyToDraft : undefined}
          />
        )}
        {translation && (
          <AssistedBlock
            label={t("inbox.aiAssistedTranslation")}
            response={translation}
            stale={false}
            onDismiss={onDismissTranslation}
            compact
          />
        )}
      </div>
    </article>
  );
}

function InternalNoteItem({
  note,
}: {
  note: Extract<InboxTimelineItem, { kind: "internal_note" }>["note"];
}) {
  const { t } = useTranslation();
  return (
    <article className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-amber-800">
        <LockClosedIcon className="h-3.5 w-3.5" />
        {t("inbox.internalNoteAuthor", { author: note.author.displayName })}
        <span className="font-normal text-amber-700">{formatInboxDateTime(note.occurredAt)}</span>
      </div>
      <p className="whitespace-pre-wrap leading-6">{note.text}</p>
      <p className="mt-1 text-[10px] text-amber-700">{t("inbox.staffOnlyVisibility")}</p>
    </article>
  );
}

function Composer(props: {
  mode: ComposerMode;
  draft: Draft;
  route: InboxThread["replyRoute"];
  quickReplies: InboxQuickReply[];
  busy: boolean;
  uploadName: string | null;
  assistBusy: string | null;
  assistLanguage: string;
  error: string | null;
  latestInboundId: string | null;
  onMode: (mode: ComposerMode) => void;
  onReply: (value: string) => void;
  onNote: (value: string) => void;
  onRemoveAttachment: (mediaId: string) => void;
  onAttachment: (event: ChangeEvent<HTMLInputElement>) => void;
  onQuickReply: (id: string) => void;
  onManageQuickReplies: () => void;
  onAssist: (kind: "draft_reply" | "summarize" | "translate_draft") => void;
  onAssistLanguage: (language: string) => void;
  onSubmit: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const { t } = useTranslation();
  const [quickOpen, setQuickOpen] = useState(false);
  const { triggerRef: quickTriggerRef, panelRef: quickPanelRef } = usePopoverFocus(quickOpen);
  const isReply = props.mode === "reply";
  const value = isReply ? props.draft.reply : props.draft.note;
  const canSend = isReply
    ? props.route.state === "ready" && Boolean(value.trim() || props.draft.attachments.length)
    : Boolean(value.trim());
  const staleAssistance = Boolean(
    props.draft.assisted?.basedThroughMessageId &&
    props.latestInboundId &&
    props.draft.assisted.basedThroughMessageId !== props.latestInboundId,
  );
  const heldRecoveryPath =
    props.route.state === "held" ? heldRouteRecoveryPath(props.route.reasonCode) : null;
  return (
    <div
      className={cn(
        "shrink-0 border-t px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2.5 sm:px-4",
        isReply ? "border-gray-200 bg-white" : "border-amber-200 bg-amber-50",
      )}
    >
      <div role="tablist" aria-label={t("inbox.composerMode")} className="mb-2 flex gap-1">
        <button
          role="tab"
          aria-selected={isReply}
          type="button"
          onClick={() => props.onMode("reply")}
          className={composerTab(isReply)}
        >
          {t("inbox.reply")}
        </button>
        <button
          role="tab"
          aria-selected={!isReply}
          type="button"
          onClick={() => props.onMode("note")}
          className={composerTab(!isReply)}
        >
          {t("inbox.internalNote")}
        </button>
      </div>
      <div className="mb-2 flex items-center gap-2 text-[11px] font-medium">
        <span
          className={isReply && props.route.state === "held" ? "text-amber-800" : "text-gray-600"}
        >
          {isReply ? inboxRouteLabel(props.route) : t("inbox.propertyStaffOnly")}
        </span>
        {isReply && props.route.state === "ready" && (
          <span className="ml-auto text-emerald-700">
            <CheckCircleIcon className="mr-1 inline h-3.5 w-3.5" />
            {t("inbox.connected")}
          </span>
        )}
      </div>
      {isReply && props.route.state === "held" && (
        <div
          className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          role="status"
        >
          {t("inbox.routeUnavailable")}
          {heldRecoveryPath && (
            <Link
              href={heldRecoveryPath}
              className="ml-1 font-semibold text-amber-950 underline underline-offset-2"
            >
              {t("inbox.reviewSettings")}
            </Link>
          )}
        </div>
      )}
      {isReply && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <div className="relative">
            <button
              ref={quickTriggerRef}
              type="button"
              onClick={() => setQuickOpen((open) => !open)}
              className="toolButton"
            >
              {t("inbox.quickReplies")} <ChevronDownIcon className="h-3 w-3" />
            </button>
            {quickOpen && (
              <div
                ref={quickPanelRef}
                onKeyDown={(event) =>
                  trapFocus(event, quickPanelRef.current, () => setQuickOpen(false))
                }
                className="absolute bottom-9 left-0 z-30 w-64 rounded-lg border border-gray-200 bg-white p-1.5 shadow-xl"
              >
                {props.quickReplies.length ? (
                  props.quickReplies.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setQuickOpen(false);
                        props.onQuickReply(item.id);
                      }}
                      className="block w-full rounded-md px-2.5 py-2 text-left text-xs hover:bg-gray-50"
                    >
                      <span className="block font-semibold text-gray-800">{item.name}</span>
                      <span className="mt-0.5 line-clamp-2 text-gray-500">{item.text}</span>
                    </button>
                  ))
                ) : (
                  <p className="px-2.5 py-2 text-xs text-gray-500">{t("inbox.noQuickReplies")}</p>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setQuickOpen(false);
                    props.onManageQuickReplies();
                  }}
                  className="mt-1 w-full border-t border-gray-100 px-2.5 py-2 text-left text-xs font-semibold text-[#2F52F5]"
                >
                  {t("inbox.manageQuickReplies")}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            disabled={!props.latestInboundId || Boolean(props.assistBusy)}
            onClick={() => props.onAssist("draft_reply")}
            className="toolButton"
          >
            <SparklesIcon className="h-3.5 w-3.5" />
            {t("inbox.draftReply")}
          </button>
          <button
            type="button"
            disabled={!props.draft.reply.trim() || Boolean(props.assistBusy)}
            onClick={() => props.onAssist("translate_draft")}
            className="toolButton"
          >
            {t("inbox.translateDraft")}
          </button>
          <button
            type="button"
            disabled={!props.latestInboundId || Boolean(props.assistBusy)}
            onClick={() => props.onAssist("summarize")}
            className="toolButton"
          >
            {t("inbox.summarize")}
          </button>
          <select
            aria-label={t("inbox.assistanceLanguage")}
            value={props.assistLanguage}
            onChange={(event) => props.onAssistLanguage(event.target.value)}
            className="min-h-11 rounded-md border border-gray-200 bg-white px-2 text-base font-semibold text-gray-600 outline-none sm:text-xs md:min-h-8"
          >
            {ASSISTANCE_LANGUAGES.map(({ value, labelKey }) => (
              <option key={value} value={value}>
                {t(labelKey)}
              </option>
            ))}
          </select>
          <label
            className={cn(
              "toolButton cursor-pointer",
              props.uploadName && "cursor-not-allowed opacity-50",
            )}
          >
            <PaperClipIcon className="h-3.5 w-3.5" />
            {t("inbox.attach")}
            <input
              type="file"
              disabled={Boolean(props.uploadName)}
              accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,application/pdf"
              onChange={props.onAttachment}
              className="sr-only"
            />
          </label>
        </div>
      )}
      {isReply && (props.uploadName || props.draft.attachments.length > 0) && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {props.uploadName && (
            <span className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] text-gray-600">
              <ArrowPathIcon className="mr-1 inline h-3 w-3 animate-spin" />
              {t("inbox.preparingAttachment", { filename: props.uploadName })}
            </span>
          )}
          {props.draft.attachments.map((attachment) => (
            <span
              key={attachment.mediaId}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-700"
            >
              <PaperClipIcon className="h-3 w-3" />
              <span className="max-w-40 truncate">{attachment.filename}</span>
              <button
                type="button"
                onClick={() => props.onRemoveAttachment(attachment.mediaId)}
                aria-label={t("inbox.removeAttachment", { filename: attachment.filename })}
              >
                <XMarkIcon className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      {isReply && props.draft.assisted && (
        <div
          className={cn(
            "mb-1 text-[11px] font-medium",
            staleAssistance ? "text-amber-700" : "text-violet-700",
          )}
        >
          <SparklesIcon className="mr-1 inline h-3.5 w-3.5" />
          {staleAssistance ? t("inbox.assistedDraftStale") : t("inbox.assistedDraftReview")}
        </div>
      )}
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">{isReply ? t("inbox.reply") : t("inbox.internalNote")}</span>
          <textarea
            rows={2}
            value={value}
            onChange={(event) =>
              isReply ? props.onReply(event.target.value) : props.onNote(event.target.value)
            }
            onKeyDown={props.onKeyDown}
            placeholder={
              isReply ? t("inbox.writeReplyPlaceholder") : t("inbox.privateNotePlaceholder")
            }
            className={cn(
              "max-h-36 min-h-[56px] w-full resize-y rounded-md border bg-white px-3 py-2 text-base leading-5 outline-none focus:ring-2 sm:text-sm",
              isReply
                ? "border-gray-200 focus:border-[#2F52F5] focus:ring-[#2F52F5]/15"
                : "border-amber-300 focus:border-amber-600 focus:ring-amber-200",
            )}
          />
        </label>
        <button
          type="button"
          disabled={!canSend || props.busy}
          onClick={props.onSubmit}
          className={cn(
            "flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40",
            isReply ? "bg-[#2F52F5] hover:bg-blue-700" : "bg-amber-700 hover:bg-amber-800",
          )}
        >
          {isReply && <PaperAirplaneIcon className="h-4 w-4" />}
          {props.busy ? t("inbox.saving") : isReply ? t("inbox.send") : t("inbox.addNote")}
        </button>
      </div>
      <div className="mt-1.5 flex min-h-4 items-start justify-between gap-2">
        {props.error ? (
          <p role="alert" className="text-xs text-rose-700">
            {props.error}
          </p>
        ) : (
          <span />
        )}
        {isReply && (
          <p className="hidden shrink-0 text-[10px] text-gray-400 sm:block">
            {t("inbox.keyboardShortcutSend")}
          </p>
        )}
      </div>
    </div>
  );
}

function ContextDrawer({ thread, onClose }: { thread: InboxThread; onClose: () => void }) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previous?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <button
        type="button"
        className="absolute inset-0 h-full w-full bg-black/40"
        aria-label={t("inbox.closeGuestAndStay")}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("inbox.guestAndStayDialog")}
        tabIndex={-1}
        onKeyDown={(event) => trapFocus(event, panelRef.current, onClose)}
        className="absolute inset-y-0 right-0 flex w-full max-w-[400px] flex-col bg-white shadow-2xl outline-none"
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-gray-200 px-4">
          <h2 className="text-sm font-bold text-gray-950">{t("inbox.guestAndStay")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("inbox.closeGuestAndStay")}
            className="flex h-11 w-11 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <ConversationContext thread={thread} showHeading={false} />
      </div>
    </div>
  );
}

function ConversationContext({
  thread,
  showHeading = true,
}: {
  thread: InboxThread;
  showHeading?: boolean;
}) {
  const { t } = useTranslation();
  const context = thread.conversationContext;
  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      {showHeading && (
        <h3 className="text-sm font-bold text-gray-950">{t("inbox.guestAndStay")}</h3>
      )}
      <section className="mt-5 border-b border-gray-100 pb-5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          {t("inbox.guest")}
        </p>
        <p className="mt-2 text-sm font-semibold text-gray-900">{inboxGuestName(thread)}</p>
        {thread.guest.email && (
          <p className="mt-1 break-all text-xs text-gray-600">{thread.guest.email}</p>
        )}
        {thread.guest.phone && <p className="mt-1 text-xs text-gray-600">{thread.guest.phone}</p>}
        {!thread.guest.email && !thread.guest.phone && (
          <p className="mt-1 text-xs text-gray-400">{t("inbox.contactDetailsUnavailable")}</p>
        )}
      </section>
      <section className="border-b border-gray-100 py-5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          {t("inbox.source")}
        </p>
        <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-gray-900">
          <SourceDot thread={thread} />
          {inboxSourceLabel(thread)}
        </p>
        <p className="mt-1 text-xs text-gray-500">{inboxContextLabel(thread)}</p>
      </section>
      <section className="border-b border-gray-100 py-5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          {t("inbox.reservationContext")}
        </p>
        {context.state === "linked" ? (
          <>
            <p className="mt-2 text-xs text-gray-600">{t("inbox.linkedBooking")}</p>
            <p className="mt-1 font-mono text-sm font-semibold text-gray-900">
              {context.reference}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
              <div>
                <dt className="text-gray-400">{t("inbox.stay")}</dt>
                <dd className="mt-0.5 text-gray-700">
                  {context.stay.checkIn} – {context.stay.checkOut}
                </dd>
              </div>
              <div>
                <dt className="text-gray-400">{t("inbox.nights")}</dt>
                <dd className="mt-0.5 text-gray-700">{context.stay.nights}</dd>
              </div>
              <div>
                <dt className="text-gray-400">{t("inbox.party")}</dt>
                <dd className="mt-0.5 text-gray-700">
                  {partyLabel(context.stay.adults, context.stay.children, t)}
                </dd>
              </div>
              <div>
                <dt className="text-gray-400">{t("inbox.status")}</dt>
                <dd className="mt-0.5 text-gray-700">{humanizeCode(context.stay.status)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-gray-400">{t("inbox.room")}</dt>
                <dd className="mt-0.5 text-gray-700">
                  {context.stay.roomName ||
                    t(
                      context.stay.roomCount === 1
                        ? "inbox.roomCountSingle"
                        : "inbox.roomCountPlural",
                      { count: context.stay.roomCount },
                    )}
                  {context.stay.roomNumber
                    ? t("inbox.roomNumberSuffix", { roomNumber: context.stay.roomNumber })
                    : ""}
                </dd>
              </div>
            </dl>
            <Link
              href={`/bookings/${encodeURIComponent(context.bookingId)}`}
              className="mt-3 inline-flex min-h-11 items-center text-xs font-semibold text-[#2F52F5] hover:underline"
            >
              {t("inbox.openBooking")}
            </Link>
          </>
        ) : context.state === "inquiry" ? (
          <>
            <p className="mt-2 text-sm font-semibold text-gray-900">
              {t("inbox.inquiryNoBooking")}
            </p>
            <p className="mt-1 font-mono text-xs text-gray-500">{context.sourceReference}</p>
            {(context.arrivalDate || context.departureDate) && (
              <p className="mt-3 text-xs text-gray-600">
                {context.arrivalDate || t("inbox.dateNotSupplied")} –{" "}
                {context.departureDate || t("inbox.dateNotSupplied")}
              </p>
            )}
            {context.adults !== null || context.children !== null ? (
              <p className="mt-2 text-xs text-gray-600">
                {partyLabel(context.adults ?? 0, context.children ?? 0, t)}
              </p>
            ) : (
              <p className="mt-2 text-xs text-gray-400">{t("inbox.partySizeNotSupplied")}</p>
            )}
          </>
        ) : (
          <>
            <p className="mt-2 text-sm font-semibold text-gray-900">
              {t("inbox.unlinkedConversation")}
            </p>
            <p className="mt-1 text-xs leading-5 text-gray-500">{t("inbox.noReservationMatch")}</p>
            {context.sourceReference && (
              <p className="mt-2 font-mono text-xs text-gray-500">{context.sourceReference}</p>
            )}
          </>
        )}
      </section>
      <section className="py-5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          {t("inbox.team")}
        </p>
        <p className="mt-2 text-sm text-gray-700">
          {thread.assignedTo?.displayName ?? t("inbox.unassigned")}
        </p>
      </section>
    </div>
  );
}

function QuickReplyManager({
  propertyId,
  items,
  onItems,
  onAccessDenied,
  onClose,
}: {
  propertyId: string;
  items: InboxQuickReply[];
  onItems: (items: InboxQuickReply[]) => void;
  onAccessDenied: (error: ReturnType<typeof inboxError>) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<InboxQuickReply | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [variables, setVariables] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function edit(item?: InboxQuickReply) {
    setEditing(item ?? null);
    setName(item?.name ?? "");
    setText(item?.text ?? "");
    setVariables(item?.approvedVariables.join(", ") ?? "");
    setError(null);
  }
  async function handleFailure(parsed: ReturnType<typeof inboxError>) {
    if (await onAccessDenied(parsed)) return;
    if (parsed.code !== "quick_reply_version_conflict") {
      setError(parsed.message);
      return;
    }
    try {
      const latest = await messagingService.getQuickReplies(propertyId);
      onItems(latest.items);
      if (editing) {
        const current = latest.items.find((item) => item.id === editing.id) ?? null;
        setEditing(current);
      }
      setError(t("inbox.errorQuickReplyChanged"));
    } catch (cause) {
      const refreshError = inboxError(cause);
      if (!(await onAccessDenied(refreshError))) setError(refreshError.message);
    }
  }
  async function save() {
    if (!name.trim() || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = editing
        ? await messagingService.updateQuickReply(propertyId, {
            ...editing,
            name: name.trim(),
            text: text.trim(),
            approvedVariables: parseVariables(variables),
          })
        : await messagingService.createQuickReply(propertyId, {
            name: name.trim(),
            text: text.trim(),
            approvedVariables: parseVariables(variables),
          });
      onItems(
        editing
          ? items.map((item) => (item.id === response.quickReply.id ? response.quickReply : item))
          : [...items, response.quickReply],
      );
      edit();
    } catch (cause) {
      const parsed = inboxError(cause);
      await handleFailure(parsed);
    } finally {
      setBusy(false);
    }
  }
  async function archive(item: InboxQuickReply) {
    setBusy(true);
    setError(null);
    try {
      await messagingService.archiveQuickReply(propertyId, item);
      onItems(items.filter((candidate) => candidate.id !== item.id));
      if (editing?.id === item.id) edit();
    } catch (cause) {
      const parsed = inboxError(cause);
      await handleFailure(parsed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      onClose={onClose}
      maxWidth="lg"
      ariaLabel={t("inbox.manageQuickReplies")}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700"
          >
            {t("common.close")}
          </button>
          <button
            type="button"
            disabled={!name.trim() || !text.trim() || busy}
            onClick={() => void save()}
            className="rounded-md bg-[#2F52F5] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy
              ? t("inbox.saving")
              : editing
                ? t("inbox.saveChanges")
                : t("inbox.createQuickReply")}
          </button>
        </div>
      }
    >
      <h2 className="text-lg font-bold text-gray-950">{t("inbox.quickReplies")}</h2>
      <p className="mt-1 text-sm text-gray-500">{t("inbox.quickRepliesDescription")}</p>
      <div className="mt-5 grid gap-5 sm:grid-cols-[180px_1fr]">
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => edit()}
            className={cn(
              "min-h-11 w-full rounded-md px-3 text-left text-sm font-semibold",
              !editing ? "bg-blue-50 text-[#2F52F5]" : "text-gray-700 hover:bg-gray-50",
            )}
          >
            {t("inbox.newQuickReply")}
          </button>
          {items.map((item) => (
            <div key={item.id} className="group flex items-center">
              <button
                type="button"
                onClick={() => edit(item)}
                className={cn(
                  "min-h-11 min-w-0 flex-1 truncate rounded-md px-3 text-left text-sm",
                  editing?.id === item.id
                    ? "bg-blue-50 font-semibold text-[#2F52F5]"
                    : "text-gray-700 hover:bg-gray-50",
                )}
              >
                {item.name}
              </button>
              <button
                type="button"
                aria-label={t("inbox.archiveQuickReply", { name: item.name })}
                disabled={busy}
                onClick={() => void archive(item)}
                className="p-2 text-gray-400 hover:text-rose-600"
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700">
            {t("inbox.name")}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-base outline-none focus:border-[#2F52F5] sm:text-sm"
            />
          </label>
          <label className="mt-4 block text-xs font-semibold text-gray-700">
            {t("inbox.replyText")}
            <textarea
              rows={8}
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-base leading-6 outline-none focus:border-[#2F52F5] sm:text-sm"
            />
          </label>
          <label className="mt-4 block text-xs font-semibold text-gray-700">
            {t("inbox.approvedVariables")}
            <input
              value={variables}
              onChange={(event) => setVariables(event.target.value)}
              placeholder={t("inbox.approvedVariablesPlaceholder")}
              className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-base outline-none focus:border-[#2F52F5] sm:text-sm"
            />
          </label>
          <p className="mt-2 text-xs text-gray-500">{t("inbox.quickReplyPreviewExplanation")}</p>
          {error && (
            <p role="alert" className="mt-3 text-xs text-rose-700">
              {error}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function FollowUpDialog({
  value,
  timezone,
  busy,
  error,
  onChange,
  onClose,
  onSubmit,
}: {
  value: string;
  timezone: string;
  busy: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const followUpInstant = propertyLocalDateTimeToIso(value, timezone);
  return (
    <Modal
      onClose={onClose}
      ariaLabel={t("inbox.scheduleFollowUp")}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={busy || !followUpInstant || new Date(followUpInstant).getTime() <= Date.now()}
            onClick={onSubmit}
            className="rounded-md bg-gray-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? t("inbox.scheduling") : t("inbox.scheduleFollowUp")}
          </button>
        </div>
      }
    >
      <h2 className="text-lg font-bold text-gray-950">{t("inbox.followUpLater")}</h2>
      <p className="mt-1 text-sm text-gray-500">
        {t("inbox.followUpExplanation", { timezone: formatTimezoneLabel(timezone) })}
      </p>
      <div className="mt-5 flex gap-2">
        <button
          type="button"
          onClick={() => onChange(defaultFollowUpTime(timezone))}
          className="min-h-11 rounded-md border border-gray-200 px-3 text-sm font-semibold text-gray-700"
        >
          {t("inbox.tomorrow")}
        </button>
        <button
          type="button"
          onClick={() => onChange(defaultFollowUpTime(timezone, 2))}
          className="min-h-11 rounded-md border border-gray-200 px-3 text-sm font-semibold text-gray-700"
        >
          {t("inbox.inTwoDays")}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-4 text-sm text-rose-700">
          {error}
        </p>
      )}
      <label className="mt-4 block text-xs font-semibold text-gray-700">
        {t("inbox.dateAndTime")}
        <input
          type="datetime-local"
          value={value}
          min={formatPropertyDateTimeInput(new Date(), timezone) ?? localDateTimeInput(new Date())}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2.5 text-base outline-none focus:border-[#2F52F5] sm:text-sm"
        />
      </label>
    </Modal>
  );
}

function DirectThreadDialog({
  bookings,
  value,
  loading,
  error,
  onChange,
  onClose,
  onSubmit,
}: {
  bookings: InboxDirectBooking[];
  value: string;
  loading: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      onClose={() => {
        if (!loading) onClose();
      }}
      ariaLabel={t("inbox.newDirectGuestMessage")}
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={onClose}
            className="rounded-md border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 disabled:opacity-50"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!value || loading}
            onClick={onSubmit}
            className="rounded-md bg-[#2F52F5] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {loading ? t("inbox.opening") : t("inbox.openConversation")}
          </button>
        </div>
      }
    >
      <h2 className="text-lg font-bold text-gray-950">{t("inbox.newMessage")}</h2>
      <p className="mt-1 text-sm leading-6 text-gray-500">{t("inbox.directBookingExplanation")}</p>
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {error}
        </p>
      )}
      {loading && !bookings.length ? (
        <p role="status" className="mt-5 text-sm text-gray-500">
          {t("inbox.loadingDirectBookings")}
        </p>
      ) : bookings.length ? (
        <label className="mt-5 block text-xs font-semibold text-gray-700">
          {t("inbox.directBooking")}
          <select
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2.5 text-base outline-none focus:border-[#2F52F5] sm:text-sm"
          >
            <option value="">{t("inbox.selectBooking")}</option>
            {bookings.map((booking) => (
              <option key={booking.guestBookingId} value={booking.guestBookingId}>
                {booking.primaryGuest.displayName} · {booking.bookingReference} ·{" "}
                {booking.stay.checkIn}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="mt-5 rounded-md border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-600">
          {t("inbox.noEligibleDirectBookings")}
        </p>
      )}
    </Modal>
  );
}

function InboxDenied({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-[calc(100dvh-3rem)] items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md text-center">
        <LockClosedIcon className="mx-auto h-9 w-9 text-gray-400" />
        <h1 className="mt-4 text-lg font-bold text-gray-950">{t("inbox.accessUnavailable")}</h1>
        <p className="mt-2 text-sm leading-6 text-gray-600">
          {t("inbox.accessUnavailableExplanation")}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 min-h-11 rounded-md bg-gray-950 px-4 text-sm font-semibold text-white"
        >
          {t("inbox.tryAgain")}
        </button>
      </div>
    </div>
  );
}

function NoSelection() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div>
        <EnvelopeIcon className="mx-auto h-9 w-9 text-gray-300" />
        <h2 className="mt-4 text-sm font-semibold text-gray-800">
          {t("inbox.selectConversation")}
        </h2>
        <p className="mt-1 max-w-xs text-xs leading-5 text-gray-500">
          {t("inbox.selectConversationExplanation")}
        </p>
      </div>
    </div>
  );
}
function QueueSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t("inbox.loadingConversations")}
      className="animate-pulse divide-y divide-gray-100"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="h-[108px] px-4 py-4">
          <div className="h-3 w-2/3 rounded bg-gray-200" />
          <div className="mt-3 h-2.5 w-1/2 rounded bg-gray-100" />
          <div className="mt-3 h-2.5 w-full rounded bg-gray-100" />
        </div>
      ))}
    </div>
  );
}
function ConversationSkeleton() {
  const { t } = useTranslation();
  return (
    <div role="status" aria-label={t("inbox.loadingConversation")} className="h-full animate-pulse">
      <div className="h-24 border-b border-gray-200 bg-white p-4">
        <div className="h-4 w-36 rounded bg-gray-200" />
        <div className="mt-3 h-3 w-56 rounded bg-gray-100" />
      </div>
      <div className="space-y-4 p-5">
        <div className="h-24 w-3/5 rounded-xl bg-white" />
        <div className="ml-auto h-20 w-2/3 rounded-xl bg-blue-50" />
        <div className="h-28 w-1/2 rounded-xl bg-white" />
      </div>
    </div>
  );
}
function EmptyQueue({ state }: { state: InboxAttentionState }) {
  const { t } = useTranslation();
  const copy =
    state === "needs_attention"
      ? [t("inbox.emptyCaughtUpTitle"), t("inbox.emptyCaughtUpDescription")]
      : state === "follow_up"
        ? [t("inbox.emptyFollowUpTitle"), t("inbox.emptyFollowUpDescription")]
        : [t("inbox.emptyDoneTitle"), t("inbox.emptyDoneDescription")];
  return (
    <div className="px-6 py-16 text-center">
      <CheckCircleIcon className="mx-auto h-8 w-8 text-gray-300" />
      <h2 className="mt-3 text-sm font-semibold text-gray-800">{copy[0]}</h2>
      <p className="mt-1 text-xs leading-5 text-gray-500">{copy[1]}</p>
    </div>
  );
}
function PaneError({
  error,
  onRetry,
}: {
  error: ReturnType<typeof inboxError>;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="m-4 rounded-lg border border-rose-200 bg-rose-50 p-4" role="alert">
      <p className="text-sm font-semibold text-rose-900">{t("inbox.loadError")}</p>
      <p className="mt-1 text-xs leading-5 text-rose-700">
        {error.message}
        {error.requestId ? t("inbox.requestId", { requestId: error.requestId }) : ""}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 min-h-11 rounded-md border border-rose-300 bg-white px-3 text-xs font-semibold text-rose-800"
      >
        {t("inbox.retry")}
      </button>
    </div>
  );
}

function DeliveryLabel({
  delivery,
  onCopy,
}: {
  delivery: NonNullable<InboxMessage["delivery"]>;
  onCopy?: () => void;
}) {
  const { t } = useTranslation();
  const label =
    delivery.state === "retrying"
      ? t("inbox.deliveryRetrying")
      : delivery.state === "held"
        ? t("inbox.deliveryHeld")
        : t(`inbox.delivery${delivery.state.charAt(0).toUpperCase()}${delivery.state.slice(1)}`);
  const tone =
    delivery.state === "sent"
      ? "text-emerald-700"
      : delivery.state === "queued"
        ? "text-gray-500"
        : delivery.state === "retrying"
          ? "text-amber-700"
          : "text-rose-700";
  return (
    <div
      aria-live="polite"
      className={cn("mt-1 flex items-center gap-2 px-1 text-[10px] font-semibold", tone)}
    >
      <span>{label}</span>
      {delivery.reasonCode && <span>· {deliveryReasonLabel(delivery.reasonCode, t)}</span>}
      {delivery.providerAcknowledgedAt && <span>· {t("inbox.providerAcknowledged")}</span>}
      {delivery.state === "failed" && onCopy && (
        <button type="button" onClick={onCopy} className="underline">
          {t("inbox.copyToNewReply")}
        </button>
      )}
    </div>
  );
}
function AssistedBlock({
  label,
  response,
  stale,
  onDismiss,
  compact = false,
}: {
  label: string;
  response: InboxAssistanceResponse;
  stale: boolean;
  onDismiss: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "mb-4 rounded-md border border-violet-200 bg-violet-50 p-3 text-sm text-violet-950",
        compact && "mt-2 mb-0",
      )}
    >
      <div className="flex items-start gap-2">
        <SparklesIcon className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-violet-700">
            {stale ? t("inbox.assistedResultStale") : label}
          </p>
          <p className="mt-1 whitespace-pre-wrap leading-6">{response.assistedText}</p>
          {response.basedThroughMessageId && (
            <p className="mt-2 text-[10px] text-violet-600">
              {t("inbox.basedThroughMessage", {
                messageId: response.basedThroughMessageId.slice(0, 8),
              })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("inbox.dismissAssistedResult", { label })}
          className="text-violet-500"
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
function ActionButton({
  label,
  busy,
  onClick,
  icon,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
  icon?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50 md:min-h-9"
    >
      {icon}
      {busy ? t("inbox.saving") : label}
    </button>
  );
}
function SourceDot({ thread }: { thread: Pick<InboxThread, "channel" | "providerChannel"> }) {
  const source = inboxSourceLabel(thread);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[8px] font-bold text-white",
        source === "Booking.com"
          ? "bg-[#003580]"
          : source === "Airbnb"
            ? "bg-rose-500"
            : source === "Email"
              ? "bg-emerald-600"
              : "bg-gray-500",
      )}
    >
      {source === "Booking.com" ? "B" : source.charAt(0)}
    </span>
  );
}

function filterClass(active: boolean) {
  return cn(
    "flex min-h-11 items-center justify-center gap-1 rounded-md border px-2 text-xs font-semibold md:min-h-9",
    active
      ? "border-[#2F52F5] bg-blue-50 text-[#2F52F5]"
      : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50",
  );
}
function composerTab(active: boolean) {
  return cn(
    "min-h-8 rounded-md px-3 text-xs font-semibold",
    active ? "bg-gray-950 text-white" : "text-gray-500 hover:bg-gray-100",
  );
}
function heldRouteRecoveryPath(
  reason: Extract<InboxThread["replyRoute"], { state: "held" }>["reasonCode"],
): string | null {
  if (reason === "channel_connection_inactive") return "/channel-manager";
  if (reason === "approved_sender_unavailable" || reason === "email_policy_disallowed") {
    return "/settings";
  }
  return null;
}
function usePopoverFocus(open: boolean) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const timer = window.setTimeout(() => focusableElements(panelRef.current)[0]?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      trigger?.focus();
    };
  }, [open]);
  return { triggerRef, panelRef };
}
function trapFocus(
  event: KeyboardEvent<HTMLElement>,
  panel: HTMLElement | null,
  onClose: () => void,
) {
  if (event.key === "Escape") {
    onClose();
    return;
  }
  if (event.key !== "Tab") return;
  const nodes = focusableElements(panel);
  if (!nodes.length) {
    event.preventDefault();
    return;
  }
  const first = nodes[0]!;
  const last = nodes.at(-1)!;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
function focusableElements(panel: HTMLElement | null): HTMLElement[] {
  return Array.from(
    panel?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  ).filter((element) => element.getClientRects().length > 0);
}
function parseAttentionState(value: string | null): InboxAttentionState {
  return value === "follow_up" || value === "done" ? value : "needs_attention";
}
function parseChannel(value: string | null): InboxChannel | "" {
  return value === "ota" || value === "email" ? value : "";
}
function uniqueThreads(items: InboxThread[]): InboxThread[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}
function mergeTimeline(
  current: InboxTimelineItem[],
  fresh: InboxTimelineItem[],
): InboxTimelineItem[] {
  const key = (item: InboxTimelineItem) =>
    `${item.kind}:${item.kind === "message" ? item.message.id : item.note.id}`;
  const merged = new Map(current.map((item) => [key(item), item]));
  for (const item of fresh) merged.set(key(item), item);
  return Array.from(merged.values()).sort((left, right) => {
    const leftAt = left.kind === "message" ? left.message.occurredAt : left.note.occurredAt;
    const rightAt = right.kind === "message" ? right.message.occurredAt : right.note.occurredAt;
    return leftAt.localeCompare(rightAt) || key(left).localeCompare(key(right));
  });
}
function parseVariables(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((variable) => variable.trim())
        .filter(Boolean),
    ),
  );
}
function deliveryReasonLabel(reason: string, t: ReturnType<typeof useTranslation>["t"]): string {
  switch (reason) {
    case "transient_provider_failure":
      return t("inbox.deliveryReasonTemporaryProviderFailure");
    case "ambiguous_provider_outcome":
      return t("inbox.deliveryReasonUnknownProviderOutcome");
    case "access_unavailable":
      return t("inbox.deliveryReasonProviderAccessUnavailable");
    case "provider_configuration_unavailable":
      return t("inbox.deliveryReasonProviderConfigurationUnavailable");
    case "invalid_delivery_payload":
      return t("inbox.deliveryReasonInvalidPayload");
    case "provider_rejected":
      return t("inbox.deliveryReasonProviderRejected");
    case "retry_exhausted":
      return t("inbox.deliveryReasonRetriesExhausted");
    default:
      return humanizeCode(reason);
  }
}
function humanizeCode(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}
function partyLabel(
  adults: number,
  children: number,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const adultLabel = t(adults === 1 ? "inbox.adultCountSingle" : "inbox.adultCountPlural", {
    count: adults,
  });
  return children
    ? t("inbox.partyCounts", {
        adults: adultLabel,
        children: t(children === 1 ? "inbox.childCountSingle" : "inbox.childCountPlural", {
          count: children,
        }),
      })
    : adultLabel;
}
function isReadAccessDenial(error: ReturnType<typeof inboxError>): boolean {
  return (
    error.status === 403 &&
    [
      "missing_entitlement",
      "inactive_entitlement",
      "missing_resource_access",
      "missing_permission",
    ].includes(error.code ?? "")
  );
}
function isEntitlementOrResourceDenial(error: ReturnType<typeof inboxError>): boolean {
  return (
    error.status === 403 &&
    ["missing_entitlement", "inactive_entitlement", "missing_resource_access"].includes(
      error.code ?? "",
    )
  );
}
function isReplyPermissionDenial(error: ReturnType<typeof inboxError>): boolean {
  return error.status === 403 && error.code === "missing_permission";
}
function localDateTimeInput(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function relativeLocalInput(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  return localDateTimeInput(date);
}
function defaultFollowUpTime(timeZone: string, days = 1): string {
  const today = formatPropertyDateTimeInput(new Date(), timeZone)?.slice(0, 10);
  if (!today) return relativeLocalInput(1);
  const tomorrow = new Date(`${today}T09:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + days);
  return tomorrow.toISOString().slice(0, 16);
}
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildMarketplaceMessageIdempotencyKey,
  collaborationService,
  filterConversations,
  readChatCollaborationId,
  transformCollaborationResponse,
  DetailedCollaboration,
  MessageResponse,
  UpdateCollaborationTermsRequest,
  ConversationResponse,
} from "@/services/api/collaborations";
import { AuthenticatedNavigation } from "@/components/layout";
import { useSidebar } from "@/components/layout/AuthenticatedNavigation";
import SuggestChangesModal from "./SuggestChangesModal";
import {
  MagnifyingGlassIcon,
  ArrowTopRightOnSquareIcon,
  EllipsisVerticalIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { CollaborationRequestDetailModal } from "@/components/marketplace/CollaborationRequestDetailModal";
import {
  PendingApplicationsList,
  ConversationsList,
  ChatMessageArea,
  ChatDetailsPanel,
  type PendingRequest,
} from "@/components/chat";
import type { Collaboration, Hotel, Creator } from "@/lib/types";
import { STORAGE_KEYS, getStatusClasses } from "@/lib/constants";
import { getInitials, formatCompactNumber, getCurrencySymbol } from "@/lib/utils";
import {
  createConversationSummary,
  isCurrentChatSelection,
  restoreConversationAfterFailedSend,
} from "@/lib/utils/chatSelectionGuard";
import {
  createChatSendLock,
  resolveChatMessageRetryAttempt,
  type ChatMessageRetryAttempt,
} from "@/lib/utils/chatSendGuard";

function ChatPageContent() {
  const { isCollapsed } = useSidebar();
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [isSuggestModalOpen, setIsSuggestModalOpen] = useState(false);
  const [detailCollaboration, setDetailCollaboration] = useState<
    (Collaboration & { hotel?: Hotel; creator?: Creator }) | null
  >(null);

  // State for pending applications and conversations
  const [userType, setUserType] = useState<string | null>(null);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [conversations, setConversations] = useState<ConversationResponse[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const [realMessages, setRealMessages] = useState<MessageResponse[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [activeCollaboration, setActiveCollaboration] = useState<DetailedCollaboration | null>(
    null,
  );
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isCancelModalOpen, setIsCancelModalOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancellationTargetId, setCancellationTargetId] = useState<string | null>(null);
  const selectedChatIdRef = useRef<string | null>(null);
  const chatSelectionGenerationRef = useRef(0);
  const messageSendLockRef = useRef(createChatSendLock());
  const messageRetryRef = useRef<ChatMessageRetryAttempt | null>(null);

  const selectChat = useCallback((collaborationId: string) => {
    if (selectedChatIdRef.current === collaborationId) return;
    selectedChatIdRef.current = collaborationId;
    chatSelectionGenerationRef.current += 1;
    setSelectedChatId(collaborationId);
    setRealMessages([]);
    setActiveCollaboration(null);
    setHasMoreMessages(true);
    setIsLoadingMore(false);
    setIsLoadingMessages(false);
    setIsMenuOpen(false);
    setMessageInput("");
    setIsSuggestModalOpen(false);
    setIsCancelModalOpen(false);
    setCancelReason("");
    setCancellationTargetId(null);
  }, []);

  const isSelectionCurrent = useCallback(
    (collaborationId: string, selectionGeneration: number) =>
      isCurrentChatSelection(
        collaborationId,
        selectionGeneration,
        selectedChatIdRef.current,
        chatSelectionGenerationRef.current,
      ),
    [],
  );

  useEffect(() => {
    if (typeof window !== "undefined") {
      const storedUserType = localStorage.getItem(STORAGE_KEYS.USER_TYPE) || "hotel";
      setUserType(storedUserType);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const collaborationId = readChatCollaborationId(window.location.search);
    if (collaborationId) selectChat(collaborationId);
  }, [selectChat]);

  const fetchData = async () => {
    if (!userType) return;

    try {
      const requestsData =
        userType === "hotel"
          ? await collaborationService.getHotelCollaborations({ status: "pending" })
          : await collaborationService.getCreatorCollaborations();

      const formattedRequests = requestsData
        .filter((collab) => collab.status === "pending")
        .map((collab) => {
          const isReceived = !collab.is_initiator;
          const derivedPlatforms = collab.platforms || [];

          let offerDetails = "";
          if (userType === "creator" && collab.collaboration_type) {
            if (collab.collaboration_type === "Free Stay" && collab.free_stay_max_nights) {
              offerDetails = `${collab.free_stay_max_nights} Nights`;
            } else if (collab.collaboration_type === "Paid" && collab.paid_amount) {
              offerDetails = `${getCurrencySymbol(collab.currency || "USD")}${Number(collab.paid_amount).toLocaleString()}`;
            } else if (collab.collaboration_type === "Discount" && collab.discount_percentage) {
              offerDetails = `${collab.discount_percentage}% Off`;
            } else {
              offerDetails = collab.collaboration_type;
            }
          }

          return {
            id: collab.id,
            updatedAt: collab.updated_at,
            name: userType === "hotel" ? collab.creator_name : collab.hotel_name || "Hotel",
            time: new Date(collab.created_at).toLocaleDateString(),
            followers:
              collab.total_followers == null ? null : formatCompactNumber(collab.total_followers),
            followersPlatform: collab.active_platform?.toLowerCase() ?? null,
            engagement:
              collab.avg_engagement_rate == null
                ? null
                : `${collab.avg_engagement_rate.toFixed(1)}%`,
            engagementPlatform: collab.active_platform?.toLowerCase() ?? null,
            platforms: derivedPlatforms,
            location: collab.listing_location || collab.hotel_location || "",
            collaborationType: collab.collaboration_type || "",
            offerDetails: offerDetails,
            avatarColor: "bg-blue-100 text-blue-600",
            avatarUrl: userType === "hotel" ? collab.creator_profile_picture : collab.hotel_picture,
            initials: getInitials(
              userType === "hotel" ? collab.creator_name : collab.hotel_name || "Hotel",
            ),
            isReceived,
            status: collab.status,
          };
        });
      setPendingRequests(formattedRequests);

      const convData = await collaborationService.getConversations();
      setConversations(convData);
    } catch (error) {
      console.error("Failed to fetch chat data:", error);
    } finally {
      setIsLoadingConversations(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [userType]);

  const fetchMessages = async (silent = false, skipDetails = false) => {
    const collaborationId = selectedChatIdRef.current;
    const selectionGeneration = chatSelectionGenerationRef.current;
    if (!collaborationId || !userType) return;
    const isCurrentSelection = () => isSelectionCurrent(collaborationId, selectionGeneration);

    if (!silent) {
      setIsLoadingMessages(true);
    }

    setHasMoreMessages(true);

    try {
      const msgData = await collaborationService.getMessages(collaborationId);
      if (!isCurrentSelection()) return;
      const reversed = [...msgData].reverse();
      setRealMessages(reversed);
      const readThrough = msgData[0];
      if (readThrough)
        void collaborationService
          .markAsRead(collaborationId, readThrough)
          .then(() => {
            if (!isCurrentSelection()) return;
            setConversations((prev) =>
              prev.map((conversation) =>
                conversation.collaboration_id === collaborationId
                  ? { ...conversation, unread_count: 0 }
                  : conversation,
              ),
            );
          })
          .catch((error) => {
            if (isCurrentSelection()) console.error("Failed to mark messages as read:", error);
          });
      if (msgData.length < 50) {
        setHasMoreMessages(false);
      }

      if (!skipDetails) {
        const detailResponse =
          userType === "hotel"
            ? await collaborationService.getHotelCollaborationDetails(collaborationId)
            : await collaborationService.getCreatorCollaborationDetails(collaborationId);
        if (!isCurrentSelection()) return;

        const detailedCollaboration = transformCollaborationResponse(detailResponse);
        setActiveCollaboration(detailedCollaboration);
      }
    } catch (error) {
      if (isCurrentSelection()) console.error("Failed to fetch chat details:", error);
    } finally {
      if (isCurrentSelection()) {
        if (!silent) {
          setIsLoadingMessages(false);
        }
        setIsMenuOpen(false);
      }
    }
  };

  useEffect(() => {
    if (!selectedChatId) {
      setRealMessages([]);
      return;
    }
    fetchMessages();
  }, [selectedChatId, userType]);

  const handleLoadMore = async () => {
    const collaborationId = selectedChatIdRef.current;
    const selectionGeneration = chatSelectionGenerationRef.current;
    if (isLoadingMore || !hasMoreMessages || !collaborationId || realMessages.length === 0) return;
    const isCurrentSelection = () => isSelectionCurrent(collaborationId, selectionGeneration);

    setIsLoadingMore(true);
    try {
      const oldestMessage = realMessages[0];
      const data = await collaborationService.getMessages(collaborationId, oldestMessage);
      if (!isCurrentSelection()) return;

      if (data.length === 0) {
        setHasMoreMessages(false);
      } else {
        const reversed = [...data].reverse();
        setRealMessages((prev) => [...reversed, ...prev]);
        if (data.length < 50) {
          setHasMoreMessages(false);
        }
      }
    } catch (error) {
      if (isCurrentSelection()) console.error("Failed to load more messages:", error);
    } finally {
      if (isCurrentSelection()) setIsLoadingMore(false);
    }
  };

  const handleViewDetails = async (id: string) => {
    try {
      const detailResponse =
        userType === "creator"
          ? await collaborationService.getCreatorCollaborationDetails(id)
          : await collaborationService.getHotelCollaborationDetails(id);
      const detailedCollaboration = transformCollaborationResponse(detailResponse);
      setDetailCollaboration(detailedCollaboration);
    } catch (error) {
      console.error("Error fetching collaboration details:", error);
    }
  };

  const handleAccept = async (id: string) => {
    try {
      await collaborationService.respondToCollaboration(id, {
        status: "accepted",
        expectedUpdatedAt:
          detailCollaboration?.id === id
            ? detailCollaboration.updatedAt.toISOString()
            : pendingRequests.find((r) => r.id === id)?.updatedAt,
      });
      setPendingRequests((prev) => prev.filter((r) => r.id !== id));
      setDetailCollaboration(null);
      const convData = await collaborationService.getConversations();
      setConversations(convData);
    } catch (error) {
      await handleViewDetails(id);
      window.alert(error instanceof Error ? error.message : "Could not accept request.");
    }
  };

  const handleDecline = async (id: string) => {
    try {
      await collaborationService.respondToCollaboration(id, {
        status: "declined",
        expectedUpdatedAt:
          detailCollaboration?.id === id
            ? detailCollaboration.updatedAt.toISOString()
            : pendingRequests.find((r) => r.id === id)?.updatedAt,
      });
      setPendingRequests((prev) => prev.filter((r) => r.id !== id));
      setDetailCollaboration(null);
      const convData = await collaborationService.getConversations();
      setConversations(convData);
    } catch (error) {
      await handleViewDetails(id);
      window.alert(error instanceof Error ? error.message : "Could not decline request.");
    }
  };

  const listedActiveChat = selectedChatId
    ? conversations.find((conversation) => conversation.collaboration_id === selectedChatId)
    : null;
  const latestMessage = realMessages[realMessages.length - 1];
  const activeChat =
    listedActiveChat ||
    createConversationSummary(selectedChatId, activeCollaboration, userType, latestMessage);
  const visibleConversations = useMemo(
    () => filterConversations(conversations, searchQuery),
    [conversations, searchQuery],
  );

  const handleSelectChat = (collaborationId: string) => {
    selectChat(collaborationId);
    if (typeof window === "undefined") return;

    const url = new URL(window.location.href);
    url.searchParams.set("collaborationId", collaborationId);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  };

  const toggleDeliverable = async (deliverableId: string) => {
    const collaborationId = selectedChatIdRef.current;
    const selectionGeneration = chatSelectionGenerationRef.current;
    if (!collaborationId) return;

    try {
      const updatedResponse = await collaborationService.toggleDeliverable(
        collaborationId,
        deliverableId,
      );
      if (!isSelectionCurrent(collaborationId, selectionGeneration)) return;
      const detailedCollaboration = transformCollaborationResponse(updatedResponse);
      setActiveCollaboration(detailedCollaboration);
      void fetchMessages(true, true);
    } catch (error) {
      if (isSelectionCurrent(collaborationId, selectionGeneration)) {
        console.error("Failed to toggle deliverable:", error);
      }
    }
  };

  const handleSuggestChanges = async (data: UpdateCollaborationTermsRequest) => {
    const collaborationId = selectedChatIdRef.current;
    const selectionGeneration = chatSelectionGenerationRef.current;
    if (!collaborationId) return;

    try {
      const updatedResponse = await collaborationService.updateTerms(collaborationId, data);
      if (!isSelectionCurrent(collaborationId, selectionGeneration)) return;
      const detailedCollaboration = transformCollaborationResponse(updatedResponse);
      setActiveCollaboration(detailedCollaboration);
      setIsSuggestModalOpen(false);
      void fetchMessages(true, true);
    } catch (error) {
      if (isSelectionCurrent(collaborationId, selectionGeneration)) {
        console.error("Failed to suggest changes:", error);
      }
    }
  };

  const handleApproveTerms = async (id?: string) => {
    const collaborationId = selectedChatIdRef.current;
    const selectionGeneration = chatSelectionGenerationRef.current;
    const targetId = id || collaborationId;
    if (!collaborationId || targetId !== collaborationId) return;

    try {
      const updatedResponse = await collaborationService.approveCollaboration(targetId);
      if (!isSelectionCurrent(collaborationId, selectionGeneration)) return;
      const detailedCollaboration = transformCollaborationResponse(updatedResponse);
      setActiveCollaboration(detailedCollaboration);
      void fetchMessages(true, true);
    } catch (error) {
      if (isSelectionCurrent(collaborationId, selectionGeneration)) {
        console.error("Failed to approve terms:", error);
      }
    }
  };

  const handleCancelCollaboration = async () => {
    const targetId = cancellationTargetId;
    const collaborationId = selectedChatIdRef.current;
    const selectionGeneration = chatSelectionGenerationRef.current;
    const reason = cancelReason;
    if (!targetId || !collaborationId || targetId !== collaborationId) return;

    try {
      const response = await collaborationService.cancelCollaboration(targetId, reason);
      if (!isSelectionCurrent(collaborationId, selectionGeneration)) return;

      const detailedCollaboration = transformCollaborationResponse(response);
      setActiveCollaboration(detailedCollaboration);
      void fetchMessages(true, true);
      void fetchData();
      setIsCancelModalOpen(false);
      setCancelReason("");
      setCancellationTargetId(null);
      setIsMenuOpen(false);
    } catch (error) {
      if (isSelectionCurrent(collaborationId, selectionGeneration)) {
        console.error("Failed to cancel collaboration:", error);
      }
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const collaborationId = selectedChatIdRef.current;
    const selectionGeneration = chatSelectionGenerationRef.current;
    if (!messageInput.trim() || !collaborationId) return;

    const releaseSendLock = messageSendLockRef.current.tryAcquire();
    if (!releaseSendLock) return;

    const content = messageInput.trim();
    const attempt = resolveChatMessageRetryAttempt(
      messageRetryRef.current,
      collaborationId,
      content,
      () => buildMarketplaceMessageIdempotencyKey(collaborationId),
    );
    const { idempotencyKey } = attempt;
    messageRetryRef.current = attempt;
    setIsSendingMessage(true);
    const previousConversationIndex = conversations.findIndex(
      (conversation) => conversation.collaboration_id === collaborationId,
    );
    const previousConversation =
      previousConversationIndex === -1 ? null : conversations[previousConversationIndex];
    const tempMessage: MessageResponse = {
      id: `temp-${Date.now()}`,
      collaboration_id: collaborationId,
      sender_id: "me",
      sender_name: "Me",
      sender_avatar: null,
      content,
      content_type: "text",
      metadata: null,
      created_at: new Date().toISOString(),
    };
    setMessageInput("");

    try {
      setRealMessages((prev) => [...prev, tempMessage]);

      setConversations((prev) => {
        const chatIndex = prev.findIndex((c) => c.collaboration_id === collaborationId);
        if (chatIndex === -1) return prev;

        const updatedChat = {
          ...prev[chatIndex],
          last_message_content: content,
          last_message_at: tempMessage.created_at,
          unread_count: 0,
        };

        const filtered = prev.filter((c) => c.collaboration_id !== collaborationId);
        return [updatedChat, ...filtered];
      });

      const sentMessage = await collaborationService.sendMessage(
        collaborationId,
        content,
        idempotencyKey,
      );
      if (messageRetryRef.current?.idempotencyKey === idempotencyKey) {
        messageRetryRef.current = null;
      }
      if (!isSelectionCurrent(collaborationId, selectionGeneration)) return;
      setRealMessages((prev) =>
        prev.map((message) => (message.id === tempMessage.id ? sentMessage : message)),
      );
    } catch (error) {
      setConversations((prev) =>
        restoreConversationAfterFailedSend(
          prev,
          collaborationId,
          tempMessage.created_at,
          previousConversation,
          previousConversationIndex,
        ),
      );
      if (!isSelectionCurrent(collaborationId, selectionGeneration)) return;
      console.error("Failed to send message:", error);
      setRealMessages((prev) => prev.filter((message) => message.id !== tempMessage.id));
      setMessageInput((currentDraft) => currentDraft || content);
    } finally {
      releaseSendLock();
      setIsSendingMessage(false);
    }
  };

  const handleSendImageMessage = async (file: File, caption?: string) => {
    const collaborationId = selectedChatIdRef.current;
    const selectionGeneration = chatSelectionGenerationRef.current;
    if (!collaborationId || (userType !== "creator" && userType !== "hotel")) {
      throw new Error("Choose a conversation before sending an image.");
    }

    const releaseSendLock = messageSendLockRef.current.tryAcquire();
    if (!releaseSendLock) throw new Error("Another message is still being sent.");

    setIsSendingMessage(true);
    try {
      const imageMessage = await collaborationService.sendChatImage(
        collaborationId,
        userType,
        file,
        caption,
      );
      if (!isSelectionCurrent(collaborationId, selectionGeneration)) return;

      setRealMessages((previous) => [...previous, imageMessage]);
      setConversations((previous) => {
        const conversationIndex = previous.findIndex(
          (conversation) => conversation.collaboration_id === collaborationId,
        );
        if (conversationIndex === -1) return previous;

        const updatedConversation = {
          ...previous[conversationIndex],
          last_message_content: imageMessage.content,
          last_message_at: imageMessage.created_at,
          unread_count: 0,
        };
        return [
          updatedConversation,
          ...previous.filter((conversation) => conversation.collaboration_id !== collaborationId),
        ];
      });
    } finally {
      releaseSendLock();
      setIsSendingMessage(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col bg-gray-50">
      <AuthenticatedNavigation />

      <div
        className={`fixed bottom-0 left-0 right-0 top-12 z-0 flex gap-3 p-3 transition-all duration-200 md:p-4 ${
          isCollapsed ? "md:pl-[4.5rem]" : "md:pl-56"
        }`}
      >
        {/* COLUMN 1: LEFT SIDEBAR */}
        <div className="flex h-full w-80 flex-shrink-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm md:w-96">
          {/* Search */}
          <div className="border-b border-gray-100 p-3">
            <div className="mb-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Collaboration inbox
              </p>
              <h1 className="text-base font-semibold text-gray-950">Messages</h1>
            </div>
            <div className="relative">
              <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="h-10 w-full rounded-md border border-gray-200 bg-gray-50 pl-9 pr-3 text-sm focus:border-primary-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {/* Pending Applications */}
            <PendingApplicationsList
              requests={pendingRequests}
              userType={userType}
              onViewDetails={handleViewDetails}
              onAccept={handleAccept}
              onDecline={handleDecline}
            />

            {/* Conversations List */}
            <ConversationsList
              conversations={visibleConversations}
              selectedChatId={selectedChatId}
              isLoading={isLoadingConversations}
              onSelectChat={handleSelectChat}
            />
          </div>
        </div>

        {/* MIDDLE & RIGHT COLUMNS */}
        {selectedChatId && activeChat && activeCollaboration ? (
          <>
            {/* COLUMN 2: CHAT AREA */}
            <div className="relative flex h-full flex-1 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
              {/* Chat Header */}
              <div className="flex h-[64px] flex-shrink-0 items-center justify-between border-b border-gray-100 bg-white px-4">
                <div className="flex items-center gap-3">
                  {activeChat.partner_avatar ? (
                    <img
                      src={activeChat.partner_avatar}
                      alt=""
                      className="w-10 h-10 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-sm font-bold">
                      {getInitials(activeChat.partner_name)}
                    </div>
                  )}
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold leading-none text-gray-950">
                        {activeChat.partner_name}
                      </h3>
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${getStatusClasses(activeChat.collaboration_status)}`}
                      >
                        {activeChat.collaboration_status}
                      </span>
                    </div>
                    {activeCollaboration.listingName && (
                      <div className="flex w-fit items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5">
                        <span className="text-[9px] font-black text-gray-400 uppercase tracking-tight">
                          {userType === "hotel" ? "Applied to:" : "Property:"}
                        </span>
                        <span className="text-xs font-semibold tracking-wide text-gray-700">
                          {activeCollaboration.listingName}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setDetailCollaboration(activeCollaboration)}
                    className="flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
                  >
                    Details <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                  </button>

                  {/* More Options Menu */}
                  <div className="relative">
                    <button
                      onClick={() => setIsMenuOpen(!isMenuOpen)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      <EllipsisVerticalIcon className="w-5 h-5" />
                    </button>

                    {isMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setIsMenuOpen(false)} />
                        <div className="absolute right-0 top-full mt-2 w-48 bg-white border border-gray-100 rounded-xl shadow-lg z-20 py-1 overflow-hidden">
                          {["pending", "negotiating", "accepted"].includes(
                            activeChat.collaboration_status.toLowerCase(),
                          ) && (
                            <button
                              onClick={() => {
                                setCancellationTargetId(selectedChatId);
                                setIsCancelModalOpen(true);
                                setIsMenuOpen(false);
                              }}
                              className="w-full px-4 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50 flex items-center gap-2"
                            >
                              <ExclamationTriangleIcon className="w-4 h-4" />
                              {activeChat.collaboration_status.toLowerCase() === "pending"
                                ? "Withdraw Request"
                                : "Cancel Collaboration"}
                            </button>
                          )}
                          {!["pending", "negotiating", "accepted"].includes(
                            activeChat.collaboration_status.toLowerCase(),
                          ) && (
                            <div className="px-4 py-3 text-xs text-gray-400 italic text-center">
                              No actions available
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Messages Area */}
              <ChatMessageArea
                key={selectedChatId}
                messages={realMessages}
                activeChat={activeChat}
                isLoading={isLoadingMessages}
                isLoadingMore={isLoadingMore}
                hasMoreMessages={hasMoreMessages}
                messageInput={messageInput}
                onMessageInputChange={setMessageInput}
                onSendMessage={handleSendMessage}
                onSendImageMessage={handleSendImageMessage}
                isSending={isSendingMessage}
                onLoadMore={handleLoadMore}
              />
            </div>

            {/* COLUMN 3: DETAILS PANEL */}
            <ChatDetailsPanel
              activeChat={activeChat}
              activeCollaboration={activeCollaboration}
              userType={userType}
              onToggleDeliverable={toggleDeliverable}
              onSuggestChanges={() => setIsSuggestModalOpen(true)}
              onApproveTerms={() => handleApproveTerms()}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-gray-200 bg-white shadow-sm">
            <div className="text-center">
              <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <MagnifyingGlassIcon className="w-8 h-8 text-gray-300" />
              </div>
              <h3 className="text-lg font-semibold text-gray-700 mb-1">Select a conversation</h3>
              <p className="text-sm text-gray-500">
                Choose a chat from the sidebar to view messages
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      <CollaborationRequestDetailModal
        isOpen={!!detailCollaboration}
        onClose={() => setDetailCollaboration(null)}
        collaboration={detailCollaboration}
        currentUserType={userType as "hotel" | "creator"}
        onUpdated={(value) => {
          setDetailCollaboration(value);
          if (value.status !== "pending")
            setPendingRequests((prev) => prev.filter((r) => r.id !== value.id));
        }}
        onAccept={handleAccept}
        onDecline={handleDecline}
      />

      <SuggestChangesModal
        isOpen={isSuggestModalOpen}
        onClose={() => setIsSuggestModalOpen(false)}
        initialCheckIn={
          activeCollaboration?.travelDateFrom || activeCollaboration?.preferredDateFrom || ""
        }
        initialCheckOut={
          activeCollaboration?.travelDateTo || activeCollaboration?.preferredDateTo || ""
        }
        initialPlatformDeliverables={activeCollaboration?.platformDeliverables || []}
        initialCollaborationType={activeCollaboration?.collaborationType}
        initialFreeStayMaxNights={activeCollaboration?.freeStayMaxNights}
        initialPaidAmount={activeCollaboration?.paidAmount}
        initialCurrency={activeCollaboration?.currency}
        initialDiscountPercentage={activeCollaboration?.discountPercentage}
        initialCreatorFee={activeCollaboration?.creatorFee}
        allowedCollaborationTypes={activeCollaboration?.allowedCollaborationTypes}
        userType={userType}
        onSubmit={handleSuggestChanges}
      />

      {/* Cancel Modal */}
      {isCancelModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full mx-4 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 mb-2">Cancel Collaboration</h3>
            <p className="text-sm text-gray-500 mb-4">
              Are you sure you want to cancel this collaboration? This action cannot be undone.
            </p>
            <textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Reason for cancellation (optional)"
              className="w-full p-3 border border-gray-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              rows={3}
            />
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => {
                  setIsCancelModalOpen(false);
                  setCancelReason("");
                  setCancellationTargetId(null);
                }}
                className="flex-1 py-2.5 px-4 text-sm font-bold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
              >
                Keep Collaboration
              </button>
              <button
                onClick={handleCancelCollaboration}
                className="flex-1 py-2.5 px-4 text-sm font-bold text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors"
              >
                Cancel Collaboration
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default function ChatPage() {
  return <ChatPageContent />;
}

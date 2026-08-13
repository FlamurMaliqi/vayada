"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { channexService, type ChannexOperation, type ChannexSnapshot } from "@/services/channex";

export const terminalChannexStatuses = new Set(["succeeded", "failed", "dead_lettered"]);
const markupChannels = new Set(["booking_com", "airbnb"]);

export function useChannexManager() {
  const [snapshot, setSnapshot] = useState<ChannexSnapshot | null>(null);
  const [operation, setOperation] = useState<ChannexOperation | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [markupDrafts, setMarkupDrafts] = useState<Record<string, string>>({});

  const loadSnapshot = useCallback(
    async (options?: { preserveOperation?: ChannexOperation; background?: boolean }) => {
      if (!options?.background) {
        setLoading(true);
        setLoadError("");
      }
      try {
        const next = await channexService.getSnapshot();
        setSnapshot(next);
        setOperation(options?.preserveOperation ?? next.activeOperation);
        setMarkupDrafts(
          Object.fromEntries(
            next.markups.map(({ channel, markupPercent }) => [channel, String(markupPercent)]),
          ),
        );
      } catch {
        if (options?.background) {
          setActionError(
            "We couldn’t refresh the channel manager. Check your connection and retry.",
          );
        } else {
          setLoadError(
            "We couldn’t load the channel manager. Check your connection and try again.",
          );
        }
      } finally {
        if (!options?.background) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    if (!operation || terminalChannexStatuses.has(operation.status)) return;
    let cancelled = false;
    let delayMs = 1500;
    let timer: number;
    const poll = async () => {
      try {
        const next = await channexService.getOperation(operation.operationId);
        if (cancelled) return;
        setOperation(next);
        setActionError("");
        if (terminalChannexStatuses.has(next.status)) {
          void loadSnapshot({ preserveOperation: next, background: true });
        }
      } catch {
        if (cancelled) return;
        setActionError("Operation progress couldn’t be refreshed. Retrying automatically.");
        delayMs = Math.min(delayMs * 2, 15_000);
        timer = window.setTimeout(poll, delayMs);
      }
    };
    timer = window.setTimeout(poll, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadSnapshot, operation]);

  const channels = useMemo(() => {
    if (!snapshot) return [];
    return Array.from(
      new Set([
        ...snapshot.channels.map((channel) => channel.key),
        ...snapshot.markups.map((markup) => markup.channel),
      ]),
    )
      .filter((channel) => markupChannels.has(channel))
      .sort();
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    setMarkupDrafts((current) =>
      Object.fromEntries(
        channels.map((channel) => [
          channel,
          current[channel] ??
            String(
              snapshot.markups.find((markup) => markup.channel === channel)?.markupPercent ?? 0,
            ),
        ]),
      ),
    );
  }, [channels, snapshot]);

  const runCommand = async (name: string, command: () => Promise<ChannexOperation>) => {
    setPendingAction(name);
    setActionError("");
    try {
      setOperation(await command());
    } catch {
      setActionError(`The ${name} request couldn’t be accepted. Nothing was changed.`);
    } finally {
      setPendingAction("");
    }
  };

  const openConsole = async () => {
    setPendingAction("channel settings");
    setActionError("");
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      setActionError("Allow pop-ups to open channel settings.");
      setPendingAction("");
      return;
    }
    popup.opener = null;
    try {
      const session = await channexService.getIframeUrl();
      popup.location.replace(session.iframe_url);
    } catch {
      popup.close();
      setActionError("A secure channel settings session couldn’t be opened. Try again.");
    } finally {
      setPendingAction("");
    }
  };

  const saveMarkups = async () => {
    const markups = channels.map((channel) => {
      const draft = markupDrafts[channel] ?? "";
      return { channel, draft, markupPct: Number(draft) };
    });
    if (
      markups.some(
        ({ draft, markupPct }) =>
          !draft.trim() || !Number.isFinite(markupPct) || markupPct < -50 || markupPct > 200,
      )
    ) {
      setActionError("Each markup must be a number between -50% and 200%.");
      return;
    }
    await runCommand("markup update", () =>
      channexService.updateMarkups(
        markups.map(({ channel, markupPct }) => ({ channel, markupPct })),
      ),
    );
  };

  return {
    snapshot,
    operation,
    loading,
    loadError,
    actionError,
    pendingAction,
    markupDrafts,
    channels,
    setMarkupDrafts,
    loadSnapshot,
    runCommand,
    openConsole,
    saveMarkups,
  };
}

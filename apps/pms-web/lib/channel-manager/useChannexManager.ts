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

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const next = await channexService.getSnapshot();
      setSnapshot(next);
      setOperation(next.activeOperation);
      setMarkupDrafts(
        Object.fromEntries(
          next.markups.map(({ channel, markupPercent }) => [channel, String(markupPercent)]),
        ),
      );
    } catch {
      setLoadError("We couldn’t load the channel manager. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    if (!operation || terminalChannexStatuses.has(operation.status)) return;
    const timer = window.setTimeout(() => {
      void channexService
        .getOperation(operation.operationId)
        .then((next) => {
          setOperation(next);
          if (terminalChannexStatuses.has(next.status)) void loadSnapshot();
        })
        .catch(() =>
          setActionError("Operation progress couldn’t be refreshed. Reload to check its status."),
        );
    }, 1500);
    return () => window.clearTimeout(timer);
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
    try {
      const session = await channexService.getIframeUrl();
      window.open(session.iframe_url, "_blank", "noopener,noreferrer");
    } catch {
      setActionError("A secure channel settings session couldn’t be opened. Try again.");
    } finally {
      setPendingAction("");
    }
  };

  const saveMarkups = async () => {
    const markups = channels.map((channel) => ({
      channel,
      markupPct: Number(markupDrafts[channel]),
    }));
    if (
      markups.some(
        ({ markupPct }) => !Number.isFinite(markupPct) || markupPct < -50 || markupPct > 200,
      )
    ) {
      setActionError("Each markup must be a number between -50% and 200%.");
      return;
    }
    await runCommand("markup update", () => channexService.updateMarkups(markups));
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { FeatureActivationClient, ModuleActivationsResponse } from "./types";

const EVENT_NAME = "vayada-feature-modules-changed";
const FALLBACK_STORAGE_KEY = "vayada-feature-modules";

type ModuleSynchronizationDetail = {
  activeModuleIds: string[];
  hotelId?: string;
  source: "read" | "write";
  canManage?: boolean;
  supportedModuleIds?: string[];
};

function selectedHotelId(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem("selectedHotelId") || "";
}

function storageKey(hotelId?: string): string {
  return `${FALLBACK_STORAGE_KEY}:${hotelId || selectedHotelId() || "default"}`;
}

function readCached(hotelId?: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(hotelId)) || "[]");
    return Array.isArray(parsed) && parsed.every((id): id is string => typeof id === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function publish(detail: ModuleSynchronizationDetail) {
  if (typeof window === "undefined") return;
  const scopedDetail = {
    ...detail,
    hotelId: detail.hotelId || selectedHotelId() || "default",
  };
  try {
    window.localStorage.setItem(storageKey(detail.hotelId), JSON.stringify(detail.activeModuleIds));
    window.localStorage.setItem(EVENT_NAME, JSON.stringify(scopedDetail));
  } catch {
    // The optional cross-tab cache must not interrupt saving or same-window synchronization.
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: scopedDetail }));
}

export function useFeatureModuleActivations(client: FeatureActivationClient) {
  const [activeModuleIds, setActiveModuleIds] = useState<string[]>(() => readCached());
  const [supportedModuleIds, setSupportedModuleIds] = useState<string[]>([]);
  const [hotelId, setHotelId] = useState<string>("");
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const clientRef = useRef(client);
  const mounted = useRef(true);
  const synchronizationRevision = useRef(0);

  // Keep refresh stable while still using the latest client implementation.
  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applyResponse = useCallback((response: ModuleActivationsResponse) => {
    const next = response.activeModules || [];
    const supported = response.supportedModules || [];
    setHotelId(response.hotelId);
    setCanManage(response.canManage);
    setSupportedModuleIds(supported);
    setActiveModuleIds(next);
    publish({
      activeModuleIds: next,
      hotelId: response.hotelId,
      source: "read",
      canManage: response.canManage,
      supportedModuleIds: supported,
    });
  }, []);

  const refresh = useCallback(async () => {
    const revision = synchronizationRevision.current;
    setLoading(true);
    setError("");
    try {
      const response = await clientRef.current.list();
      if (!mounted.current) return;
      if (revision !== synchronizationRevision.current) return;
      applyResponse(response);
    } catch (err) {
      if (!mounted.current) return;
      if (revision !== synchronizationRevision.current) return;
      setError(err instanceof Error ? err.message : "Could not load feature modules.");
      const cached = readCached();
      if (cached.length > 0) setActiveModuleIds(cached);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [applyResponse]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const applyDetail = (
      detail: Partial<ModuleSynchronizationDetail> | null | undefined,
      acceptUnbound: boolean,
    ) => {
      const activeModuleIds = detail?.activeModuleIds;
      if (!Array.isArray(activeModuleIds)) return;
      if (!activeModuleIds.every((id): id is string => typeof id === "string")) return;
      const detailHotelId = detail?.hotelId;
      if (detailHotelId && !hotelId && !acceptUnbound) return;
      if (detailHotelId && hotelId && detailHotelId !== hotelId) return;
      if (detail?.source !== "read") synchronizationRevision.current += 1;
      if (detailHotelId && detailHotelId !== "default" && !hotelId) setHotelId(detailHotelId);
      if (typeof detail?.canManage === "boolean") setCanManage(detail.canManage);
      const supported = detail?.supportedModuleIds;
      if (Array.isArray(supported) && supported.every((id) => typeof id === "string")) {
        setSupportedModuleIds(supported);
      }
      setActiveModuleIds(activeModuleIds);
      if (detail?.source === "read") setLoading(false);
    };

    const onChange = (event: Event) => {
      applyDetail((event as CustomEvent).detail, true);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== EVENT_NAME || !event.newValue) return;
      try {
        applyDetail(JSON.parse(event.newValue), false);
      } catch {
        // Ignore malformed cross-tab notifications.
      }
    };

    window.addEventListener(EVENT_NAME, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [hotelId]);

  const setModuleActive = useCallback(
    async (moduleId: string, isActive: boolean) => {
      const previous = activeModuleIds;
      const next = isActive
        ? Array.from(new Set([...activeModuleIds, moduleId]))
        : activeModuleIds.filter((id) => id !== moduleId);
      setActiveModuleIds(next);
      publish({ activeModuleIds: next, hotelId, source: "write", canManage, supportedModuleIds });
      try {
        await clientRef.current.update(moduleId, isActive);
        publish({ activeModuleIds: next, hotelId, source: "write", canManage, supportedModuleIds });
      } catch (err) {
        setActiveModuleIds(previous);
        publish({
          activeModuleIds: previous,
          hotelId,
          source: "write",
          canManage,
          supportedModuleIds,
        });
        throw err;
      }
    },
    [activeModuleIds, canManage, hotelId, supportedModuleIds],
  );

  const activeModuleSet = useMemo(() => new Set(activeModuleIds), [activeModuleIds]);

  return {
    activeModuleIds,
    activeModuleSet,
    supportedModuleIds,
    hotelId,
    canManage,
    loading,
    error,
    refresh,
    setModuleActive,
  };
}

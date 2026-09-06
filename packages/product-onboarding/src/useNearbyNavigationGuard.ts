"use client";
import { useEffect } from "react";
const message = "You have unsaved location or place changes. Discard them and leave?";
export function useNearbyNavigationGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    let acceptedNavigation = false;
    const unload = (event: BeforeUnloadEvent) => {
      if (acceptedNavigation) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    const navigate = (event: Event) => {
      const change = event as Event & {
        canIntercept: boolean;
        hashChange: boolean;
        navigationType: string;
      };
      if (change.canIntercept && !change.hashChange && change.navigationType !== "reload") {
        if (!window.confirm(message)) event.preventDefault();
        else acceptedNavigation = true;
      }
    };
    const click = (event: MouseEvent) => {
      const link = (event.target as Element)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (
        navigation ||
        !link ||
        link.target === "_blank" ||
        event.metaKey ||
        event.ctrlKey ||
        link.href === window.location.href
      )
        return;
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else acceptedNavigation = true;
    };
    window.addEventListener("beforeunload", unload);
    navigation?.addEventListener("navigate", navigate);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      navigation?.removeEventListener("navigate", navigate);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);
}

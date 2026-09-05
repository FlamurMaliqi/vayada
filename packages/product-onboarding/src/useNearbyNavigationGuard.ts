"use client";
import { useEffect } from "react";
type GuardWindow = Window & { navigation?: EventTarget; __vayadaNearbyLeave?: () => boolean };
const message = "You have unsaved location or place changes. Discard them and leave?";
export function useNearbyNavigationGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const target = window as GuardWindow;
    let accepted = false;
    const leave = () => accepted || (accepted = window.confirm(message));
    target.__vayadaNearbyLeave = leave;
    const unload = (event: BeforeUnloadEvent) => {
      if (accepted) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const navigate = (event: Event) => {
      const change = event as Event & {
        canIntercept: boolean;
        hashChange: boolean;
        navigationType: string;
      };
      if (
        change.canIntercept &&
        !change.hashChange &&
        change.navigationType !== "reload" &&
        !leave()
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    target.navigation?.addEventListener("navigate", navigate);
    return () => {
      if (target.__vayadaNearbyLeave === leave) delete target.__vayadaNearbyLeave;
      window.removeEventListener("beforeunload", unload);
      target.navigation?.removeEventListener("navigate", navigate);
    };
  }, [dirty]);
}

type Router = {
  push(href: string, options?: { scroll?: boolean }): void;
  replace(href: string, options?: { scroll?: boolean }): void;
  back(): void;
  forward(): void;
  refresh(): void;
};
/** Install at the app shell so every same-document history entry has an index. */
export function useNearbyHistoryGuard(router: Router) {
  useEffect(() => {
    const target = window as GuardWindow;
    if (target.navigation) return;
    const key = "__vayadaNearbyIndex";
    const push = history.pushState.bind(history),
      replace = history.replaceState.bind(history);
    let position = Number(history.state?.[key] ?? 0);
    let restoring = false;
    replace({ ...history.state, [key]: position }, "");
    history.pushState = (state, title, url) => {
      position += 1;
      push({ ...state, [key]: position }, title, url);
    };
    history.replaceState = (state, title, url) =>
      replace({ ...state, [key]: position }, title, url);
    const pop = (event: PopStateEvent) => {
      const next = Number(event.state?.[key] ?? position - 1);
      if (restoring) {
        restoring = false;
        position = next;
        event.stopImmediatePropagation();
        return;
      }
      if (target.__vayadaNearbyLeave && !target.__vayadaNearbyLeave()) {
        event.stopImmediatePropagation();
        restoring = true;
        history.go(position - next);
        return;
      }
      position = next;
    };
    window.addEventListener("popstate", pop, true);
    const original = {
      push: router.push,
      replace: router.replace,
      back: router.back,
      forward: router.forward,
      refresh: router.refresh,
    };
    const allowed = () => !target.__vayadaNearbyLeave || target.__vayadaNearbyLeave();
    router.push = (href, options) => {
      if (allowed()) original.push(href, options);
    };
    router.replace = (href, options) => {
      if (allowed()) original.replace(href, options);
    };
    router.back = () => {
      if (allowed()) original.back();
    };
    router.forward = () => {
      if (allowed()) original.forward();
    };
    router.refresh = () => {
      if (allowed()) original.refresh();
    };
    return () => {
      history.pushState = push;
      history.replaceState = replace;
      window.removeEventListener("popstate", pop, true);
      Object.assign(router, original);
    };
  }, [router]);
}

"use client";
import { useEffect } from "react";
type GuardWindow = Window & {
  navigation?: EventTarget;
  __vayadaNearbyLeave?: () => boolean;
  __vayadaNearbyNavigationDone?: () => void;
};
const message = "You have unsaved location or place changes. Discard them and leave?";
export function useNearbyNavigationGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const target = window as GuardWindow;
    let accepted = false;
    const leave = () => accepted || (accepted = window.confirm(message));
    target.__vayadaNearbyLeave = leave;
    const reset = () => {
      accepted = false;
    };
    target.__vayadaNearbyNavigationDone = reset;
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
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (
        !(link instanceof HTMLAnchorElement) ||
        link.download ||
        (link.target && link.target !== "_self")
      )
        return;
      const destination = new URL(link.href);
      const current = new URL(window.location.href);
      if (
        destination.href === current.href ||
        (destination.origin === current.origin &&
          destination.pathname === current.pathname &&
          destination.search === current.search &&
          destination.hash)
      )
        return;
      if (!leave()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    if (!target.navigation) window.addEventListener("click", click, true);
    window.addEventListener("beforeunload", unload);
    target.navigation?.addEventListener("navigate", navigate);
    target.navigation?.addEventListener("navigatesuccess", reset);
    target.navigation?.addEventListener("navigateerror", reset);
    return () => {
      if (target.__vayadaNearbyLeave === leave) delete target.__vayadaNearbyLeave;
      if (target.__vayadaNearbyNavigationDone === reset) delete target.__vayadaNearbyNavigationDone;
      target.navigation?.removeEventListener("navigatesuccess", reset);
      target.navigation?.removeEventListener("navigateerror", reset);
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("click", click, true);
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
      target.__vayadaNearbyNavigationDone?.();
    };
    history.replaceState = (state, title, url) => {
      replace({ ...state, [key]: position }, title, url);
      target.__vayadaNearbyNavigationDone?.();
    };
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
      target.__vayadaNearbyNavigationDone?.();
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
      if (new URL(href, window.location.href).href === window.location.href || allowed())
        original.push(href, options);
    };
    router.replace = (href, options) => {
      if (new URL(href, window.location.href).href === window.location.href || allowed())
        original.replace(href, options);
    };
    router.back = () => {
      if (allowed()) original.back();
    };
    router.forward = () => {
      if (allowed()) original.forward();
    };
    router.refresh = () => {
      if (allowed()) original.refresh();
      target.__vayadaNearbyNavigationDone?.();
    };
    return () => {
      history.pushState = push;
      history.replaceState = replace;
      window.removeEventListener("popstate", pop, true);
      Object.assign(router, original);
    };
  }, [router]);
}

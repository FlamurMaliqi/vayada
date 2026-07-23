"use client";

import { useEffect, useRef, type RefObject } from "react";

interface UseModalAccessibilityOptions {
  isOpen: boolean;
  onClose: () => void;
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  isInert?: boolean;
}

interface ModalStackEntry {
  token: symbol;
  dialog: HTMLElement;
  lastFocusedElement: HTMLElement | null;
  restoreFocusElement: HTMLElement | null;
}

const modalStack: ModalStackEntry[] = [];
let bodyOverflowBeforeModalStack: string | null = null;

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function isTopModal(token: symbol) {
  return modalStack[modalStack.length - 1]?.token === token;
}

function getFocusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => !element.closest('[aria-hidden="true"]'),
  );
}

export function useModalAccessibility({
  isOpen,
  onClose,
  dialogRef,
  initialFocusRef,
  isInert = false,
}: UseModalAccessibilityOptions) {
  const tokenRef = useRef(Symbol("modal"));
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    dialogRef.current?.toggleAttribute("inert", isOpen && isInert);
  }, [dialogRef, isInert, isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const token = tokenRef.current;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const underlyingModal = modalStack[modalStack.length - 1];
    const restoreFocusElement = underlyingModal
      ? activeElement && underlyingModal.dialog.contains(activeElement)
        ? activeElement
        : underlyingModal.lastFocusedElement
      : activeElement === document.body || activeElement === document.documentElement
        ? null
        : activeElement;

    if (modalStack.length === 0) {
      bodyOverflowBeforeModalStack = document.body.style.overflow;
    }
    const entry: ModalStackEntry = {
      token,
      dialog,
      lastFocusedElement: null,
      restoreFocusElement,
    };
    modalStack.push(entry);
    document.body.style.overflow = "hidden";

    const initialFocus = initialFocusRef?.current ?? getFocusableElements(dialog)[0] ?? dialog;
    entry.lastFocusedElement = initialFocus;
    initialFocus?.focus();

    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && dialog.contains(event.target)) {
        entry.lastFocusedElement = event.target;
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopModal(token)) return;

      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const currentDialog = dialogRef.current;
      if (!currentDialog) return;

      const focusableElements = getFocusableElements(currentDialog);
      if (focusableElements.length === 0) {
        event.preventDefault();
        currentDialog.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (
        event.shiftKey &&
        (activeElement === firstElement || !currentDialog.contains(activeElement))
      ) {
        event.preventDefault();
        lastElement.focus();
      } else if (
        !event.shiftKey &&
        (activeElement === lastElement || !currentDialog.contains(activeElement))
      ) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);

      const wasTopModal = isTopModal(token);
      const stackIndex = modalStack.findIndex((modal) => modal.token === token);
      if (!wasTopModal && stackIndex >= 0) {
        for (const coveringModal of modalStack.slice(stackIndex + 1)) {
          if (
            !coveringModal.restoreFocusElement ||
            dialog.contains(coveringModal.restoreFocusElement)
          ) {
            coveringModal.restoreFocusElement = entry.restoreFocusElement;
          }
        }
      }
      if (stackIndex >= 0) modalStack.splice(stackIndex, 1);

      if (modalStack.length === 0) {
        document.body.style.overflow = bodyOverflowBeforeModalStack ?? "";
        bodyOverflowBeforeModalStack = null;
      }

      if (wasTopModal) {
        modalStack[modalStack.length - 1]?.dialog.removeAttribute("inert");
        const focusTarget = entry.restoreFocusElement?.isConnected
          ? entry.restoreFocusElement
          : modalStack[modalStack.length - 1]?.lastFocusedElement;
        if (focusTarget?.isConnected) focusTarget.focus();
      }
    };
  }, [dialogRef, initialFocusRef, isOpen]);
}

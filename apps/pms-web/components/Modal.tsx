"use client";

import { ReactNode, useEffect, useRef, type KeyboardEvent } from "react";

interface ModalProps {
  onClose: () => void;
  maxWidth?: "md" | "lg" | "xl";
  children: ReactNode;
  /**
   * Optional non-scrolling action area pinned to the bottom of the modal.
   * When provided, the body scrolls and this footer stays reachable on every
   * viewport (the New Booking modal relies on this — VAY-411). When the
   * footer is present the panel also goes full-screen on narrow viewports so
   * the action buttons sit within comfortable thumb reach.
   */
  footer?: ReactNode;
  ariaLabel?: string;
}

// prettier-ignore
function trapFocus(event: KeyboardEvent<HTMLDivElement>, panel: HTMLDivElement | null, close: () => void) { if (event.key === "Escape") return close(); if (event.key !== "Tab") return; const nodes = Array.from(panel?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []); if (!nodes.length) return event.preventDefault(); const first = nodes[0]!, last = nodes.at(-1)!; if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }

// prettier-ignore
export default function Modal({ onClose, maxWidth = "md", children, footer, ariaLabel }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const maxWidthClass =
    maxWidth === "xl" ? "max-w-2xl" : maxWidth === "lg" ? "max-w-lg" : "max-w-md";

  // With a footer: full-screen on mobile (dvh so the browser chrome can't
  // clip it), capped + rounded from `sm` up. Without: keep the centered
  // capped panel, but use dvh instead of vh so the bottom is never clipped
  // behind mobile browser UI.
  const panelSizing = footer
    ? `h-[100dvh] w-full rounded-none sm:h-auto sm:max-h-[90dvh] sm:w-full sm:rounded-xl sm:mx-4 ${maxWidthClass}`
    : `w-full mx-4 rounded-xl max-h-[90dvh] ${maxWidthClass}`;

  // prettier-ignore
  useEffect(() => { if (!ariaLabel || typeof document === "undefined") return; const previous = document.activeElement as HTMLElement | null; panelRef.current?.focus(); return () => previous?.focus(); }, [ariaLabel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      {/* prettier-ignore */}
      <div ref={panelRef} role={ariaLabel ? "dialog" : undefined} aria-modal={ariaLabel ? "true" : undefined} aria-label={ariaLabel} tabIndex={-1} onKeyDown={(event) => trapFocus(event, panelRef.current, onClose)} className={`relative bg-white shadow-xl flex flex-col ${panelSizing}`}>
        <div className="flex-1 min-h-0 overflow-y-auto p-6">{children}</div>
        {footer && <div className="shrink-0 border-t border-gray-100 p-4 sm:px-6">{footer}</div>}
      </div>
    </div>
  );
}

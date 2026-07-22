"use client";

import { ReactNode, useRef } from "react";
import { useModalAccessibility } from "./useModalAccessibility";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Modal max-width size */
  size?: "sm" | "md" | "lg" | "xl" | "2xl" | "full";
  /** Whether clicking the backdrop closes the modal */
  closeOnBackdropClick?: boolean;
  /** Whether to show the backdrop blur effect */
  blur?: boolean;
  /** Backdrop opacity - 50 = bg-black/50, 60 = bg-black/60, 70 = bg-black/70 */
  backdropOpacity?: 50 | 60 | 70;
  /** Additional classes for the modal container */
  className?: string;
  /** Z-index level */
  zIndex?: 50 | 60;
  /** ID of the element that labels the dialog */
  ariaLabelledBy?: string;
  /** Accessible label when there is no visible title */
  ariaLabel?: string;
}

const sizeClasses = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  full: "max-w-4xl",
};

const backdropClasses = {
  50: "bg-black/50",
  60: "bg-black/60",
  70: "bg-black/70",
};

const zIndexClasses = {
  50: "z-50",
  60: "z-[60]",
};

export function Modal({
  isOpen,
  onClose,
  children,
  size = "md",
  closeOnBackdropClick = true,
  blur = true,
  backdropOpacity = 50,
  className = "",
  zIndex = 50,
  ariaLabelledBy,
  ariaLabel,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalAccessibility({ isOpen, onClose, dialogRef });

  if (!isOpen) return null;

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.target === event.currentTarget && closeOnBackdropClick) {
      onClose();
    }
  };

  return (
    <div
      className={`fixed inset-0 ${zIndexClasses[zIndex]} flex items-center justify-center p-4 ${backdropClasses[backdropOpacity]} ${blur ? "backdrop-blur-sm" : ""} overflow-y-auto`}
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`max-h-[95vh] w-full overflow-y-auto rounded-lg bg-white shadow-2xl ${sizeClasses[size]} animate-in fade-in zoom-in-95 duration-200 ${className}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
        aria-label={ariaLabel}
      >
        {children}
      </div>
    </div>
  );
}

export interface ModalHeaderProps {
  children: ReactNode;
  onClose?: () => void;
  className?: string;
}

export function ModalHeader({ children, onClose, className = "" }: ModalHeaderProps) {
  return (
    <div
      className={`sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white px-5 py-3 ${className}`}
    >
      <h3 className="text-base font-semibold text-gray-950">{children}</h3>
      {onClose && (
        <button onClick={onClose} className="rounded-md p-2 transition-colors hover:bg-gray-100">
          <svg
            className="h-5 w-5 text-gray-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

export interface ModalBodyProps {
  children: ReactNode;
  className?: string;
}

export function ModalBody({ children, className = "" }: ModalBodyProps) {
  return <div className={`p-5 ${className}`}>{children}</div>;
}

export interface ModalFooterProps {
  children: ReactNode;
  className?: string;
}

export function ModalFooter({ children, className = "" }: ModalFooterProps) {
  return (
    <div
      className={`sticky bottom-0 flex items-center justify-end gap-2 border-t border-gray-200 bg-white px-5 py-3 ${className}`}
    >
      {children}
    </div>
  );
}

export default Modal;

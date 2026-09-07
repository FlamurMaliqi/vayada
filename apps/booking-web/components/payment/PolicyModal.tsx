"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

export type PolicyKind = "terms" | "cancellation";

interface PolicyModalProps {
  kind: PolicyKind | null;
  onClose: () => void;
  termsText: string;
  cancellationPolicyText: string;
  /** Fallback body for the cancellation modal when the hotel hasn't supplied custom text. */
  cancellationFallback: string;
  cancellationContent?: ReactNode;
}

export default function PolicyModal({
  kind,
  onClose,
  termsText,
  cancellationPolicyText,
  cancellationFallback,
  cancellationContent,
}: PolicyModalProps) {
  const t = useTranslations("payment");
  if (!kind) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-900">
            {kind === "terms" ? t("termsAndConditions") : t("cancellationPolicyTitle")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
          {kind === "terms"
            ? termsText || "Please contact us for the full Terms and Conditions."
            : (cancellationContent ?? (cancellationPolicyText || cancellationFallback))}
        </div>
      </div>
    </div>
  );
}

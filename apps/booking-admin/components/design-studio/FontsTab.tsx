"use client";
import { useTranslation } from "@/lib/i18n";

import { FONT_PAIRINGS } from "@/lib/constants/branding";

interface FontsTabProps {
  selectedFont: string;
  setSelectedFont: (v: string) => void;
}

export default function FontsTab({ selectedFont, setSelectedFont }: FontsTabProps) {
  const { t } = useTranslation();
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h2 className="text-[13px] font-semibold text-gray-900">{t("designStudio.fonts.title")}</h2>
      <p className="text-[12px] text-gray-500 mt-0.5 mb-3">{t("designStudio.fonts.subtitle")}</p>

      <div className="space-y-1.5">
        {FONT_PAIRINGS.map((pairing) => (
          <button
            key={pairing.id}
            onClick={() => setSelectedFont(pairing.id)}
            className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
              selectedFont === pairing.id
                ? "border-primary-500 bg-primary-50/30 ring-1 ring-primary-500"
                : "border-gray-200 hover:border-gray-300"
            }`}
          >
            <div>
              <div className="flex items-center gap-1">
                <span className="text-[12px] font-semibold text-gray-900">{pairing.name}</span>
                {selectedFont === pairing.id && (
                  <svg
                    className="w-3.5 h-3.5 text-primary-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
              <span className="text-[11px] text-gray-500">{pairing.fonts}</span>
            </div>
            <span className="text-sm text-gray-600" style={{ fontFamily: pairing.headingFamily }}>
              {pairing.preview}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

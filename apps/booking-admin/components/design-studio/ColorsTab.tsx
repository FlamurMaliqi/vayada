"use client";
import { useTranslation } from "@/lib/i18n";

import { COLOR_PRESETS } from "@/lib/constants/branding";

interface ColorsTabProps {
  primaryColor: string;
  setPrimaryColor: (v: string) => void;
  applyPreset: (preset: (typeof COLOR_PRESETS)[number]) => void;
}

export default function ColorsTab({ primaryColor, setPrimaryColor, applyPreset }: ColorsTabProps) {
  const { t } = useTranslation();
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h2 className="text-[13px] font-semibold text-gray-900">{t("designStudio.colors.title")}</h2>
      <p className="text-[12px] text-gray-500 mt-0.5 mb-3">{t("designStudio.colors.subtitle")}</p>

      <div className="space-y-4">
        <div>
          <h3 className="text-[12px] font-semibold text-gray-900">
            {t("designStudio.colors.primaryBrandColor")}
          </h3>
          <p className="text-[11px] text-gray-500 mt-0.5 mb-1.5">
            {t("designStudio.colors.primaryDescription")}
          </p>
          <div className="flex items-center gap-2">
            <label
              className="w-8 h-8 rounded-full border border-gray-200 cursor-pointer shrink-0"
              style={{ backgroundColor: primaryColor }}
            >
              <input
                type="color"
                aria-label={t("admin.primaryBrandColorPicker")}
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="opacity-0 w-0 h-0"
              />
            </label>
            <input
              type="text"
              aria-label={t("admin.primaryBrandColor")}
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="w-20 px-2 py-1 border border-gray-300 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>

        <div>
          <h3 className="text-[12px] font-semibold text-gray-900 mb-1.5">
            {t("designStudio.colors.quickPresets")}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {COLOR_PRESETS.map((preset) => (
              <button
                key={preset.name}
                onClick={() => applyPreset(preset)}
                className="inline-flex items-center gap-1 px-2 py-0.5 border border-gray-200 rounded-full text-[12px] text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: preset.primary }}
                />
                {preset.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

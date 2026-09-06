import { useTranslation } from "@/lib/i18n";
import { ReactNode } from "react";

interface SaveButtonProps {
  onClick: () => void;
  saving: boolean;
  disabled?: boolean;
  children?: ReactNode;
  icon?: ReactNode;
}

export function SaveButton({ onClick, saving, disabled, children, icon }: SaveButtonProps) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      disabled={saving || disabled}
      className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
    >
      {saving ? (
        <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
      ) : icon ? (
        icon
      ) : (
        <svg
          className="w-3.5 h-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"
          />
        </svg>
      )}
      {children ?? t("common.save")}
    </button>
  );
}

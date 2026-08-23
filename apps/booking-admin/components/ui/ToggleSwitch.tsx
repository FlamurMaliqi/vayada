interface ToggleSwitchProps {
  enabled: boolean;
  onChange: () => void;
  label: string;
  description?: string;
  size?: "sm" | "md";
  disabled?: boolean;
}

export function ToggleSwitch({
  enabled,
  onChange,
  label,
  description,
  size = "md",
  disabled = false,
}: ToggleSwitchProps) {
  if (size === "sm") {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        onClick={onChange}
        className={`flex items-center justify-between p-3 rounded-lg border transition-all text-left w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
          enabled ? "border-primary-500 bg-primary-50/30" : "border-gray-200 hover:border-gray-300"
        }`}
      >
        <div>
          <span className="text-[12px] font-medium text-gray-900">{label}</span>
          {description && <p className="text-[11px] text-gray-500 mt-0.5">{description}</p>}
        </div>
        <div
          className={`w-8 h-5 rounded-full transition-colors relative shrink-0 ${enabled ? "bg-primary-500" : "bg-gray-300"}`}
        >
          <div
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? "left-3.5" : "left-0.5"}`}
          />
        </div>
      </button>
    );
  }

  return (
    <div className="flex items-center justify-between py-3">
      <div>
        <p className="text-[13px] font-semibold text-gray-900">{label}</p>
        {description && <p className="text-[13px] text-gray-500">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        disabled={disabled}
        onClick={onChange}
        className={`relative w-10 h-[22px] rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
          enabled ? "bg-primary-500" : "bg-gray-300"
        }`}
      >
        <span
          className={`absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow transition-transform ${
            enabled ? "translate-x-[18px]" : ""
          }`}
        />
      </button>
    </div>
  );
}

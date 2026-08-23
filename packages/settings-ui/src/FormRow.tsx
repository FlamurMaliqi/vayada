import { ReactNode } from "react";
import { cn } from "./cn";

interface FormRowProps {
  label: string;
  htmlFor?: string;
  description?: ReactNode;
  error?: ReactNode;
  layout?: "stacked" | "inline";
  required?: boolean;
  children: ReactNode;
  className?: string;
}

export function FormRow({
  label,
  htmlFor,
  description,
  error,
  layout = "stacked",
  required,
  children,
  className,
}: FormRowProps) {
  if (layout === "inline") {
    return (
      <div className={cn("flex items-start justify-between gap-4 py-2.5", className)}>
        <div className="min-w-0 flex-1">
          <label htmlFor={htmlFor} className="text-[13px] font-medium text-gray-900">
            {label}
            {required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
          {description && <p className="text-[12px] text-gray-500 mt-0.5">{description}</p>}
          {error && <p className="text-[12px] text-red-600 mt-0.5">{error}</p>}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-1", className)}>
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-gray-700">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {description && <p className="text-[12px] text-gray-500">{description}</p>}
      {children}
      {error && <p className="text-[12px] text-red-600">{error}</p>}
    </div>
  );
}

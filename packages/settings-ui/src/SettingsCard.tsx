import { ReactNode } from "react";
import { cn } from "./cn";

interface SettingsCardProps {
  title?: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function SettingsCard({
  title,
  description,
  footer,
  children,
  className,
  contentClassName,
}: SettingsCardProps) {
  const hasHeader = title || description;
  return (
    <div className={cn("bg-white border border-gray-200 rounded-lg overflow-hidden", className)}>
      {hasHeader && (
        <div className="px-4 md:px-5 pt-4 md:pt-5 pb-3 border-b border-gray-100">
          {title && <h3 className="text-[14px] font-semibold text-gray-900">{title}</h3>}
          {description && <p className="text-[13px] text-gray-500 mt-0.5">{description}</p>}
        </div>
      )}
      <div className={cn("px-4 md:px-5 py-4 md:py-5", contentClassName)}>{children}</div>
      {footer && (
        <div className="px-4 md:px-5 py-3 border-t border-gray-100 bg-gray-50/60">{footer}</div>
      )}
    </div>
  );
}

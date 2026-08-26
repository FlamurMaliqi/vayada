import { ReactNode } from "react";
import { cn } from "./cn";

interface SettingsSectionProps {
  id: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SettingsSection({
  id,
  title,
  description,
  actions,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <section id={id} className={cn("scroll-mt-20 first:pt-0 pt-6 pb-2", className)}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="min-w-0">
          <h2 className="text-base md:text-lg font-semibold text-gray-900">{title}</h2>
          {description && <p className="text-[13px] text-gray-500 mt-0.5">{description}</p>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

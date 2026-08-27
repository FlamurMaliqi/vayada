"use client";

import { ReactNode } from "react";
import Link from "next/link";
import { cn } from "./cn";

export interface SettingsNavSection {
  id: string;
  label: string;
  href?: string;
  icon?: React.ComponentType<{ className?: string }>;
}

interface SettingsLayoutProps {
  title?: string;
  description?: string;
  sections: SettingsNavSection[];
  activeId: string;
  onSelect?: (id: string) => void;
  children: ReactNode;
}

export function SettingsLayout({
  title,
  description,
  sections,
  activeId,
  onSelect,
  children,
}: SettingsLayoutProps) {
  return (
    <div className="min-h-full">
      {(title || description) && (
        <div className="px-4 md:px-6 lg:px-8 pt-4 md:pt-6 pb-3">
          {title && <h1 className="text-xl md:text-2xl font-semibold text-gray-900">{title}</h1>}
          {description && <p className="text-[13px] text-gray-500 mt-1">{description}</p>}
        </div>
      )}

      <div className="md:hidden px-4 pb-2 sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-gray-100">
        <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 py-1.5">
          {sections.map((section) => (
            <SettingsNavItem
              key={section.id}
              section={section}
              active={activeId === section.id}
              onSelect={onSelect}
              variant="pill"
            />
          ))}
        </div>
      </div>

      <div className="flex">
        <aside className="hidden md:block w-56 shrink-0 border-r border-gray-100 px-3 py-4 sticky top-0 self-start max-h-screen overflow-y-auto">
          <nav className="space-y-0.5">
            {sections.map((section) => (
              <SettingsNavItem
                key={section.id}
                section={section}
                active={activeId === section.id}
                onSelect={onSelect}
                variant="rail"
              />
            ))}
          </nav>
        </aside>

        <div className="flex-1 min-w-0 px-4 md:px-6 lg:px-8 py-4 md:py-6">
          <div className="max-w-3xl">{children}</div>
        </div>
      </div>
    </div>
  );
}

function SettingsNavItem({
  section,
  active,
  onSelect,
  variant,
}: {
  section: SettingsNavSection;
  active: boolean;
  onSelect?: (id: string) => void;
  variant: "rail" | "pill";
}) {
  const Icon = section.icon;
  const className =
    variant === "rail"
      ? cn(
          "flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] transition-colors w-full text-left",
          active
            ? "bg-gray-100 text-gray-900 font-semibold"
            : "text-gray-600 hover:bg-gray-50 hover:text-gray-900",
        )
      : cn(
          "shrink-0 px-3 py-1.5 rounded-full text-[12px] font-medium whitespace-nowrap transition-colors",
          active ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200",
        );

  const inner = (
    <>
      {Icon && variant === "rail" && (
        <Icon className={cn("w-4 h-4 shrink-0", active ? "text-gray-900" : "text-gray-400")} />
      )}
      <span className={variant === "rail" ? "flex-1" : ""}>{section.label}</span>
    </>
  );

  if (section.href) {
    return (
      <Link href={section.href} className={className}>
        {inner}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect?.(section.id)}
      className={className}
      aria-current={active ? "page" : undefined}
    >
      {inner}
    </button>
  );
}

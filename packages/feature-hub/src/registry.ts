import type { CoreNavItem, FeatureCategory, FeatureModule, FeatureProduct } from "./types";

export const FEATURE_CATEGORIES: Array<"All" | FeatureCategory> = ["All", "Distribution"];

export const FEATURE_MODULES: FeatureModule[] = [];

export const CORE_NAV_ITEMS: Record<FeatureProduct, CoreNavItem[]> = {
  pms: [
    { label: "Dashboard", href: "/dashboard" },
    { label: "Calendar", href: "/calendar" },
    { label: "Reservations", href: "/bookings" },
    { label: "Reviews", href: "/reviews" },
    { label: "Rooms & Rates", href: "/rooms" },
    { label: "Channel Manager", href: "/channel-manager" },
    { label: "Settings", href: "/settings" },
  ],
  booking_engine: [
    { label: "Dashboard", href: "/" },
    { label: "Design Studio", href: "/design-studio" },
    { label: "Booking Flow", href: "/booking-flow" },
    { label: "Promo Codes", href: "/promo-codes" },
    { label: "Settings", href: "/settings" },
  ],
};

export const FEATURE_MODULE_NAV_INDEX: Record<FeatureProduct, number> = {
  pms: 6,
  booking_engine: 3,
};

export function modulesForProduct(product: FeatureProduct): FeatureModule[] {
  return FEATURE_MODULES.filter((module) => module.product === product);
}

export function activeNavModules(product: FeatureProduct, activeModuleIds: string[]) {
  const active = new Set(activeModuleIds);
  return FEATURE_MODULES.filter(
    (module) => module.product === product && module.navItem && active.has(module.id),
  );
}

export function activeModuleCount(product: FeatureProduct, activeModuleIds: string[]): number {
  const active = new Set(activeModuleIds);
  return FEATURE_MODULES.filter((module) => module.product === product && active.has(module.id))
    .length;
}

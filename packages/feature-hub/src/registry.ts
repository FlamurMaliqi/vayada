import { BanknotesIcon, LinkIcon, MegaphoneIcon, UserGroupIcon } from "@heroicons/react/24/outline";

import type { CoreNavItem, FeatureCategory, FeatureModule, FeatureProduct } from "./types";

export const FEATURE_CATEGORIES: Array<"All" | FeatureCategory> = ["All", "Distribution"];

export const FEATURE_MODULES: FeatureModule[] = [
  {
    id: "affiliates",
    name: "Affiliates",
    description: "Let partners earn commission on the bookings they refer to you.",
    category: "Distribution",
    type: "internal",
    product: "booking_engine",
    icon: "users",
    isNew: true,
    navItem: { label: "Affiliates", href: "/affiliates", icon: UserGroupIcon },
    detail: {
      headline: "Open a partner channel without adding manual commission tracking.",
      visualType: "affiliates",
      features: [
        { icon: UserGroupIcon, text: "Invite partners and track their referral activity." },
        { icon: MegaphoneIcon, text: "See clicks, bookings, revenue, and commission earned." },
        { icon: LinkIcon, text: "Issue partner links tied to your booking engine." },
        { icon: BanknotesIcon, text: "Prepare payout-ready commission records." },
      ],
    },
  },
];

export const CORE_NAV_ITEMS: Record<FeatureProduct, CoreNavItem[]> = {
  pms: [
    { label: "Dashboard", href: "/dashboard" },
    { label: "Calendar", href: "/calendar" },
    { label: "Reservations", href: "/bookings" },
    { label: "Rooms & Rates", href: "/rooms" },
    { label: "Channel Manager", href: "/channel-manager" },
    { label: "Settings", href: "/settings" },
  ],
  booking_engine: [
    { label: "Dashboard", href: "/" },
    { label: "Design Studio", href: "/design-studio" },
    { label: "Booking Flow", href: "/booking-flow" },
    { label: "Settings", href: "/settings" },
  ],
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

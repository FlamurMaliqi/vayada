import {
  BoltIcon,
  CalendarDaysIcon,
  ClipboardDocumentCheckIcon,
  GlobeAltIcon,
  ReceiptPercentIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";
import { HotelIcon } from "@vayada/product-onboarding";
import type { SettingsNavSection } from "@vayada/settings-ui";

export function getPmsSettingsSections(indexPage: boolean): SettingsNavSection[] {
  const anchorHref = (id: string) => (indexPage ? undefined : `/settings#${id}`);

  return [
    {
      id: "property-details",
      label: "Property",
      icon: HotelIcon,
      href: anchorHref("property-details"),
    },
    {
      id: "calendar",
      label: "Calendar",
      icon: CalendarDaysIcon,
      href: anchorHref("calendar"),
    },
    {
      id: "booking-engine",
      label: "Booking Engine",
      icon: BoltIcon,
      href: anchorHref("booking-engine"),
    },
    {
      id: "ota-commissions",
      label: "OTA commissions",
      icon: ReceiptPercentIcon,
      href: anchorHref("ota-commissions"),
    },
    {
      id: "checkin-checklist",
      label: "Check-in checklist",
      icon: ClipboardDocumentCheckIcon,
      href: "/settings/checkin-checklist",
    },
    {
      id: "checkout-inspection",
      label: "Check-out inspection",
      icon: ClipboardDocumentCheckIcon,
      href: "/settings/checkout-inspection",
    },
    {
      id: "team",
      label: "Team & Roles",
      icon: UserGroupIcon,
      href: "/settings/team",
    },
    {
      id: "localization",
      label: "Localization",
      icon: GlobeAltIcon,
      href: anchorHref("localization"),
    },
  ];
}

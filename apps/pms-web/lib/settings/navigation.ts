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

export function getPmsSettingsSections(
  indexPage: boolean,
  t: (key: string) => string,
): SettingsNavSection[] {
  const anchorHref = (id: string) => (indexPage ? undefined : `/settings#${id}`);

  return [
    {
      id: "property-details",
      label: t("settings.navigation.property"),
      icon: HotelIcon,
      href: anchorHref("property-details"),
    },
    {
      id: "calendar",
      label: t("settings.navigation.calendar"),
      icon: CalendarDaysIcon,
      href: anchorHref("calendar"),
    },
    {
      id: "booking-engine",
      label: t("settings.navigation.bookingEngine"),
      icon: BoltIcon,
      href: anchorHref("booking-engine"),
    },
    {
      id: "ota-commissions",
      label: t("settings.navigation.otaCommissions"),
      icon: ReceiptPercentIcon,
      href: anchorHref("ota-commissions"),
    },
    {
      id: "checkin-checklist",
      label: t("settings.navigation.checkinChecklist"),
      icon: ClipboardDocumentCheckIcon,
      href: "/settings/checkin-checklist",
    },
    {
      id: "checkout-inspection",
      label: t("settings.navigation.checkoutInspection"),
      icon: ClipboardDocumentCheckIcon,
      href: "/settings/checkout-inspection",
    },
    {
      id: "team",
      label: t("settings.navigation.team"),
      icon: UserGroupIcon,
      href: "/settings/team",
    },
    {
      id: "localization",
      label: t("settings.navigation.localization"),
      icon: GlobeAltIcon,
      href: anchorHref("localization"),
    },
  ];
}

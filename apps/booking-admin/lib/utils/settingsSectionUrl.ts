export const SETTINGS_SECTIONS = ["property", "booking", "billing", "payments"] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

export function readSettingsSection(search: string): SettingsSectionId {
  const searchParams = new URLSearchParams(search);
  const requested = searchParams.get("section");

  if (requested !== null) {
    return SETTINGS_SECTIONS.find((section) => section === requested) ?? "property";
  }

  return searchParams.has("billing") ? "billing" : "property";
}

export function buildSettingsSectionUrl(currentUrl: string, section: SettingsSectionId): string {
  const url = new URL(currentUrl);
  url.searchParams.set("section", section);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Application routes
 *
 * This is the marketing site (vayada.com). The authenticated creator
 * marketplace app lives on its own host (app.vayada.com), so every route
 * that belongs to the app is an absolute URL into APP_BASE_URL. Pure
 * marketing pages (home, product pages, legal) stay relative — they are
 * served by this site.
 */

/**
 * The authenticated app (login, signup, marketplace, dashboards, …) is a
 * separate deployment on its own domain. Configurable per environment;
 * defaults to the production host. In local dev set
 * NEXT_PUBLIC_APP_URL=https://marketplace.localhost (portless) or
 * http://localhost:3000 (plain-port).
 */
export const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://app.vayada.com";

const app = (path: string) => `${APP_BASE_URL}${path}`;

export const ROUTES = {
  // Marketing pages — served by this site (relative)
  HOME: "/",
  ABOUT: "/about",
  CONTACT: "/contact",
  BLOG: "/blog",
  PRICING: "/pricing",
  CREATOR_BENEFITS: "/creator-benefits",
  HOTEL_BENEFITS: "/hotel-benefits",

  // Legal — served by this site (relative)
  PRIVACY: "/privacy",
  TERMS: "/terms",
  IMPRINT: "/imprint",

  // App pages — absolute, on the app domain
  CREATORS: app("/creators"),
  PROPERTIES: app("/properties"),
  MARKETPLACE: app("/marketplace"),
  COLLABORATIONS: app("/collaborations"),
  CALENDAR: app("/calendar"),
  CHAT: app("/chat"),

  // Auth — on the app domain
  LOGIN: app("/login"),
  SIGNUP: app("/signup"),
  FORGOT_PASSWORD: app("/forgot-password"),
  RESET_PASSWORD: app("/reset-password"),
  VERIFY_EMAIL: app("/verify-email"),
  PROFILE: app("/profile"),
  PROFILE_COMPLETE: app("/profile/complete"),

  // Hotel routes — on the app domain
  HOTEL_DASHBOARD: app("/hotel/dashboard"),
  HOTEL_PROFILE: app("/hotel/profile"),
  HOTEL_CREATORS: app("/hotel/creators"),
  HOTEL_COLLABORATIONS: app("/hotel/collaborations"),
  HOTEL_SETTINGS: app("/hotel/settings"),

  // Creator routes — on the app domain
  CREATOR_DASHBOARD: app("/creator/dashboard"),
  CREATOR_PROFILE: app("/creator/profile"),
  CREATOR_HOTELS: app("/creator/hotels"),
  CREATOR_COLLABORATIONS: app("/creator/collaborations"),
  CREATOR_SETTINGS: app("/creator/settings"),

  // Admin routes — on the app domain
  ADMIN_DASHBOARD: app("/admin/dashboard"),
  ADMIN_USERS: app("/admin/users"),
  ADMIN_VERIFICATIONS: app("/admin/verifications"),
  ADMIN_SETTINGS: app("/admin/settings"),

  // Settings routes — on the app domain
  SETTINGS: app("/settings"),
  SETTINGS_PRIVACY: app("/settings/privacy"),
  SETTINGS_DATA_EXPORT: app("/settings/data-export"),
  SETTINGS_DELETE_ACCOUNT: app("/settings/delete-account"),
} as const;

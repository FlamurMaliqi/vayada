import type { ComponentType } from "react";

export type FeatureProduct = "pms" | "booking_engine";

export type FeatureCategory =
  | "Distribution"
  | "Guest Experience"
  | "Operations"
  | "Payments"
  | "PMS Integrations";

export type FeatureModuleType = "internal" | "external";

export interface FeatureNavItem {
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
}

export interface FeatureModule {
  id: string;
  name: string;
  description: string;
  category: FeatureCategory;
  type: FeatureModuleType;
  product: FeatureProduct;
  icon: string;
  isNew?: boolean;
  navItem?: FeatureNavItem;
  settingsNote?: string;
  detail: {
    headline: string;
    features: Array<{ icon: ComponentType<{ className?: string }>; text: string }>;
    visualType: FeatureVisualType;
  };
}

export type FeatureVisualType =
  | "inbox"
  | "financials"
  | "affiliates"
  | "stripe"
  | "paypal"
  | "xendit"
  | "lodgify";

export interface ModuleActivation {
  moduleId: string;
  isActive: boolean;
  activatedAt: string | null;
  deactivatedAt: string | null;
  updatedAt: string;
}

export interface ModuleActivationsResponse {
  hotelId: string;
  canManage: boolean;
  supportedModules: string[];
  activeModules: string[];
  activations: ModuleActivation[];
}

export interface FeatureActivationClient {
  list: () => Promise<ModuleActivationsResponse>;
  update: (moduleId: string, isActive: boolean) => Promise<ModuleActivation>;
}

export interface CoreNavItem {
  label: string;
  href: string;
}

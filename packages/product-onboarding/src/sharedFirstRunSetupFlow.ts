export const SHARED_HOTEL_SETUP_PRODUCTS = ["booking", "pms", "marketplace"] as const;

export type SharedHotelSetupProduct = (typeof SHARED_HOTEL_SETUP_PRODUCTS)[number];
export type SharedHotelSetupEntryProduct = SharedHotelSetupProduct;

export function parseSharedHotelSetupEntryProduct(
  value: string | null | undefined,
): SharedHotelSetupEntryProduct | null {
  return SHARED_HOTEL_SETUP_PRODUCTS.includes(value as SharedHotelSetupEntryProduct)
    ? (value as SharedHotelSetupEntryProduct)
    : null;
}

export function isSafeSharedHotelSetupReturnTo(value: string | null | undefined): value is string {
  return Boolean(value && value.startsWith("/") && !value.startsWith("//"));
}

export function safeSharedHotelSetupReturnTo(
  value: string | null | undefined,
  fallback: string,
): string {
  return isSafeSharedHotelSetupReturnTo(value) ? value : fallback;
}

export type SharedPropertyProfileMissingField =
  | "displayName"
  | "location"
  | "website"
  | "phone"
  | "description"
  | "media";
export type SharedPropertyProfileSource = "canonical" | "legacy_prefill";

export type SharedProductActivation<Product extends SharedHotelSetupProduct> = {
  product: Product;
  status: "not_selected" | "selected_incomplete" | "active" | "suspended" | "unavailable";
  missingSteps: string[];
  statusReasons: string[];
  updatedAt: string | null;
};

export const MARKETPLACE_PROFILE_TOOL_STEPS = [
  "creatorPitch",
  "collaborationOffer",
  "creatorRequirements",
  "marketplaceListing",
] as const;

const MARKETPLACE_PROFILE_TOOL_STEP_SET = new Set<string>(MARKETPLACE_PROFILE_TOOL_STEPS);

export function canOpenMarketplaceProfileTools(input: {
  product: SharedHotelSetupProduct | null;
  productStatus: SharedProductActivation<SharedHotelSetupProduct>["status"] | null;
  missingSteps: readonly string[];
}): boolean {
  return (
    input.product === "marketplace" &&
    input.productStatus === "selected_incomplete" &&
    input.missingSteps.length > 0 &&
    input.missingSteps.every((step) => MARKETPLACE_PROFILE_TOOL_STEP_SET.has(step))
  );
}

export type SharedSetupProperty = {
  propertyId: string;
  publicId: string;
  displayName: string | null;
  locationSummary: string | null;
  sharedProfile: {
    status: "incomplete" | "complete" | "disabled" | "private";
    source: SharedPropertyProfileSource;
    completionPercent: number;
    missingFields: SharedPropertyProfileMissingField[];
  };
  products: {
    booking: SharedProductActivation<"booking">;
    pms: SharedProductActivation<"pms">;
    marketplace: SharedProductActivation<"marketplace">;
  };
};

export type SharedHotelSetupNextAction =
  | { action: "create_property"; reasonCodes: string[] }
  | { action: "select_property"; reasonCodes: string[] }
  | {
      action: "complete_shared_profile";
      propertyId: string;
      missingFields: SharedPropertyProfileMissingField[];
      reasonCodes: string[];
    }
  | { action: "select_products"; propertyId: string; reasonCodes: string[] }
  | {
      action: "complete_product_activation";
      propertyId: string;
      product: SharedHotelSetupProduct;
      missingSteps: string[];
      reasonCodes: string[];
    }
  | {
      action: "enter_product";
      propertyId: string;
      product: SharedHotelSetupProduct;
      returnTo: string | null;
      reasonCodes: string[];
    };

export type SharedHotelSetupStatus = {
  contractVersion: "shared-hotel-setup-status.v1";
  entry: {
    entryProduct: SharedHotelSetupEntryProduct | null;
    returnTo: string | null;
  };
  hotelGroup: {
    organizationId: string;
    displayName: string;
  };
  selection: {
    state: "no_property" | "single_property" | "multiple_properties";
    selectedPropertyId: string | null;
  };
  properties: SharedSetupProperty[];
  nextAction: SharedHotelSetupNextAction;
  updatedAt: string;
};

export type SharedPropertyProfileLocation = {
  countryCode: string | null;
  region: string | null;
  city: string | null;
  streetAddress: string | null;
  postalCode: string | null;
  rawMarketplaceLocation: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  addressPublic: boolean;
  mapDisplayMode: "hidden" | "approximate" | "exact";
};

export type SharedPropertyProfileMedia = {
  mediaType: "hero_image" | "gallery_image" | "logo";
  url: string;
  altText: string | null;
  sortOrder: number;
};

export type SharedPropertyProfileInput = {
  displayName: string;
  location: SharedPropertyProfileLocation;
  website: string | null;
  phone: string | null;
  shortDescription: string | null;
  longDescription: string | null;
  media: SharedPropertyProfileMedia[];
};

export type SharedPropertyProfile = SharedPropertyProfileInput & {
  propertyId: string;
  publicId: string;
  sharedProfile: SharedSetupProperty["sharedProfile"];
  updatedAt: string;
};

export type SharedHotelSetupProductSelection = {
  propertyId: string;
  selectedProducts: SharedHotelSetupProduct[];
  updatedAt: string;
};

export type SharedHotelSetupProductStatus =
  SharedSetupProperty["products"][SharedHotelSetupProduct]["status"];

export type SharedFirstRunSetupScreen =
  | "loading"
  | "property_profile"
  | "property_selection"
  | "product_selection"
  | "product_activation"
  | "enter_product";

export type SharedFirstRunSetupViewModel = {
  screen: SharedFirstRunSetupScreen;
  profileMode: "create" | "update" | null;
  selectedPropertyId: string | null;
  selectedProperty: SharedSetupProperty | null;
  product: SharedHotelSetupProduct | null;
  title: string;
};

export function resolveSharedFirstRunSetupView(
  status: SharedHotelSetupStatus | null,
  options: { forceCreateProperty?: boolean } = {},
): SharedFirstRunSetupViewModel {
  if (!status) {
    return {
      screen: "loading",
      profileMode: null,
      selectedPropertyId: null,
      selectedProperty: null,
      product: null,
      title: "Loading setup",
    };
  }

  if (options.forceCreateProperty || status.nextAction.action === "create_property") {
    return {
      screen: "property_profile",
      profileMode: "create",
      selectedPropertyId: null,
      selectedProperty: null,
      product: null,
      title: "Add property",
    };
  }

  if (status.nextAction.action === "select_property") {
    return {
      screen: "property_selection",
      profileMode: null,
      selectedPropertyId: null,
      selectedProperty: null,
      product: null,
      title: "Choose property",
    };
  }

  if (status.nextAction.action === "complete_shared_profile") {
    const selectedProperty = findProperty(status, status.nextAction.propertyId);
    return {
      screen: "property_profile",
      profileMode: "update",
      selectedPropertyId: status.nextAction.propertyId,
      selectedProperty,
      product: null,
      title: selectedProperty?.displayName ?? "Complete property profile",
    };
  }

  if (status.nextAction.action === "select_products") {
    return propertyActionView(status, status.nextAction.propertyId, {
      screen: "product_selection",
      product: null,
      title: "Choose products",
    });
  }

  if (status.nextAction.action === "complete_product_activation") {
    const selectedProperty = findProperty(status, status.nextAction.propertyId);
    return propertyActionView(status, status.nextAction.propertyId, {
      screen: "product_activation",
      product: status.nextAction.product,
      title:
        status.nextAction.product === "marketplace"
          ? `Set up Marketplace for ${selectedProperty?.displayName ?? "selected property"}`
          : "Continue setup",
    });
  }

  return propertyActionView(status, status.nextAction.propertyId, {
    screen: "enter_product",
    product: status.nextAction.product,
    title: "Setup complete",
  });
}

export function selectedProductsForProperty(
  property: SharedSetupProperty | null,
  entryProduct: SharedHotelSetupEntryProduct | null,
): SharedHotelSetupProduct[] {
  const selected = SHARED_HOTEL_SETUP_PRODUCTS.filter((product) =>
    isSelectedSharedHotelSetupProductStatus(property?.products[product].status),
  );
  if (
    entryProduct &&
    !selected.includes(entryProduct) &&
    isSharedHotelSetupProductSelectable(property, entryProduct)
  ) {
    selected.unshift(entryProduct);
  }
  return selected;
}

export function isSharedHotelSetupProductSelectable(
  property: SharedSetupProperty | null,
  product: SharedHotelSetupProduct,
): boolean {
  const status = property?.products[product].status;
  return status !== "suspended" && status !== "unavailable";
}

function isSelectedSharedHotelSetupProductStatus(
  status: SharedHotelSetupProductStatus | undefined,
): boolean {
  return status === "active" || status === "selected_incomplete";
}

function propertyActionView(
  status: SharedHotelSetupStatus,
  propertyId: string,
  view: Pick<SharedFirstRunSetupViewModel, "screen" | "product" | "title">,
): SharedFirstRunSetupViewModel {
  const selectedProperty = findProperty(status, propertyId);
  return {
    ...view,
    profileMode: null,
    selectedPropertyId: propertyId,
    selectedProperty,
  };
}

function findProperty(
  status: SharedHotelSetupStatus,
  propertyId: string,
): SharedSetupProperty | null {
  return status.properties.find((property) => property.propertyId === propertyId) ?? null;
}

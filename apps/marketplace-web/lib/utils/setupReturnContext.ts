import {
  isSafeSharedHotelSetupReturnTo,
  parseSharedHotelSetupEntryProduct,
  type SharedHotelSetupEntryProduct,
} from "@vayada/product-onboarding";

const SETUP_RETURN_CONTEXT_KEY = "vayada.hotelSetup.returnContext";

export type SetupReturnContext = {
  propertyId: string;
  entryProduct: SharedHotelSetupEntryProduct;
  returnProduct: SharedHotelSetupEntryProduct;
  returnTo: string;
};

type SetupReturnStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function saveSetupReturnContext(
  context: SetupReturnContext,
  storage: SetupReturnStorage | null = browserSessionStorage(),
): void {
  const propertyId = context.propertyId.trim();
  if (!storage || !propertyId || !isSafeSharedHotelSetupReturnTo(context.returnTo)) return;

  try {
    storage.setItem(SETUP_RETURN_CONTEXT_KEY, JSON.stringify({ ...context, propertyId }));
  } catch {
    // Setup still works without browser context; Exit falls back to Marketplace.
  }
}

export function readSetupReturnContext(
  propertyId: string,
  storage: SetupReturnStorage | null = browserSessionStorage(),
): SetupReturnContext | null {
  const selectedPropertyId = propertyId.trim();
  if (!storage || !selectedPropertyId) return null;

  try {
    const raw = storage.getItem(SETUP_RETURN_CONTEXT_KEY);
    if (!raw) return null;
    const candidate = JSON.parse(raw) as Partial<Record<keyof SetupReturnContext, unknown>>;
    const entryProduct = parseSharedHotelSetupEntryProduct(
      typeof candidate.entryProduct === "string" ? candidate.entryProduct : null,
    );
    const returnProduct = parseSharedHotelSetupEntryProduct(
      typeof candidate.returnProduct === "string" ? candidate.returnProduct : null,
    );
    const returnTo = typeof candidate.returnTo === "string" ? candidate.returnTo : null;
    if (
      candidate.propertyId !== selectedPropertyId ||
      !entryProduct ||
      !returnProduct ||
      !isSafeSharedHotelSetupReturnTo(returnTo)
    ) {
      return null;
    }
    return {
      propertyId: selectedPropertyId,
      entryProduct,
      returnProduct,
      returnTo,
    };
  } catch {
    return null;
  }
}

export function clearSetupReturnContext(
  storage: SetupReturnStorage | null = browserSessionStorage(),
): void {
  try {
    storage?.removeItem(SETUP_RETURN_CONTEXT_KEY);
  } catch {
    // Ignore unavailable browser storage during navigation.
  }
}

function browserSessionStorage(): SetupReturnStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export type ReturnToParam = string | string[] | null | undefined;

const SAME_ORIGIN_RETURN_TO_BASE = "https://vayada.local";

export function firstSearchParam(value: ReturnToParam): string | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

export function isSafeRelativeReturnTo(value: string | null | undefined): value is string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return false;

  let decoded = value;
  try {
    for (let index = 0; index < 4; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return false;
  }

  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) {
    return false;
  }

  try {
    return new URL(decoded, SAME_ORIGIN_RETURN_TO_BASE).origin === SAME_ORIGIN_RETURN_TO_BASE;
  } catch {
    return false;
  }
}

export function safeRelativeReturnTo(value: ReturnToParam, fallback: string): string {
  const raw = firstSearchParam(value);
  return isSafeRelativeReturnTo(raw) ? raw : fallback;
}

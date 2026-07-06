export type ReturnToParam = string | string[] | null | undefined;

const SAME_ORIGIN_RETURN_TO_BASE = "https://vayada.local";

export function firstSearchParam(value: ReturnToParam): string | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

export function safeRelativeReturnTo(value: ReturnToParam, fallback: string): string {
  const raw = firstSearchParam(value);
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return fallback;
  }
  try {
    return new URL(raw, SAME_ORIGIN_RETURN_TO_BASE).origin === SAME_ORIGIN_RETURN_TO_BASE
      ? raw
      : fallback;
  } catch {
    return fallback;
  }
}

// Never log provider messages, stacks, headers, or raw data: they can contain credentials/PII.
export function workosErrorDiagnostics(error: unknown) {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = value.code ?? value.error;
  return {
    code: typeof code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : undefined,
    status:
      typeof value.status === "number" &&
      Number.isInteger(value.status) &&
      value.status >= 400 &&
      value.status <= 599
        ? value.status
        : undefined,
    requestId:
      typeof value.requestID === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value.requestID)
        ? value.requestID
        : undefined,
  };
}

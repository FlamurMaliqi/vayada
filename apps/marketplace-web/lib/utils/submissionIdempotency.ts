export type SubmissionIdempotencyState = {
  fingerprint: string;
  keys: Record<string, string>;
};

export type PerWriteSubmissionIdempotencyState = {
  fingerprints: Record<string, string>;
  keys: Record<string, string>;
};

export type SubmissionWriteFingerprint = {
  keyName: string;
  fingerprint: string;
};

export function resolveSubmissionIdempotencyState(
  current: SubmissionIdempotencyState | null,
  fingerprint: string,
  keyNames: readonly string[],
  createKey: (keyName: string) => string,
): SubmissionIdempotencyState {
  if (current?.fingerprint === fingerprint && keyNames.every((keyName) => current.keys[keyName])) {
    return current;
  }

  return {
    fingerprint,
    keys: Object.fromEntries(keyNames.map((keyName) => [keyName, createKey(keyName)])),
  };
}

export function resolvePerWriteSubmissionIdempotencyState(
  current: PerWriteSubmissionIdempotencyState | null,
  writes: readonly SubmissionWriteFingerprint[],
  createKey: (keyName: string) => string,
): PerWriteSubmissionIdempotencyState {
  const fingerprints: Record<string, string> = {};
  const keys: Record<string, string> = {};

  for (const write of writes) {
    fingerprints[write.keyName] = write.fingerprint;
    keys[write.keyName] =
      current?.fingerprints[write.keyName] === write.fingerprint && current.keys[write.keyName]
        ? current.keys[write.keyName]
        : createKey(write.keyName);
  }

  return { fingerprints, keys };
}

export function isDefiniteValidationSubmissionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error) || !("data" in error)) {
    return false;
  }

  const status = error.status;
  const data = error.data;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    !!data &&
    typeof data === "object" &&
    "category" in data &&
    data.category === "validation"
  );
}

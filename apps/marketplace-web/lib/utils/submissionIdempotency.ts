export type SubmissionIdempotencyState = {
  fingerprint: string;
  keys: Record<string, string>;
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

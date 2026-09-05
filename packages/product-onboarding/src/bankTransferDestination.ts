export class BankTransferValidationError extends Error {}

export type SavedBankTransferDestination = {
  id: string;
  revision: number;
  version: number;
  enabled: boolean;
  deleted: boolean;
  maskedAccount: string | null;
};
export type DirectTransferDetails = {
  accountHolder: string;
  accountType: "iban" | "account_number";
  accountNumber: string;
  bankName: string;
  bicSwift: string;
  instructions: string;
};
export type BankTransferSaveAttempt = {
  fingerprint?: string;
  body?: unknown;
  result?: SavedBankTransferDestination;
};

type Transport = {
  get<T>(path: string): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
};
export const bankTransferDestinationPath = (propertyId: string) =>
  `/api/finance/properties/${encodeURIComponent(propertyId.trim())}/bank-transfer-destination`;

export async function readBankTransferDestination(
  client: Pick<Transport, "get">,
  propertyId: string,
) {
  return (
    await client.get<{ destination: SavedBankTransferDestination | null }>(
      bankTransferDestinationPath(propertyId),
    )
  ).destination;
}

export async function saveBankTransferDestination(
  client: Transport,
  input: {
    propertyId: string;
    enabled: boolean;
    details: DirectTransferDetails;
    saved?: SavedBankTransferDestination | null;
    attempt: BankTransferSaveAttempt;
  },
) {
  const fingerprint = JSON.stringify([input.propertyId, input.enabled, input.details]);
  if (input.attempt.fingerprint === fingerprint && input.attempt.result)
    return input.attempt.result;
  const saved =
    input.saved === undefined
      ? await readBankTransferDestination(client, input.propertyId)
      : input.saved;
  if (!input.enabled && !saved?.enabled) return saved;
  const { accountType: _accountType, ...fields } = input.details;
  const edited = Object.values(fields).some((value) => value.trim().length > 0);
  if (input.enabled && !edited && saved?.enabled && !saved.deleted) return saved;
  if (
    input.enabled &&
    (!input.details.bankName.trim() ||
      !input.details.accountHolder.trim() ||
      input.details.accountNumber.replace(/[ -]/g, "").length < 8)
  ) {
    throw new BankTransferValidationError(
      "Enter the complete bank details, or leave all fields empty to keep the saved account.",
    );
  }
  const body =
    input.attempt.fingerprint === fingerprint && input.attempt.body
      ? input.attempt.body
      : input.enabled
        ? {
            action: "replace",
            details: input.details,
            expectedVersion: saved?.version ?? 0,
            commandId: crypto.randomUUID(),
          }
        : { action: "disable", expectedVersion: saved!.version, commandId: crypto.randomUUID() };
  input.attempt.fingerprint = fingerprint;
  input.attempt.body = body;
  delete input.attempt.result;
  const result = (
    await client.put<{ destination: SavedBankTransferDestination }>(
      bankTransferDestinationPath(input.propertyId),
      body,
    )
  ).destination;
  input.attempt.result = result;
  return result;
}

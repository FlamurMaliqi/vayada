export type VayadaAuthState =
  | "invalid_credentials"
  | "email_verification_required"
  | "organization_selection_required"
  | "mfa_required"
  | "sso_required"
  | "auth_failed";

export type VayadaAuthStateOrganization = {
  id: string;
  name?: string;
};

export type VayadaAuthStateResponse = {
  state: VayadaAuthState;
  message: string;
  pendingAuthenticationToken?: string;
  email?: string;
  emailVerificationId?: string;
  organizations?: VayadaAuthStateOrganization[];
  connectionIds?: string[];
};

const STATE_MESSAGES: Record<VayadaAuthState, string> = {
  invalid_credentials: "Email or password is incorrect.",
  email_verification_required: "Verify your email address to continue.",
  organization_selection_required: "Choose a workspace to continue.",
  mfa_required: "Additional verification is required.",
  sso_required: "Single sign-on is required for this account.",
  auth_failed: "Authentication failed. Please try again.",
};

export function mapWorkOSAuthError(error: unknown): VayadaAuthStateResponse {
  const payloads = errorPayloads(error);
  const code = readString(payloads, ["code", "error"]);

  switch (code) {
    case "invalid_credentials":
    case "invalid_grant":
      return stateResponse("invalid_credentials");
    case "email_verification_required":
      return stateResponse("email_verification_required", {
        pendingAuthenticationToken: readString(payloads, [
          "pendingAuthenticationToken",
          "pending_authentication_token",
        ]),
        email: readString(payloads, ["email"]),
        emailVerificationId: readString(payloads, ["emailVerificationId", "email_verification_id"]),
      });
    case "organization_selection_required":
      return stateResponse("organization_selection_required", {
        pendingAuthenticationToken: readString(payloads, [
          "pendingAuthenticationToken",
          "pending_authentication_token",
        ]),
        organizations: readOrganizations(payloads),
      });
    case "mfa_challenge":
    case "mfa_enrollment":
    case "mfa_verification":
    case "mfa_required":
      return stateResponse("mfa_required", {
        pendingAuthenticationToken: readString(payloads, [
          "pendingAuthenticationToken",
          "pending_authentication_token",
        ]),
      });
    case "sso_required":
    case "organization_authentication_methods_required":
      return stateResponse("sso_required", {
        connectionIds: readStringArray(payloads, [
          "connectionIds",
          "connection_ids",
          "ssoConnectionIds",
          "sso_connection_ids",
        ]),
      });
    default:
      return stateResponse("auth_failed");
  }
}

function stateResponse(
  state: VayadaAuthState,
  details: Omit<VayadaAuthStateResponse, "state" | "message"> = {},
): VayadaAuthStateResponse {
  return {
    state,
    message: STATE_MESSAGES[state],
    ...definedEntries(details),
  };
}

function errorPayloads(error: unknown): Array<Record<string, unknown>> {
  if (!isRecord(error)) return [];
  return [
    error,
    ...["rawData", "raw_data", "body", "responseBody", "response"]
      .map((key) => error[key])
      .filter(isRecord),
  ];
}

function readString(payloads: Array<Record<string, unknown>>, keys: string[]): string | undefined {
  for (const payload of payloads) {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

function readStringArray(
  payloads: Array<Record<string, unknown>>,
  keys: string[],
): string[] | undefined {
  for (const payload of payloads) {
    for (const key of keys) {
      const value = payload[key];
      if (!Array.isArray(value)) continue;
      const strings = value.filter((item): item is string => typeof item === "string");
      if (strings.length > 0) return strings;
    }
  }
  return undefined;
}

function readOrganizations(
  payloads: Array<Record<string, unknown>>,
): VayadaAuthStateOrganization[] | undefined {
  for (const payload of payloads) {
    const value = payload.organizations;
    if (!Array.isArray(value)) continue;
    const organizations = value.flatMap((item) => {
      if (!isRecord(item)) return [];
      const id = readString([item], ["id", "organizationId", "organization_id"]);
      if (!id) return [];
      return [
        {
          id,
          name: readString([item], ["name"]),
        },
      ];
    });
    if (organizations.length > 0) return organizations;
  }
  return undefined;
}

function definedEntries<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

import { describe, expect, it } from "vitest";

import { mapWorkOSAuthError } from "./workosAuthState.js";

describe("mapWorkOSAuthError", () => {
  it("maps invalid credentials to a stable login error", () => {
    const error = Object.assign(new Error("raw provider message"), {
      code: "invalid_grant",
    });

    expect(mapWorkOSAuthError(error)).toEqual({
      state: "invalid_credentials",
      message: "Email or password is incorrect.",
    });
  });

  it("maps email verification errors and keeps only UI-safe continuation fields", () => {
    expect(
      mapWorkOSAuthError({
        code: "email_verification_required",
        pending_authentication_token: "pending_123",
        email: "creator@example.test",
        email_verification_id: "email_verification_123",
        error_description: "provider text should not leak",
      }),
    ).toEqual({
      state: "email_verification_required",
      message: "Verify your email address to continue.",
      pendingAuthenticationToken: "pending_123",
      email: "creator@example.test",
      emailVerificationId: "email_verification_123",
    });
  });

  it("maps organization selection errors with workspace candidates", () => {
    expect(
      mapWorkOSAuthError({
        rawData: {
          code: "organization_selection_required",
          pending_authentication_token: "pending_workspace",
          organizations: [
            { id: "org_creator", name: "Creator Studio" },
            { organization_id: "org_hotel", name: "Hotel Group" },
          ],
        },
      }),
    ).toEqual({
      state: "organization_selection_required",
      message: "Choose a workspace to continue.",
      pendingAuthenticationToken: "pending_workspace",
      organizations: [
        { id: "org_creator", name: "Creator Studio" },
        { id: "org_hotel", name: "Hotel Group" },
      ],
    });
  });

  it("maps MFA enrollment and challenge errors to one app state", () => {
    expect(
      mapWorkOSAuthError({
        code: "mfa_challenge",
        pendingAuthenticationToken: "pending_mfa",
      }),
    ).toEqual({
      state: "mfa_required",
      message: "Additional verification is required.",
      pendingAuthenticationToken: "pending_mfa",
    });

    expect(mapWorkOSAuthError({ code: "mfa_enrollment" })).toEqual({
      state: "mfa_required",
      message: "Additional verification is required.",
    });

    expect(mapWorkOSAuthError({ code: "mfa_verification" })).toEqual({
      state: "mfa_required",
      message: "Additional verification is required.",
    });
  });

  it("maps SSO-required errors and connection ids", () => {
    expect(
      mapWorkOSAuthError({
        error: "sso_required",
        connection_ids: ["conn_123", "conn_456"],
      }),
    ).toEqual({
      state: "sso_required",
      message: "Single sign-on is required for this account.",
      connectionIds: ["conn_123", "conn_456"],
    });
  });

  it("maps unknown WorkOS failures to a generic app-owned failure state", () => {
    expect(
      mapWorkOSAuthError({
        code: "unexpected_workos_code",
        message: "raw provider message",
      }),
    ).toEqual({
      state: "auth_failed",
      message: "Authentication failed. Please try again.",
    });
  });
});

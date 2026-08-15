import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { APIRequestContext, Page } from "@playwright/test";

const WORKOS_ORIGIN = "https://api.workos.com";

export const NEXT_STACK_ORIGINS = Object.freeze({
  api: "https://next-api.vayada.com",
  bookingAdmin: "https://next-booking-admin.vayada.com",
  marketplace: "https://next-marketplace.vayada.com",
  pms: "https://next-pms.vayada.com",
});

export type SmokeEnvironment = {
  emailDomain: string;
  password: string;
  runId: string;
  workosApiKey: string;
};

export type AuthSession = {
  accessToken: string;
  csrfToken: string;
  organizationId: string;
  workosOrganizationId: string;
  organizationKind: "creator_workspace" | "hotel_group";
  user: { id: string; email: string; workosUserId?: string };
};

export type SyntheticUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "hotel" | "creator";
};

export type UploadedMedia = {
  mediaObjectId: string;
};

export class JsonApi {
  constructor(
    private readonly request: APIRequestContext,
    private readonly origin: string,
    private readonly authorization?: string,
  ) {}

  async json<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    route: string,
    body?: unknown,
    headers: Record<string, string> = {},
    timeout?: number,
  ): Promise<T> {
    const response = await this.request.fetch(new URL(route, this.origin).toString(), {
      method,
      ...(timeout === undefined ? {} : { timeout }),
      headers: {
        ...(this.authorization ? { authorization: this.authorization } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { data: body }),
    });
    const text = await response.text();
    if (!response.ok()) {
      throw new Error(`${method} ${route} returned ${response.status()}: ${safeError(text)}`);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${method} ${route} returned invalid JSON.`);
    }
  }

  async deleteIfPresent(route: string): Promise<void> {
    const response = await this.request.delete(new URL(route, this.origin).toString(), {
      headers: this.authorization ? { authorization: this.authorization } : {},
    });
    if (!response.ok() && response.status() !== 404) {
      throw new Error(
        `DELETE ${route} returned ${response.status()}: ${safeError(await response.text())}`,
      );
    }
  }
}

export function loadSmokeEnvironment(): SmokeEnvironment {
  if (process.env.E2E_NEXT_STACK_SMOKE !== "1") {
    throw new Error("Set E2E_NEXT_STACK_SMOKE=1 to acknowledge the live next-stack smoke.");
  }
  if (process.env.NEXT_STACK_SMOKE_ENV !== "next") {
    throw new Error("NEXT_STACK_SMOKE_ENV must be exactly 'next'.");
  }

  const workosApiKey = required("WORKOS_API_KEY");
  if (!workosApiKey.startsWith("sk_")) {
    throw new Error("WORKOS_API_KEY must be a WorkOS secret key.");
  }
  if (
    !workosApiKey.startsWith("sk_test_") &&
    process.env.NEXT_STACK_SMOKE_ALLOW_LIVE_WORKOS !== "1"
  ) {
    throw new Error(
      "The deployed next stack uses live WorkOS; set NEXT_STACK_SMOKE_ALLOW_LIVE_WORKOS=1 to acknowledge synthetic user creation and deletion.",
    );
  }
  const password = required("NEXT_STACK_SMOKE_PASSWORD");
  if (password.length < 12) {
    throw new Error("NEXT_STACK_SMOKE_PASSWORD must contain at least 12 characters.");
  }
  const emailDomain = required("NEXT_STACK_SMOKE_EMAIL_DOMAIN").toLowerCase();
  if (!/^[a-z0-9.-]+\.test$/.test(emailDomain)) {
    throw new Error("NEXT_STACK_SMOKE_EMAIL_DOMAIN must use the reserved .test suffix.");
  }

  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return {
    emailDomain,
    password,
    runId: `${timestamp}-${randomBytes(4).toString("hex")}`,
    workosApiKey,
  };
}

export async function createSyntheticUser(
  request: APIRequestContext,
  environment: SmokeEnvironment,
  role: "hotel" | "creator",
  qualifier = "",
): Promise<SyntheticUser> {
  const firstName = role === "hotel" ? "Harper" : "Casey";
  const lastName = `Smoke ${environment.runId.slice(-8)}`;
  const email = `qa-next-${qualifier ? `${qualifier}-` : ""}${role}-${environment.runId}@${environment.emailDomain}`;
  const api = workosApi(request, environment.workosApiKey);
  const user = await api.json<Record<string, unknown>>("POST", "/user_management/users", {
    email,
    password: environment.password,
    first_name: firstName,
    last_name: lastName,
    email_verified: true,
  });
  return { id: stringField(user, "id"), email, firstName, lastName, role };
}

export async function login(page: Page, user: SyntheticUser, password: string): Promise<void> {
  await page.goto(`${NEXT_STACK_ORIGINS.marketplace}/login?returnTo=/onboarding`);
  await page.getByLabel("Email address").fill(user.email);
  await page.getByLabel("Password").fill(password);
  const loginResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/auth/password/login" &&
      response.request().method() === "POST",
    { timeout: 45_000 },
  );
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  const loginResponse = await loginResponsePromise;
  if (!loginResponse.ok()) {
    throw new Error(
      `Marketplace password login returned ${loginResponse.status()}: ${safeError(await loginResponse.text())}`,
    );
  }
  try {
    await page.waitForURL(
      (url) => url.origin === NEXT_STACK_ORIGINS.marketplace && url.pathname === "/onboarding",
      { timeout: 45_000 },
    );
  } catch {
    const messages = await page.getByRole("alert").allTextContents();
    throw new Error(
      `Marketplace login did not reach onboarding; current path ${new URL(page.url()).pathname}; alerts: ${messages.join(" | ") || "none"}.`,
    );
  }
}

export async function readAuthSession(page: Page): Promise<AuthSession> {
  const result = await page.evaluate(async () => {
    const response = await fetch("/auth/session?surface=marketplace-web", {
      credentials: "include",
    });
    return { status: response.status, body: await response.text() };
  });
  if (result.status !== 200) {
    throw new Error(`Marketplace session returned ${result.status}: ${safeError(result.body)}`);
  }
  const session = JSON.parse(result.body) as Partial<AuthSession>;
  for (const field of [
    "accessToken",
    "csrfToken",
    "organizationId",
    "workosOrganizationId",
  ] as const) {
    if (!session[field]) throw new Error(`Marketplace session is missing ${field}.`);
  }
  if (
    session.organizationKind !== "hotel_group" &&
    session.organizationKind !== "creator_workspace"
  ) {
    throw new Error("Marketplace session has the wrong organization kind.");
  }
  return session as AuthSession;
}

export function targetApi(request: APIRequestContext, accessToken: string): JsonApi {
  return new JsonApi(request, NEXT_STACK_ORIGINS.api, `Bearer ${accessToken}`);
}

export function publicApi(request: APIRequestContext): JsonApi {
  return new JsonApi(request, NEXT_STACK_ORIGINS.api);
}

export function workosApi(request: APIRequestContext, apiKey: string): JsonApi {
  return new JsonApi(request, WORKOS_ORIGIN, `Bearer ${apiKey}`);
}

export async function workosOrganizationsForUser(
  request: APIRequestContext,
  apiKey: string,
  userId: string,
): Promise<string[]> {
  const response = await workosApi(request, apiKey).json<Record<string, unknown>>(
    "GET",
    `/user_management/organization_memberships?user_id=${encodeURIComponent(userId)}&limit=100`,
  );
  return arrayField(response, "data")
    .map(record)
    .map((membership) => stringField(membership, "organization_id"));
}

export async function workosUserIdsForEmail(
  request: APIRequestContext,
  apiKey: string,
  email: string,
): Promise<string[]> {
  const response = await workosApi(request, apiKey).json<Record<string, unknown>>(
    "GET",
    `/user_management/users?email=${encodeURIComponent(email)}&limit=100`,
  );
  return arrayField(response, "data")
    .map(record)
    .filter((user) => user.email === email)
    .map((user) => stringField(user, "id"));
}

export async function uploadPropertyCover(
  request: APIRequestContext,
  api: JsonApi,
  propertyId: string,
  runId: string,
): Promise<UploadedMedia> {
  const bytes = await readFile(
    path.resolve("apps/marketplace-web/public/creator-category-travel.jpg"),
  );
  const created = await api.json<Record<string, unknown>>("POST", "/api/media/upload-sessions", {
    idempotencyKey: `next-smoke:${runId}:cover`,
    purpose: "property.hero_image",
    visibility: "private",
    resource: {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: propertyId,
      propertyId,
    },
    files: [
      {
        clientFileId: "file_1",
        filename: `next-smoke-${runId}.jpg`,
        contentType: "image/jpeg",
        sizeBytes: bytes.length,
      },
    ],
  });
  const uploadSession = recordField(created, "uploadSession");
  const sessionId = stringField(uploadSession, "sessionId");
  if (uploadSession.status === "completed") {
    return mediaFrom(created);
  }
  const targets = arrayField(created, "uploadTargets");
  const target = record(targets[0]);
  const response = await request.fetch(stringField(target, "uploadUrl"), {
    method: "PUT",
    headers: stringRecord(target.headers),
    data: bytes,
  });
  if (!response.ok()) {
    throw new Error(`Property cover upload returned ${response.status()}.`);
  }
  const finalized = await api.json<Record<string, unknown>>(
    "POST",
    `/api/media/upload-sessions/${encodeURIComponent(sessionId)}/finalize`,
    {
      files: [
        {
          uploadTargetId: stringField(target, "uploadTargetId"),
          contentType: "image/jpeg",
          sizeBytes: bytes.length,
        },
      ],
    },
  );
  return mediaFrom(finalized);
}

export function futureStay(): { checkIn: string; checkOut: string } {
  const checkIn = new Date();
  checkIn.setUTCDate(checkIn.getUTCDate() + 60);
  const checkOut = new Date(checkIn);
  checkOut.setUTCDate(checkOut.getUTCDate() + 2);
  return { checkIn: dateOnly(checkIn), checkOut: dateOnly(checkOut) };
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object response.");
  }
  return value as Record<string, unknown>;
}

export function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || !result) throw new Error(`Response is missing ${field}.`);
  return result;
}

export function numberField(value: Record<string, unknown>, field: string): number {
  const result = value[field];
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error(`Response is missing numeric ${field}.`);
  }
  return result;
}

export function recordField(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  return record(value[field]);
}

export function arrayField(value: Record<string, unknown>, field: string): unknown[] {
  const result = value[field];
  if (!Array.isArray(result)) throw new Error(`Response is missing ${field}.`);
  return result;
}

function mediaFrom(value: Record<string, unknown>): UploadedMedia {
  return {
    mediaObjectId: stringField(record(arrayField(value, "mediaObjects")[0]), "mediaObjectId"),
  };
}

function stringRecord(value: unknown): Record<string, string> {
  const object = record(value);
  if (!Object.values(object).every((entry) => typeof entry === "string")) {
    throw new Error("Upload target headers are invalid.");
  }
  return object as Record<string, string>;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function safeError(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 800) || "empty response";
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

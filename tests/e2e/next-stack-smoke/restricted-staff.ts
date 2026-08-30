import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import {
  NEXT_STACK_ORIGINS,
  arrayField,
  login,
  loginPms,
  readAuthSession,
  record,
  stringField,
  workosApi,
  type JsonApi,
  type SmokeEnvironment,
  type SyntheticUser,
} from "./support";

type RestrictedStaffArgs = {
  assignedPropertyId: string;
  browser: Browser;
  environment: SmokeEnvironment;
  foreignPropertyId: string;
  ownerApi: JsonApi;
  ownerWorkosOrganizationId: string;
  ownerWorkosUserId: string;
  replacementPropertyId: string;
  request: APIRequestContext;
  staff: SyntheticUser;
};

export async function runRestrictedStaffAcceptance(args: RestrictedStaffArgs): Promise<void> {
  const { browser, environment, request, staff } = args;
  const propertyA = args.assignedPropertyId;
  const propertyB = args.replacementPropertyId;
  const propertyC = args.foreignPropertyId;
  const context = await browser.newContext();

  try {
    const page = await context.newPage();
    await test.step("prime the staff identity through Vayada", () =>
      login(page, staff, environment.password));

    const membershipId =
      await test.step("invite and activate assigned-property staff", async () => {
        const invitedAt = Date.now();
        const invitation = await args.ownerApi.json<Record<string, unknown>>(
          "POST",
          "/api/identity/staff/invitations",
          {
            email: staff.email,
            name: `${staff.firstName} ${staff.lastName}`,
            roleKey: "front_desk",
            propertyIds: [propertyA],
            permissionOverrides: { grant: [], deny: ["pms.rooms_rates.read"] },
            configurationRevision: 1,
          },
          { "Idempotency-Key": `next-smoke:${environment.runId}:staff-invite` },
        );
        expect(invitation.delivery).toBe("delivered");

        const workos = workosApi(request, environment.workosApiKey);
        let providerInvitationId = "";
        await expect
          .poll(
            async () => {
              const listed = await workos.json<Record<string, unknown>>(
                "GET",
                `/user_management/invitations?email=${encodeURIComponent(staff.email)}&organization_id=${encodeURIComponent(args.ownerWorkosOrganizationId)}&limit=100`,
              );
              const matches = arrayField(listed, "data")
                .map(record)
                .filter(
                  (candidate) =>
                    candidate.email === staff.email &&
                    candidate.organization_id === args.ownerWorkosOrganizationId &&
                    candidate.inviter_user_id === args.ownerWorkosUserId &&
                    candidate.role_slug === "hotel_member" &&
                    candidate.state === "pending" &&
                    candidate.accepted_user_id === null &&
                    typeof candidate.expires_at === "string" &&
                    Math.abs(Date.parse(candidate.expires_at) - invitedAt - 7 * 86_400_000) <=
                      120_000,
                );
              providerInvitationId = matches.length === 1 ? stringField(matches[0]!, "id") : "";
              return matches.length;
            },
            { timeout: 60_000 },
          )
          .toBe(1);

        const accepted = await workos.json<Record<string, unknown>>(
          "POST",
          `/user_management/invitations/${encodeURIComponent(providerInvitationId)}/accept`,
          null,
        );
        expect(accepted.id).toBe(providerInvitationId);
        expect(accepted.email).toBe(staff.email);
        expect(accepted.organization_id).toBe(args.ownerWorkosOrganizationId);
        expect(accepted.inviter_user_id).toBe(args.ownerWorkosUserId);
        expect(accepted.role_slug).toBe("hotel_member");
        expect(accepted.state).toBe("accepted");
        expect(accepted.accepted_user_id).toBe(staff.id);
        expect(Number.isFinite(Date.parse(stringField(accepted, "accepted_at")))).toBe(true);

        await expect
          .poll(async () => rosterAccess(args.ownerApi, staff.email), { timeout: 90_000 })
          .toEqual(staffAccess(propertyA, "active", "front_desk"));
        const members = await rosterMembers(args.ownerApi, staff.email);
        expect(members).toHaveLength(1);

        return stringField(members[0]!, "id");
      });

    await test.step("enforce the initial staff permission and property scope", async () => {
      await loginPms(page, staff, environment.password);
      const session = await readAuthSession(page, "pms-web");
      const token = session.accessToken;
      expect(session.user.workosUserId).toBe(staff.id);
      expect(session.workosOrganizationId).toBe(args.ownerWorkosOrganizationId);
      expect(session.resources).toEqual({ "pms:pms_property": [propertyA] });

      await expectPms(token, rooms(propertyA), 200);
      await expectPms(token, roomTypes(propertyA), 403, "missing_permission");
      const [unassigned, foreign] = await Promise.all(
        [propertyB, propertyC].map((propertyId) =>
          expectPms(token, rooms(propertyId), 403, "missing_resource_access"),
        ),
      );
      expect(foreign).toEqual(unassigned);
      await expectPms(token, "/api/identity/staff/members", 403, "forbidden");

      await args.ownerApi.json(
        "PATCH",
        `/api/identity/staff/members/${membershipId}`,
        {
          roleKey: "hotel_custom",
          propertyIds: [propertyB],
          permissionOverrides: { grant: ["pms.room_status.read"], deny: [] },
        },
        { "Idempotency-Key": `next-smoke:${environment.runId}:staff-access` },
      );

      const flipped = await readAuthSession(page, "pms-web");
      expect(flipped.resources).toEqual({ "pms:pms_property": [propertyB] });
      await expectPms(token, rooms(propertyA), 403, "missing_resource_access");
      await expectPms(token, rooms(propertyB), 200);
    });

    await test.step("deactivation invalidates the existing staff bearer", async () => {
      const session = await readAuthSession(page, "pms-web");
      await args.ownerApi.json(
        "PATCH",
        `/api/identity/staff/members/${membershipId}/status`,
        { status: "deactivated" },
        { "Idempotency-Key": `next-smoke:${environment.runId}:staff-deactivate` },
      );
      await expect
        .poll(async () => rosterAccess(args.ownerApi, staff.email))
        .toEqual(staffAccess(propertyB, "deactivated"));
      await expectPms(session.accessToken, rooms(propertyB), 401);
      expect(await pmsSessionStatus(page)).toBe(403);
    });
  } finally {
    await context.close();
  }
}

async function rosterMembers(ownerApi: JsonApi, email: string) {
  const roster = await ownerApi.json<Record<string, unknown>>("GET", "/api/identity/staff/members");
  return arrayField(roster, "members")
    .map(record)
    .filter((member) => member.email === email);
}

async function rosterAccess(ownerApi: JsonApi, email: string) {
  const members = await rosterMembers(ownerApi, email);
  if (members.length !== 1) return null;
  const member = members[0]!;
  return {
    propertyIds: arrayField(member, "propertyIds"),
    roleKey: stringField(member, "roleKey"),
    status: stringField(member, "status"),
  };
}

function staffAccess(
  propertyId: string,
  status: "active" | "deactivated",
  roleKey: "front_desk" | "hotel_custom" = "hotel_custom",
) {
  return { propertyIds: [propertyId], roleKey, status };
}

function rooms(propertyId: string): string {
  return `/api/pms/properties/${propertyId}/rooms`;
}

function roomTypes(propertyId: string): string {
  return `/api/pms/properties/${propertyId}/room-types`;
}

export async function expectPms(
  accessToken: string,
  route: string,
  status: number,
  code?: string,
  nativeFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Record<string, unknown> | undefined> {
  const response = await nativeFetch(new URL(route, NEXT_STACK_ORIGINS.api), {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new Error(`GET ${route} request failed.`);
  });
  expect(response.status).toBe(status);
  if (!code) return undefined;
  const actual = record(await response.json());
  expect(actual.code).toBe(code);
  return actual;
}

async function pmsSessionStatus(page: Page): Promise<number> {
  return page.evaluate(
    async () => (await fetch("/auth/session?surface=pms-web", { credentials: "include" })).status,
  );
}

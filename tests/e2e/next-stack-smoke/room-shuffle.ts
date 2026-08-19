import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import type { BookingResource } from "./booking-lifecycle";
import {
  NEXT_STACK_ORIGINS,
  arrayField,
  numberField,
  record,
  recordField,
  stringField,
  type JsonApi,
  type SmokeEnvironment,
} from "./support";

type Args = {
  api: JsonApi;
  bookings: BookingResource[];
  environment: SmokeEnvironment;
  page: Page;
  propertyId: string;
  roomTypeId: string;
  slug: string;
  testInfo: TestInfo;
};

type CreatedBooking = {
  assignment: Record<string, unknown>;
  resource: BookingResource;
  result: Record<string, unknown>;
};

type ToastTiming = {
  hiddenAt: number | null;
  shownAt: number | null;
  zeroResponseAt: number | null;
};

export async function runRoomShuffleAcceptance(args: Args): Promise<void> {
  const { api, page, propertyId, roomTypeId, testInfo } = args;
  const roomsResponse = await api.json<Record<string, unknown>>(
    "GET",
    `/api/pms/properties/${propertyId}/rooms`,
  );
  const rooms = arrayField(roomsResponse, "items")
    .map(record)
    .filter((room) => stringField(room, "roomTypeId") === roomTypeId)
    .sort((left, right) => numberField(left, "sortOrder") - numberField(right, "sortOrder"));
  expect(rooms).toHaveLength(2);
  const room1 = stringField(rooms[0]!, "roomId"),
    room2 = stringField(rooms[1]!, "roomId");
  const evidence: Record<string, unknown> = {
    propertyId,
    roomTypeId,
    rooms: rooms.map((room) => ({
      roomId: stringField(room, "roomId"),
      label: stringField(room, "roomNumber"),
    })),
  };

  await test.step("persist automatic room assignment off and keep zero moves silent", async () => {
    await api.json("PATCH", `/api/pms/properties/${propertyId}/calendar-settings`, {
      autoRearrangeEnabled: true,
    });
    await page.goto(`${NEXT_STACK_ORIGINS.pms}/settings`);
    const toggle = page.getByRole("switch", { name: "Optimize room assignments" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const disableResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/pms/properties/${propertyId}/calendar-settings`,
    );
    await toggle.click();
    expect((await disableResponse).status()).toBe(200);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await page.screenshot({
      path: testInfo.outputPath("vay-667-setting-off.png"),
      fullPage: true,
    });

    const anchor = await createApiBooking(args, "Setting off anchor", room1, 50, 51);
    const follower = await createUiBooking(args, "Setting off follower", room2, 51, 52);
    expect(numberField(follower.result, "rearrangedBookingCount")).toBe(0);
    await expect(page.getByText(/rearranged for optimal room usage/)).toHaveCount(0);
    expect(stringField(await assignment(args, follower.resource.bookingId), "roomId")).toBe(room2);
    evidence.settingOff = {
      persisted: true,
      anchorRoomId: stringField(anchor.assignment, "roomId"),
      followerRoomId: room2,
      rearrangedBookingCount: 0,
      zeroToastSilent: true,
    };
  });

  await test.step("persist automatic room assignment on and pack a same-day turnover", async () => {
    await page.goto(`${NEXT_STACK_ORIGINS.pms}/settings`);
    const toggle = page.getByRole("switch", { name: "Optimize room assignments" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const enableResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/pms/properties/${propertyId}/calendar-settings`,
    );
    await toggle.click();
    expect((await enableResponse).status()).toBe(200);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.screenshot({
      path: testInfo.outputPath("vay-667-setting-on.png"),
      fullPage: true,
    });

    const trigger = await createUiBooking(args, "Setting on trigger", room2, 52, 53, true);
    const count = numberField(trigger.result, "rearrangedBookingCount");
    expect(count).toBe(2);
    const follower = args.bookings.find(({ email }) => email.includes("setting-off-follower"));
    if (!follower) throw new Error("Setting-off follower resource is missing.");
    expect(stringField(await assignment(args, follower.bookingId), "roomId")).toBe(room1);
    expect(stringField(trigger.assignment, "roomId")).toBe(room1);

    const toast = page.getByText("2 bookings rearranged for optimal room usage", { exact: true });
    await expect(toast).toBeVisible();
    await expect(toast).toBeHidden({ timeout: 6_000 });
    const timing = await toastTiming(page);
    expect(timing.shownAt).not.toBeNull();
    expect(timing.hiddenAt).not.toBeNull();
    const observedMilliseconds = timing.hiddenAt! - timing.shownAt!;
    expect(observedMilliseconds).toBeGreaterThanOrEqual(4_900);
    expect(observedMilliseconds).toBeLessThan(5_500);
    evidence.settingOn = {
      persisted: true,
      deterministicDestinationRoomId: room1,
      sameDayTurnover: true,
      rearrangedBookingCount: count,
      toastText: "2 bookings rearranged for optimal room usage",
      toastObservedMilliseconds: observedMilliseconds,
    };
  });

  await test.step("repack after a cancellation", async () => {
    const anchor = await createApiBooking(args, "Cancel anchor", room1, 80, 83);
    const follower = await createApiBooking(args, "Cancel follower", room2, 81, 82);
    expect(stringField(follower.assignment, "roomId")).toBe(room2);
    const command = commandEnvelope();
    const cancelled = record(
      await api.json(
        "POST",
        `/api/pms/properties/${propertyId}/reservations/${anchor.resource.bookingId}/cancel`,
        {
          ...command,
          reason: "VAY-667 deployed acceptance",
          accountingDate: null,
          retainedCharges: [],
        },
      ),
    );
    anchor.resource.resolved = true;
    const count = numberField(recordField(cancelled, "commandMeta"), "rearrangedBookingCount");
    expect(count).toBe(1);
    expect(stringField(await assignment(args, follower.resource.bookingId), "roomId")).toBe(room1);
    evidence.cancelTrigger = { rearrangedBookingCount: count, destinationRoomId: room1 };
  });

  await test.step("repack after a stay modification", async () => {
    await createApiBooking(args, "Modify anchor", room1, 90, 92);
    const subject = await createApiBooking(args, "Modify subject", room2, 91, 93);
    expect(stringField(subject.assignment, "roomId")).toBe(room2);
    const command = commandEnvelope(),
      checkIn = futureDate(92),
      checkOut = futureDate(93);
    const modified = record(
      await api.json(
        "POST",
        `/api/pms/properties/${propertyId}/reservations/${subject.resource.bookingId}/correct-stays`,
        {
          ...command,
          accountingDate: futureDate(0),
          stays: [
            {
              assignmentId: stringField(subject.assignment, "assignmentId"),
              position: 1,
              roomId: room2,
              checkIn,
              checkOut,
              nightly: [
                {
                  stayDate: checkIn,
                  amount: { amountDecimal: "150.00", currency: "EUR" },
                  evidenceQuality: "exact",
                },
              ],
            },
          ],
        },
      ),
    );
    const count = numberField(recordField(modified, "commandMeta"), "rearrangedBookingCount");
    expect(count).toBe(1);
    expect(stringField(await assignment(args, subject.resource.bookingId), "roomId")).toBe(room1);
    evidence.modifyTrigger = { rearrangedBookingCount: count, destinationRoomId: room1 };
  });

  await test.step("keep an in-house stay immovable", async () => {
    const inHouse = await createApiBooking(args, "In house", room1, 0, 2);
    const assignmentId = stringField(inHouse.assignment, "assignmentId");
    for (const status of ["checked_in", "in_house"] as const) {
      await api.json(
        "POST",
        `/api/pms/properties/${propertyId}/reservations/${inHouse.resource.bookingId}/status`,
        { ...commandEnvelope(), status },
      );
    }
    const candidate = await createApiBooking(args, "In house overlap", room2, 1, 2);
    const fixed = await assignment(args, inHouse.resource.bookingId),
      overlapping = await assignment(args, candidate.resource.bookingId);
    expect(fixed).toMatchObject({ assignmentId, roomId: room1, assignmentStatus: "in_house" });
    expect(stringField(overlapping, "roomId")).toBe(room2);
    expect(numberField(candidate.result, "rearrangedBookingCount")).toBe(0);
    inHouse.resource.resolved = true;
    evidence.inHouseSafety = {
      fixedRoomId: room1,
      overlappingRoomId: room2,
      rearrangedBookingCount: 0,
    };
  });

  await test.step("never move a stay into a blocked room", async () => {
    const command = commandEnvelope(),
      startsOn = futureDate(100),
      endsOn = futureDate(101);
    const createdBlock = record(
      await api.json("POST", `/api/pms/properties/${propertyId}/room-blocks`, {
        ...command,
        roomTypeId,
        roomIds: [room1],
        startsOn,
        endsOn,
        reason: "VAY-667 deployed acceptance",
      }),
    );
    const block = record(arrayField(createdBlock, "items")[0]),
      candidate = await createApiBooking(args, "Blocked room overlap", room2, 100, 102);
    expect(stringField(candidate.assignment, "roomId")).toBe(room2);
    expect(numberField(candidate.result, "rearrangedBookingCount")).toBe(0);
    evidence.blockedRoomSafety = {
      blockedRoomId: room1,
      assignedRoomId: room2,
      rearrangedBookingCount: 0,
    };
    await api.json(
      "DELETE",
      `/api/pms/properties/${propertyId}/room-blocks/${stringField(block, "blockId")}`,
      { ...commandEnvelope(), expectedVersion: stringField(block, "version") },
    );
  });

  await test.step("clear a live nonzero toast when the next create moves zero bookings", async () => {
    await createApiBooking(args, "Zero anchor", room1, 70, 71);
    const positive = await createUiBooking(args, "Zero transition positive", room2, 71, 72, true);
    const positiveCount = numberField(positive.result, "rearrangedBookingCount");
    expect(positiveCount).toBe(1);
    const toast = page.getByText("1 booking rearranged for optimal room usage", { exact: true });
    await expect(toast).toBeVisible();
    const silent = await createUiBooking(args, "Zero transition silent", room1, 75, 76);
    expect(numberField(silent.result, "rearrangedBookingCount")).toBe(0);
    await expect(toast).toBeHidden();
    const timing = await toastTiming(page);
    expect(timing.shownAt).not.toBeNull();
    expect(timing.hiddenAt).not.toBeNull();
    expect(timing.zeroResponseAt).not.toBeNull();
    const observedMilliseconds = timing.hiddenAt! - timing.shownAt!,
      zeroResponseToHiddenMilliseconds = timing.hiddenAt! - timing.zeroResponseAt!;
    expect(observedMilliseconds).toBeLessThan(4_900);
    expect(zeroResponseToHiddenMilliseconds).toBeGreaterThanOrEqual(0);
    expect(zeroResponseToHiddenMilliseconds).toBeLessThan(500);
    evidence.zeroAfterNonzero = {
      previousRearrangedBookingCount: positiveCount,
      nextRearrangedBookingCount: 0,
      clearedBeforeNaturalTimeout: true,
      toastObservedMilliseconds: observedMilliseconds,
      zeroResponseToHiddenMilliseconds,
    };
  });

  await test.step("show create, cancel and modify moves in room shuffle history", async () => {
    await createApiBooking(args, "History anchor", room1, 110, 111);
    const trigger = await createUiBooking(args, "History trigger", room2, 111, 112);
    const count = numberField(trigger.result, "rearrangedBookingCount");
    expect(count).toBeGreaterThan(0);
    const toast = page.getByText(
      `${count} ${count === 1 ? "booking" : "bookings"} rearranged for optimal room usage`,
      { exact: true },
    );
    await expect(toast).toBeVisible();
    await page.getByRole("button", { name: "View log" }).click();
    const historyDialog = page.getByRole("dialog", { name: "Room move history" });
    await expect(historyDialog).toBeVisible();
    for (const reason of ["create", "cancel", "modify"]) {
      await expect(historyDialog.getByText(reason, { exact: true }).first()).toBeVisible();
    }
    const history = record(
      await api.json("GET", `/api/pms/properties/${propertyId}/calendar-shuffles?limit=100`),
    );
    const items = arrayField(history, "items").map(record),
      reasons = [...new Set(items.map((item) => stringField(item, "reason")))].sort();
    expect(reasons).toEqual(expect.arrayContaining(["cancel", "create", "modify"]));
    expect(items.every((item) => stringField(item, "roomTypeId") === roomTypeId)).toBe(true);
    const selectedRoomIds = new Set(rooms.map((room) => stringField(room, "roomId")));
    expect(
      items.every((item) => {
        const fromRoom = item["fromRoom"],
          toRoom = recordField(item, "toRoom");
        return (
          (fromRoom === null || selectedRoomIds.has(stringField(record(fromRoom), "roomId"))) &&
          selectedRoomIds.has(stringField(toRoom, "roomId"))
        );
      }),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("vay-667-room-shuffle-history.png"),
      fullPage: true,
    });
    evidence.history = {
      itemCount: items.length,
      reasons,
      sameRoomTypeOnly: true,
      optimizerScopeProof:
        "The same acceptance workflow asserts every optimizer room, assignment, block, and guarded-update query is scoped to the requested property and room type.",
      uiVerified: true,
    };
  });

  evidence.pinnedSafety = {
    liveApiCanCreatePinnedFixture: false,
    proof:
      "The same acceptance workflow runs a focused target optimizer test with a pinned=true future stay and proves it remains fixed while adjacent movable stays pack around it. The deployed target API has no supported pin-mutation surface, so this criterion is intentionally verified at the optimizer boundary rather than misrepresented as a live fixture.",
  };
  evidence.completedAt = new Date().toISOString();
  await writeFile(
    testInfo.outputPath("vay-667-acceptance.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

async function createApiBooking(
  args: Args,
  label: string,
  roomId: string,
  checkInOffset: number,
  checkOutOffset: number,
): Promise<CreatedBooking> {
  const body = bookingBody(args, label, roomId, checkInOffset, checkOutOffset),
    result = record(
      await args.api.json("POST", `/api/pms/properties/${args.propertyId}/manual-bookings`, body),
    ),
    resource = registerBooking(args, result, stringField(recordField(body, "guest"), "email"));
  return { result, resource, assignment: await assignment(args, resource.bookingId) };
}

async function createUiBooking(
  args: Args,
  label: string,
  roomId: string,
  checkInOffset: number,
  checkOutOffset: number,
  observeToast = false,
): Promise<CreatedBooking> {
  const { page, propertyId } = args;
  if (new URL(page.url()).pathname !== "/calendar") {
    await page.goto(`${NEXT_STACK_ORIGINS.pms}/calendar`);
  }
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "+ New Booking", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New booking" }),
    email = `qa-next-${slug(label)}-${args.environment.runId}@${args.environment.emailDomain}`;
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Room 1 room").selectOption(roomId);
  await dialog.getByLabel("Room 1 check-in").fill(futureDate(checkInOffset));
  await dialog.getByLabel("Room 1 check-out").fill(futureDate(checkOutOffset));
  await dialog.getByLabel("First name").fill("Vera");
  await dialog.getByLabel("Last name").fill(label);
  await dialog.locator('input[type="email"]').fill(email);
  await dialog.locator('input[name="phoneE164"]').fill("+49305550166");
  await dialog.getByLabel("Guest country").fill("DE");
  const submit = dialog.getByRole("button", { name: "Create booking" });
  await expect(submit).toBeEnabled({ timeout: 15_000 });
  if (observeToast) await startToastObservation(page);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/pms/properties/${propertyId}/manual-bookings`,
  );
  await submit.click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(201);
  const result = record(await response.json()),
    resource = registerBooking(args, result, email);
  await expect(dialog).toBeHidden();
  return { result, resource, assignment: await assignment(args, resource.bookingId) };
}

async function startToastObservation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const global = window as typeof window & {
        __vay667RestoreFetch?: () => void;
        __vay667ToastObserver?: MutationObserver;
        __vay667ToastTiming?: ToastTiming;
      },
      timing: ToastTiming = { hiddenAt: null, shownAt: null, zeroResponseAt: null };
    global.__vay667RestoreFetch?.();
    global.__vay667ToastObserver?.disconnect();
    global.__vay667ToastTiming = timing;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...input) => {
      const response = await originalFetch(...input);
      if (new URL(response.url).pathname.endsWith("/manual-bookings")) {
        try {
          const payload = (await response.clone().json()) as Record<string, unknown>;
          if (payload["rearrangedBookingCount"] === 0 && timing.shownAt !== null) {
            timing.zeroResponseAt = performance.now();
          }
        } catch {
          // The application remains authoritative if an unrelated response is not JSON.
        }
      }
      return response;
    };
    global.__vay667RestoreFetch = () => {
      window.fetch = originalFetch;
    };
    let wasVisible = false;
    const check = () => {
        const visible = [...document.querySelectorAll<HTMLElement>('[role="status"]')].some(
          (element) => {
            const style = getComputedStyle(element),
              bounds = element.getBoundingClientRect();
            return (
              element.textContent?.includes("rearranged for optimal room usage") === true &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              bounds.width > 0 &&
              bounds.height > 0
            );
          },
        );
        const now = performance.now();
        if (visible && !wasVisible && timing.shownAt === null) timing.shownAt = now;
        if (!visible && wasVisible && timing.shownAt !== null && timing.hiddenAt === null) {
          timing.hiddenAt = now;
        }
        wasVisible = visible;
      },
      observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    global.__vay667ToastObserver = observer;
    check();
  });
}

async function toastTiming(page: Page): Promise<ToastTiming> {
  return page.evaluate(() => {
    const timing = (window as typeof window & { __vay667ToastTiming?: ToastTiming })
      .__vay667ToastTiming;
    if (!timing) throw new Error("Toast observation was not started.");
    return timing;
  });
}

function bookingBody(
  args: Args,
  label: string,
  roomId: string,
  checkInOffset: number,
  checkOutOffset: number,
): Record<string, unknown> {
  const commandId = randomUUID();
  return {
    contractVersion: "pms-manual-booking.v1",
    commandId,
    idempotencyKey: commandId,
    stays: [
      {
        position: 1,
        roomId,
        checkIn: futureDate(checkInOffset),
        checkOut: futureDate(checkOutOffset),
        adults: 1,
        children: 0,
        ratePlanId: null,
        pricing: {
          kind: "custom",
          nightlyAmount: { amountDecimal: "150.00", currency: "EUR" },
        },
      },
    ],
    addOns: [],
    guest: {
      firstName: "Vera",
      lastName: label,
      email: `qa-next-${slug(label)}-${args.environment.runId}@${args.environment.emailDomain}`,
      phoneE164: "+49305550166",
      countryCode: "DE",
      specialRequests: null,
    },
    privateNote: null,
    directSource: "email",
    payment: { expectedMethod: "pay_at_property", settlement: { status: "unpaid" } },
  };
}

async function assignment(args: Args, bookingId: string): Promise<Record<string, unknown>> {
  const detail = recordField(
    await args.api.json("GET", `/api/pms/properties/${args.propertyId}/reservations/${bookingId}`),
    "item",
  );
  const assignments = arrayField(detail, "assignments").map(record);
  expect(assignments).toHaveLength(1);
  return assignments[0]!;
}

function registerBooking(
  args: Args,
  result: Record<string, unknown>,
  email: string,
): BookingResource {
  const resource: BookingResource = {
    bookingId: stringField(result, "guestBookingId"),
    email,
    mode: "instant",
    resolved: false,
    slug: args.slug,
  };
  args.bookings.push(resource);
  return resource;
}

function commandEnvelope(): { commandId: string; idempotencyKey: string } {
  const commandId = randomUUID();
  return { commandId, idempotencyKey: commandId };
}

function futureDate(offset: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

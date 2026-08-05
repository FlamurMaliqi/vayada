import { expect, test } from "@playwright/test";

const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const endpoint = `https://api.vayada.test/api/hotel-setup/properties/${propertyId}/steps/present-hotel`;
const summary =
  "A welcoming independent hotel with calm rooms, thoughtful service, and an easy walk to local highlights.";

test("browser submits only the complete canonical Step 1 owner contract", async ({ page }) => {
  const calls: Array<{ url: string; method: string; key: string | null; body: unknown }> = [];
  await page.route("https://api.vayada.test/**", async (route) => {
    const request = route.request();
    calls.push({
      url: request.url(),
      method: request.method(),
      key: await request.headerValue("idempotency-key"),
      body: request.postDataJSON(),
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      json: { outcome: "updated", profileRevision: 8 },
    });
  });
  await page.setContent("<main>Hotel Catalog Step 1 API fixture</main>");

  const response = await page.evaluate(
    async ({ url, description }) => {
      const result = await fetch(url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "browser-step1-1",
        },
        body: JSON.stringify({
          expectedProfileRevision: 7,
          locale: "de",
          shortDescription: description,
          amenities: { reviewed: true, keys: [] },
          media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
        }),
      });
      return { status: result.status, body: await result.json() };
    },
    { url: endpoint, description: summary },
  );

  expect(response).toEqual({ status: 200, body: { outcome: "updated", profileRevision: 8 } });
  expect(calls).toEqual([
    {
      url: endpoint,
      method: "PUT",
      key: "browser-step1-1",
      body: {
        expectedProfileRevision: 7,
        locale: "de",
        shortDescription: summary,
        amenities: { reviewed: true, keys: [] },
        media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
      },
    },
  ]);
  expect(calls[0]!.url).not.toContain("/api/marketplace/");
  expect(calls[0]!.url).not.toContain("/public-profile");
});

test("browser can recover from the typed revision conflict without losing input", async ({
  page,
}) => {
  let writes = 0;
  const submittedRevisions: number[] = [];
  await page.route(endpoint, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        json: { profileRevision: 8 },
      });
      return;
    }
    writes += 1;
    submittedRevisions.push(request.postDataJSON().expectedProfileRevision);
    await route.fulfill({
      status: writes === 1 ? 409 : 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      json:
        writes === 1
          ? { code: "profile_revision_conflict", currentRevision: 8 }
          : { outcome: "updated", profileRevision: 9 },
    });
  });
  await page.setContent("<main>Hotel Catalog Step 1 conflict fixture</main>");

  const result = await page.evaluate(
    async ({ url, description }) => {
      const input = {
        expectedProfileRevision: 7,
        locale: "en",
        shortDescription: description,
        amenities: { reviewed: true, keys: ["wifi"] },
        media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
      };
      const save = (key: string) =>
        fetch(url, {
          method: "PUT",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify(input),
        });
      const first = await save("browser-conflict-1");
      if (first.status !== 409) return { input, status: first.status };
      const current = await fetch(url).then((response) => response.json());
      input.expectedProfileRevision = current.profileRevision;
      const retried = await save("browser-conflict-2");
      return { input, status: retried.status, response: await retried.json() };
    },
    { url: endpoint, description: summary },
  );

  expect(submittedRevisions).toEqual([7, 8]);
  expect(result).toMatchObject({
    status: 200,
    input: { shortDescription: summary, amenities: { reviewed: true, keys: ["wifi"] } },
    response: { outcome: "updated", profileRevision: 9 },
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadPlatformMedia, uploadPmsInboxAttachment } from ".";

describe("uploadPlatformMedia", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the canonical public room-media contract from the browser client", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          uploadSession: { sessionId: "00000000-0000-4000-8000-000000000010" },
          uploadTargets: [
            {
              uploadTargetId: "target-1",
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/target-1",
              headers: { "content-type": "image/jpeg" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          mediaObjects: [
            {
              mediaObjectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              status: "public_ready",
              publicVariants: [
                {
                  variantName: "thumbnail",
                  publicUrl: "https://cdn.example.com/room-thumbnail.webp",
                },
              ],
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([1, 2, 3])], "room.jpg", {
      type: "image/jpeg",
    });

    await expect(
      uploadPlatformMedia({
        purpose: "pms.room_type.media",
        visibility: "public",
        resource: {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          propertyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          targetResourceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        },
        files: [file],
      }),
    ).resolves.toEqual([
      {
        mediaId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        url: "https://cdn.example.com/room-thumbnail.webp",
      },
    ]);

    expect(await requestBody(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      purpose: "pms.room_type.media",
      visibility: "public",
      resource: {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        propertyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        targetResourceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.localhost/api/media/upload-sessions/00000000-0000-4000-8000-000000000010/finalize",
    );
  });

  it("prepares a private property-scoped Inbox attachment", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          uploadSession: { sessionId: "session-inbox" },
          uploadTargets: [
            {
              uploadTargetId: "target-inbox",
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/target-inbox",
              headers: { "content-type": "application/pdf" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          mediaObjects: [{ mediaObjectId: "media-inbox" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([1, 2, 3])], "arrival.pdf", {
      type: "application/pdf",
    });

    await expect(
      uploadPmsInboxAttachment({
        propertyId: "property-1",
        threadId: "thread-1",
        file,
      }),
    ).resolves.toEqual({
      mediaId: "media-inbox",
      filename: "arrival.pdf",
      contentType: "application/pdf",
      size: 3,
    });

    expect(await requestBody(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      purpose: "pms.messaging.attachment",
      visibility: "private",
      resource: {
        product: "pms",
        resourceType: "pms_property",
        resourceId: "property-1",
        propertyId: "property-1",
        targetResourceId: "thread-1",
      },
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function requestBody(options: RequestInit | undefined): Promise<unknown> {
  return JSON.parse(String(options?.body));
}

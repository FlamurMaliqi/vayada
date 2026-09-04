import pg, { type QueryResult, type QueryResultRow } from "pg";

export type PmsInboxAttachmentMedia = {
  mediaId: string;
  propertyId: string;
  threadId: string;
  attachmentId: string;
  bucketName: string;
  storageKey: string;
  visibility: "private";
  lifecycleStatus: "active";
  originalFilename?: string;
  contentType?: string;
};

export type PmsInboxAttachmentMediaReadPort = {
  find(
    propertyId: string,
    threadId: string,
    attachmentId: string,
  ): Promise<PmsInboxAttachmentMedia | null>;
  close?(): Promise<void>;
};

export type PmsInboxAttachmentMediaPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end?(): Promise<void>;
};

type MediaRow = Omit<PmsInboxAttachmentMedia, "originalFilename" | "contentType"> & {
  originalFilename: string | null;
  contentType: string | null;
};

export function createPgPmsInboxAttachmentMediaReadPort(config: {
  connectionString: string;
  pool?: PmsInboxAttachmentMediaPool;
  max?: number;
}): PmsInboxAttachmentMediaReadPort {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("PMS Inbox attachment media connectionString must not be empty");
  const ownsPool = !config.pool;
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async find(propertyId, threadId, attachmentId) {
      const result = await pool.query<MediaRow>(
        `SELECT media.id::text AS "mediaId", attachment.property_id::text AS "propertyId",
                message.thread_id::text AS "threadId", attachment.id::text AS "attachmentId",
                media.bucket AS "bucketName", media.storage_key AS "storageKey",
                media.visibility, media.lifecycle_status AS "lifecycleStatus",
                COALESCE(NULLIF(BTRIM(attachment.filename), ''), media.original_filename)
                  AS "originalFilename",
                COALESCE(NULLIF(BTRIM(attachment.content_type), ''), media.content_type)
                  AS "contentType"
         FROM pms.message_attachments attachment
         JOIN pms.messages message
           ON message.id = attachment.message_id AND message.property_id = attachment.property_id
         JOIN pms.message_threads thread
           ON thread.id = message.thread_id AND thread.property_id = message.property_id
         JOIN platform.media_objects media
           ON media.id = attachment.platform_media_object_id
          AND media.property_id = attachment.property_id
          AND media.visibility = 'private' AND media.purpose = 'pms.messaging.attachment'
          AND media.resource_product = 'pms'
          AND ((media.resource_type = 'message_thread'
                AND media.resource_id = message.thread_id::text)
            OR (media.resource_type = 'message_attachment'
                AND media.resource_id = attachment.id::text))
          AND media.lifecycle_status = 'active' AND media.storage_kind = 'vayada_managed'
          AND media.storage_key LIKE 'private/%' AND media.deleted_at IS NULL
         WHERE attachment.property_id = $1::uuid AND message.thread_id = $2::uuid
           AND attachment.id = $3::uuid
         LIMIT 1`,
        [propertyId, threadId, attachmentId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const { originalFilename, contentType, ...media } = row;
      return {
        ...media,
        ...(originalFilename ? { originalFilename } : {}),
        ...(contentType ? { contentType } : {}),
      };
    },

    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

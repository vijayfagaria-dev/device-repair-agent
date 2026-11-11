// Server-generated ids (protocol.md §1.1): random base64url, 96 bits.
import { randomBytes } from "node:crypto";

/** A chat message id (wire id `m_<id>`); chat_messages.id is unique across all sessions. */
export const newMessageId = (): string => randomBytes(12).toString("base64url");

/** A stored file id (`file:<id>` refs and `/files/<id>` links). */
export const newFileId = (): string => `f${randomBytes(12).toString("base64url")}`;

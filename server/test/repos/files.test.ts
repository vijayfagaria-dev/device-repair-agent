import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFile, getFileBytes, insertFile, listFiles } from "../../src/db/repos/files.js";
import { withTx } from "../../src/db/tx.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { seedSession } from "../helpers/seed.js";

let schema: TestSchema;
let pool: pg.Pool;

beforeAll(async () => {
  let db: { pool: pg.Pool };
  ({ schema, db } = await createMigratedSchema("rfile"));
  pool = db.pool;
});
afterAll(async () => {
  await schema.drop();
});

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from([0, 1, 2, 255, 254])]);

describe("files repo", () => {
  it("insertFile stores metadata and bytes together; size and SHA-256 come from the bytes", async () => {
    const id = await seedSession(pool);
    const file = await withTx(pool, (tx) =>
      insertFile(tx, { id: "f_1", sessionId: id, mime: "application/pdf", bytes: PDF, originalName: "invoice.pdf", checkResult: { pages: 1 } }),
    );
    expect(file).toMatchObject({
      id: "f_1",
      sessionId: id,
      mime: "application/pdf",
      size: PDF.length,
      sha256: createHash("sha256").update(PDF).digest("hex"),
      originalName: "invoice.pdf",
      checkResult: { pages: 1 },
    });
    expect(file.createdAt).toBeInstanceOf(Date);
    const bare = await withTx(pool, (tx) => insertFile(tx, { id: "f_2", sessionId: id, mime: "image/png", bytes: Buffer.from([137, 80, 78, 71]) }));
    expect(bare).toMatchObject({ originalName: null, checkResult: null, size: 4 });
  });

  it("insertFile writes nothing if the transaction fails (no metadata without bytes)", async () => {
    const id = await seedSession(pool);
    await expect(
      withTx(pool, async (tx) => {
        await insertFile(tx, { id: "f_rolled_back", sessionId: id, mime: "image/jpeg", bytes: Buffer.from([255, 216, 255]) });
        throw new Error("later step failed");
      }),
    ).rejects.toThrow("later step failed");
    expect(await getFile(pool, "f_rolled_back")).toBeNull();
    expect(await getFileBytes(pool, "f_rolled_back")).toBeNull();
    // A type outside the allow-list is refused by the database too.
    await expect(withTx(pool, (tx) => insertFile(tx, { id: "f_exe", sessionId: id, mime: "application/x-msdownload" as never, bytes: PDF }))).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("getFile returns metadata only; getFileBytes returns the exact bytes", async () => {
    const id = await seedSession(pool);
    await withTx(pool, (tx) => insertFile(tx, { id: "f_get", sessionId: id, mime: "application/pdf", bytes: PDF }));
    const meta = await getFile(pool, "f_get");
    expect(meta?.size).toBe(PDF.length);
    expect(meta).not.toHaveProperty("bytes");
    const bytes = await getFileBytes(pool, "f_get");
    expect(bytes?.equals(PDF)).toBe(true);
    expect(await getFile(pool, "f_none")).toBeNull();
    expect(await getFileBytes(pool, "f_none")).toBeNull();
  });

  it("listFiles returns the session's files, oldest first", async () => {
    const id = await seedSession(pool);
    for (const n of [1, 2, 3]) {
      await withTx(pool, (tx) => insertFile(tx, { id: `f_list_${n}`, sessionId: id, mime: "image/webp", bytes: Buffer.from([n]) }));
    }
    expect((await listFiles(pool, id)).map((f) => f.id)).toEqual(["f_list_1", "f_list_2", "f_list_3"]);
    expect(await listFiles(pool, await seedSession(pool))).toEqual([]);
  });
});

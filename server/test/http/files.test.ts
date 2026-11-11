// Uploads and signed downloads (P4-T03) over HTTP against the throwaway test Postgres: a valid PDF round-trips with
// the same SHA-256 and its ref is accepted by a card; a renamed .exe → 415; 25 MB → 413 with no rows; over budget →
// 507; a tampered signature → 403; an expired link → 410; plus the per-session cap and the error shape.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/pool.js";
import { listFiles } from "../../src/db/repos/files.js";
import { attachmentHeader } from "../../src/http/files.js";
import type { SessionServices } from "../../src/session/services.js";
import { type RunningApp, startApp } from "../helpers/app.js";
import { answer, EXE, openCard, PDF, PNG, sessionAtField } from "../helpers/chatFlow.js";
import { createMigratedSchema, type TestSchema } from "../helpers/db.js";
import { TEST_FILE_URL_SECRET, TEST_SIGNER, testServices } from "../helpers/session.js";

let schema: TestSchema;
let db: Database;
let services: SessionServices;
let server: RunningApp;

beforeAll(async () => {
  ({ schema, db } = await createMigratedSchema("files", { max: 10 }));
  services = testServices(db, { planner: true });
  // A generous upload limit here: this file uploads far more than a person would; the limit has its own test below.
  server = await startApp(db, { services, fileUrlSecret: TEST_FILE_URL_SECRET, uploadBudgetBytes: 20 * 1024 * 1024, uploadsPerMinute: 1000 });
});
afterAll(async () => {
  await server.close();
  await schema.drop();
});

async function upload(sessionId: string, bytes: Buffer, name = "invoice.pdf", type = "application/pdf", base = server.http): Promise<Response> {
  const body = new FormData();
  body.append("file", new Blob([bytes], { type }), name);
  return fetch(`${base}/sessions/${sessionId}/files`, { method: "POST", body });
}
const sha256 = (bytes: Buffer | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fileRows = async () => (await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM files")).rows[0]?.n ?? 0;
const blobRows = async () => (await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM file_blobs")).rows[0]?.n ?? 0;
/** A signed link the test app accepts (the test signer uses https://repair.example.com as its origin). */
const linkFor = (fileId: string, now = new Date()) => {
  const url = new URL(TEST_SIGNER.sign(fileId, now));
  return `${server.http}${url.pathname}${url.search}`;
};

describe("POST /sessions/:id/files", () => {
  it("stores a valid PDF (lazily creating the session) and answers with an opaque file: ref; the bytes round-trip with the same SHA-256", async () => {
    const id = randomUUID();
    const response = await upload(id, PDF);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { url } = (await response.json()) as { url: string };
    expect(url).toMatch(/^file:f[A-Za-z0-9_-]{16}$/);
    const fileId = url.slice("file:".length);
    const [stored] = await listFiles(db.pool, id);
    expect(stored).toMatchObject({ id: fileId, sessionId: id, mime: "application/pdf", size: PDF.length, sha256: sha256(PDF), originalName: "invoice.pdf" });

    const download = await fetch(linkFor(fileId));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("content-disposition")).toBe(`attachment; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(sha256(new Uint8Array(await download.arrayBuffer()))).toBe(sha256(PDF));
  });

  it("the ref is accepted by the session's invoice card (P4-T02)", async () => {
    const id = await sessionAtField(db, services, "purchaseInvoice");
    const { url } = (await (await upload(id, PDF)).json()) as { url: string };
    const open = await openCard(db, id);
    expect(await answer(services, id, open?.id ?? "", "purchaseInvoice", url)).toEqual({ status: "accepted" });
  });

  it("refuses a renamed .exe (415), a HEIC photo (415) and a type that disagrees with the bytes (415), writing nothing", async () => {
    const id = randomUUID();
    const before = await fileRows();
    for (const [bytes, name, type] of [
      [EXE, "invoice.pdf", "application/pdf"],
      [Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(16)]), "photo.heic", "image/heic"],
      [PNG, "invoice.pdf", "application/pdf"],
    ] as const) {
      const response = await upload(id, bytes, name, type);
      expect(response.status).toBe(415);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("unsupported_type");
      expect(body.error.message.length).toBeGreaterThan(0);
    }
    expect(await fileRows()).toBe(before);
  });

  it("refuses 25 MB with 413 and writes no rows", async () => {
    const id = randomUUID();
    const files = await fileRows();
    const blobs = await blobRows();
    const response = await upload(id, Buffer.concat([PDF, Buffer.alloc(25 * 1024 * 1024)]));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "too_large", message: "That file is larger than 10 MB." } });
    expect(await fileRows()).toBe(files);
    expect(await blobRows()).toBe(blobs);
  });

  it("an empty file is a 400; a request without a file part is a 400; a malformed session id is a 400", async () => {
    expect((await upload(randomUUID(), Buffer.alloc(0))).status).toBe(400);
    const body = new FormData();
    body.append("other", "x");
    expect((await fetch(`${server.http}/sessions/${randomUUID()}/files`, { method: "POST", body })).status).toBe(400);
    expect((await fetch(`${server.http}/sessions/${randomUUID()}/files`, { method: "POST", body: "plain" })).status).toBe(400);
    const bad = await upload("not-a-uuid", PDF);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("bad_request");
  });

  it("caps a session at 12 files (413)", async () => {
    const id = randomUUID();
    for (let i = 0; i < 12; i++) expect((await upload(id, PNG, `p${i}.png`, "image/png")).status).toBe(200);
    const thirteenth = await upload(id, PNG, "p12.png", "image/png");
    expect(thirteenth.status).toBe(413);
    expect(((await thirteenth.json()) as { error: { code: string } }).error.code).toBe("too_large");
    expect(await listFiles(db.pool, id)).toHaveLength(12);
  });

  it("refuses uploads over the global budget with 507, writing nothing", async () => {
    const small = await startApp(db, { services, fileUrlSecret: TEST_FILE_URL_SECRET, uploadBudgetBytes: 1 });
    try {
      const before = await fileRows();
      const response = await upload(randomUUID(), PDF, "invoice.pdf", "application/pdf", small.http);
      expect(response.status).toBe(507);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("storage_budget");
      expect(await fileRows()).toBe(before);
    } finally {
      await small.close();
    }
  });

  it("refuses a closed session (410) and more uploads at once than the instance allows (429)", async () => {
    const id = randomUUID();
    expect((await upload(id, PDF)).status).toBe(200);
    await db.pool.query("UPDATE sessions SET status = 'closed' WHERE id = $1", [id]);
    const closed = await upload(id, PDF);
    expect(closed.status).toBe(410);
    expect(((await closed.json()) as { error: { code: string } }).error.code).toBe("session_closed");

    const busy = await startApp(db, { services, fileUrlSecret: TEST_FILE_URL_SECRET, maxConcurrentUploads: 0 });
    try {
      const response = await upload(randomUUID(), PDF, "invoice.pdf", "application/pdf", busy.http);
      expect(response.status).toBe(429);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    } finally {
      await busy.close();
    }
  });

  it("rate-limits uploads and downloads per client IP, separately (429 in the protocol's error shape)", async () => {
    const limited = await startApp(db, { services, fileUrlSecret: TEST_FILE_URL_SECRET, uploadsPerMinute: 1, downloadsPerMinute: 2 });
    try {
      const id = randomUUID();
      const first = await upload(id, PDF, "invoice.pdf", "application/pdf", limited.http);
      expect(first.status).toBe(200);
      const second = await upload(id, PDF, "invoice.pdf", "application/pdf", limited.http);
      expect(second.status).toBe(429);
      expect(((await second.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
      // Downloads still work after uploads ran out; they have their own budget.
      const fileId = ((await first.json()) as { url: string }).url.slice("file:".length);
      const link = (base: string) => `${base}${new URL(TEST_SIGNER.sign(fileId, new Date())).pathname}${new URL(TEST_SIGNER.sign(fileId, new Date())).search}`;
      expect((await fetch(link(limited.http))).status).toBe(200);
      expect((await fetch(link(limited.http))).status).toBe(200);
      expect((await fetch(link(limited.http))).status).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe("GET /files/:id (signed links)", () => {
  let fileId: string;
  beforeAll(async () => {
    const { url } = (await (await upload(randomUUID(), PDF)).json()) as { url: string };
    fileId = url.slice("file:".length);
  });

  it("a tampered signature, expiry or file id → 403", async () => {
    const good = new URL(linkFor(fileId));
    const sig = good.searchParams.get("sig") ?? "";
    const tamperedSig = new URL(good);
    tamperedSig.searchParams.set("sig", `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`);
    const tamperedExp = new URL(good);
    tamperedExp.searchParams.set("exp", String(Number(good.searchParams.get("exp")) + 1));
    const otherFile = new URL(good);
    otherFile.pathname = "/files/fSomeOtherFile0000";
    for (const url of [tamperedSig, tamperedExp, otherFile, new URL(`${server.http}/files/${fileId}`)]) {
      const response = await fetch(url);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    }
  });

  it("an expired link → 410", async () => {
    const response = await fetch(linkFor(fileId, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)));
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("expired");
  });

  it("a validly signed link to a file that doesn't exist → 404", async () => {
    expect((await fetch(linkFor("fNoSuchFile0000000"))).status).toBe(404);
  });
});

describe("Content-Disposition", () => {
  it("can't be broken out of by a file name: quotes, backslashes and non-ASCII are replaced in the fallback", () => {
    expect(attachmentHeader('a"b\\c\r\nd.pdf', "fX")).toBe(`attachment; filename="a_b_c__d.pdf"; filename*=UTF-8''a%22b%5Cc%0D%0Ad.pdf`);
    expect(attachmentHeader("रसीद.pdf", "fX")).toBe(`attachment; filename="____.pdf"; filename*=UTF-8''${encodeURIComponent("रसीद.pdf")}`);
    expect(attachmentHeader(null, "fAbc")).toBe(`attachment; filename="fAbc"; filename*=UTF-8''fAbc`);
  });
});

describe("abuse limits (P4 review #3, #4)", () => {
  it("ByteQuota: bytes per key per window, returned bytes count again, and the window resets", async () => {
    const { ByteQuota } = await import("../../src/http/files.js");
    let now = 0;
    const quota = new ByteQuota(100, 1000, () => now);
    expect(quota.tryUse("a", 60)).toBe(true);
    expect(quota.tryUse("a", 50)).toBe(false);
    expect(quota.tryUse("b", 100)).toBe(true);
    quota.giveBack("a", 60);
    expect(quota.tryUse("a", 100)).toBe(true);
    now = 1000;
    expect(quota.tryUse("a", 100)).toBe(true);
  });

  it("one client IP can't store more than its hourly byte quota (429), writing nothing", async () => {
    const limited = await startApp(db, { services, fileUrlSecret: TEST_FILE_URL_SECRET, uploadsPerMinute: 1000, uploadBytesPerIpPerHour: PDF.length * 2 });
    try {
      const id = randomUUID();
      expect((await upload(id, PDF, "a.pdf", "application/pdf", limited.http)).status).toBe(200);
      expect((await upload(id, PDF, "b.pdf", "application/pdf", limited.http)).status).toBe(200);
      const before = await fileRows();
      const third = await upload(id, PDF, "c.pdf", "application/pdf", limited.http);
      expect(third.status).toBe(429);
      expect(((await third.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
      expect(await fileRows()).toBe(before);
    } finally {
      await limited.close();
    }
  });

  it("a sender that trickles its body is dropped at the deadline and frees its slot", async () => {
    const { request } = await import("node:http");
    const slow = await startApp(db, { services, fileUrlSecret: TEST_FILE_URL_SECRET, uploadsPerMinute: 1000, uploadDeadlineMs: 300, maxConcurrentUploads: 1 });
    try {
      const url = new URL(`${slow.http}/sessions/${randomUUID()}/files`);
      const boundary = "----slowboundary";
      const closed = new Promise<string>((resolve) => {
        const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": "100000" } });
        req.on("response", (res) => resolve(`status ${res.statusCode}`));
        req.on("error", () => resolve("dropped"));
        req.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-`);
        // ...and never sends the rest.
      });
      expect(await closed).toMatch(/dropped|status 408/);
      // The slot is free again: a normal upload goes through.
      expect((await upload(randomUUID(), PDF, "invoice.pdf", "application/pdf", slow.http)).status).toBe(200);
    } finally {
      await slow.close();
    }
  });
});

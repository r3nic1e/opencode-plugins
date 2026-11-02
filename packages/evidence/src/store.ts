import { createHash, randomUUID } from "node:crypto";
import type { Plugin } from "@opencode/plugin";

export type Snapshot = {
  text: string;
  bytes: number;
  sha256: string;
  truncated: boolean;
  redacted: boolean;
};

export type Evidence = {
  version: 1;
  uuid: string;
  ref: string;
  sessionID: string;
  messageID: string;
  callID: string;
  tool: string;
  directory: string;
  parent?: string;
  captured: string;
  finished?: string;
  status: "started" | "completed" | "error";
  input: Snapshot;
  result?: Snapshot;
};

export type Summary = Omit<Evidence, "input" | "result"> & { preview: string; resultPreview?: string };
export type Page = { items: Summary[]; next?: string };
type Call = { sessionID: string; messageID: string; id: string };
type Storage = Plugin.Context["storage"];

const queues = new Map<string, Promise<unknown>>();
const sensitiveKey = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret)$/i;

export function snapshot(value: unknown, maxBytes: number): Snapshot {
  let redacted = false;
  const text = JSON.stringify(value, (key, value) => {
    if (sensitiveKey.test(key)) {
      redacted = true;
      return "[REDACTED]";
    }
    if (value instanceof Error) return { ...value, name: value.name, message: value.message };
    if (typeof value === "bigint") return { bigint: String(value) };
    if (typeof value !== "string") return value;
    return value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, () => {
      redacted = true;
      return "Bearer [REDACTED]";
    });
  }, 2) ?? "null";
  const bytes = Buffer.from(text);
  return {
    text: bytes.length > maxBytes ? new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true }) : text,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    truncated: bytes.length > maxBytes,
    redacted,
  };
}

export function normalizeRef(value: string): string | undefined {
  const match = /^(?:E([1-9]\d*)|\[E([1-9]\d*)\])$/.exec(value.trim());
  if (!match) return;
  const number = Number(match[1] ?? match[2]);
  if (Number.isSafeInteger(number)) return `E${number}`;
}

function prefix(sessionID: string) {
  return `v1/sessions/${encodeURIComponent(sessionID)}/`;
}

function recordKey(sessionID: string, ref: string) {
  return `${prefix(sessionID)}records/${ref.slice(1).padStart(16, "0")}`;
}

export function summarize(record: Evidence): Summary {
  const { input, result, ...summary } = record;
  return {
    ...summary,
    preview: input.text.replace(/\s+/g, " ").slice(0, 220),
    ...(result ? { resultPreview: result.text.replace(/\s+/g, " ").slice(0, 220) } : {}),
  };
}

export class EvidenceStore {
  private storage: Storage;
  private maxBytes: number;

  constructor(storage: Storage, maxBytes = 262_144) {
    this.storage = storage;
    this.maxBytes = maxBytes;
  }

  async start(tool: string, input: unknown, call: Call, directory: string, parent?: string): Promise<Evidence> {
    const key = `${prefix(call.sessionID)}counter`;
    const previous = queues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const count = await this.storage.get(key);
      if (count !== undefined && (!Number.isSafeInteger(count) || Number(count) < 0)) throw new Error("Invalid evidence counter");
      const next = Number(count ?? 0) + 1;
      if (!Number.isSafeInteger(next)) throw new Error("Evidence counter exhausted");
      const record: Evidence = {
        version: 1,
        uuid: randomUUID(),
        ref: `E${next}`,
        sessionID: call.sessionID,
        messageID: call.messageID,
        callID: call.id,
        tool,
        directory,
        ...(parent ? { parent } : {}),
        captured: new Date().toISOString(),
        status: "started",
        input: snapshot(input, this.maxBytes),
      };
      await this.storage.set(key, next);
      await this.storage.set(recordKey(call.sessionID, record.ref), record);
      await this.storage.set(`${prefix(call.sessionID)}uuids/${record.uuid}`, record.ref);
      return record;
    });
    queues.set(key, operation);
    try {
      return await operation;
    } finally {
      if (queues.get(key) === operation) queues.delete(key);
    }
  }

  async finish(record: Evidence, status: "completed" | "error", result: unknown): Promise<Evidence> {
    const completed: Evidence = {
      ...record,
      status,
      finished: new Date().toISOString(),
      result: snapshot(result, this.maxBytes),
    };
    await this.storage.set(recordKey(record.sessionID, record.ref), completed);
    return completed;
  }

  async get(sessionID: string, reference: string): Promise<Evidence | null> {
    let ref = normalizeRef(reference);
    if (!ref && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(reference)) {
      const stored = await this.storage.get(`${prefix(sessionID)}uuids/${reference.toLowerCase()}`);
      if (typeof stored === "string") ref = normalizeRef(stored);
    }
    if (!ref) return null;
    return (await this.storage.get(recordKey(sessionID, ref)) as Evidence | undefined) ?? null;
  }

  async list(sessionID: string, after?: string): Promise<Page> {
    const base = `${prefix(sessionID)}records/`;
    if (after !== undefined && (!after.startsWith(base) || !/^\d{16}$/.test(after.slice(base.length)))) {
      throw new Error("Invalid evidence cursor for this session");
    }
    const page = await this.storage.scan({ prefix: base, ...(after ? { after } : {}), limit: 100 });
    return {
      items: page.entries.map(({ value }) => summarize(value as Evidence)),
      ...(page.next ? { next: page.next } : {}),
    };
  }

  async recent(sessionID: string): Promise<Summary[]> {
    const count = Number(await this.storage.get(`${prefix(sessionID)}counter`) ?? 0);
    const records = await Promise.all(Array.from({ length: Math.min(count, 30) }, (_, i) =>
      this.get(sessionID, `E${Math.max(1, count - 29) + i}`)));
    return records.filter((record): record is Evidence => record !== null).map(summarize);
  }

  async check(sessionID: string, references: string[]): Promise<{ valid: string[]; broken: string[] }> {
    const valid: string[] = [];
    const broken: string[] = [];
    for (const reference of new Set(references)) {
      (await this.get(sessionID, reference) ? valid : broken).push(reference);
    }
    return { valid, broken };
  }
}

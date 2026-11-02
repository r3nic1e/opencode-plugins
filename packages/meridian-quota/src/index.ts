import http from "node:http";

import type { Plugin } from "@opencode/plugin";

/**
 * Bridge that exposes Meridian's Anthropic quota to @slkiser/opencode-quota.
 *
 * opencode-quota cannot read Meridian directly for two reasons:
 *
 * 1. Custom provider URLs must be HTTPS or loopback HTTP (quota-providers.js
 *    rejects anything else), and `host.docker.internal` is neither. Of the
 *    loopback spellings, only `127.0.0.1` is in NO_PROXY, so `[::1]` and
 *    `*.localhost` get sent to the sandbox proxy and refused.
 * 2. The `json-v1` adapter cannot index arrays, so it cannot read the
 *    per-window `buckets[]` array, and its `rowsPath` mode gives every row the
 *    same static name.
 *
 * So this plugin listens on 127.0.0.1 and re-serves Meridian's payload in the
 * native `quota-v1` format, which lets us name each window and attach reset
 * times explicitly.
 */

export type BridgeConfig = { upstream: string; port: number };

export function resolveConfig(options: unknown, env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const raw = isRecord(options) ? options : {};
  const upstream =
    (typeof raw["upstream"] === "string" && raw["upstream"].trim()) ||
    env["MERIDIAN_QUOTA_URL"]?.trim() ||
    "http://host.docker.internal:3456/v1/usage/quota";
  const port = Number(raw["port"] ?? (env["MERIDIAN_QUOTA_BRIDGE_PORT"]?.trim() || 39456));
  return { upstream, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 39456 };
}

const BRIDGE_PATH = "/quota";
const UPSTREAM_TIMEOUT_MS = 8_000;

/**
 * Rate-limit windows to surface, in display order.
 *
 * quota-v1 entries may only carry the keys parseQuotaV1 allows (kind, name,
 * resultType, percentRemaining, value, label, right, resetTimeIso,
 * observedAtIso). There is no sortPriority, so emission order is the order.
 */
const WINDOWS: ReadonlyArray<{
  type: string;
  name: string;
  resultType: "rate_limit" | "quota";
}> = [
  { type: "five_hour", name: "5h", resultType: "rate_limit" },
  { type: "seven_day", name: "Weekly", resultType: "quota" },
  { type: "seven_day_fable", name: "Weekly Fable", resultType: "quota" },
];

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Convert a unix-millisecond timestamp into the ISO form quota-v1 requires. */
function isoFromMillis(value: unknown): string | undefined {
  const millis = asFiniteNumber(value);
  if (millis === null || millis <= 0) return undefined;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

/** Meridian reports utilization as a 0..1 fraction; quota-v1 wants percent remaining. */
function percentRemainingFrom(utilization: number): number {
  return Math.round((1 - utilization) * 1000) / 10;
}

function statusText(status: string): string {
  return status.replace(/_/g, " ");
}

/**
 * Meridian merges two upstream sources: an OAuth source that carries the weekly
 * buckets, real utilization numbers and extraUsage, and an SDK source that only
 * carries `overage` and `five_hour`. When the OAuth source drops out the payload
 * degrades to `utilization: null` and `extraUsage: null`, so every field here is
 * treated as optional and we fall back rather than failing.
 */
export function buildEntries(payload: Json): unknown[] {
  const entries: unknown[] = [];
  const asOfIso = isoFromMillis(payload["asOf"]);
  const buckets = Array.isArray(payload["buckets"]) ? payload["buckets"] : [];

  const byType = new Map<string, Json>();
  for (const bucket of buckets) {
    if (isRecord(bucket) && typeof bucket["type"] === "string") {
      byType.set(bucket["type"], bucket);
    }
  }

  const observedFor = (bucket: Json): string | undefined =>
    isoFromMillis(bucket["observedAt"]) ?? asOfIso;

  const resetFor = (bucket: Json): string | undefined =>
    isoFromMillis(bucket["resetsAt"]) ?? isoFromMillis(bucket["overageResetsAt"]);

  let windowMissing = false;

  for (const window of WINDOWS) {
    const bucket = byType.get(window.type);
    if (!bucket) {
      windowMissing = true;
      continue;
    }

    const utilization = asFiniteNumber(bucket["utilization"]);
    const status = typeof bucket["status"] === "string" ? bucket["status"] : null;
    const resetTimeIso = resetFor(bucket);
    const observedAtIso = observedFor(bucket);

    if (utilization !== null) {
      entries.push({
        kind: "percent",
        name: window.name,
        label: window.name,
        resultType: window.resultType,
        percentRemaining: percentRemainingFrom(utilization),
        // Surface the status only when it is not the boring case, so a blocked
        // window is visible even while utilization still reads 0.
        ...(status && status !== "allowed" ? { right: statusText(status) } : {}),
        ...(resetTimeIso ? { resetTimeIso } : {}),
        ...(observedAtIso ? { observedAtIso } : {}),
      });
      continue;
    }

    if (status) {
      // No utilization number, but the window still has a state worth showing:
      // `five_hour` can read "rejected" while utilization is null.
      entries.push({
        kind: "value",
        name: window.name,
        label: window.name,
        resultType: "status",
        value: statusText(status),
        ...(resetTimeIso ? { resetTimeIso } : {}),
        ...(observedAtIso ? { observedAtIso } : {}),
      });
      continue;
    }

    windowMissing = true;
  }

  const extraUsage = payload["extraUsage"];
  let monthlyReported = false;

  if (isRecord(extraUsage) && extraUsage["isEnabled"] !== false) {
    const used = asFiniteNumber(extraUsage["usedCredits"]);
    const limit = asFiniteNumber(extraUsage["monthlyLimit"]);
    const currency =
      typeof extraUsage["currency"] === "string" && extraUsage["currency"].length === 3
        ? extraUsage["currency"]
        : "USD";

    if (used !== null && limit !== null && limit > 0) {
      const percentUsed = Math.round((used / limit) * 1000) / 10;
      entries.push({
        kind: "value",
        name: "Extra usage",
        label: "Extra",
        resultType: "spend",
        value: `${formatMoney(used / 100, currency)} / ${formatMoney(limit / 100, currency)} (${percentUsed}%)`,
        ...(asOfIso ? { observedAtIso: asOfIso } : {}),
      });
      monthlyReported = true;
    }
  }

  // The `overage` bucket tracks the same monthly budget as extraUsage, so it is
  // redundant while extraUsage is present but is the only monthly signal left
  // once the OAuth source drops out.
  if (!monthlyReported) {
    const overage = byType.get("overage");
    const utilization = overage ? asFiniteNumber(overage["utilization"]) : null;

    if (overage && utilization !== null) {
      const status = typeof overage["status"] === "string" ? overage["status"] : null;
      const resetTimeIso = resetFor(overage);
      const observedAtIso = observedFor(overage);

      entries.push({
        kind: "percent",
        name: "Month",
        label: "Month",
        resultType: "budget",
        percentRemaining: percentRemainingFrom(utilization),
        ...(status && status !== "allowed" ? { right: statusText(status) } : {}),
        ...(resetTimeIso ? { resetTimeIso } : {}),
        ...(observedAtIso ? { observedAtIso } : {}),
      });
    }
  }

  // Without this the weekly windows would just silently disappear, with nothing
  // to say why.
  const sources = payload["sources"];
  const oauthMissing = isRecord(sources) ? !isRecord(sources["oauth"]) : true;
  if (oauthMissing && windowMissing) {
    entries.push({
      kind: "value",
      name: "Source",
      label: "Source",
      resultType: "status",
      value: "sdk only - oauth source unavailable",
      ...(asOfIso ? { observedAtIso: asOfIso } : {}),
    });
  }

  return entries;
}

async function fetchUpstream(upstream: string): Promise<Json> {
  const response = await fetch(upstream, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`upstream returned HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error("upstream returned a non-object payload");
  }
  return payload;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

async function handle(upstream: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = (req.url ?? "").split("?", 1)[0];
  if (req.method !== "GET" || path !== BRIDGE_PATH) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  try {
    const entries = buildEntries(await fetchUpstream(upstream));
    if (entries.length === 0) {
      // quota-v1 requires at least one entry, so report the failure instead of
      // serving an empty document the plugin would reject as malformed.
      sendJson(res, 502, { error: "no usable quota buckets in upstream payload" });
      return;
    }
    sendJson(res, 200, { version: "quota-v1", entries });
  } catch (error) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * opencode may instantiate a plugin more than once per process, so keep one
 * listener per port at module level and treat EADDRINUSE as "already serving".
 */
const started = new Map<number, Promise<void>>();

export function startBridge(config: BridgeConfig): Promise<void> {
  let ready = started.get(config.port);
  if (!ready) {
    ready = new Promise<void>((resolve) => {
      const server = http.createServer((req, res) => {
        void handle(config.upstream, req, res);
      });

      server.on("error", () => resolve());
      server.listen(config.port, "127.0.0.1", () => {
        // Do not hold the event loop open on shutdown.
        server.unref();
        resolve();
      });
    });
    started.set(config.port, ready);
  }
  return ready;
}

const MeridianQuotaBridge: Plugin.Plugin = {
  id: "meridian-quota-bridge",
  async setup(ctx) {
    await startBridge(resolveConfig(ctx.options));
  },
};

export default MeridianQuotaBridge;

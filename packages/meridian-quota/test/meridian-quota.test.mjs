import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Plugin, { buildEntries, resolveConfig } from "../src/index.ts";

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("options take precedence over the environment, which takes precedence over defaults", () => {
  const env = { MERIDIAN_QUOTA_URL: "http://env.example:1/q", MERIDIAN_QUOTA_BRIDGE_PORT: "40001" };
  assert.deepEqual(resolveConfig({}, {}), { upstream: "http://host.docker.internal:3456/v1/usage/quota", port: 39456 });
  assert.deepEqual(resolveConfig(undefined, env), { upstream: "http://env.example:1/q", port: 40001 });
  assert.deepEqual(resolveConfig({ upstream: "http://opt.example:2/q", port: 40002 }, env), { upstream: "http://opt.example:2/q", port: 40002 });
  assert.equal(resolveConfig({ port: "not a port" }, {}).port, 39456);
});

test("converts Meridian buckets into named quota-v1 entries", () => {
  const entries = buildEntries({
    asOf: 1_700_000_000_000,
    sources: { oauth: {} },
    buckets: [
      { type: "five_hour", utilization: 0.25, status: "allowed", resetsAt: 1_700_000_360_000 },
      { type: "seven_day", utilization: 0.5, status: "allowed_warning" },
      { type: "seven_day_fable", utilization: null, status: "rejected" },
    ],
    extraUsage: { isEnabled: true, usedCredits: 1250, monthlyLimit: 5000, currency: "USD" },
  });
  assert.deepEqual(entries.map((entry) => [entry.name, entry.kind]), [
    ["5h", "percent"],
    ["Weekly", "percent"],
    ["Weekly Fable", "value"],
    ["Extra usage", "value"],
  ]);
  assert.equal(entries[0].percentRemaining, 75);
  assert.equal(entries[0].resetTimeIso, new Date(1_700_000_360_000).toISOString());
  assert.equal(entries[1].right, "allowed warning");
  assert.equal(entries[2].value, "rejected");
  assert.equal(entries[3].value, "$12.5 / $50 (25%)");
});

test("reports a missing OAuth source instead of silently dropping weekly windows", () => {
  const entries = buildEntries({ buckets: [{ type: "five_hour", utilization: 0.1 }, { type: "overage", utilization: 0.2 }] });
  assert.deepEqual(entries.map((entry) => entry.name), ["5h", "Month", "Source"]);
});

test("setup serves the upstream quota on the configured port", async (t) => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sources: { oauth: {} }, buckets: [{ type: "five_hour", utilization: 0.4 }] }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const port = await freePort();
  await Plugin.setup({ options: { upstream: `http://127.0.0.1:${upstreamPort}/quota`, port } });

  const ok = await fetch(`http://127.0.0.1:${port}/quota`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.version, "quota-v1");
  assert.equal(body.entries[0].name, "5h");
  assert.equal(body.entries[0].percentRemaining, 60);

  assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
});

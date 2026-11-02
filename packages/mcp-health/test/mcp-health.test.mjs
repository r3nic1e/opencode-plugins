import test from "node:test";
import assert from "node:assert/strict";
import Plugin, { createHealth } from "../src/index.ts";

const connected = (name) => ({ name, status: { status: "connected" } });
const failed = (name, error) => ({ name, status: { status: "failed", error } });
const local = (name, path) => ({ name, path, source: { type: "local", path } });

async function noteFor({ servers = [], references = [], options }) {
  const hooks = {};
  await Plugin.setup({
    options,
    mcp: { list: async () => ({ location: {}, data: servers }) },
    reference: { list: async () => ({ location: {}, data: references }) },
    session: { hook: async (name, handler) => { hooks[name] = handler; } },
  });
  const event = { system: [] };
  await hooks.context(event);
  return event.system.map((part) => part.text).join("\n");
}

test("reports a failed MCP server as down, not missing", async () => {
  const note = await noteFor({ servers: [connected("github"), failed("kubernetes", "Request timed out")] });
  assert.match(note, /`kubernetes` is configured but failed: Request timed out/);
  assert.match(note, /Do not say that it does not exist/);
  assert.match(note, /`\/mcps` or `\/reload`/);
  assert.doesNotMatch(note, /`github`/);
});

test("adds nothing when every server is healthy or expected down", async () => {
  const note = await noteFor({
    options: { expectedDown: ["demo_browser"] },
    servers: [
      connected("github"),
      { name: "notion", status: { status: "disabled" } },
      failed("demo_browser", "dial tcp4 127.0.0.1:13106: connect: connection refused"),
    ],
  });
  assert.equal(note, "");
});

test("asks for sign-in when a server needs auth", async () => {
  const note = await noteFor({ servers: [{ name: "slack", status: { status: "needs_auth", error: "Unauthorized" } }] });
  assert.match(note, /`slack` needs sign-in/);
  assert.match(note, /sign in through `\/mcps`/);
  assert.doesNotMatch(note, /restart MCP servers/);
});

test("reports a local reference whose path is missing", async () => {
  const missing = `/nonexistent-${process.pid}/Obsidian`;
  const note = await noteFor({
    references: [
      local("Obsidian", missing),
      local("tmp", "/tmp"),
      { name: "standards", path: "/nonexistent/cache", source: { type: "git", repository: "https://example.com/x" } },
    ],
  });
  assert.match(note, new RegExp(`\`Obsidian\` points to \`${missing}\``));
  assert.match(note, /Do not create or write to a missing reference path/);
  assert.doesNotMatch(note, /`tmp`|`standards`/);
});

test("rechecks status after the cache expires", async () => {
  let clock = 0;
  let calls = 0;
  let servers = [failed("kubernetes", "Request timed out")];
  const health = createHealth({
    servers: async () => { calls++; return { data: servers }; },
    references: async () => ({ data: [] }),
    now: () => clock,
  });

  assert.match(await health.note(), /kubernetes/);
  servers = [connected("kubernetes")];
  clock = 14_000;
  assert.match(await health.note(), /kubernetes/, "within the cache window");
  assert.equal(calls, 1);
  clock = 16_000;
  assert.equal(await health.note(), undefined);
  assert.equal(calls, 2);
});

test("a hanging or failing list does not block the model call", async () => {
  const hanging = createHealth({
    servers: () => new Promise(() => {}),
    references: async () => { throw new Error("boom"); },
    timeoutMs: 20,
  });
  assert.equal(await hanging.note(), undefined);
});

test("reports a server that is not listed in expectedDown", async () => {
  const note = await noteFor({ servers: [failed("demo_browser", "connection refused")] });
  assert.match(note, /`demo_browser` is configured but failed/);
});

test("advice options replace the default instructions", async () => {
  const options = {
    advice: { down: "Check the host stack.", auth: "Run the login helper.", missing: "Restore the mount." },
  };
  const note = await noteFor({
    options,
    servers: [failed("kubernetes", "timeout"), { name: "slack", status: { status: "needs_auth" } }],
    references: [local("docs", `/nonexistent-${process.pid}/docs`)],
  });
  assert.match(note, /Check the host stack\./);
  assert.match(note, /Run the login helper\./);
  assert.match(note, /Restore the mount\./);
  assert.doesNotMatch(note, /reconnect it with|sign in through|Ask the user to restore it/);
});

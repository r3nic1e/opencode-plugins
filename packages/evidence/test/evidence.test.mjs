import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Plugin from "../src/index.ts";
import { setupBrowser } from "../src/browser.ts";
import { watchEvidence } from "../src/feed.ts";
import { EvidenceStore } from "../src/store.ts";
import { citations, recordLines } from "../src/view.ts";

async function database(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "evidence-test-"));
  const file = path.join(directory, "storage.sqlite");
  const connections = [];
  t.after(async () => {
    for (const db of connections) db.close();
    await rm(directory, { recursive: true });
  });
  return () => {
    const db = new DatabaseSync(file);
    connections.push(db);
    db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    return {
      async get(key) {
        const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
        return row ? JSON.parse(row.value) : undefined;
      },
      async set(key, value) {
        db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(key, JSON.stringify(value));
      },
      async remove(key) {
        db.prepare("DELETE FROM kv WHERE key = ?").run(key);
      },
      async scan({ prefix, after, limit }) {
        const rows = db.prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?")
          .all(prefix, `${prefix}\uffff`, after ?? "", limit + 1);
        const more = rows.length > limit;
        const entries = rows.slice(0, limit).map(({ key, value }) => ({ key, value: JSON.parse(value) }));
        return { entries, ...(more ? { next: entries.at(-1).key } : {}) };
      },
    };
  };
}

async function harness(storage, options = {}) {
  const hooks = new Map();
  const sessionHooks = new Map();
  const tools = new Map();
  const events = [];
  const listeners = new Set();
  let rpc;
  const context = {
    options,
    location: { directory: "/workspace/project" },
    storage,
    rpc: { async register(definition, handlers) {
      assert.equal(definition.id, "evidence");
      rpc = handlers;
      return { events: { async emit(type, data) {
        assert.equal(type, "changed");
        events.push(structuredClone(data));
        for (const receive of listeners) receive(data.record);
      } } };
    } },
    tool: {
      async transform(transform) {
        transform({
          list: () => [...tools.values()],
          get: (id) => tools.get(id),
          add: (tool) => tools.set(tool.name, { ...tool, id: tool.name }),
          update: (id, update) => update(tools.get(id)),
        });
      },
      async hook(name, callback) { hooks.set(name, callback); },
    },
    session: { async hook(name, callback) { sessionHooks.set(name, callback); } },
  };
  await Plugin.setup(context);
  const invoke = async (tool, input, execute, call = {}) => {
    const event = {
      tool, input, sessionID: "session-a", messageID: "message-1", id: "call-1", agent: "build", ...call,
    };
    await hooks.get("execute.before")(event);
    let result;
    try {
      result = await execute(event.input);
    } catch (error) {
      await hooks.get("execute.after")({ ...event, status: "error", error });
      throw error;
    }
    await hooks.get("execute.after")({ ...event, status: "completed", result });
    return result;
  };
  const lookup = async (input, sessionID = "session-a") => {
    const result = await invoke("evidence_lookup", input,
      () => tools.get("evidence_lookup").execute(input, { sessionID }), { sessionID });
    const page = JSON.parse(result.content);
    return { ...page, value: page.nextOffset === null ? JSON.parse(page.text) : undefined };
  };
  const index = async (kind = "context", sessionID = "session-a") => {
    const event = { sessionID, system: [] };
    await sessionHooks.get(kind)(event);
    return event.system.map((part) => part.text).join("\n");
  };
  return { invoke, lookup, index, rpc, hooks, events, changed(receive) {
    listeners.add(receive);
    return () => listeners.delete(receive);
  } };
}

test("records exact arguments and results without changing tool behavior, and survives reloads", async (t) => {
  const connect = await database(t);
  const storage = connect();
  const h = await harness(storage);
  const input = { command: "printf 'three replicas\\n'", workdir: "/workspace/project" };
  const output = { content: "three replicas\n", metadata: { exit: 0 } };
  const expectedInput = structuredClone(input);
  const expectedOutput = structuredClone(output);
  assert.equal(await h.invoke("shell", input, async () => output), output);
  assert.deepEqual(input, expectedInput);
  assert.deepEqual(output, expectedOutput);
  const record = await h.rpc.get({ sessionID: "session-a", reference: "[E1]" });
  assert.equal(record.status, "completed");
  assert.match(record.uuid, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  assert.deepEqual(JSON.parse(record.input.text), expectedInput);
  assert.deepEqual(JSON.parse(record.result.text), expectedOutput);
  assert.equal(record.directory, "/workspace/project");
  assert.equal(record.messageID, "message-1");
  assert.equal(record.callID, "call-1");
  assert.ok(Number.isFinite(Date.parse(record.captured)));
  assert.ok(Number.isFinite(Date.parse(record.finished)));
  input.command = "mutated after capture";
  output.content = "mutated after capture";
  const restarted = await harness(connect());
  const saved = await restarted.rpc.get({ sessionID: "session-a", reference: record.uuid });
  assert.deepEqual(saved, record);
  await restarted.invoke("read", { path: "file.txt" }, async () => ({ content: "later" }));
  assert.equal((await restarted.rpc.get({ sessionID: "session-a", reference: "E2" })).tool, "read");
  assert.deepEqual((await restarted.lookup({ reference: "E1" })).value, record);
  assert.equal((await restarted.rpc.list({ sessionID: "session-a" })).items.length, 2);
});

test("concurrent identical nested calls sharing a native call ID get distinct evidence and the right parent", async (t) => {
  const storage = (await database(t))();
  const h = await harness(storage);
  const releases = [];
  const started = [];
  const waitFor = (index) => new Promise((resolve) => { started[index] = resolve; });
  const entered = [waitFor(0), waitFor(1)];
  const outer = h.invoke("execute", { code: "return await Promise.all([same(), same()])" }, async () => {
    const child = (index) => h.invoke("mcp_query", { query: "same" }, async () => {
      started[index]();
      await new Promise((resolve) => { releases[index] = resolve; });
      return { output: { source: index } };
    });
    return { output: await Promise.all([child(0), child(1)]) };
  });
  await Promise.all(entered);
  releases[1]();
  const secondCompleted = new Promise((resolve) => {
    const original = h.hooks.get("execute.after");
    h.hooks.set("execute.after", async (event) => {
      await original(event);
      if (event.tool === "mcp_query") resolve();
    });
  });
  await secondCompleted;
  releases[0]();
  const result = await outer;
  assert.deepEqual(result.output, [{ output: { source: 0 } }, { output: { source: 1 } }]);
  const records = await Promise.all(["E1", "E2", "E3"].map((reference) => h.rpc.get({ sessionID: "session-a", reference })));
  assert.equal(new Set(records.map((record) => record.uuid)).size, 3);
  assert.equal(records[0].tool, "execute");
  assert.equal(records[0].status, "completed");
  assert.deepEqual(records.slice(1).map((record) => record.parent), ["E1", "E1"]);
  assert.deepEqual(records.slice(1).map((record) => JSON.parse(record.result.text).output.source), [1, 0]);
  assert.deepEqual(records.map((record) => record.callID), ["call-1", "call-1", "call-1"]);
});

test("records tools added after plugin setup and preserves thrown errors", async (t) => {
  const h = await harness((await database(t))());
  const error = Object.assign(new Error("permission rejected"), { metadata: { reason: "denied" } });
  await assert.rejects(h.invoke("late_plugin_tool", { target: "prod" }, async () => { throw error; }), (caught) => caught === error);
  const record = await h.rpc.get({ sessionID: "session-a", reference: "E1" });
  assert.equal(record.tool, "late_plugin_tool");
  assert.equal(record.status, "error");
  assert.equal(JSON.parse(record.result.text).message, "permission rejected");
  assert.deepEqual(JSON.parse(record.result.text).metadata, { reason: "denied" });
});

test("redacts common credentials, bounds UTF-8 snapshots, and hashes the full redacted snapshot", async (t) => {
  const h = await harness((await database(t))(), { maxSnapshotBytes: 1024 });
  const output = { output: { password: "sentinel-password", headers: { Authorization: "sentinel-auth" }, text: `Bearer sentinel-bearer ${"é".repeat(1200)}` } };
  const original = structuredClone(output);
  await h.invoke("mcp_query", { api_key: "sentinel-input", query: "safe" }, async () => output);
  const record = await h.rpc.get({ sessionID: "session-a", reference: "E1" });
  const serialized = JSON.stringify(record);
  for (const secret of ["sentinel-password", "sentinel-auth", "sentinel-bearer", "sentinel-input"]) assert.ok(!serialized.includes(secret));
  assert.deepEqual(output, original);
  assert.equal(record.input.redacted, true);
  assert.equal(record.result.redacted, true);
  assert.equal(record.result.truncated, true);
  assert.ok(Buffer.byteLength(record.result.text) <= 1024);
  assert.ok(!record.result.text.includes("\ufffd"));
  const fullRedacted = JSON.stringify({ output: { password: "[REDACTED]", headers: { Authorization: "[REDACTED]" }, text: `Bearer [REDACTED] ${"é".repeat(1200)}` } }, null, 2);
  assert.equal(record.result.bytes, Buffer.byteLength(fullRedacted));
  assert.equal(record.result.sha256, createHash("sha256").update(fullRedacted).digest("hex"));
  const view = recordLines(record).join("\n");
  assert.match(view, /REDACTED/);
  assert.match(view, /TRUNCATED/);
});

test("session-scoped lookup rejects foreign UUIDs, cursors, and malformed handles", async (t) => {
  const h = await harness((await database(t))());
  await h.invoke("read", { path: "a" }, async () => ({ content: "a" }));
  const a = await h.rpc.get({ sessionID: "session-a", reference: "E1" });
  assert.equal(await h.rpc.get({ sessionID: "session-b", reference: a.uuid }), null);
  assert.equal(await h.rpc.get({ sessionID: "session-b", reference: "E1" }), null);
  for (const reference of ["E0", "E01", "E-1", "E1/foo", "[E1", "E9007199254740993"]) {
    assert.equal(await h.rpc.get({ sessionID: "session-a", reference }), null);
  }
  await assert.rejects(h.rpc.list({ sessionID: "session-b", after: "v1/sessions/session-a/records/0000000000000001" }), /cursor/);
  await h.invoke("read", {}, async () => ({ content: "b" }), { sessionID: "session-b" });
  assert.equal((await h.rpc.get({ sessionID: "session-b", reference: "E1" })).sessionID, "session-b");
  assert.deepEqual(await h.rpc.check({ sessionID: "session-a", references: ["E1", "E404", "E404"] }), { valid: ["E1"], broken: ["E404"] });
  assert.match((await h.lookup({ reference: "E404" })).value.error, /Broken citation/);
});

test("paginates history and keeps evidence available after compaction without recursively recording lookup", async (t) => {
  const h = await harness((await database(t))());
  for (let i = 1; i <= 105; i++) {
    await h.invoke("read", { path: `file-${i}` }, async () => ({ content: `value-${i}` }), { id: `call-${i}` });
  }
  const first = await h.rpc.list({ sessionID: "session-a" });
  const second = await h.rpc.list({ sessionID: "session-a", after: first.next });
  assert.deepEqual(first.items.map((item) => item.ref), Array.from({ length: 100 }, (_, i) => `E${i + 1}`));
  assert.deepEqual(second.items.map((item) => item.ref), ["E101", "E102", "E103", "E104", "E105"]);
  assert.equal(second.next, undefined);
  const compact = await h.index("compaction");
  assert.match(compact, /preserve cited handles/);
  const index = JSON.parse(compact.split("Recent execution index (previews only):\n")[1]);
  assert.deepEqual(index.map((item) => item.ref), Array.from({ length: 30 }, (_, i) => `E${i + 76}`));
  assert.match((await h.lookup({ reference: "E1" })).value.result.text, /value-1/);
  assert.equal((await h.rpc.list({ sessionID: "session-a", after: first.next })).items.length, 5);
  const page = await h.lookup({ reference: "E1", limit: 40 });
  const next = await h.lookup({ reference: "E1", offset: page.nextOffset, limit: 40 });
  const full = await h.lookup({ reference: "E1" });
  assert.equal(page.text + next.text, full.text.slice(0, 80));
});

test("storage failures do not fail a tool, and incomplete captures never look completed", async (t) => {
  const storage = (await database(t))();
  const h = await harness({ ...storage, async set(key, value) {
    if (value?.status === "completed") throw new Error("disk full: secret diagnostic");
    return storage.set(key, value);
  } });
  const warnings = [];
  const originalError = console.error;
  console.error = (text) => warnings.push(text);
  t.after(() => { console.error = originalError; });
  const result = { content: "success" };
  assert.equal(await h.invoke("shell", {}, async () => result), result);
  const record = await h.rpc.get({ sessionID: "session-a", reference: "E1" });
  assert.equal(record.status, "started");
  assert.equal(record.result, undefined);
  assert.match(recordLines(record).join("\n"), /No completion snapshot/);
  assert.match(await h.index(), /WARNING: Evidence capture has failed/);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings.join().includes("secret diagnostic"));
  const broken = await harness({ ...storage, async get() { throw new Error("storage unavailable"); } });
  const failure = new Error("original failure");
  await assert.rejects(broken.invoke("read", {}, async () => { throw failure; }), (caught) => caught === failure);
});

test("missing outer completion survives reload as incomplete and reference numbers are not reused", async (t) => {
  const connect = await database(t);
  const h = await harness(connect());
  await h.hooks.get("execute.before")({ tool: "execute", input: { code: "unfinished" }, sessionID: "session-a", messageID: "m", id: "c" });
  const restarted = await harness(connect());
  const record = await restarted.rpc.get({ sessionID: "session-a", reference: "E1" });
  assert.equal(record.status, "started");
  assert.equal(record.finished, undefined);
  await restarted.invoke("read", {}, async () => ({ content: "after restart" }));
  assert.equal((await restarted.rpc.get({ sessionID: "session-a", reference: "E2" })).status, "completed");
});

test("citation scanning only inspects assistant text, not user input, reasoning, or tool output", () => {
  assert.deepEqual(citations([
    { type: "user", content: [{ type: "text", text: "[E99]" }] },
    { type: "assistant", content: [
      { type: "reasoning", text: "[E98]" },
      { type: "tool", text: "[E97]" },
      { type: "text", text: "Claim [E1], another [E2], repeated [E1]. Not [E01] or [E0]." },
    ] },
  ]), ["E1", "E2"]);
});

test("UI browser follows persisted references, flags broken citations, and never executes source tools", async (t) => {
  const h = await harness((await database(t))());
  await h.invoke("shell", { command: "printf fixture" }, async () => ({ content: "fixture output" }));
  const commands = [];
  const dialogs = [];
  const alerts = [];
  const calls = [];
  const ui = {
    location: { directory: "/workspace/project" },
    client: { rpc: (definition) => {
      assert.equal(definition.id, "evidence");
      return Object.fromEntries(Object.entries(h.rpc).map(([name, handler]) => [name, (input, options) => {
        assert.deepEqual(options.location, { directory: "/workspace/project" });
        calls.push({ name, input });
        return handler(input);
      }]));
    } },
    data: { session: { message: {
      async sync(id) { assert.equal(id, "session-a"); },
      list: () => [{ type: "assistant", content: [{ type: "text", text: "Observed [E1]. Invented [E404]." }] }],
    } } },
    keymap: { layer: (factory) => commands.push(...factory().commands) },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "session-a" }) },
      dialog: {
        set() {},
        async select(dialog) {
          dialogs.push(dialog);
          return dialogs.length === 1 ? "E1" : undefined;
        },
        async alert(dialog) { alerts.push(dialog); },
      },
      toast: { show: (toast) => { throw new Error(`Unexpected toast: ${toast.message}`); } },
    },
  };
  setupBrowser(ui);
  await commands.find((command) => command.id === "evidence.open").run();
  assert.ok(dialogs[0].options.some((item) => item.title.includes("[E404] BROKEN")));
  assert.ok(dialogs[0].options.some((item) => item.title.includes("[E1] shell")));
  const detail = dialogs[1].options.map((item) => item.title).join("\n");
  assert.match(detail, /printf fixture/);
  assert.match(detail, /fixture output/);
  await commands[0].run("E404");
  assert.match(alerts.at(-1).title, /Broken evidence citation/);
  assert.ok(calls.every((call) => ["list", "get", "check"].includes(call.name)));
});

test("sidebar feed loads every page, receives saved updates without rescanning, and unsubscribes", async (t) => {
  const h = await harness((await database(t))());
  for (let i = 1; i <= 105; i++) {
    await h.invoke("read", { path: `file-${i}` }, async () => ({ content: `value-${i}` }));
  }
  let state;
  const scans = [];
  let reconnect;
  let disconnected = false;
  const feed = watchEvidence("session-a", {
    async list(after) {
      scans.push(after);
      return h.rpc.list({ sessionID: "session-a", ...(after ? { after } : {}) });
    },
    changed: h.changed,
    reconnected(receive) { reconnect = receive; return () => { disconnected = true; }; },
  }, (value) => { state = value; });
  t.after(() => feed.dispose());
  await feed.ready;
  assert.equal(state.loading, false);
  assert.equal(state.failed, false);
  assert.deepEqual(state.items.map((item) => item.ref), Array.from({ length: 105 }, (_, i) => `E${105 - i}`));
  assert.equal(scans.length, 2);
  await h.invoke("shell", { command: "fixture", token: "secret-sentinel" }, async () => ({ content: "new result" }));
  assert.equal(state.items[0].ref, "E106");
  assert.equal(state.items[0].tool, "shell");
  assert.equal(state.items[0].status, "completed");
  assert.match(state.items[0].resultPreview, /new result/);
  assert.equal(scans.length, 2);
  assert.ok(!JSON.stringify(h.events.at(-1)).includes("secret-sentinel"));
  const outer = { tool: "execute", input: {}, sessionID: "session-a", messageID: "m", id: "c" };
  await h.hooks.get("execute.before")(outer);
  assert.equal(state.items[0].ref, "E107");
  assert.equal(state.items[0].status, "started");
  await h.hooks.get("execute.after")({ ...outer, status: "completed", result: { content: "done" } });
  assert.equal(state.items.filter((item) => item.ref === "E107").length, 1);
  assert.equal(state.items[0].status, "completed");
  const before = state;
  await h.invoke("read", {}, async () => ({ content: "foreign" }), { sessionID: "session-b" });
  assert.equal(state, before);
  feed.dispose();
  assert.equal(disconnected, true);
  reconnect();
  await h.invoke("read", {}, async () => ({ content: "after cleanup" }));
  assert.equal(state, before);
  assert.equal(scans.length, 2);
});

test("sidebar merges live updates during pagination and ignores replies after its session is unmounted", async () => {
  const summary = (ref, status = "completed") => ({ ref, status, sessionID: "session-a", tool: "read" });
  let release;
  let receive;
  let state;
  const feed = watchEvidence("session-a", {
    list: async (after) => after
      ? { items: [summary("E2")], next: undefined }
      : new Promise((resolve) => { release = resolve; }),
    changed(callback) { receive = callback; return () => {}; },
    reconnected() { return () => {}; },
  }, (value) => { state = value; });
  receive(summary("E1"));
  receive(summary("E3"));
  release({ items: [summary("E1", "started")], next: "page-2" });
  await feed.ready;
  assert.deepEqual(state.items.map(({ ref, status }) => [ref, status]), [
    ["E3", "completed"], ["E2", "completed"], ["E1", "completed"],
  ]);
  feed.dispose();
  let resolveOld;
  let oldState;
  const old = watchEvidence("session-a", {
    list: () => new Promise((resolve) => { resolveOld = resolve; }),
    changed() { return () => {}; }, reconnected() { return () => {}; },
  }, (value) => { oldState = value; });
  const before = oldState;
  old.dispose();
  resolveOld({ items: [summary("E99")] });
  await old.ready;
  assert.equal(oldState, before);
});

test("sidebar reports load failures and recovers missed events after reconnect", async () => {
  let fail = true;
  let reconnect;
  let state;
  let recovered;
  const recovery = new Promise((resolve) => { recovered = resolve; });
  const feed = watchEvidence("session-a", {
    async list() {
      if (fail) throw new Error("offline");
      return { items: [{ ref: "E7", sessionID: "session-a", tool: "shell", status: "error" }] };
    },
    changed() { return () => {}; },
    reconnected(receive) { reconnect = receive; return () => {}; },
  }, (value) => {
    state = value;
    if (!value.loading && !value.failed && value.items.length) recovered();
  });
  await feed.ready;
  assert.equal(state.failed, true);
  assert.equal(state.loading, false);
  fail = false;
  reconnect();
  await recovery;
  assert.equal(state.failed, false);
  assert.equal(state.items[0].ref, "E7");
  assert.equal(state.items[0].status, "error");
  feed.dispose();
});

test("stores allocated handles monotonically across concurrent instances", async (t) => {
  const connect = await database(t);
  const stores = [new EvidenceStore(connect()), new EvidenceStore(connect())];
  const records = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].start("read", { i },
    { sessionID: "shared", messageID: "m", id: "c" }, "/project")));
  assert.deepEqual(records.map((record) => record.ref), Array.from({ length: 20 }, (_, i) => `E${i + 1}`));
  assert.equal(new Set(records.map((record) => record.uuid)).size, 20);
});

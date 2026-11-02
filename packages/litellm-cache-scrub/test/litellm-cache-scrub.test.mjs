import test from "node:test";
import assert from "node:assert/strict";
import Plugin, { scrubRequest } from "../src/index.ts";

const json = (body) =>
  new Request("https://proxy.example.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "999" },
    body: JSON.stringify(body),
  });

async function hooks(options) {
  const registered = [];
  await Plugin.setup({
    options,
    session: { hook: async (name, handler, filter) => { registered.push({ name, handler, filter }); } },
  });
  return registered;
}

test("removes prompt-cache fields at any depth", async () => {
  const request = await scrubRequest(json({
    model: "m",
    promptCacheKey: "k",
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    tools: [{ name: "t", cacheControl: { type: "ephemeral" } }],
  }));
  assert.deepEqual(await request.json(), {
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [{ name: "t" }],
  });
  assert.equal(request.headers.get("content-length"), null);
});

test("returns the original request when nothing changes or the body is not JSON", async () => {
  const clean = json({ model: "m", messages: [] });
  assert.equal(await scrubRequest(clean), clean);
  const text = new Request("https://proxy.example.com/", { method: "POST", headers: { "content-type": "text/plain" }, body: "cache_control" });
  assert.equal(await scrubRequest(text), text);
});

test("hooks the litellm provider by default", async () => {
  const registered = await hooks(undefined);
  assert.deepEqual(registered.map((hook) => [hook.name, hook.filter]), [["http.request", { providerID: "litellm" }]]);
});

test("providerIDs option selects the providers to scrub", async () => {
  const registered = await hooks({ providerIDs: ["gateway", "proxy"] });
  assert.deepEqual(registered.map((hook) => hook.filter.providerID), ["gateway", "proxy"]);
  const event = { request: json({ cache_control: {} }) };
  await registered[0].handler(event);
  assert.deepEqual(await event.request.json(), {});
});

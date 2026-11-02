import test from "node:test";
import assert from "node:assert/strict";
import Plugin from "../src/index.ts";

const ENDPOINT = "https://gateway.example.com/openai/v1/decisions";

const input = {
  model: "decisions-model",
  input: "Shared evidence",
  questions: [
    { type: "predicate", name: "safe", instructions: "Is it safe?" },
    { type: "choice", instructions: "Choose", choices: [{ value: true }, { value: "true", description: "Literal text" }] },
    { type: "score", instructions: "Rate", levels: [{ label: "low" }, { label: "high", description: "Severe" }] },
  ],
  safety_identifier: "opaque-id",
};

async function setup(t, { provider = { settings: { apiKey: "litellm-key" } }, credential, connected = false, resolve, fetcher, options = { endpoint: ENDPOINT } } = {}) {
  const providerID = options.providerID ?? "litellm";
  let tool;
  const calls = [];
  const connection = { type: "credential", integrationID: "litellm", credentialID: "existing" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), ...options });
    return fetcher ? fetcher(url, options) : Response.json({ answers: [], model: "decisions-model", usage: { total_tokens: 2 } });
  });
  await Plugin.setup({
    options,
    tool: { transform: async (transform) => transform({ add: (definition) => { tool = definition; } }) },
    provider: { get: async ({ providerID: requested }) => {
      assert.equal(requested, providerID);
      return { location: { directory: "/workspace" }, data: { id: providerID, ...provider } };
    } },
    integration: { connection: {
      active: async (id) => { assert.equal(id, provider.integrationID ?? providerID); return connected ? connection : undefined; },
      resolve: async (selected) => { assert.equal(selected, connection); return resolve ? resolve() : credential; },
    } },
  });
  assert.equal(tool.name, "openai_decisions");
  assert.equal(tool.options.codemode, true);
  const controller = new AbortController();
  return { tool, calls, controller, run: (body = input) => tool.execute(body, { signal: controller.signal }) };
}

test("posts the exact Decisions payload to the endpoint with the provider token", async t => {
  const s = await setup(t);
  const result = await s.run();
  assert.equal(s.calls.length, 1);
  const request = s.calls[0];
  assert.equal(request.url, ENDPOINT);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("authorization"), "Bearer litellm-key");
  assert.equal(request.headers.get("content-type"), "application/json");
  assert.equal(request.redirect, "error");
  assert.deepEqual(JSON.parse(request.body), input);
  assert.deepEqual(JSON.parse(result.content), { answers: [], model: "decisions-model", usage: { total_tokens: 2 } });
});

test("defaults the model to gpt-6-luna when omitted", async t => {
  const s = await setup(t);
  const { model, ...withoutModel } = input;
  await s.run(withoutModel);
  assert.deepEqual(JSON.parse(s.calls[0].body), { ...withoutModel, model: "gpt-6-luna" });
});

test("the provider's baseURL never redirects the request", async t => {
  for (const baseURL of ["https://gateway.example.com/v1", "https://user:password@example.com/v1", "not a URL", 42]) {
    const s = await setup(t, { provider: { settings: { baseURL, apiKey: "litellm-key" } } });
    await s.run();
    assert.equal(s.calls[0].url, ENDPOINT);
  }
});

test("a connected credential takes precedence and is resolved on every invocation", async t => {
  let token = "first-token";
  const s = await setup(t, {
    connected: true,
    provider: { integrationID: "litellm-sso", settings: { apiKey: "stale-key" }, headers: { "X-Team": "infra", Authorization: "Bearer stale-header" } },
    resolve: () => ({ type: "key", key: token }),
  });
  await s.run();
  token = "refreshed-token";
  await s.run();
  assert.deepEqual(s.calls.map(request => request.headers.get("authorization")), ["Bearer first-token", "Bearer refreshed-token"]);
  assert.equal(s.calls[1].headers.get("x-team"), "infra");
});

test("a configured Authorization header is used when there is no key", async t => {
  const s = await setup(t, { provider: { headers: { Authorization: "Bearer header-key" } } });
  await s.run();
  assert.equal(s.calls[0].headers.get("authorization"), "Bearer header-key");
});

test("missing credentials and credential-resolution failures never send a request", async t => {
  const missing = await setup(t, { provider: {} });
  await assert.rejects(missing.run(), /No token is configured for the litellm provider/);
  assert.equal(missing.calls.length, 0);
  const broken = await setup(t, { connected: true, resolve: () => { throw new Error("credential lookup failed"); } });
  await assert.rejects(broken.run(), /credential lookup failed/);
  assert.equal(broken.calls.length, 0);
});

test("returns distributions, boolean choices, refusals, and usage without reinterpretation", async t => {
  const response = {
    model: "decisions-model",
    answers: [
      { type: "predicate", name: "safe", probability: 0.8 },
      { type: "choice", name: null, choice: true, confidence: 0.9, probabilities: [{ value: true, probability: 0.9 }, { value: "true", probability: 0.1 }] },
      { type: "score", name: null, score: 1.4, confidence: 0.6, probabilities: [{ label: "low", value: 1, probability: 0.6 }, { label: "high", value: 2, probability: 0.4 }] },
      { type: "refusal", name: "restricted" },
    ],
    usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
  };
  const s = await setup(t, { fetcher: () => Response.json(response) });
  assert.deepEqual(JSON.parse((await s.run()).content), response);
});

test("inline images are passed through and the 128-image limit prevents an oversized request", async t => {
  const s = await setup(t);
  const image = { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "original" };
  const body = { ...input, input: [{ role: "user", type: "message", content: [{ type: "input_text", text: "Evidence" }, image] }] };
  await s.run(body);
  assert.deepEqual(JSON.parse(s.calls[0].body), body);
  const tooMany = { ...input, input: [{ role: "user", content: Array(129).fill(image) }] };
  await assert.rejects(s.run(tooMany), /at most 128/);
  assert.equal(s.calls.length, 1);
});

test("API failures report status without echoing sensitive bodies or falling back", async t => {
  for (const status of [401, 404, 429, 500]) {
    const s = await setup(t, { fetcher: () => Response.json({ error: { message: "secret-evidence litellm-key" } }, { status }) });
    await assert.rejects(s.run(), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes("secret-evidence"));
      assert.ok(!error.message.includes("litellm-key"));
      if (status === 401) assert.match(error.message, /did not accept the token/);
      return true;
    });
    assert.equal(s.calls.length, 1);
  }
});

test("session cancellation aborts the pending request even with provider timeout disabled", async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const s = await setup(t, {
    provider: { settings: { apiKey: "litellm-key", timeout: false } },
    fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started();
    }),
  });
  const pending = s.run();
  await ready;
  s.controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(s.calls[0].signal.aborted, true);
});

test("provider timeout aborts pending requests", async t => {
  const s = await setup(t, {
    provider: { settings: { apiKey: "litellm-key", timeout: 0 } },
    fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  const keepAlive = setInterval(() => {}, 1000);
  try { await assert.rejects(s.run(), { name: "TimeoutError" }); }
  finally { clearInterval(keepAlive); }
});

test("setup fails without an endpoint", async () => {
  await assert.rejects(Plugin.setup({ options: {}, tool: { transform: async () => {} } }), /set options\.endpoint/);
  await assert.rejects(Plugin.setup({ tool: { transform: async () => {} } }), /set options\.endpoint/);
});

test("providerID and model options select the credential source and the default model", async t => {
  const s = await setup(t, {
    options: { endpoint: "https://api.example.com/v1/decisions", providerID: "openai-api", model: "decisions-mini" },
    provider: { settings: { apiKey: "api-key" } },
  });
  const { model, ...withoutModel } = input;
  await s.run(withoutModel);
  assert.equal(s.calls[0].url, "https://api.example.com/v1/decisions");
  assert.equal(s.calls[0].headers.get("authorization"), "Bearer api-key");
  assert.equal(JSON.parse(s.calls[0].body).model, "decisions-mini");
  assert.match(s.tool.description, /openai-api provider's token; model defaults to decisions-mini/);
});

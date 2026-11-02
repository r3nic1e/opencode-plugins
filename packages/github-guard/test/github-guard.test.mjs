import test from "node:test";
import assert from "node:assert/strict";
import Plugin, { checkToolCall, createGuard } from "../src/index.ts";

for (const command of [
  "curl -I https://github.com/docker/docs",
  "curl -fL https://github.com/docker/docs/archive/refs/heads/main.tar.gz -o /tmp/docs.tar.gz",
  "wget https://github.com/cli/cli/releases/download/v2.65.0/gh_2.65.0_linux_amd64.tar.gz",
  "curl https://raw.githubusercontent.com/docker/docs/main/README.md",
  "curl -I https://codeload.github.com/docker/docs/tar.gz/refs/heads/main",
]) {
  test(`allows ordinary download command: ${command}`, () => {
    assert.equal(checkToolCall("shell", { command }), null);
  });
}

for (const url of [
  "https://github.com/docker/docs",
  "https://github.com/docker/docs/archive/refs/heads/main.tar.gz",
  "https://github.com/cli/cli/releases/latest",
  "https://raw.githubusercontent.com/docker/docs/main/README.md",
  "https://release-assets.githubusercontent.com/example",
  "https://example.com/docs",
]) {
  test(`allows ordinary webfetch URL: ${url}`, () => {
    assert.equal(checkToolCall("webfetch", { url }), null);
  });
}

for (const command of [
  "git clone https://github.com/docker/docs.git",
  "git clone git@github.com:docker/docs.git",
  "git -C /tmp/repo fetch origin",
  "git pull",
  "git push origin feature/test",
  "git -c credential.helper= push https://github.com/org/repo.git HEAD",
  "git ls-remote https://github.com/docker/docs.git",
  "git remote update",
  "git submodule update --init",
  "git submodule add https://github.com/docker/docs.git",
]) {
  test(`blocks remote Git: ${command}`, () => {
    for (const tool of ["shell", "bash"]) {
      assert.match(checkToolCall(tool, { command }), /Blocked by github-guard: remote `git [a-z -]+` is blocked/);
    }
  });
}

for (const command of [
  "git status",
  "git -C /tmp/repo diff",
  "git fetch /run/sandbox/source",
  "git clone /cache/repo ./local",
  "git fetch ../source",
  "git fetch file:///cache/repo",
]) {
  test(`preserves local Git: ${command}`, () => {
    assert.equal(checkToolCall("shell", { command }), null);
  });
}

test("blocks gh and suggests a GitHub MCP server", () => {
  assert.match(checkToolCall("shell", { command: "gh pr view 123" }), /Fix: use a GitHub MCP server/);
});

for (const command of [
  "curl https://api.github.com/repos/docker/docs",
  'curl -H "Accept: application/json" "https://api.github.com/repos/docker/docs"',
  "wget https://API.GITHUB.COM/repos/docker/docs",
]) {
  test(`blocks direct API command: ${command}`, () => {
    assert.match(checkToolCall("shell", { command }), /api\.github\.com is blocked in this environment/);
  });
}

test("blocks API webfetch without blocking unrelated hostnames", () => {
  assert.match(checkToolCall("webfetch", { url: "https://api.github.com/repos/docker/docs" }), /is blocked in this environment/);
  assert.equal(checkToolCall("webfetch", { url: "https://api.github.com.example.org/docs" }), null);
  assert.equal(checkToolCall("webfetch", { url: "not a URL" }), null);
});

test("execute.before rejects remote operations with configured advice and permits downloads", async () => {
  let hook;
  await Plugin.setup({ options: { git: { note: "Use the host Git broker." } }, tool: { hook: async (event, handler) => {
    assert.equal(event, "execute.before");
    hook = handler;
  } } });
  assert.equal(typeof hook, "function");
  assert.throws(() => hook({ tool: "shell", input: { command: "git push origin feature/test" } }), /Use the host Git broker\./);
  assert.throws(() => hook({ tool: "webfetch", input: { url: "https://api.github.com/repos/docker/docs" } }), /is blocked in this environment/);
  await hook({ tool: "shell", input: { command: "curl -I https://github.com/docker/docs" } });
  await hook({ tool: "webfetch", input: { url: "https://github.com/docker/docs" } });
});

test("options add a note and replace fix lines per operation", () => {
  const guard = createGuard({
    git: { note: "Use the broker.", fix: { push: ["Fix: push with the broker."], default: ["Fix: fetch with the broker."] } },
    gh: { note: "Policy denies it.", fix: ["Fix: use tools.github."] },
    githubApi: { fix: "Fix: use tools.github for API reads." },
  });
  const push = guard.checkBash("git push origin main");
  assert.match(push, /^Blocked by github-guard: remote `git push` is blocked in this environment\. Use the broker\.\n/);
  assert.match(push, /\nFix: push with the broker\.\n/);
  assert.match(guard.checkBash("git pull"), /\nFix: fetch with the broker\.\n/);
  const gh = guard.checkBash("gh pr view 1");
  assert.match(gh, /Policy denies it\.\nFix: use tools\.github\./);
  assert.match(gh, /Do not retry gh with a token/);
  assert.match(guard.checkWebfetch("https://api.github.com/x"), /\nFix: use tools\.github for API reads\.\nRejected URL/);
});

test("invalid options fall back to the defaults", () => {
  const guard = createGuard({ git: { note: 3, fix: { push: [1, 2] } }, gh: "nope" });
  assert.equal(guard.checkBash("git push"), checkToolCall("shell", { command: "git push" }));
  assert.equal(guard.checkBash("gh pr list"), checkToolCall("shell", { command: "gh pr list" }));
});

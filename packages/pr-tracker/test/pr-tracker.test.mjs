import test from "node:test";
import assert from "node:assert/strict";
import { decode, due, parseCreated, parseStatus, toolNames, upsert } from "../src/pr.ts";

const URL = "https://github.com/octo-org/octo-repo/pull/436";

test("reads a created PR from structured MCP output", () => {
  const created = parseCreated(
    { owner: "octo-org", repo: "octo-repo", title: "Fix relay", draft: true },
    { output: { id: "123", url: URL } },
  );
  assert.deepEqual(created, {
    owner: "octo-org",
    repo: "octo-repo",
    number: 436,
    url: URL,
    title: "Fix relay",
    status: "draft",
  });
});

test("reads a created PR from MCP text content", () => {
  const created = parseCreated(
    { title: "Add check" },
    { output: "", content: [{ type: "text", text: JSON.stringify({ id: "1", url: URL }) }] },
  );
  assert.equal(created?.number, 436);
  assert.equal(created?.status, "open");
});

test("ignores a create result without a PR URL", () => {
  assert.equal(parseCreated({}, { output: "failed to create pull request: 422" }), undefined);
});

for (const [name, pr, status] of [
  ["open", { state: "open", draft: false, merged: false }, "open"],
  ["draft", { state: "open", draft: true, merged: false }, "draft"],
  ["closed", { state: "closed", draft: false, merged: false }, "closed"],
  ["merged", { state: "closed", draft: false, merged: true }, "merged"],
  ["merged_at only", { state: "closed", merged_at: "2026-10-31T10:00:00Z" }, "merged"],
]) {
  test(`maps pull_request_read state: ${name}`, () => {
    assert.equal(parseStatus({ output: JSON.stringify({ number: 1, ...pr }) }), status);
  });
}

test("returns no status for an error text", () => {
  assert.equal(parseStatus({ output: "Not Found" }), undefined);
});

const pr = (fields) => ({
  owner: "octo-org",
  repo: "octo-repo",
  number: 436,
  url: URL,
  title: "t",
  status: "open",
  createdAt: 1,
  checkedAt: 1,
  agent: "build",
  messageID: "msg_1",
  ...fields,
});

test("upsert replaces the same PR case-insensitively and keeps its creation time", () => {
  const list = upsert([pr({})], pr({ owner: "Octo-Org", status: "draft", createdAt: 9 }));
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "draft");
  assert.equal(list[0].createdAt, 1);
});

test("upsert appends a different PR", () => {
  assert.equal(upsert([pr({})], pr({ number: 437 })).length, 2);
});

test("refreshes stale PRs except merged ones", () => {
  assert.equal(due(pr({ checkedAt: 0 }), 60_000, 50_000), true);
  assert.equal(due(pr({ checkedAt: 20_000 }), 60_000, 50_000), false);
  assert.equal(due(pr({ status: "closed", checkedAt: 0 }), 60_000, 50_000), true);
  assert.equal(due(pr({ status: "merged", checkedAt: 0 }), 60_000, 50_000), false);
});

test("decode drops malformed stored entries", () => {
  assert.deepEqual(decode([pr({}), { owner: "x" }, null]), [pr({})]);
  assert.deepEqual(decode(undefined), []);
});

test("tool names default to the GitHub MCP server and follow options", () => {
  assert.deepEqual(toolNames(undefined), { create: "github_create_pull_request", read: "github_pull_request_read" });
  assert.deepEqual(toolNames({ createTool: "gh_create_pr", readTool: "gh_read_pr" }), { create: "gh_create_pr", read: "gh_read_pr" });
  assert.deepEqual(toolNames({ createTool: "", readTool: 3 }), { create: "github_create_pull_request", read: "github_pull_request_read" });
});

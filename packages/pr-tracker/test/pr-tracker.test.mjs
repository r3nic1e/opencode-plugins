import test from "node:test";
import assert from "node:assert/strict";
import { decode, due, parseCi, parseCreated, parseStatus, toolNames, upsert } from "../src/pr.ts";

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

const checkRuns = (...runs) => ({ output: JSON.stringify({ total_count: runs.length, check_runs: runs }) });
const combined = (...statuses) => ({
  output: JSON.stringify({ state: statuses.length ? "success" : "pending", total_count: statuses.length, statuses }),
});
const run = (id, name, status, conclusion = null) => ({ id, name, status, conclusion });

test("CI: only the newest run of each check counts", () => {
  const passedRerun = [run(2, "build", "completed", "success"), run(1, "build", "completed", "failure")];
  const failedRerun = [run(1, "build", "completed", "success"), run(2, "build", "completed", "failure")];
  assert.equal(parseCi(checkRuns(...passedRerun), combined()), "success");
  assert.equal(parseCi(checkRuns(...failedRerun), combined()), "failure");
});

test("CI: a commit with check runs and no statuses is not pending", () => {
  assert.equal(parseCi(checkRuns(run(1, "lint", "completed", "success")), combined()), "success");
});

test("CI: skipped and neutral checks count as passing", () => {
  const runs = [run(1, "a", "completed", "skipped"), run(2, "b", "completed", "neutral"), run(3, "c", "completed", "success")];
  assert.equal(parseCi(checkRuns(...runs), combined({ context: "jenkins", state: "success" })), "success");
});

test("CI: a failed commit status fails CI even when every check run passed", () => {
  const runs = checkRuns(run(1, "lint", "completed", "success"));
  assert.equal(parseCi(runs, combined({ context: "jenkins", state: "failure" })), "failure");
  assert.equal(parseCi(runs, combined({ context: "jenkins", state: "error" })), "failure");
});

test("CI: work in progress is pending until something fails", () => {
  assert.equal(parseCi(checkRuns(run(1, "build", "in_progress")), combined({ context: "jenkins", state: "success" })), "pending");
  assert.equal(parseCi(checkRuns(run(1, "build", "completed", "success")), combined({ context: "jenkins", state: "pending" })), "pending");
  assert.equal(
    parseCi(checkRuns(run(1, "build", "queued"), run(2, "lint", "completed", "timed_out")), combined()),
    "failure",
  );
});

test("CI: a commit without checks or statuses has no CI", () => {
  assert.equal(parseCi(checkRuns(), combined()), "none");
});

test("CI: unknown when either result is unreadable", () => {
  assert.equal(parseCi({ output: "Not Found" }, combined()), undefined);
  assert.equal(parseCi(checkRuns(run(1, "build", "completed", "success")), { output: "Not Found" }), undefined);
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

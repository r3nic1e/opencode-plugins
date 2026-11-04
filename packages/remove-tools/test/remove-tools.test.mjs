import test from "node:test";
import assert from "node:assert/strict";
import Plugin, { parseOptions, removable } from "../src/index.ts";

async function setup({ options, tools }) {
  const removed = [];
  let transforms = 0;
  await Plugin.setup({
    options,
    tool: {
      transform: async (transform) => {
        transforms += 1;
        transform({ list: () => tools.map((id) => ({ id })), remove: (id) => removed.push(id) });
      },
    },
  });
  return { removed, transforms };
}

test("removes the configured tools under either namespace separator and keeps the rest", async () => {
  const s = await setup({
    options: { tools: ["session_move", "opencode.worktree_remove"] },
    tools: ["opencode.session_move", "opencode_session_move", "session_move", "opencode.session_rename", "opencode_worktree_remove", "read"],
  });
  assert.deepEqual(s.removed, ["opencode.session_move", "opencode_session_move", "session_move", "opencode_worktree_remove"]);
});

test("registers no transform without a tool list", async () => {
  for (const options of [undefined, {}, { tools: [] }, { tools: "session_move" }, { tools: [" ", 3] }]) {
    const s = await setup({ options, tools: ["opencode.session_move"] });
    assert.equal(s.transforms, 0);
    assert.deepEqual(s.removed, []);
  }
});

test("parseOptions keeps only non-empty strings", () => {
  assert.deepEqual(parseOptions({ tools: ["a", "", 1, " b "] }), ["a", " b "]);
  assert.deepEqual(parseOptions(null), []);
});

test("removable does not match other namespaces or substrings", () => {
  assert.ok(removable("opencode.session_move", ["session_move"]));
  assert.ok(removable("acme_greeting", ["acme_greeting"]));
  assert.ok(!removable("other_session_move", ["session_move"]));
  assert.ok(!removable("opencode.session_move_v2", ["session_move"]));
});

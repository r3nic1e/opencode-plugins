import assert from "node:assert/strict"
import test from "node:test"
import { permissionDetails } from "../src/permission.ts"

test("shows tool input for wildcard and scoped permissions", () => {
  for (const resources of [["*"], ["example.org"], ["one", "two"]]) {
    assert.deepEqual(permissionDetails({
      action: "custom.fetch", resources,
      metadata: { input: { url: "https://example.org", limit: 5 }, internal: "not an argument" },
    }), { url: "https://example.org", limit: 5 })
  }
})

test("shows custom permission metadata without depending on the action name", () => {
  for (const action of ["environment.access", "custom.approval"]) {
    assert.deepEqual(permissionDetails({
      action, resources: ["jfrog-download"],
      metadata: {
        reason: "Install test dependencies",
        additions: [{ name: "jfrog-download", methods: ["GET", "HEAD"] }],
      },
    }), {
      reason: "Install test dependencies",
      additions: [{ name: "jfrog-download", methods: ["GET", "HEAD"] }],
    })
  }
})

test("omits empty panels and preserves non-object metadata values", () => {
  for (const request of [undefined, { action: "shell", resources: ["ls"] },
    { action: "custom", resources: [], metadata: {} },
    { action: "custom", resources: [], metadata: { input: {} } }]) {
    assert.equal(permissionDetails(request), undefined)
  }
  assert.deepEqual(permissionDetails({
    action: "custom", resources: [], metadata: { input: ["first", "second"], enabled: false },
  }), { input: ["first", "second"], enabled: false })
})

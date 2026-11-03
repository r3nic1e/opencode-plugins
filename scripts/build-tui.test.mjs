import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { parseSync } from "@babel/core"
import { build, compile, tuiPackages } from "./build-tui.mjs"

const packages = tuiPackages()

test("finds the packages with a TUI part", () => {
  const names = packages.map((dir) => path.basename(dir))
  for (const name of ["evidence", "mcp-args", "pr-tracker"]) assert.ok(names.includes(name), `${name} not found`)
})

for (const dir of packages) {
  const name = path.basename(dir)
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
  const entry = path.join(dir, manifest.exports["./tui"])

  test(`${name}: ./tui export is the committed, up-to-date build`, async () => {
    const { out, code } = await build(dir)
    assert.equal(entry, out)
    assert.ok(existsSync(entry), `${entry} is missing; run npm run build`)
    assert.equal(readFileSync(entry, "utf8"), code, "dist/tui.js is stale; run npm run build")
  })

  test(`${name}: ./tui entry is plain JavaScript whose relative imports ship with the package`, () => {
    // Without syntax plugins Babel rejects JSX and TypeScript, so this parse fails on anything but plain JS.
    const program = parseSync(readFileSync(entry, "utf8"), { configFile: false, babelrc: false, sourceType: "module" }).program
    const relative = program.body
      .filter((node) => node.type === "ImportDeclaration" && node.source.value.startsWith("."))
      .map((node) => node.source.value)
    for (const specifier of relative) {
      const target = path.resolve(path.dirname(entry), specifier)
      assert.ok(existsSync(target), `${specifier} does not exist`)
      const top = path.relative(dir, target).split(path.sep)[0]
      assert.ok(manifest.files.includes(top), `${specifier} is outside the published files`)
    }
  })
}

test("compiled JSX keeps component props reactive", async () => {
  const code = await compile(
    'import { Show } from "solid-js"\nexport const View = (p: { n: () => number }) => <Show when={p.n() > 0}><text>x</text></Show>\n',
    path.join(import.meta.dirname, "fixture.tsx"),
  )
  assert.match(code, /get when\(\)\s*\{\s*return p\.n\(\) > 0;?\s*\}/)
  assert.match(code, /from "@opentui\/solid"/)
  assert.doesNotMatch(code, /jsx-runtime/)
})

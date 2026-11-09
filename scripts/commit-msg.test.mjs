import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const hook = new URL("../.githooks/commit-msg", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")
const dir = mkdtempSync(join(tmpdir(), "commit-msg-"))

function run(subject, env = {}) {
  const file = join(dir, "msg")
  writeFileSync(file, `${subject}\n\nbody; with — anything\n`)
  return spawnSync("sh", [hook, file], { encoding: "utf8", env: { ...process.env, NERLA_CI: "", ...env } })
}

test("valid subjects pass", () => {
  for (const s of [
    "feat: calls ring on every page",
    "fix(server): a slow query ends",
    "feat!: drop x",
    "fix(server)!: x",
    "Merge branch 'main' into x",
    "Merge pull request #1 from a/b",
    'Revert "feat: x"',
    "fixup! feat: x",
    "feat: one — two",
    "feat: one; two",
  ]) {
    assert.equal(run(s).status, 0, s)
  }
})

test("invalid subjects fail with the rule", () => {
  for (const s of ["added stuff", "feat:no space", "feature: x", "feat: "]) {
    const r = run(s)
    assert.equal(r.status, 1, s)
    assert.match(r.stdout, /^Commit subjects look like "fix: one plain sentence"\. The types are feat, fix/)
  }
  assert.equal(run("fixup! feat: x", { NERLA_CI: "1" }).status, 1)
})

import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { checkImage, checkWebsite } from "./size-budgets.mjs"

function fakeDist(bytes) {
  const dist = mkdtempSync(join(tmpdir(), "dist-"))
  mkdirSync(join(dist, "assets"))
  writeFileSync(join(dist, "index.html"), '<script type="module" src="/assets/index-a.js"></script>')
  writeFileSync(join(dist, "assets", "index-a.js"), randomBytes(bytes))
  return dist
}

test("a website over budget fails and one under passes", () => {
  const budgets = { websiteFirstLoadKb: 10 }
  const over = checkWebsite(fakeDist(20_000), budgets)
  assert.equal(over.errors.length, 1)
  assert.match(
    over.errors[0],
    /^The website's first load is 20 kB gzipped, over its 10 kB budget\. Make something load later, or raise the budget/,
  )
  assert.equal(checkWebsite(fakeDist(5_000), budgets).errors.length, 0)
})

test("an image over budget fails and one under passes", () => {
  assert.equal(checkImage(500e6, { serverImageMb: 439 }).errors.length, 1)
  assert.equal(checkImage(399e6, { serverImageMb: 439 }).errors.length, 0)
})

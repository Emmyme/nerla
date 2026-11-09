import assert from "node:assert/strict"
import { test } from "node:test"
import { releaseNotes } from "./release-notes.mjs"

const source =
  "The images are built on Alpine Linux. The sources of its GPL packages are at https://gitlab.alpinelinux.org/alpine/aports, under the tag of the Alpine version in each image."

test("sections come in order, with prefixes stripped and noise left out", () => {
  const notes = releaseNotes([
    "chore: bump deps",
    "perf: lazy load the board",
    "fix(server): a retry that looped",
    "docs: update readme",
    "Merge pull request #4 from a/b",
    "refactor: split the router",
    "feat!: drop the v1 API",
    "feat(web): dark mode",
    "fix: security headers on uploads",
    "ci: cache yarn",
    "test: more tests",
    "style: format",
  ])
  assert.equal(
    notes,
    [
      "## Breaking changes\n\n- drop the v1 API",
      "## Features\n\n- dark mode",
      "## Fixes\n\n- a retry that looped",
      "## Speed\n\n- lazy load the board",
      "## Security\n\n- security headers on uploads",
      "## Other\n\n- split the router",
      source,
    ].join("\n\n") + "\n",
  )
})

test("empty sections are left out and the source note always ends the notes", () => {
  assert.equal(releaseNotes(["docs: x"]), source + "\n")
  assert.equal(releaseNotes(["fix: one"]), `## Fixes\n\n- one\n\n${source}\n`)
})

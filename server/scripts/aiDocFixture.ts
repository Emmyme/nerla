/**
 * Writes the paper converter's output for one sample with every node and mark the format has, as a base64 Yjs
 * update, for the website's test that loads it in the real editor schema. Run it again after changing the converter:
 * npx tsx scripts/aiDocFixture.ts
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as Y from "yjs"
import { NO_REFS, type Resolved } from "../src/utils/docFormat"
import { applyDocWrite, revisionOf } from "../src/utils/docText"

const PERSON = "aaaaaaaa-0000-4000-8000-000000000001"
const BOARD = "bbbbbbbb-0000-4000-8000-000000000002"
const PAPER = "cccccccc-0000-4000-8000-000000000003"
const TASK = "dddddddd-0000-4000-8000-000000000004"
const IMAGE = "eeeeeeee-0000-4000-8000-000000000005"

const SAMPLE = [
  "# Launch plan",
  "## Goals",
  "### Details",
  `Some **bold**, *italic*, <u>underlined</u>, ~~struck~~ and \`code\` text, a [link](https://example.com), a [paper](paper:${PAPER}) and a line<br>break`,
  `Ask @[Theo](person:${PERSON}) about it`,
  "- One",
  "  - Nested",
  "1. First",
  "2. Second",
  "- [x] Done",
  `- [ ] [Fix login](task:${TASK})`,
  "> A quote",
  "```ts",
  "const a = 1",
  "```",
  "---",
  "| Name | Due |",
  "| --- | --- |",
  "| **Ship** | Soon |",
  `![Logo](file:${IMAGE})`,
  `![board](board:${BOARD})`,
  "![board](board:new)",
].join("\n")

const refs: Resolved = {
  ...NO_REFS,
  people: new Map([[PERSON, "Theo"]]),
  tasks: new Map([[TASK, { title: "Fix login" }]]),
  links: new Map([
    [`paper:${PAPER}`, `/paper/${PAPER}`],
    [`task:${TASK}`, `/?task=${TASK}`],
  ]),
  images: new Map([[IMAGE, IMAGE]]),
  boards: new Set([BOARD]),
}

const doc = new Y.Doc()
doc.clientID = 1
const result = applyDocWrite(doc, { op: "append", text: SAMPLE, revision: revisionOf(doc) }, refs, {
  newId: () => "ffffffff-0000-4000-8000-000000000006",
})
if (!result.ok) throw new Error(result.error)
if (result.kept.length) throw new Error(`The sample kept lines as text: ${JSON.stringify(result.kept)}`)

const out = resolve(__dirname, "../../website/src/components/papers/fixtures/aiSample.update.txt")
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")}\n`)
console.log(`Wrote ${out}`)

// node scripts/release-notes.mjs <previous tag or empty> <tag>
import { execFileSync } from "node:child_process"

const SOURCE_NOTE =
  "The images are built on Alpine Linux. The sources of its GPL packages are at https://gitlab.alpinelinux.org/alpine/aports, under the tag of the Alpine version in each image."
const LEFT_OUT = new Set(["docs", "test", "ci", "style", "chore"])
const SECTIONS = ["Breaking changes", "Features", "Fixes", "Speed", "Security", "Other"]

export function releaseNotes(subjects) {
  const found = Object.fromEntries(SECTIONS.map((s) => [s, []]))
  for (const subject of subjects) {
    if (subject.startsWith("Merge ")) continue
    const m = subject.match(/^(\w+)(?:\([^)]*\))?(!)?: (.+)$/)
    if (!m) {
      found.Other.push(subject)
      continue
    }
    const [, type, breaking, text] = m
    if (breaking) found["Breaking changes"].push(text)
    else if (LEFT_OUT.has(type)) continue
    else if (type === "feat") found.Features.push(text)
    else if (type === "fix") found[/^security\b/i.test(text) ? "Security" : "Fixes"].push(text)
    else if (type === "perf") found.Speed.push(text)
    else found.Other.push(text)
  }
  const blocks = SECTIONS.filter((s) => found[s].length).map((s) => `## ${s}\n\n${found[s].map((t) => `- ${t}`).join("\n")}`)
  return [...blocks, SOURCE_NOTE].join("\n\n") + "\n"
}

if (process.argv[1]?.endsWith("release-notes.mjs")) {
  const [previous, tag] = process.argv.slice(2)
  if (tag === undefined) {
    console.error("Usage: node scripts/release-notes.mjs <previous tag or empty> <tag>")
    process.exit(2)
  }
  const log = execFileSync("git", ["log", "--format=%s", previous ? `${previous}..${tag}` : tag], { encoding: "utf8" })
  process.stdout.write(releaseNotes(log.split("\n").filter(Boolean)))
}

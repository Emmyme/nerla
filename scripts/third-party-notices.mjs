// Writes THIRD_PARTY_NOTICES.md (website and desktop) and server/THIRD_PARTY_LICENSES.md from what is installed.
// Run with `yarn notices` after any dependency change. `--audit` prints a JSON summary instead of writing files.
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { brotliDecompressSync } from "node:zlib"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const TAURI = join(ROOT, "desktop", "src-tauri")
const EXCALIDRAW_FONTS = join(ROOT, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts")
// Families the website build doesn't copy (see the excalidrawFonts plugin in website/vite.config.ts), so they never ship
const FONTS_NOT_SERVED = new Set(JSON.parse(readFileSync(join(ROOT, "website", "excalidraw-fonts-left-out.json"), "utf8")))
const OWN = new Set(["nerla", "website", "server", "desktop", "app"])

// Copyright lines for packages that ship no licence file, taken from their upstream repository or sibling packages
const KNOWN_COPYRIGHT = {
  "@excalidraw/excalidraw": ["Copyright (c) 2020 Excalidraw"],
  "@radix-ui/": ["Copyright (c) 2022 WorkOS"],
  "@tauri-apps/plugin-notification": ["Copyright (c) 2017 - Present Tauri Apps Contributors"],
  "@tauri-apps/plugin-store": ["Copyright (c) 2017 - Present Tauri Apps Contributors"],
}
const knownCopyright = (name) =>
  KNOWN_COPYRIGHT[name] ?? Object.entries(KNOWN_COPYRIGHT).find(([key]) => key.endsWith("/") && name.startsWith(key))?.[1]

const FAMILY = {
  permissive: "Permissive",
  weak: "Weak copyleft",
  strong: "Strong copyleft",
  font: "Font licence",
  content: "Content licence",
  restricted: "Commercial or restricted",
  unknown: "Unknown or custom",
}

const PERMISSIVE = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSD-3-Clause-Clear",
  "BSD",
  "Apache-2.0",
  "Unlicense",
  "CC0-1.0",
  "Zlib",
  "BSL-1.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "PostgreSQL",
  "Python-2.0",
  "BlueOak-1.0.0",
  "WTFPL",
  "X11",
  "MIT-CMU",
])
// Lower is preferred when a package offers a choice
const RANK = ["MIT", "ISC", "0BSD", "MIT-0", "BSD-2-Clause", "BSD-3-Clause", "Zlib", "Unlicense", "CC0-1.0", "BSL-1.0", "Apache-2.0"]

const ALIASES = {
  "apache 2.0": "Apache-2.0",
  "apache-2": "Apache-2.0",
  apache2: "Apache-2.0",
  "apache license 2.0": "Apache-2.0",
  "mit/x11": "MIT",
  "mit*": "MIT",
  bsd: "BSD",
  "new bsd": "BSD-3-Clause",
  "simplified bsd": "BSD-2-Clause",
  "public domain": "Unlicense",
  "unicode-dfs-2016": "Unicode-DFS-2016",
  "ofl-1.1": "OFL-1.1",
  "lgpl-2.1+": "LGPL-2.1-or-later",
}

const familyOf = (id) => {
  const base = id.split(" WITH ")[0]
  if (PERMISSIVE.has(base)) return "permissive"
  if (/^(MPL|LGPL|EPL|CDDL)/.test(base)) return "weak"
  if (/^(GPL|AGPL)/.test(base)) return "strong"
  if (/^OFL/.test(base)) return "font"
  if (/^CC-BY/.test(base)) return "content"
  if (/^(BUSL|SSPL|Elastic|PolyForm|Commons|CC-BY-NC)/i.test(base) || /non-?commercial/i.test(base)) return "restricted"
  return "unknown"
}
const SEVERITY = ["permissive", "font", "content", "weak", "unknown", "restricted", "strong"]
const worst = (families) => families.reduce((a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a), "permissive")

// Small SPDX expression reader: returns the alternatives, each a list of licences that all apply
function alternatives(expression) {
  const tokens = expression
    .replace(/\s+\/\s+|\//g, " OR ")
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .split(/\s+/)
    .filter(Boolean)
  let i = 0
  const atom = () => {
    if (tokens[i] === "(") {
      i++
      const inner = or()
      i++
      return inner
    }
    let id = tokens[i++] ?? ""
    if (tokens[i] === "WITH") {
      id += ` WITH ${tokens[i + 1]}`
      i += 2
    }
    id = ALIASES[id.toLowerCase()] ?? id
    return [[id]]
  }
  const and = () => {
    let left = atom()
    while (tokens[i]?.toUpperCase() === "AND") {
      i++
      const right = atom()
      left = left.flatMap((l) => right.map((r) => [...l, ...r]))
    }
    return left
  }
  const or = () => {
    let left = and()
    while (tokens[i]?.toUpperCase() === "OR") {
      i++
      left = [...left, ...and()]
    }
    return left
  }
  return or()
}

const score = (ids) =>
  ids.reduce((sum, id) => {
    const r = RANK.indexOf(id)
    if (r >= 0) return sum + r
    return sum + 10 * (SEVERITY.indexOf(familyOf(id)) + 2)
  }, 0)

function choose(expression) {
  if (!expression) return { chosen: [], family: "unknown" }
  const options = alternatives(expression)
  const best = options.reduce((a, b) => (score(b) < score(a) ? b : a))
  return { chosen: best, family: worst(best.map(familyOf)) }
}

// Licence files: what each one contains, read from its wording
const SIGNATURES = [
  ["Apache-2.0", /terms and conditions for use, reproduction,? and distribution/i],
  ["MIT", /permission is hereby granted, free of charge, to any person obtaining a copy of this software/i],
  ["BSD-3-Clause", /neither the name of|names of its contributors may be used/i],
  ["BSD-2-Clause", /redistribution and use in source and binary forms/i],
  [
    "0BSD",
    /permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted\. the software is provided/i,
  ],
  ["ISC", /permission to use, copy, modify, and\/?(or)? distribute this software for any/i],
  ["Unlicense", /free and unencumbered software released into the public domain/i],
  ["Zlib", /altered source versions must be plainly marked/i],
  ["MPL-2.0", /mozilla public license,?\s+(version|v\.)\s*2\.0/i],
  ["OFL-1.1", /sil open font license/i],
  ["Unicode-3.0", /unicode license v3|unicode, inc\. license agreement|unicode license agreement/i],
  ["BSL-1.0", /boost software license/i],
  ["CC0-1.0", /cc0 1\.0 universal|creative commons legal code\s+cc0/i],
  ["LGPL", /gnu lesser general public license/i],
  ["AGPL", /gnu affero general public license/i],
  ["GPL", /gnu general public license/i],
  ["BlueOak-1.0.0", /blue oak model license/i],
  ["Python-2.0", /python software foundation license/i],
  ["CC-BY", /creative commons attribution/i],
]
function detect(text) {
  const flat = text.replace(/\s+/g, " ")
  const found = new Set()
  for (const [id, re] of SIGNATURES) if (re.test(flat)) found.add(id)
  if (found.has("MIT") && !/above copyright notice and this permission notice shall be included/i.test(flat)) {
    found.delete("MIT")
    found.add("MIT-0")
  }
  if (found.has("BSD-3-Clause")) found.delete("BSD-2-Clause")
  if (found.has("MPL-2.0")) for (const id of ["GPL", "LGPL", "AGPL"]) found.delete(id)
  if (found.has("0BSD")) found.delete("ISC")
  if (found.has("LGPL") || found.has("AGPL")) found.delete("GPL")
  return found
}
const matchesChosen = (found, chosen) =>
  chosen.some((id) => {
    const base = id.split(" WITH ")[0]
    if (found.has(base)) return true
    if (base === "BSD" && (found.has("BSD-2-Clause") || found.has("BSD-3-Clause"))) return true
    if (/^LGPL/.test(base) && found.has("LGPL")) return true
    if (/^AGPL/.test(base) && found.has("AGPL")) return true
    if (/^GPL/.test(base) && found.has("GPL")) return true
    if (/^Unicode/.test(base) && found.has("Unicode-3.0")) return true
    if (/^CC-BY/.test(base) && found.has("CC-BY")) return true
    return false
  })

const LICENCE_FILE = /^(licen[cs]e|copying|unlicense|copyright|ofl)([-._].*)?$/i
const NOTICE_FILE = /^notice([-._].*)?$/i

const isCopyrightLine = (line) =>
  (/(copyright\s*(\(c\)|©|[0-9]{4})|^\s*\(c\)\s*[0-9]{4}|©\s*[0-9]{4}|copyright\s+(the|by)\s+\S)/i.test(line) ||
    /^[\s#*/-]*(Copyright|COPYRIGHT)\s+[A-Z]/.test(line)) &&
  !/[[{<](yyyy|year|dates)|copyright owner|copyright holder|copyright (license|licence|convention|act|law|and related|and permission|protection|interest)|free software foundation|copyright notice|copyright \(c\) <year>/i.test(
    line,
  )

const copyrightLines = (text) => [
  ...new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^[#*/\s-]+/, ""))
      .filter((l) => l && l.length < 600 && isCopyrightLine(l)),
  ),
]

function normalise(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => !isCopyrightLine(l) && !/^\s*all rights reserved\.?\s*$/i.test(l))
    .filter((l) => !/^\W*(the\s+)?[\w.\- ]{0,30}licen[cs]e(\s*\([\w.-]+\))?\W*$/i.test(l))
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

const readText = (file) =>
  readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trimEnd()

function licenceFiles(dir) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return { licences: [], notices: [] }
  }
  const files = names.filter((n) => {
    try {
      return statSync(join(dir, n)).isFile()
    } catch {
      return false
    }
  })
  const licences = files
    .filter((n) => LICENCE_FILE.test(n))
    .sort()
    .map((n) => ({ name: n, text: readText(join(dir, n)) }))
  const notices = files
    .filter((n) => NOTICE_FILE.test(n))
    .sort()
    .map((n) => ({ name: n, text: readText(join(dir, n)) }))
  for (const l of licences) l.found = detect(l.text)
  return { licences, notices }
}

// One record per name@version, with the licence it is used under and the texts that go with it
function describe({ ecosystem, name, version, declared, dir, authors, via }) {
  const { licences, notices } = licenceFiles(dir)
  // No usable licence field, so the licence file's wording decides
  const fromFile = !declared || /^see /i.test(declared)
  const detected = [...new Set(licences.flatMap((l) => [...l.found]))]
  const { chosen, family } = choose(fromFile ? detected.join(" OR ") : declared)
  const matched = licences.filter((l) => matchesChosen(l.found, chosen))
  const texts = matched.length ? matched : licences
  // Licences the package names but whose full text it does not ship
  const missing = chosen.filter((id) => !matched.some((l) => matchesChosen(l.found, [id])))
  let copyright = [...new Set(texts.flatMap((t) => copyrightLines(t.text)))]
  let source = missing.length || !texts.length ? "none" : "package"
  if (!copyright.length && knownCopyright(name)) {
    copyright = knownCopyright(name)
    if (missing.length) source = "upstream"
  }
  if (!copyright.length && authors.length) copyright = authors.map((a) => `Copyright (c) ${a}`)
  const shown = fromFile ? `none (licence file reads as ${detected.join(", ") || "unknown"})` : declared
  return { ecosystem, name, version, declared: declared || "", shown, chosen, family, texts, missing, notices, copyright, source, via, dir }
}

// npm: walk the installed tree the way Node resolves it
function findPackage(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, "node_modules", name)
    if (existsSync(join(candidate, "package.json"))) return candidate
    if (dir === ROOT) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"))

function declaredLicence(pkg) {
  if (typeof pkg.license === "string") return pkg.license
  if (pkg.license?.type) return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ")
  return ""
}

const personName = (p) => (typeof p === "string" ? p.replace(/\s*[<(].*$/, "") : p?.name)

function walkNpm(entries) {
  const byKey = new Map()
  const visited = new Set()
  const missing = []
  const queue = entries.map(({ dir, names, label }) => ({ dir, names, via: [label] }))
  while (queue.length) {
    const { dir, names, via } = queue.shift()
    for (const { name, optional } of names) {
      const found = findPackage(name, dir)
      if (!found) {
        if (!optional) missing.push(`${name} (from ${via.join(" > ")})`)
        continue
      }
      if (visited.has(found)) continue
      visited.add(found)
      const pkg = readJson(join(found, "package.json"))
      const key = `${pkg.name}@${pkg.version}`
      if (!OWN.has(pkg.name) && !byKey.has(key)) {
        byKey.set(
          key,
          describe({
            ecosystem: "npm",
            name: pkg.name,
            version: pkg.version,
            declared: declaredLicence(pkg),
            dir: found,
            authors: [personName(pkg.author), ...[].concat(pkg.contributors ?? []).map(personName)].filter(Boolean).slice(0, 3),
            via,
          }),
        )
      }
      queue.push({ dir: found, names: dependencyNames(pkg, false), via: [...via, pkg.name] })
    }
  }
  return { packages: [...byKey.values()], missing }
}

function dependencyNames(pkg, dev) {
  const optionalPeers = pkg.peerDependenciesMeta ?? {}
  const names = [
    ...Object.keys(pkg.dependencies ?? {}).map((name) => ({ name, optional: false })),
    ...Object.keys(pkg.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
    ...Object.keys(pkg.peerDependencies ?? {})
      .filter((name) => !optionalPeers[name]?.optional)
      .map((name) => ({ name, optional: true })),
  ]
  if (dev) names.push(...Object.keys(pkg.devDependencies ?? {}).map((name) => ({ name, optional: false })))
  return names
}

const workspace = (sub) => {
  const dir = sub ? join(ROOT, sub) : ROOT
  return { dir, pkg: readJson(join(dir, "package.json")) }
}
const entry = (sub, label) => {
  const { dir, pkg } = workspace(sub)
  return { dir, label, names: dependencyNames(pkg, false) }
}

// Rust: everything the desktop app links on any platform it ships for
function walkCargo() {
  let meta
  try {
    meta = JSON.parse(
      execFileSync("cargo", ["metadata", "--locked", "--offline", "--format-version", "1"], {
        cwd: TAURI,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }).toString(),
    )
  } catch (error) {
    console.error("cargo metadata failed, so the Rust crates could not be read. Run `cargo fetch` in desktop/src-tauri first.")
    throw error
  }
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]))
  const packages = new Map(meta.packages.map((p) => [p.id, p]))
  const via = new Map([[meta.resolve.root, []]])
  const queue = [meta.resolve.root]
  while (queue.length) {
    const id = queue.shift()
    for (const dep of nodes.get(id).deps) {
      if (!dep.dep_kinds.some((k) => k.kind === null)) continue
      if (via.has(dep.pkg)) continue
      via.set(dep.pkg, [...via.get(id), packages.get(id).name])
      queue.push(dep.pkg)
    }
  }
  return [...via.keys()]
    .filter((id) => id !== meta.resolve.root)
    .map((id) => {
      const p = packages.get(id)
      const dir = dirname(p.manifest_path)
      let declared = p.license ?? ""
      if (!declared && p.license_file) declared = "SEE LICENSE FILE"
      return describe({
        ecosystem: "cargo",
        name: p.name,
        version: p.version,
        declared,
        dir,
        authors: (p.authors ?? []).map(personName).filter(Boolean).slice(0, 3),
        via: via.get(id),
      })
    })
}

// Fonts: read the copyright and licence straight from each font's name table
const WOFF2_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name"]
function base128(buf, at) {
  let value = 0
  for (let i = 0; i < 5; i++) {
    const byte = buf[at.pos++]
    value = value * 128 + (byte & 0x7f)
    if (!(byte & 0x80)) return value
  }
  return value
}
function nameTable(file) {
  const buf = readFileSync(file)
  let table
  if (buf.toString("latin1", 0, 4) === "wOF2") {
    const numTables = buf.readUInt16BE(12)
    const compressed = buf.readUInt32BE(20)
    const at = { pos: 48 }
    let offset = 0
    let nameAt = null
    for (let t = 0; t < numTables; t++) {
      const flags = buf[at.pos++]
      const index = flags & 0x3f
      const transform = flags >> 6
      let tag = WOFF2_TAGS[index] ?? `#${index}`
      if (index === 63) {
        tag = buf.toString("latin1", at.pos, at.pos + 4)
        at.pos += 4
      }
      const original = base128(buf, at)
      const isGlyf = index === 10 || index === 11
      const transformed = isGlyf ? transform === 0 : transform !== 0
      const length = transformed ? base128(buf, at) : original
      if (tag === "name") nameAt = { offset, length }
      offset += length
    }
    if (!nameAt) return {}
    const data = brotliDecompressSync(buf.subarray(at.pos, at.pos + compressed))
    table = data.subarray(nameAt.offset, nameAt.offset + nameAt.length)
  } else {
    const count = buf.readUInt16BE(4)
    for (let t = 0; t < count; t++) {
      const rec = 12 + t * 16
      if (buf.toString("latin1", rec, rec + 4) === "name") {
        const off = buf.readUInt32BE(rec + 8)
        table = buf.subarray(off, off + buf.readUInt32BE(rec + 12))
      }
    }
    if (!table) return {}
  }
  const count = table.readUInt16BE(2)
  const strings = table.readUInt16BE(4)
  const out = {}
  for (let r = 0; r < count; r++) {
    const rec = 6 + r * 12
    const platform = table.readUInt16BE(rec)
    const language = table.readUInt16BE(rec + 4)
    const id = table.readUInt16BE(rec + 6)
    const length = table.readUInt16BE(rec + 8)
    const start = strings + table.readUInt16BE(rec + 10)
    const raw = table.subarray(start, start + length)
    let text
    if (platform === 3 && language === 0x409) text = Buffer.from(raw).swap16().toString("utf16le")
    else if (platform === 1 && language === 0) text = raw.toString("latin1")
    else continue
    if (!out[id] || platform === 3) out[id] = text.trim()
  }
  return out
}

// Fonts whose files carry no licence statement. The licence is the one their upstream project states.
const FONT_UPSTREAM = {
  Excalifont: { licence: "OFL-1.1", note: "stated by Excalidraw, the font file names no licence" },
  Xiaolai: { licence: "OFL-1.1", note: "stated by the upstream project (lxgw/kose-font), the font file names no licence" },
  Liberation: {
    licence: "GPL-2.0 WITH font exception",
    note: "Liberation 1.x, licensed by Red Hat under the GPL version 2 with a font embedding exception. Liberation is a trademark of Red Hat",
    source: "https://github.com/liberationfonts/liberation-fonts",
  },
}

function excalidrawFonts() {
  if (!existsSync(EXCALIDRAW_FONTS)) return []
  return readdirSync(EXCALIDRAW_FONTS)
    .filter((family) => !FONTS_NOT_SERVED.has(family))
    .sort()
    .map((family) => {
      const files = readdirSync(join(EXCALIDRAW_FONTS, family)).filter((f) => /\.(woff2|ttf|otf)$/.test(f))
      const names = nameTable(join(EXCALIDRAW_FONTS, family, files[0]))
      const statement = `${names[0] ?? ""} ${names[13] ?? ""} ${names[14] ?? ""}`
      const read = /open font licen|scripts\.sil\.org\/ofl/i.test(statement)
        ? "OFL-1.1"
        : /mit license|permission is hereby granted/i.test(statement)
          ? "MIT"
          : ""
      const upstream = read ? null : FONT_UPSTREAM[family]
      const copyright = copyrightLines(names[0] ?? "")
      return {
        family,
        files: files.length,
        name: (names[16] ?? names[1] ?? family).replace(/\s+(Regular|Thin|ExtraLight|Light|Medium|SemiBold|Bold|ExtraBold|Black)$/, ""),
        version: (names[5] ?? "").replace(/^Version\s*/i, "").split(";")[0],
        copyright: copyright.length ? copyright : [names[0] ?? ""].filter(Boolean),
        reserved: (names[0] ?? "").match(/reserved font names?\s+["'“]?([^"'”.]+)/i)?.[1]?.trim() ?? "",
        licence: read || upstream?.licence || "unknown",
        note: upstream?.note ?? "read from the font file",
        source: upstream?.source,
      }
    })
}

// Third-party code that @excalidraw/excalidraw bundles into its own files, with the licence comment it carries
function excalidrawBundled() {
  const dir = join(EXCALIDRAW_FONTS, "..")
  const out = []
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .sort()) {
    const text = readFileSync(join(dir, file), "utf8")
    for (const match of text.matchAll(/\/\*\*\s*\n\* The following wasm module[\s\S]*?\*\//g)) {
      const block = match[0].replace(/\r\n/g, "\n")
      out.push({
        name: block.match(/taken from the package "([^"]+)"/)?.[1] ?? "unknown",
        version: block.match(/@version\s+(\S+)/)?.[1] ?? "",
        licence:
          block
            .match(/@license\s+(.+)/)?.[1]
            ?.replace(/.*"type":"([^"]+)".*/, "$1")
            .trim() ?? "",
        text: block
          .replace(/^\/\*\*\s*\n/, "")
          .replace(/\*\/$/, "")
          .replace(/^\* ?/gm, "")
          .trim(),
      })
    }
  }
  return out
}

// Licence texts: one copy of each distinct text, with every package's copyright lines above it
function groupTexts(records) {
  const groups = new Map()
  const add = (record, text) => {
    const hash = createHash("sha256").update(normalise(text.text)).digest("hex").slice(0, 12)
    if (!groups.has(hash)) groups.set(hash, { hash, text: text.text, found: text.found, members: [] })
    const group = groups.get(hash)
    if (!group.members.includes(record)) group.members.push(record)
    return hash
  }
  for (const r of records) r.textIds = r.texts.map((t) => add(r, t))
  // A licence the package names without shipping its text gets the standard text, or the most common copy of it here
  for (const r of records.filter((x) => x.missing.length)) {
    let added = 0
    for (const id of r.missing) {
      if (STANDARD[id]) {
        r.textIds.push(add(r, { text: STANDARD[id], found: new Set([id]) }))
        added++
        continue
      }
      const target = [...groups.values()]
        .filter((g) => g.found.size === 1 && matchesChosen(g.found, [id]))
        .sort((a, b) => b.members.length - a.members.length)[0]
      if (!target) continue
      if (!target.members.includes(r)) target.members.push(r)
      r.textIds.push(target.hash)
      added++
    }
    if (added === r.missing.length) r.source = r.source === "upstream" ? "upstream" : "metadata"
    else r.source = "missing"
  }
  const ordered = [...groups.values()].sort((a, b) => b.members.length - a.members.length || a.text.localeCompare(b.text))
  ordered.forEach((g, i) => (g.number = i + 1))
  return ordered
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim()
const fence = (text) => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const ticks = "`".repeat(longest + 1)
  return `${ticks}text\n${text}\n${ticks}`
}
const label = (r) => (r.chosen.length ? r.chosen.join(" AND ") : "none found")

function counts(records) {
  const out = {}
  for (const r of records) out[r.family] = (out[r.family] ?? 0) + 1
  return out
}
const summaryTable = (rows) =>
  [
    "| Licence family | " + rows.map((r) => r.title).join(" | ") + " |",
    "| --- | " + rows.map(() => "---").join(" | ") + " |",
    ...Object.keys(FAMILY)
      .filter((f) => rows.some((r) => r.counts[f]))
      .map((f) => `| ${FAMILY[f]} | ${rows.map((r) => r.counts[f] ?? 0).join(" | ")} |`),
  ].join("\n")

function packageTable(records, groups) {
  const number = new Map(groups.map((g) => [g.hash, g.number]))
  const lines = ["| Package | Version | Declared licence | Used under | Copyright | Text |", "| --- | --- | --- | --- | --- | --- |"]
  for (const r of [...records].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
    const copyright = r.copyright.length
      ? r.copyright[0] + (r.copyright.length > 1 ? ` (and ${r.copyright.length - 1} more)` : "")
      : "none stated"
    const texts = r.textIds.map((id) => `[${number.get(id)}](#text-${number.get(id)})`).join(", ") || "missing"
    const note =
      {
        metadata: " (standard text, the package ships none)",
        upstream: " (copyright from the upstream repository)",
        missing: " (licence text missing)",
        none: " (licence text missing)",
      }[r.source] ?? ""
    lines.push(
      `| \`${cell(r.name)}\` | ${cell(r.version)} | ${cell(r.shown)} | ${cell(label(r))} | ${cell(copyright.slice(0, 160))} | ${texts}${note} |`,
    )
  }
  return lines.join("\n")
}

function textsSection(groups) {
  const out = []
  for (const g of groups) {
    out.push(`<a id="text-${g.number}"></a>\n\n### Text ${g.number}: ${[...g.found].join(", ") || "other"}\n`)
    out.push("Applies to:\n")
    for (const r of [...g.members].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
      out.push(`- \`${r.name}\` ${r.version}${r.copyright.length ? `: ${r.copyright.join(" / ")}` : ""}`)
    }
    out.push(
      "",
      fence(
        g.text
          .split("\n")
          .filter((l) => !isCopyrightLine(l))
          .join("\n")
          .replace(/^\n+/, ""),
      ),
      "",
    )
  }
  return out.join("\n")
}

function noticesSection(records) {
  const withNotice = records.filter((r) => r.notices.length)
  if (!withNotice.length) return "None of these packages ship a NOTICE file.\n"
  return withNotice
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map((r) => r.notices.map((n) => `### \`${r.name}\` ${r.version}, ${n.name}\n\n${fence(n.text)}\n`).join("\n"))
    .join("\n")
}

function mplSection(records) {
  const mpl = records.filter((r) => r.chosen.some((id) => /^MPL/.test(id)))
  if (!mpl.length) return ""
  return [
    "## Source for MPL-2.0 components\n",
    "These components are covered by the Mozilla Public License 2.0. Nerla uses them without modification. Their source code is available here:\n",
    ...mpl.map((r) =>
      r.ecosystem === "cargo"
        ? `- \`${r.name}\` ${r.version}: https://crates.io/crates/${r.name}/${r.version}`
        : `- \`${r.name}\` ${r.version}: https://www.npmjs.com/package/${r.name}/v/${r.version}`,
    ),
    "",
  ].join("\n")
}

// The website build compares the yarn.lock hash to warn when the notices are older than the dependencies
const fileHash = (file) =>
  existsSync(file) ? createHash("sha256").update(readFileSync(file, "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 16) : "none"
const lockHash = () => `yarn.lock ${fileHash(join(ROOT, "yarn.lock"))}, Cargo.lock ${fileHash(join(TAURI, "Cargo.lock"))}`

const LIVEKIT = `## LiveKit

Nerla's calls are built on the LiveKit client libraries, and the server mints call tokens with the LiveKit server SDK. They are licensed under the Apache License, Version 2.0, and are used without modification. The packages are made by LiveKit, Inc. Keep their licence texts, and this notice, with any copy of Nerla you distribute.
`
const LIVEKIT_SERVER = `## LiveKit

The server mints call tokens with the LiveKit server SDK (\`livekit-server-sdk\`). It is licensed under the Apache License, Version 2.0, and is used without modification. It is made by LiveKit, Inc. Keep its licence text, and this notice, with any copy of the server you distribute.
`

function fontsSection(fonts, ofl, gpl) {
  const lines = [
    "## Fonts\n",
    "The interface fonts come from Fontsource packages and are listed in the package table with their licence texts: Figtree, Atkinson Hyperlegible and JetBrains Mono (all SIL Open Font License 1.1). They are served unmodified.\n",
    "Boards use the fonts that ship inside `@excalidraw/excalidraw` in `dist/prod/fonts`. Every family Nerla serves is listed below (Liberation ships in the package but Nerla doesn't serve it), with the copyright and licence read from the font files themselves. The fonts are used unmodified, are never sold on their own, and keep their names.\n",
    "| Family | Version | Files | Copyright | Reserved font name | Licence | Where the licence comes from |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...fonts.map(
      (f) =>
        `| ${cell(f.name)} | ${cell(f.version)} | ${f.files} | ${cell(f.copyright.join(" / ") || "none stated")} | ${cell(f.reserved || "none")} | ${cell(f.licence)} | ${cell(f.note)} |`,
    ),
    "",
  ]
  const oflFonts = fonts.filter((f) => f.licence === "OFL-1.1")
  if (oflFonts.length && ofl) {
    lines.push(
      `${oflFonts.map((f) => f.name).join(", ")} are licensed under the SIL Open Font License 1.1:\n`,
      fence(
        ofl
          .split("\n")
          .filter((l) => !isCopyrightLine(l))
          .join("\n")
          .replace(/^\n+/, ""),
      ),
      "",
    )
  }
  for (const f of fonts.filter((x) => x.licence === "MIT")) {
    lines.push(`${f.name} is licensed under the MIT licence:\n`, fence([...f.copyright, "", MIT_TEXT].join("\n")), "")
  }
  for (const f of fonts.filter((x) => x.licence.startsWith("GPL"))) {
    lines.push(
      `${f.name} is ${f.note}. The exception reads: as a special exception, if you create a document which uses this font, and embed this font or unaltered portions of this font into the document, this font does not by itself cause the resulting document to be covered by the GNU General Public License. Its source is at ${f.source}.\n`,
      gpl ? fence(gpl) : "The full text of the GPL version 2 is at https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt.\n",
      "",
    )
  }
  return lines.join("\n")
}

function bundledSection(bundled) {
  if (!bundled.length) return ""
  const tick = "`"
  return [
    "## Code bundled inside other packages\n",
    "`@excalidraw/excalidraw` builds these into its own files as WebAssembly. Their licence comments are reproduced as Excalidraw ships them.\n",
    ...bundled.map((b) => `### ${tick}${b.name}${tick} ${b.version} (${b.licence})\n\n${fence(b.text)}\n`),
  ].join("\n")
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const BSD_3_TEXT = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`

const UNLICENSE_TEXT = `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org>`

// Standard texts for licences a package names without shipping the text
const STANDARD = { MIT: MIT_TEXT, "BSD-3-Clause": BSD_3_TEXT, Unlicense: UNLICENSE_TEXT }

function header(title, hash) {
  return `# ${title}

<!-- Generated by \`yarn notices\` (scripts/third-party-notices.mjs). Do not edit by hand. Generated from ${hash} -->
`
}

const RUNTIME = `## Not in the build

These are used but not shipped with Nerla.

- On Windows the desktop app runs in the Microsoft Edge WebView2 runtime, which Windows provides under Microsoft's own terms. It is not part of the Nerla installer.
`

// shadcn/ui components are copied into the source rather than installed, so the package walk never finds them
const SHADCN = `## shadcn/ui

Several components in \`website/src/components/ui\` started from shadcn/ui (https://ui.shadcn.com) and have been changed since. shadcn/ui is licensed under the MIT licence:

${fence(["Copyright (c) 2023 shadcn", "", MIT_TEXT].join("\n"))}
`

function websiteDocument({ web, crates, fonts, bundled, groups, ofl, gpl, hash }) {
  const all = [...web, ...crates]
  return [
    header("Third-party notices", hash),
    "Nerla is released under the MIT licence. It is built on the open source software listed here. This file ships with every website build (as `THIRD_PARTY_NOTICES.md` next to `index.html`) and with the desktop app. Keep it with any copy of Nerla you distribute.\n",
    "The website section lists every package in the website's production dependency tree. The desktop app wraps the same website build, and the desktop section lists every Rust crate it links on Windows, macOS and Linux. Where a package offers a choice of licences, the column `Used under` shows the one Nerla takes. Each package's full licence text is under [Licence texts](#licence-texts), one copy per distinct text with every package's copyright lines above it.\n",
    "The server's licences are in `server/THIRD_PARTY_LICENSES.md`.\n",
    LIVEKIT,
    SHADCN,
    "## Summary\n",
    summaryTable([
      { title: "Website packages", counts: counts(web) },
      { title: "Desktop crates", counts: counts(crates) },
    ]),
    "",
    fontsSection(fonts, ofl, gpl),
    "## Icons, images and sounds\n",
    "Icons come from Phosphor Icons (`@phosphor-icons/react`, MIT), listed below. The cat logo, the app icons, the favicon and the illustrations are Nerla's own. Nerla ships no third-party images or sounds.\n",
    RUNTIME,
    bundledSection(bundled),
    `## Website packages (${web.length})\n`,
    packageTable(web, groups),
    "",
    `## Desktop crates (${crates.length})\n`,
    packageTable(crates, groups),
    "",
    mplSection(all),
    "## NOTICE files\n",
    "These packages ship a NOTICE file, which the Apache License asks to carry with the software.\n",
    noticesSection(all),
    "## Licence texts\n",
    textsSection(groups),
  ].join("\n")
}

const SERVICES = `## Separate services

A Nerla install also runs these programs, each in its own container from its own unmodified upstream image, at the versions pinned in docker-compose.yml and proxy/Dockerfile. Nerla talks to them over the network and does not link, copy or bundle their code, so their licences do not reach Nerla's code.

| Service | Image | Licence |
| --- | --- | --- |
| PostgreSQL | \`postgres\` | PostgreSQL License (permissive) |
| Garage object storage | \`dxflrs/garage\` | AGPL-3.0 |
| LiveKit server | \`livekit/livekit-server\` | Apache-2.0 |
| Caddy (web proxy, with the website build) | \`caddy\` | Apache-2.0 |
| Mailpit (development only) | \`axllent/mailpit\` | MIT |

Garage is licensed under the GNU Affero General Public License v3.0. Nerla runs the official image unmodified and reaches it only through its S3 API. If you modify Garage and let people use your modified version over a network, the AGPL asks you to offer them the source code of your modified version. Garage's source is at https://git.deuxfleurs.fr/Deuxfleurs/garage. Garage can be swapped for any S3-compatible storage by changing the \`S3_*\` settings.

## Server image

The server image is built on the official \`node\` Alpine image, at the version pinned in the Dockerfile. Node.js is MIT licensed and ships the licences of the code it bundles. The Alpine packages in the base image keep their own licences, and their sources are at https://gitlab.alpinelinux.org/alpine/aports. The image also carries every package below in \`node_modules\`, each with its own licence files.
`

function serverDocument({ server, groups, hash }) {
  return [
    header("Third-party licences", hash),
    "Nerla is released under the MIT licence. The Nerla server is built on the open source software listed here. This file ships inside the server image at `/app/server/THIRD_PARTY_LICENSES.md`. Keep it with any copy of the server you distribute.\n",
    "The table lists every package in the server's production dependency tree. Packages built for one platform are listed as installed where this file was generated. The image carries the Linux build of the same package under the same licence. Where a package offers a choice of licences, the column `Used under` shows the one Nerla takes. Each package's full licence text is under [Licence texts](#licence-texts).\n",
    "The website and desktop licences are in `THIRD_PARTY_NOTICES.md`.\n",
    LIVEKIT_SERVER,
    SERVICES,
    "## Summary\n",
    summaryTable([{ title: "Server packages", counts: counts(server) }]),
    "",
    `## Server packages (${server.length})\n`,
    packageTable(server, groups),
    "",
    mplSection(server),
    "## NOTICE files\n",
    "These packages ship a NOTICE file, which the Apache License asks to carry with the software.\n",
    noticesSection(server),
    "## Licence texts\n",
    textsSection(groups),
  ].join("\n")
}

const flagged = (records) =>
  records
    .filter((r) => r.family !== "permissive" && r.family !== "font")
    .map((r) => ({ name: r.name, version: r.version, declared: r.declared, chosen: r.chosen, family: r.family, via: r.via.join(" > ") }))

const ofFamily = (records, family) => records.filter((r) => r.family === family)

function main() {
  const audit = process.argv.includes("--audit")
  const web = walkNpm([entry("website", "website")])
  const server = walkNpm([entry("server", "server")])
  const crates = walkCargo()
  const fonts = excalidrawFonts()
  const oflSource = web.packages.find((r) => r.name === "@fontsource/figtree")?.texts[0]?.text
  const hash = lockHash()

  if (audit) {
    const prodKeys = new Set([...web.packages, ...server.packages].map((r) => `${r.name}@${r.version}`))
    const dev = walkNpm([
      { dir: ROOT, label: "root (dev)", names: dependencyNames(workspace("").pkg, true) },
      { dir: join(ROOT, "website"), label: "website (dev)", names: dependencyNames(workspace("website").pkg, true) },
      { dir: join(ROOT, "server"), label: "server (dev)", names: dependencyNames(workspace("server").pkg, true) },
      { dir: join(ROOT, "desktop"), label: "desktop (dev)", names: dependencyNames(workspace("desktop").pkg, true) },
    ]).packages.filter((r) => !prodKeys.has(`${r.name}@${r.version}`))
    const noFile = (records) =>
      records.filter((r) => !r.texts.length).map((r) => `${r.name}@${r.version} (${r.declared || "no licence field"})`)
    const noField = (records) => records.filter((r) => !r.declared).map((r) => `${r.name}@${r.version}`)
    const declaredCounts = (records) => {
      const out = {}
      for (const r of records) out[label(r)] = (out[label(r)] ?? 0) + 1
      return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]))
    }
    const withNotice = (records) => records.filter((r) => r.notices.length).map((r) => `${r.name}@${r.version}`)
    const choices = (records) =>
      records
        .filter((r) => alternatives(r.declared || "x").length > 1 && r.declared.match(/GPL|MPL|EPL|CDDL|CC-BY/))
        .map((r) => `${r.name}@${r.version}: ${r.declared} -> ${label(r)}`)
    console.log(
      JSON.stringify(
        {
          counts: { website: counts(web.packages), server: counts(server.packages), desktop: counts(crates), dev: counts(dev) },
          totals: { website: web.packages.length, server: server.packages.length, desktop: crates.length, dev: dev.length },
          usedUnder: { website: declaredCounts(web.packages), server: declaredCounts(server.packages), desktop: declaredCounts(crates) },
          flagged: { website: flagged(web.packages), server: flagged(server.packages), desktop: flagged(crates), dev: flagged(dev) },
          choicesAwayFromCopyleft: { website: choices(web.packages), server: choices(server.packages), desktop: choices(crates) },
          noLicenceFile: { website: noFile(web.packages), server: noFile(server.packages), desktop: noFile(crates) },
          noLicenceField: { website: noField(web.packages), server: noField(server.packages), desktop: noField(crates), dev: noField(dev) },
          noticeFiles: { website: withNotice(web.packages), server: withNotice(server.packages), desktop: withNotice(crates) },
          unresolved: { website: web.missing, server: server.missing },
          fonts,
          fontFamilies: ofFamily(web.packages, "font").map((r) => `${r.name}@${r.version}`),
        },
        null,
        2,
      ),
    )
    return
  }

  const webGroups = groupTexts([...web.packages, ...crates])
  writeFileSync(
    join(ROOT, "THIRD_PARTY_NOTICES.md"),
    websiteDocument({
      web: web.packages,
      crates,
      fonts,
      bundled: excalidrawBundled(),
      groups: webGroups,
      ofl: oflSource,
      gpl: readText(join(ROOT, "scripts", "licence-texts", "GPL-2.0.txt")),
      hash,
    }) + "\n",
  )
  const serverGroups = groupTexts(server.packages)
  writeFileSync(
    join(ROOT, "server", "THIRD_PARTY_LICENSES.md"),
    serverDocument({ server: server.packages, groups: serverGroups, hash }) + "\n",
  )
  for (const [label, missing] of [
    ["website", web.missing],
    ["server", server.missing],
  ]) {
    if (missing.length) console.warn(`${label}: ${missing.length} dependencies are not installed: ${missing.join(", ")}`)
  }
  const unlicensed = [...web.packages, ...crates, ...server.packages].filter((r) => !r.textIds.length)
  if (unlicensed.length) console.warn(`No licence text found for: ${unlicensed.map((r) => `${r.name}@${r.version}`).join(", ")}`)
  console.log(`Wrote THIRD_PARTY_NOTICES.md (${web.packages.length} packages, ${crates.length} crates, ${webGroups.length} texts)`)
  console.log(`Wrote server/THIRD_PARTY_LICENSES.md (${server.packages.length} packages, ${serverGroups.length} texts)`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()

// Turns a folder of command output into a support bundle with every secret removed.
// node scripts/support-bundle.mjs <install folder> <bundle folder>
// ./nerla support-bundle writes the docker output into the bundle folder first, then packs it once this has run
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

const [install, bundle] = process.argv.slice(2)
if (!install || !bundle) {
  console.error("Usage: node scripts/support-bundle.mjs <install folder> <bundle folder>")
  process.exit(2)
}

const REMOVED = "[removed]"
const SAFE_KEYS = new Set(["NODE_ENV", "STORAGE_DRIVER", "SITE_ADDRESS", "TRUST_PROXY", "LOG_LEVEL", "TLS_MODE"])
const isSafe = (key) => SAFE_KEYS.has(key) || key.endsWith("_PORT")
// Names whose value is a secret, in logs and config files
const NAMES = "token|pass|secret|key|credential|auth|cookie|private|session"
const SECRET_NAME = new RegExp(NAMES, "i")
// The .env values the last net looks for. Plain ones such as DB_USER or CLIENT_URL stay readable in the logs
const NET_NAME = /secret|key|token|password|pass|private|credential/i

// Exit 3 tells ./nerla the message is already said
function stop(message) {
  console.error(message)
  process.exit(3)
}

const shown = (path) => relative(install, path).replace(/\\/g, "/")

// A file setup wrote as root can't be read without sudo, and a bundle without it would leave a secret unchecked
function fromInstall(path, readIt) {
  try {
    return readIt(path)
  } catch (error) {
    if (error.code !== "EACCES" && error.code !== "EPERM") throw error
    stop(`Nerla can't read ${shown(path)}. Run ./nerla support-bundle with sudo, the way you ran setup.`)
  }
}

function read(path) {
  return existsSync(path) ? fromInstall(path, (file) => readFileSync(file, "utf8").replace(/\r/g, "")) : null
}

function bundleFiles() {
  return readdirSync(bundle, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

// What docker compose reads, and a bit more, so a line it takes is never missed here
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*[=:]\s*(.*)$/

// Where a quoted value ends, with \" inside double quotes read as compose reads it
function closingQuote(raw, quote) {
  for (let i = 1; i < raw.length; i++) {
    if (quote === '"' && raw[i] === "\\") i++
    else if (raw[i] === quote) return i
  }
  return -1
}

// One entry per setting. A quote left open runs on to the line that closes it, or to the end of the file.
// The lines it takes in are kept as swallowed entries too, so a secret on one of them is still netted
function parseEnv(text) {
  const entries = []
  const lines = (text ?? "").split("\n")
  for (let i = 0; i < lines.length; i++) {
    const match = ENV_LINE.exec(lines[i])
    if (!match) continue
    let raw = match[2].trim()
    const quote = /^["']/.test(raw) ? raw[0] : ""
    while (quote && closingQuote(raw, quote) < 0 && i + 1 < lines.length) {
      raw += "\n" + lines[++i]
      const inside = ENV_LINE.exec(lines[i])
      if (inside) entries.push({ key: inside[1], raw: inside[2].trim(), value: inside[2].trim(), swallowed: true })
    }
    let value
    if (quote) {
      const end = closingQuote(raw, quote)
      // raw keeps the escapes, as a log that prints the value as JSON shows them
      raw = end < 0 ? raw.slice(1) : raw.slice(1, end)
      value = quote === '"' ? raw.replace(/\\(.)/gs, (_, char) => (char === "n" ? "\n" : char)) : raw
    } else {
      value = raw.replace(/\s+#.*$/, "").trim()
    }
    entries.push({ key: match[1], raw, value })
  }
  return entries
}

const STRING = String.raw`"(?:[^"\\]|\\.)*"`
// A whole word holding a name. The lookahead finds the name once, so a long word is read once, not once per letter
const NAME = String.raw`(?=[\w-]*?(?:${NAMES}))[\w-]+(?![\w-])`
// Quoted values go first, as a [removed] put in by a later rule would end a JSON array early
// Each rule starts only where a name or scheme can start, so a long run of letters can't make it start over at every one
const LOG_RULES = [
  [new RegExp(String.raw`("${NAME}"\s*:\s*)(?:${STRING}|\[\s*(?:${STRING}\s*(?:,\s*)?)*\])`, "gi"), `$1"${REMOVED}"`],
  [new RegExp(String.raw`(\\"${NAME}\\"\s*:\s*)\\".*?\\"`, "gi"), String.raw`$1\"${REMOVED}\"`],
  // util.inspect and YAML: name: 'value'
  [new RegExp(String.raw`((?<![\w-])${NAME}\s*:\s*)(['"])(?:(?!\2).)*\2`, "gi"), `$1'${REMOVED}'`],
  // The last @ in the run, so a password holding @ or / still goes. A URL with no user name has none before the colon.
  // A URL starts after a space, quote or bracket, and each part is bounded, so a long run of a:// can't make it slow
  [/(?<=^|[\s"'(<=,;[{])([a-z][a-z0-9+.-]*:\/\/)[^\s/:@"'<>]{0,256}:[^\s"'<>]{0,256}@/gi, `$1${REMOVED}@`],
  [/\b(authorization|cookie|set-cookie)(\s*:\s*)(?!["'[])[^\r\n]*/gi, `$1$2${REMOVED}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REMOVED}`],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, REMOVED],
  [/\bnerla_pat_[\w-]+/g, REMOVED],
  // Share links, guest meeting sessions and the share page carry their secret in the path
  [/(\/api\/public\/links\/|\/api\/meetings\/guest-status\/|\/s\/)[^\s/?#"'\\<>]+/g, `$1${REMOVED}`],
  // The whole value goes, a [removed] from an earlier rule included, so no tail after it is left
  [new RegExp(String.raw`((?<![\w-])${NAME})=[^\s&"',;<>]+`, "gi"), `$1=${REMOVED}`],
]

const LINE_CAP = 64 * 1024
function redactLog(text) {
  const capped = text
    .split("\n")
    // The end of the word cut in half goes too, since a secret cut there no longer matches any rule
    .map((line) => (line.length > LINE_CAP ? line.slice(0, LINE_CAP).replace(/[^\s"',;:=&]{1,256}$/, "") + " [line cut at 64 KB]" : line))
    .join("\n")
  return LOG_RULES.reduce((out, [rule, by]) => out.replace(rule, by), capped)
}

function redactEnv(text) {
  return (
    parseEnv(text)
      .filter((entry) => !entry.swallowed)
      .map(({ key, value }) => `${key}=${isSafe(key) ? value : value ? "[set]" : "[empty]"}`)
      .join("\n") + "\n"
  )
}

// A line that doesn't parse is left out, so a secret never slips through on a shape this doesn't know
function redactToml(text) {
  const out = []
  for (const line of text.split("\n")) {
    if (!line.trim() || /^\s*\[[A-Za-z0-9_.-]+\]\s*$/.test(line)) {
      out.push(line)
      continue
    }
    const match = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)
    if (match) out.push(SECRET_NAME.test(line) ? `${match[1]} = ${REMOVED}` : line)
  }
  return out.join("\n") + "\n"
}

function redactYaml(text) {
  const out = []
  let inKeys = -1
  for (const line of text.split("\n")) {
    const indent = line.length - line.trimStart().length
    if (inKeys >= 0 && (!line.trim() || indent > inKeys)) continue
    inKeys = -1
    if (!line.trim()) {
      out.push(line)
      continue
    }
    const match = /^(\s*)([A-Za-z0-9_.-]+):(\s|$)/.exec(line)
    if (!match) continue
    const [, space, key] = match
    if (key === "keys") inKeys = indent
    out.push(SECRET_NAME.test(line) ? `${space}${key}: ${REMOVED}` : line)
  }
  return out.join("\n") + "\n"
}

// Caddy takes secrets as bare words, such as a DNS provider's token or a basic_auth hash, so such a line keeps only its directive.
// A basic_auth block keeps only its braces, as each line in it is a user and a hash
function redactCaddyfile(text) {
  const out = []
  let block = 0
  for (const line of text.split("\n")) {
    const [, space, word] = /^(\s*)(\S*)/.exec(line)
    const depth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (block > 0) {
      block += depth
      if (block <= 0) out.push(`${space}}`)
      continue
    }
    if (/basic_?auth/i.test(line)) {
      out.push(`${space}${word} ${REMOVED}${depth > 0 ? " {" : ""}`)
      block = Math.max(depth, 0)
    } else if (/token|secret|passw|key|credential|auth(?!orit)|\bdns\b|\$2[aby]?\$/i.test(line)) {
      out.push(`${space}${word} ${REMOVED}`)
    } else {
      out.push(line)
    }
  }
  return out.join("\n")
}

// Every file under secrets/, following links, so a nested or linked secret is still checked
function secretFiles(dir, seen = new Set()) {
  const real = fromInstall(dir, realpathSync)
  if (seen.has(real)) return []
  seen.add(real)
  const found = []
  for (const name of fromInstall(dir, readdirSync)) {
    const path = join(dir, name)
    let stat
    try {
      stat = statSync(path)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      stop(`${shown(path)} links to a file that doesn't exist. Fix the link or remove it, then run ./nerla support-bundle again.`)
    }
    if (stat.isDirectory()) found.push(...secretFiles(path, seen))
    else if (name !== ".gitkeep") found.push(path)
  }
  return found
}

const env = read(join(install, ".env"))
const configs = [
  ["env.txt", env, redactEnv],
  ["garage.toml", read(join(install, "garage.toml")), redactToml],
  ["livekit.yaml", read(join(install, "livekit.yaml")), redactYaml],
  ["Caddyfile", read(join(install, "proxy", "Caddyfile")), redactCaddyfile],
]
for (const [name, text, redact] of configs) {
  writeFileSync(join(bundle, name), text === null ? "Not found in the install folder.\n" : redact(text))
}

// Only the names of the secret files, never what is in them
const secretsDir = join(install, "secrets")
const secrets = existsSync(secretsDir) ? secretFiles(secretsDir) : []
writeFileSync(
  join(bundle, "secrets.txt"),
  existsSync(secretsDir) ? (secrets.map((path) => shown(path)).join("\n") || "No files in secrets/.") + "\n" : "No secrets folder.\n",
)

// env.txt holds only [set], [empty] and the safe values, which the name= rule would hide
for (const path of bundleFiles()) {
  if (path !== join(bundle, "env.txt")) writeFileSync(path, redactLog(readFileSync(path, "utf8")))
}

// The last net: any secret from .env or secrets/ still in the bundle is removed, and named so the redaction can be fixed
const known = []
// Each line counts on its own, split at real newlines and at \n escapes, and so does the base64 form of each
const add = (text, from) => {
  for (const value of [text, ...text.split(/\n|\\n/)].map((part) => part.trim())) {
    known.push({ value, from })
    if (value.length >= 8) known.push({ value: Buffer.from(value).toString("base64"), from: `${from}, in base64,` })
  }
}
for (const { key, raw, value } of parseEnv(env)) {
  const from = `the value of ${key} in .env`
  if (!isSafe(key) && NET_NAME.test(key)) {
    add(value, from)
    add(raw, from)
  }
  for (const [, password] of value.matchAll(/:\/\/[^\s/:@]*:(\S*)@/g)) add(password, `the password in ${key} in .env`)
}
for (const path of secrets)
  add(
    fromInstall(path, (file) => readFileSync(file, "utf8")),
    `the contents of ${shown(path)}`,
  )
const net = known.filter(({ value }) => value.length >= 8).sort((a, b) => b.value.length - a.value.length)

for (const path of bundleFiles()) {
  let text = readFileSync(path, "utf8")
  for (const { value, from } of net) {
    if (!text.includes(value)) continue
    text = text.replaceAll(value, REMOVED)
    console.error(`Warning: ${from} was still in ${relative(bundle, path).replace(/\\/g, "/")}, so it was removed.`)
  }
  writeFileSync(path, text)
}

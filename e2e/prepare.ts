/**
 * Gets a fresh e2e stack ready before playwright test: the database nerla_e2e dropped, made again, migrated and
 * seeded, the bucket nerla-e2e emptied with its own key, and the server and website built.
 *
 * Locally it uses the running dev stack (docker compose up -d postgres garage mailpit). CI points it at a throwaway
 * compose project with the E2E_* variables below. Nothing else differs between the two.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseEnv, promisify } from "node:util"
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"
import postgres from "postgres"
import {
  API_URL,
  AUTH_DIR,
  BUCKET,
  DATABASE,
  GARAGE_KEY,
  REPO,
  RUN_DIR,
  RUN_FILE,
  SERVER_DIR,
  SERVER_PORT,
  VITE_BIN,
  WEB_URL,
  WEBSITE_DIR,
  WEBSITE_OUT,
  type Run,
} from "./stack"

/** A problem the user can fix, printed without a stack trace */
class Stop extends Error {}

const run = promisify(execFile)
const secret = (bytes: number) => randomBytes(bytes).toString("hex")
const started = Date.now()
const log = (line: string) => console.log(`[e2e] ${line}`)

const START_STACK = "Start the dev stack with docker compose up -d postgres garage mailpit, then run yarn test:e2e again."

// Locally the user from the root .env, as the server's db tests do
function localPostgres(): string {
  const file = resolve(REPO, ".env")
  const env = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {}
  const url = new URL("postgresql://localhost/postgres")
  url.username = env.DB_USER || "postgres"
  url.password = env.DB_PASSWORD || "postgres"
  url.port = env.DB_PORT || "5432"
  return url.toString()
}

/** The one place local and CI differ. CI sets these to its throwaway stack, locally they name the dev stack */
function services() {
  const value = (name: string) => process.env[name]?.trim() || undefined
  return {
    postgresUrl: value("E2E_POSTGRES_URL") ?? localPostgres(),
    garageContainer: value("E2E_GARAGE_CONTAINER") ?? "nerla-garage",
    garageEndpoint: value("E2E_GARAGE_ENDPOINT") ?? "http://localhost:3900",
    smtpPort: value("E2E_SMTP_PORT") ?? "1025",
    mailpitUrl: value("E2E_MAILPIT_URL") ?? "http://localhost:8025",
  }
}

const where = (url: string) => {
  const parsed = new URL(url)
  return `${parsed.hostname}:${parsed.port || "5432"}`
}

async function freshDatabase(adminUrl: string): Promise<string> {
  const sql = postgres(adminUrl, { max: 1, connect_timeout: 5, onnotice: () => {}, connection: { TimeZone: "UTC" } })
  try {
    await sql`select 1`
  } catch (error) {
    // A refused connection to localhost has no message, only a code
    const reason = (error as Error).message || (error as { code?: string }).code
    throw new Stop(`Postgres at ${where(adminUrl)} did not answer or refused the login (${reason}). ${START_STACK}`)
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {})
  }
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {}, connection: { TimeZone: "UTC" } })
  try {
    await admin`drop database if exists ${admin(DATABASE)} with (force)`
    await admin`create database ${admin(DATABASE)}`
  } finally {
    await admin.end()
  }
  const url = new URL(adminUrl)
  url.pathname = `/${DATABASE}`
  return url.toString()
}

/** The bucket nerla-e2e with its own key, made once and reused. The owner's key and bucket are never named here */
async function storage(container: string, endpoint: string) {
  const garage = async (...args: string[]) => (await run("docker", ["exec", container, "/garage", ...args])).stdout
  try {
    await garage("status")
  } catch {
    throw new Stop(`The Garage container ${container} is not running or does not answer. ${START_STACK}`)
  }

  // A fresh Garage, as in CI, has no layout yet. The dev one has
  const node = /[0-9a-f]{16}/.exec(await garage("status"))?.[0]
  if (node && !(await garage("layout", "show")).includes(node)) {
    await garage("layout", "assign", node, "-z", "dc1", "-c", "1G")
    await garage("layout", "apply", "--version", "1")
  }

  let keyInfo: string
  try {
    keyInfo = await garage("key", "info", "--show-secret", GARAGE_KEY)
  } catch (error) {
    if (!String((error as { stderr?: string }).stderr).includes("0 matching keys")) throw error
    keyInfo = await garage("key", "create", GARAGE_KEY)
  }
  const accessKey = /Key ID:\s*(GK[0-9a-f]+)/i.exec(keyInfo)?.[1]
  const secretKey = /Secret key:\s*([0-9a-f]+)/i.exec(keyInfo)?.[1]
  if (!accessKey || !secretKey) {
    throw new Stop(`Garage did not show the id and secret of the key ${GARAGE_KEY}. Check that it is a Garage 2 container.`)
  }

  try {
    await garage("bucket", "info", BUCKET)
  } catch {
    await garage("bucket", "create", BUCKET)
  }
  await garage("bucket", "allow", "--read", "--write", "--owner", BUCKET, "--key", accessKey)

  // Files from the last run would be left with nothing pointing at them
  const s3 = new S3Client({
    endpoint,
    region: "garage",
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  })
  for (;;) {
    const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET }))
    if (!Contents?.length) break
    await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: Contents.map(({ Key }) => ({ Key })) } }))
  }
  s3.destroy()
  return { accessKey, secretKey }
}

async function checkMailpit(url: string) {
  try {
    const response = await fetch(`${url}/api/v1/info`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch (error) {
    throw new Stop(`Mailpit at ${url} did not answer (${(error as Error).message}). ${START_STACK}`)
  }
}

function serverEnv(databaseUrl: string, stack: ReturnType<typeof services>, keys: { accessKey: string; secretKey: string }) {
  const env: Record<string, string> = {
    NODE_ENV: "test",
    PORT: String(SERVER_PORT),
    CLIENT_URL: WEB_URL,
    TRUST_PROXY: "false",
    LOG_LEVEL: "warn",
    // Every browser in a run comes from 127.0.0.1, so they share one global limit. Credential routes keep theirs
    RATE_LIMIT_MAX: "2000",
    DATABASE_URL: databaseUrl,
    DB_SSL: "false",
    JWT_SECRET: secret(32),
    AI_MASTER_KEY: secret(32),
    S3_ENDPOINT: stack.garageEndpoint,
    S3_REGION: "garage",
    S3_ACCESS_KEY: keys.accessKey,
    S3_SECRET_KEY: keys.secretKey,
    S3_BUCKET: BUCKET,
    EMAIL_HOST: "localhost",
    EMAIL_PORT: stack.smtpPort,
    EMAIL_USER: "test",
    EMAIL_PASS: "test",
    EMAIL_FROM: "Nerla <noreply@nerla.local>",
    EXPOSE_RESET_TOKEN: "false",
    LIVEKIT_API_KEY: "e2e",
    LIVEKIT_API_SECRET: secret(16),
    LIVEKIT_URL: "ws://localhost:7880",
  }
  // Blank, so nothing the shell happens to hold stands in for them
  for (const name of ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME", "S3_FORCE_PATH_STYLE", "STORAGE_DRIVER"]) env[name] = ""
  for (const name of ["LIVEKIT_PUBLIC_URL", "MAX_UPLOAD_MB", "DOC_VERSION_WINDOW_MS"]) env[name] = ""
  for (const name of ["JWT_SECRET", "DATABASE_URL", "DB_PASSWORD", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "AI_MASTER_KEY"])
    env[`${name}_FILE`] = ""
  for (const name of ["S3_ACCESS_KEY", "S3_SECRET_KEY", "EMAIL_PASS"]) env[`${name}_FILE`] = ""
  return env
}

// Builds ---------------------------------------------------------------------------------------------------------

const children = new Set<ChildProcess>()

/** Runs node with the arguments, keeping the output for when it fails */
function quietly(args: string[], cwd: string, env: Record<string, string>): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
    children.add(child)
    let output = ""
    child.stdout?.on("data", (chunk) => (output += chunk))
    child.stderr?.on("data", (chunk) => (output += chunk))
    child.on("error", fail)
    child.on("close", (code) => {
      children.delete(child)
      if (code === 0) done()
      else fail(new Stop(`${output.trim()}\n\nThe command ${args.join(" ")} in ${cwd} failed with exit code ${code}.`))
    })
  })
}

/** The newest change under the given paths, so an unchanged build is skipped */
function newest(path: string, skip: string[]): number {
  if (!existsSync(path) || skip.some((name) => path.endsWith(name))) return 0
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.mtimeMs
  return readdirSync(path).reduce((latest, name) => Math.max(latest, newest(join(path, name), skip)), stat.mtimeMs)
}

async function build(name: string, options: { inputs: string[]; skip?: string[]; output: string; key: string; run: () => Promise<void> }) {
  const stamp = resolve(RUN_DIR, `${name}.stamp`)
  const changed = Math.max(...options.inputs.map((input) => newest(input, options.skip ?? [])))
  const current =
    existsSync(stamp) && existsSync(options.output) && readFileSync(stamp, "utf8") === options.key && statSync(stamp).mtimeMs >= changed
  if (current) return log(`The ${name} build is up to date.`)
  const begun = Date.now()
  await options.run()
  writeFileSync(stamp, options.key)
  // Stamped with the start, so a file saved during the build makes the next run build again
  utimesSync(stamp, begun / 1000, begun / 1000)
  log(`Built the ${name} in ${Math.round((Date.now() - begun) / 1000)} s.`)
}

const lock = resolve(REPO, "yarn.lock")

function buildServer() {
  const tsc = require.resolve("typescript/bin/tsc", { paths: [SERVER_DIR] })
  return build("server", {
    inputs: [resolve(SERVER_DIR, "src"), resolve(SERVER_DIR, "tsconfig.json"), resolve(SERVER_DIR, "package.json"), lock],
    output: resolve(SERVER_DIR, "dist", "index.js"),
    key: "server",
    run: () => {
      // tsc keeps output whose source is gone, and a stale file can shadow a module, such as schema.js over schema/index.js
      rmSync(resolve(SERVER_DIR, "dist"), { recursive: true, force: true })
      return quietly([tsc, "-p", "tsconfig.json"], SERVER_DIR, {})
    },
  })
}

function buildWebsite() {
  // Placeholders for what the journeys never reach. VITE_* already set wins over the website's own .env files
  const env = { VITE_API_URL: API_URL, VITE_LIVEKIT_URL: "ws://localhost:7880", VITE_PRESENCE_IDLE_MS: "" }
  const inputs = ["src", "public", "index.html", "vite.config.ts", "tsconfig.json", "postcss.config.mjs", "package.json"]
  return build("website", {
    inputs: [...inputs.map((input) => resolve(WEBSITE_DIR, input)), lock],
    // The build copies these fonts in again each time
    skip: ["excalidraw-assets"],
    output: resolve(WEBSITE_DIR, WEBSITE_OUT, "index.html"),
    key: JSON.stringify(env),
    run: () => quietly([VITE_BIN, "build", "--outDir", WEBSITE_OUT, "--emptyOutDir", "--logLevel", "warn"], WEBSITE_DIR, env),
  })
}

// ---------------------------------------------------------------------------------------------------------------

async function migrateAndSeed(env: Record<string, string>) {
  // The server's modules read the environment as they load, so it is set before the first import
  Object.assign(process.env, env)
  const { migrate } = await import("../server/src/db/migrate")
  // Its own client, so the notices migrations raise stay out of the output
  const migrator = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {}, connection: { TimeZone: "UTC" } })
  try {
    const { applied } = await migrate(migrator)
    log(`Migrated ${DATABASE} with ${applied.length} migrations.`)
  } finally {
    await migrator.end()
  }

  const { db } = await import("../server/src/db")
  const { seed } = await import("../server/scripts/seed")
  try {
    const [{ name }] = await db.$client<{ name: string }[]>`select current_database() as name`
    if (name !== DATABASE) throw new Stop(`The seed would have run on ${name}, not ${DATABASE}, so it stopped before touching it.`)
    const summary = await seed({ reset: true, storage: true })
    log(`Seeded ${name} with ${summary.counts.users} accounts in 2 workspaces.`)
  } finally {
    await db.$client.end({ timeout: 5 })
  }
}

async function main() {
  if (existsSync(resolve(__dirname, ".env"))) {
    throw new Stop("e2e/.env exists, and the e2e server would read it. Remove it, the harness sets everything itself.")
  }
  mkdirSync(RUN_DIR, { recursive: true })
  const builds = Promise.all([buildServer(), buildWebsite()])
  // Settled at once, so a failed build waits for the steps below instead of ending the process mid-way
  builds.catch(() => {})

  const stack = services()
  await checkMailpit(stack.mailpitUrl)
  const keys = await storage(stack.garageContainer, stack.garageEndpoint)
  log(`Emptied the bucket ${BUCKET} in ${stack.garageContainer}.`)
  const databaseUrl = await freshDatabase(stack.postgresUrl)
  log(`Made the database ${DATABASE} afresh on ${where(stack.postgresUrl)}.`)

  const env = serverEnv(databaseUrl, stack, keys)
  const runFile: Run = { server: env, mailpitUrl: stack.mailpitUrl }
  writeFileSync(RUN_FILE, JSON.stringify(runFile, null, 2), { mode: 0o600 })
  // The cached sessions belong to the accounts of the last seed, signed with its secret
  rmSync(AUTH_DIR, { recursive: true, force: true })

  await migrateAndSeed(env)
  await builds
  log(`Ready in ${Math.round((Date.now() - started) / 1000)} s.`)
}

main().catch((error) => {
  for (const child of children) child.kill()
  console.error(error instanceof Stop ? `[e2e] ${error.message}` : error)
  process.exitCode = 1
})

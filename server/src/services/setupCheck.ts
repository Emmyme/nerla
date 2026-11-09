import { checkConfig, type ConfigProblem } from "../config"
import { pendingMigrations } from "../db/migrate"
import type { jobCounts } from "../jobs/queue"
import { defaultChecks, type Checks } from "./health"
import { livekitPublicUrl } from "../utils/livekitUrl"
import { errorText } from "../utils/errorText"

export type SetupItem = {
  id: string
  status: "ok" | "warning" | "problem"
  title: string
  detail: string
  fix?: { text: string; href?: string }
}

/** `proxyAddress` is the address Fastify took as the visitor's, and `proxyIgnored` is true when it did not read the forwarded header */
export type SetupContext = { forwardedFor?: boolean; proxyIgnored?: boolean; proxyAddress?: string; origin?: string }

type SetupDeps = {
  env: NodeJS.ProcessEnv
  checks: Checks
  pendingMigrations: () => Promise<string[]>
  jobCounts: typeof jobCounts
  /** Problems from reading `NAME_FILE` secrets, which the command line finds before the checks run */
  secretFileProblems: ConfigProblem[]
}

// Every fix links into the setup guide
const SETUP_URL = "https://github.com/Emmyme/nerla/blob/main/SETUP.md"
const guide = (anchor: string) => `${SETUP_URL}#${anchor}`

const RESTART = "then run ./nerla restart server"
const DEFAULT_CLIENT_URL = "http://localhost:3001"
const RANK: Record<SetupItem["status"], number> = { problem: 0, warning: 1, ok: 2 }

// These settings have an item of their own, which says more than the config line would
const COVERED = ["EMAIL_USER", "S3_ACCESS_KEY"]

const CONFIG_GUIDE: Record<string, string> = {
  EMAIL_USER: "email-optional",
  STORAGE_DRIVER: "file-storage",
  S3_ENDPOINT: "file-storage",
  S3_REGION: "file-storage",
  S3_BUCKET: "file-storage",
  S3_FORCE_PATH_STYLE: "file-storage",
  TRUST_PROXY: "proxy-setting",
  CLIENT_URL: "site-address",
}

async function defaultPending(): Promise<string[]> {
  const { db } = await import("../db")
  return pendingMigrations(db.$client)
}

async function defaultJobCounts(): ReturnType<typeof jobCounts> {
  const queue = await import("../jobs/queue")
  return queue.jobCounts()
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, "")
// A mail server can answer over several lines, and each item stays one line on the command line
const oneLine = (text: string | undefined, fallback: string) => text?.replace(/\s+/g, " ").trim() || fallback

function configItems(env: NodeJS.ProcessEnv, fileProblems: ConfigProblem[], context: SetupContext): SetupItem[] {
  const covered = new Set(COVERED)
  if (context.forwardedFor !== undefined) covered.add("TRUST_PROXY")
  if (context.origin !== undefined) covered.add("CLIENT_URL")
  const problems = [
    ...fileProblems,
    ...checkConfig(env).filter((problem) => !fileProblems.some((found) => found.variable === problem.variable)),
  ]
  const items = problems
    .filter((problem) => !covered.has(problem.variable))
    .map<SetupItem>((problem) => ({
      id: `config-${problem.variable}`,
      status: problem.level === "fatal" ? "problem" : "warning",
      title: `The ${problem.variable} setting`,
      detail: problem.message,
      fix: { text: `Change it in .env, ${RESTART}.`, href: guide(CONFIG_GUIDE[problem.variable] ?? "settings-in-env") },
    }))
  return items.length > 0 ? items : [{ id: "config", status: "ok", title: "Settings", detail: "The settings in .env are in order." }]
}

function databaseItem(database: { ok: boolean; error?: string }): SetupItem {
  if (database.ok) return { id: "database", status: "ok", title: "Database", detail: "The database answers." }
  return {
    id: "database",
    status: "problem",
    title: "Database",
    detail: `Nerla can't reach the database: ${oneLine(database.error, "it did not answer")}`,
    fix: {
      text: "Check that postgres runs with ./nerla status, and that DATABASE_URL or the DB_ settings in .env point at it.",
      href: guide("database"),
    },
  }
}

async function migrationsItem(databaseOk: boolean, pending: () => Promise<string[]>): Promise<SetupItem> {
  const base = { id: "migrations", title: "Database updates" }
  const fix = {
    text: `Run ./nerla restart server, which applies them as it starts. If one fails, ./nerla logs server says why.`,
    href: guide("database-updates"),
  }
  if (!databaseOk) {
    return {
      ...base,
      status: "warning",
      detail: "Not checked, because the database can't be reached.",
      fix: { ...fix, text: "Fix the database first, then check again." },
    }
  }
  let names: string[]
  try {
    names = await pending()
  } catch (caught) {
    return {
      ...base,
      status: "problem",
      detail: `Nerla couldn't read its list of database updates: ${oneLine(errorText(caught), "no reason given")}`,
      fix,
    }
  }
  if (names.length === 0) return { ...base, status: "ok", detail: "Every database update has run." }
  const count = names.length === 1 ? "1 database update has" : `${names.length} database updates have`
  return { ...base, status: "problem", detail: `${count} not run yet: ${names.join(", ")}.`, fix }
}

function storageItem(storage: { ok: boolean; warning?: string; error?: string }, local: boolean): SetupItem {
  const base = { id: "storage", title: "File storage" }
  const href = guide("file-storage")
  if (storage.ok && storage.warning) {
    return {
      ...base,
      status: "warning",
      detail: storage.warning,
      fix: { text: "Free some space on the disk, or move files to S3 with ./nerla move-files.", href },
    }
  }
  if (storage.ok)
    return { ...base, status: "ok", detail: local ? "The file storage folder can be written." : "The storage bucket answers." }
  return {
    ...base,
    status: "problem",
    detail: oneLine(storage.error, "The storage bucket did not answer."),
    fix: {
      text: local
        ? `Check that the folder in STORAGE_PATH exists and the server may write to it, ${RESTART}.`
        : `Check S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY in .env, ${RESTART}. If Nerla runs the file storage itself, ./nerla status shows whether it runs.`,
      href,
    },
  }
}

function emailItem(email: { ok: boolean; skipped?: boolean; error?: string }): SetupItem {
  const base = { id: "email", title: "Email" }
  const href = guide("email-optional")
  if (email.ok && email.skipped) {
    return {
      ...base,
      status: "warning",
      detail: "Email is not set up, so Nerla can't send invites or password resets. Invite links still show in the app to send yourself.",
      fix: { text: `Set EMAIL_HOST, EMAIL_USER and EMAIL_PASS in .env, ${RESTART}.`, href },
    }
  }
  if (email.ok) return { ...base, status: "ok", detail: "The mail server accepts Nerla's sign in." }
  return {
    ...base,
    status: "problem",
    detail: `Nerla can't send email: ${oneLine(email.error, "the mail server did not answer")}`,
    fix: { text: `Check EMAIL_HOST, EMAIL_PORT, EMAIL_USER and EMAIL_PASS in .env, ${RESTART}.`, href },
  }
}

const BEHIND_MS = 10 * 60 * 1000

// What each kind of job does, to say what a failure leaves undone. `.*` matches a family of kinds
const JOB_KINDS: Record<string, { means: string; anchor?: string }> = {
  "file-cleanup": {
    means:
      "file-cleanup deletes what has been in the trash for 30 days, old drafts and unused pictures, so until it runs they take up space.",
  },
  "notification-cleanup": {
    means: "notification-cleanup deletes notifications older than 90 days and expires Allow cards nobody answered.",
  },
  "time-jobs": { means: "time-jobs stops timers left running past their limit and fills in days for people with auto-fill on." },
  "revoked-tokens": { means: "revoked-tokens clears out old sign-outs whose sessions have expired anyway." },
  "guest-sessions": { means: "guest-sessions clears out requests from guests waiting to join a call once their time is up." },
  "ai-stale": {
    means: "ai-stale ends AI work left behind by a server that stopped, so until it runs AI answers and Allow cards stay stuck.",
  },
  "status.*": { means: "A status job ends a status at the time it was set to end." },
  "email.*": { means: "An email job sends an invite or a password reset. Check the email settings in .env.", anchor: "email-optional" },
  "storage.delete": {
    means: "storage.delete deletes stored files whose records are gone. The File storage item says whether the file storage answers.",
    anchor: "file-storage",
  },
}

function jobKind(kind: string): { key: string; means: string; anchor?: string } {
  const key = Object.keys(JOB_KINDS).find((name) => (name.endsWith(".*") ? kind.startsWith(name.slice(0, -1)) : kind === name))
  if (key) return { key, ...JOB_KINDS[key] }
  return { key: kind, means: `${kind} is work Nerla does in the background.` }
}

async function backgroundItem(databaseOk: boolean, counts: typeof jobCounts): Promise<SetupItem> {
  const base = { id: "background-jobs", title: "Background jobs" }
  const fix = {
    text: "Check that the server runs with ./nerla status. ./nerla logs server says what it is busy with.",
    href: guide("background-jobs"),
  }
  if (!databaseOk) {
    return {
      ...base,
      status: "warning",
      detail: "Not checked, because the database can't be reached.",
      fix: { ...fix, text: "Fix the database first, then check again." },
    }
  }
  let found: Awaited<ReturnType<typeof jobCounts>>
  try {
    found = await counts()
  } catch (caught) {
    return {
      ...base,
      status: "problem",
      detail: `Nerla couldn't read its background jobs: ${oneLine(errorText(caught), "no reason given")}`,
      fix: { ...fix, text: "Run ./nerla restart server. If it stays, ./nerla logs server says why." },
    }
  }
  if (found.failed.length > 0) {
    const kinds = found.failed.map((failed) => jobKind(failed.kind))
    const lines = found.failed.map(
      ({ kind, count, lastError }) =>
        `${kind} failed ${count === 1 ? "once" : `${count} times`}, last with "${oneLine(lastError, "no reason given").replace(/\.$/, "")}".`,
    )
    const means = [...new Map(kinds.map((kind) => [kind.key, kind.means])).values()]
    return {
      ...base,
      status: "problem",
      detail: `Some background work failed in the last 7 days. ${lines.join(" ")}`,
      fix: {
        text: `${means.join(" ")} ./nerla logs server says more about each failure.`,
        href: guide(kinds.find((kind) => kind.anchor)?.anchor ?? "background-jobs"),
      },
    }
  }
  if (found.oldestPendingMs !== null && found.oldestPendingMs > BEHIND_MS) {
    return { ...base, status: "warning", detail: "Background work is behind. The server may be overloaded or stopped.", fix }
  }
  return { ...base, status: "ok", detail: "Background work runs on time, and none failed in the last 7 days." }
}

function proxyItem(env: NodeJS.ProcessEnv, forwardedFor: boolean, ignored: boolean, address?: string): SetupItem {
  const trusted = !!env.TRUST_PROXY?.trim() && env.TRUST_PROXY.trim() !== "false"
  const base = { id: "proxy", title: "Proxy setting" }
  if (forwardedFor && trusted && ignored) {
    return {
      ...base,
      status: "problem",
      detail: `TRUST_PROXY is set, but the proxy at ${address} is not on a private network, so Nerla ignores it. Every visitor looks like that address.`,
      fix: { text: `Set TRUST_PROXY to ${address} in .env, ${RESTART}.`, href: guide("proxy-setting") },
    }
  }
  if (!forwardedFor || trusted) return { ...base, status: "ok", detail: "Nerla sees each visitor's own address." }
  return {
    ...base,
    status: "problem",
    detail:
      "Requests reach Nerla through a proxy, but TRUST_PROXY is not set. Every visitor looks like one address, so one person's sign in attempts can lock out everyone.",
    fix: { text: `Set TRUST_PROXY=1 in .env, ${RESTART}.`, href: guide("proxy-setting") },
  }
}

function siteItem(env: NodeJS.ProcessEnv, origin: string): SetupItem {
  const clientUrl = trimSlash(env.CLIENT_URL?.trim() || DEFAULT_CLIENT_URL)
  const base = { id: "site-address", title: "Site address" }
  if (trimSlash(origin) === clientUrl) return { ...base, status: "ok", detail: `Links in emails point at ${clientUrl}, where you are now.` }
  return {
    ...base,
    status: "warning",
    detail: `You opened Nerla at ${trimSlash(origin)}, but CLIENT_URL is ${clientUrl}, so links in emails point there.`,
    fix: { text: `Set CLIENT_URL in .env to the address people use, ${RESTART}.`, href: guide("site-address") },
  }
}

function livekitItem(env: NodeJS.ProcessEnv): SetupItem {
  const base = { id: "livekit-address", title: "Call address" }
  if (livekitPublicUrl(env.LIVEKIT_PUBLIC_URL))
    return { ...base, status: "ok", detail: "Calls reach LiveKit at the address in LIVEKIT_PUBLIC_URL." }
  return {
    ...base,
    status: "problem",
    detail: env.LIVEKIT_PUBLIC_URL?.trim()
      ? "LIVEKIT_PUBLIC_URL needs the ws or wss scheme and a host, so calls ignore it and try to reach LiveKit on this computer instead of your server."
      : "LIVEKIT_PUBLIC_URL is empty, so calls try to reach LiveKit on this computer instead of your server.",
    fix: { text: `Set it to wss://<your domain>:7880 in .env, ${RESTART}.`, href: guide("settings-in-env") },
  }
}

/** Every check on the install, problems first. A request adds the items only it can show */
export async function runSetupChecks(context: SetupContext = {}, deps: Partial<SetupDeps> = {}): Promise<SetupItem[]> {
  const env = deps.env ?? process.env
  const checks = deps.checks ?? defaultChecks
  const [database, storage, email] = await Promise.all([checks.database(), checks.storage(), checks.email()])
  const items: SetupItem[] = [
    ...configItems(env, deps.secretFileProblems ?? [], context),
    databaseItem(database),
    await migrationsItem(database.ok, deps.pendingMigrations ?? defaultPending),
    storageItem(storage, env.STORAGE_DRIVER?.trim() === "local"),
    emailItem(email),
    await backgroundItem(database.ok, deps.jobCounts ?? defaultJobCounts),
  ]
  if (env.NODE_ENV?.trim() === "production") items.push(livekitItem(env))
  if (context.forwardedFor !== undefined) items.push(proxyItem(env, context.forwardedFor, !!context.proxyIgnored, context.proxyAddress))
  if (context.origin !== undefined) items.push(siteItem(env, context.origin))
  return items.sort((a, b) => RANK[a.status] - RANK[b.status])
}

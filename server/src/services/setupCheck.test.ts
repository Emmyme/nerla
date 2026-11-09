import { describe, expect, it } from "vitest"
import { checkConfig } from "../config"
import type { jobCounts } from "../jobs/queue"
import type { CheckResult } from "../utils/timedCheck"
import type { Checks } from "./health"
import { runSetupChecks, type SetupContext, type SetupItem } from "./setupCheck"

const CLIENT_URL = "https://nerla.example.com"
const fine: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  JWT_SECRET: "j".repeat(40),
  DATABASE_URL: "postgresql://nerla:a-long-random-password@postgres:5432/nerla", // trufflehog:ignore
  LIVEKIT_API_SECRET: "l".repeat(32),
  AI_MASTER_KEY: "a".repeat(64),
  S3_ENDPOINT: "http://garage:3900",
  S3_REGION: "garage",
  S3_BUCKET: "nerla-files",
  S3_ACCESS_KEY: "GK0123456789abcdef",
  S3_SECRET_KEY: "s".repeat(40),
  EMAIL_USER: "nerla@example.com",
  EMAIL_PASS: "mail-password",
  CLIENT_URL,
  TRUST_PROXY: "1",
  LIVEKIT_PUBLIC_URL: "wss://nerla.example.com:7880",
}

const ok = async (): Promise<CheckResult> => ({ ok: true, ms: 1 })
const skipped = async (): Promise<CheckResult> => ({ ok: true, skipped: true, ms: 0 })
const failing = (error: string) => async (): Promise<CheckResult> => ({ ok: false, ms: 2, error })
const failedJob = (kind: string, lastError: string) => ({ failed: [{ kind, count: 2, lastError }], oldestPendingMs: null })

type Case = {
  env?: NodeJS.ProcessEnv
  checks?: Partial<Checks>
  pending?: string[]
  jobs?: Awaited<ReturnType<typeof jobCounts>>
  context?: SetupContext
  detail?: string
  title?: string
  anchor?: string
}

describe("runSetupChecks", () => {
  it.each<[string, Case, string, SetupItem["status"]]>([
    ["a fatal config problem", { env: { JWT_SECRET: "too-short" } }, "config-JWT_SECRET", "problem"],
    ["a config warning", { env: { AI_MASTER_KEY: "" } }, "config-AI_MASTER_KEY", "warning"],
    ["pending migrations", { pending: ["0007_add_labels"] }, "migrations", "problem"],
    [
      "storage failing",
      { checks: { storage: failing("The specified bucket does not exist") }, detail: "The specified bucket does not exist" },
      "storage",
      "problem",
    ],
    ["storage low on space", { checks: { storage: async () => ({ ok: true, ms: 1, warning: "x" }) }, detail: "x" }, "storage", "warning"],
    ["a storage setting wrong", { env: { S3_FORCE_PATH_STYLE: "yes" }, anchor: "file-storage" }, "config-S3_FORCE_PATH_STYLE", "warning"],
    ["email not set up", { checks: { email: skipped } }, "email", "warning"],
    ["email failing", { checks: { email: failing("Invalid login: 535 Authentication failed") } }, "email", "problem"],
    [
      "a proxy while TRUST_PROXY is unset",
      { env: { TRUST_PROXY: "" }, context: { forwardedFor: true }, title: "Proxy setting" },
      "proxy",
      "problem",
    ],
    [
      "TRUST_PROXY set but the proxy ignored",
      {
        env: { TRUST_PROXY: "1" },
        context: { forwardedFor: true, proxyIgnored: true, proxyAddress: "203.0.113.5" },
        title: "Proxy setting",
      },
      "proxy",
      "problem",
    ],
    ["LIVEKIT_PUBLIC_URL empty in production", { env: { LIVEKIT_PUBLIC_URL: "" } }, "livekit-address", "problem"],
    ["LIVEKIT_PUBLIC_URL without a scheme", { env: { LIVEKIT_PUBLIC_URL: "example.com:7880" } }, "livekit-address", "problem"],
    ["an address other than CLIENT_URL", { context: { origin: "http://192.168.1.20:3001" } }, "site-address", "warning"],
    [
      "a failed email job",
      {
        jobs: failedJob("email.invite", "Invalid login: 535 Authentication failed"),
        detail:
          'Some background work failed in the last 7 days. email.invite failed 2 times, last with "Invalid login: 535 Authentication failed".',
        anchor: "email-optional",
      },
      "background-jobs",
      "problem",
    ],
    [
      "a failed job of a kind it doesn't know",
      { jobs: failedJob("brand-new", "Out of cheese"), anchor: "background-jobs" },
      "background-jobs",
      "problem",
    ],
    [
      "background work more than 10 minutes behind",
      {
        jobs: { failed: [], oldestPendingMs: 11 * 60 * 1000 },
        detail: "Background work is behind. The server may be overloaded or stopped.",
      },
      "background-jobs",
      "warning",
    ],
    ["all fine", { context: { forwardedFor: true, origin: CLIENT_URL }, jobs: { failed: [], oldestPendingMs: 60_000 } }, "*", "ok"],
  ])("%s", async (_name, input, id, status) => {
    const env = { ...fine, ...input.env }
    const items = await runSetupChecks(input.context, {
      env,
      checks: { database: ok, storage: ok, email: ok, ...input.checks },
      pendingMigrations: async () => input.pending ?? [],
      jobCounts: async () => input.jobs ?? { failed: [], oldestPendingMs: null },
    })

    if (id === "*") {
      expect(items.map((item) => item.id).sort()).toEqual([
        "background-jobs",
        "config",
        "database",
        "email",
        "livekit-address",
        "migrations",
        "proxy",
        "site-address",
        "storage",
      ])
      expect(items.every((item) => item.status === status)).toBe(true)
      return
    }
    const item = items.find((found) => found.id === id)
    expect(item?.status).toBe(status)
    expect(item?.fix?.text).toBeTruthy()
    expect(item?.fix?.href).toMatch(/^https:\/\/github\.com\/.+\/SETUP\.md#[a-z-]+$/)
    const ranks = items.map((found) => ["problem", "warning", "ok"].indexOf(found.status))
    expect(ranks).toEqual([...ranks].sort())
    if (input.title) expect(item?.title).toBe(input.title)
    if (input.anchor) expect(item?.fix?.href?.endsWith(`#${input.anchor}`)).toBe(true)
    const variable = id.startsWith("config-") ? id.slice("config-".length) : null
    const expected = variable ? checkConfig(env).find((problem) => problem.variable === variable)?.message : input.detail
    if (expected) expect(item?.detail).toBe(expected)
  })
})

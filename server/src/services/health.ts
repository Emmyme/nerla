import { checkEmail } from "./email"
import { checkStorage } from "./storage"
import { timedCheck, withTimeout, type CheckResult } from "../utils/timedCheck"
import { errorText } from "../utils/errorText"

export type Checks = Record<"database" | "storage" | "email", () => Promise<CheckResult>>
type Readiness = { status: "ok" | "degraded" | "down"; checks: Record<keyof Checks, CheckResult> }

const CACHE_MS = 10_000

async function checkDatabase(): Promise<CheckResult> {
  return timedCheck(async () => {
    // Loaded here so importing this file never needs a database to be configured
    const { db } = await import("../db")
    await db.$client`select 1`
  })
}

export const defaultChecks: Checks = { database: checkDatabase, storage: checkStorage, email: checkEmail }

/** One cached answer per set of checks, so a test with its own checks never sees another's result */
const cache = new WeakMap<Checks, { at: number; answer: Promise<Readiness> }>()

async function settle(check: () => Promise<CheckResult>): Promise<CheckResult> {
  const start = Date.now()
  try {
    return await withTimeout(check())
  } catch (caught) {
    return { ok: false, ms: Date.now() - start, error: errorText(caught) }
  }
}

async function measure(checks: Checks): Promise<Readiness> {
  const [database, storage, email] = await Promise.all([settle(checks.database), settle(checks.storage), settle(checks.email)])
  const status = !database.ok || !storage.ok ? "down" : !email.ok ? "degraded" : "ok"
  return { status, checks: { database, storage, email } }
}

/** Checks the database, storage and email, each limited to 3 s, and keeps the answer for 10 s */
export function readiness(checks: Checks = defaultChecks): Promise<Readiness> {
  const kept = cache.get(checks)
  if (kept && Date.now() - kept.at < CACHE_MS) return kept.answer
  const answer = measure(checks)
  cache.set(checks, { at: Date.now(), answer })
  return answer
}

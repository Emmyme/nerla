export const ONBOARDING_TIPS = ["home", "chat", "calendar", "files", "time", "project", "ai"] as const
export type TipId = (typeof ONBOARDING_TIPS)[number]

/** The getting started steps in the order they show. The last three are for workspace admins only */
const STEP_IDS = ["profile", "task", "event", "message", "doc", "ai", "desktop", "invite", "setup", "aiOn"] as const
export type StepId = (typeof STEP_IDS)[number]

/** Steps the user may skip. The others tick only once done */
export const OPTIONAL_STEPS = ["desktop", "aiOn"] as const satisfies readonly StepId[]
export type OptionalStep = (typeof OPTIONAL_STEPS)[number]

/** Stored on the account. `setupClearAt` and `desktopDone` are written by the server only */
export type Onboarding = {
  welcomeSeenAt?: string
  checklistDismissedAt?: string
  skipped?: OptionalStep[]
  tips?: TipId[]
  desktopDone?: boolean
  setupClearAt?: string
}

export type StepState = "done" | "skipped" | "todo"
export type Step = { id: StepId; state: StepState; optional: boolean }

const isOneOf =
  <T extends string>(list: readonly T[]) =>
  (value: unknown): value is T =>
    list.includes(value as T)
const text = (value: unknown) => (typeof value === "string" ? value : undefined)

/** The stored state, keeping only known keys and values, each list without repeats */
export function onboardingOf(stored: unknown): Onboarding {
  if (!stored || typeof stored !== "object") return {}
  const raw = stored as Record<string, unknown>
  const list = <T extends string>(value: unknown, known: readonly T[]) =>
    Array.isArray(value) ? [...new Set(value.filter(isOneOf(known)))] : []
  return {
    welcomeSeenAt: text(raw.welcomeSeenAt),
    checklistDismissedAt: text(raw.checklistDismissedAt),
    skipped: list(raw.skipped, OPTIONAL_STEPS),
    tips: list(raw.tips, ONBOARDING_TIPS),
    desktopDone: raw.desktopDone === true,
    setupClearAt: text(raw.setupClearAt),
  }
}

/** What the server found the user has done, one flag per step */
type StepFacts = Record<StepId, boolean>

/** The steps the user sees. Asking the AI shows only while the AI is there for them, and the admin steps only for admins */
export function checklistSteps(facts: StepFacts, skipped: readonly OptionalStep[], who: { admin: boolean; ai: boolean }): Step[] {
  const shown = STEP_IDS.filter((id) => (id !== "ai" || who.ai) && (who.admin || !["invite", "setup", "aiOn"].includes(id)))
  return shown.map((id) => {
    const optional = isOneOf(OPTIONAL_STEPS)(id)
    const state: StepState = facts[id] ? "done" : optional && skipped.includes(id) ? "skipped" : "todo"
    return { id, state, optional }
  })
}

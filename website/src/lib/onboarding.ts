import { useSyncExternalStore } from "react"
import { toast } from "sonner"
import { onboardingAPI, type Onboarding, type OnboardingTip, type OptionalStep } from "@/lib/api/users"
import { messageOf } from "@/lib/taskStore"

type OnboardingState = { data: Onboarding | null; error: unknown; welcomeOpen: boolean }

let state: OnboardingState = { data: null, error: null, welcomeOpen: false }
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function update(next: Partial<OnboardingState>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

/** Asks the server again, so steps done since tick off. The welcome cards open on the first answer that says they are unseen */
export function loadOnboarding(): Promise<void> {
  loading ??= onboardingAPI
    .get()
    .then(
      (data) => update({ data, error: null, welcomeOpen: state.welcomeOpen || (!state.data && !data.welcomeSeen) }),
      (error: unknown) => update({ error }),
    )
    .finally(() => {
      loading = null
    })
  return loading
}

/** Shows the change at once and saves it. A failed save puts it back and says so */
async function save(change: Parameters<typeof onboardingAPI.save>[0], local: (data: Onboarding) => Onboarding) {
  const before = state.data
  if (before) update({ data: local(before) })
  try {
    await onboardingAPI.save(change)
  } catch (err) {
    if (before) update({ data: before })
    toast.error(messageOf(err, "Couldn't save that. Try again."))
  }
}

export const openWelcome = () => update({ welcomeOpen: true })

export function closeWelcome() {
  update({ welcomeOpen: false })
  if (state.data && !state.data.welcomeSeen) void save({ welcomeSeen: true }, (data) => ({ ...data, welcomeSeen: true }))
}

export const dismissChecklist = () => save({ checklistDismissed: true }, (data) => ({ ...data, checklistDismissed: true }))

export const skipStep = (id: OptionalStep) =>
  save({ skip: id }, (data) => ({
    ...data,
    steps: data.steps.map((step) => (step.id === id && step.state === "todo" ? { ...step, state: "skipped" } : step)),
  }))

export const dismissTip = (tip: OnboardingTip) => save({ tip }, (data) => ({ ...data, tips: [...data.tips, tip] }))

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useOnboarding(): OnboardingState {
  return useSyncExternalStore(subscribe, () => state)
}

import { Info, X } from "@/components/icons"
import { IconTip } from "@/components/ui/icon-tip"
import type { OnboardingTip } from "@/lib/api/users"
import { useAiTeammate } from "@/lib/aiStore"
import { dismissTip, useOnboarding } from "@/lib/onboarding"
import { chordCaps } from "@/lib/shortcuts"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { cn } from "@/lib/utils"

// Every key named here is in lib/shortcuts.ts
const TIPS: Record<OnboardingTip, (aiName: string) => string> = {
  home: () => "Press C for a new task. In the List view, J and K move between tasks and Enter opens one.",
  chat: () => `Press C to start a new chat. Type @ to mention someone, and ${chordCaps("Shift+Enter")} starts a new line.`,
  calendar: () => "Press C for a new event and N for a new meeting. T brings you back to today.",
  files: () => "Press C to make a paper, a board or a folder, U to upload a file and / to search.",
  time: () => "Log time on any day of your week, or start a timer from a task. Suggestions under each day are there to add with one click.",
  project: () => "Press C for a new task. With a task picked, S, P and A change its status, its priority and who it's assigned to.",
  ai: (name) => `Ask ${name} in your own words, like "what's due this week?". It asks you before it changes anything other people can see.`,
}

// Tips that only name keys, so they wait for a screen wide enough to come with a keyboard
const KEYS_ONLY = new Set<OnboardingTip>(["home", "chat", "calendar", "files", "project"])

/** One line of help at the top of an area, until the user dismisses it */
export function FirstTip({ id, className }: { id: OnboardingTip; className?: string }) {
  const { data } = useOnboarding()
  const aiName = useAiTeammate()?.name ?? "Nerla AI"
  const desktop = useIsDesktop()
  if (!data || data.tips.includes(id) || (!desktop && KEYS_ONLY.has(id))) return null
  return (
    <div
      role="note"
      className={cn("flex items-center gap-2 rounded-md bg-app-sky-soft py-1 pr-1 pl-3 text-ui text-app-sky-ink", className)}
    >
      <Info aria-hidden="true" weight="bold" className="size-4 shrink-0" />
      <p className="min-w-0 flex-1 py-0.5">{TIPS[id](aiName)}</p>
      <IconTip label="Dismiss tip">
        <button
          type="button"
          aria-label="Dismiss tip"
          onClick={() => void dismissTip(id)}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-app-sky-ink transition-colors duration-150 hover:bg-app-sky focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:size-11"
        >
          <X aria-hidden="true" weight="bold" className="size-3.5" />
        </button>
      </IconTip>
    </div>
  )
}

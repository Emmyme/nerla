import { useEffect, useId, useState } from "react"
import { useNavigate } from "react-router"
import { ChevronDown } from "@/components/icons"
import { LoadError } from "@/components/settings/LoadState"
import { Button } from "@/components/ui/button"
import { Collapse } from "@/components/ui/collapse"
import { StatusIcon } from "@/components/ui/status-icon"
import type { OnboardingStepId, OptionalStep } from "@/lib/api/users"
import { useAiTeammate } from "@/lib/aiStore"
import { dismissChecklist, loadOnboarding, skipStep, useOnboarding } from "@/lib/onboarding"
import { readViewPreference, saveViewPreference } from "@/lib/viewPreference"
import { cn } from "@/lib/utils"

const OPEN_KEY = "nerla-getting-started"
const DESKTOP_DOWNLOAD = "https://github.com/Emmyme/nerla/releases/latest"

/** Where each step is done: a page, the new task dialog, or the desktop download */
type Action = { label: string; to?: string; href?: string; newTask?: true }
type StepText = { label: string; hint: string; action: Action }

function stepText(id: OnboardingStepId, aiName: string): StepText {
  switch (id) {
    case "profile":
      return {
        label: "Add a profile picture",
        hint: "So teammates recognise you in chats, tasks and calls.",
        action: { label: "Open profile", to: "/settings/profile" },
      }
    case "task":
      return { label: "Create a task", hint: "Write down something you need to do.", action: { label: "Add a task", newTask: true } }
    case "event":
      return {
        label: "Add an event to your calendar",
        hint: "Plan a meeting or block time for yourself.",
        action: { label: "Open calendar", to: "/calendar" },
      }
    case "message":
      return { label: "Send a chat message", hint: "Say hello to a teammate.", action: { label: "Start a chat", to: "/messages?new=dm" } }
    case "doc":
      return {
        label: "Make a paper or a board",
        hint: "A paper is a page to write in together, a board is a canvas to draw on.",
        action: { label: "Open Files", to: "/files" },
      }
    case "ai":
      return {
        label: `Ask ${aiName} something`,
        hint: "Ask in your own words, like you would ask a teammate.",
        action: { label: "Ask the AI", to: "/messages?ai" },
      }
    case "desktop":
      return {
        label: "Get the desktop app",
        hint: "Nerla in its own window on your computer. This ticks itself the first time you sign in there.",
        action: { label: "Get the app", href: DESKTOP_DOWNLOAD },
      }
    case "invite":
      return {
        label: "Invite your first teammate",
        hint: "Send an invite from Members, and they get a link to join.",
        action: { label: "Open Members", to: "/settings/members" },
      }
    case "setup":
      return {
        label: "Run the setup check",
        hint: "It ticks once file storage and email both work, so uploads are kept and invites arrive.",
        action: { label: "Open setup check", to: "/settings/setup-check" },
      }
    case "aiOn":
      return {
        label: "Turn on the AI teammate",
        hint: "Connect an AI model, so everyone in the workspace can ask it for help.",
        action: { label: "Open AI settings", to: "/settings/workspace-ai" },
      }
  }
}

/** The getting started checklist on Home. Each step ticks from what the server finds, and the list goes for good once done or dismissed */
export function GettingStarted({ onNewTask }: { onNewTask: () => void }) {
  const { data, error } = useOnboarding()
  const aiName = useAiTeammate()?.name ?? "Nerla AI"
  const navigate = useNavigate()
  const [open, setOpen] = useState(() => readViewPreference(OPEN_KEY, "open", ["open", "closed"]) === "open")
  const ids = useId()

  // Steps done elsewhere since the last visit tick off on the way back to Home
  useEffect(() => void loadOnboarding(), [])

  if (!data) return error ? <LoadError message="Couldn't load your getting started list." onRetry={() => void loadOnboarding()} /> : null
  const left = data.steps.filter((step) => step.state === "todo").length
  if (data.checklistDismissed || left === 0) return null
  const total = data.steps.length

  const toggle = () => {
    setOpen(!open)
    saveViewPreference(OPEN_KEY, open ? "closed" : "open")
  }

  return (
    <section aria-labelledby={`${ids}-title`} className="rounded-lg bg-card ring-[0.0625rem] ring-border">
      <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
        <h2 id={`${ids}-title`} className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`${ids}-steps`}
            onClick={toggle}
            className="flex w-full items-center gap-2 rounded-sm text-left focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
          >
            <ChevronDown
              aria-hidden="true"
              weight="bold"
              className={cn("motion-rotate size-[0.75rem] shrink-0 text-muted-foreground", !open && "-rotate-90")}
            />
            <span className="text-ui font-semibold text-foreground">Getting started</span>
            <span className="text-caption font-medium text-muted-foreground tabular-nums">
              {total - left} of {total}
            </span>
          </button>
        </h2>
        <Button type="button" variant="ghost" size="sm" onClick={() => void dismissChecklist()}>
          Dismiss
        </Button>
      </div>
      <Collapse open={open} id={`${ids}-steps`}>
        <ul className="flex flex-col divide-y divide-border border-t border-border">
          {data.steps.map((step) => {
            const { label, hint, action } = stepText(step.id, aiName)
            const todo = step.state === "todo"
            return (
              <li key={step.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                <StatusIcon status={todo ? "todo" : "done"} />
                <div className="min-w-0 flex-1">
                  <p className={cn("text-ui font-medium", todo ? "text-foreground" : "text-muted-foreground line-through")}>{label}</p>
                  {todo && <p className="text-caption text-muted-foreground">{hint}</p>}
                </div>
                {step.state === "skipped" && <span className="text-caption text-muted-foreground">Skipped</span>}
                {todo && step.optional && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => void skipStep(step.id as OptionalStep)}>
                    Skip
                  </Button>
                )}
                {todo &&
                  (action.href ? (
                    <Button asChild variant="outline" size="sm">
                      <a href={action.href} target="_blank" rel="noreferrer">
                        {action.label}
                      </a>
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => (action.newTask ? onNewTask() : action.to && navigate(action.to))}
                    >
                      {action.label}
                    </Button>
                  ))}
              </li>
            )
          })}
        </ul>
      </Collapse>
    </section>
  )
}

import { isTauri } from "@tauri-apps/api/core"
import { useEffect, type MouseEvent } from "react"
import { toast } from "sonner"
import { ArrowSquareOut, CheckCircle, Refresh, Warning, XCircle, type IconComponent } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { SetupItem } from "@/lib/api/setup"
import { loadSetupCheck, problemCount, useSetupCheck } from "@/lib/setupCheck"
import { messageOf } from "@/lib/taskStore"
import { cn } from "@/lib/utils"
import { LoadError, LoadingRows } from "./LoadState"
import { SettingsSection } from "./SettingsSection"

const LOAD_FAILED = "Couldn't run the setup check. Check your connection and try again."

const STATUS: Record<SetupItem["status"], { label: string; icon: IconComponent; tone: string; rank: number }> = {
  problem: { label: "Problem", icon: XCircle, tone: "bg-app-bubblegum-soft text-app-bubblegum-ink", rank: 0 },
  warning: { label: "Warning", icon: Warning, tone: "bg-app-lemon-soft text-app-lemon-ink", rank: 1 },
  ok: { label: "OK", icon: CheckCircle, tone: "bg-app-pistachio-soft text-app-pistachio-ink", rank: 2 },
}

const OPEN_FAILED = "Couldn't open the link."

/** Tauri has no new tabs, so its links go to the system browser */
async function openInSystemBrowser(e: MouseEvent<HTMLAnchorElement>) {
  if (!isTauri()) return
  e.preventDefault()
  const { href } = e.currentTarget
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener")
    await openUrl(href)
  } catch {
    toast.error(OPEN_FAILED)
  }
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

function summary(items: SetupItem[]): string {
  const problems = problemCount(items)
  const warnings = items.filter((item) => item.status === "warning").length
  if (problems + warnings === 0) return "All fine"
  return [problems && count(problems, "problem"), warnings && count(warnings, "warning")].filter(Boolean).join(", ")
}

/** What the install needs fixing, for a workspace admin, each item with how to fix it */
export default function SetupCheck() {
  const { items, error, checking } = useSetupCheck()

  useEffect(() => {
    void loadSetupCheck()
  }, [])

  const again = () => void loadSetupCheck({ again: true })
  const sorted = items && [...items].sort((a, b) => STATUS[a.status].rank - STATUS[b.status].rank)

  return (
    <div className="flex flex-col">
      <SettingsSection
        title="Setup check"
        meta={sorted && !checking ? summary(sorted) : null}
        description="Checks how the server Nerla runs on is set up. Most fixes are one line in the .env file on that server, followed by ./nerla restart."
        action={
          <Button type="button" variant="outline" size="sm" aria-busy={checking || undefined} onClick={() => !checking && again()}>
            <Refresh aria-hidden="true" className={cn("size-[0.9rem]", checking && "motion-safe:animate-spin")} />
            {checking ? "Checking" : "Check again"}
          </Button>
        }
      >
        {error && !checking ? (
          <LoadError message={messageOf(error, LOAD_FAILED)} onRetry={again} />
        ) : !sorted ? (
          <LoadingRows label="Running the setup check" busy={false}>
            <Skeleton className="h-[3.5rem] rounded-lg" />
            <Skeleton className="h-[3.5rem] rounded-lg" />
            <Skeleton className="h-[3.5rem] rounded-lg" />
          </LoadingRows>
        ) : (
          <ul aria-label="Setup check results" aria-busy={checking || undefined} className="flex flex-col divide-y divide-border">
            {sorted.map((item) => (
              <SetupRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  )
}

function SetupRow({ item }: { item: SetupItem }) {
  const { label, icon: Icon, tone } = STATUS[item.status]
  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <span className={cn("mt-0.5 flex size-[1.75rem] shrink-0 items-center justify-center rounded-md", tone)}>
        <Icon aria-hidden="true" weight="bold" className="size-[1rem]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-body font-medium text-foreground">{item.title}</h3>
          <span className={cn("rounded-md px-1.5 text-caption leading-[1.25rem] font-medium", tone)}>{label}</span>
        </div>
        <p className="text-ui leading-[1.5] wrap-anywhere text-muted-foreground">{item.detail}</p>
        {item.fix && (
          <p className="text-ui leading-[1.5] wrap-anywhere text-foreground">
            {item.fix.text}{" "}
            {item.fix.href && (
              <a
                href={item.fix.href}
                onClick={openInSystemBrowser}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline underline-offset-[0.2rem] hover:no-underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:min-h-11"
              >
                How to fix it
                <ArrowSquareOut aria-hidden="true" className="size-[0.85rem]" />
                <span className="sr-only">, opens in a new tab</span>
              </a>
            )}
          </p>
        )}
      </div>
    </li>
  )
}

/** The problem count on the Setup check menu item, read out as words */
export function ProblemBadge({ items }: { items: SetupItem[] | null }) {
  const problems = problemCount(items)
  if (problems === 0) return null
  return (
    <span className="ml-auto shrink-0 rounded-full bg-app-bubblegum-soft px-1.5 text-micro leading-[1.1rem] font-medium text-app-bubblegum-ink tabular-nums">
      <span aria-hidden="true">{problems}</span>
      <span className="sr-only">, {count(problems, "problem")}</span>
    </span>
  )
}

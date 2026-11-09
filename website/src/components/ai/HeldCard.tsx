import { useEffect, useId, useState } from "react"
import { Check } from "@/components/icons"
import { Button } from "@/components/ui/button"
import type { AiHeld, AiHeldItem } from "@/lib/api/ai"
import { parseServerDate } from "@/lib/dates"
import { messageOf } from "@/lib/taskStore"
import { cn } from "@/lib/utils"

const ANSWER_FAILED = "Couldn't send your answer. Try again."

const LABELS: Record<string, string> = {
  title: "Title",
  description: "Description",
  status: "Status",
  priority: "Priority",
  dueDate: "Due",
  content: "Message",
  text: "Text",
  body: "Comment",
  op: "Change",
  start: "Starts",
  end: "Ends",
  all_day: "All day",
  video_call: "Video call",
  date: "Date",
  minutes: "Minutes",
  note: "Note",
  reason: "Why",
  prompt: "Question",
  name: "Name",
  key: "Key",
  color: "Colour",
  plan: "On the board",
}
/** A label one tool reads differently */
const TOOL_LABELS: Record<string, Record<string, string>> = {
  create_paper: { content: "Starting content" },
}
// Free text shows in full, as it will be written
const LONG = new Set(["description", "content", "text", "body", "note", "reason", "prompt", "plan"])
const WORDS = new Set(["status", "priority", "op"])
/**
 * The values each tool's summary already names, such as an id it turns into a name. Everything else shows, so a
 * value no summary covers, or a tool this list doesn't know, is never left off the card
 */
const NAMED: Record<string, string[]> = {
  create_task: ["projectId", "assigneeId"],
  update_task: ["taskId", "projectId", "assigneeId"],
  create_event: ["attendee_ids", "repeat"],
  invite_to_event: ["eventId", "attendee_ids"],
  move_event: ["eventId", "start", "end", "time_zone", "scope", "occurrence"],
  write_doc: ["fileId", "revision", "op", "ref", "from", "to"],
  add_task_comment: ["taskId"],
  create_paper: ["projectId", "folderId"],
  create_board: ["projectId", "folderId"],
  add_to_board: ["fileId", "revision"],
  make_task_line: ["fileId", "revision", "ref", "projectId", "assignee"],
  add_doc_comment: ["fileId", "parentId"],
  post_message: ["kind", "id"],
  log_time: ["projectId", "taskId"],
  delete_task: ["taskId"],
  cancel_event: ["eventId", "scope", "occurrence"],
  delete_doc: ["fileId"],
  delete_file: ["fileId"],
  restore_from_trash: ["kind", "id"],
  // The share and reply cards stay in the place they were asked in, which the reply's summary names
  ask_private: ["place", "replyTo"],
  post_reply: ["place", "replyTo"],
}

/** A change that moves something to Trash, so its card says the way back */
const TO_TRASH = new Set(["delete_task", "cancel_event", "delete_doc", "delete_file"])

type Field = { key: string; label: string; value: string; long: boolean }

const sentence = (text: string) => (text ? text[0].toUpperCase() + text.slice(1).replace(/_/g, " ") : text)

type PlanItem = { id: string; text: string; group?: string }
type Plan = { items?: PlanItem[]; groups?: { id: string; title?: string }[]; connections?: { from: string; to: string; label?: string }[] }

/** A board's content as it reads: each group's items under its title, then what joins what */
function planText(plan: Plan): string {
  const items = plan.items ?? []
  const groups = plan.groups ?? []
  const known = new Set(groups.map((group) => group.id))
  const lines = (list: PlanItem[]) => list.map((item) => `- ${item.text}`)
  const parts = groups.flatMap((group) => {
    const members = items.filter((item) => item.group === group.id)
    return members.length ? [[group.title || "Untitled group", ...lines(members)].join("\n")] : []
  })
  const loose = items.filter((item) => item.group === undefined || !known.has(item.group))
  if (loose.length) parts.push((parts.length ? ["Other", ...lines(loose)] : lines(loose)).join("\n"))
  const textOf = (id: string) => `"${items.find((item) => item.id === id)?.text ?? id}"`
  const links = (plan.connections ?? []).map((link) => `${textOf(link.from)} to ${textOf(link.to)}${link.label ? `, ${link.label}` : ""}`)
  if (links.length) parts.push(["Connections", ...links].join("\n"))
  return parts.join("\n\n")
}

const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2})?)?$/

/** Values that hold a local date or wall time, the only ones read as dates */
const DATE_KEYS = new Set(["start", "end", "dueDate", "date"])

/**
 * A valid local date or wall time as "Thu 5 Nov 2026" or "Thu 5 Nov 2026 14:30", read as written so no zone moves it.
 * Anything else, such as 2026-02-30, stays raw, since the card must show exactly what will run
 */
function wallTimeText(value: string): string | null {
  const match = WALL_TIME.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute] = match.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  if (!real || (match[4] !== undefined && (hour > 23 || minute > 59))) return null
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(date)
  const dayText = `${part({ weekday: "short" })} ${day} ${part({ month: "short" })} ${year}`
  return match[4] === undefined ? dayText : `${dayText} ${match[4]}:${match[5]}`
}

function valueText(key: string, value: unknown): string {
  if (value === null) return "None"
  const wall = typeof value === "string" && DATE_KEYS.has(key) ? wallTimeText(value) : null
  if (wall) return wall
  if (key === "plan" && typeof value === "object") return planText(value as Plan)
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "string") return WORDS.has(key) ? sentence(value) : value
  if (typeof value === "number") return String(value)
  return JSON.stringify(value, null, 2)
}

/** Every value a change runs with, apart from those its summary names */
export function heldFields(tool: string, args: Record<string, unknown>): Field[] {
  const named = new Set(NAMED[tool] ?? [])
  const order = (key: string) => (key === "start" ? 0 : key === "end" ? 1 : 2)
  return Object.entries(args ?? {})
    .filter(([key, value]) => value !== undefined && !named.has(key))
    .sort(([a], [b]) => order(a) - order(b))
    .map(([key, value]) => {
      const text = valueText(key, value)
      const label = TOOL_LABELS[tool]?.[key] ?? LABELS[key] ?? sentence(key)
      return { key, label, value: text, long: LONG.has(key) || typeof value === "object" || text.includes("\n") }
    })
}

function Values({ item }: { item: AiHeldItem }) {
  const fields = heldFields(item.tool, item.args)
  if (fields.length === 0) return null
  return (
    <dl className="flex flex-col gap-1.5 text-ui">
      {fields.map((field) =>
        field.long ? (
          <div key={field.key} className="flex flex-col gap-1">
            <dt className="text-caption font-medium text-muted-foreground">{field.label}</dt>
            <dd>
              {/* Focusable so a keyboard can scroll a long text */}
              <div
                role="group"
                tabIndex={0}
                aria-label={field.label}
                className="max-h-[16rem] overflow-y-auto rounded-md bg-app-sunk px-3 py-2 leading-[1.5] wrap-anywhere whitespace-pre-wrap text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
              >
                {field.value || <span className="text-muted-foreground">Empty</span>}
              </div>
            </dd>
          </div>
        ) : (
          <div key={field.key} className="flex gap-2">
            <dt className="w-[6.5rem] shrink-0 text-muted-foreground">{field.label}</dt>
            <dd className="min-w-0 flex-1 font-medium wrap-anywhere text-foreground">{field.value}</dd>
          </div>
        ),
      )}
    </dl>
  )
}

function TickBox({ checked, onChange, label, children }: { checked: boolean; onChange: () => void; label: string; children: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md text-ui text-foreground">
      <input type="checkbox" checked={checked} onChange={onChange} aria-label={label} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-[1rem] shrink-0 items-center justify-center rounded-sm peer-focus-visible:outline-[0.125rem] peer-focus-visible:outline-offset-[0.125rem] peer-focus-visible:outline-ring",
          checked ? "bg-app-sky text-app-sky-ink" : "ring-[0.125rem] ring-input ring-inset",
        )}
      >
        {checked && <Check weight="bold" className="size-[0.7rem]" />}
      </span>
      <span className="min-w-0 flex-1 leading-[1.45] font-medium wrap-anywhere">{children}</span>
    </label>
  )
}

const MAX_TIMER_MS = 2 ** 31 - 1

function useExpired(held: AiHeld): boolean {
  const ends = parseServerDate(held.expiresAt)?.getTime() ?? 0
  const [past, setPast] = useState(() => Date.now() >= ends)
  useEffect(() => {
    const left = ends - Date.now()
    setPast(left <= 0)
    // A browser fires a timer longer than 2^31 - 1 ms at once, and an expiry that far off can't pass in one visit
    if (left <= 0 || left > MAX_TIMER_MS) return
    const timer = setTimeout(() => setPast(true), left)
    return () => clearTimeout(timer)
  }, [ends])
  return held.status === "expired" || (held.status === "waiting" && past)
}

const titleOf = (held: AiHeld, name: string) => {
  if (held.kind === "share") return `${name} wants to answer with your own things`
  if (held.kind === "reply") return `${name} wants to post this answer`
  return held.items.length === 1 ? `${name} wants to make a change` : `${name} wants to make ${held.items.length} changes`
}

const CLOSED: Partial<Record<AiHeld["status"], string>> = {
  allowed: "Allowed",
  done: "Allowed",
  denied: "Denied",
  failed: "This didn't go through",
}

const REMEMBER_CLOSED: Partial<Record<AiHeld["status"], string>> = {
  allowed: "Remembered",
  done: "Remembered",
  denied: "Not remembered",
  failed: "This didn't go through",
}

/** The one line a Remember card would save, and the saved line it takes the place of */
function rememberOf(held: AiHeld): { text: string; replacing: string | null } | null {
  const [item] = held.items
  if (held.items.length !== 1 || item.tool !== "save_preference" || typeof item.args.text !== "string") return null
  return {
    text: item.args.text,
    replacing: typeof item.args.replacing === "string" && item.args.replaces !== undefined ? item.args.replacing : null,
  }
}

const SHARE_CLOSED: Partial<Record<AiHeld["status"], string>> = {
  allowed: "Shared in chat",
  done: "Shared in chat",
  denied: "Kept private. The answer is in your chat with the AI.",
  failed: "This didn't go through",
}

/**
 * What the AI or an agent waits to do, with every value that runs on Allow. Only the ticked changes run.
 * `aiName` names the AI teammate's cards, an agent's cards carry their token's name
 */
export function HeldCard({
  held,
  onAnswer,
  aiName = "Nerla AI",
  className,
}: {
  held: AiHeld
  onAnswer: (decision: "allow" | "deny", chosen: string[]) => Promise<void>
  aiName?: string
  className?: string
}) {
  const [ticked, setTicked] = useState(() => new Set(held.items.map((item) => item.id)))
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const expired = useExpired(held)
  const titleId = useId()
  const name = held.source === "mcp" ? (held.tokenName ?? "Your agent") : aiName
  const remember = rememberOf(held)
  const changes = held.kind === "changes" && !remember
  const waiting = held.status === "waiting" && !expired
  const closed = expired
    ? "This request timed out"
    : remember
      ? held.error
        ? "This didn't go through"
        : REMEMBER_CLOSED[held.status]
      : held.kind === "share"
        ? SHARE_CLOSED[held.status]
        : CLOSED[held.status]

  const toggle = (id: string) =>
    setTicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const answer = async (decision: "allow" | "deny") => {
    if (busy || (decision === "allow" && changes && ticked.size === 0)) return
    setBusy(decision)
    setError(null)
    try {
      await onAnswer(
        decision,
        changes ? held.items.filter((item) => ticked.has(item.id)).map((item) => item.id) : held.items.map((item) => item.id),
      )
    } catch (err) {
      setError(messageOf(err, ANSWER_FAILED))
    } finally {
      setBusy(null)
    }
  }

  const allowLabel = remember ? "Remember" : held.kind === "share" ? "Share in chat" : "Allow"
  const denyLabel = remember ? "Not now" : held.kind === "share" ? "Keep private" : "Deny"
  const allowBusy = remember ? "Remembering" : held.kind === "share" ? "Sharing" : "Allowing"

  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex flex-col gap-3 rounded-lg bg-card p-3.5 ring-[0.0625rem] ring-border", className)}
    >
      <h3 id={titleId} className="text-body leading-[1.4] font-semibold text-foreground">
        {remember ? "Remember this?" : titleOf(held, name)}
      </h3>
      {remember ? (
        <div className="flex flex-col gap-1.5">
          <p className="rounded-md bg-app-pistachio-soft px-3 py-2 text-ui leading-[1.5] font-medium wrap-anywhere whitespace-pre-wrap text-app-pistachio-ink">
            {remember.text}
          </p>
          {remember.replacing !== null && (
            <p className="text-caption leading-[1.45] wrap-anywhere text-muted-foreground">Instead of: {remember.replacing}</p>
          )}
        </div>
      ) : (
        <ul className="flex flex-col divide-y-[0.0625rem] divide-border">
          {held.items.map((item) => (
            <li key={item.id} className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0">
              {changes ? (
                <TickBox checked={ticked.has(item.id)} onChange={() => waiting && toggle(item.id)} label={item.summary}>
                  {item.summary}
                </TickBox>
              ) : (
                <p className="text-ui leading-[1.45] font-medium wrap-anywhere text-foreground">{item.summary}</p>
              )}
              <div className={cn("flex flex-col gap-2", changes && "pl-6.5")}>
                {TO_TRASH.has(item.tool) && <p className="text-caption text-muted-foreground">You can restore it for 30 days</p>}
                <Values item={item} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-ui text-app-berry-text">
          {error}
        </p>
      )}
      {waiting ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            aria-disabled={!!busy || (changes && ticked.size === 0) || undefined}
            aria-busy={busy === "allow" || undefined}
            onClick={() => void answer("allow")}
          >
            {busy === "allow" ? allowBusy : allowLabel}
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-disabled={!!busy || undefined}
            aria-busy={busy === "deny" || undefined}
            onClick={() => void answer("deny")}
          >
            {denyLabel}
          </Button>
          {changes && held.items.length > 1 && ticked.size < held.items.length && (
            <span className="text-caption text-muted-foreground tabular-nums">
              {ticked.size} of {held.items.length} ticked
            </span>
          )}
        </div>
      ) : (
        closed && (
          <div role="status" className="flex flex-col gap-0.5">
            <p className="text-ui font-medium text-muted-foreground">{closed}</p>
            {held.error && <p className="text-ui leading-[1.45] wrap-anywhere text-app-berry-text">{held.error}</p>}
          </div>
        )
      )}
    </section>
  )
}

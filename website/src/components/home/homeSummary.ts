import { allDayRange, parseDueDate, startOfDay } from "@/lib/dates"

type SummaryEvent = { starts_at: string; ends_at?: string | null; all_day?: boolean; viewer_response?: string | null }
type SummaryTask = { due_date: string | null; status: string }

export const NOTHING_TODAY = "Nothing scheduled today"

function count(n: number, one: string, many: string, rest: string) {
  return `${n} ${n === 1 ? one : many}${rest}`
}

// An event over several days counts on each of them
function coversDay(event: SummaryEvent, day: number): boolean {
  const range = allDayRange({ starts_at: event.starts_at, ends_at: event.ends_at ?? null, all_day: !!event.all_day })
  return !!range && range.first.getTime() <= day && day <= range.last.getTime()
}

export function homeSummary({ events, tasks, now }: { events: SummaryEvent[]; tasks: SummaryTask[]; now: Date }): string {
  const today = startOfDay(now).getTime()
  const eventsToday = events.filter((event) => event.viewer_response !== "no" && coversDay(event, today)).length
  let overdue = 0
  let dueToday = 0
  for (const task of tasks) {
    if (task.status === "done" || task.status === "backlog") continue
    const day = parseDueDate(task.due_date)?.getTime()
    if (day === undefined) continue
    if (day < today) overdue += 1
    else if (day === today) dueToday += 1
  }

  const parts = [
    eventsToday > 0 && count(eventsToday, "event", "events", " today"),
    overdue > 0 && count(overdue, "task", "tasks", " overdue"),
    dueToday > 0 && `${dueToday} due today`,
  ].filter((part): part is string => typeof part === "string")

  return parts.length > 0 ? parts.join(" · ") : NOTHING_TODAY
}

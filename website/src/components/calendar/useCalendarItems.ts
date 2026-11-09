import { useCallback, useMemo } from "react"
import type { CalendarEntry } from "@/lib/api/calendar"
import { entryKey, useCalendarRange, useTeamRange } from "@/lib/calendarStore"
import type { EventType } from "@/lib/eventColors"
import type { CalendarItem, TeamPerson } from "./items"

function toItem(entry: CalendarEntry, person: TeamPerson | null): CalendarItem {
  return { key: entryKey(entry), entry, starts_at: entry.starts_at, ends_at: entry.ends_at, all_day: entry.all_day, person }
}

/**
 * The user's events with the hidden types left out, plus each checked teammate's overlay. A teammate's
 * event that is also on the user's calendar shows once, as the user's own.
 */
export function useCalendarItems(from: Date, to: Date, { hidden, people }: { hidden: ReadonlySet<EventType>; people: TeamPerson[] }) {
  const mine = useCalendarRange(from, to)
  const ids = useMemo(() => people.map((person) => person.id), [people])
  const team = useTeamRange(from, to, ids)

  const items = useMemo(() => {
    const own = mine.events.filter((event) => !hidden.has(event.event_type))
    const shown = new Set(mine.events.map((event) => event.occurrence_id))
    const overlays = people.flatMap((person) =>
      (team.byUser[person.id] ?? []).filter((entry) => entry.busy || !shown.has(entry.occurrence_id)).map((entry) => toItem(entry, person)),
    )
    return [...own.map((event) => toItem(event, null)), ...overlays]
  }, [mine.events, team.byUser, hidden, people])

  // Ready once the user's events and every checked teammate's overlay are in
  const status = mine.status !== "ready" ? mine.status : team.status === "loading" ? "loading" : "ready"
  const { reload: reloadMine } = mine
  const { reload: reloadTeam } = team
  const reload = useCallback(() => Promise.all([reloadMine(), reloadTeam()]), [reloadMine, reloadTeam])

  return { items, status, error: mine.error, reload, unshared: team.unshared }
}

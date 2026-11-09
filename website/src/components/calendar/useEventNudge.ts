import { useEffect, useMemo, useRef, useState } from "react"
import { itemTimes, itemTitle, type CalendarItem } from "@/components/calendar/items"
import { nudgeEvent, type EventTimes, type NudgeKey } from "@/components/calendar/timeMath"
import { withTimes } from "@/components/calendar/useGridPointer"
import { allDayRange, formatDayTitle, formatTime, formatTimeRange } from "@/lib/dates"

// Keyboard moves wait this long for the next key, so holding an arrow saves once
const NUDGE_SAVE_MS = 700

function whenText(item: CalendarItem): string {
  const times = itemTimes(item)
  if (!times) return ""
  if (item.all_day) {
    const range = allDayRange(item)
    return range ? `${formatDayTitle(range.first)}, all day` : ""
  }
  return `${formatDayTitle(times.start)}, ${formatTimeRange(times.start, times.end)}`
}

/**
 * Moves and resizes events by keyboard, shown at once and saved through `changeTimes` once the keys stop.
 * `items` is `loaded` with those moves applied, and `announcement` says each move for screen readers
 */
export function useEventNudge(
  loaded: CalendarItem[],
  changeTimes: (item: CalendarItem, times: EventTimes) => Promise<void>,
  { month }: { month: boolean },
) {
  const [nudged, setNudged] = useState<ReadonlyMap<string, EventTimes>>(new Map())
  const nudgeOriginals = useRef(new Map<string, CalendarItem>())
  const nudgeTimer = useRef<ReturnType<typeof setTimeout>>()
  const [announcement, setAnnouncement] = useState("")

  const items = useMemo(
    () => (nudged.size === 0 ? loaded : loaded.map((item) => (nudged.has(item.key) ? withTimes(item, nudged.get(item.key)!) : item))),
    [loaded, nudged],
  )

  // A drag wins over keyboard moves still waiting to save
  const dropTimes = (item: CalendarItem, times: EventTimes) => {
    if (nudgeOriginals.current.delete(item.key)) {
      setNudged((map) => {
        const next = new Map(map)
        next.delete(item.key)
        return next
      })
    }
    return changeTimes(item, times)
  }

  const focusEvent = (key: string) =>
    requestAnimationFrame(() => {
      const block = document.querySelector<HTMLElement>(`[data-event-key="${CSS.escape(key)}"]:not([data-dragging])`)
      if (block && document.activeElement !== block) block.focus()
    })

  const commitNudges = () => {
    clearTimeout(nudgeTimer.current)
    const pending = [...nudged]
    for (const [key, times] of pending) {
      const original = nudgeOriginals.current.get(key)
      nudgeOriginals.current.delete(key)
      const settled = original ? changeTimes(original, times) : Promise.resolve()
      void settled.finally(() => {
        setNudged((map) => {
          if (map.get(key) !== times) return map
          const next = new Map(map)
          next.delete(key)
          return next
        })
        focusEvent(key)
      })
    }
  }
  const commitRef = useRef(commitNudges)
  commitRef.current = commitNudges

  const nudge = (item: CalendarItem, key: NudgeKey, resize: boolean) => {
    const times = nudgeEvent(item, key, { resize, month })
    if (!times) return
    if (!nudgeOriginals.current.has(item.key)) nudgeOriginals.current.set(item.key, loaded.find((entry) => entry.key === item.key) ?? item)
    setNudged((map) => new Map(map).set(item.key, times))
    const moved = withTimes(item, times)
    const end = itemTimes(moved)?.end
    const lastDay = allDayRange(moved)?.last
    let said = `${itemTitle(item)} moved to ${whenText(moved)}`
    if (resize && item.all_day && lastDay) said = `${itemTitle(item)} now ends on ${formatDayTitle(lastDay)}`
    else if (resize && end) said = `${itemTitle(item)} now ends at ${formatTime(end)}`
    setAnnouncement(said)
    focusEvent(item.key)
    clearTimeout(nudgeTimer.current)
    nudgeTimer.current = setTimeout(() => commitRef.current(), NUDGE_SAVE_MS)
  }

  // Leaving the page saves keyboard moves still waiting
  useEffect(() => () => commitRef.current(), [])

  return { items, dropTimes, nudge, announcement }
}

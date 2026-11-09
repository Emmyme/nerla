// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { ApiError } from "@/lib/api/request"
import type { CalendarEvent } from "@/lib/api/calendar"

const api = vi.hoisted(() => ({
  getRange: vi.fn(),
  getTeamRange: vi.fn(),
  updateEvent: vi.fn(),
  createEvent: vi.fn(),
  deleteEvent: vi.fn(),
}))
const socket = vi.hoisted(() => ({ changed: [] as ((data: { eventId: string }) => void)[], reconnected: new Set<() => void>() }))

vi.mock("@/lib/api/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/calendar")>()),
  calendarAPI: api,
}))
vi.mock("@/lib/socket", () => ({
  onCalendarChanged: (callback: (data: { eventId: string }) => void) => {
    socket.changed.push(callback)
    return () => {
      socket.changed = socket.changed.filter((c) => c !== callback)
    }
  },
  onSocketReconnect: (callback: () => void) => {
    socket.reconnected.add(callback)
    return () => socket.reconnected.delete(callback)
  },
}))

import { mutateEvent, resetCalendarStore, useCalendarRange, useTeamRange } from "./calendarStore"

function event(id: string, start: Date, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    occurrence_id: id,
    series_id: null,
    original_start: null,
    title: id,
    description: null,
    location: null,
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 3_600_000).toISOString(),
    all_day: false,
    event_type: "meeting",
    video_call: false,
    everyone: false,
    recurrence_rule: null,
    recurrence_tz: null,
    reminder_minutes: 10,
    created_by: "me",
    organizer: { id: "me", first_name: null, last_name: null, avatar_url: null },
    calendar_user_id: "me",
    attendees: [],
    viewer_response: null,
    created_at: "2026-10-20T10:00:00.000Z",
    updated_at: "2026-10-20T10:00:00.000Z",
    ...overrides,
  }
}

const nine = new Date(2026, 9, 23, 9, 0)
const range = (from: Date, days: number) => ({ from, to: new Date(from.getFullYear(), from.getMonth(), from.getDate() + days) })

beforeEach(() => {
  resetCalendarStore()
  vi.resetAllMocks()
  socket.changed = []
  socket.reconnected.clear()
})

describe("useCalendarRange", () => {
  it("fetches whole weeks once, then serves days of a cached week without a request", async () => {
    api.getRange.mockResolvedValue([event("a", nine)])
    const { result, rerender } = renderHook(({ from, to }) => useCalendarRange(from, to), { initialProps: range(new Date(2026, 9, 23), 1) })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.events.map((e) => e.id)).toEqual(["a"])
    expect(api.getRange).toHaveBeenCalledWith(new Date(2026, 9, 19).toISOString(), new Date(2026, 9, 26).toISOString())

    rerender(range(new Date(2026, 9, 21), 1))
    expect(result.current.status).toBe("ready")
    expect(result.current.events).toEqual([])
    rerender(range(new Date(2026, 9, 26), 14))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(api.getRange).toHaveBeenCalledTimes(2)
    expect(api.getRange).toHaveBeenLastCalledWith(new Date(2026, 9, 26).toISOString(), new Date(2026, 10, 9).toISOString())
  })

  it("reloads once after a burst of calendar changes", async () => {
    api.getRange.mockResolvedValue([event("a", nine)])
    renderHook(() => useCalendarRange(new Date(2026, 9, 19), new Date(2026, 10, 2)))
    await waitFor(() => expect(api.getRange).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()
    try {
      act(() => socket.changed.forEach((callback) => [1, 2, 3].forEach(() => callback({ eventId: "x" }))))
      await act(() => vi.advanceTimersByTimeAsync(299))
      expect(api.getRange).toHaveBeenCalledTimes(1)
      await act(() => vi.advanceTimersByTimeAsync(1))
      expect(api.getRange).toHaveBeenCalledTimes(2)
      await act(() => vi.advanceTimersByTimeAsync(5000))
      expect(api.getRange).toHaveBeenCalledTimes(2)
      // Changes missed while the socket was down show up after it reconnects
      act(() => socket.reconnected.forEach((callback) => callback()))
      await act(() => vi.advanceTimersByTimeAsync(300))
      expect(api.getRange).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("mutateEvent", () => {
  it("keeps the optimistic value through a refetch while the save is pending", async () => {
    api.getRange.mockResolvedValue([event("a", nine)])
    let finish: (saved: CalendarEvent) => void = () => {}
    api.updateEvent.mockReturnValue(new Promise<CalendarEvent>((resolve) => (finish = resolve)))
    const { result } = renderHook(() => useCalendarRange(new Date(2026, 9, 19), new Date(2026, 9, 26)))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    let pending: Promise<string | null> = Promise.resolve(null)
    act(() => {
      pending = mutateEvent({ type: "update", event: result.current.events[0], patch: { title: "Planning" } })
    })
    expect(result.current.events[0].title).toBe("Planning")
    await act(() => result.current.reload())
    expect(api.getRange).toHaveBeenCalledTimes(2)
    expect(result.current.events[0].title).toBe("Planning")

    let resolved: string | null = "unset"
    await act(async () => {
      finish(event("a", nine, { title: "Planning", updated_at: "2026-10-23T08:00:00.000Z" }))
      resolved = await pending
    })
    expect(resolved).toBeNull()
    expect(result.current.events[0].title).toBe("Planning")
  })

  it("rolls a rejected move back and resolves with the server message", async () => {
    api.getRange.mockResolvedValue([event("a", nine)])
    api.updateEvent.mockRejectedValue(new ApiError(403, { error: "Only the event creator or an admin can edit this event" }))
    const { result } = renderHook(() => useCalendarRange(new Date(2026, 9, 19), new Date(2026, 9, 26)))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    const later = new Date(2026, 9, 23, 11, 0)
    let resolved: string | null = null
    await act(async () => {
      resolved = await mutateEvent({
        type: "update",
        event: result.current.events[0],
        patch: { starts_at: later.toISOString(), ends_at: new Date(later.getTime() + 3_600_000).toISOString() },
      })
    })
    expect(resolved).toBe("Only the event creator or an admin can edit this event")
    expect(result.current.events[0].starts_at).toBe(nine.toISOString())
  })
})

describe("mutateEvent on a series", () => {
  it("keeps an all-events edit on screen until the reload brings the server copy, moved by wall-clock days", async () => {
    const series = (id: string, start: Date, title: string) =>
      event("s", start, { occurrence_id: id, series_id: "s", original_start: start.toISOString(), recurrence_rule: "FREQ=DAILY", title })
    const sat = new Date(2026, 9, 24, 9, 0)
    const mon = new Date(2026, 9, 26, 9, 0)
    let answer: (events: CalendarEvent[]) => void = () => {}
    api.getRange
      .mockResolvedValueOnce([series("s:1", sat, "Standup"), series("s:2", mon, "Standup")])
      .mockReturnValueOnce(new Promise<CalendarEvent[]>((resolve) => (answer = resolve)))
    api.updateEvent.mockResolvedValue({ id: "s" })
    const { result } = renderHook(() => useCalendarRange(new Date(2026, 9, 19), new Date(2026, 10, 2)))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    const ten = new Date(2026, 9, 25, 10, 0)
    let pending: Promise<string | null> = Promise.resolve(null)
    act(() => {
      pending = mutateEvent({
        type: "update",
        event: result.current.events[0],
        patch: { title: "Daily", starts_at: ten.toISOString(), ends_at: new Date(ten.getTime() + 3_600_000).toISOString() },
        scope: "all",
      })
    })
    await waitFor(() => expect(api.getRange).toHaveBeenCalledTimes(2))
    expect(result.current.events.map((e) => [e.title, e.starts_at])).toEqual([
      ["Daily", ten.toISOString()],
      ["Daily", new Date(2026, 9, 27, 10, 0).toISOString()],
    ])

    let resolved: string | null = "unset"
    await act(async () => {
      answer([series("s:1", ten, "Server"), series("s:2", new Date(2026, 9, 27, 10, 0), "Server")])
      resolved = await pending
    })
    expect(resolved).toBeNull()
    expect(result.current.events.map((e) => e.title)).toEqual(["Server", "Server"])
  })
})

describe("mutateEvent follow-up reloads", () => {
  const series = (id: string, start: Date, title: string) =>
    event("n", start, { occurrence_id: id, series_id: "n", original_start: start.toISOString(), recurrence_rule: "FREQ=DAILY", title })
  const useWeek = () => useCalendarRange(new Date(2026, 9, 19), new Date(2026, 9, 26))

  it("shows a new repeating event once while its occurrences load", async () => {
    let answer: (events: CalendarEvent[]) => void = () => {}
    api.getRange.mockResolvedValueOnce([]).mockReturnValueOnce(new Promise<CalendarEvent[]>((resolve) => (answer = resolve)))
    api.createEvent.mockResolvedValue(series("n:1", nine, "Standup"))
    const { result } = renderHook(useWeek)
    await waitFor(() => expect(result.current.status).toBe("ready"))

    const body = {
      title: "Standup",
      starts_at: nine.toISOString(),
      ends_at: new Date(nine.getTime() + 3_600_000).toISOString(),
      recurrence_rule: "FREQ=DAILY",
      recurrence_tz: "Europe/Stockholm",
    }
    let pending: Promise<string | null> = Promise.resolve(null)
    act(() => {
      pending = mutateEvent({ type: "create", body, userId: "me" })
    })
    expect(result.current.events).toHaveLength(1)
    await waitFor(() => expect(api.getRange).toHaveBeenCalledTimes(2))
    expect(result.current.events.map((e) => e.occurrence_id)).toEqual(["n:1"])

    await act(async () => {
      answer([series("n:1", nine, "Standup"), series("n:2", new Date(2026, 9, 24, 9, 0), "Standup")])
      await pending
    })
    expect(result.current.events.map((e) => e.occurrence_id)).toEqual(["n:1", "n:2"])
  })

  it("shows every occurrence when a one-off event becomes repeating", async () => {
    api.getRange
      .mockResolvedValueOnce([event("n", nine, { title: "Standup" })])
      .mockResolvedValueOnce([series("n:1", nine, "Standup"), series("n:2", new Date(2026, 9, 24, 9, 0), "Standup")])
    api.updateEvent.mockResolvedValue(series("n:1", nine, "Standup"))
    const { result } = renderHook(useWeek)
    await waitFor(() => expect(result.current.status).toBe("ready"))

    await act(async () => {
      await mutateEvent({
        type: "update",
        event: result.current.events[0],
        patch: { recurrence_rule: "FREQ=DAILY", recurrence_tz: "Europe/Stockholm" },
      })
    })
    expect(api.getRange).toHaveBeenCalledTimes(2)
    expect(result.current.events.map((e) => e.occurrence_id)).toEqual(["n:1", "n:2"])
  })

  it("deletes an event still saving once the save returns its id, and sends nothing when the save fails", async () => {
    const saves: { resolve: (saved: CalendarEvent) => void; reject: (error: Error) => void }[] = []
    api.getRange.mockResolvedValue([])
    api.createEvent.mockImplementation(() => new Promise((resolve, reject) => saves.push({ resolve, reject })))
    api.deleteEvent.mockResolvedValue({ kind: "event", id: "e1" })
    const { result } = renderHook(useWeek)
    await waitFor(() => expect(result.current.status).toBe("ready"))
    const body = { title: "Lunch", starts_at: nine.toISOString(), ends_at: new Date(nine.getTime() + 3_600_000).toISOString() }

    for (const outcome of ["saved", "failed"] as const) {
      let created: Promise<string | null> = Promise.resolve(null)
      let deleted: Promise<string | null> = Promise.resolve(null)
      act(() => {
        created = mutateEvent({ type: "create", body, userId: "me" })
      })
      act(() => {
        deleted = mutateEvent({ type: "delete", event: result.current.events[0] })
      })
      expect(result.current.events).toEqual([])
      await act(async () => {
        if (outcome === "saved") saves[saves.length - 1].resolve(event("e1", nine, { title: "Lunch" }))
        else saves[saves.length - 1].reject(new TypeError("Failed to fetch"))
        // A save that fails after the delete shows no error for an event the user removed
        expect(await created).toBeNull()
        expect(await deleted).toBeNull()
      })
      expect(result.current.events).toEqual([])
    }
    expect(api.deleteEvent.mock.calls).toEqual([["e1", undefined]])
  })

  it("retries once through the coalesced reload when the follow-up reload fails", async () => {
    api.getRange
      .mockResolvedValueOnce([series("n:1", nine, "Standup")])
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce([series("n:1", nine, "Daily")])
    api.updateEvent.mockResolvedValue({ id: "n" })
    const { result } = renderHook(useWeek)
    await waitFor(() => expect(result.current.status).toBe("ready"))

    let resolved: string | null = "unset"
    await act(async () => {
      resolved = await mutateEvent({ type: "update", event: result.current.events[0], patch: { title: "Daily" }, scope: "all" })
    })
    expect(resolved).toBeNull()
    await waitFor(() => expect(api.getRange).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(result.current.events[0].title).toBe("Daily"))
  })
})

describe("useTeamRange", () => {
  it("asks for all new users in one request and only for the user just added", async () => {
    api.getTeamRange.mockImplementation(async (_start: string, _end: string, users: string[]) =>
      Object.fromEntries(users.filter((id) => id !== "private").map((id) => [id, [event(`${id}-1`, nine, { calendar_user_id: id })]])),
    )
    const week = range(new Date(2026, 9, 19), 7)
    const { result, rerender } = renderHook(({ users }) => useTeamRange(week.from, week.to, users), {
      initialProps: { users: ["ann", "private"] },
    })
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(api.getTeamRange).toHaveBeenCalledTimes(1)
    expect(result.current.events.map((e) => e.id)).toEqual(["ann-1"])
    expect(result.current.unshared).toEqual(["private"])

    rerender({ users: ["ann", "private", "bo"] })
    await waitFor(() => expect(result.current.events).toHaveLength(2))
    expect(api.getTeamRange).toHaveBeenCalledTimes(2)
    expect(api.getTeamRange.mock.calls[1][2]).toEqual(["bo"])
  })

  it("keeps an admin's move and delete of a teammate's event in Team view and off the admin's own calendar", async () => {
    const theirs = (id: string, title = id) => event(id, nine, { title, created_by: "ann", calendar_user_id: "ann" })
    let server = [theirs("t1"), theirs("t2")]
    const nextWeek = new Date(2026, 9, 27, 9)
    const renamed = {
      ...theirs("t1", "Renamed"),
      starts_at: nextWeek.toISOString(),
      ends_at: new Date(nextWeek.getTime() + 3_600_000).toISOString(),
      updated_at: "2026-10-23T08:00:00.000Z",
    }
    api.getRange.mockResolvedValue([])
    api.getTeamRange.mockImplementation(async () => ({ ann: server }))
    api.updateEvent.mockImplementation(async () => {
      server = [renamed, server[1]]
      return renamed
    })
    api.deleteEvent.mockImplementation(async () => {
      server = server.filter((e) => e.id !== "t2")
    })
    const weeks = range(new Date(2026, 9, 19), 14)
    const { result } = renderHook(() => ({
      mine: useCalendarRange(weeks.from, weeks.to),
      team: useTeamRange(weeks.from, weeks.to, ["ann"]),
    }))
    await waitFor(() => expect(result.current.team.status).toBe("ready"))
    const [first, second] = result.current.team.events as CalendarEvent[]

    await act(async () => {
      await mutateEvent({
        type: "update",
        event: first,
        patch: { title: "Renamed", starts_at: renamed.starts_at, ends_at: renamed.ends_at },
      })
    })
    let pending: Promise<string | null> = Promise.resolve(null)
    act(() => {
      pending = mutateEvent({ type: "delete", event: second })
    })
    expect(result.current.team.events.map((e) => (e.busy ? "" : [e.title, e.starts_at]))).toEqual([["Renamed", renamed.starts_at]])
    await act(() => pending)
    expect(result.current.team.events.map((e) => (e.busy ? "" : [e.title, e.calendar_user_id]))).toEqual([["Renamed", "ann"]])
    expect(result.current.mine.events).toEqual([])
  })
})

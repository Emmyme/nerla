import { FirstTip } from "@/components/onboarding/FirstTip"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { CalendarSide, MAX_TEAM, type TeamSelection } from "@/components/calendar/CalendarSide"
import { CalendarSideSheet, SideColumn } from "@/components/calendar/CalendarSideSheet"
import { CalendarToolbar } from "@/components/calendar/CalendarToolbar"
import { EventDetailsPopover } from "@/components/calendar/EventDetailsPopover"
import { eventRights, itemTimes, type CalendarItem } from "@/components/calendar/items"
import { useDiscardGuard } from "@/components/calendar/DiscardDialog"
import {
  draftBody,
  draftChanged,
  draftFromEvent,
  draftPatch,
  duplicateDraft,
  newDraft,
  ruleFollowsOnly,
  type EventDraft,
} from "@/components/calendar/draft"
import { EventEditor } from "@/components/calendar/EventEditor"
import { QuickCreatePopover } from "@/components/calendar/QuickCreatePopover"
import { useRecurrenceScope } from "@/components/calendar/RecurrenceScopeDialog"
import { nextFreeHalfHour, type EventTimes, type Range } from "@/components/calendar/timeMath"
import { TYPE_VALUES, useCalendarLinks } from "@/components/calendar/useCalendarLinks"
import { useCalendarItems } from "@/components/calendar/useCalendarItems"
import { useEventNudge } from "@/components/calendar/useEventNudge"
import { MonthView } from "@/components/calendar/MonthView"
import { ScheduleView } from "@/components/calendar/ScheduleView"
import { useToday } from "@/components/calendar/useNow"
import { WeekGrid } from "@/components/calendar/WeekGrid"
import { useRegisterCommands, type Command } from "@/components/command/registry"
import { personName, type PersonResult } from "@/components/projects/PeopleSearch"
import { TaskPanelDock, TaskPanelSheet } from "@/components/tasks/TaskPanelSheet"
import type { VirtualAnchor } from "@/components/ui/anchored-popover"
import { CreateFab } from "@/components/ui/create-fab"
import type { SegmentedOption } from "@/components/ui/segmented-control"
import { organizationsAPI } from "@/lib/api/organizations"
import type { CalendarEvent, EventPatch } from "@/lib/api/calendar"
import type { TrashRef } from "@/lib/api/trash"
import { mutateEvent, refreshCalendar, type EventMutation } from "@/lib/calendarStore"
import { usePresence } from "@/lib/motion"
import {
  addDays,
  addMonths,
  type CalendarView,
  formatDayTitle,
  formatDaySpan,
  formatMonthTitle,
  formatShortMonthTitle,
  formatRangeTitle,
  parseServerDate,
  sameDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
  weekNumber,
} from "@/lib/dates"
import type { EventType } from "@/lib/eventColors"
import { colorForPerson } from "@/lib/personColors"
import { movedToTrash } from "@/lib/trashToast"
import { useCalendarShortcuts } from "@/lib/useCalendarShortcuts"
import { useIsDesktop, useMediaQuery } from "@/lib/useMediaQuery"
import { useDocumentTitle } from "@/lib/useDocumentTitle"
import { readViewPreference, saveViewPreference } from "@/lib/viewPreference"
import { remPx } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"

const VIEW_KEY = "nerla-calendar-view"
const SIDE_KEY = "nerla-calendar-side"
const HIDDEN_KEY = "nerla-calendar-hidden-types"
const TEAM_KEY = "nerla-calendar-team"
const VIEW_VALUES: readonly CalendarView[] = ["day", "week", "month", "schedule"]
const BUFFER_DAYS = 7

const WIDE_VIEWS: SegmentedOption<CalendarView>[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "schedule", label: "Schedule" },
]
const NARROW_VIEWS: SegmentedOption<CalendarView>[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "3 days" },
  { value: "month", label: "Month" },
  { value: "schedule", label: "Schedule" },
]

function readJson<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    return valid(value) ? value : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be blocked, the choice then lasts for this visit only
  }
}

const isTypeList = (value: unknown): value is EventType[] =>
  Array.isArray(value) && value.every((type) => TYPE_VALUES.includes(type as EventType))

const isTeam = (value: unknown): value is { id: string; name: string; shown: boolean }[] =>
  Array.isArray(value) && value.every((p) => p && typeof p.id === "string" && typeof p.name === "string" && typeof p.shown === "boolean")

function readTeam(): TeamSelection[] {
  return readJson(TEAM_KEY, [], isTeam)
    .slice(0, MAX_TEAM)
    .map((person) => ({ ...person, tone: colorForPerson(person.id) }))
}

/** The days a view shows, and the instants it spans */
function visibleDays(view: CalendarView, date: Date, narrow: boolean): Date[] {
  if (view === "day") return [date]
  if (view === "week") {
    const first = narrow ? date : startOfWeek(date)
    return Array.from({ length: narrow ? 3 : 7 }, (_, i) => addDays(first, i))
  }
  const first = startOfWeek(view === "month" ? startOfMonth(date) : date)
  return Array.from({ length: view === "month" ? 42 : 7 }, (_, i) => addDays(first, i))
}

function stepDate(view: CalendarView, date: Date, direction: 1 | -1, narrow: boolean): Date {
  if (view === "day") return addDays(date, direction)
  if (view === "week") return addDays(date, direction * (narrow ? 3 : 7))
  return startOfMonth(addMonths(date, direction))
}

const PERIOD: Record<CalendarView, string> = { day: "day", week: "week", month: "month", schedule: "month" }
const POPOVER_WIDTH_REM = 24
const MIN_GRID_REM = 40
const SIDE_REM = 18.75

const sameInstant = (a: string | null, b: string | null) => (parseServerDate(a)?.getTime() ?? 0) === (parseServerDate(b)?.getTime() ?? 0)

function save(mutation: EventMutation, done?: string) {
  void mutateEvent(mutation).then((error) => {
    if (error) toast.error(error)
    else if (done) toast.success(done)
  })
}

export default function CalendarPage() {
  useDocumentTitle("Calendar")
  const today = useToday()
  const desktop = useIsDesktop()
  const narrow = !useMediaQuery("(min-width: 40rem)")
  const { user } = useAuth()

  const [view, setView] = useState<CalendarView>(() => readViewPreference(VIEW_KEY, desktop ? "week" : "day", VIEW_VALUES))
  const [date, setDate] = useState(today)
  const [miniMonth, setMiniMonth] = useState(() => startOfMonth(today))
  const [sideOpen, setSideOpen] = useState(() => readViewPreference(SIDE_KEY, "open", ["open", "closed"]) === "open")
  const [sheetOpen, setSheetOpen] = useState(false)
  const [hidden, setHidden] = useState<ReadonlySet<EventType>>(() => new Set(readJson(HIDDEN_KEY, [], isTypeList)))
  const [team, setTeam] = useState<TeamSelection[]>(readTeam)
  // A teammate whose event was opened from search, shown for this visit without joining the saved team
  const [visiting, setVisiting] = useState<TeamSelection | null>(null)
  // Types shown again for an event opened from search, kept hidden in the saved choice
  const sessionShown = useRef(new Set<EventType>())
  const [open, setOpen] = useState<{ item: CalendarItem; anchor: HTMLElement } | null>(null)
  const [draft, setDraft] = useState<EventDraft | null>(null)
  const [draftSession, setDraftSession] = useState(0)
  const [editor, setEditor] = useState<EventDraft | null>(null)
  const [editorSession, setEditorSession] = useState(0)
  const editorOpened = useRef<EventDraft | null>(null)
  const column = useRef<HTMLDivElement>(null)
  const [columnRem, setColumnRem] = useState(Infinity)
  const [sidePeek, setSidePeek] = useState(false)
  const [orgAdmin, setOrgAdmin] = useState(false)
  const draftAnchorEl = useRef<HTMLElement | null>(null)
  // Create and C from Month or Schedule sit near the top of the calendar rather than by a far cell
  const draftAtTop = useRef(false)
  const [reveal, setReveal] = useState(0)
  const panel = useRef<HTMLDivElement>(null)
  const [requestScope, scopeDialog] = useRecurrenceScope(() => panel.current)

  const people = useMemo(() => {
    const shown = team.filter((person) => person.shown)
    return visiting && !shown.some((person) => person.id === visiting.id) ? [...shown, visiting] : shown
  }, [team, visiting])
  const weekNarrow = view === "week" && narrow
  const days = useMemo(() => visibleDays(view, date, narrow), [view, date, narrow])
  const first = days[0]
  const last = days[days.length - 1]
  const {
    items: loaded,
    status,
    error,
    reload,
    unshared,
  } = useCalendarItems(addDays(first, -BUFFER_DAYS), addDays(last, BUFFER_DAYS + 1), { hidden, people })
  const unsharedKey = unshared.join(",")
  const unsharedIds = useMemo(() => (unsharedKey ? unsharedKey.split(",") : []), [unsharedKey])
  const excludeIds = useMemo(() => (user?.id ? [user.id] : []), [user?.id])

  const title = desktop ? formatRangeTitle(view, date) : narrow ? formatShortMonthTitle(date, today) : formatMonthTitle(date, today)
  const rangeTitle = view === "month" || view === "schedule" ? formatRangeTitle(view, date) : formatDaySpan(first, last)
  const ranged = view === "day" || view === "week"

  useEffect(() => writeJson(HIDDEN_KEY, [...new Set([...hidden, ...sessionShown.current])]), [hidden])
  useEffect(
    () =>
      writeJson(
        TEAM_KEY,
        team.map(({ id, name, shown }) => ({ id, name, shown })),
      ),
    [team],
  )

  // Admins may delete any event in the workspace, so the card offers Delete on events they cannot edit
  useEffect(() => {
    let live = true
    organizationsAPI
      .getCurrentOrganization()
      .then((org) => live && setOrgAdmin(org?.role === "admin"))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const go = useCallback((day: Date) => {
    const next = startOfDay(day)
    setDate(next)
    setMiniMonth(startOfMonth(next))
  }, [])

  const changeView = useCallback((next: CalendarView) => {
    setView(next)
    saveViewPreference(VIEW_KEY, next)
  }, [])

  const showDay = useCallback(
    (day: Date) => {
      go(day)
      changeView("day")
    },
    [go, changeView],
  )

  const step = (direction: 1 | -1) => go(stepDate(view, date, direction, narrow))
  const goToday = () => go(today)

  const userId = user?.id
  const canMove = useCallback(
    (item: CalendarItem) =>
      !!userId &&
      !item.person &&
      !item.entry.busy &&
      item.entry.created_by === userId &&
      item.entry.calendar_user_id === userId &&
      !item.entry.id.startsWith("temp-"),
    [userId],
  )

  // A popover has no trigger, so focus goes back to what opened it, the same event re-rendered, or the calendar
  const focusBack = useRef<{ element: HTMLElement | null; key: string | null }>({ element: null, key: null })
  const popups = useRef({ draft, open, editor })
  popups.current = { draft, open, editor }
  const returnFocus = useCallback(() => {
    if (popups.current.draft || popups.current.open || popups.current.editor) return
    const { element, key } = focusBack.current
    const target =
      (element?.isConnected && element !== document.body ? element : null) ??
      (key ? document.querySelector<HTMLElement>(`[data-event-key="${CSS.escape(key)}"]`) : null) ??
      panel.current
    target?.focus({ preventScroll: target === panel.current })
  }, [])

  const openDraft = useCallback((next: EventDraft, anchor: HTMLElement | null = null, key: string | null = null) => {
    const active = document.activeElement
    focusBack.current = { element: anchor ?? (active instanceof HTMLElement && active !== document.body ? active : null), key }
    setOpen(null)
    setEditor(null)
    draftAnchorEl.current = anchor
    draftAtTop.current = false
    setDraft(next)
    setDraftSession((session) => session + 1)
  }, [])

  /**
   * The full editor. Focus goes back to what opened the popover or card it came from, when there was one.
   * `opened` is what counts as unchanged, the draft itself unless a failed save reopens it.
   */
  const openEditor = useCallback(
    (next: EventDraft, from?: { element: HTMLElement | null; key: string | null }, opened: EventDraft = next) => {
      if (from) focusBack.current = from
      else if (!popups.current.draft) {
        const active = document.activeElement
        focusBack.current = { element: active instanceof HTMLElement && active !== document.body ? active : null, key: null }
      }
      setDraft(null)
      setOpen(null)
      setSheetOpen(false)
      setSidePeek(false)
      editorOpened.current = opened
      setEditor(next)
      setEditorSession((session) => session + 1)
    },
    [],
  )

  const closeEditor = useCallback(() => {
    setEditor(null)
    setSidePeek(false)
    popups.current.editor = null
    requestAnimationFrame(() => returnFocus())
  }, [returnFocus])

  const editorDirty = useCallback(() => {
    const current = popups.current.editor
    return !!current && !!editorOpened.current && draftChanged(current, editorOpened.current)
  }, [])
  const [guard, discardDialog] = useDiscardGuard(editorDirty)
  const cancelEditor = useCallback(() => guard(closeEditor), [guard, closeEditor])

  // The grid keeps about 40rem beside the docked editor, so the side column steps aside without changing the saved choice
  useEffect(() => {
    const node = column.current
    if (!node || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      const rem = remPx()
      setColumnRem(entry.contentRect.width / rem)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const editorDock = usePresence(desktop && !!editor)
  // The column comes back only once the editor has eased out
  const squeezed = desktop && (!!editor || editorDock.mounted) && columnRem - SIDE_REM < MIN_GRID_REM
  const sideShown = desktop && sideOpen && (!squeezed || sidePeek)

  // A new event of a type the filters hide would vanish on save, so that type is shown again
  const showType = useCallback((type: EventType) => {
    sessionShown.current.delete(type)
    setHidden((shown) => {
      if (!shown.has(type)) return shown
      const next = new Set(shown)
      next.delete(type)
      return next
    })
  }, [])

  const createAt = useCallback((range: Range, allDay: boolean) => openDraft(newDraft(range.start, range.end, allDay)), [openDraft])

  // Like Google's C: the next free half hour today, with the view brought to today when needed
  const nextFree = () => {
    const busy = loaded.flatMap((item) => (item.person || item.entry.busy || item.all_day ? [] : (itemTimes(item) ?? [])))
    const range = nextFreeHalfHour(new Date(), busy)
    if (view !== "schedule" && !days.some((day) => sameDay(day, range.start))) go(range.start)
    return range
  }

  const createNow = () => {
    const range = nextFree()
    setSheetOpen(false)
    openDraft(newDraft(range.start, range.end, false))
    draftAtTop.current = view === "month" || view === "schedule"
    setReveal((count) => count + 1)
  }

  const newMeeting = () => {
    const range = nextFree()
    openEditor(newDraft(range.start, range.end, false, { type: "meeting", video: true }))
    setReveal((count) => count + 1)
  }
  const meetingRef = useRef(newMeeting)
  meetingRef.current = newMeeting
  const newMeetingNow = useCallback(() => guard(() => meetingRef.current()), [guard])

  // Set out of office in the account menu: all day today, with the dates easy to stretch
  const newAway = () => {
    const today = startOfDay(new Date())
    go(today)
    openEditor(newDraft(today, today, true, { type: "ooo", reminder: null }))
    setReveal((count) => count + 1)
  }
  const awayRef = useRef(newAway)
  awayRef.current = newAway

  const draftAnchor = useMemo<VirtualAnchor | null>(() => {
    if (!draft) return null
    return {
      getBoundingClientRect: () => {
        const ghost = draftAtTop.current ? null : document.querySelector("[data-calendar-ghost]")
        const element = ghost ?? draftAnchorEl.current
        if (element?.isConnected) return element.getBoundingClientRect()
        const box = panel.current?.getBoundingClientRect()
        const rem = remPx()
        if (!box) return { top: 0, left: 0, bottom: 0, right: 0 }
        const left = box.left + Math.max(0, box.width / 2 - (POPOVER_WIDTH_REM * rem) / 2)
        return { top: box.top + rem, bottom: box.top + rem, left, right: left }
      },
    }
  }, [draft])

  const saveDraft = (next: EventDraft) => {
    setDraft(null)
    showType(next.type)
    if (userId) save({ type: "create", body: draftBody(next), userId })
  }

  // A refused save brings the form back as it was, unless something else has opened since
  const saveFromEditor = (mutation: EventMutation, next: EventDraft) => {
    closeEditor()
    showType(next.type)
    void mutateEvent(mutation).then((error) => {
      if (!error) return
      toast.error(error)
      if (popups.current.editor || popups.current.draft) return
      const opened = next.event ? draftFromEvent(next.event, next.savedRule ?? null) : newDraft(next.start, next.end, next.allDay)
      openEditor(next, undefined, opened)
    })
  }

  // A series asks which occurrences first, and the editor stays open when that is cancelled
  const saveEditor = async (next: EventDraft) => {
    const { event } = next
    if (!event) {
      if (userId) saveFromEditor({ type: "create", body: draftBody(next), userId }, next)
      return
    }
    const patch = draftPatch(next, event)
    if (Object.keys(patch).length === 0) return closeEditor()
    // A rule that only followed a moved start still lets "This event" move just this occurrence
    const follows = ruleFollowsOnly(next)
    const scope = event.series_id ? await requestScope("edit", { allowThis: patch.recurrence_rule === undefined || follows }) : undefined
    if (scope === null) return
    if (scope === "this" && follows) {
      delete patch.recurrence_rule
      delete patch.recurrence_tz
    }
    saveFromEditor({ type: "update", event, patch, scope }, next)
  }

  const changeTimes = useCallback(
    async (item: CalendarItem, times: EventTimes) => {
      const event = item.entry
      if (event.busy) return
      const patch: EventPatch = {}
      if (!sameInstant(times.starts_at, event.starts_at)) patch.starts_at = times.starts_at
      if (!sameInstant(times.ends_at, event.ends_at)) patch.ends_at = times.ends_at
      if (!patch.starts_at && !patch.ends_at) return
      const scope = event.series_id ? await requestScope("edit") : undefined
      if (scope === null) return
      save({ type: "update", event, patch, scope })
    },
    [requestScope],
  )

  const { items, dropTimes, nudge, announcement } = useEventNudge(loaded, changeTimes, { month: view === "month" })

  const closeAll = () => {
    setDraft(null)
    setOpen(null)
  }

  useCalendarShortcuts({
    day: () => changeView("day"),
    week: () => changeView("week"),
    month: () => changeView("month"),
    schedule: () => changeView("schedule"),
    today: goToday,
    prev: () => step(-1),
    next: () => step(1),
    create: editor ? undefined : createNow,
    meeting: editor ? undefined : newMeetingNow,
    close: draft || open ? closeAll : editor ? cancelEditor : undefined,
  })

  const commands: Command[] = [
    {
      id: "calendar-new-event",
      title: "New event",
      group: "Actions",
      shortcut: "C",
      keywords: ["create", "add", "calendar"],
      run: () => guard(createNow),
    },
    { id: "calendar-today", title: "Go to today", group: "Navigate", shortcut: "T", keywords: ["calendar"], run: goToday },
    { id: "calendar-next", title: "Next period", group: "Navigate", shortcut: "J", keywords: ["calendar", "forward"], run: () => step(1) },
    {
      id: "calendar-previous",
      title: "Previous period",
      group: "Navigate",
      shortcut: "K",
      keywords: ["calendar", "back"],
      run: () => step(-1),
    },
    { id: "calendar-view-day", title: "Day view", group: "Navigate", shortcut: "D", keywords: ["calendar"], run: () => changeView("day") },
    {
      id: "calendar-view-week",
      title: narrow ? "3 day view" : "Week view",
      group: "Navigate",
      shortcut: "W",
      keywords: ["calendar"],
      run: () => changeView("week"),
    },
    {
      id: "calendar-view-month",
      title: "Month view",
      group: "Navigate",
      shortcut: "M",
      keywords: ["calendar"],
      run: () => changeView("month"),
    },
    {
      id: "calendar-view-schedule",
      title: "Schedule view",
      group: "Navigate",
      shortcut: "A",
      keywords: ["calendar", "agenda", "list"],
      run: () => changeView("schedule"),
    },
  ]
  useRegisterCommands(commands)

  const toggleSide = () => {
    if (!desktop) {
      setSheetOpen(true)
      return
    }
    if (squeezed && sideOpen) {
      setSidePeek(!sidePeek)
      return
    }
    setSidePeek(true)
    setSideOpen(!sideOpen)
    saveViewPreference(SIDE_KEY, sideOpen ? "closed" : "open")
  }

  const selectDay = useCallback(
    (day: Date) => {
      go(day)
      setSheetOpen(false)
    },
    [go],
  )

  const toggleType = useCallback((type: EventType) => {
    sessionShown.current.delete(type)
    setHidden((shown) => {
      const next = new Set(shown)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }, [])

  const addPerson = useCallback((person: PersonResult) => {
    setTeam((list) =>
      list.length >= MAX_TEAM || list.some((p) => p.id === person.id)
        ? list
        : [...list, { id: person.id, name: personName(person), tone: colorForPerson(person.id), shown: true }],
    )
  }, [])
  const togglePerson = useCallback(
    (id: string) => setTeam((list) => list.map((person) => (person.id === id ? { ...person, shown: !person.shown } : person))),
    [],
  )
  const removePerson = useCallback((id: string) => setTeam((list) => list.filter((person) => person.id !== id)), [])

  const openItem = useCallback((item: CalendarItem, anchor: HTMLElement) => {
    setDraft(null)
    focusBack.current = { element: anchor, key: item.key }
    setOpen({ item, anchor })
  }, [])

  const openNew = useCallback((kind: "meeting" | "ooo") => guard(() => (kind === "ooo" ? awayRef : meetingRef).current()), [guard])
  useCalendarLinks({
    go,
    userId,
    team,
    setHidden,
    sessionShown,
    setVisiting,
    days,
    items,
    status,
    view,
    setView,
    openItem,
    openNew,
  })

  const createRef = useRef(createNow)
  createRef.current = createNow
  const create = useCallback(() => guard(() => createRef.current()), [guard])

  // The card follows the store, so a reply or a move shows in it at once
  const details = open ? { item: items.find((item) => item.key === open.item.key) ?? open.item, anchor: open.anchor } : null
  const detailsEvent = details && !details.item.entry.busy ? details.item.entry : null
  const detailsRights = details ? eventRights(details.item.entry, userId, orgAdmin) : null
  const seriesRule = detailsEvent?.series_id
    ? ((
        items.find((item) => !item.entry.busy && item.entry.series_id === detailsEvent.series_id && item.entry.recurrence_rule)?.entry as
          CalendarEvent | undefined
      )?.recurrence_rule ?? null)
    : null
  const dismissing = !!draft || !!open || !!editor
  const actions = {
    draft: draft ?? (editor && !editor.event ? editor : null),
    dismissing,
    canMove,
    onCreate: createAt,
    onChangeTimes: dropTimes,
    onNudge: nudge,
    reveal,
  }

  const editorPanel = editor && (
    <EventEditor
      key={editorSession}
      draft={editor}
      ownerId={editor.event?.created_by ?? userId}
      onChange={setEditor}
      onSave={(next) => void saveEditor(next)}
      onCancel={cancelEditor}
    />
  )

  const side = (
    <CalendarSide
      date={date}
      today={today}
      month={miniMonth}
      onMonthChange={setMiniMonth}
      onSelectDay={selectDay}
      rangeStart={ranged ? first : null}
      rangeEnd={ranged ? last : null}
      hidden={hidden}
      onToggleType={toggleType}
      team={team}
      unshared={unsharedIds}
      excludeIds={excludeIds}
      onAddPerson={addPerson}
      onTogglePerson={togglePerson}
      onRemovePerson={removePerson}
      onCreate={create}
      onNewMeeting={newMeetingNow}
    />
  )

  return (
    <div data-full-bleed="" className="flex h-full min-h-0">
      <div ref={column} className="flex min-w-0 flex-1 flex-col">
        <CalendarToolbar
          title={title}
          week={desktop && (view === "day" || view === "week") ? weekNumber(date) : null}
          view={view}
          views={narrow ? NARROW_VIEWS : WIDE_VIEWS}
          periodName={weekNarrow ? "days" : PERIOD[view]}
          compact={!desktop}
          sideOpen={sideShown}
          onToggleSide={toggleSide}
          onCreate={create}
          onToday={goToday}
          onStep={step}
          onView={changeView}
        />
        <FirstTip id="calendar" className="mx-4 mb-3" />

        <div className="flex min-h-0 flex-1 lg:px-4 lg:pb-4">
          {desktop && <SideColumn open={sideShown}>{side}</SideColumn>}

          <div
            ref={panel}
            tabIndex={-1}
            aria-busy={status === "loading"}
            className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-card ring-[0.0625rem] ring-border focus:outline-none"
          >
            {status === "error" && view !== "schedule" && (
              <p
                role="alert"
                className="flex flex-wrap items-center gap-x-2 border-b-[0.0625rem] border-border px-4 py-2 text-ui text-app-berry-text"
              >
                {error}
                <button
                  type="button"
                  onClick={() => void reload()}
                  className="rounded-sm font-medium text-foreground underline-offset-[0.2rem] hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
                >
                  Try again
                </button>
              </p>
            )}
            {view === "month" ? (
              <MonthView month={date} items={items} label={rangeTitle} narrow={narrow} onOpen={openItem} onShowDay={showDay} {...actions} />
            ) : view === "schedule" ? (
              <ScheduleView
                anchor={date}
                hidden={hidden}
                people={people}
                label={`Schedule from ${formatDayTitle(date)}`}
                onOpen={openItem}
                onShowDay={showDay}
              />
            ) : (
              <WeekGrid days={days} items={items} narrow={narrow} label={rangeTitle} onOpen={openItem} onShowDay={showDay} {...actions} />
            )}
          </div>
        </div>
      </div>

      {desktop ? (
        editorDock.mounted && (
          <TaskPanelDock presence={editorDock} className="flex w-[28rem] shrink-0 flex-col">
            {editorPanel}
          </TaskPanelDock>
        )
      ) : (
        <TaskPanelSheet open={!!editor} onOpenChange={(next) => !next && cancelEditor()} label={editor?.event ? "Edit event" : "New event"}>
          {editorPanel}
        </TaskPanelSheet>
      )}

      {!desktop && <CreateFab label="Create" shortcut="c" onClick={create} />}

      {!desktop && (
        <CalendarSideSheet open={sheetOpen} onOpenChange={setSheetOpen} keepFocus={() => !!(popups.current.draft || popups.current.editor)}>
          {side}
        </CalendarSideSheet>
      )}

      <EventDetailsPopover
        open={details}
        userId={userId}
        canEdit={!!detailsRights?.edit}
        canDelete={!!detailsRights?.delete}
        rule={seriesRule}
        onClose={() => setOpen(null)}
        onEdit={(event, anchor) => {
          const key = details?.item.key ?? null
          guard(() => openEditor(draftFromEvent(event, event.recurrence_rule ?? seriesRule), { element: anchor, key }))
        }}
        onDelete={async (event) => {
          setOpen(null)
          const scope = event.series_id ? await requestScope("delete") : undefined
          if (scope === null) return
          const onTrashed = (entry: TrashRef) => movedToTrash("Event moved to the trash", entry, () => void refreshCalendar())
          save({ type: "delete", event, scope, onTrashed })
        }}
        onDuplicate={(event) => {
          const from = { element: details?.anchor ?? null, key: details?.item.key ?? null }
          guard(() => openEditor(duplicateDraft(event, event.recurrence_rule ?? seriesRule, userId), from))
        }}
        onRespond={(event, response) => userId && save({ type: "respond", event, response, userId })}
        returnFocus={returnFocus}
        side={narrow || view === "day" ? "bottom" : "right"}
      />

      <QuickCreatePopover
        key={draftSession}
        draft={draft}
        anchor={draftAnchor}
        onChange={setDraft}
        onClose={() => setDraft(null)}
        onSave={saveDraft}
        onMoreOptions={(next) => openEditor(next)}
        returnFocus={returnFocus}
        side={narrow || view === "day" ? "bottom" : "right"}
      />

      {scopeDialog}
      {discardDialog}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}

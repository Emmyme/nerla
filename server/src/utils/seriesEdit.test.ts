import { describe, expect, it } from "vitest"
import type { calendarEvents } from "../db/schema"
import { expandSeries } from "./recurrence"
import {
  planDelete,
  planEdit,
  PlanError,
  planRestore,
  planTrash,
  roomPurge,
  seriesRoom,
  type Guest,
  type Plan,
  type SeriesState,
} from "./seriesEdit"

type EventRow = typeof calendarEvents.$inferSelect

const ZONE = "Europe/Stockholm"
const ALICE = "alice"
const BOB = "bob"
const CAROL = "carol"

const row = (over: Partial<EventRow>): EventRow => ({
  id: "master",
  title: "Weekly",
  description: null,
  location: null,
  startsAt: "2026-10-05 07:00:00",
  endsAt: "2026-10-05 08:00:00",
  allDay: false,
  createdBy: "owner",
  organizationId: "org",
  eventType: "meeting",
  videoCall: true,
  everyone: false,
  recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
  recurrenceTz: ZONE,
  seriesId: null,
  originalStart: null,
  cancelled: false,
  reminderMinutes: 10,
  doneVia: null,
  deletedAt: null,
  deletedBy: null,
  deletedVia: null,
  trashRoot: null,
  trashGuests: null,
  createdAt: "2026-10-01 00:00:00",
  updatedAt: "2026-10-01 00:00:00",
  ...over,
})

const override = (id: string, originalStart: string, over: Partial<EventRow> = {}): EventRow =>
  row({
    id,
    recurrenceRule: null,
    recurrenceTz: null,
    seriesId: "master",
    originalStart,
    startsAt: originalStart,
    endsAt: originalStart.replace(/ (\d\d)/, (_, h) => ` ${String(Number(h) + 1).padStart(2, "0")}`),
    ...over,
  })

function state(master: EventRow, overrides: EventRow[] = [], guests: Record<string, Guest[]> = {}, target = master): SeriesState {
  return { target, master, overrides, guests: new Map(Object.entries(guests)) }
}

function context() {
  let next = 0
  return { now: "2026-10-23 12:00:00.000", newId: () => `new-${++next}` }
}

/** The rows after a plan, as the database would hold them. */
function applied(before: SeriesState, plan: Plan): EventRow[] {
  const rows = new Map([before.master!, ...before.overrides].map((item) => [item.id, { ...item }]))
  for (const insert of plan.inserts) rows.set(insert.id, row({ ...insert } as Partial<EventRow>))
  for (const update of plan.updates) Object.assign(rows.get(update.id)!, update.set)
  for (const id of plan.deletes) rows.delete(id)
  return [...rows.values()]
}

/** What the calendar shows between two instants, as "start title". */
function shown(rows: EventRow[], from: string, to: string): string[] {
  return rows
    .filter((item) => !item.seriesId)
    .flatMap((master) =>
      expandSeries(
        master,
        rows.filter((item) => item.seriesId === master.id),
        { from, to },
      ),
    )
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((item) => `${new Date(item.startsAt).toISOString()} ${item.title}`)
}

describe("planEdit", () => {
  it("makes an override for this event, with the series' guests and the change", () => {
    const before = state(row({}), [], { master: [{ userId: ALICE, response: "yes" }] })
    const plan = planEdit(
      before,
      { title: "Moved", starts_at: "2026-10-12T09:00:00Z", ends_at: "2026-10-12T10:00:00Z", attendee_ids: [ALICE, BOB] },
      "this",
      "2026-10-12T07:00:00Z",
      context(),
    )
    expect(plan.updates).toEqual([])
    expect(plan.inserts[0]).toMatchObject({
      id: "new-1",
      seriesId: "master",
      originalStart: "2026-10-12 07:00:00.000",
      startsAt: "2026-10-12 09:00:00.000",
      title: "Moved",
      recurrenceRule: null,
    })
    expect(plan.guestAdds).toEqual([
      { eventId: "new-1", userId: ALICE, response: "yes" },
      { eventId: "new-1", userId: BOB, response: "pending" },
    ])
    expect(shown(applied(before, plan), "2026-10-05T00:00:00Z", "2026-10-20T00:00:00Z")).toEqual([
      "2026-10-05T07:00:00.000Z Weekly",
      "2026-10-12T09:00:00.000Z Moved",
      "2026-10-19T07:00:00.000Z Weekly",
    ])
  })

  it("updates the override that already stands for an occurrence", () => {
    const existing = override("o1", "2026-10-12 07:00:00", { title: "Special" })
    const plan = planEdit(state(row({}), [existing]), { location: "Room 2" }, "this", "2026-10-12T07:00:00Z", context())
    expect(plan.inserts).toEqual([])
    expect(plan.updates).toEqual([{ id: "o1", set: { location: "Room 2", updatedAt: "2026-10-23 12:00:00.000" } }])
  })

  it("splits for this and following, and moves later overrides to the new series", () => {
    const early = override("early", "2026-10-12 07:00:00", { title: "Early" })
    const late = override("late", "2026-10-26 08:00:00", { startsAt: "2026-10-27 08:00:00", endsAt: "2026-10-27 09:00:00" })
    const before = state(row({}), [early, late])
    const plan = planEdit(before, { title: "Renamed" }, "following", "2026-10-19T07:00:00Z", context())

    expect(plan.updates.find((update) => update.id === "master")?.set.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261012T070000Z")
    expect(plan.inserts[0]).toMatchObject({ id: "new-1", startsAt: "2026-10-19 07:00:00.000", recurrenceRule: "FREQ=WEEKLY;BYDAY=MO" })
    expect(plan.updates.find((update) => update.id === "late")?.set).toMatchObject({ seriesId: "new-1", title: "Renamed" })
    expect(plan.updates.find((update) => update.id === "early")).toBeUndefined()
    expect(shown(applied(before, plan), "2026-10-05T00:00:00Z", "2026-11-03T00:00:00Z")).toEqual([
      "2026-10-05T07:00:00.000Z Weekly",
      "2026-10-12T07:00:00.000Z Early",
      "2026-10-19T07:00:00.000Z Renamed",
      "2026-10-27T08:00:00.000Z Renamed",
      "2026-11-02T08:00:00.000Z Renamed",
    ])
  })

  it("treats this and following at the first occurrence as all events", () => {
    const plan = planEdit(state(row({})), { title: "Renamed" }, "following", "2026-10-05T07:00:00Z", context())
    expect(plan.inserts).toEqual([])
    expect(plan.updates).toEqual([{ id: "master", set: { title: "Renamed", updatedAt: "2026-10-23 12:00:00.000" } }])
  })

  it("moves all events to the new local time and re-bases the overrides", () => {
    const kept = override("kept", "2026-10-12 07:00:00", { title: "Kept" })
    const moved = override("moved", "2026-10-19 07:00:00", { startsAt: "2026-10-20 12:00:00", endsAt: "2026-10-20 13:00:00" })
    const gone = override("gone", "2026-10-26 08:00:00", { cancelled: true })
    const before = state(row({}), [kept, moved, gone])
    const plan = planEdit(
      before,
      { starts_at: "2026-11-02T09:00:00Z", ends_at: "2026-11-02T10:00:00Z" },
      "all",
      "2026-11-02T08:00:00Z",
      context(),
    )
    expect(plan.deletes).toEqual([])
    expect(shown(applied(before, plan), "2026-10-05T00:00:00Z", "2026-11-10T00:00:00Z")).toEqual([
      "2026-10-05T08:00:00.000Z Weekly",
      "2026-10-12T08:00:00.000Z Kept",
      "2026-10-20T12:00:00.000Z Weekly",
      "2026-11-02T09:00:00.000Z Weekly",
      "2026-11-09T09:00:00.000Z Weekly",
    ])
  })

  it("moves a timed UNTIL with the series, so its last occurrence stays", () => {
    const before = state(row({ recurrenceRule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019T070000Z" }))
    const plan = planEdit(
      before,
      { starts_at: "2026-10-19T08:00:00Z", ends_at: "2026-10-19T09:00:00Z" },
      "all",
      "2026-10-19T07:00:00Z",
      context(),
    )
    expect(plan.updates[0].set.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019T080000Z")
    expect(shown(applied(before, plan), "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z")).toEqual([
      "2026-10-05T08:00:00.000Z Weekly",
      "2026-10-12T08:00:00.000Z Weekly",
      "2026-10-19T08:00:00.000Z Weekly",
    ])
  })

  it("carries field and guest changes to overrides that had the series' values", () => {
    const custom = override("custom", "2026-10-12 07:00:00", { title: "Custom" })
    const plain = override("plain", "2026-10-19 07:00:00", { location: "Hall" })
    const guests = {
      master: [
        { userId: ALICE, response: "yes" },
        { userId: BOB, response: "no" },
      ],
      custom: [{ userId: ALICE, response: "yes" }],
      plain: [
        { userId: ALICE, response: "maybe" },
        { userId: BOB, response: "no" },
      ],
    }
    const plan = planEdit(
      state(row({}), [custom, plain], guests),
      { title: "Renamed", attendee_ids: [ALICE, CAROL] },
      "all",
      undefined,
      context(),
    )
    expect(plan.updates.find((update) => update.id === "custom")?.set.title).toBeUndefined()
    expect(plan.updates.find((update) => update.id === "plain")?.set.title).toBe("Renamed")
    expect(plan.guestRemoves).toEqual([
      { eventId: "master", userId: BOB },
      { eventId: "plain", userId: BOB },
    ])
    expect(plan.guestAdds).toEqual([
      { eventId: "master", userId: CAROL, response: "pending" },
      { eventId: "custom", userId: CAROL, response: "pending" },
      { eventId: "plain", userId: CAROL, response: "pending" },
    ])
  })

  it("never re-bases an override onto a slot another override keeps", () => {
    const daily = row({ recurrenceRule: "FREQ=DAILY" })
    const d1 = override("d1", "2026-10-05 07:00:00", { title: "D1" })
    const d2 = override("d2", "2026-10-06 07:00:00", { title: "D2" })
    const before = state(daily, [d1, d2])
    const plan = planEdit(
      before,
      { starts_at: "2026-10-08T07:00:00Z", ends_at: "2026-10-08T08:00:00Z" },
      "all",
      "2026-10-07T07:00:00Z",
      context(),
    )
    expect(plan.deletes).toEqual(["d1"])
    expect(shown(applied(before, plan), "2026-10-05T00:00:00Z", "2026-10-09T00:00:00Z")).toEqual([
      "2026-10-06T07:00:00.000Z D2",
      "2026-10-07T07:00:00.000Z Weekly",
      "2026-10-08T07:00:00.000Z Weekly",
    ])
  })

  it("ignores the series' own rule resent with this event", () => {
    const plan = planEdit(
      state(row({})),
      { title: "Once", recurrence_rule: "FREQ=WEEKLY;BYDAY=MO" },
      "this",
      "2026-10-12T07:00:00Z",
      context(),
    )
    expect(plan.inserts[0]).toMatchObject({ title: "Once", recurrenceRule: null })
  })

  it("drops overrides the new rule no longer has", () => {
    const monday = override("monday", "2026-10-12 07:00:00", { title: "Monday" })
    const plan = planEdit(state(row({}), [monday]), { recurrence_rule: "FREQ=WEEKLY;BYDAY=TU" }, "all", undefined, context())
    expect(plan.deletes).toEqual(["monday"])
  })

  it("keeps a series at 02:30 local when it splits at an occurrence in the spring gap", () => {
    const master = row({
      startsAt: "2027-03-14 01:30:00",
      endsAt: "2027-03-14 02:00:00",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=SU",
    })
    const before = state(master)
    const plan = planEdit(before, { title: "Renamed" }, "following", "2027-03-28T01:30:00Z", context())
    expect(plan.updates.find((update) => update.id === "master")?.set.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=SU;UNTIL=20270328T013000Z")
    expect(shown(applied(before, plan), "2027-03-14T00:00:00Z", "2027-04-12T00:00:00Z")).toEqual([
      "2027-03-14T01:30:00.000Z Weekly",
      "2027-03-21T01:30:00.000Z Weekly",
      "2027-03-28T01:30:00.000Z Renamed",
      "2027-04-04T00:30:00.000Z Renamed",
      "2027-04-11T00:30:00.000Z Renamed",
    ])
  })

  it("checks the merged event, not only the fields sent", () => {
    const single = row({ recurrenceRule: null, recurrenceTz: null })
    const plan = () => planEdit(state(single), { ends_at: "2026-10-05T06:00:00Z" }, undefined, undefined, context())
    expect(plan).toThrow(PlanError)
    expect(plan).toThrow("End must be after start")
    const repeat = () => planEdit(state(single), { recurrence_rule: "FREQ=DAILY" }, undefined, undefined, context())
    expect(repeat).toThrow("A repeating event needs the time zone it repeats in")
  })
})

describe("planDelete", () => {
  it("cancels one occurrence, ends the series at another, or removes it", () => {
    const later = override("later", "2026-10-26 08:00:00")
    const before = state(row({}), [later])

    const one = planDelete(before, "this", "2026-10-12T07:00:00Z", context())
    expect(one.inserts[0]).toMatchObject({ seriesId: "master", originalStart: "2026-10-12 07:00:00.000", cancelled: true })

    const following = planDelete(before, "following", "2026-10-19T07:00:00Z", context())
    expect(following.updates[0].set.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261012T070000Z")
    expect(following.deletes).toEqual(["later"])

    expect(planDelete(before, "following", "2026-10-05T07:00:00Z", context()).deletes).toEqual(["master"])
    expect(planDelete({ ...before, target: later }, undefined, undefined, context()).updates[0]).toMatchObject({
      id: "later",
      set: { cancelled: true },
    })
  })
})

describe("planTrash", () => {
  const trash = () => ({ ...context(), by: "owner", via: null })
  const NOW = "2026-10-23 12:00:00.000"
  const setOf = (plan: Plan, id: string) => plan.updates.find((update) => update.id === id)?.set

  it("trashes a single event as its own entry", () => {
    const single = row({ recurrenceRule: null, recurrenceTz: null })
    const plan = planTrash(state(single), undefined, undefined, trash())
    expect(plan.entryId).toBe("master")
    expect(plan.deletes).toEqual([])
    expect(setOf(plan, "master")).toMatchObject({ deletedAt: NOW, deletedBy: "owner", trashRoot: "master" })
  })

  it("trashes a series with its overrides under the series", () => {
    const moved = override("moved", "2026-10-12 07:00:00", { title: "Moved" })
    const alone = override("alone", "2026-10-19 07:00:00", { cancelled: true, deletedAt: "2026-10-20 00:00:00", trashRoot: "alone" })
    const plan = planTrash(state(row({}), [moved, alone]), "all", "2026-10-12T07:00:00Z", trash())
    expect(plan.entryId).toBe("master")
    expect(plan.deletes).toEqual([])
    expect(plan.updates.map((update) => [update.id, update.set.trashRoot])).toEqual([
      ["master", "master"],
      ["moved", "master"],
    ])
  })

  it("keeps the guests of a cancelled occurrence", () => {
    const guests = [
      { userId: ALICE, response: "yes" },
      { userId: BOB, response: "no" },
    ]
    const moved = override("moved", "2026-10-12 07:00:00")
    const plan = planTrash(state(row({}), [moved], { moved: guests }), "this", "2026-10-12T07:00:00Z", trash())
    expect(plan.entryId).toBe("moved")
    expect(setOf(plan, "moved")).toMatchObject({ cancelled: true, trashRoot: "moved", trashGuests: guests })
    expect(plan.guestRemoves).toEqual(guests.map(({ userId }) => ({ eventId: "moved", userId })))
  })

  it("splits this and following into a trashed tail", () => {
    const later = override("later", "2026-10-26 07:00:00", { title: "Later" })
    const before = state(row({}), [later], { master: [{ userId: ALICE, response: "yes" }] })
    const plan = planTrash(before, "following", "2026-10-19T07:00:00Z", trash())
    expect(setOf(plan, "master")?.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261012T070000Z")
    expect(plan.inserts[0]).toMatchObject({
      id: plan.entryId,
      startsAt: "2026-10-19 07:00:00.000",
      deletedAt: NOW,
      trashRoot: plan.entryId,
    })
    expect(plan.inserts[0].createdAt).toBe(plan.inserts[0].deletedAt)
    expect(setOf(plan, "later")).toMatchObject({ seriesId: plan.entryId, trashRoot: plan.entryId })
    expect(plan.guestAdds).toEqual([{ eventId: plan.entryId, userId: ALICE, response: "yes" }])
  })

  it("trashes and restores this and following from an occurrence in the spring gap", () => {
    const master = row({ startsAt: "2027-03-14 01:30:00", endsAt: "2027-03-14 02:00:00", recurrenceRule: "FREQ=WEEKLY;BYDAY=SU" })
    const before = state(master, [], { master: [{ userId: ALICE, response: "yes" }] })
    const plan = planTrash(before, "following", "2027-03-28T01:30:00Z", trash())
    const rows = applied(before, plan)
    const visible = (list: EventRow[]) =>
      shown(
        list.filter((item) => !item.deletedAt || item.seriesId),
        "2027-03-14T00:00:00Z",
        "2027-04-12T00:00:00Z",
      )
    expect(visible(rows)).toEqual(["2027-03-14T01:30:00.000Z Weekly", "2027-03-21T01:30:00.000Z Weekly"])

    const tail = rows.find((item) => item.id === plan.entryId)!
    const gap = rows.find((item) => item.seriesId === "master")!
    const trashed: SeriesState = { target: tail, master: tail, overrides: [], guests: new Map(), strays: [gap] }
    const restore = planRestore(trashed, plan.entryId, context())
    expect(restore.guestAdds).toEqual([{ eventId: gap.id, userId: ALICE, response: "yes" }])
    const back = rows.map((item) => ({ ...item, ...restore.updates.find((update) => update.id === item.id)?.set }) as EventRow)
    expect(visible(back)).toEqual([
      "2027-03-14T01:30:00.000Z Weekly",
      "2027-03-21T01:30:00.000Z Weekly",
      "2027-03-28T01:30:00.000Z Weekly",
      "2027-04-04T00:30:00.000Z Weekly",
      "2027-04-11T00:30:00.000Z Weekly",
    ])
  })
})

describe("planRestore", () => {
  const guests = [
    { userId: ALICE, response: "yes" },
    { userId: BOB, response: "maybe" },
  ]
  const trashed = { cancelled: true, deletedAt: "2026-10-20 00:00:00", deletedBy: "owner", trashRoot: "moved", trashGuests: guests }

  it("puts a cancelled occurrence back with its guests", () => {
    const moved = override("moved", "2026-10-12 07:00:00", trashed)
    const plan = planRestore(state(row({}), [moved], {}, moved), "moved", context())
    expect(plan.updates).toEqual([
      {
        id: "moved",
        set: {
          cancelled: false,
          deletedAt: null,
          deletedBy: null,
          deletedVia: null,
          trashRoot: null,
          trashGuests: null,
          updatedAt: "2026-10-23 12:00:00.000",
        },
      },
    ])
    expect(plan.guestAdds).toEqual(guests.map((guest) => ({ eventId: "moved", ...guest })))
  })

  it("puts an occurrence back where a moved series now has it, with the series' new guests", () => {
    const gone = override("moved", "2026-10-12 07:00:00", trashed)
    const before = state(row({}), [gone], { master: guests })
    const plan = planEdit(
      before,
      { starts_at: "2026-10-05T09:00:00Z", ends_at: "2026-10-05T10:00:00Z", attendee_ids: [ALICE, BOB, CAROL] },
      "all",
      undefined,
      context(),
    )
    const rows = applied(before, plan)
    const master = rows.find((item) => item.id === "master")!
    const kept = rows.find((item) => item.id === "moved")!
    expect(kept.trashGuests).toEqual([...guests, { userId: CAROL, response: "pending" }])
    const restored = state(master, [kept], {}, kept)
    expect(shown(applied(restored, planRestore(restored, "moved", context())), "2026-10-05T00:00:00Z", "2026-10-20T00:00:00Z")).toEqual([
      "2026-10-05T09:00:00.000Z Weekly",
      "2026-10-12T09:00:00.000Z Weekly",
      "2026-10-19T09:00:00.000Z Weekly",
    ])
  })

  it("keeps an occurrence the series no longer has in Trash, and refuses its restore", () => {
    const gone = override("moved", "2026-10-12 07:00:00", trashed)
    const before = state(row({}), [gone])
    const plan = planEdit(before, { recurrence_rule: "FREQ=WEEKLY;BYDAY=TU" }, "all", undefined, context())
    expect(plan.deletes).toEqual([])
    const rows = applied(before, plan)
    const kept = state(
      rows.find((item) => item.id === "master")!,
      [rows.find((item) => item.id === "moved")!],
      {},
      rows.find((item) => item.id === "moved")!,
    )
    expect(() => planRestore(kept, "moved", context())).toThrow("This occurrence is no longer part of the series")
  })

  it("refuses an occurrence of a trashed series", () => {
    const moved = override("moved", "2026-10-12 07:00:00", trashed)
    const master = row({ deletedAt: "2026-10-21 00:00:00", deletedBy: "owner", trashRoot: "master" })
    const restore = () => planRestore(state(master, [moved], {}, moved), "moved", context())
    expect(restore).toThrow(PlanError)
    expect(restore).toThrow("Restore the series first")
  })
})

describe("roomPurge", () => {
  const entry = (userIds: string[] | null, keepGuests = true) => ({ room: "meeting-master", seriesId: "master", userIds, keepGuests })

  it("clears a removed guest from the series room, never the creator", () => {
    const moved = override("moved", "2026-10-12 07:00:00")
    const before = state(row({}), [moved], {
      master: [
        { userId: ALICE, response: "yes" },
        { userId: BOB, response: "yes" },
      ],
      moved: [{ userId: BOB, response: "yes" }],
    })
    const plan = planEdit(before, { attendee_ids: [ALICE, "owner"] }, "all", undefined, context())
    expect(roomPurge(before, plan)).toEqual({ creatorId: "owner", entries: [entry([BOB])] })
  })

  it("keeps the room of the series a following edit splits off", () => {
    const later = override("later", "2026-10-26 08:00:00")
    const before = state(row({}), [later], {
      master: [
        { userId: ALICE, response: "yes" },
        { userId: BOB, response: "yes" },
      ],
      later: [
        { userId: ALICE, response: "yes" },
        { userId: BOB, response: "yes" },
      ],
    })
    const plan = planEdit(before, { attendee_ids: [ALICE] }, "following", "2026-10-19T07:00:00Z", context())
    expect(roomPurge(before, plan).entries).toEqual([entry([BOB])])
  })

  it("clears non-guests when Everyone goes off, the whole room when the video call does", () => {
    const shared = row({ recurrenceRule: null, recurrenceTz: null, everyone: true })
    const everyoneOff = planEdit(state(shared), { everyone: false }, undefined, undefined, context())
    expect(roomPurge(state(shared), everyoneOff).entries).toEqual([entry(null)])
    const videoOff = planEdit(state(shared), { video_call: false }, undefined, undefined, context())
    expect(roomPurge(state(shared), videoOff).entries).toEqual([entry(null, false)])
    const renamed = planEdit(state(shared), { title: "Renamed" }, undefined, undefined, context())
    expect(roomPurge(state(shared), renamed).entries).toEqual([])
  })

  it("clears the room only when no live row of the series keeps a video call", () => {
    const plain = row({ videoCall: false })
    const call = override("call", "2026-10-12 07:00:00", { videoCall: true })
    const before = state(plain, [call], {}, call)
    expect(roomPurge(before, planEdit(before, { video_call: false }, "this", undefined, context())).entries).toEqual([entry(null, false)])
    expect(roomPurge(before, planDelete(before, "this", undefined, context())).entries).toEqual([entry(null, false)])

    const both = state(row({}), [call], {}, call)
    expect(roomPurge(both, planEdit(both, { video_call: false }, "this", undefined, context())).entries).toEqual([])
  })
})

describe("seriesRoom", () => {
  it("opens the series room when any live row has a video call or Everyone", () => {
    const plain = row({ videoCall: false })
    const call = override("call", "2026-10-12 07:00:00", { everyone: true })
    expect(seriesRoom([plain], "master")).toEqual({ video: false, everyone: false })
    expect(seriesRoom([plain, call], "master")).toEqual({ video: true, everyone: true })
    expect(seriesRoom([plain, { ...call, cancelled: true }], "master")).toEqual({ video: false, everyone: false })
    expect(seriesRoom([plain, { ...call, seriesId: "other" }], "master")).toEqual({ video: false, everyone: false })
  })
})

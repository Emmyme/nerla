import { and, desc, eq, getTableColumns, inArray, isNull, or, sql, type SQL } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { calendarEvents, db, projects, tasks, users } from "../db"
import { FILE_PLACEHOLDER } from "../utils/chatAccess"
import { DAY_MS, msToStored, readInstant, storedMs } from "../utils/eventTime"
import { visibilityFor, type SharingTowardViewer } from "../utils/eventVisibility"
import { presenceName } from "../utils/presence"
import { expandSeries, type OverrideRow, type SeriesRow } from "../utils/recurrence"
import { MENTION_PG, MENTION_PG_CAPTURE, SOMEONE } from "../utils/mentions"
import { eventMatchable, parseTaskId, snippetAround } from "../utils/searchText"
import { formatTaskIdentifier } from "../utils/taskKeys"
import { LIVE_EVENT_SQL, LIVE_PROJECT_SQL, liveEvent, liveProject, liveTask } from "../utils/trash"
import { notEndedBefore, sharingToward } from "./calendarQueries"
import { contextLines, fileDto, likePattern, searchFiles, type FileDto } from "./fileQueries"
import type { FileViewer } from "./files"
import { readableProjectIds } from "./projectAccess"
import { memberIdsOf } from "./tenancy"

const GROUP_LIMIT = 5
const FETCH = GROUP_LIMIT + 1
const MIN_QUERY = 2
const EVENT_CANDIDATES = 40
const MENTION_CANDIDATES = 50
const YEAR_MS = 366 * DAY_MS

type Group<T> = { items: T[]; more: boolean }

type SearchReply = {
  files: Group<FileDto>
  tasks: Group<{
    id: string
    title: string
    identifier: string | null
    status: string
    project: { name: string; slug: string; color: string | null; icon: string | null } | null
  }>
  projects: Group<{ id: string; name: string; slug: string; color: string | null; icon: string | null; member: boolean }>
  people: Group<{ id: string; name: string; email: string; jobTitle: string | null; team: string | null; avatarUrl: string | null }>
  messages: Group<{
    id: string
    snippet: string
    createdAt: string
    sender: { id: string; name: string } | null
    chat: { kind: "dm" | "group"; id: string; title: string }
  }>
  /** `ownerId` is the creator, already shown as the organizer of any event seen in full */
  events: Group<{ id: string; title: string; startsAt: string; allDay: boolean; eventType: string; ownerId: string }>
}

const group = <T>(rows: T[]): Group<T> => ({ items: rows.slice(0, GROUP_LIMIT), more: rows.length > GROUP_LIMIT })

const matches = (column: AnyPgColumn | SQL, q: string): SQL => sql`lower(${column}) like ${likePattern(q)} escape '\\'`
const startsWith = (column: AnyPgColumn | SQL, q: string): SQL =>
  sql`coalesce(lower(${column}) like ${likePattern(q).slice(1)} escape '\\', false)`

const fullName = (first: string | null, last: string | null, email: string) => [first, last].filter(Boolean).join(" ").trim() || email

async function searchFileGroup(v: FileViewer, q: string): Promise<SearchReply["files"]> {
  const rows = await searchFiles(v, { q }, FETCH)
  const page = rows.slice(0, GROUP_LIMIT)
  const contexts = await contextLines(v, page)
  return { items: page.map((row) => fileDto(row, v, contexts.get(row.id) ?? null)), more: rows.length > GROUP_LIMIT }
}

/** Project tasks of readable projects and the viewer's own personal tasks, an exact ID first */
async function searchTasks(v: FileViewer, q: string): Promise<SearchReply["tasks"]> {
  const id = parseTaskId(q)
  const byId = id ? sql`coalesce(${projects.key} = ${id.key} and ${tasks.number} = ${id.number}, false)` : null
  const order = [desc(startsWith(tasks.title, q)), desc(tasks.updatedAt), desc(tasks.id)]
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      number: tasks.number,
      status: tasks.status,
      projectId: tasks.projectId,
      name: projects.name,
      slug: projects.slug,
      color: projects.color,
      icon: projects.icon,
      key: projects.key,
    })
    .from(tasks)
    .leftJoin(projects, and(eq(projects.id, tasks.projectId), eq(projects.organizationId, v.organizationId), liveProject))
    .where(
      and(
        eq(tasks.organizationId, v.organizationId),
        liveTask,
        or(
          and(isNull(tasks.projectId), eq(tasks.assignedTo, v.userId)),
          inArray(tasks.projectId, readableProjectIds(v.userId, v.organizationId)),
        ),
        byId ? or(matches(tasks.title, q), byId) : matches(tasks.title, q),
      ),
    )
    .orderBy(...(byId ? [desc(byId), ...order] : order))
    .limit(FETCH)
  return group(
    rows.map((row) => ({
      id: row.id,
      title: row.title,
      identifier: formatTaskIdentifier(row.key, row.number),
      status: row.status,
      project: row.projectId && row.slug ? { name: row.name ?? "", slug: row.slug, color: row.color, icon: row.icon } : null,
    })),
  )
}

async function searchProjects(v: FileViewer, q: string): Promise<SearchReply["projects"]> {
  const member = sql<boolean>`exists (select 1 from project_members pm
    where pm.project_id = "projects"."id" and pm.user_id = ${v.userId})`
  const rows = await db
    .select({ id: projects.id, name: projects.name, slug: projects.slug, color: projects.color, icon: projects.icon, member })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, v.organizationId),
        liveProject,
        inArray(projects.id, readableProjectIds(v.userId, v.organizationId)),
        matches(projects.name, q),
      ),
    )
    .orderBy(desc(startsWith(projects.name, q)), desc(member), sql`lower(${projects.name})`, projects.id)
    .limit(FETCH)
  return group(rows.map((row) => ({ ...row, member: !!row.member })))
}

/** Current members by full name, which covers either name, email, job title or team */
async function searchPeople(v: FileViewer, q: string): Promise<SearchReply["people"]> {
  // The same expression as users_full_name_trgm_idx, so a first name, a last name or both use that index
  const name = sql`coalesce(${users.firstName}, '') || ' ' || coalesce(${users.lastName}, '')`
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      jobTitle: users.jobTitle,
      team: users.team,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(
      and(
        inArray(users.id, memberIdsOf(v.organizationId)),
        isNull(users.removedAt),
        or(matches(name, q), matches(users.email, q), matches(users.jobTitle, q), matches(users.team, q)),
      ),
    )
    .orderBy(desc(startsWith(name, q)), sql`lower(${name})`, users.id)
    .limit(FETCH)
  return group(
    rows.map((row) => ({
      id: row.id,
      name: fullName(row.firstName, row.lastName, row.email),
      email: row.email,
      jobTitle: row.jobTitle,
      team: row.team,
      avatarUrl: row.avatarUrl,
    })),
  )
}

type MessageRow = {
  id: string
  content: string
  created_at: string
  sender_id: string
  sender_first: string | null
  sender_last: string | null
  thread_type: string | null
  thread_id: string | null
  group_name: string | null
  partner_id: string | null
  partner_first: string | null
  partner_last: string | null
  partner_email: string | null
}

/** A member's name as `presenceName` gives it, or null when they have none */
const memberName = (alias: string) =>
  // nosemgrep: nerla-raw-sql-interpolation -- alias is a fixed table alias from this file, never user input
  sql.raw(`nullif(trim(concat_ws(' ', nullif(${alias}.first_name, ''), nullif(${alias}.last_name, ''))), '')`)

/** A message as users read it, each mention as "@Name" of a current member of the workspace */
function readableContent(O: SQL): SQL {
  return sql`(case when strpos(m.content, '@[') = 0 then m.content else (
    select string_agg(p.part || coalesce(t.label, ''), '' order by p.n)
    from unnest(regexp_split_to_array(m.content, ${MENTION_PG}, 'i')) with ordinality p(part, n)
    left join (
      select x.n, '@' || coalesce(${memberName("mu")}, ${SOMEONE}) as label
      from regexp_matches(m.content, ${MENTION_PG_CAPTURE}, 'gi') with ordinality x(found, n)
      left join lateral (
        select u.first_name, u.last_name from users u
        where u.id = lower(x.found[1])::uuid
          and exists (select 1 from organization_members mm where mm.organization_id = ${O} and mm.user_id = u.id)
        limit 1
      ) mu on true
    ) t on t.n = p.n
  ) end)`
}

/** Mention tokens of the members whose "@Name" the query could be part of, so a message is found by the name it shows */
async function mentionTokensFor(organizationId: string, q: string): Promise<string[]> {
  const needle = q.toLowerCase()
  const tail = needle.includes("@") ? needle.slice(needle.lastIndexOf("@")) : null
  const label = sql`('@' || lower(coalesce(${memberName("u")}, ${SOMEONE})))`
  const prefix = likePattern(needle.startsWith("@") ? needle : `@${needle}`).slice(1)
  // A name the query holds whole first, then names it starts, then the rest, so the cap keeps the likeliest
  const rows = await db.execute<{ id: string }>(sql`
    select u.id from users u
    where exists (select 1 from organization_members om where om.user_id = u.id and om.organization_id = ${organizationId}::uuid)
      and (${label} like ${likePattern(needle)} escape '\\' or strpos(${needle}, ${label}) > 0
        ${tail ? sql`or ${label} like ${likePattern(tail).slice(1)} escape '\\'` : sql``})
    order by case when strpos(${needle}, ${label}) > 0 then 0 when ${label} like ${prefix} escape '\\' then 1 else 2 end, ${label}, u.id
    limit ${MENTION_CANDIDATES}::int`)
  return [...rows].map((row) => `@[${row.id.toLowerCase()}]`)
}

/** Text messages of the group chats the viewer is in and of DMs with users still in the workspace, newest first */
async function searchMessages(v: FileViewer, q: string): Promise<SearchReply["messages"]> {
  const V = sql`${v.userId}::uuid`
  const O = sql`${v.organizationId}::uuid`
  const partner = sql`(case when m.sender_id = ${V} then m.recipient_id else m.sender_id end)`
  const readable = readableContent(O)
  const pattern = likePattern(q)
  // Found by the stored text or by a mention of a matching name, then kept only when the text as read matches.
  // The candidates are put in order first, so the text as read is only built until the page is full
  const byName = (await mentionTokensFor(v.organizationId, q)).map((token) => sql`lower(m.content) like ${likePattern(token)} escape '\\'`)
  const rows = await db.execute<MessageRow>(sql`
    select m.id, m.content, m.created_at::text as created_at, m.sender_id,
      su.first_name as sender_first, su.last_name as sender_last, m.thread_type, m.thread_id,
      g.name as group_name, pu.id as partner_id, pu.first_name as partner_first, pu.last_name as partner_last,
      pu.email as partner_email
    from (
      select m.id, ${readable} as content, m.created_at, m.sender_id, m.recipient_id, m.thread_type, m.thread_id
      from (
        select m.id, m.content, m.created_at, m.sender_id, m.recipient_id, m.thread_type, m.thread_id
        from messages m
        where m.organization_id = ${O}
          and m.kind = 'text' and m.content <> ${FILE_PLACEHOLDER}
          and (${sql.join([sql`lower(m.content) like ${pattern} escape '\\'`, ...byName], sql` or `)})
          and (
            (m.thread_type = 'group' and m.thread_id in (
              select gcm.group_chat_id from group_chat_members gcm join group_chats gg on gg.id = gcm.group_chat_id
              where gcm.user_id = ${V} and gg.organization_id = ${O} and (gg.project_id is null
                or exists (select 1 from projects gp where gp.id = gg.project_id and ${LIVE_PROJECT_SQL("gp")}))))
            or (m.thread_type is null and m.recipient_id is not null and (m.sender_id = ${V} or m.recipient_id = ${V})
              and exists (select 1 from organization_members om where om.organization_id = ${O} and om.user_id = ${partner})))
        order by m.created_at desc, m.id desc
        offset 0
      ) m
      where lower(${readable}) like ${pattern} escape '\\'
      order by m.created_at desc, m.id desc
      limit ${FETCH}::int
    ) m
    left join users su on su.id = m.sender_id
    left join group_chats g on m.thread_type = 'group' and g.id = m.thread_id and g.organization_id = ${O}
    left join users pu on m.thread_type is null and pu.id = ${partner}
    order by m.created_at desc, m.id desc`)
  const items: SearchReply["messages"]["items"] = []
  for (const row of rows) {
    const chat =
      row.thread_type === "group" && row.thread_id
        ? { kind: "group" as const, id: row.thread_id, title: row.group_name ?? "Group chat" }
        : row.partner_id
          ? { kind: "dm" as const, id: row.partner_id, title: fullName(row.partner_first, row.partner_last, row.partner_email ?? "") }
          : null
    if (!chat) continue
    items.push({
      id: row.id,
      snippet: snippetAround(row.content, q),
      createdAt: readInstant(row.created_at) ?? row.created_at,
      sender: { id: row.sender_id, name: presenceName(row.sender_first, row.sender_last) },
      chat,
    })
  }
  return group(items)
}

// Drizzle leaves select-list columns unqualified on a one-table select, so correlated subqueries name the outer row in full
const EVENT_ID = sql.raw(`"calendar_events"."id"`)
const EVENT_CREATOR = sql.raw(`"calendar_events"."created_by"`)
const EVENT_SERIES = sql.raw(`"calendar_events"."series_id"`)

type EventFacts = { createdBy: string; eventType: string; everyone: boolean; isGuest: boolean; creatorMember: boolean }
type EventCandidate = SeriesRow & EventFacts & { title: string; seriesId: string | null; live: boolean }

/** Whether the viewer is invited and whether the creator is still a member, inside a query on `calendar_events` */
function viewerFacts(v: FileViewer) {
  return {
    isGuest: sql<boolean>`exists (select 1 from event_attendees ea
      where ea.event_id = ${EVENT_ID} and ea.user_id = ${v.userId})`,
    creatorMember: sql<boolean>`exists (select 1 from organization_members om
      where om.organization_id = ${v.organizationId} and om.user_id = ${EVENT_CREATOR})`,
  }
}

/** Rows that could be seen in full, so the cap is not spent on hidden ones. `seenInFull` still decides */
function couldBeFull(v: FileViewer, facts: ReturnType<typeof viewerFacts>): SQL {
  const grantsAll = sql`exists (select 1 from calendar_share_grants sg
    where sg.owner_id = ${EVENT_CREATOR} and sg.grantee_id = ${v.userId} and sg.level = 'everything'
      and sg.organization_id = ${v.organizationId})`
  const sharesDetails = sql`coalesce((select cs.default_level from calendar_sharing cs
    where cs.user_id = ${EVENT_CREATOR}), 'details') = 'details'`
  return or(
    eq(calendarEvents.createdBy, v.userId),
    eq(calendarEvents.everyone, true),
    facts.isGuest,
    and(facts.creatorMember, or(grantsAll, and(sharesDetails, sql`${calendarEvents.eventType} not in ('personal', 'focus')`))),
  )!
}

/** Outside their own, invited and Everyone events, only a current member's events count */
function seenInFull(v: FileViewer, sharing: (ownerId: string) => SharingTowardViewer, row: EventFacts): boolean {
  const own = row.createdBy === v.userId || row.isGuest || row.everyone
  if (!own && !row.creatorMember) return false
  const seen = visibilityFor(
    row,
    { id: v.userId },
    {
      isCreator: row.createdBy === v.userId,
      isAttendee: row.isGuest,
      ownerSharing: sharing(row.createdBy),
      creatorSharing: sharing(row.createdBy),
      mode: "team",
    },
  )
  return eventMatchable(seen)
}

/**
 * Titles the viewer sees in full, one per series with the master preferred. Series that have not ended and
 * upcoming one-offs rank ahead of ended ones, so overrides or old rows never use up the cap
 */
async function searchEvents(v: FileViewer, q: string): Promise<SearchReply["events"]> {
  const now = Date.now()
  const today = Math.floor(now / DAY_MS) * DAY_MS
  const todayStored = sql`${msToStored(today)}::timestamp`
  const facts = viewerFacts(v)
  const liveMaster = sql`(${calendarEvents.seriesId} is null or exists (select 1 from calendar_events sm
    where sm.id = ${EVENT_SERIES} and sm.cancelled = false and sm.organization_id = ${v.organizationId} and ${LIVE_EVENT_SQL("sm")}))`
  const where = and(
    eq(calendarEvents.organizationId, v.organizationId),
    eq(calendarEvents.cancelled, false),
    liveEvent,
    matches(calendarEvents.title, q),
    liveMaster,
    couldBeFull(v, facts),
  )!
  const live = sql`case when ${calendarEvents.recurrenceRule} is not null and ${calendarEvents.seriesId} is null
    then ${notEndedBefore(msToStored(today))} else ${calendarEvents.endsAt} >= ${todayStored} end`
  // trash: `where` holds liveEvent
  const fetched = [
    ...(await db.execute<EventCandidate>(sql`
      select * from (
        select id, title, starts_at::text as "startsAt", ends_at::text as "endsAt", all_day as "allDay",
          created_by as "createdBy", event_type as "eventType", everyone, recurrence_rule as "recurrenceRule",
          recurrence_tz as "recurrenceTz", series_id as "seriesId",
          ${facts.isGuest} as "isGuest", ${facts.creatorMember} as "creatorMember", ${live} as live,
          row_number() over (partition by coalesce(series_id, id)
            order by (series_id is null) desc, case when ends_at >= ${todayStored} then starts_at end asc nulls last,
              starts_at desc) as rn
        from calendar_events
        where ${where}
      ) c
      where c.rn = 1
      order by c.live desc, case when c.live then greatest(c."startsAt"::timestamp, ${todayStored}) end asc,
        c."startsAt"::timestamp desc, c.id
      limit ${EVENT_CANDIDATES + 1}::int`)),
  ]
  const rows = fetched.slice(0, EVENT_CANDIDATES)

  const sharing = await sharingToward(
    { id: v.userId, organizationId: v.organizationId },
    rows.map((row) => row.createdBy),
  )
  const visible = rows.filter((row) => seenInFull(v, sharing, row))
  const masterIds = visible.filter((row) => row.recurrenceRule && !row.seriesId).map((row) => row.id)
  const overrides = masterIds.length
    ? await db
        .select({ ...getTableColumns(calendarEvents), ...facts })
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.organizationId, v.organizationId),
            inArray(calendarEvents.seriesId, masterIds),
            // trash: a cancelled occurrence in Trash still keeps its series from showing that day
            or(eq(calendarEvents.cancelled, true), liveEvent),
          ),
        )
    : []
  const overrideSharing = await sharingToward(
    { id: v.userId, organizationId: v.organizationId },
    overrides.map((row) => row.createdBy),
  )
  const needle = q.toLowerCase()
  const usable = new Set(
    overrides
      .filter((row) => !row.cancelled && row.title.toLowerCase().includes(needle) && seenInFull(v, overrideSharing, row))
      .map((row) => row.id),
  )

  const masters = new Set(masterIds)
  const dated = visible.map((row) => ({ row, startsAt: masters.has(row.id) ? seriesDate(row, overrides, usable, now) : row.startsAt }))
  const ms = (value: string) => storedMs(value) ?? 0
  const ahead = dated.filter((d) => ms(d.startsAt) >= today).sort((a, b) => ms(a.startsAt) - ms(b.startsAt))
  const past = dated.filter((d) => ms(d.startsAt) < today).sort((a, b) => ms(b.startsAt) - ms(a.startsAt))
  const items = [...ahead, ...past].map(({ row, startsAt }) => ({
    id: row.id,
    title: row.title,
    startsAt: readInstant(startsAt) ?? startsAt,
    allDay: row.allDay,
    eventType: row.eventType,
    ownerId: row.createdBy,
  }))
  return { items: items.slice(0, GROUP_LIMIT), more: items.length > GROUP_LIMIT || fetched.length > EVENT_CANDIDATES }
}

/**
 * The next occurrence of a series from today, else its latest in the past year, else its first. An occurrence
 * an override replaced counts only when that override matches and is seen in full itself
 */
function seriesDate(master: SeriesRow, overrides: OverrideRow[], usable: Set<string>, now: number): string {
  const today = Math.floor(now / DAY_MS) * DAY_MS
  const counts = (occurrence: { id: string }) => occurrence.id === master.id || usable.has(occurrence.id)
  const window = (from: number, to: number) => ({ from: new Date(from).toISOString(), to: new Date(to).toISOString() })
  const next = expandSeries(master, overrides, window(today, today + YEAR_MS)).find(counts)
  if (next) return next.startsAt
  const last = expandSeries(master, overrides, window(now - YEAR_MS, now))
    .filter(counts)
    .pop()
  return last?.startsAt ?? master.startsAt
}

/** Every type at once, each capped at GROUP_LIMIT with a flag for more */
export async function searchEverything(v: FileViewer, q: string): Promise<SearchReply> {
  if (Array.from(q).length < MIN_QUERY) {
    const none = () => ({ items: [], more: false })
    return { files: none(), tasks: none(), projects: none(), people: none(), messages: none(), events: none() }
  }
  const [files, taskGroup, projectGroup, people, messageGroup, events] = await Promise.all([
    searchFileGroup(v, q),
    searchTasks(v, q),
    searchProjects(v, q),
    searchPeople(v, q),
    searchMessages(v, q),
    searchEvents(v, q),
  ])
  return { files, tasks: taskGroup, projects: projectGroup, people, messages: messageGroup, events }
}

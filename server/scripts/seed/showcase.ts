/**
 * The showcase workspace, Nerla, a small design and product studio for launch and README screenshots.
 * Everything in it is invented. Dates sit around today, so a fresh seed always looks current
 */
import { sql } from "drizzle-orm"
import { db } from "../../src/db"
import { notify } from "../../src/services/notifications"
import { parseMentions } from "../../src/utils/mentions"
import { addEvent, addTask, addTaskComment, logTime, respond, type Person } from "./build"
import { seedShowcaseAi } from "./showcaseAi"
import { seedShowcaseChats } from "./showcaseChats"
import { emailOf, MEMBERS, seedCrew, seedProjects, withMentions, WORKSPACE, type Crew, type CrewKey, type Projects } from "./showcaseCrew"
import { seedShowcaseDocs } from "./showcaseDocs"
import { atClock, fromLocalNoon, localDate, localZone, seedNow, weekday } from "./time"

export type ShowcaseIds = {
  workspace: string
  organizationId: string
  admin: { email: string; name: string }
  projects: Record<string, string>
}

type TaskSpec = {
  title: string
  status: "backlog" | "todo" | "in_progress" | "done" | "cancelled"
  priority: "none" | "low" | "medium" | "high" | "urgent"
  to: CrewKey
  /** Days from today */
  due?: number
  /** Days ago a done task was finished */
  doneAgo?: number
  about?: string
  comments?: [CrewKey, string][]
}

const TASKS: Record<keyof Projects, TaskSpec[]> = {
  tallow: [
    {
      title: "Final logo lockups",
      status: "in_progress",
      priority: "high",
      to: "lorem",
      due: 1,
      about: "Primary, stacked and the small stamp version for the bread bags.",
      comments: [
        ["test", "The stamp works so well at small sizes. Can we try it in the darker brown too?"],
        ["lorem", "Yes, I'll add it to the next round."],
      ],
    },
    {
      title: "Present the brand to the owners",
      status: "in_progress",
      priority: "urgent",
      to: "emelie",
      due: 0,
      about: "Thirty minutes at the Södermalm shop. Bring printed samples of the packaging.",
      comments: [["test", "@emelie the printed samples are on your desk, in the brown envelope."]],
    },
    { title: "Packaging dieline for the bread bags", status: "todo", priority: "medium", to: "john", due: 4 },
    {
      title: "Menu board system",
      status: "todo",
      priority: "medium",
      to: "lorem",
      due: 8,
      about: "Chalkboards in the shops and a printed menu for the café counter.",
    },
    {
      title: "Typeface licence check",
      status: "in_progress",
      priority: "medium",
      to: "penny",
      due: -1,
      about: "The display face needs a licence for signage as well as print.",
    },
    { title: "Colour palette sign-off", status: "done", priority: "high", to: "test", doneAgo: 1 },
    { title: "Photography moodboard", status: "done", priority: "low", to: "lorem", doneAgo: 2 },
    { title: "Loyalty card concept", status: "backlog", priority: "low", to: "john" },
    {
      title: "Window sticker for the old shop",
      status: "cancelled",
      priority: "none",
      to: "lorem",
      about: "The shop moves in spring, so the sticker is no longer needed.",
    },
  ],
  sampleClient: [
    {
      title: "Booking flow, second round",
      status: "in_progress",
      priority: "urgent",
      to: "john",
      due: 2,
      about: "Fewer steps to a booked time, and the time slots above the fold on a small phone.",
      comments: [
        ["penny", "Three of five people in the interviews missed the slots below the fold."],
        ["john", "Thanks, that settles it. Slots go first."],
      ],
    },
    {
      title: "Accessible date picker",
      status: "in_progress",
      priority: "high",
      to: "jane",
      due: 3,
      about: "Works with a screen reader, with a keyboard and with large text.",
    },
    {
      title: "Clinic list API",
      status: "in_progress",
      priority: "medium",
      to: "jane",
      due: -2,
      comments: [["jane", "@emelie two endpoints left. Can the due date move to Monday?"]],
    },
    {
      title: "Sprint 14 review notes",
      status: "in_progress",
      priority: "medium",
      to: "emelie",
      due: 1,
      about: "A short summary for the clinic owners before the client call.",
    },
    {
      title: "Sprint 14 goals for the kickoff",
      status: "done",
      priority: "high",
      to: "emelie",
      doneAgo: 1,
      about: "Three goals at most, each with one owner.",
    },
    { title: "Reminder settings screen", status: "todo", priority: "high", to: "john", due: 5 },
    {
      title: "Push notification copy",
      status: "todo",
      priority: "medium",
      to: "penny",
      due: 6,
      about: "Friendly, short and never more than one reminder a day.",
    },
    { title: "Usability test, round two", status: "todo", priority: "high", to: "penny", due: 7 },
    { title: "Login with a one-time code", status: "done", priority: "high", to: "jane", doneAgo: 1 },
    { title: "Empty states for the bookings tab", status: "done", priority: "medium", to: "john", doneAgo: 0 },
    { title: "Dark mode pass", status: "backlog", priority: "low", to: "jane" },
    { title: "Offline banner", status: "backlog", priority: "none", to: "jane" },
    {
      title: "Calendar sync with Google",
      status: "cancelled",
      priority: "low",
      to: "jane",
      about: "The clinics asked for text message reminders instead.",
    },
  ],
  system: [
    {
      title: "Form field component",
      status: "in_progress",
      priority: "high",
      to: "jane",
      due: 2,
      comments: [["test", "Error text sits under the field, never in a pop-up."]],
    },
    {
      title: "Icon set clean-up",
      status: "in_progress",
      priority: "medium",
      to: "lorem",
      due: 4,
      about: "Down from 112 icons to the 64 that are in use.",
    },
    { title: "Contrast audit", status: "todo", priority: "high", to: "test", due: -1 },
    { title: "Review the token naming", status: "todo", priority: "medium", to: "emelie", due: 3 },
    { title: "Spacing scale documentation", status: "todo", priority: "low", to: "john", due: 9 },
    { title: "Button and link tokens", status: "done", priority: "medium", to: "jane", doneAgo: 1 },
    { title: "Motion guidelines", status: "backlog", priority: "low", to: "test" },
    { title: "Table component", status: "backlog", priority: "medium", to: "jane" },
  ],
  website: [
    {
      title: "New contact page",
      status: "in_progress",
      priority: "high",
      to: "jane",
      due: 0,
      about: "One short form, our address and a map link.",
      comments: [["emelie", "Looks great. @jane can the form say how soon we reply?"]],
    },
    {
      title: "Hosting renewal",
      status: "done",
      priority: "urgent",
      to: "emelie",
      due: -1,
      doneAgo: 1,
      about: "The invoice is in the shared inbox.",
    },
    { title: "Sample Client case study", status: "in_progress", priority: "medium", to: "lorem", due: 5 },
    { title: "Team page bios", status: "todo", priority: "low", to: "emelie", due: 8 },
    { title: "Cookie-free analytics", status: "done", priority: "low", to: "jane", doneAgo: 2 },
    { title: "Blog post on how we run design critique", status: "backlog", priority: "none", to: "penny" },
  ],
  research: [
    {
      title: "Recruit eight clinic patients",
      status: "in_progress",
      priority: "high",
      to: "penny",
      due: 1,
      about: "Mixed ages, and at least two who book for someone else.",
    },
    { title: "Tag last month's notes", status: "in_progress", priority: "low", to: "john", due: -3 },
    { title: "Synthesis workshop", status: "todo", priority: "medium", to: "penny", due: 6 },
    { title: "Share findings with Sample Client", status: "todo", priority: "high", to: "emelie", due: 6 },
    { title: "Interview guide for round two", status: "done", priority: "medium", to: "penny", doneAgo: 1 },
    { title: "Panel consent forms", status: "backlog", priority: "medium", to: "penny" },
  ],
}

const OWNERS: Record<keyof Projects, CrewKey> = {
  tallow: "test",
  sampleClient: "penny",
  system: "test",
  website: "emelie",
  research: "penny",
}

/** Each task as the create route makes it, then told to its assignee, and its comments told as the comment route tells them */
async function seedTasks(crew: Crew, projects: Projects) {
  for (const place of Object.keys(TASKS) as (keyof Projects)[]) {
    const creator = crew[OWNERS[place]]
    for (const [position, spec] of TASKS[place].entries()) {
      const taskId = await addTask(projects[place], creator, {
        title: spec.title,
        description: spec.about,
        status: spec.status,
        priority: spec.priority,
        assignee: crew[spec.to],
        dueDate: spec.due === undefined ? undefined : fromLocalNoon(spec.due, 5).toISOString(),
        completedAt: spec.doneAgo === undefined ? undefined : fromLocalNoon(-spec.doneAgo, 3).toISOString(),
        position,
      })
      await notify(creator.organizationId, { type: "task_added", actorId: creator.id, taskId })
      for (const [author, text] of spec.comments ?? []) {
        const content = withMentions(text, crew)
        const commentId = await addTaskComment(taskId, crew[author], content)
        await notify(creator.organizationId, {
          type: "comment",
          actorId: crew[author].id,
          taskId,
          commentId,
          mentions: parseMentions(content),
          edited: false,
        })
      }
    }
  }
}

async function seedCalendar(crew: Crew) {
  const zone = localZone()
  const { emelie, john, test, jane, penny, lorem } = crew
  const everyoneBut = (person: Person) => Object.values(crew).filter((other) => other.id !== person.id)
  const at = (day: number, start: number, end: number) => ({ startsAt: atClock(day, start), endsAt: atClock(day, end) })

  // Emelie's own week never overlaps, one to three events a day between 09:00 and 18:00. Others' events may
  const standup = await addEvent(emelie, {
    title: "Studio stand-up",
    description: "Fifteen minutes on what is blocked and who can help.",
    ...at(weekday(0), 9.5, 9.75),
    guests: everyoneBut(emelie),
    recurrence: { rule: "FREQ=WEEKLY;BYDAY=MO,WE,FR", timeZone: zone },
  })
  for (const guest of [john, test, jane, penny, lorem]) await respond(standup, guest, "yes")

  const kickoff = await addEvent(penny, {
    title: "Sample Client kickoff",
    description: "The goals for sprint 14 and who owns what.",
    ...at(weekday(0), 10.5, 11.5),
    videoCall: true,
    guests: [emelie, john, jane, test],
  })
  await respond(kickoff, emelie, "yes")
  await respond(kickoff, john, "yes")
  await addEvent(emelie, { title: "Renew the hosting", eventType: "task", ...at(weekday(0), 14, 14.5) })
  await addEvent(john, { title: "Focus: booking flow", eventType: "focus", ...at(weekday(0), 13, 15.5) })

  const oneToOne = await addEvent(emelie, {
    title: "One to one",
    ...at(weekday(1), 9.5, 10),
    guests: [john],
    recurrence: { rule: "FREQ=WEEKLY;BYDAY=TU", timeZone: zone },
  })
  await respond(oneToOne, john, "yes")
  await addEvent(emelie, { title: "Dentist", eventType: "personal", ...at(weekday(1), 16, 16.75) })

  await addEvent(test, {
    title: "Design week talks",
    description: "Talks across town all day. Join whichever you like.",
    eventType: "event",
    everyone: true,
    allDay: { from: localDate(weekday(2)), to: localDate(weekday(2)) },
  })
  const clientCall = await addEvent(penny, {
    title: "Sample Client client call",
    description: "Sprint 14 demo for the clinic owners, then questions.",
    ...at(weekday(2), 10.5, 11.25),
    videoCall: true,
    guests: [emelie, john, jane],
  })
  await respond(clientCall, emelie, "yes")
  await respond(clientCall, john, "yes")
  await respond(clientCall, jane, "maybe")
  const critique = await addEvent(test, {
    title: "Design critique",
    description: "Bring one screen you are stuck on.",
    location: "The studio, big table",
    ...at(weekday(2), 13, 14),
    videoCall: false,
    guests: [john, lorem, emelie, penny],
  })
  await respond(critique, john, "yes")
  await respond(critique, emelie, "maybe")

  await addEvent(emelie, { title: "Focus: quarterly plan", eventType: "focus", ...at(weekday(3), 9.5, 11.5) })
  const workshop = await addEvent(test, {
    title: "Bakery brand workshop",
    description: "How the new brand rolls out to the shops, the bags and the menus.",
    location: "The studio, big table",
    ...at(weekday(3), 13, 14.5),
    videoCall: false,
    guests: [emelie, lorem, penny],
  })
  await respond(workshop, emelie, "yes")
  await respond(workshop, lorem, "yes")
  await addEvent(emelie, {
    title: "Out of office",
    description: "Leaving early for the school play.",
    eventType: "ooo",
    ...at(weekday(3), 15, 18),
  })
  const checkIn = await addEvent(penny, { title: "Clinic owners check-in", ...at(weekday(3), 9, 9.5), videoCall: true, guests: [john] })
  await respond(checkIn, john, "yes")
  await addEvent(lorem, { title: "Focus: menu boards", eventType: "focus", ...at(weekday(3), 10, 12) })
  await addEvent(john, { title: "Send the dieline to the printer", eventType: "task", ...at(weekday(3), 16, 16.5) })

  // Today, which the messages talk about
  await addEvent(jane, {
    title: "Home sick",
    description: "Back on Monday.",
    eventType: "ooo",
    allDay: { from: localDate(0), to: localDate(0) },
  })
  const presentation = await addEvent(test, {
    title: "Sample Bakery presentation",
    location: "Sample Bakery, the corner shop",
    ...at(0, 14, 14.5),
    videoCall: false,
    guests: [emelie, lorem, penny],
  })
  await respond(presentation, emelie, "yes")
  await respond(presentation, penny, "yes")
  await respond(presentation, lorem, "no")

  await addEvent(penny, {
    title: "Friday fika",
    location: "The studio kitchen",
    eventType: "event",
    everyone: true,
    ...at(weekday(4), 15.5, 16),
  })
  const review = await addEvent(emelie, { title: "Portfolio review", ...at(weekday(4), 16, 17), guests: [john, lorem] })
  await respond(review, john, "yes")
  await respond(review, lorem, "yes")

  // Next week
  await addEvent(lorem, {
    title: "Out of office",
    description: "Visiting family. Back on Wednesday.",
    eventType: "ooo",
    allDay: { from: localDate(weekday(0, 1)), to: localDate(weekday(1, 1)) },
  })
  await addEvent(john, { title: "Focus: reminder settings", eventType: "focus", ...at(weekday(1, 1), 13, 15) })
  await addEvent(emelie, { title: "Team page bios", eventType: "task", ...at(weekday(2, 1), 10, 11) })
  await addEvent(emelie, {
    title: "Studio offsite",
    description: "A day on the island: a look back at the autumn and plans for the spring.",
    location: "Fjäderholmarna",
    eventType: "event",
    everyone: true,
    allDay: { from: localDate(weekday(3, 1)), to: localDate(weekday(3, 1)) },
  })
  await addEvent(test, { title: "Gym", eventType: "personal", ...at(weekday(4, 1), 16.5, 17.5) })

  // The two newest invites stay unanswered, so the screenshot account has them waiting in the bell
  const invite = async (organiser: Person, title: string, day: number, start: number, end: number, guests: Person[]) => {
    const startsAt = atClock(day, start)
    const id = await addEvent(organiser, { title, startsAt, endsAt: atClock(day, end), videoCall: true, guests })
    await notify(organiser.organizationId, {
      type: "event_changed",
      actorId: organiser.id,
      eventId: id,
      change: "invited",
      startsAt: startsAt.toISOString(),
      allDay: false,
      userIds: guests.map((guest) => guest.id),
    })
  }
  await invite(penny, "Sprint 14 planning", weekday(0, 1), 10, 11.5, [emelie, john, jane, test])
  await invite(penny, "Synthesis workshop", weekday(2, 1), 13, 16, [emelie, john, test])
}

async function seedTime(emelie: Person, projects: Projects) {
  const today = -weekday(0)
  const plan: [keyof Projects, number, string][] = [
    ["tallow", 90, "Brand presentation prep"],
    ["sampleClient", 60, "Sprint review and client notes"],
    ["website", 45, "Contact page feedback"],
    ["research", 30, "Interview read-through"],
    ["system", 75, "Token naming review"],
  ]
  for (let day = 0; day <= Math.min(today, 4); day++) {
    for (let n = 0; n < 3; n++) {
      const [place, minutes, note] = plan[(day + n) % plan.length]
      await logTime(emelie, localDate(weekday(day)), minutes + day * 5, { projectId: projects[place].id }, note)
    }
  }
}

/**
 * Notifications are stamped with the real clock. One about a message takes that message's time, and the rest step back
 * from SEED_NOW, the newest made the most recent: six this morning, then the evening before onwards
 */
async function backdateNotifications(organizationId: string) {
  const now = seedNow().toISOString()
  await db.execute(sql`
    with ranked as (
      select n.id, m.created_at as said,
        row_number() over (partition by n.user_id, m.id is null order by n.created_at desc, n.id desc)::int - 1 as back
      from notifications n
      left join messages m on m.id = n.message_id
      where n.organization_id = ${organizationId}
    ),
    stamped as (
      select id, coalesce(said, ${now}::timestamp - make_interval(mins => 25 + 45 * back + case when back >= 6 then 840 else 0 end)) as at
      from ranked
    )
    update notifications set created_at = stamped.at, updated_at = stamped.at
    from stamped
    where notifications.id = stamped.id
  `)
}

export async function seedShowcase(): Promise<ShowcaseIds> {
  const crew = await seedCrew()
  const projects = await seedProjects(crew)
  await seedTasks(crew, projects)
  await seedCalendar(crew)
  await seedShowcaseChats(crew, projects)
  const { sprintPaper } = await seedShowcaseDocs(crew, projects)
  await seedShowcaseAi(crew, projects, sprintPaper)
  await seedTime(crew.emelie, projects)
  await backdateNotifications(crew.emelie.organizationId)
  return {
    workspace: WORKSPACE,
    organizationId: crew.emelie.organizationId,
    admin: { email: emailOf("emelie"), name: `${MEMBERS.emelie.firstName} ${MEMBERS.emelie.lastName}` },
    projects: Object.fromEntries(Object.values(projects).map((project) => [project.slug, project.id])),
  }
}

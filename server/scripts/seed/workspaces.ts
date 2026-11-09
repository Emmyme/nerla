import { SEED_ACCOUNTS, type SeedAccount, type SeedEmail, type SeedWorkspace } from "./accounts"
import {
  addEvent,
  addTask,
  addTaskComment,
  createGroupChat,
  createPaper,
  createProject,
  createWorkspace,
  logTime,
  sendDirectMessage,
  sendGroupMessage,
  trashOne,
  uploadFile,
  type Person,
} from "./build"
import { daysAgo, fromLocalNoon, localDate, localZone } from "./time"

export type NerlaIds = {
  organizationId: string
  projects: Record<string, string>
  paperId: string
  trashedTaskId: string
  groupChatId: string
  fileId: string | null
}

export type OtherIds = { organizationId: string; projectId: string; projectSlug: string; taskId: string; paperId: string }

const accountsOf = (workspace: SeedWorkspace): SeedAccount[] => SEED_ACCOUNTS.filter((account) => account.workspace === workspace)

function personIn(people: Map<string, Person>) {
  return (email: SeedEmail): Person => {
    const person = people.get(email)
    if (!person) throw new Error(`The seed has no account ${email}`)
    return person
  }
}

const LAUNCH_PAPER = [
  "# Launch plan",
  "## Goals",
  "Ship the new website before the spring campaign, with the mobile app close behind.",
  "- Faster pages on every phone",
  "- One look across the site and the app",
  "## Open questions",
  "1. Which pages move first?",
  "2. Who signs off on the copy?",
  "- [x] Agree on the scope",
  "- [ ] Book the launch review",
  "> Diana reviews this plan and leaves her notes as comments.",
].join("\n")

export async function seedNerla(storage: boolean): Promise<NerlaIds> {
  const people = await createWorkspace("Nerla", accountsOf("Nerla"), true)
  const person = personIn(people)
  const admin = person("admin@nerla.com")
  const fiona = person("fiona@nerla.com")
  const diana = person("diana@nerla.com")

  const website = await createProject(admin, {
    name: "Website Redesign",
    description: "A faster, clearer website with a fresh look, ready before the spring campaign.",
    color: "#7CC2F7",
    members: [{ person: fiona, role: "member" }],
    startDate: daysAgo(30),
    endDate: fromLocalNoon(45).toISOString(),
  })
  const mobile = await createProject(admin, {
    name: "Mobile App",
    description: "The second version of the app, with offline mode and a new start screen.",
    color: "#D5EDB5",
    members: [
      { person: fiona, role: "admin" },
      { person: diana, role: "member" },
    ],
    startDate: daysAgo(14),
    endDate: fromLocalNoon(90).toISOString(),
  })
  const marketing = await createProject(diana, {
    name: "Spring Campaign",
    description: "Emails, social posts and the launch event for the relaunch.",
    color: "#FF9CC8",
    members: [{ person: admin, role: "member" }],
    startDate: daysAgo(7),
    endDate: fromLocalNoon(60).toISOString(),
  })

  const hero = await addTask(website, admin, {
    title: "Design the homepage hero",
    description: "A clear headline, one picture and one button. It should say what we do in five seconds.",
    status: "done",
    priority: "high",
    assignee: fiona,
    position: 0,
  })
  const nav = await addTask(website, admin, {
    title: "Build the responsive navigation",
    description: "Works from the smallest phone to a wide screen, with the menu reachable by keyboard.",
    status: "in_progress",
    priority: "high",
    assignee: fiona,
    dueDate: fromLocalNoon(3).toISOString(),
    position: 1,
  })
  const pricing = await addTask(website, admin, {
    title: "Write the pricing page",
    status: "todo",
    priority: "medium",
    assignee: admin,
    dueDate: fromLocalNoon(7).toISOString(),
    position: 2,
  })
  await addTask(website, fiona, {
    title: "Check colour contrast on every page",
    status: "backlog",
    priority: "low",
    assignee: fiona,
    position: 3,
  })
  const oldBanner = await addTask(website, admin, {
    title: "Old cookie banner",
    description: "Replaced by the new consent screen.",
    status: "todo",
    priority: "none",
    assignee: admin,
    position: 4,
  })

  const onboarding = await addTask(mobile, fiona, {
    title: "Redesign the start screens",
    description: "Three short steps: welcome, permissions and a first project.",
    status: "in_progress",
    priority: "high",
    assignee: diana,
    dueDate: fromLocalNoon(5).toISOString(),
    position: 0,
  })
  await addTask(mobile, fiona, { title: "Offline mode", status: "todo", priority: "high", assignee: fiona, position: 1 })
  await addTask(mobile, admin, { title: "Crash reports for the beta", status: "done", priority: "medium", assignee: admin, position: 2 })
  await addTask(mobile, diana, { title: "Dark mode icons", status: "backlog", priority: "low", assignee: diana, position: 3 })

  const emails = await addTask(marketing, diana, {
    title: "Draft the launch emails",
    status: "in_progress",
    priority: "medium",
    assignee: diana,
    dueDate: fromLocalNoon(4).toISOString(),
    position: 0,
  })
  await addTask(marketing, diana, { title: "Book the launch venue", status: "todo", priority: "high", assignee: admin, position: 1 })
  await addTask(marketing, admin, { title: "Pick the campaign photos", status: "done", priority: "low", assignee: diana, position: 2 })

  await addTaskComment(nav, admin, "Looks great on my phone. Can the menu close when I tap outside it?")
  await addTaskComment(nav, fiona, "Yes, that's in the next push.")
  await addTaskComment(hero, admin, "Approved, thank you!")
  await addTaskComment(onboarding, diana, "The first draft is in Figma, feedback welcome.")
  await addTaskComment(emails, admin, "Keep the subject lines short.")

  await trashOne(oldBanner, admin)

  const crew = await createGroupChat(admin, "Launch crew", "Everything about the spring launch", [fiona, diana])
  await sendGroupMessage(crew, admin, "Morning all! The launch review moves to Thursday.", 180)
  await sendGroupMessage(crew, fiona, "Works for me. The navigation will be ready by then.", 170)
  await sendGroupMessage(crew, diana, "I'll bring the email drafts.", 160)
  await sendDirectMessage(admin, fiona, "Have you got a minute for the pricing page later?", 90)
  await sendDirectMessage(fiona, admin, "Sure, after lunch.", 85)

  const paperId = await createPaper(admin, website, "Launch plan", LAUNCH_PAPER, [{ person: diana, level: "comment" }])

  const zone = localZone()
  await addEvent(admin, {
    title: "Daily standup",
    description: "Ten minutes on what is blocked.",
    startsAt: fromLocalNoon(0, -2.5),
    endsAt: fromLocalNoon(0, -2.25),
    guests: [fiona, diana],
    recurrence: { rule: "FREQ=DAILY", timeZone: zone },
  })
  await addEvent(fiona, {
    title: "Design critique",
    startsAt: fromLocalNoon(0, -1),
    endsAt: fromLocalNoon(0, -0.5),
    guests: [admin],
    recurrence: { rule: "FREQ=WEEKLY", timeZone: zone },
  })
  await addEvent(admin, {
    title: "Launch review",
    description: "Walk through the launch plan paper together.",
    startsAt: fromLocalNoon(0, 2),
    endsAt: fromLocalNoon(0, 3),
    guests: [fiona, diana],
  })
  await addEvent(diana, {
    title: "Team lunch",
    eventType: "event",
    location: "The corner cafe",
    startsAt: fromLocalNoon(0),
    endsAt: fromLocalNoon(0, 1),
    everyone: true,
  })
  await addEvent(fiona, { title: "Focus on navigation", eventType: "focus", startsAt: fromLocalNoon(1, -2), endsAt: fromLocalNoon(1, 0) })

  for (let day = 1; day <= 7; day++) {
    const date = localDate(-day)
    await logTime(admin, date, 90, { taskId: pricing }, "Pricing copy")
    await logTime(fiona, date, 120 + day * 10, { taskId: nav }, "Navigation")
    await logTime(diana, date, 60, { projectId: marketing.id }, "Campaign planning")
  }

  const fileId = storage
    ? await uploadFile(fiona, website, hero, "hero-notes.txt", "Hero notes\n\nHeadline: Work together, simply.\nButton: Start free\n")
    : null

  return {
    organizationId: admin.organizationId,
    projects: { [website.slug]: website.id, [mobile.slug]: mobile.id, [marketing.slug]: marketing.id },
    paperId,
    trashedTaskId: oldBanner,
    groupChatId: crew,
    fileId,
  }
}

export async function seedOther(): Promise<OtherIds> {
  const people = await createWorkspace("Other", accountsOf("Other"), false)
  const olga = personIn(people)("olga@other.test")
  const project = await createProject(olga, {
    name: "Other Roadmap",
    description: "Plans that only the Other workspace may see.",
    color: "#DCD0FF",
    members: [],
  })
  const taskId = await addTask(project, olga, {
    title: "Other secret task",
    description: "Nobody in Nerla should ever read this.",
    status: "todo",
    priority: "high",
    assignee: olga,
    position: 0,
  })
  const paperId = await createPaper(olga, project, "Other secret paper", "# Other secret paper\nOnly the Other workspace reads this.")
  return { organizationId: olga.organizationId, projectId: project.id, projectSlug: project.slug, taskId, paperId }
}

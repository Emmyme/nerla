import { markGroupRead } from "../../src/services/chats"
import { notify } from "../../src/services/notifications"
import { parseMentions } from "../../src/utils/mentions"
import { createGroupChat, pin, react, sendDirectMessage, sendGroupMessage, type Person, type ReactionKey } from "./build"
import { withMentions, type Crew, type CrewKey, type Projects } from "./showcaseCrew"

type ChatKey = "studio" | "design" | "fika" | keyof Projects

type Line = {
  chat: ChatKey
  from: CrewKey
  /** Minutes ago */
  ago: number
  text: string
  /** A name for the line, so later lines can reply to it */
  name?: string
  reply?: string
  reactions?: [CrewKey, ReactionKey][]
  pinned?: boolean
}

const LINES: Line[] = [
  {
    chat: "studio",
    from: "emelie",
    ago: 4300,
    text: "Studio hours this month: open 8 to 18, and Fridays end at 15 for fika.",
    pinned: true,
  },
  {
    chat: "studio",
    from: "emelie",
    ago: 2900,
    name: "offsite",
    text: "Good morning everyone! The studio offsite is next Thursday. I'll share the plan on Monday.",
    reactions: [
      ["penny", "party"],
      ["jane", "party"],
      ["john", "cat"],
    ],
  },
  { chat: "studio", from: "penny", ago: 2880, name: "bring", reply: "offsite", text: "Can't wait. Should we bring anything?" },
  { chat: "studio", from: "emelie", ago: 2870, reply: "bring", text: "Just yourselves and one thing you're proud of from this autumn." },
  {
    chat: "studio",
    from: "jane",
    ago: 1500,
    text: "The new contact page is on the staging site. Feedback very welcome before Friday.",
    reactions: [
      ["test", "fire"],
      ["emelie", "cat"],
    ],
  },
  { chat: "studio", from: "test", ago: 1490, text: "Looks lovely. The form labels could sit a little closer to the fields." },
  {
    chat: "studio",
    from: "jane",
    ago: 400,
    name: "sick",
    text: "I'm home sick today, sorry. I'll pick up the clinic list API on Monday.",
    reactions: [
      ["test", "heart"],
      ["emelie", "heart"],
      ["john", "heart"],
      ["penny", "cat-sleepy"],
    ],
  },
  { chat: "studio", from: "penny", ago: 390, reply: "sick", text: "Get well soon! Rest up." },
  { chat: "studio", from: "penny", ago: 120, text: "@emelie could you look at the Sample Client sprint notes before the client call?" },
  {
    chat: "studio",
    from: "lorem",
    ago: 45,
    text: "Morning from Toronto! The Sample Bakery lockups are in the project files.",
    reactions: [
      ["emelie", "fire"],
      ["test", "fire"],
      ["penny", "cat"],
    ],
  },

  {
    chat: "design",
    from: "test",
    ago: 2000,
    text: "Crit on Wednesday: bring one screen you are stuck on, not the one you are happiest with.",
    reactions: [["john", "check"]],
  },
  {
    chat: "design",
    from: "john",
    ago: 1980,
    name: "picker",
    text: "I'll bring the booking flow. The time picker still feels heavy.",
    reactions: [["penny", "cat-search"]],
  },
  {
    chat: "design",
    from: "penny",
    ago: 1970,
    reply: "picker",
    text: "The interviews back that up. Three of five people missed the slots below the fold.",
  },
  {
    chat: "design",
    from: "lorem",
    ago: 600,
    name: "menus",
    text: "Sharing the menu board drafts here first. Two directions, one with hand lettering.",
    reactions: [
      ["test", "heart"],
      ["emelie", "cat"],
      ["john", "cat"],
    ],
  },
  {
    chat: "design",
    from: "test",
    ago: 590,
    reply: "menus",
    text: "Hand lettering for the chalkboards, the clean one for print. Best of both.",
    reactions: [["lorem", "thumbs-up"]],
  },
  { chat: "design", from: "john", ago: 30, text: "@emelie do you want to join the crit? Ten minutes on the bakery packaging would help." },

  {
    chat: "fika",
    from: "penny",
    ago: 3000,
    name: "buns",
    text: "Cinnamon buns from Sample Bakery are on the kitchen table. Research perks.",
    reactions: [
      ["jane", "cat"],
      ["emelie", "cat"],
      ["john", "laugh"],
    ],
  },
  { chat: "fika", from: "jane", ago: 2990, reply: "buns", text: "The best kind of client research.", reactions: [["penny", "laugh"]] },
  { chat: "fika", from: "emelie", ago: 2980, text: "I saved one for whoever comes in late." },
  {
    chat: "fika",
    from: "penny",
    ago: 300,
    name: "lunch",
    text: "Lunch at the Thai place at 12? I'm booking for six.",
    reactions: [
      ["john", "thumbs-up"],
      ["test", "thumbs-up"],
      ["emelie", "thumbs-up"],
    ],
  },
  { chat: "fika", from: "john", ago: 295, reply: "lunch", text: "Count me in." },
  { chat: "fika", from: "test", ago: 290, reply: "lunch", text: "Me too, I'll be a few minutes late." },

  { chat: "tallow", from: "test", ago: 1600, text: "The owners loved the warmer palette. Next step is the lockups." },
  { chat: "tallow", from: "lorem", ago: 1590, text: "On it. The stamp version will be ready by Thursday." },
  {
    chat: "tallow",
    from: "penny",
    ago: 200,
    name: "licence",
    text: "The typeface licence is still waiting on their lawyer. I'll chase it today.",
    reactions: [["emelie", "cat-search"]],
  },
  { chat: "tallow", from: "emelie", ago: 190, reply: "licence", text: "Thank you. Tell me if I should call them." },

  { chat: "sampleClient", from: "penny", ago: 1300, text: "Sprint 14 starts on Monday. The booking flow and the date picker come first." },
  {
    chat: "sampleClient",
    from: "jane",
    ago: 1290,
    text: "The date picker now reads well with VoiceOver.",
    reactions: [
      ["penny", "party"],
      ["john", "fire"],
    ],
  },
  { chat: "sampleClient", from: "jane", ago: 1280, text: "The clinic list API is nearly there, two endpoints left." },
  { chat: "sampleClient", from: "john", ago: 60, text: "@emelie the second round of the booking flow is ready for a look." },
  {
    chat: "sampleClient",
    from: "penny",
    ago: 50,
    text: "Recruiting is going well, six of eight patients are booked.",
    reactions: [
      ["john", "thumbs-up"],
      ["emelie", "party"],
    ],
  },

  { chat: "system", from: "jane", ago: 2200, text: "The button tokens are merged.", reactions: [["test", "check"]] },
  { chat: "system", from: "test", ago: 2190, text: "Lovely. The contrast audit is next, I'll start on Monday." },
  {
    chat: "system",
    from: "lorem",
    ago: 700,
    text: "The icon set is down to 64 icons from 112.",
    reactions: [
      ["test", "party"],
      ["jane", "cat"],
    ],
  },

  { chat: "website", from: "emelie", ago: 2500, name: "golive", text: "@jane can the contact page go live on Friday?" },
  { chat: "website", from: "jane", ago: 2490, reply: "golive", text: "Yes, if the copy is final by Thursday." },
  { chat: "website", from: "lorem", ago: 800, text: "The Sample Client case study needs two more screenshots." },

  { chat: "research", from: "penny", ago: 1800, text: "The interview guide for round two is done. The notes template is in the library." },
  { chat: "research", from: "emelie", ago: 1790, text: "Great work. Add the clinic questions when you can." },
  {
    chat: "research",
    from: "john",
    ago: 1000,
    text: "I'm tagging last month's notes, about halfway now.",
    reactions: [["penny", "cat-sleepy"]],
  },
]

/** Chats the screenshot account has read. The rest show as unread */
const READ: ChatKey[] = ["fika", "tallow", "system", "website", "research"]

export async function seedShowcaseChats(crew: Crew, projects: Projects) {
  const { emelie, john, test, jane, penny, lorem } = crew
  const everyone = Object.values(crew)
  const chats: Record<ChatKey, string> = {
    studio: await createGroupChat(emelie, "Studio", "News, plans and questions for the whole studio", everyone),
    design: await createGroupChat(test, "Design crew", "Work in progress, critique and inspiration", [john, lorem, emelie, penny]),
    fika: await createGroupChat(penny, "Lunch and fika", "Food, coffee and the occasional cat picture", everyone),
    ...(Object.fromEntries(Object.entries(projects).map(([key, project]) => [key, project.chatId])) as Record<keyof Projects, string>),
  }

  const named = new Map<string, string>()
  for (const line of [...LINES].sort((a, b) => b.ago - a.ago)) {
    const sender = crew[line.from]
    const content = withMentions(line.text, crew)
    const id = await sendGroupMessage(chats[line.chat], sender, content, line.ago, line.reply ? named.get(line.reply) : null)
    if (line.name) named.set(line.name, id)
    for (const [who, emoji] of line.reactions ?? []) await react(id, crew[who], emoji)
    if (line.pinned) await pin(id)
    const mentions = parseMentions(content)
    if (mentions.length) await notify(sender.organizationId, { type: "message", actorId: sender.id, messageId: id, mentions })
  }
  for (const chat of READ) await markGroupRead(chats[chat], emelie.id)

  const dm = (from: Person, to: Person, text: string, ago: number, read = true) => sendDirectMessage(from, to, text, ago, read)
  await dm(emelie, jane, "Thanks for staying late on the contact page.", 1440)
  await dm(jane, emelie, "Happy to. It was fun to build.", 1430)
  await dm(penny, emelie, "I put the sprint notes in the Sample Client paper. Could you read them tonight?", 90)
  await dm(emelie, penny, "Yes, I'll read them after the presentation.", 85)
  await dm(penny, emelie, "Thank you! I added the clinic's questions at the bottom.", 15, false)
  await dm(lorem, emelie, "Morning! Do you have ten minutes for the Sample Bakery lockups today?", 40, false)
  await dm(john, emelie, "Quick one: are we still on for the portfolio review on Friday at 4?", 20, false)
}

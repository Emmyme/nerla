/**
 * The AI teammate for screenshots: switched on with a placeholder local model that is never called, and a short DM
 * with Emelie that ends on a waiting Allow card
 */
import { randomUUID } from "node:crypto"
import { aiActivity, aiHeld, aiMessages, aiRequests, db } from "../../src/db"
import { saveWorkspaceAi } from "../../src/services/aiSettings"
import { threadIdOf } from "../../src/services/aiThread"
import { toolByName, type ToolContext } from "../../src/services/aiTools"
import type { HeldItem } from "../../src/utils/aiGate"
import type { Crew, Projects } from "./showcaseCrew"
import { localDate, seedNow, weekday } from "./time"

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

const PLATE = (projects: Projects, sprintPaper: string) =>
  [
    "Here's the rest of your day:",
    "",
    "- **14:00** Sample Bakery presentation at the corner shop, with Test and Penny",
    "- **16:00** Dentist",
    "",
    "Your tasks in progress:",
    "",
    `- **Present the brand to the owners** in [Sample Bakery rebrand](/project/${projects.tallow.slug}), due today. Test left the printed samples on your desk, in the brown envelope.`,
    `- **Sprint 14 review notes**, due tomorrow before the client call at 10:30. Penny's notes are in [Sample Client sprint 14](/paper/${sprintPaper}).`,
    "",
    "Two people are waiting on you as well. Lorem would like ten minutes on the bakery lockups, and John says the second round of the booking flow is ready for a look.",
  ].join("\n")

const BOOKED =
  "Thursday at 14:30 is free for you both, right after the brand workshop and before John sends the dieline to the printer at 16:00. Allow it and John gets the invite."

export async function seedShowcaseAi(crew: Crew, projects: Projects, sprintPaper: string) {
  const { emelie, john } = crew
  const { organizationId } = emelie
  await saveWorkspaceAi(
    { organizationId, userId: emelie.id },
    { enabled: true, baseUrl: "http://localhost:11434/v1", model: "llama3.2", localNetwork: true },
  )

  const threadId = await threadIdOf(organizationId, emelie.id)
  const now = seedNow().getTime()
  const at = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE).toISOString()

  const turn = async (asked: number, answered: number, question: string, answer: string, tools: string[]) => {
    const [request] = await db
      .insert(aiRequests)
      .values({
        organizationId,
        userId: emelie.id,
        source: "ai",
        place: { kind: "dm" },
        steps: tools.length,
        status: "done",
        createdAt: at(asked),
        finishedAt: at(answered),
      })
      .returning({ id: aiRequests.id })
    await db.insert(aiMessages).values([
      { organizationId, threadId, role: "user", content: question, requestId: request.id, createdAt: at(asked) },
      { organizationId, threadId, role: "assistant", content: answer, requestId: request.id, createdAt: at(answered) },
    ])
    return request.id
  }

  await turn(20, 19.8, "What's on my plate today?", PLATE(projects, sprintPaper), ["list_events", "list_tasks", "list_chats"])
  const asked = "Can you book half an hour with John on Thursday to check the dieline before it goes to the printer?"
  const requestId = await turn(16, 15.7, asked, BOOKED, ["find_time", "create_event"])

  // The card as the gate holds it: the tool's own checked arguments and summary
  const createEvent = toolByName("create_event")!
  const day = localDate(weekday(3))
  const args = createEvent.input.parse({
    title: "Dieline check",
    start: `${day}T14:30`,
    end: `${day}T15:00`,
    description: "A last look at the bread bag dieline before it goes to the printer.",
    attendee_ids: [john.id],
  })
  const ctx: ToolContext = {
    askerId: emelie.id,
    organizationId,
    isAdmin: emelie.isOrgAdmin,
    via: { kind: "ai" },
    requestId,
    place: { kind: "dm" },
    audience: null,
    scopes: null,
    signal: new AbortController().signal,
  }
  const items: HeldItem[] = [{ id: randomUUID(), tool: createEvent.name, args, summary: (await createEvent.summary!(args, ctx)).trim() }]
  // The browser clock sits at SEED_NOW and the server sweeps by the real clock, so the card outlives both
  const expiresAt = new Date(Math.max(now, Date.now()) + 30 * DAY).toISOString()
  await db.insert(aiHeld).values({ organizationId, userId: emelie.id, requestId, kind: "changes", items, expiresAt, createdAt: at(15.75) })

  const log = (tool: string, result: "ok" | "held", minutesAgo: number) => ({
    organizationId,
    userId: emelie.id,
    source: "ai",
    tool,
    result,
    createdAt: at(minutesAgo),
  })
  await db
    .insert(aiActivity)
    .values([
      log("list_events", "ok", 19.95),
      log("list_tasks", "ok", 19.9),
      log("list_chats", "ok", 19.85),
      log("find_time", "ok", 15.9),
      log("create_event", "held", 15.75),
    ])
}

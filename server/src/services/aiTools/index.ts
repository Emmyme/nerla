import { z } from "zod"
import { filterShared } from "../../utils/aiPlace"
import type { ToolSpec } from "../../utils/aiTypes"
import { checkPreference, checkReplacing, foldLine, PREF_MAX_CHARS, PREF_MAX_LINES, PREFS_OFF } from "../../utils/aiMemory"
import { logger } from "../../utils/logger"
import { AppError } from "../acting"
import { preferencesOf, preferencesOn, savePreference } from "../aiMemory"
import { timeTrackingOn } from "../timeEntries"
import { CALENDAR_TOOLS } from "./calendar"
import { CHAT_TOOLS } from "./chat"
import { DOC_TOOLS } from "./docs"
import { FILE_TOOLS } from "./files"
import { PEOPLE_TOOLS } from "./people"
import { PROJECT_TOOLS } from "./projects"
import { placeReader } from "./reader"
import { OWN_VIEW_REFUSAL, tool, type ToolContext, type ToolDef, type ToolResult } from "./shared"
import { TASK_TOOLS } from "./tasks"
import { TIME_TOOLS } from "./time"
import { TRASH_TOOL_DEFS } from "./trash"

export type { ToolContext, ToolDef, ToolResult } from "./shared"

export const APPLY_CHANGES = "apply_changes"
const BATCH_LIMIT = 25

/** Its changes are checked and run one by one by the gate, which holds them on one card when any needs Allow */
const applyChanges = tool({
  name: APPLY_CHANGES,
  area: "both",
  write: true,
  description:
    "Make several changes in one go, each as a call of another write tool with its own arguments. When any needs the user's Allow they are all shown on one card. Deletes and restores can't go in it.",
  input: z.object({
    changes: z
      .array(
        z.object({
          tool: z.string().max(60).describe("The name of a write tool"),
          args: z.record(z.string(), z.unknown()).optional().describe("That tool's arguments"),
        }),
      )
      .min(1)
      .max(BATCH_LIMIT),
  }),
  async run() {
    return { ok: false, error: "apply_changes runs only through the gate" }
  },
})

export const ASK_PRIVATE = "ask_private"

/** Makes a card only the asker sees in a shared place. The AI teammate holds it itself, so it never runs here */
const askPrivate = tool({
  name: ASK_PRIVATE,
  area: "people",
  write: false,
  aiOnly: true,
  description:
    "Ask the user, on a card only they see, whether you may use their own private things to answer. They pick Share in chat, to answer here with them, or Keep private, to answer in their DM with you.",
  input: z.object({ reason: z.string().trim().min(1).max(200).describe("What you need, in a few words, such as your tasks this week") }),
  async run() {
    return { ok: false, error: "ask_private runs only through the AI teammate" }
  },
})

export const SAVE_PREFERENCE = "save_preference"

/** Always waits for the asker's Allow on a card only they see, so nothing is saved without their yes */
const savePreferenceTool = tool({
  name: SAVE_PREFERENCE,
  area: "people",
  write: true,
  aiOnly: true,
  alwaysGated: () => true,
  description:
    "Offer to remember a lasting preference of the user's, as one short line in their own words. Use it when they state one, and when their answer to your question would settle the same question next time. They see the exact line on a card and choose Remember or Not now. Call it on its own, after any change it goes with is done. When it contradicts a saved preference, pass that preference's number as replaces and its words as replacing.",
  input: z.object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(PREF_MAX_CHARS)
      .transform(foldLine)
      .describe("The preference as one line, such as Call meetings syncs"),
    replaces: z
      .number()
      .int()
      .min(1)
      .max(PREF_MAX_LINES)
      .optional()
      .describe("The number of the saved preference this one takes the place of"),
    replacing: z.string().max(PREF_MAX_CHARS).optional().describe("The words of that saved preference, exactly as numbered"),
  }),
  async precheck(ctx, args) {
    const { use, lines } = await preferencesOf({ userId: ctx.askerId, organizationId: ctx.organizationId })
    if (!use) return PREFS_OFF
    return checkPreference(lines, args.text, args.replaces) ?? checkReplacing(lines, args.replaces, args.replacing)
  },
  async othersCanSee() {
    return false
  },
  async summary(args, ctx) {
    const old = args.replaces
      ? (await preferencesOf({ userId: ctx.askerId, organizationId: ctx.organizationId })).lines[args.replaces - 1]
      : undefined
    return old ? `Remember: ${args.text}, instead of: ${old.text}` : `Remember: ${args.text}`
  },
  run: (ctx, args) => savePreference({ userId: ctx.askerId, organizationId: ctx.organizationId }, args.text, args.replaces, args.replacing),
})

export const POST_REPLY = "post_reply"

/** The card an answer waits on after "Share in chat". Only Allow on that card posts it */
const postReply = tool({
  name: POST_REPLY,
  area: "chat",
  write: true,
  internal: true,
  description: "Post the AI's answer in the place it was asked in.",
  input: z.object({}),
  async run() {
    return { ok: false, error: "post_reply runs only from its card" }
  },
})

export const TOOLS: ToolDef[] = [
  ...TASK_TOOLS,
  ...PROJECT_TOOLS,
  ...CALENDAR_TOOLS,
  ...DOC_TOOLS,
  ...CHAT_TOOLS,
  ...FILE_TOOLS,
  ...TIME_TOOLS,
  ...PEOPLE_TOOLS,
  ...TRASH_TOOL_DEFS,
  applyChanges,
  askPrivate,
  savePreferenceTool,
  postReply,
]

export const toolByName = (name: string): ToolDef | undefined => TOOLS.find((tool) => tool.name === name)

function parametersOf(schema: z.ZodType): object {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
  return parameters
}

/** An AI teammate only tool is never offered over MCP, the private card only in a shared place, and saving only while preferences are on */
async function aiOnlyOffers(ctx: ToolContext): Promise<(tool: ToolDef) => boolean> {
  if (ctx.via.kind !== "ai") return () => false
  const remember = await preferencesOn(ctx.askerId, ctx.organizationId)
  return (tool) => (tool.name === ASK_PRIVATE ? !!ctx.audience : tool.name !== SAVE_PREFERENCE || remember)
}

/** The tools as the model is offered them. Time tracking shows only while the workspace has it on */
export async function toolSpecs(ctx: ToolContext): Promise<ToolSpec[]> {
  const [timeOn, aiOnly] = await Promise.all([timeTrackingOn(ctx.organizationId), aiOnlyOffers(ctx)])
  return TOOLS.filter((tool) => !tool.internal && (tool.area !== "time" || timeOn) && (!tool.aiOnly || aiOnly(tool))).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: parametersOf(tool.input) },
  }))
}

const NOT_FOUND = { ok: false as const, error: "not found" }

/**
 * Runs one tool as the asker. In a shared place only what every member can read comes back, and anything
 * hidden answers "not found". Allow and scopes are checked before this
 */
export async function runTool(ctx: ToolContext, name: string, rawArgs: unknown): Promise<ToolResult> {
  const tool = toolByName(name)
  if (!tool) return { ok: false, error: `There is no tool called ${name}` }
  if (ctx.signal.aborted) return { ok: false, error: "Stopped" }
  if (tool.ownView && ctx.audience?.some((id) => id !== ctx.askerId)) return { ok: false, error: OWN_VIEW_REFUSAL }
  const parsed = tool.input.safeParse(rawArgs ?? {})
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) }
  try {
    const result = await tool.run(ctx, parsed.data)
    if (!result.ok || !ctx.audience || !result.items) return result
    const items = await filterShared(result.items, ctx.audience, placeReader(ctx.organizationId, ctx.audience))
    if (result.target && result.items.length > 0 && items.length === 0) return NOT_FOUND
    return { ...result, items }
  } catch (error) {
    if (error instanceof AppError) return error.status === 403 || error.status === 404 ? NOT_FOUND : { ok: false, error: error.message }
    logger.error(`AI tool ${name} failed`, error)
    return { ok: false, error: "Something went wrong" }
  }
}

import { UUID_TEXT as UUID } from "./uuid"

/** A mention as stored, `@[userId]`. The website's `lib/mentions.ts` keeps the same pattern */
const MENTION = new RegExp(`@\\[(${UUID})\\]`, "gi")
/** The same token for Postgres, matched with its `i` flag */
export const MENTION_PG = `@\\[${UUID}\\]`
export const MENTION_PG_CAPTURE = `@\\[(${UUID})\\]`

/** How a user who left the workspace, or was never in it, is shown */
export const SOMEONE = "Someone"

export type MentionNames = ReadonlyMap<string, string>

/** The users a text mentions, as `@[userId]` tokens */
export function parseMentions(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((match) => match[1].toLowerCase()))]
}

/** Mentioned in the new text and not in the old one */
export function addedMentions(before: string, after: string): string[] {
  const old = new Set(parseMentions(before))
  return parseMentions(after).filter((id) => !old.has(id))
}

/** The text as users read it, each token as "@Name" */
export function renderMentions(text: string, names: MentionNames): string {
  return text.replace(MENTION, (_, id: string) => `@${names.get(id.toLowerCase()) ?? SOMEONE}`)
}

/** The AI teammate's mention token, `@[ai]`. It is never a user, so `parseMentions` skips it */
const AI_TOKEN = /@\[ai\]/gi

export const mentionsAi = (text: string): boolean => new RegExp(AI_TOKEN.source, "i").test(text)

/** An edit that tags the AI where the text before it didn't, so re-saving a tagged text never asks again */
export const addedAiMention = (before: string, after: string): boolean => mentionsAi(after) && !mentionsAi(before)

/** The text the AI is asked, without its own mention */
export const withoutAiMention = (text: string): string =>
  text
    .replace(AI_TOKEN, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim()

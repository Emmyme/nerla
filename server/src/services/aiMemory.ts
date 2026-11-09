import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { aiPreferences, db, type Tx } from "../db"
import {
  applyPreference,
  checkPreference,
  checkReplacing,
  foldLine,
  PREFS_CHANGED,
  PREFS_OFF,
  sameLine,
  type PrefLine,
} from "../utils/aiMemory"
import { AiRefusal } from "./aiSettings"
import type { ToolResult } from "./aiTools/shared"

type Viewer = { userId: string; organizationId: string }

type Preferences = { use: boolean; lines: PrefLine[] }
/** With when it was last saved, null before the first save, so an edit can say which version it started from */
type SavedPreferences = Preferences & { updatedAt: string | null }

const PREFS_STALE = "Your preferences changed somewhere else since you opened this page. Reload them, then make your changes again"

const whereMine = (organizationId: string, userId: string) =>
  and(eq(aiPreferences.organizationId, organizationId), eq(aiPreferences.userId, userId))

/** The user's own list. A user who never saved one has an empty list that is on */
export async function preferencesOf(viewer: Viewer): Promise<SavedPreferences> {
  const [row] = await db
    .select({ use: aiPreferences.use, lines: aiPreferences.lines, updatedAt: aiPreferences.updatedAt })
    .from(aiPreferences)
    .where(whereMine(viewer.organizationId, viewer.userId))
    .limit(1)
  return row ?? { use: true, lines: [], updatedAt: null }
}

/** The lines the AI follows, or null when they are off or there are none */
export async function preferencesFor(userId: string, organizationId: string): Promise<PrefLine[] | null> {
  const { use, lines } = await preferencesOf({ userId, organizationId })
  return use && lines.length > 0 ? lines : null
}

export async function preferencesOn(userId: string, organizationId: string): Promise<boolean> {
  return (await preferencesOf({ userId, organizationId })).use
}

/** The user's row under its lock, so two saves never lose one another's line */
async function lockedRow(tx: Tx, viewer: Viewer) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai-preferences:${viewer.organizationId}:${viewer.userId}`}, 0))`)
  const [row] = await tx.select().from(aiPreferences).where(whereMine(viewer.organizationId, viewer.userId)).limit(1)
  return row ?? null
}

async function write(tx: Tx, viewer: Viewer, current: { id: string } | null, next: Preferences): Promise<SavedPreferences> {
  const values = { ...next, updatedAt: new Date().toISOString() }
  const [saved] = current
    ? await tx
        .update(aiPreferences)
        .set(values)
        .where(and(eq(aiPreferences.id, current.id), eq(aiPreferences.organizationId, viewer.organizationId)))
        .returning({ use: aiPreferences.use, lines: aiPreferences.lines, updatedAt: aiPreferences.updatedAt })
    : await tx
        .insert(aiPreferences)
        .values({ organizationId: viewer.organizationId, userId: viewer.userId, ...values })
        .returning({ use: aiPreferences.use, lines: aiPreferences.lines, updatedAt: aiPreferences.updatedAt })
  return saved
}

/** Saves one line the user allowed, checked again under the lock since the list may have changed while the card waited */
export async function savePreference(asker: Viewer, text: string, replaces?: number, replacing?: string): Promise<ToolResult> {
  return db.transaction(async (tx) => {
    const current = await lockedRow(tx, asker)
    const lines = current?.lines ?? []
    if (current && !current.use) return { ok: false as const, error: PREFS_OFF }
    if (checkReplacing(lines, replaces, replacing)) return { ok: false as const, error: PREFS_CHANGED }
    const refusal = checkPreference(lines, text, replaces)
    if (refusal) return { ok: false as const, error: refusal }
    const old = replaces === undefined ? null : lines[replaces - 1].text
    await write(tx, asker, current, { use: true, lines: applyPreference(lines, text, replaces, randomUUID()) })
    return { ok: true as const, data: { saved: foldLine(text), ...(old ? { replaced: old } : {}) }, authors: [] }
  })
}

/**
 * The whole list as the user edited it in Settings. A text left as it was keeps its id. `basedOn` is the version
 * the page loaded, so a line the AI saved meanwhile is never written over
 */
export async function replacePreferences(
  viewer: Viewer,
  next: { use: boolean; lines: string[]; basedOn: string | null },
): Promise<SavedPreferences> {
  const texts = next.lines.map(foldLine)
  for (const [index, text] of texts.entries()) {
    const earlier = texts.findIndex((other) => sameLine(other, text))
    if (earlier < index) throw new AiRefusal(400, `Line ${index + 1} repeats line ${earlier + 1}. Remove one of them`)
  }
  return db.transaction(async (tx) => {
    const current = await lockedRow(tx, viewer)
    if ((current?.updatedAt ?? null) !== next.basedOn) throw new AiRefusal(409, PREFS_STALE)
    const unused = [...(current?.lines ?? [])]
    const lines = texts.map((text) => {
      const at = unused.findIndex((line) => line.text === text)
      const id = at >= 0 ? unused.splice(at, 1)[0].id : randomUUID()
      return { id, text }
    })
    return write(tx, viewer, current, { use: next.use, lines })
  })
}

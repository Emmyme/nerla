import { and, eq, sql } from "drizzle-orm"
import { aiPersonal, aiSettings, db, fileAttachments, type Tx } from "../db"
import { STRICTNESS_LEVELS } from "../utils/aiTypes"
import { logger } from "../utils/logger"
import { checkModelUrl } from "../utils/modelAddress"
import { isSafeInlineImageType } from "../utils/mimeValidation"
import { NoMasterKey, open, seal } from "../utils/secretBox"

export type AiSettingsRow = typeof aiSettings.$inferSelect
export type AiPersonalRow = typeof aiPersonal.$inferSelect

export class AiRefusal extends Error {
  constructor(
    readonly code: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message)
  }
}

export async function workspaceAi(organizationId: string): Promise<AiSettingsRow | null> {
  const row = await db.query.aiSettings.findFirst({ where: eq(aiSettings.organizationId, organizationId) })
  return row ?? null
}

export async function personalAi(userId: string, organizationId: string): Promise<AiPersonalRow | null> {
  const row = await db.query.aiPersonal.findFirst({
    where: and(eq(aiPersonal.organizationId, organizationId), eq(aiPersonal.userId, userId)),
  })
  return row ?? null
}

/** The AI teammate shows up only once a model is connected */
export const aiAvailable = (org: Pick<AiSettingsRow, "enabled" | "baseUrl" | "model"> | null): boolean =>
  !!org && org.enabled && !!org.baseUrl && !!org.model

const lock = (tx: Tx, key: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)

/** The workspace row, made on first use. One per workspace, so making it waits on the lock */
async function settingsIn(tx: Tx, organizationId: string): Promise<AiSettingsRow> {
  await lock(tx, `ai-settings:${organizationId}`)
  const [existing] = await tx.select().from(aiSettings).where(eq(aiSettings.organizationId, organizationId)).limit(1)
  if (existing) return existing
  const [created] = await tx.insert(aiSettings).values({ organizationId }).returning()
  return created
}

export const ensureWorkspaceAi = (organizationId: string): Promise<AiSettingsRow> => db.transaction((tx) => settingsIn(tx, organizationId))

/** A key sealed for storage, or the two fields that clear it */
function sealKey(key: string): { keyCipher: string | null; keyLast4: string | null } {
  if (!key) return { keyCipher: null, keyLast4: null }
  try {
    return { keyCipher: seal(key), keyLast4: key.slice(-4) }
  } catch (error) {
    if (error instanceof NoMasterKey) throw new AiRefusal(409, error.message)
    throw error
  }
}

function checkAddress(baseUrl: string | null, local: boolean) {
  if (!baseUrl) return
  const checked = checkModelUrl(baseUrl, { local })
  if (!checked.ok) throw new AiRefusal(400, checked.reason)
}

type WorkspaceAiPatch = Partial<
  Pick<
    AiSettingsRow,
    | "enabled"
    | "mcpEnabled"
    | "baseUrl"
    | "model"
    | "name"
    | "avatarFileId"
    | "monthlyBudget"
    | "personBudget"
    | "allowPersonalKey"
    | "allowPersonalUrl"
    | "localNetwork"
    | "strictness"
  > & { key: string }
>

async function checkAvatar(tx: Tx, fileId: string, viewer: { organizationId: string; userId: string }) {
  const file = await tx.query.fileAttachments.findFirst({
    where: and(
      eq(fileAttachments.id, fileId),
      eq(fileAttachments.organizationId, viewer.organizationId),
      eq(fileAttachments.uploadedBy, viewer.userId),
      eq(fileAttachments.kind, "avatar"),
    ),
    columns: { mimeType: true },
  })
  if (!file) throw new AiRefusal(400, "Avatar file not found")
  if (!isSafeInlineImageType(file.mimeType)) throw new AiRefusal(400, "Avatar must be a JPEG, PNG, GIF, WebP, AVIF, or BMP image")
}

export async function saveWorkspaceAi(viewer: { organizationId: string; userId: string }, patch: WorkspaceAiPatch): Promise<AiSettingsRow> {
  return db.transaction(async (tx) => {
    const current = await settingsIn(tx, viewer.organizationId)
    const { key, ...fields } = patch
    const next = { ...current, ...fields }
    // A saved address has to stay valid when the local network switch changes
    if (fields.baseUrl !== undefined || fields.localNetwork !== undefined) checkAddress(next.baseUrl, next.localNetwork)
    if (fields.avatarFileId) await checkAvatar(tx, fields.avatarFileId, viewer)
    const [saved] = await tx
      .update(aiSettings)
      .set({ ...fields, ...(key === undefined ? {} : sealKey(key)), updatedAt: new Date().toISOString() })
      .where(and(eq(aiSettings.id, current.id), eq(aiSettings.organizationId, viewer.organizationId)))
      .returning()
    return saved
  })
}

type PersonalAiPatch = Partial<Pick<AiPersonalRow, "baseUrl" | "model" | "strictness"> & { key: string }>

/** What a user may set depends on the workspace switches, and a stricter level is always allowed */
export async function savePersonalAi(
  viewer: { organizationId: string; userId: string },
  org: AiSettingsRow | null,
  patch: PersonalAiPatch,
): Promise<AiPersonalRow> {
  const { key, ...fields } = patch
  if ((fields.baseUrl || fields.model) && !org?.allowPersonalUrl) {
    throw new AiRefusal(403, "Your admin hasn't allowed your own address")
  }
  if (key && !org?.allowPersonalKey && !org?.allowPersonalUrl) {
    throw new AiRefusal(403, "Your admin hasn't allowed your own key")
  }
  if (fields.strictness && STRICTNESS_LEVELS.indexOf(fields.strictness) > STRICTNESS_LEVELS.indexOf(org?.strictness ?? "tainted")) {
    throw new AiRefusal(400, "Your level can't be looser than the workspace's")
  }
  // A personal address never gets the local network exception
  checkAddress(fields.baseUrl ?? null, false)

  return db.transaction(async (tx) => {
    await lock(tx, `ai-personal:${viewer.organizationId}:${viewer.userId}`)
    const [current] = await tx
      .select()
      .from(aiPersonal)
      .where(and(eq(aiPersonal.organizationId, viewer.organizationId), eq(aiPersonal.userId, viewer.userId)))
      .limit(1)
    // An address with no model would never be used, and its key would have nowhere to go
    const next = { ...current, ...fields }
    if (next.baseUrl && !next.model) {
      throw new AiRefusal(400, "Add the model name your address serves")
    }
    const changes = { ...fields, ...(key === undefined ? {} : sealKey(key)), updatedAt: new Date().toISOString() }
    if (!current) {
      const [created] = await tx
        .insert(aiPersonal)
        .values({ organizationId: viewer.organizationId, userId: viewer.userId, ...changes })
        .returning()
      return created
    }
    const [saved] = await tx
      .update(aiPersonal)
      .set(changes)
      .where(and(eq(aiPersonal.id, current.id), eq(aiPersonal.organizationId, viewer.organizationId)))
      .returning()
    return saved
  })
}

export type ModelChoice = { baseUrl: string; model: string; key: string | null; local: boolean; personal: boolean }

/**
 * The connection a user's own turn in their DM would use. A personal address brings its own key, so the
 * workspace key never goes to it, and it never gets the local network exception
 */
export function modelChoice(org: AiSettingsRow | null, personal: AiPersonalRow | null): ModelChoice | null {
  if (!org) return null
  try {
    const ownAddress = !!(org.allowPersonalUrl && personal?.baseUrl && personal.model)
    // A key saved with an address of its own only ever goes to that address
    const keyForWorkspace = !personal?.baseUrl && org.allowPersonalKey
    const ownKey = personal?.keyCipher && (ownAddress || keyForWorkspace) ? personal.keyCipher : null
    const baseUrl = ownAddress ? personal!.baseUrl : org.baseUrl
    const model = ownAddress ? personal!.model : org.model
    if (!baseUrl || !model) return null
    const sealed = ownKey ?? (ownAddress ? null : org.keyCipher)
    return {
      baseUrl,
      model,
      key: sealed ? open(sealed) : null,
      local: ownAddress ? false : org.localNetwork,
      // A member's key at the workspace address skips the budgets only where that address needs a real key
      personal: ownAddress || (!!ownKey && !!org.keyCipher && !org.localNetwork),
    }
  } catch (error) {
    logger.warn("Couldn't read the stored model key", { reason: error instanceof NoMasterKey ? "no master key" : "key did not open" })
    return null
  }
}

import { z } from "zod"
import { DAY_MS, isUtcMidnight, isValidTimeZone, parseInstant } from "../utils/eventTime"
import { isValidRecurrenceRule, normalizeRecurrenceRule } from "../utils/recurrence"
import { GRANT_LEVELS, SHARE_LEVELS } from "../utils/eventVisibility"
import { REACTION_KEYS } from "../utils/reactions"
import { LINK_EXPIRIES } from "../utils/fileLinks"
import { STATUS_OVERRIDES } from "../utils/statusOverride"
import { SYMBOL_KEYS } from "../utils/symbols"
import { FREE_MAX_MINUTES, FREE_MAX_PEOPLE, FREE_MIN_MINUTES, LATEST_AFTER_EARLIEST } from "../utils/freeSlots"
import { NOTIFICATION_KINDS } from "../utils/notificationRules"
import { PREF_MAX_CHARS, PREF_MAX_LINES } from "../utils/aiMemory"
import { DOC_LEVELS, DOC_TYPES } from "../utils/docAccess"
import { TOKEN_AREAS } from "../utils/tokenScopes"
import type { AccessibilityKey } from "../utils/accessibility"
import { ONBOARDING_TIPS, OPTIONAL_STEPS } from "../utils/onboarding"

const zUuid = z.string().uuid()

/** A UUID in lowercase, so ids compared in code match the ones the database returns */
const zUuidLower = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())

const taskStatusSchema = z.enum(["backlog", "todo", "in_progress", "done", "cancelled"])

const taskPrioritySchema = z.enum(["none", "low", "medium", "high", "urgent"])

const projectMemberRoleSchema = z.enum(["admin", "member"])

const orgMemberRoleSchema = z.enum(["admin", "member"])

export const projectKeySchema = z.string().regex(/^[A-Z][A-Z0-9]{1,4}$/)

export const projectColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/)

const symbolSchema = z.enum(SYMBOL_KEYS)

export const FOLDER_COLORS = ["sky", "pistachio", "bubblegum", "lavender", "lemon"] as const
export type FolderColor = (typeof FOLDER_COLORS)[number]
const folderColor = z.enum(FOLDER_COLORS)

const strongPassword = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .regex(/[a-z]/, "Password must include a lowercase letter")
  .regex(/[A-Z]/, "Password must include an uppercase letter")
  .regex(/[0-9]/, "Password must include a number")
  .regex(/[^a-zA-Z0-9]/, "Password must include a special character")

export const signupBodySchema = z.object({
  email: z.string().email().max(255),
  password: strongPassword,
  firstName: z.string().max(255).optional(),
  lastName: z.string().max(255).optional(),
  organizationName: z.string().min(1).max(255).trim(),
})

export const signinBodySchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(128),
})

export const setPasswordBodySchema = z.object({
  email: z.string().email().max(255),
  password: strongPassword,
  token: z.string().min(1).max(255),
})

export const forgotPasswordBodySchema = z.object({
  email: z.string().email().max(255),
})

export const resetPasswordBodySchema = z.object({
  token: z.string().min(1).max(255),
  password: strongPassword,
})

// Limits and trimming are applied after parsing, by normalizeProfile
const profileText = z.string().max(200).nullable().optional()

export const userProfilePutSchema = z
  .object({
    firstName: z.string().max(255).nullable().optional(),
    lastName: z.string().max(255).nullable().optional(),
    // The avatar URL is derived from this id, so a client can never point it at another user's upload
    avatarFileId: zUuid.nullable().optional(),
    jobTitle: profileText,
    team: profileText,
    location: profileText,
    timeZone: profileText,
    pronouns: profileText,
    phone: profileText,
    workingHours: z
      .record(z.string().max(3), z.object({ start: z.string().max(5), end: z.string().max(5) }))
      .nullable()
      .optional(),
    workBreaks: z
      .array(z.object({ start: z.string().max(5), end: z.string().max(5) }))
      .max(4)
      .nullable()
      .optional(),
    accessibility: z
      .object({
        typeShapes: z.boolean().optional(),
        reduceMotion: z.boolean().optional(),
        easierReading: z.boolean().optional(),
        largerText: z.boolean().optional(),
        moreContrast: z.boolean().optional(),
        stillZs: z.boolean().optional(),
      } satisfies Record<AccessibilityKey, z.ZodOptional<z.ZodBoolean>>)
      .strict()
      .optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: "At least one field is required",
  })

/** What the user just saw, skipped or dismissed. Nothing here can be undone, and the server stamps the times */
export const onboardingPutSchema = z
  .object({
    welcomeSeen: z.literal(true).optional(),
    checklistDismissed: z.literal(true).optional(),
    skip: z.enum(OPTIONAL_STEPS).optional(),
    tip: z.enum(ONBOARDING_TIPS).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "At least one field is required" })

export const userSearchQuerySchema = z.object({
  q: z.string().min(2).max(200),
})

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
})

export const userAvatarParamsSchema = z.object({
  fileId: zUuid,
})

export const userIdParamsSchema = z.object({
  id: zUuidLower,
})

export const presenceQueryBodySchema = z.object({
  ids: z.array(zUuidLower).max(200),
})

const STATUS_LONGEST_MS = 31 * DAY_MS

export const presenceStatusBodySchema = z.object({
  status: z.enum(["auto", ...STATUS_OVERRIDES]),
  until: z
    .string()
    .max(40)
    .refine(
      (value) => {
        const ms = parseInstant(value)
        return ms !== null && ms > Date.now() && ms <= Date.now() + STATUS_LONGEST_MS
      },
      { message: "Use a future ISO 8601 time within 31 days" },
    )
    .nullable()
    .optional(),
})

export const projectCreateBodySchema = z.object({
  name: z.string().min(1).max(255).trim(),
  key: projectKeySchema.optional(),
  description: z.string().max(10000).optional(),
  color: projectColorSchema.optional(),
  icon: symbolSchema.nullable().optional(),
  start_date: z.string().max(100).optional(),
  end_date: z.string().max(100).optional(),
})

export const projectUpdateBodySchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
  key: projectKeySchema.optional(),
  description: z.string().max(10000).optional(),
  color: projectColorSchema.optional(),
  icon: symbolSchema.nullable().optional(),
  status: z.string().max(50).optional(),
  start_date: z.string().max(100).optional(),
  end_date: z.string().max(100).optional(),
})

export const projectIdParamsSchema = z.object({
  projectId: zUuid,
})

export const projectSlugParamsSchema = z.object({
  slug: z.string().min(1).max(255),
})

export const idParamsSchema = z.object({
  id: zUuid,
})

export const projectMemberPostBodySchema = z
  .object({
    user_id: zUuid.optional(),
    userId: zUuid.optional(),
    role: projectMemberRoleSchema.optional(),
  })
  .refine((b) => !!(b.user_id || b.userId), {
    message: "user_id or userId is required",
  })

export const projectMemberRolePutBodySchema = z.object({
  role: projectMemberRoleSchema,
})

export const projectMemberParamsSchema = z.object({
  id: zUuid,
  userId: zUuid,
})

export const taskCreateBodySchema = z.object({
  title: z.string().min(1).max(255).trim(),
  description: z.string().max(100_000).optional(),
  project_id: zUuid.nullable().optional(),
  assigned_to: zUuid.nullable().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  due_date: z.string().max(100).optional(),
  position: z.number().int().min(0).max(1_000_000).optional(),
})

const optionalUuidOrEmpty = z.union([zUuid, z.literal("")])

export const taskUpdateBodySchema = z.object({
  title: z.string().min(1).max(255).trim().optional(),
  description: z.string().max(100_000).optional(),
  project_id: zUuid.nullable().optional(),
  assigned_to: optionalUuidOrEmpty.optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  due_date: z.union([z.string().max(100), z.literal("")]).optional(),
  position: z.number().int().min(0).max(1_000_000).optional(),
  completed_at: z.union([z.string().max(100), z.literal("")]).optional(),
})

export const taskCommentPostBodySchema = z.object({
  content: z.string().min(1).max(50000).trim(),
  fileIds: z.array(zUuid).max(50).optional(),
})

export const taskCommentPutBodySchema = z.object({
  content: z.string().min(1).max(50000).trim(),
  /** The comment's files after the edit. Left out, they stay as they are */
  fileIds: z.array(zUuid).max(50).optional(),
})

export const taskIdParamsSchema = z.object({
  taskId: zUuid,
})

export const commentIdParamsSchema = z.object({
  commentId: zUuid,
})

/** The sender's own id for a message, echoed back so its devices can match the live copy to what they sent */
const clientIdSchema = z.string().min(1).max(64).optional()

export const messagePostBodySchema = z.object({
  recipientId: zUuidLower,
  content: z.string().min(1).max(50000),
  fileIds: z.array(zUuid).max(50).optional(),
  replyToId: zUuid.optional(),
  clientId: clientIdSchema,
})

/** A page of history: the newest messages before a server timestamp */
const historyInstant = z
  .string()
  .max(40)
  .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?Z?$/)

/** One of `before`, `after` or `around`, a message to load the page around */
export const chatHistoryQuerySchema = z
  .object({
    before: historyInstant.optional(),
    /** The cursor message, so messages sharing its timestamp are neither skipped nor repeated */
    beforeId: zUuidLower.optional(),
    after: historyInstant.optional(),
    afterId: zUuidLower.optional(),
    around: zUuidLower.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .refine((q) => [q.before, q.after, q.around].filter(Boolean).length <= 1, { message: "Use one of before, after or around" })

export const chatParamsSchema = z.object({
  kind: z.enum(["dm", "group"]),
  id: zUuidLower,
})

export const messagePinBodySchema = z.object({
  pinned: z.boolean(),
})

export const messagePutBodySchema = z.object({
  content: z.string().min(1).max(50000),
})

export const messageIdParamsSchema = z.object({
  id: zUuid,
})

/** A file posted on a message or a task */
export const messageAttachmentParamsSchema = z.object({
  id: zUuid,
  fileId: zUuid,
})

export const contactConversationParamsSchema = z.object({
  contactId: zUuidLower,
})

export const EVENT_TYPES = ["meeting", "event", "task", "focus", "personal", "ooo"] as const
const REMINDER_MINUTES = [0, 5, 10, 30, 60, 1440] as const
export const DEFAULT_REMINDER_MINUTES = 10

const EARLIEST_EVENT = Date.UTC(1900, 0, 1)
const LATEST_EVENT = Date.UTC(3000, 0, 1)

const eventInstantSchema = z
  .string()
  .max(40)
  .refine(
    (value) => {
      const ms = parseInstant(value)
      return ms !== null && ms >= EARLIEST_EVENT && ms < LATEST_EVENT
    },
    { message: "Use an ISO 8601 time with Z or an offset" },
  )

const eventFields = {
  title: z.string().trim().min(1).max(255),
  description: z.string().max(10000).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  all_day: z.boolean().optional(),
  event_type: z.enum(EVENT_TYPES).optional(),
  video_call: z.boolean().optional(),
  everyone: z.boolean().optional(),
  recurrence_rule: z
    .string()
    .max(506)
    .transform(normalizeRecurrenceRule)
    .refine(isValidRecurrenceRule, { message: "Unsupported recurrence rule" })
    .nullable()
    .optional(),
  recurrence_tz: z.string().max(64).refine(isValidTimeZone, { message: "Unknown time zone" }).nullable().optional(),
  reminder_minutes: z.literal(REMINDER_MINUTES).nullable().optional(),
  attendee_ids: z.array(zUuid).max(200).optional(),
}

type EventTimes = {
  starts_at?: string
  ends_at?: string
  all_day?: boolean
}

function checkEventTimes(body: EventTimes, ctx: z.RefinementCtx) {
  const start = body.starts_at === undefined ? null : parseInstant(body.starts_at)
  const end = body.ends_at === undefined ? null : parseInstant(body.ends_at)
  if (start !== null && end !== null && end <= start) {
    ctx.addIssue({ code: "custom", path: ["ends_at"], message: "End must be after start" })
  }
  if (body.all_day) {
    for (const [key, ms] of [
      ["starts_at", start],
      ["ends_at", end],
    ] as const) {
      if (ms !== null && !isUtcMidnight(ms)) {
        ctx.addIssue({ code: "custom", path: [key], message: "All-day events start and end at 00:00 UTC" })
      }
    }
  }
}

export const calendarEventCreateBodySchema = z
  .strictObject({ ...eventFields, starts_at: eventInstantSchema, ends_at: eventInstantSchema })
  .superRefine((body, ctx) => {
    checkEventTimes(body, ctx)
    if (body.recurrence_rule && !body.all_day && !body.recurrence_tz) {
      ctx.addIssue({
        code: "custom",
        path: ["recurrence_tz"],
        message: "A repeating event needs the time zone it repeats in",
      })
    }
  })

/** Fields left out keep their stored value. The route checks the merged event. */
export const calendarEventUpdateBodySchema = z
  .strictObject({
    ...eventFields,
    title: eventFields.title.optional(),
    starts_at: eventInstantSchema.optional(),
    ends_at: eventInstantSchema.optional(),
  })
  .superRefine(checkEventTimes)

const MAX_RANGE_MS = 120 * DAY_MS

const rangeFields = { start: eventInstantSchema, end: eventInstantSchema }

function checkRange(query: { start: string; end: string }, ctx: z.RefinementCtx) {
  const start = parseInstant(query.start)
  const end = parseInstant(query.end)
  if (start === null || end === null) return
  const span = end - start
  if (span <= 0) ctx.addIssue({ code: "custom", path: ["end"], message: "End must be after start" })
  if (span > MAX_RANGE_MS) ctx.addIssue({ code: "custom", path: ["end"], message: "Ask for at most 120 days" })
}

export const calendarRangeQuerySchema = z.object(rangeFields).superRefine(checkRange)

const MAX_TEAM_USERS = 20

export const calendarTeamQuerySchema = z
  .object({
    ...rangeFields,
    users: z
      .string()
      .max(2000)
      .transform((value) => [
        ...new Set(
          value
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ])
      .pipe(z.array(zUuid).min(1).max(MAX_TEAM_USERS)),
  })
  .superRefine(checkRange)

export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time of day such as 09:00")

/** The window's checks against now live in `freeWindow`, and a single bound is checked against the asker's day in `freeTimes` */
export const calendarFreeQuerySchema = z
  .strictObject({
    users: z
      .string()
      .max(2000)
      .transform((value) => [
        ...new Set(
          value
            .split(",")
            .map((id) => id.trim().toLowerCase())
            .filter(Boolean),
        ),
      ])
      .pipe(z.array(zUuid).min(1, "Name at least one person").max(FREE_MAX_PEOPLE, `Find a time for at most ${FREE_MAX_PEOPLE} people`)),
    start: eventInstantSchema.optional(),
    end: eventInstantSchema.optional(),
    minutes: z.coerce
      .number()
      .int("Give the length in whole minutes")
      .min(FREE_MIN_MINUTES, `A meeting can be ${FREE_MIN_MINUTES} to ${FREE_MAX_MINUTES} minutes long`)
      .max(FREE_MAX_MINUTES, `A meeting can be ${FREE_MIN_MINUTES} to ${FREE_MAX_MINUTES} minutes long`),
    day_start: timeOfDaySchema.optional(),
    day_end: timeOfDaySchema.optional(),
    time_zone: z.string().max(64).refine(isValidTimeZone, "Use a time zone such as Europe/Stockholm").optional(),
  })
  .superRefine((query, ctx) => {
    if (query.day_start && query.day_end && query.day_end <= query.day_start) {
      ctx.addIssue({ code: "custom", path: ["day_end"], message: LATEST_AFTER_EARLIEST })
    }
  })

export const calendarScopeQuerySchema = z.object({
  scope: z.enum(["this", "following", "all"]).optional(),
  occurrence: eventInstantSchema.optional(),
})

export const calendarEventQuerySchema = z.object({
  calendar: zUuid.optional(),
})

export const calendarRespondBodySchema = z.strictObject({
  response: z.enum(["yes", "no", "maybe"]),
})

export const calendarSharingBodySchema = z.strictObject({
  default_level: z.enum(SHARE_LEVELS).optional(),
  grants: z
    .array(z.strictObject({ grantee_id: zUuid, level: z.enum(GRANT_LEVELS) }))
    .max(200)
    .optional(),
})

export const orgInviteBodySchema = z.object({
  email: z.string().email().max(255),
  firstName: z.string().max(255).optional(),
  lastName: z.string().max(255).optional(),
  role: orgMemberRoleSchema.optional(),
})

export const orgMemberIdParamsSchema = z.object({
  memberId: zUuid,
})

export const invitationUserParamsSchema = z.object({
  userId: zUuid,
})

export const orgMemberRoleBodySchema = z.object({
  role: orgMemberRoleSchema,
})

export const groupChatCreateBodySchema = z.object({
  name: z.string().min(1).max(255).trim(),
  description: z.string().max(2000).optional(),
  member_ids: z.array(zUuidLower).min(1).max(200),
  icon: symbolSchema.nullable().optional(),
  color: folderColor.nullable().optional(),
})

export const groupChatUpdateBodySchema = z
  .object({
    icon: symbolSchema.nullable().optional(),
    color: folderColor.nullable().optional(),
    /** A picture in place of the symbol, an avatar upload of the admin's own. Null takes it away */
    avatar_file_id: zUuidLower.nullable().optional(),
  })
  .refine((b) => b.icon !== undefined || b.color !== undefined || b.avatar_file_id !== undefined, { message: "Nothing to change" })
  .refine((b) => !(b.icon && b.avatar_file_id), { message: "Choose a symbol or a picture" })

export const groupChatMemberPostBodySchema = z.object({
  user_id: zUuidLower,
})

export const groupChatIdParamsSchema = z.object({
  id: zUuidLower,
})

export const groupChatAvatarParamsSchema = z.object({
  id: zUuidLower,
  fileId: zUuidLower,
})

export const groupChatMessageParamsSchema = z.object({
  id: zUuidLower,
  messageId: zUuidLower,
})

export const groupChatMemberParamsSchema = z.object({
  id: zUuidLower,
  userId: zUuidLower,
})

export const groupChatMessagePostBodySchema = z
  .object({
    content: z.string().max(50000).optional(),
    fileIds: z.array(zUuid).max(50).optional(),
    replyToId: zUuid.optional(),
    clientId: clientIdSchema,
  })
  .refine((b) => (b.content && b.content.trim().length > 0) || (b.fileIds && b.fileIds.length > 0), {
    message: "content or fileIds required",
  })

export const fileAttachBodySchema = z
  .object({
    fileId: zUuid,
    messageId: zUuid.optional(),
    taskId: zUuid.optional(),
    commentId: zUuid.optional(),
  })
  .refine((b) => [b.messageId, b.taskId, b.commentId].filter(Boolean).length === 1, {
    message: "Exactly one of messageId, taskId, or commentId is required",
  })

export const fileUploadQuerySchema = z
  .object({
    purpose: z.enum(["avatar", "draft", "file", "doc"]).optional(),
    projectId: zUuidLower.optional(),
    folderId: zUuidLower.optional(),
    /** The paper or board an image goes into, with `purpose=doc` */
    docId: zUuidLower.optional(),
    /** The call share the doc is open through, for a user who edits it in a call */
    shareId: zUuidLower.optional(),
  })
  .refine((q) => (q.purpose === "doc") === !!q.docId, { message: "docId goes with purpose=doc" })
  .refine((q) => !q.shareId || q.purpose === "doc", { message: "shareId goes with purpose=doc" })

export const fileBrowseQuerySchema = z
  .object({
    section: z.enum(["mine", "shared", "recent", "trash", "project"]),
    projectId: zUuidLower.optional(),
    folderId: zUuidLower.optional(),
    sort: z.enum(["name", "updated", "size"]).default("name"),
    dir: z.enum(["asc", "desc"]).optional(),
    cursor: z.string().max(1600).optional(),
  })
  .refine((q) => q.section !== "project" || !!q.projectId, { message: "projectId is required for a project" })

const searchDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })])

export const fileSearchQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    type: z.enum(["image", "document", "pdf", "video", "audio", "paper", "board", "other"]).optional(),
    owner: z.enum(["me", "others"]).optional(),
    after: searchDate.optional(),
    before: searchDate.optional(),
    projectId: zUuidLower.optional(),
    folderId: zUuidLower.optional(),
  })
  .refine((s) => !!s.q || !!s.type || !!s.owner || !!s.after || !!s.before, { message: "Type a name or pick a filter" })

const itemName = z.string().trim().min(1).max(255)

export const fileIdParamsSchema = z.object({ id: zUuidLower })

export const folderCreateBodySchema = z.object({
  name: itemName,
  parentId: zUuidLower.nullish(),
  projectId: zUuidLower.nullish(),
  color: folderColor.nullish(),
  icon: symbolSchema.nullish(),
})

export const folderPatchBodySchema = z
  .object({
    name: itemName.optional(),
    parentId: zUuidLower.nullable().optional(),
    color: folderColor.nullable().optional(),
    icon: symbolSchema.nullable().optional(),
  })
  .refine((b) => b.name !== undefined || b.parentId !== undefined || b.color !== undefined || b.icon !== undefined, {
    message: "Nothing to change",
  })

export const filePatchBodySchema = z
  .object({
    name: itemName.optional(),
    folderId: zUuidLower.nullable().optional(),
    altText: z.string().trim().max(500).nullable().optional(),
  })
  .refine((b) => b.name !== undefined || b.folderId !== undefined || b.altText !== undefined, {
    message: "Nothing to change",
  })

/** A storage limit in bytes, or null for no limit */
const capBytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional()

export const orgSettingsBodySchema = z
  .object({
    name: z.string().min(1).max(255).trim().optional(),
    storageCapPerPerson: capBytes,
    storageCapTotal: capBytes,
    maxFileSize: capBytes,
    timeTracking: z.boolean().optional(),
  })
  .refine((b) => Object.values(b).some((value) => value !== undefined), { message: "Nothing to change" })

/** Toggles a reaction, one of the fixed keys */
export const reactionBodySchema = z.object({
  emoji: z.enum(REACTION_KEYS),
})

export const fileGrantBodySchema = z.object({
  userIds: z.array(zUuidLower).min(1).max(50),
  level: z.enum(DOC_LEVELS).optional(),
})

export const docCreateBodySchema = z.object({
  docType: z.enum(DOC_TYPES),
  name: itemName.optional(),
  folderId: zUuidLower.nullish(),
  projectId: zUuidLower.nullish(),
})

export const docQuerySchema = z.object({ shareId: zUuidLower.optional() })

export const docVersionParamsSchema = z.object({ id: zUuidLower, versionId: zUuidLower })

const roomNameField = z.string().min(1).max(128)

/** Shows an existing doc in the call, or makes a new one for it */
export const callShareCreateBodySchema = z
  .object({
    roomName: roomNameField,
    level: z.enum(DOC_LEVELS),
    fileId: zUuidLower.optional(),
    create: z.object({ docType: z.enum(DOC_TYPES), template: z.enum(["blank", "meeting"]) }).optional(),
  })
  .refine((b) => !!b.fileId !== !!b.create, { message: "Name a doc or ask for a new one" })

export const callSharesQuerySchema = z.object({ roomName: roomNameField })

export const guestTokenBodySchema = z.object({ shareId: zUuidLower })

export const docsForEventParamsSchema = z.object({ eventId: zUuidLower })

/** The occurrence's day, or its start instant, which the server reads in the event's own zone */
export const docsForEventQuerySchema = z
  .object({ date: z.iso.date().optional(), start: z.iso.datetime({ offset: true }).optional() })
  .refine((query) => !!query.date !== !!query.start, { message: "Give either date or start" })

/**
 * A paper's image loads through the call share its doc is open in. `doc` asks for an image of that paper or board
 * only, so a board can never show a file it doesn't hold
 */
export const fileDownloadQuerySchema = z.object({ share: zUuidLower.optional(), doc: zUuidLower.optional() })

/** A Yjs relative position, encoded */
const relativePosition = z
  .string()
  .min(1)
  .max(2000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)

const commentAnchorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), from: relativePosition, to: relativePosition, quote: z.string().max(500) }),
  z.object({
    type: z.literal("board"),
    boardId: z
      .string()
      .min(1)
      .max(100)
      .nullish()
      .transform((value) => value ?? null),
    x: z.number(),
    y: z.number(),
  }),
])

const commentBody = z.string().trim().min(1).max(5000)

export const docCommentPostBodySchema = z
  .object({ body: commentBody, anchor: commentAnchorSchema.optional(), parentId: zUuidLower.optional() })
  .refine((b) => !(b.anchor && b.parentId), { message: "A reply has no anchor" })

export const docCommentPatchBodySchema = z.object({ body: commentBody })

export const docCommentParamsSchema = z.object({ commentId: zUuidLower })

/** At most 100 task ids, comma separated */
export const taskSummariesQuerySchema = z.object({
  ids: z
    .string()
    .max(4000)
    .transform((value) =>
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    )
    // A malformed id comes back hidden, so one bad task line never refuses the paper's others
    .pipe(z.array(z.string().max(100)).max(100)),
})

export const fileGrantParamsSchema = z.object({ id: zUuidLower, userId: zUuidLower })

export const fileLinkBodySchema = z.object({ expiry: z.enum(LINK_EXPIRIES).optional() }).optional()

export const fileLinkIdParamsSchema = z.object({ linkId: zUuidLower })

export const adminUsageParamsSchema = z.object({ userId: zUuidLower })

/** 32 bytes in base64url */
const linkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const publicLinkParamsSchema = z.object({ token: linkToken })

export const publicLinkQuerySchema = z.object({ folderId: zUuidLower.optional(), cursor: z.string().max(1600).optional() })

export const publicDownloadParamsSchema = z.object({ token: linkToken, fileId: zUuidLower })

export const notificationListQuerySchema = z.object({ cursor: z.string().max(200).optional() })

export const notificationReadBodySchema = z
  .object({
    ids: z.array(zUuidLower).min(1).max(100).optional(),
    taskId: zUuidLower.optional(),
    chat: z.object({ kind: z.enum(["dm", "group"]), id: zUuidLower }).optional(),
  })
  .refine((b) => !!(b.ids || b.taskId || b.chat), { message: "Say what to mark read" })

const kindPrefSchema = z.object({ bell: z.boolean().optional(), desktop: z.boolean().optional() }).strict()

export const notificationPrefsBodySchema = z.object({
  prefs: z.partialRecord(z.enum(NOTIFICATION_KINDS), kindPrefSchema),
})

const timeNote = z.string().trim().max(500)
const PLACE_NEEDED = { message: "Pick a project or a task" }

export const timeEntryCreateBodySchema = z
  .object({
    date: z.iso.date(),
    minutes: z.number().int().min(1).max(1440),
    projectId: zUuidLower.optional(),
    taskId: zUuidLower.optional(),
    note: timeNote.nullable().optional(),
    source: z.enum(["manual", "suggestion"]),
    suggestionKey: z.string().max(200).optional(),
  })
  .refine((b) => !!(b.projectId || b.taskId), PLACE_NEEDED)

export const timeEntryPatchBodySchema = z
  .object({
    date: z.iso.date().optional(),
    minutes: z.number().int().min(1).max(1440).optional(),
    note: timeNote.nullable().optional(),
    projectId: zUuidLower.optional(),
    taskId: zUuidLower.nullable().optional(),
  })
  .refine((b) => Object.values(b).some((value) => value !== undefined), { message: "Nothing to change" })

export const timeTimerBodySchema = z
  .object({
    projectId: zUuidLower.optional(),
    taskId: zUuidLower.optional(),
    note: timeNote.nullable().optional(),
  })
  .refine((b) => !!(b.projectId || b.taskId), PLACE_NEEDED)

export const timeChecksSeenBodySchema = z.object({ ids: z.array(zUuidLower).min(1).max(100) })

export const timeSettingsBodySchema = z.object({ autofillProjectId: zUuidLower.nullable() })

export const timeEntryParamsSchema = z.object({ id: zUuidLower })

export const timeTaskParamsSchema = z.object({ taskId: zUuidLower })

const isMonday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() === 1

export const timeWeekQuerySchema = z.object({ start: z.iso.date().refine(isMonday, { message: "Start the week on a Monday" }) })

export const timeDismissalBodySchema = z.object({
  key: z
    .string()
    .max(200)
    .regex(/^(meeting|task|repeat):\S+$/, { message: "Unknown suggestion" }),
})

const timeIdList = z
  .string()
  .max(20000)
  .transform((value) => [
    ...new Set(
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ])
  .pipe(z.array(zUuidLower).max(500))

const MAX_REPORT_DAYS = 366
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS

export const timeReportQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    people: timeIdList.optional(),
    projects: timeIdList.optional(),
    groupBy: z.enum(["person", "project", "task"]).default("project"),
  })
  .superRefine((query, ctx) => {
    const days = dayNumber(query.to) - dayNumber(query.from) + 1
    if (days < 1) ctx.addIssue({ code: "custom", path: ["to"], message: "End the range on or after its start" })
    else if (days > MAX_REPORT_DAYS) ctx.addIssue({ code: "custom", path: ["to"], message: "Ask for at most 366 days" })
  })

export const timeLocksBodySchema = z.object({
  projectIds: z.union([z.literal("all"), z.array(zUuidLower).min(1).max(500)]),
  until: z.iso.date().nullable(),
})

export const timeImpactQuerySchema = z
  .object({ projectId: zUuidLower.optional(), taskId: zUuidLower.optional() })
  .refine((query) => !!query.projectId !== !!query.taskId, { message: "Name a project or a task" })

const aiStrictnessSchema = z.enum(["every", "tainted", "sensitive"])
const aiBudgetSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable()
const aiAddressSchema = z
  .string()
  .trim()
  .max(2000)
  .transform((value) => value || null)
  .nullable()
const aiModelSchema = z
  .string()
  .trim()
  .max(200)
  .transform((value) => value || null)
  .nullable()
/** An empty key clears the saved one */
const aiKeySchema = z.string().trim().max(500)

export const aiSettingsBodySchema = z
  .object({
    enabled: z.boolean(),
    mcpEnabled: z.boolean(),
    baseUrl: aiAddressSchema,
    model: aiModelSchema,
    key: aiKeySchema,
    name: z.string().trim().min(1).max(60),
    avatarFileId: zUuidLower.nullable(),
    monthlyBudget: aiBudgetSchema,
    personBudget: aiBudgetSchema,
    allowPersonalKey: z.boolean(),
    allowPersonalUrl: z.boolean(),
    localNetwork: z.boolean(),
    strictness: aiStrictnessSchema,
  })
  .partial()
  .strict()

export const aiPersonalBodySchema = z
  .object({
    baseUrl: aiAddressSchema,
    model: aiModelSchema,
    key: aiKeySchema,
    strictness: aiStrictnessSchema.nullable(),
  })
  .partial()
  .strict()

export const aiAvatarParamsSchema = z.object({ fileId: zUuid })

export const aiHeldParamsSchema = z.object({ id: zUuid })

export const aiHeldBodySchema = z.object({
  decision: z.enum(["allow", "deny"]),
  chosen: z.array(zUuid).max(200).optional(),
})

export const aiThreadQuerySchema = z.object({ before: historyInstant.optional() })

export const aiThreadPostBodySchema = z.object({ content: z.string().trim().min(1).max(20000), clientId: clientIdSchema })

export const aiRequestParamsSchema = z.object({ id: zUuid })

export const aiPreferencesBodySchema = z.strictObject({
  use: z.boolean(),
  lines: z.array(z.string().trim().min(1).max(PREF_MAX_CHARS)).max(PREF_MAX_LINES),
  /** When the list the page edited was saved, null when it had never been */
  basedOn: z.string().max(64).nullable(),
})

export const aiActivityQuerySchema = z.object({ scope: z.enum(["mine", "workspace"]).default("mine") })

export const aiTokenBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365), z.null()]).default(30),
    scopes: z
      .partialRecord(z.enum(TOKEN_AREAS), z.enum(["read", "write"]))
      .refine((scopes) => Object.keys(scopes).length > 0, { message: "Pick at least one area" }),
    readOnly: z.boolean().default(false),
  })
  .strict()

export const aiTokenParamsSchema = z.object({ id: zUuid })

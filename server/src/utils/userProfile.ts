import { WEEKDAYS, type Availability, type DayHours, type Weekday, type WorkingHours } from "./availability"
import { accessibilityOf } from "./accessibility"
import { isValidTimeZone } from "./eventTime"

type ProfileFields = {
  job_title: string | null
  team: string | null
  location: string | null
  time_zone: string | null
  pronouns: string | null
  phone: string | null
}

type ProfileDto = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  avatar_url: string | null
  role: "admin" | "member"
} & ProfileFields & { availability: Availability }

type UserRow = {
  id: string
  firstName: string | null
  lastName: string | null
  email: string
  avatarUrl: string | null
  jobTitle: string | null
  team: string | null
  location: string | null
  timeZone: string | null
  pronouns: string | null
  phone: string | null
}

type Member = { organizationId: string; role: string; user: UserRow }

function profileFieldsOf(user: Omit<UserRow, "id" | "firstName" | "lastName" | "email" | "avatarUrl">): ProfileFields {
  return {
    job_title: user.jobTitle,
    team: user.team,
    location: user.location,
    time_zone: user.timeZone,
    pronouns: user.pronouns,
    phone: user.phone,
  }
}

/** A user's card, only for a member of the viewer's own organization. Any other user is not found. */
export function profileFor(
  viewerOrgId: string | null,
  member: Member | null | undefined,
  availability: Availability = { kind: null },
): ProfileDto | null {
  if (!viewerOrgId || !member || member.organizationId !== viewerOrgId) return null
  const { user } = member
  return {
    id: user.id,
    first_name: user.firstName,
    last_name: user.lastName,
    email: user.email,
    avatar_url: user.avatarUrl,
    role: member.role === "admin" ? "admin" : "member",
    ...profileFieldsOf(user),
    availability,
  }
}

const PROFILE_LIMITS = { jobTitle: 100, team: 100, location: 100, pronouns: 40, phone: 40 } as const
const LABELS = { jobTitle: "Job title", team: "Team", location: "Location", pronouns: "Pronouns", phone: "Phone" } as const
type TextField = keyof typeof PROFILE_LIMITS
/** The editable profile fields, as sent and as stored */
type ProfileValues = Partial<Record<TextField | "timeZone", string | null>> & {
  workingHours?: WorkingHours | null
  workBreaks?: DayHours[] | null
}

const MAX_WORK_BREAKS = 4

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Trims every text field and stores an empty one as null. Refuses a value over its limit, an unknown
 * time zone, and working hours or breaks that are not HH:MM ranges ending after they start. Omitted fields stay omitted.
 */
export function normalizeProfile(input: ProfileValues): { ok: true; values: ProfileValues } | { ok: false; error: string } {
  const values: ProfileValues = {}
  for (const key of Object.keys(PROFILE_LIMITS) as TextField[]) {
    if (input[key] === undefined) continue
    const value = input[key]?.trim() ?? ""
    if (value.length > PROFILE_LIMITS[key]) return { ok: false, error: `${LABELS[key]} can be up to ${PROFILE_LIMITS[key]} characters` }
    values[key] = value || null
  }
  if (input.timeZone !== undefined) {
    const zone = input.timeZone?.trim() ?? ""
    if (zone && !isValidTimeZone(zone)) return { ok: false, error: "Unknown time zone" }
    values.timeZone = zone || null
  }
  if (input.workingHours !== undefined) {
    const hours: WorkingHours = {}
    for (const [day, range] of Object.entries(input.workingHours ?? {})) {
      if (!WEEKDAYS.includes(day as Weekday) || !range) return { ok: false, error: "Unknown working day" }
      if (!TIME.test(range.start) || !TIME.test(range.end) || range.end <= range.start) {
        return { ok: false, error: "Working hours must end after they start" }
      }
      hours[day as Weekday] = { start: range.start, end: range.end }
    }
    values.workingHours = Object.keys(hours).length ? hours : null
  }
  if (input.workBreaks !== undefined) {
    const breaks = input.workBreaks ?? []
    if (breaks.length > MAX_WORK_BREAKS) return { ok: false, error: `Add up to ${MAX_WORK_BREAKS} breaks` }
    if (breaks.some((range) => !TIME.test(range.start) || !TIME.test(range.end) || range.end <= range.start)) {
      return { ok: false, error: "Breaks must end after they start" }
    }
    values.workBreaks = breaks.length ? breaks.map((range) => ({ start: range.start, end: range.end })) : null
  }
  return { ok: true, values }
}

/** The profile fields as the user reads their own, in the camelCase of /auth/me */
export function ownProfile(
  user: Omit<UserRow, "id" | "firstName" | "lastName" | "email" | "avatarUrl"> & {
    workingHours: WorkingHours | null
    workBreaks: DayHours[] | null
    accessibility: unknown
  },
) {
  return {
    jobTitle: user.jobTitle,
    team: user.team,
    location: user.location,
    timeZone: user.timeZone,
    pronouns: user.pronouns,
    phone: user.phone,
    workingHours: user.workingHours,
    workBreaks: user.workBreaks,
    accessibility: accessibilityOf(user.accessibility),
  }
}

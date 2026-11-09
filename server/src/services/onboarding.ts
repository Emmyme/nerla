import { eq, sql } from "drizzle-orm"
import { db, users } from "../db"
import { checklistSteps, onboardingOf, type Onboarding, type Step, type TipId } from "../utils/onboarding"
import type { OrgContext } from "../utils/tenancy"
import { teammateFor } from "./aiTeammate"

type OnboardingView = { welcomeSeen: boolean; checklistDismissed: boolean; tips: TipId[]; steps: Step[] }

type Found = Record<"profile" | "task" | "event" | "message" | "doc" | "ai" | "invite" | "aiOn", boolean>

/** One query for every step the database can tell, each limited to the user's own rows in the workspace */
async function foundIn(userId: string, organizationId: string): Promise<Found> {
  const me = sql`${userId}::uuid`
  const org = sql`${organizationId}::uuid`
  // trash: a task or event made and then moved to the trash still counts as made
  const [row] = await db.execute<Found>(sql`
    select
      exists(select 1 from users where id = ${me} and avatar_url is not null) as profile,
      exists(select 1 from tasks where created_by = ${me} and organization_id = ${org}) as task,
      exists(select 1 from calendar_events where created_by = ${me} and organization_id = ${org}) as event,
      exists(select 1 from messages where sender_id = ${me} and organization_id = ${org} and kind = 'text') as message,
      exists(select 1 from file_attachments where uploaded_by = ${me} and organization_id = ${org} and doc_type is not null) as doc,
      exists(select 1 from ai_requests where user_id = ${me} and organization_id = ${org} and source = 'ai') as ai,
      exists(select 1 from users where organization_id = ${org} and id <> ${me}) as invite,
      exists(
        select 1 from ai_settings
        where organization_id = ${org} and enabled and base_url is not null and model is not null
      ) as "aiOn"`)
  return row
}

/** The user's welcome, checklist and tips state, with each step ticked from what the server finds */
export async function onboardingFor(userId: string, org: OrgContext): Promise<OnboardingView> {
  const admin = org.role === "admin"
  const [user, found, teammate] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId), columns: { onboarding: true } }),
    foundIn(userId, org.organizationId),
    teammateFor({ userId, organizationId: org.organizationId, isAdmin: admin }),
  ])
  const stored = onboardingOf(user?.onboarding)
  const facts = { ...found, desktop: !!stored.desktopDone, setup: !!stored.setupClearAt }
  return {
    welcomeSeen: !!stored.welcomeSeenAt,
    checklistDismissed: !!stored.checklistDismissedAt,
    tips: stored.tips ?? [],
    steps: checklistSteps(facts, stored.skipped ?? [], { admin, ai: teammate.available }),
  }
}

/**
 * Merges a change into the stored state in the database, so two devices changing different parts keep both. Lists
 * are appended to, and `onboardingOf` drops the repeats on read
 */
export async function saveOnboarding(
  userId: string,
  change: Omit<Onboarding, "skipped" | "tips">,
  add: Pick<Onboarding, "skipped" | "tips"> = {},
) {
  let next = sql`coalesce(${users.onboarding}, '{}'::jsonb) || ${JSON.stringify(change)}::jsonb`
  for (const key of ["skipped", "tips"] as const) {
    const items = add[key]
    if (items?.length) {
      next = sql`jsonb_set(${next}, ${`{${key}}`}::text[], coalesce(${users.onboarding} -> ${key}, '[]'::jsonb) || ${JSON.stringify(items)}::jsonb)`
    }
  }
  await db.update(users).set({ onboarding: next }).where(eq(users.id, userId))
}

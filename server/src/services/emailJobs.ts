import { and, eq, sql } from "drizzle-orm"
import { db, jobs, users, type Executor } from "../db"
import { addJob, cancelJobs, defineJob, FinalError } from "../jobs/queue"
import { open, seal } from "../jobs/sealed"
import { logger } from "../utils/logger"
import { resetTokenMatches } from "../utils/resetTokens"
import { buildInviteUrl, isEmailConfigured, resetLink, sendInviteEmail, sendPasswordResetEmail, sendRejoinEmail, signInLink } from "./email"

type EmailState = "sending" | "not-set-up"
type Invite = { userId: string; to: string; token: string; inviterName: string; orgName: string }
type Rejoin = Omit<Invite, "token">
type Reset = { userId: string; to: string; token: string }

// The job goes in the caller's transaction, so it exists only if the token it carries was saved
async function queue<P extends { userId: string }>(tx: Executor, kind: string, payload: P, logLine: string): Promise<EmailState> {
  if (!isEmailConfigured()) {
    logger.warn(`[email] Not configured - ${logLine}`)
    return "not-set-up"
  }
  const uniqueKey = `${kind.replace(".", ":")}:${payload.userId}`
  await cancelJobs(tx, uniqueKey)
  // A running job still holds the key, and this newer link has to go out too
  if (!(await addJob(tx, kind, payload, { uniqueKey }))) await addJob(tx, kind, payload)
  return "sending"
}

/** Emails the invite link. With no mail server set up it writes the link to the log instead */
export const emailInvite = (tx: Executor, invite: Invite) =>
  queue(
    tx,
    "email.invite",
    { ...invite, token: seal(invite.token) },
    `invite link for ${invite.to}: ${buildInviteUrl(invite.to, invite.token)}`,
  )

export const emailRejoin = (tx: Executor, rejoin: Rejoin) =>
  queue(tx, "email.rejoin", rejoin, `${rejoin.to} was invited back to ${rejoin.orgName} and rejoins by signing in at ${signInLink()}`)

export const emailReset = (tx: Executor, reset: Reset) =>
  queue(tx, "email.reset", { ...reset, token: seal(reset.token) }, `reset link for ${reset.to}: ${resetLink(reset.token)}`)

function unseal(token: string): string {
  try {
    return open(token)
  } catch {
    throw new FinalError("This email's link can't be read any more. Make a new link.")
  }
}

function ready() {
  if (!isEmailConfigured()) {
    throw new FinalError(
      "Email isn't set up on this server any more, so this email wasn't sent. Make a new link, or ask for a new reset link.",
    )
  }
}

// False when the link was revoked, replaced or used while the job waited
async function linkLive(userId: string, token: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { passwordResetToken: true } })
  return resetTokenMatches(token, user?.passwordResetToken ?? null)
}

// The link is no use once sent. Matched to the attempt like the queue's own writes. Failing here leaves it until the job is pruned
async function forgetLink(job: { id: string; attempt: number }) {
  await db
    .update(jobs)
    .set({ payload: sql`${jobs.payload} - 'token'` })
    .where(and(eq(jobs.id, job.id), eq(jobs.attempts, job.attempt), eq(jobs.status, "running")))
    .catch((error) => logger.warn("A sent email's link stays in its job until the job is pruned", { jobId: job.id, error: String(error) }))
}

defineJob<Invite>("email.invite", { maxAttempts: 6 }, async (invite, job) => {
  ready()
  // An earlier attempt sent it and dropped the link, but its finish was lost
  if (!invite.token) return
  const token = unseal(invite.token)
  if (!(await linkLive(invite.userId, token))) return
  await sendInviteEmail(invite.to, token, invite.inviterName, invite.orgName)
  await forgetLink(job)
})

defineJob<Rejoin>("email.rejoin", { maxAttempts: 6 }, async (rejoin) => {
  ready()
  const user = await db.query.users.findFirst({ where: eq(users.id, rejoin.userId), columns: { rejoinInvitedUntil: true } })
  if (!user?.rejoinInvitedUntil) return
  await sendRejoinEmail(rejoin.to, rejoin.inviterName, rejoin.orgName)
})

defineJob<Reset>("email.reset", { maxAttempts: 6 }, async (reset, job) => {
  ready()
  // An earlier attempt sent it and dropped the link, but its finish was lost
  if (!reset.token) return
  const token = unseal(reset.token)
  if (!(await linkLive(reset.userId, token))) return
  await sendPasswordResetEmail(reset.to, token)
  await forgetLink(job)
})

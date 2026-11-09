import { isResetTokenExpired } from "./resetTokens"

/** An account as invites see it. `member` means a membership in any workspace. */
type InviteAccount = {
  organizationId: string | null
  member: boolean
  passwordSet: boolean
  rejoinUntil: string | null
}

type TokenKind = "invite" | "reset"

/** An invite token only ever sets a first password and a reset token only ever replaces one */
export function tokenUsableFor(purpose: TokenKind, account: { kind: string | null; passwordSet: boolean }): boolean {
  if (account.kind !== purpose) return false
  return purpose === "invite" ? !account.passwordSet : account.passwordSet
}

/** A pending invite is an account with no password that holds this workspace's invite token */
export function inviteBelongsTo(
  invitee: Pick<InviteAccount, "organizationId" | "member" | "passwordSet"> & { kind: string | null },
  org: string,
): boolean {
  return !invitee.member && invitee.organizationId === org && tokenUsableFor("invite", invitee)
}

function rejoinOpen(until: string | null): boolean {
  return !isResetTokenExpired(until)
}

/**
 * What inviting an email into `org` does. A new email gets an account and a link. A removed account, which keeps its
 * password, is invited back without any token and rejoins by signing in. A member of any workspace, another workspace's
 * pending invite and another workspace's open invite back are refused.
 */
export function inviteDecision(account: InviteAccount | null, org: string): "new" | "pending" | "rejoin" | "refuse" {
  if (!account) return "new"
  if (account.member) return "refuse"
  if (!account.passwordSet) return account.organizationId === org ? "pending" : "refuse"
  if (account.organizationId && account.organizationId !== org && rejoinOpen(account.rejoinUntil)) return "refuse"
  return "rejoin"
}

/** What an account is in this workspace's pending list: an invite link, an open invite back, or nothing */
export function pendingKind(account: InviteAccount & { kind: string | null }, org: string): "invite" | "rejoin" | null {
  if (inviteBelongsTo(account, org)) return "invite"
  const invitedBack = account.passwordSet && account.organizationId === org && rejoinsOnSignIn(account)
  return invitedBack ? "rejoin" : null
}

/** Only an open invite back rejoins on sign-in, never a workspace id left on the account */
export function rejoinsOnSignIn(account: Pick<InviteAccount, "organizationId" | "member" | "rejoinUntil">): boolean {
  return !account.member && !!account.organizationId && rejoinOpen(account.rejoinUntil)
}

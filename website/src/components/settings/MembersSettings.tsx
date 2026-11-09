import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Check, Mail, Trash, UserPlus, Warning } from "@/components/icons"
import BaseModal from "@/components/ui/BaseModal"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { UserAvatar } from "@/components/ui/user-avatar"
import { organizationsAPI, type OrganizationMember, type PendingInvitation } from "@/lib/api/organizations"
import { formatLongDate, parseServerDate } from "@/lib/dates"
import { messageOf } from "@/lib/taskStore"
import { useAvatarSrc } from "@/lib/useAvatarSrc"
import { useBusyRetry } from "@/lib/useBusyRetry"
import { useAuth } from "@/providers/AuthProvider"
import { ConfirmDialog } from "./ConfirmDialog"
import { copyToClipboard, InviteDialog, InviteLink, ROLES, type Role } from "./InviteDialog"
import { inviteOutcome, type InviteOutcome } from "./inviteOutcome"
import { LoadError, LoadingRows } from "./LoadState"
import { SettingsSection } from "./SettingsSection"

type IssuedLink = Extract<InviteOutcome, { kind: "link" }>

const LOAD_FAILED = "Couldn't load the members. Check your connection and try again."
const ROLE_FAILED = "Couldn't change the role. Try again."
const REMOVE_FAILED = "Couldn't remove them. Try again."
const LINK_FAILED = "Couldn't create a new link. Try again."
const REVOKE_FAILED = "Couldn't revoke the invitation. Try again."

const EMAIL_BADGES = {
  sending: { tone: "sky", Icon: Mail, label: "Sending" },
  sent: { tone: "pistachio", Icon: Check, label: "Email sent" },
  failed: { tone: "lemon", Icon: Warning, label: "Email failed" },
} as const

const fullName = (first: string | null | undefined, last: string | null | undefined) => [first, last].filter(Boolean).join(" ").trim()
const memberName = (member: OrganizationMember) => fullName(member.user.firstName, member.user.lastName) || member.user.email
const roleLabel = (role: string) => ROLES.find((option) => option.value === role)?.label ?? "Member"

export default function MembersSettings() {
  const myId = useAuth().user?.id
  const [members, setMembers] = useState<OrganizationMember[] | null>(null)
  const [invitations, setInvitations] = useState<PendingInvitation[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [inviting, setInviting] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<OrganizationMember | null>(null)
  const [revoking, setRevoking] = useState<PendingInvitation | null>(null)
  const [issued, setIssued] = useState<IssuedLink | null>(null)
  const live = useRef(true)
  const root = useRef<HTMLDivElement>(null)
  const inviteButton = useRef<HTMLButtonElement>(null)
  // Where focus goes once a confirm closes and the button that opened it has gone with its row
  const nextFocus = useRef<string | null>(null)
  const focusAfter = () => (nextFocus.current && root.current?.querySelector<HTMLElement>(nextFocus.current)) || inviteButton.current

  const load = useCallback(async () => {
    const [nextMembers, nextInvitations] = await Promise.all([organizationsAPI.getOrganizationMembers(), organizationsAPI.getInvitations()])
    if (!live.current) return
    setMembers(nextMembers)
    setInvitations(nextInvitations)
    setLoadError(null)
  }, [])

  const { busy: serverBusy, waitIfBusy, done } = useBusyRetry()

  useEffect(() => {
    live.current = true
    load()
      .then(done)
      .catch((err) => {
        if (!live.current || waitIfBusy(err, () => setAttempt((count) => count + 1))) return
        done()
        setLoadError(messageOf(err, LOAD_FAILED))
      })
    return () => {
      live.current = false
    }
  }, [load, attempt, waitIfBusy, done])

  const reload = () => void load().catch((err) => live.current && toast.error(messageOf(err, LOAD_FAILED)))

  const changeRole = async (member: OrganizationMember, role: Role) => {
    if (role === member.role || busy) return
    setBusy(member.id)
    try {
      await organizationsAPI.updateMemberRole(member.id, role)
      setMembers((current) => current && current.map((m) => (m.id === member.id ? { ...m, role } : m)))
      toast.success(`${memberName(member)} is now ${role === "admin" ? "an admin" : "a member"}`)
    } catch (err) {
      toast.error(messageOf(err, ROLE_FAILED))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (member: OrganizationMember) => {
    await organizationsAPI.removeMember(member.id)
    setMembers((current) => current && current.filter((m) => m.id !== member.id))
    toast.success(`${memberName(member)} was removed from the workspace`)
  }

  const newLink = async (invitation: PendingInvitation) => {
    if (busy) return
    setBusy(invitation.id)
    try {
      const outcome = inviteOutcome(await organizationsAPI.createInviteLink(invitation.id), invitation.email)
      if (outcome.kind !== "link") return void toast.error(LINK_FAILED)
      const emailStatus = outcome.emailing ? "sending" : "not-set-up"
      setInvitations((current) =>
        current.map((i) => (i.id === invitation.id ? { ...i, expired: false, expiresAt: outcome.expiresAt, emailStatus } : i)),
      )
      const emailing = outcome.emailing ? " We're emailing it to them too." : ""
      if (await copyToClipboard(outcome.url))
        toast.success(`New link for ${invitation.email} copied.${emailing} The old link no longer works.`)
      else setIssued(outcome)
    } catch (err) {
      toast.error(messageOf(err, LINK_FAILED))
    } finally {
      setBusy(null)
    }
  }

  const revoke = async (invitation: PendingInvitation) => {
    await organizationsAPI.revokeInvitation(invitation.id)
    setInvitations((current) => current.filter((i) => i.id !== invitation.id))
    toast.success(`Invitation for ${invitation.email} revoked`)
  }

  const sorted =
    members &&
    [...members].sort((a, b) => Number(b.userId === myId) - Number(a.userId === myId) || memberName(a).localeCompare(memberName(b)))

  const askRemove = (member: OrganizationMember) => {
    const others = (sorted ?? []).filter((m) => m.userId !== myId)
    const next = others[others.findIndex((m) => m.id === member.id) + 1]
    nextFocus.current = next ? `[data-remove="${next.id}"]` : null
    setRemoving(member)
  }

  const askRevoke = (invitation: PendingInvitation) => {
    const next = invitations[invitations.findIndex((i) => i.id === invitation.id) + 1]
    nextFocus.current = next ? `[data-revoke="${next.id}"]` : null
    setRevoking(invitation)
  }

  return (
    <div ref={root} className="flex flex-col">
      <SettingsSection
        title="Members"
        meta={
          members && (
            <>
              <span className="max-lg:hidden">{members.length}</span>
              <span className="lg:hidden">{members.length === 1 ? "1 member" : `${members.length} members`}</span>
            </>
          )
        }
        action={
          <Button ref={inviteButton} type="button" onClick={() => setInviting(true)}>
            <UserPlus aria-hidden="true" className="size-[1rem]" />
            Invite
          </Button>
        }
      >
        {loadError ? (
          <LoadError
            message={loadError}
            onRetry={() => {
              setLoadError(null)
              setAttempt((count) => count + 1)
            }}
          />
        ) : !sorted ? (
          <LoadingRows label="Loading members" busy={serverBusy}>
            <Skeleton className="h-[3rem] rounded-lg" />
            <Skeleton className="h-[3rem] rounded-lg" />
            <Skeleton className="h-[3rem] rounded-lg" />
          </LoadingRows>
        ) : (
          <ul aria-label="Members" className="flex flex-col divide-y divide-border">
            {sorted.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                self={member.userId === myId}
                busy={busy === member.id}
                onRole={(role) => void changeRole(member, role)}
                onRemove={() => askRemove(member)}
              />
            ))}
          </ul>
        )}
      </SettingsSection>

      {!loadError && invitations.length > 0 && (
        <SettingsSection title="Pending invitations" meta={invitations.length}>
          <ul aria-label="Pending invitations" className="flex flex-col divide-y divide-border">
            {invitations.map((invitation) => {
              const name = fullName(invitation.firstName, invitation.lastName)
              const emailBadge =
                invitation.emailStatus && invitation.emailStatus !== "not-set-up" ? EMAIL_BADGES[invitation.emailStatus] : null
              return (
                <li key={invitation.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-medium text-foreground">{name || invitation.email}</p>
                    {name && <p className="truncate text-ui text-muted-foreground">{invitation.email}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {invitation.kind === "rejoin" ? (
                      <Badge tone="neutral">Can rejoin by signing in until {formatLongDate(parseServerDate(invitation.expiresAt))}</Badge>
                    ) : (
                      <Badge tone={invitation.expired ? "berry" : "neutral"}>{invitation.expired ? "Expired" : "Awaiting sign-up"}</Badge>
                    )}
                    {emailBadge && (
                      <Badge tone={emailBadge.tone} className="gap-1">
                        <emailBadge.Icon aria-hidden="true" className="size-[0.875rem]" />
                        {invitation.kind === "rejoin" && invitation.emailStatus === "failed"
                          ? "Email failed, let them know yourself"
                          : emailBadge.label}
                      </Badge>
                    )}
                    <div className="flex items-center gap-2">
                      {invitation.kind !== "rejoin" && (
                        <Button
                          type="button"
                          variant="outline"
                          aria-busy={busy === invitation.id || undefined}
                          onClick={() => void newLink(invitation)}
                        >
                          {busy === invitation.id ? "Creating" : "New link"}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        data-revoke={invitation.id}
                        aria-disabled={busy === invitation.id || undefined}
                        className="aria-disabled:cursor-progress"
                        onClick={() => busy !== invitation.id && askRevoke(invitation)}
                      >
                        Revoke
                      </Button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </SettingsSection>
      )}

      <InviteDialog
        open={inviting}
        onClose={() => setInviting(false)}
        onInvited={reload}
        pendingEmails={invitations.filter((i) => i.kind !== "rejoin").map((i) => i.email)}
        memberEmails={(members ?? []).map((m) => m.user.email)}
      />

      <ConfirmDialog
        open={!!removing}
        title="Remove member"
        confirmLabel="Remove"
        busyLabel="Removing"
        failed={REMOVE_FAILED}
        onConfirm={() => (removing ? remove(removing) : Promise.resolve())}
        onClose={() => setRemoving(null)}
        fallbackFocus={focusAfter}
      >
        Remove <span className="font-semibold text-foreground">{removing && memberName(removing)}</span> from the workspace? They lose
        access to its projects, chats and calendar.
      </ConfirmDialog>

      <ConfirmDialog
        open={!!revoking}
        title="Revoke invitation"
        confirmLabel="Revoke"
        busyLabel="Revoking"
        failed={REVOKE_FAILED}
        onConfirm={() => (revoking ? revoke(revoking) : Promise.resolve())}
        onClose={() => setRevoking(null)}
        fallbackFocus={focusAfter}
      >
        {revoking?.kind === "rejoin" ? (
          <>
            <span className="font-semibold text-foreground">{revoking.email}</span> can no longer rejoin by signing in.
          </>
        ) : (
          <>
            The invite link for <span className="font-semibold text-foreground">{revoking?.email}</span> stops working.
          </>
        )}
      </ConfirmDialog>

      <BaseModal isOpen={!!issued} onClose={() => setIssued(null)} title="New invite link" maxWidth="md">
        {issued && (
          <div className="flex flex-col gap-4 p-6">
            <p className="text-body leading-[1.5] text-muted-foreground">
              The link couldn't be copied automatically. Copy it here and send it to{" "}
              <span className="font-medium text-foreground">{issued.email}</span>.
            </p>
            <InviteLink outcome={issued} />
            <div className="flex justify-end">
              <Button type="button" onClick={() => setIssued(null)}>
                Done
              </Button>
            </div>
          </div>
        )}
      </BaseModal>
    </div>
  )
}

function MemberRow({
  member,
  self,
  busy,
  onRole,
  onRemove,
}: {
  member: OrganizationMember
  self: boolean
  busy: boolean
  onRole: (role: Role) => void
  onRemove: () => void
}) {
  const name = memberName(member)
  const src = useAvatarSrc(member.user.avatarUrl)
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <UserAvatar
          user={{ id: member.user.id, first_name: member.user.firstName, last_name: member.user.lastName }}
          src={src}
          size="md"
          presence
        />
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-foreground">{name}</p>
          <p className="truncate text-ui text-muted-foreground">{member.user.email}</p>
        </div>
      </div>
      {self ? (
        <span className="shrink-0 text-ui text-muted-foreground max-sm:pl-11">{roleLabel(member.role)} (you)</span>
      ) : (
        <div className="flex shrink-0 items-center gap-2 max-sm:pl-11">
          <Select value={member.role} onValueChange={(role) => onRole(role as Role)}>
            <SelectTrigger aria-label={`Role for ${name}`} aria-busy={busy || undefined} className="w-[7.5rem] px-2.5 max-sm:flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((option) => (
                <SelectItem key={option.value} value={option.value} className="text-ui">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            aria-label={`Remove ${name}`}
            aria-disabled={busy || undefined}
            data-remove={member.id}
            onClick={() => !busy && onRemove()}
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none aria-disabled:cursor-progress aria-disabled:opacity-50 max-lg:size-11"
          >
            <Trash aria-hidden="true" className="size-[1rem]" />
          </button>
        </div>
      )}
    </li>
  )
}

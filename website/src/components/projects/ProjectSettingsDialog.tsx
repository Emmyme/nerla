import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react"
import { useNavigate } from "react-router"
import * as SelectPrimitive from "@radix-ui/react-select"
import { ChevronDown, LogOut, Trash, X } from "@/components/icons"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Select, SelectContent, SelectItem } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { UserAvatar } from "@/components/ui/user-avatar"
import { ApiError } from "@/lib/api/request"
import { projectsAPI, type Project, type ProjectMember, type ProjectRole } from "@/lib/api/projects"
import type { TrashRef } from "@/lib/api/trash"
import { nearestSwatch } from "@/lib/projectColors"
import { messageOf, notifyTasksChanged } from "@/lib/taskStore"
import { movedToTrash } from "@/lib/trashToast"
import { dropProject, notifyProjectsChanged, returnProject } from "@/lib/useProjects"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"
import { PeopleSearch, personName, type PersonResult } from "./PeopleSearch"
import { IdentityTile } from "@/components/ui/identity-tile"
import { symbolFor, type SymbolKey } from "@/components/ui/symbols"
import { ColorField, DescriptionField, KeyField, NameField, SymbolField } from "./ProjectFields"
import { KEY_TAKEN, projectKeyError } from "./projectKey"
import { SWATCH_NAMES } from "./SwatchPicker"
import { useTimeImpactText } from "@/components/time/timeImpact"

const SAVE_FAILED = "Couldn't save the project. Check your connection and try again."
const MEMBERS_FAILED = "Couldn't load members."
const MEMBER_FAILED = "Couldn't update members. Check your connection and try again."
const DELETE_FAILED = "Couldn't delete the project. Check your connection and try again."
const LEAVE_FAILED = "Couldn't leave the project. Check your connection and try again."

const STATUSES = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
]

const ROLE_LABEL: Record<ProjectRole, string> = { admin: "Admin", member: "Member" }

const SECTION_HEADING = "text-body font-semibold tracking-normal text-foreground"

type Access = "loading" | "edit" | "view" | "unknown"

const ACCESS_NOTE: Partial<Record<Access, string>> = {
  view: "Only project admins can change these settings.",
  unknown: "These settings stay locked until your access is checked. Load the members again below.",
}

type ProjectSettingsDialogProps = {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: (project: Project) => void
  onDeleted: () => void
  fallbackFocus?: () => HTMLElement | null | undefined
}

export function ProjectSettingsDialog({ project, open, onOpenChange, onChanged, onDeleted, fallbackFocus }: ProjectSettingsDialogProps) {
  return (
    <BaseModal isOpen={open} onClose={() => onOpenChange(false)} title="Project settings" maxWidth="xl" fallbackFocus={fallbackFocus}>
      <SettingsBody key={project.id} project={project} onChanged={onChanged} onDeleted={onDeleted} onClose={() => onOpenChange(false)} />
    </BaseModal>
  )
}

function SettingsBody({
  project,
  onChanged,
  onDeleted,
  onClose,
}: {
  project: Project
  onChanged: (project: Project) => void
  onDeleted: () => void
  onClose: () => void
}) {
  const { user } = useAuth()
  const me = user?.id ?? null
  const [saved, setSaved] = useState(project)
  const [members, setMembers] = useState<ProjectMember[] | null>(null)
  const [membersError, setMembersError] = useState<string | null>(null)

  const loadMembers = useCallback(() => {
    setMembersError(null)
    projectsAPI
      .getProjectMembers(project.id)
      .then(setMembers)
      .catch((err: unknown) => setMembersError(messageOf(err, MEMBERS_FAILED)))
  }, [project.id])

  useEffect(() => {
    loadMembers()
  }, [loadMembers])

  const myRole = members?.find((member) => member.user_id === me)?.role
  const isAdmin = myRole === "admin"
  const access: Access = isAdmin ? "edit" : members !== null ? "view" : membersError ? "unknown" : "loading"

  const latest = useRef(saved)
  latest.current = saved

  const publish = (next: Project) => {
    latest.current = next
    setSaved(next)
    notifyProjectsChanged()
    onChanged(next)
  }

  const membersChanged = (next: ProjectMember[]) => {
    setMembers(next)
    publish({
      ...latest.current,
      members: next.flatMap((member) =>
        member.user
          ? [
              {
                id: member.user.id,
                first_name: member.user.first_name,
                last_name: member.user.last_name,
                avatar_url: member.user.avatar_url,
              },
            ]
          : [],
      ),
    })
  }

  return (
    <div className="flex flex-col">
      <DetailsSection project={saved} access={access} onSaved={publish} />
      <MembersSection
        project={saved}
        me={me}
        members={members}
        error={membersError}
        canManage={isAdmin}
        onRetry={loadMembers}
        onChange={membersChanged}
      />
      {members && myRole && <LeaveSection project={saved} members={members} me={me} onClose={onClose} />}
      {isAdmin && <DangerSection project={saved} onDeleted={onDeleted} onClose={onClose} />}
    </div>
  )
}

function DetailsSection({ project, access, onSaved }: { project: Project; access: Access; onSaved: (project: Project) => void }) {
  const [name, setName] = useState(project.name)
  const [key, setKey] = useState(project.key ?? "")
  const [color, setColor] = useState(project.color)
  const [symbol, setSymbol] = useState<SymbolKey | null>(symbolFor(project.icon)?.key ?? null)
  const [description, setDescription] = useState(project.description ?? "")
  const [status, setStatus] = useState(project.status)
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const keyRef = useRef<HTMLInputElement>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)
  const focusAfterSave = useRef<HTMLElement | null>(null)
  const ids = useId()

  const locked = access !== "edit" || saving

  useEffect(() => {
    const target = focusAfterSave.current
    if (saving || !target) return
    focusAfterSave.current = null
    const next = target.isConnected && !target.matches(":disabled") ? target : statusRef.current
    next?.focus()
  }, [saving])

  const patch = {
    ...(name.trim() !== project.name && { name: name.trim() }),
    ...(key !== (project.key ?? "") && { key }),
    ...(color !== project.color && color !== null && { color }),
    ...(symbol !== (symbolFor(project.icon)?.key ?? null) && { icon: symbol }),
    ...(description.trim() !== (project.description ?? "") && { description: description.trim() }),
    ...(status !== project.status && { status }),
  }
  const dirty = Object.keys(patch).length > 0

  const edited = () => {
    if (savedNote) setSavedNote(false)
    if (error) setError(null)
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (locked || !dirty) return
    if (!name.trim()) {
      setNameError("Give the project a name")
      nameRef.current?.focus()
      return
    }
    const keyProblem = key === "" && project.key ? "Give the project a key" : projectKeyError(key)
    if (keyProblem) {
      setKeyError(keyProblem)
      keyRef.current?.focus()
      return
    }

    const active = document.activeElement
    focusAfterSave.current = active instanceof HTMLElement && active !== document.body ? active : statusRef.current
    setSaving(true)
    setError(null)
    try {
      const next = await projectsAPI.updateProject(project.id, patch)
      setName(next.name)
      setKey(next.key ?? "")
      setColor(next.color)
      setSymbol(symbolFor(next.icon)?.key ?? null)
      setDescription(next.description ?? "")
      setStatus(next.status)
      setSavedNote(true)
      onSaved(next)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setKeyError(messageOf(err, KEY_TAKEN))
        focusAfterSave.current = keyRef.current
      } else {
        setError(messageOf(err, SAVE_FAILED))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${ids}-heading`} className="flex flex-col gap-4 px-6 pt-5 pb-6">
      <h3 id={`${ids}-heading`} className={SECTION_HEADING}>
        Details
      </h3>
      {ACCESS_NOTE[access] && <p className="rounded-lg bg-app-sunk px-3 py-2 text-ui text-muted-foreground">{ACCESS_NOTE[access]}</p>}

      {access === "view" ? (
        <ReadOnlyDetails project={project} />
      ) : (
        <fieldset disabled={locked} className="flex min-w-0 flex-col gap-4">
          <NameField
            id={`${ids}-name`}
            inputRef={nameRef}
            value={name}
            error={nameError}
            onChange={(next) => {
              setName(next)
              if (nameError) setNameError(null)
              edited()
            }}
          />
          <KeyField
            id={`${ids}-key`}
            inputRef={keyRef}
            value={key}
            error={keyError}
            hint={`Task IDs look like ${key || project.key || "WEB"}-12. Changing the key changes them all.`}
            onChange={(next) => {
              setKey(next)
              if (keyError) setKeyError(null)
              edited()
            }}
          />
          <ColorField
            id={`${ids}-color`}
            value={color}
            onChange={(hex) => {
              setColor(hex)
              edited()
            }}
          />
          <SymbolField
            id={`${ids}-symbol`}
            value={symbol}
            onChange={(next) => {
              setSymbol(next)
              edited()
            }}
          />
          <DescriptionField
            id={`${ids}-description`}
            value={description}
            onChange={(next) => {
              setDescription(next)
              edited()
            }}
          />
          <div className="flex flex-col items-start gap-2">
            <span aria-hidden="true" className="form-label mb-0">
              Status
            </span>
            <SegmentedControl
              label="Status"
              value={status}
              onChange={(next) => {
                setStatus(next)
                edited()
              }}
              options={STATUSES}
              className="[fieldset:disabled_&]:opacity-50"
            />
          </div>
        </fieldset>
      )}

      {(access === "edit" || access === "loading") && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {error && (
            <p role="alert" className="mr-auto text-ui text-app-berry-text">
              {error}
            </p>
          )}
          <p ref={statusRef} role="status" tabIndex={-1} className="text-ui text-muted-foreground focus:outline-none">
            {savedNote && !dirty ? "Changes saved" : ""}
          </p>
          <Button type="submit" variant={dirty || saving ? "default" : "secondary"} disabled={locked || !dirty}>
            {saving ? "Saving" : "Save changes"}
          </Button>
        </div>
      )}
    </form>
  )
}

// Users who can only view the settings see the values as text, not as a form they can't use
function ReadOnlyDetails({ project }: { project: Project }) {
  const swatch = nearestSwatch(project.color)
  const symbol = symbolFor(project.icon)
  const term = "font-medium text-muted-foreground"
  return (
    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-ui leading-[1.45]">
      <dt className={term}>Name</dt>
      <dd className="min-w-0 font-medium wrap-anywhere text-foreground">{project.name}</dd>
      <dt className={term}>Key</dt>
      <dd className="font-medium tracking-[0.04em] text-foreground tabular-nums">{project.key || "None"}</dd>
      <dt className={term}>Color</dt>
      <dd className="flex items-center gap-2 text-foreground">
        <IdentityTile color={project.color} symbol={null} size="sm" />
        {SWATCH_NAMES[swatch.key]}
      </dd>
      <dt className={term}>Symbol</dt>
      <dd className="flex items-center gap-2 text-foreground">
        {symbol ? (
          <>
            <IdentityTile color={project.color} symbol={project.icon} size="sm" />
            {symbol.label}
          </>
        ) : (
          <span className="text-muted-foreground">No symbol</span>
        )}
      </dd>
      <dt className={term}>Description</dt>
      <dd className={cn("min-w-0 wrap-anywhere whitespace-pre-wrap", project.description ? "text-foreground" : "text-muted-foreground")}>
        {project.description || "No description"}
      </dd>
      <dt className={term}>Status</dt>
      <dd className="text-foreground">{STATUSES.find((status) => status.value === project.status)?.label ?? project.status}</dd>
    </dl>
  )
}

function MembersSection({
  project,
  me,
  members,
  error,
  canManage,
  onRetry,
  onChange,
}: {
  project: Project
  me: string | null
  members: ProjectMember[] | null
  error: string | null
  canManage: boolean
  onRetry: () => void
  onChange: (members: ProjectMember[]) => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const ids = useId()

  const run = async (userId: string, action: () => Promise<ProjectMember[]>): Promise<boolean> => {
    if (busyId) return false
    setBusyId(userId)
    setActionError(null)
    try {
      onChange(await action())
      return true
    } catch (err) {
      setActionError(messageOf(err, MEMBER_FAILED))
      return false
    } finally {
      setBusyId(null)
    }
  }

  const list = members ?? []

  const add = (person: PersonResult) =>
    run(person.id, async () => {
      const row = await projectsAPI.addProjectMember(project.id, person.id)
      return [...list, { ...row, user: person }]
    })

  const changeRole = (member: ProjectMember, role: ProjectRole) =>
    run(member.user_id, async () => {
      await projectsAPI.updateProjectMemberRole(project.id, member.user_id, role)
      return list.map((m) => (m.user_id === member.user_id ? { ...m, role } : m))
    })

  const remove = async (member: ProjectMember) => {
    const removed = await run(member.user_id, async () => {
      await projectsAPI.removeProjectMember(project.id, member.user_id)
      return list.filter((m) => m.user_id !== member.user_id)
    })
    if (!removed) return
    const next = sectionRef.current?.querySelector<HTMLInputElement>("input") ?? headingRef.current
    next?.focus()
  }

  const note = canManage ? null : "Only project admins can add, remove or change members."

  return (
    <section
      ref={sectionRef}
      aria-labelledby={`${ids}-heading`}
      className="flex flex-col gap-3 border-t-[0.0625rem] border-border px-6 py-5"
    >
      <h3 ref={headingRef} id={`${ids}-heading`} tabIndex={-1} className={cn(SECTION_HEADING, "focus:outline-none")}>
        Members
        {members && <span className="ml-1.5 text-caption font-medium text-muted-foreground tabular-nums">{members.length}</span>}
      </h3>

      {members === null ? (
        error ? (
          <div role="alert" className="flex flex-wrap items-center gap-2.5 text-ui">
            <span className="text-app-berry-text">{error}</span>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : (
          <div aria-hidden="true" className="flex flex-col gap-2">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-[2.75rem] rounded-lg" />
            ))}
          </div>
        )
      ) : (
        <ul className="overflow-hidden rounded-lg ring-[0.0625rem] ring-border">
          {members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              self={member.user_id === me}
              canManage={canManage}
              busy={busyId === member.user_id}
              locked={busyId !== null}
              onRole={(role) => changeRole(member, role)}
              onRemove={() => remove(member)}
            />
          ))}
        </ul>
      )}

      {actionError && (
        <p role="alert" className="text-ui text-app-berry-text">
          {actionError}
        </p>
      )}

      {note && members !== null && <p className="text-caption text-muted-foreground">{note}</p>}
      {canManage && members !== null && (
        <PeopleSearch excludeIds={members.map((member) => member.user_id)} onPick={add} busy={busyId !== null} />
      )}
    </section>
  )
}

function MemberRow({
  member,
  self,
  canManage,
  busy,
  locked,
  onRole,
  onRemove,
}: {
  member: ProjectMember
  self: boolean
  canManage: boolean
  busy: boolean
  locked: boolean
  onRole: (role: ProjectRole) => void
  onRemove: () => void
}) {
  const name = member.user ? personName(member.user) : "Unknown user"
  const role = ROLE_LABEL[member.role] ?? member.role
  const editable = canManage && !self

  return (
    <li
      aria-busy={busy || undefined}
      className={cn(
        "grid items-center gap-x-2.5 gap-y-1.5 border-b-[0.0625rem] border-border bg-card px-3 py-2 transition-opacity duration-150 last:border-b-0",
        editable ? "grid-cols-[2rem_minmax(0,1fr)] sm:grid-cols-[2rem_minmax(0,1fr)_auto]" : "grid-cols-[2rem_minmax(0,1fr)_auto]",
        busy && "opacity-60",
      )}
    >
      <UserAvatar user={member.user} size="md" profile />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-ui font-medium text-foreground">
          {name}
          {self && <span className="ml-1.5 font-normal text-muted-foreground">You</span>}
        </span>
        {member.user?.email && <span className="truncate text-caption text-muted-foreground">{member.user.email}</span>}
      </span>
      {editable ? (
        <span className="col-start-2 flex items-center gap-1 sm:col-start-auto">
          <Select value={member.role} onValueChange={(next) => onRole(next as ProjectRole)} disabled={locked}>
            <SelectPrimitive.Trigger
              aria-label={`Role for ${name}: ${role}`}
              className="inline-flex h-[1.75rem] shrink-0 items-center gap-1.5 rounded-md border-[0.0625rem] border-border bg-card px-2.5 text-ui font-medium text-foreground transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-app-hover max-lg:h-11"
            >
              {role}
              <ChevronDown aria-hidden="true" weight="bold" className="size-[0.7rem] shrink-0 text-muted-foreground" />
            </SelectPrimitive.Trigger>
            <SelectContent className="min-w-[8rem]">
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="member">Member</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${name}`}
            title="Remove"
            disabled={locked}
            onClick={onRemove}
            className="size-[1.75rem] rounded-md text-muted-foreground hover:text-foreground max-lg:size-11"
          >
            <X aria-hidden="true" className="size-[0.9rem]" />
          </Button>
        </span>
      ) : (
        <span className="text-ui font-medium text-muted-foreground">{role}</span>
      )}
    </li>
  )
}

function DangerSection({ project, onDeleted, onClose }: { project: Project; onDeleted: () => void; onClose: () => void }) {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState("")
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)
  const ids = useId()
  const matches = typed.trim() === project.name.trim()
  const impact = useTimeImpactText(confirming ? { projectId: project.id } : null, "project")

  useEffect(() => {
    if (confirming || !returnFocus.current) return
    returnFocus.current = false
    deleteRef.current?.focus()
  }, [confirming])

  const remove = async () => {
    if (!matches || deleting) return
    setDeleting(true)
    setError(null)
    let entry: TrashRef
    try {
      entry = await projectsAPI.deleteProject(project.id)
    } catch (err) {
      setError(messageOf(err, DELETE_FAILED))
      setDeleting(false)
      return
    }
    dropProject(project.id)
    notifyTasksChanged()
    onDeleted()
    onClose()
    navigate("/projects")
    movedToTrash("Project moved to the trash", entry, (restored) => {
      if (restored.kind === "project") returnProject(restored.project)
      notifyTasksChanged()
    })
  }

  return (
    <section aria-labelledby={`${ids}-heading`} className="flex flex-col gap-2.5 border-t-[0.0625rem] border-border px-6 pt-5 pb-6">
      <h3 id={`${ids}-heading`} className={SECTION_HEADING}>
        Delete project
      </h3>
      <p id={`${ids}-what`} className="text-ui leading-[1.5] text-muted-foreground">
        Moves the project to Trash with all of its tasks, files, papers, boards and chat. Nobody can open it until it's restored, and it's
        deleted for good after 30 days.
        {impact && ` ${impact}`}
      </p>
      {confirming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void remove()
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor={`${ids}-confirm`} className="text-ui text-foreground">
            Type <span className="font-semibold">{project.name}</span> to confirm
          </label>
          <Input
            id={`${ids}-confirm`}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-describedby={`${ids}-what`}
            disabled={deleting}
          />
          {error && (
            <p role="alert" className="text-ui text-app-berry-text">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={deleting}
              onClick={() => {
                returnFocus.current = true
                setConfirming(false)
                setTyped("")
                setError(null)
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!matches || deleting}>
              {deleting ? "Deleting" : "Delete project"}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button ref={deleteRef} type="button" variant="outline" onClick={() => setConfirming(true)}>
            <Trash aria-hidden="true" className="size-[1rem] text-muted-foreground" />
            Delete project
          </Button>
        </div>
      )}
    </section>
  )
}

function LeaveSection({
  project,
  members,
  me,
  onClose,
}: {
  project: Project
  members: ProjectMember[]
  me: string | null
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const leaveRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)
  const ids = useId()

  const others = members.filter((member) => member.user_id !== me)
  const lastAdmin =
    others.length > 0 && !others.some((member) => member.role === "admin") && members.some((m) => m.user_id === me && m.role === "admin")
  const after =
    others.length === 0
      ? " Nobody is left in it after you, so only a workspace admin can delete it."
      : lastAdmin
        ? " The longest-standing member becomes an admin."
        : ""

  useEffect(() => {
    if (confirming || !returnFocus.current) return
    returnFocus.current = false
    leaveRef.current?.focus()
  }, [confirming])

  const leave = async () => {
    if (!me || leaving) return
    setLeaving(true)
    setError(null)
    try {
      await projectsAPI.removeProjectMember(project.id, me)
    } catch (err) {
      setError(messageOf(err, LEAVE_FAILED))
      setLeaving(false)
      return
    }
    notifyProjectsChanged()
    notifyTasksChanged()
    onClose()
    navigate("/projects")
  }

  return (
    <section aria-labelledby={`${ids}-heading`} className="flex flex-col gap-2.5 border-t-[0.0625rem] border-border px-6 pt-5 pb-6">
      <h3 id={`${ids}-heading`} className={SECTION_HEADING}>
        Leave project
      </h3>
      <p className="text-ui leading-[1.5] text-muted-foreground">
        You lose access to its tasks, files and chat. Tasks assigned to you here are unassigned.{after}
      </p>
      {error && (
        <p role="alert" className="text-ui text-app-berry-text">
          {error}
        </p>
      )}
      {confirming ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={leaving}
            onClick={() => {
              returnFocus.current = true
              setConfirming(false)
              setError(null)
            }}
          >
            Cancel
          </Button>
          <Button type="button" variant="destructive" autoFocus disabled={leaving} onClick={() => void leave()}>
            {leaving ? "Leaving" : "Leave project"}
          </Button>
        </div>
      ) : (
        <div>
          <Button ref={leaveRef} type="button" variant="outline" onClick={() => setConfirming(true)}>
            <LogOut aria-hidden="true" className="size-[1rem] text-muted-foreground" />
            Leave project
          </Button>
        </div>
      )}
    </section>
  )
}

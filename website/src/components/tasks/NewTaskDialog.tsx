import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import { tasksAPI, type Task } from "@/lib/api/tasks"
import type { UserSummary } from "@/lib/api/users"
import { messageOf, notifyTasksChanged } from "@/lib/taskStore"
import { useProjects } from "@/lib/useProjects"
import { useAuth } from "@/providers/AuthProvider"
import { TASK_DESCRIPTION_MAX, type TaskPriority, type TaskStatus } from "@/types/tasks"
import { DueDatePopover } from "./DueDatePopover"
import { AssigneePicker, PriorityPicker, ProjectPicker, StatusPicker } from "./pickers"

const CREATE_FAILED = "Couldn't create the task. Check your connection and try again."

type NewTaskDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultProjectId: string | null
  defaultStatus?: TaskStatus
  initialDescription?: string
  onCreated: (task: Task) => void
  fallbackFocus?: () => HTMLElement | null | undefined
  source?: string
}

export function NewTaskDialog({
  open,
  onOpenChange,
  defaultProjectId,
  defaultStatus = "todo",
  initialDescription = "",
  onCreated,
  fallbackFocus,
  source,
}: NewTaskDialogProps) {
  return (
    <BaseModal isOpen={open} onClose={() => onOpenChange(false)} title="New task" maxWidth="xl" fallbackFocus={fallbackFocus}>
      <NewTaskForm
        defaultProjectId={defaultProjectId}
        defaultStatus={defaultStatus}
        initialDescription={initialDescription}
        onCreated={onCreated}
        onClose={() => onOpenChange(false)}
        source={source}
      />
    </BaseModal>
  )
}

function NewTaskForm({
  defaultProjectId,
  defaultStatus,
  initialDescription,
  onCreated,
  onClose,
  source,
}: {
  defaultProjectId: string | null
  defaultStatus: TaskStatus
  initialDescription: string
  onCreated: (task: Task) => void
  onClose: () => void
  source?: string
}) {
  const { user } = useAuth()
  const { projects } = useProjects()
  const me: UserSummary | null = user
    ? { id: user.id, first_name: user.firstName, last_name: user.lastName, avatar_url: user.avatarUrl ?? null }
    : null

  const [title, setTitle] = useState("")
  const [description, setDescription] = useState(initialDescription)
  const [projectId, setProjectId] = useState<string | null>(defaultProjectId)
  const [status, setStatus] = useState<TaskStatus>(defaultStatus)
  const [priority, setPriority] = useState<TaskPriority>("none")
  const [assignee, setAssignee] = useState<string | null>(me?.id ?? null)
  const [due, setDue] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missingTitle, setMissingTitle] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const ids = useId()

  const choices = useMemo(
    () => projects.filter((project) => project.status !== "archived" || project.id === projectId),
    [projects, projectId],
  )
  const membersOf = (id: string | null) => projects.find((project) => project.id === id)?.members ?? []
  const members = membersOf(projectId)

  const changeProject = (next: string | null) => {
    setProjectId(next)
    if (assignee && assignee !== me?.id && !membersOf(next).some((member) => member.id === assignee)) {
      setAssignee(me?.id ?? null)
    }
  }

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const name = title.trim()
    if (!name) {
      setMissingTitle(true)
      titleRef.current?.focus()
      return
    }
    if (saving) return

    setSaving(true)
    setError(null)
    const knownAssignee = assignee === null || members.some((member) => member.id === assignee)
    try {
      const task = await tasksAPI.createTask({
        title: name,
        description: description.trim() || undefined,
        project_id: projectId,
        status,
        priority,
        assigned_to: projectId !== null && knownAssignee ? assignee : undefined,
        due_date: due ?? undefined,
      })
      notifyTasksChanged(source)
      onCreated(task)
      onClose()
    } catch (err) {
      setError(messageOf(err, CREATE_FAILED))
      setSaving(false)
    }
  }

  const submitOnModEnter = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.currentTarget.requestSubmit()
    }
  }

  return (
    <form onSubmit={submit} onKeyDown={submitOnModEnter} noValidate className="flex flex-col">
      <div className="flex flex-col gap-2 px-6 pt-5 pb-4">
        <label htmlFor={`${ids}-title`} className="sr-only">
          Title
        </label>
        <input
          ref={titleRef}
          id={`${ids}-title`}
          autoFocus
          required
          autoComplete="off"
          maxLength={255}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            if (missingTitle) setMissingTitle(false)
          }}
          placeholder="Task title"
          aria-invalid={missingTitle || undefined}
          aria-describedby={missingTitle ? `${ids}-title-error` : undefined}
          disabled={saving}
          className="-mx-2 w-[calc(100%+1rem)] rounded-md bg-transparent px-2 py-1 text-title font-semibold tracking-[-0.01em] text-foreground transition-colors duration-150 placeholder:text-muted-foreground focus-visible:bg-app-sunk focus-visible:outline-none"
        />
        {missingTitle && (
          <FieldError id={`${ids}-title-error`} className="mt-0">
            Give the task a title
          </FieldError>
        )}
        <label htmlFor={`${ids}-description`} className="sr-only">
          Description
        </label>
        <textarea
          id={`${ids}-description`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add a description"
          maxLength={TASK_DESCRIPTION_MAX}
          rows={4}
          disabled={saving}
          className="-mx-2 min-h-[5.5rem] w-[calc(100%+1rem)] resize-none rounded-md bg-transparent px-2 py-1.5 text-body leading-[1.55] font-normal text-foreground transition-colors duration-150 placeholder:font-normal placeholder:text-muted-foreground focus-visible:bg-app-sunk focus-visible:outline-none"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-5">
        <ProjectPicker
          variant="pill"
          value={projectId}
          projects={choices}
          onChange={changeProject}
          disabled={saving}
          className="max-w-[12rem]"
        />
        <StatusPicker variant="pill" value={status} onChange={setStatus} disabled={saving} />
        <PriorityPicker variant="pill" value={priority} onChange={setPriority} disabled={saving} />
        {projectId !== null && (
          <AssigneePicker variant="pill" value={assignee} members={members} assignee={me} onChange={setAssignee} disabled={saving} />
        )}
        <DueDatePopover variant="pill" value={due} onChange={setDue} disabled={saving} />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t-[0.0625rem] border-border px-6 py-4">
        {error && (
          <p role="alert" className="mr-auto text-ui text-app-berry-text">
            {error}
          </p>
        )}
        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Creating" : "Create task"}
        </Button>
      </div>
    </form>
  )
}

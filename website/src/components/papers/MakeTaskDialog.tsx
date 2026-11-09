import { useEffect, useId, useMemo, useState, type FormEvent } from "react"
import { AssigneePicker, ProjectPicker } from "@/components/tasks/pickers"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import { tasksAPI, type Task } from "@/lib/api/tasks"
import type { UserSummary } from "@/lib/api/users"
import { messageOf, notifyTasksChanged } from "@/lib/taskStore"
import { useProjects } from "@/lib/useProjects"
import { useAuth } from "@/providers/AuthProvider"

/** Turns a checklist line into a task: its text as the title, in the paper's project unless another is picked */
export function MakeTaskDialog({
  line,
  projectId,
  onCreated,
  onClose,
}: {
  /** The line's text, or null when closed */
  line: string | null
  projectId: string | null
  onCreated: (task: Task) => void
  onClose: () => void
}) {
  const { user } = useAuth()
  const { projects } = useProjects()
  const ids = useId()
  const me: UserSummary | null = user
    ? { id: user.id, first_name: user.firstName, last_name: user.lastName, avatar_url: user.avatarUrl ?? null }
    : null
  // Only projects the user can add tasks to
  const choices = useMemo(() => projects.filter((project) => project.member !== false && project.status !== "archived"), [projects])
  const [title, setTitle] = useState("")
  const [project, setProject] = useState<string | null>(null)
  const [assignee, setAssignee] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missingTitle, setMissingTitle] = useState(false)

  useEffect(() => {
    if (line === null) return
    setTitle(line)
    setProject(projectId && choices.some((choice) => choice.id === projectId) ? projectId : null)
    setAssignee(me?.id ?? null)
    setSaving(false)
    setError(null)
    setMissingTitle(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- starts fresh each time a line opens it, and only then
  }, [line])

  const members = choices.find((choice) => choice.id === project)?.members ?? []

  const changeProject = (next: string | null) => {
    setProject(next)
    const stillThere = next !== null && choices.find((choice) => choice.id === next)?.members.some((member) => member.id === assignee)
    if (!stillThere) setAssignee(me?.id ?? null)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = title.trim()
    if (!name) return setMissingTitle(true)
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const task = await tasksAPI.createTask({
        title: name,
        project_id: project,
        assigned_to: project !== null ? assignee : undefined,
      })
      notifyTasksChanged()
      onCreated(task)
      onClose()
    } catch (err) {
      setError(messageOf(err, "Couldn't make the task. Try again."))
      setSaving(false)
    }
  }

  return (
    <BaseModal isOpen={line !== null} onClose={onClose} title="Make task" maxWidth="md">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4 p-6">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-title`} className="text-ui font-medium text-foreground">
            Title
          </label>
          <input
            id={`${ids}-title`}
            autoFocus
            autoComplete="off"
            maxLength={255}
            value={title}
            disabled={saving}
            aria-invalid={missingTitle || undefined}
            aria-describedby={missingTitle ? `${ids}-error` : undefined}
            onChange={(event) => {
              setTitle(event.target.value)
              setMissingTitle(false)
            }}
            className="h-8 w-full rounded-md bg-app-sunk px-2.5 text-ui text-foreground placeholder:text-muted-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:h-11"
          />
          {missingTitle && (
            <FieldError id={`${ids}-error`} className="mt-0">
              Give the task a title
            </FieldError>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProjectPicker
            variant="pill"
            value={project}
            projects={choices}
            onChange={changeProject}
            disabled={saving}
            className="max-w-[14rem]"
          />
          {project !== null && (
            <AssigneePicker variant="pill" value={assignee} members={members} assignee={me} onChange={setAssignee} disabled={saving} />
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {error && (
            <p role="alert" className="mr-auto text-ui text-app-berry-text">
              {error}
            </p>
          )}
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Making" : "Make task"}
          </Button>
        </div>
      </form>
    </BaseModal>
  )
}

import { useRef, useState } from "react"
import { Trash } from "@/components/icons"
import { useTimeImpactText } from "@/components/time/timeImpact"
import { IdentityTile } from "@/components/ui/identity-tile"
import { Skeleton } from "@/components/ui/skeleton"
import { organizationsAPI } from "@/lib/api/organizations"
import { projectsAPI, type WorkspaceProject } from "@/lib/api/projects"
import { notifyTasksChanged } from "@/lib/taskStore"
import { useBusyLoad } from "@/lib/useBusyRetry"
import { movedToTrash } from "@/lib/trashToast"
import { dropProject, returnProject } from "@/lib/useProjects"
import { ConfirmDialog } from "./ConfirmDialog"
import { LoadError, LoadingRows } from "./LoadState"
import { SettingsSection } from "./SettingsSection"

const LOAD_FAILED = "Couldn't load the projects. Check your connection and try again."
const DELETE_FAILED = "Couldn't delete the project. Try again."

const statusLabel = (status: string) => status.charAt(0).toUpperCase() + status.slice(1)
const memberCount = (count: number) => (count === 1 ? "1 member" : `${count} members`)

/** Every project in the workspace, by name only, so an admin can delete one they are not in */
export function WorkspaceProjects() {
  const {
    data: projects,
    setData: setProjects,
    loadError,
    busy,
    reload,
    retry,
  } = useBusyLoad(organizationsAPI.getWorkspaceProjects, LOAD_FAILED)
  const [deleting, setDeleting] = useState<WorkspaceProject | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const nextFocus = useRef<string | null>(null)
  const impact = useTimeImpactText(deleting ? { projectId: deleting.id } : null, "project")

  const askDelete = (project: WorkspaceProject) => {
    const rows = projects ?? []
    const index = rows.findIndex((p) => p.id === project.id)
    const next = rows[index + 1] ?? rows[index - 1]
    nextFocus.current = next ? `[data-delete="${next.id}"]` : null
    setDeleting(project)
  }

  const remove = async (project: WorkspaceProject) => {
    const entry = await projectsAPI.deleteProject(project.id)
    setProjects((current) => current && current.filter((p) => p.id !== project.id))
    dropProject(project.id)
    notifyTasksChanged()
    movedToTrash("Project moved to the trash", entry, (restored) => {
      if (restored.kind === "project") returnProject(restored.project)
      notifyTasksChanged()
      reload()
    })
  }

  return (
    <SettingsSection
      title="Projects"
      meta={projects && projects.length}
      description="Every project in the workspace. You see names and counts here, not what's inside."
    >
      {loadError ? (
        <LoadError message={loadError} onRetry={retry} />
      ) : !projects ? (
        <LoadingRows label="Loading projects" busy={busy}>
          <Skeleton className="h-[2.75rem] rounded-lg" />
          <Skeleton className="h-[2.75rem] rounded-lg" />
        </LoadingRows>
      ) : projects.length === 0 ? (
        <p className="text-body text-muted-foreground">No projects yet.</p>
      ) : (
        <ul ref={list} tabIndex={-1} aria-label="Projects" className="flex flex-col divide-y divide-border focus:outline-none">
          {projects.map((project) => (
            <li key={project.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <IdentityTile color={project.color} symbol={project.icon} size="sm" />
              <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
                <p className="min-w-0 truncate text-body font-medium text-foreground sm:flex-1">{project.name}</p>
                <p className="shrink-0 text-ui text-muted-foreground tabular-nums">
                  {statusLabel(project.status)} · {memberCount(project.member_count)}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Delete ${project.name}`}
                data-delete={project.id}
                onClick={() => askDelete(project)}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:size-11"
              >
                <Trash aria-hidden="true" className="size-[1rem]" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Delete project?"
        confirmLabel="Delete project"
        busyLabel="Deleting"
        failed={DELETE_FAILED}
        onConfirm={() => (deleting ? remove(deleting) : Promise.resolve())}
        onClose={() => setDeleting(null)}
        fallbackFocus={() => (nextFocus.current && list.current?.querySelector<HTMLElement>(nextFocus.current)) || list.current}
      >
        <span className="mb-2 block font-semibold text-foreground">{deleting?.name}</span>
        Moves the project to Trash with all of its tasks, files, papers, boards and chat. Nobody can open it until it's restored, and it's
        deleted for good after 30 days.
        {impact && ` ${impact}`}
      </ConfirmDialog>
    </SettingsSection>
  )
}

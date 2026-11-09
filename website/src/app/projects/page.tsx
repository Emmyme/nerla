import { useEffect, useState } from "react"
import { Link } from "react-router"
import { Warning } from "@/components/icons"
import { NewProjectDialog } from "@/components/projects/NewProjectDialog"
import { PageHeader } from "@/components/shell/PageHeader"
import { DueLabel } from "@/components/tasks/DueLabel"
import { Button } from "@/components/ui/button"
import { IdentityTile } from "@/components/ui/identity-tile"
import { Skeleton } from "@/components/ui/skeleton"
import { UserAvatar } from "@/components/ui/user-avatar"
import { projectsAPI, type Project } from "@/lib/api/projects"
import { useDocumentTitle } from "@/lib/useDocumentTitle"
import { useProjects } from "@/lib/useProjects"
import { useTaskShortcuts } from "@/lib/useTaskShortcuts"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"

const MAX_AVATARS = 4

// The name track is capped and the spare width goes to an empty last track, so the data sits next to the names
const COLUMNS = "grid-cols-[1.0625rem_minmax(0,1fr)_auto] sm:grid-cols-[1.0625rem_minmax(12rem,24rem)_10.5rem_7.75rem_5.5rem_minmax(0,1fr)]"

/** Workspace admins also see the projects they are not in, which they can open to read */
function useAdminView(memberIds: string[]) {
  const { user } = useAuth()
  const admin = user?.role === "admin"
  const [others, setOthers] = useState<Project[]>([])
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const key = memberIds.join(",")

  useEffect(() => {
    if (!admin) {
      setOthers([])
      setFailed(false)
      return
    }
    let live = true
    projectsAPI.getAllProjects().then(
      (all) => {
        if (!live) return
        setOthers(all.filter((project) => project.member === false))
        setFailed(false)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [admin, key, attempt])

  const mine = new Set(memberIds)
  return {
    viewable: others.filter((project) => !mine.has(project.id)),
    failed: admin && failed,
    retry: () => setAttempt((n) => n + 1),
  }
}

export default function ProjectsPage() {
  useDocumentTitle("Projects")
  const { projects, status, error, refresh } = useProjects()
  const [creating, setCreating] = useState(false)
  useTaskShortcuts({ new: () => setCreating(true) })
  const { viewable, failed: adminViewFailed, retry: retryAdminView } = useAdminView(projects.map((project) => project.id))
  const viewableShown = viewable.filter((project) => project.status !== "archived")
  const viewableArchived = viewable.filter((project) => project.status === "archived")

  const active = projects.filter((project) => project.status !== "archived")
  const archived = projects.filter((project) => project.status === "archived")
  const loadFailed = status === "error" && projects.length === 0

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Projects"
        actions={
          <Button type="button" shortcut="C" onClick={() => setCreating(true)}>
            New project
          </Button>
        }
      />

      {status === "error" && !loadFailed && (
        <div role="alert" className="flex items-center gap-2.5 rounded-lg border-[0.0625rem] border-border bg-card py-1 pr-1 pl-3 text-ui">
          <Warning aria-hidden="true" weight="fill" className="size-[1rem] shrink-0 text-app-berry" />
          <span className="min-w-0 flex-1 text-app-berry-text">{error ?? "Couldn't refresh projects."}</span>
          <Button type="button" variant="ghost" size="sm" onClick={refresh}>
            Try again
          </Button>
        </div>
      )}

      {status === "loading" && projects.length === 0 ? (
        <ListSkeleton />
      ) : loadFailed ? (
        <Placeholder role="alert" text={error ?? "Couldn't load projects."} action="Try again" onAction={refresh} />
      ) : projects.length === 0 ? (
        <Placeholder
          text="You're not in any projects yet."
          hint="Create one or ask a project admin to add you."
          action="New project"
          onAction={() => setCreating(true)}
        />
      ) : (
        <>
          {active.length > 0 && <ProjectList label="Projects" projects={active} />}
          {archived.length > 0 && (
            <section aria-labelledby="projects-archived" className="flex flex-col gap-2.5">
              <h2 id="projects-archived" className="text-body font-semibold tracking-normal text-muted-foreground">
                Archived
                <span className="ml-1.5 text-caption font-medium tabular-nums">{archived.length}</span>
              </h2>
              <ProjectList label="Archived projects" projects={archived} dimmed />
            </section>
          )}
        </>
      )}

      {viewable.length > 0 && (
        <section aria-labelledby="projects-admin" className="flex flex-col gap-2.5">
          <h2 id="projects-admin" className="text-body font-semibold tracking-normal text-muted-foreground">
            View as admin
            <span className="ml-1.5 text-caption font-medium tabular-nums">{viewable.length}</span>
          </h2>
          <ProjectList label="Projects you can view as an admin" projects={[...viewableShown, ...viewableArchived]} />
        </section>
      )}
      {adminViewFailed && (
        <p role="alert" className="flex flex-wrap items-center gap-x-2 text-ui text-muted-foreground">
          Couldn't load the projects you can view as an admin.
          <Button type="button" variant="ghost" size="sm" onClick={retryAdminView}>
            Try again
          </Button>
        </p>
      )}

      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}

function ProjectList({ label, projects, dimmed = false }: { label: string; projects: Project[]; dimmed?: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg bg-card ring-[0.0625rem] ring-border">
      <div
        aria-hidden="true"
        className={cn(
          "grid items-center gap-x-3 border-b-[0.0625rem] border-border px-3 py-2 text-caption font-medium text-muted-foreground max-sm:hidden",
          COLUMNS,
        )}
      >
        <span />
        <span>Name</span>
        <span>Progress</span>
        <span>Members</span>
        <span className="text-right">Next due</span>
      </div>
      <ul aria-label={label}>
        {projects.map((project) => (
          <li key={project.id} className="border-b-[0.0625rem] border-border last:border-b-0">
            <ProjectRow project={project} dimmed={dimmed || project.status === "archived"} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function ProjectRow({ project, dimmed }: { project: Project; dimmed: boolean }) {
  const { task_count: total, done_count: done } = project
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  const shown = project.members.slice(0, MAX_AVATARS)
  const extra = project.members.length - shown.length

  return (
    <Link
      to={`/project/${project.slug}`}
      className={cn(
        "grid items-center gap-x-3 gap-y-1.5 px-3 py-2.5 transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset max-sm:py-3",
        COLUMNS,
      )}
    >
      <IdentityTile color={project.color} symbol={project.icon} size="sm" />

      <span className="flex min-w-0 items-baseline gap-2">
        <span className={cn("truncate text-body font-medium", dimmed ? "text-muted-foreground" : "text-foreground")}>{project.name}</span>
        {project.key && (
          <span className="shrink-0 text-caption font-medium tracking-[0.01em] text-muted-foreground tabular-nums">{project.key}</span>
        )}
      </span>

      <span className="col-span-2 col-start-2 row-start-2 flex min-w-0 items-center gap-2.5 sm:col-span-1 sm:col-start-auto sm:row-start-auto">
        {total > 0 ? (
          <>
            <span aria-hidden="true" className="h-[0.375rem] w-full max-w-[6rem] overflow-hidden rounded-full bg-app-sunk">
              <span className="block h-full rounded-full bg-app-pistachio-strong" style={{ width: `${percent}%` }} />
            </span>
            <span className="text-caption font-medium whitespace-nowrap text-muted-foreground tabular-nums">
              {done} of {total}
              <span className="sr-only"> tasks done</span>
            </span>
          </>
        ) : (
          <span className="text-caption font-medium text-muted-foreground">No tasks</span>
        )}
      </span>

      <span className="flex items-center max-sm:hidden">
        <span className="sr-only">
          {project.members.length} {project.members.length === 1 ? "member" : "members"}
        </span>
        <span aria-hidden="true" className="flex items-center gap-0.5">
          {shown.map((member) => (
            <UserAvatar key={member.id} user={member} size="sm" />
          ))}
          {extra > 0 && <span className="pl-1 text-caption font-medium text-muted-foreground tabular-nums">+{extra}</span>}
        </span>
      </span>

      <span className="col-start-3 row-start-1 flex justify-end sm:col-start-auto sm:row-start-auto">
        {project.next_due && <span className="sr-only">Next due </span>}
        <DueLabel due={project.next_due} />
      </span>
    </Link>
  )
}

function Placeholder({
  text,
  hint,
  action,
  onAction,
  role,
}: {
  text: string
  hint?: string
  action: string
  onAction: () => void
  role?: "alert"
}) {
  return (
    <div role={role} className="flex flex-col items-center gap-3 rounded-xl px-4 py-10 text-center ring-[0.0625rem] ring-border">
      <p className="flex flex-col gap-1 text-body">
        <span className="font-semibold text-foreground">{text}</span>
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onAction}>
        {action}
      </Button>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg bg-card ring-[0.0625rem] ring-border">
      <span role="status" className="sr-only">
        Loading projects
      </span>
      <div aria-hidden="true">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-3 border-b-[0.0625rem] border-border px-3 py-3 last:border-b-0">
            <Skeleton className="size-[0.75rem] rounded-xs" />
            <Skeleton className="h-[0.9rem] w-[12rem] max-w-[50%]" />
            <Skeleton className="ml-auto h-[0.375rem] w-[6rem] rounded-full max-sm:hidden" />
          </div>
        ))}
      </div>
    </div>
  )
}

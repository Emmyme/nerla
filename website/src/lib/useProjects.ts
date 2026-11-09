import { useSyncExternalStore } from "react"
import { projectsAPI } from "@/lib/api/projects"
import { messageOf } from "@/lib/taskStore"
import type { Project } from "@/lib/api/projects"

type ProjectsStatus = "loading" | "ready" | "error"
type Snapshot = { projects: Project[]; status: ProjectsStatus; error: string | null }

const PROJECTS_CHANGED_EVENT = "nerla:projects-changed"

const EMPTY: Project[] = []
let snapshot: Snapshot = { projects: EMPTY, status: "loading", error: null }
let subscribers = 0
let requestId = 0
let listening = false
const listeners = new Set<() => void>()

function publish(next: Snapshot) {
  snapshot = next
  listeners.forEach((listener) => listener())
}

let loading = false

function refresh() {
  const id = ++requestId
  loading = true
  projectsAPI
    .getUserProjects()
    .then((projects) => {
      if (id === requestId) publish({ projects, status: "ready", error: null })
    })
    .catch((err: unknown) => {
      const error = messageOf(err, "Couldn't load projects")
      if (id === requestId) publish({ projects: snapshot.projects, status: "error", error })
    })
    .finally(() => {
      if (id === requestId) loading = false
    })
}

function patchProject(projectId: string, patch: Partial<Project>) {
  publish({ ...snapshot, projects: snapshot.projects.map((project) => (project.id === projectId ? { ...project, ...patch } : project)) })
}

/** Pins or unpins at once, and puts the pin back as it was when the server refuses */
export async function setProjectPinned(project: Project, pinned: boolean): Promise<void> {
  const before = { pinned: project.pinned ?? false, pinned_at: project.pinned_at ?? null }
  // A list already on its way was read before this change, so it is dropped and read again afterwards
  const stale = loading
  if (stale) {
    requestId += 1
    loading = false
  }
  patchProject(project.id, { pinned, pinned_at: pinned ? new Date().toISOString() : null })
  try {
    await (pinned ? projectsAPI.pinProject(project.slug) : projectsAPI.unpinProject(project.slug))
  } catch (err) {
    patchProject(project.id, before)
    throw err
  } finally {
    if (stale && subscribers > 0) refresh()
  }
}

export function notifyProjectsChanged() {
  window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT))
}

// A list already on its way may have been read before the change, so it is dropped and read again
function changeAtOnce(projects: Project[]) {
  requestId += 1
  loading = false
  publish({ ...snapshot, projects })
  notifyProjectsChanged()
}

/** A project moved to Trash leaves the sidebar and every list at once */
export function dropProject(projectId: string) {
  changeAtOnce(snapshot.projects.filter((project) => project.id !== projectId))
}

/** A restored project comes back at once for its members */
export function returnProject(project: Project) {
  const listed = snapshot.projects.some((p) => p.id === project.id)
  changeAtOnce(project.member === false || listed ? snapshot.projects : [project, ...snapshot.projects])
}

function onExternalChange() {
  if (subscribers > 0) refresh()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  subscribers += 1
  if (subscribers === 1) {
    window.addEventListener("focus", onExternalChange)
    window.addEventListener(PROJECTS_CHANGED_EVENT, onExternalChange)
    listening = true
    refresh()
  }
  return () => {
    listeners.delete(listener)
    subscribers -= 1
    if (subscribers === 0 && listening) {
      window.removeEventListener("focus", onExternalChange)
      window.removeEventListener(PROJECTS_CHANGED_EVENT, onExternalChange)
      listening = false
    }
  }
}

export function useProjects() {
  const state = useSyncExternalStore(subscribe, () => snapshot)
  return { projects: state.projects, status: state.status, error: state.error, refresh }
}

export function resetProjectsStore() {
  requestId += 1
  snapshot = { projects: EMPTY, status: "loading", error: null }
}

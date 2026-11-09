import { useSyncExternalStore } from "react"
import type { Project } from "@/lib/api/projects"

const KEY = "nerla-recent-projects"
const MAX_RECENT = 10
const EMPTY: string[] = []

let cached: string[] | null = null
const listeners = new Set<() => void>()

function read(): string[] {
  if (cached) return cached
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]")
    cached = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_RECENT) : EMPTY
  } catch {
    cached = EMPTY
  }
  return cached
}

/** Puts a project first in this viewer's recently opened list */
export function rememberProject(projectId: string) {
  const current = read()
  if (current[0] === projectId) return
  cached = [projectId, ...current.filter((id) => id !== projectId)].slice(0, MAX_RECENT)
  try {
    localStorage.setItem(KEY, JSON.stringify(cached))
  } catch {
    // The list still holds for this visit
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useRecentProjects(): string[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY)
}

export function resetRecentProjects() {
  cached = null
}

/**
 * The sidebar's projects: the pinned ones in the order they were pinned, then up to `limit` others, the recently
 * opened first and then the rest in list order.
 */
export function sidebarProjects(projects: Project[], pinnedIds: string[], recentIds: string[], limit: number) {
  const byId = new Map(projects.map((project) => [project.id, project]))
  const pinned = pinnedIds.flatMap((id) => byId.get(id) ?? [])
  const taken = new Set(pinned.map((project) => project.id))
  const others: Project[] = []
  for (const project of [...recentIds.flatMap((id) => byId.get(id) ?? []), ...projects]) {
    if (others.length >= limit) break
    if (taken.has(project.id)) continue
    taken.add(project.id)
    others.push(project)
  }
  return { pinned, others }
}

import { useId, useState, type ReactNode } from "react"
import { Link } from "react-router"
import { ChevronDown, Folder, Recent, SharedFolder, Trash, type IconComponent } from "@/components/icons"
import { Collapse } from "@/components/ui/collapse"
import { IdentityTile } from "@/components/ui/identity-tile"
import type { Project } from "@/lib/api/projects"
import { cn } from "@/lib/utils"
import { readViewPreference, saveViewPreference } from "@/lib/viewPreference"
import { UsageMeter } from "./UsageMeter"
import type { FilePlace, Usage } from "./useFiles"

type Entry = { key: string; label: string; to: string; Icon?: IconComponent; color?: string | null; symbol?: string | null }

const ROW =
  "flex min-h-[2rem] items-center gap-2.5 rounded-md px-2.5 text-ui transition-colors duration-150 focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-inset focus-visible:ring-ring"
const IDLE = "text-muted-foreground hover:bg-app-hover hover:text-foreground"
const ACTIVE = "bg-current-page font-medium text-app-pistachio-ink dark:text-foreground dark:[&_svg]:text-app-pistachio"

const sectionPath = (place: FilePlace): string =>
  place.section === "project" && place.projectId
    ? `/files?project=${encodeURIComponent(place.projectId)}`
    : place.section === "mine"
      ? "/files"
      : `/files/${place.section}`

/** Where a place lives in the Files page, a folder included */
export function filesPath(place: FilePlace): string {
  if (!place.folderId) return sectionPath(place)
  const query =
    place.section === "project" && place.projectId
      ? `?project=${encodeURIComponent(place.projectId)}`
      : place.section === "shared"
        ? "?section=shared"
        : ""
  return `/files/folder/${encodeURIComponent(place.folderId)}${query}`
}

const PROJECTS_KEY = "nerla-files-projects"
const SHOWN = ["open", "closed"] as const

const placeKey = (place: FilePlace) => (place.section === "project" ? `project:${place.projectId}` : place.section)

function entries(projects: Project[]) {
  const top: Entry[] = [
    { key: "mine", label: "My files", to: "/files", Icon: Folder },
    { key: "shared", label: "Shared with me", to: "/files/shared", Icon: SharedFolder },
  ]
  const bottom: Entry[] = [
    { key: "recent", label: "Recent", to: "/files/recent", Icon: Recent },
    { key: "trash", label: "Trash", to: "/trash?kind=files", Icon: Trash },
  ]
  const projectEntries: Entry[] = projects
    .filter((project) => project.status !== "archived")
    .map((project) => ({
      key: `project:${project.id}`,
      label: project.name,
      to: sectionPath({ section: "project", projectId: project.id }),
      color: project.color,
      symbol: project.icon,
    }))
  return { top, bottom, projectEntries }
}

function Mark({ entry }: { entry: Entry }) {
  if (entry.Icon) return <entry.Icon aria-hidden="true" className="size-[1rem] shrink-0" />
  return <IdentityTile color={entry.color} symbol={entry.symbol} size="sm" className="size-[1rem]" />
}

/** The Files sections down the left, with the user's usage at the bottom */
export function FilesNav({ place, projects, usage }: { place: FilePlace; projects: Project[]; usage: Usage | null }) {
  const current = placeKey(place)
  const { top, bottom, projectEntries } = entries(projects)
  const link = (entry: Entry) => {
    const active = entry.key === current
    return (
      <li key={entry.key}>
        <Link to={entry.to} aria-current={active ? "page" : undefined} title={entry.label} className={cn(ROW, active ? ACTIVE : IDLE)}>
          <Mark entry={entry} />
          <span className="truncate">{entry.label}</span>
        </Link>
      </li>
    )
  }
  return (
    <nav aria-label="Files sections" className="flex h-full flex-col gap-4">
      <ul className="flex flex-col gap-0.5">{[...top, ...bottom].map(link)}</ul>
      {projectEntries.length > 0 && <ProjectGroup inProject={place.section === "project"}>{projectEntries.map(link)}</ProjectGroup>}
      <UsageMeter usage={usage} className="mt-auto px-2.5 pb-1" />
    </nav>
  )
}

/** Starts closed, or as the user left it, and open while one of its projects is showing */
function ProjectGroup({ inProject, children }: { inProject: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(() => inProject || readViewPreference(PROJECTS_KEY, "closed", SHOWN) === "open")
  const toggle = () => {
    saveViewPreference(PROJECTS_KEY, open ? "closed" : "open")
    setOpen(!open)
  }
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
        className="flex min-h-[2rem] items-center justify-between rounded-md px-2.5 text-caption font-medium text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:min-h-11"
      >
        Project files
        <ChevronDown aria-hidden="true" className={cn("motion-rotate size-[0.85rem]", !open && "-rotate-90")} />
      </button>
      <Collapse open={open} id={id}>
        <ul className="flex flex-col gap-0.5">{children}</ul>
      </Collapse>
    </div>
  )
}

/** The phone's sections, as one row that scrolls sideways */
export function FilesSwitcher({ place, projects }: { place: FilePlace; projects: Project[] }) {
  const current = placeKey(place)
  const { top, bottom, projectEntries } = entries(projects)
  return (
    <nav aria-label="Files sections" className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none]">
      <ul className="flex w-max items-center gap-1.5">
        {[...top, ...bottom, ...projectEntries].map((entry) => {
          const active = entry.key === current
          return (
            <li key={entry.key}>
              <Link
                to={entry.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-full px-3.5 text-ui font-medium whitespace-nowrap transition-colors duration-150 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
                  active ? "bg-current-page text-app-pistachio-ink dark:text-foreground" : "bg-app-sunk text-muted-foreground",
                )}
              >
                <Mark entry={entry} />
                {entry.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

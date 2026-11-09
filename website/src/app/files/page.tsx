import { useCallback, useEffect, useState } from "react"
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router"
import { FileBrowser } from "@/components/files/FileBrowser"
import { filesPath, FilesNav, FilesSwitcher } from "@/components/files/FilesNav"
import { UsageMeter } from "@/components/files/UsageMeter"
import type { FilePlace, Usage } from "@/components/files/useFiles"
import type { FileSection } from "@/lib/api/files"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { useProjects } from "@/lib/useProjects"

const SECTIONS: Record<string, FileSection> = { shared: "shared", recent: "recent" }
const ROOT_LABELS: Record<Exclude<FileSection, "project">, string> = {
  mine: "My files",
  shared: "Shared with me",
  recent: "Recent",
}

function usePlace(): FilePlace {
  const { pathname } = useLocation()
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const projectId = params.get("project")
  if (projectId) return { section: "project", projectId, folderId: id ?? null }
  if (id) return { section: params.get("section") === "shared" ? "shared" : "mine", folderId: id }
  return { section: SECTIONS[pathname.split("/")[2] ?? ""] ?? "mine" }
}

export default function FilesPage() {
  const place = usePlace()
  const navigate = useNavigate()
  const desktop = useIsDesktop()
  const { projects } = useProjects()
  const [usage, setUsage] = useState<Usage | null>(null)
  const [params, setParams] = useSearchParams()

  // ?q= searches My files and everything shared, then leaves the address
  const asked = params.get("q")
  const [searchFor, setSearchFor] = useState<{ q: string } | null>(null)
  useEffect(() => {
    if (asked === null) return
    setSearchFor({ q: asked })
    setParams(
      (current) => {
        current.delete("q")
        return current
      },
      { replace: true },
    )
  }, [asked, setParams])

  const project = place.section === "project" ? projects.find((p) => p.id === place.projectId) : undefined
  const rootLabel = place.section === "project" ? (project?.name ?? "Project files") : ROOT_LABELS[place.section]

  const openFolder = useCallback(
    (folderId: string | null, target?: FilePlace) =>
      navigate(filesPath(target ?? { section: place.section, projectId: place.projectId, folderId })),
    [navigate, place.section, place.projectId],
  )

  return (
    <div data-full-bleed="" className="flex min-h-full lg:h-full lg:min-h-0">
      {desktop && (
        <aside aria-label="Files" className="w-[15rem] shrink-0 overflow-y-auto py-6 pr-2 pl-4">
          <FilesNav place={place} projects={projects} usage={usage} />
        </aside>
      )}
      <div className="min-w-0 flex-1 lg:overflow-y-auto lg:pt-6 lg:pr-6 lg:pb-[max(1.5rem,var(--chat-space,0rem))] lg:pl-4">
        <FileBrowser
          place={place}
          rootLabel={rootLabel}
          onOpenFolder={openFolder}
          onUsage={setUsage}
          searchFor={searchFor}
          phoneNav={
            !desktop && (
              <div className="flex flex-col gap-2.5">
                <FilesSwitcher place={place} projects={projects} />
                <UsageMeter usage={usage} />
              </div>
            )
          }
        />
      </div>
    </div>
  )
}

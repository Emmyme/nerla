import { FirstTip } from "@/components/onboarding/FirstTip"
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react"
import { toast } from "sonner"
import { useNavigate } from "react-router"
import { Board, DropUpload, FolderPlus, Grid, List, Paper, Search, Sort, Upload, Warning, X } from "@/components/icons"
import { ConfirmDialog } from "@/components/settings/ConfirmDialog"
import { PageHeader } from "@/components/shell/PageHeader"
import { downloadAttachment } from "@/components/tasks/AttachmentPreview"
import { BottomSheet } from "@/components/ui/bottom-sheet"
import { Button } from "@/components/ui/button"
import { CatInFolder, CatSearching } from "@/components/ui/cat-scenes"
import { CreateFab } from "@/components/ui/create-fab"
import { NotFoundView } from "@/components/ui/not-found-view"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { fileBrowserAPI, filesAPI, type DocType, type FileItem, type FileSearchQuery, type FileSort } from "@/lib/api/files"
import { fileSharingAPI } from "@/lib/api/fileSharing"
import { papersAPI } from "@/lib/api/papers"
import { messageOf } from "@/lib/taskStore"
import { useIsDesktop, useMediaQuery } from "@/lib/useMediaQuery"
import { shouldIgnoreKey } from "@/lib/useTaskShortcuts"
import { cn } from "@/lib/utils"
import { readViewPreference, saveViewPreference } from "@/lib/viewPreference"
import { useAuth } from "@/providers/AuthProvider"
import { AltTextDialog } from "./AltTextDialog"
import { Breadcrumbs } from "./Breadcrumbs"
import { MenuPopover, type MenuEntry } from "./ActionMenu"
import { carriesFiles, type DraggedItem } from "./fileDrag"
import { FileGrid } from "./FileGrid"
import { docRoute, type TypeGroup } from "./fileKinds"
import { FileList } from "./FileList"
import { LinkDialog } from "./LinkDialog"
import { FilePreviewDialog, type PreviewFile } from "./FilePreviewDialog"
import type { FileActions, RowItem } from "./FileRowMenu"
import { MoveDialog } from "./MoveDialog"
import { EditFolderDialog, NameDialog, NewFolderDialog } from "./NewFolderDialog"
import { ShareDialog } from "./ShareDialog"
import { batchLimit, capRefusal, isFull, uploadFailure } from "./uploadErrors"
import { useFiles, type FilePlace, type TrailStep, type Usage } from "./useFiles"

type View = "list" | "grid"
type SortChoice = "name-asc" | "name-desc" | "updated-desc" | "updated-asc" | "size-desc" | "size-asc"
type OwnerFilter = "any" | "me" | "others"
type DateFilter = "any" | "today" | "week" | "month" | "year"

const VIEW_KEY = "nerla-files-view"
const VIEWS: readonly View[] = ["list", "grid"]

const SORTS: { value: SortChoice; label: string }[] = [
  { value: "name-asc", label: "Name A to Z" },
  { value: "name-desc", label: "Name Z to A" },
  { value: "updated-desc", label: "Newest first" },
  { value: "updated-asc", label: "Oldest first" },
  { value: "size-desc", label: "Largest first" },
  { value: "size-asc", label: "Smallest first" },
]
const TYPES: { value: TypeGroup | "any"; label: string }[] = [
  { value: "any", label: "Any type" },
  { value: "image", label: "Images" },
  { value: "document", label: "Documents" },
  { value: "pdf", label: "PDFs" },
  { value: "video", label: "Video" },
  { value: "paper", label: "Papers" },
  { value: "board", label: "Boards" },
]
const OWNERS: { value: OwnerFilter; label: string }[] = [
  { value: "any", label: "Anyone" },
  { value: "me", label: "Me" },
  { value: "others", label: "Others" },
]
const DATES: { value: DateFilter; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "Last 30 days" },
  { value: "year", label: "This year" },
]

const SECTION_LABELS = { mine: "My files", shared: "Shared with me", recent: "Recent" } as const
const WIDE_QUERY = "(min-width: 40rem)"

const EMPTY_TEXT = {
  mine: "No files yet. Upload one or drop it here.",
  shared: "Files people post in your chats and projects show up here.",
  recent: "Files you add or change show up here.",
  project: "No project files yet. Upload one or drop it here.",
} as const

const DAY_MS = 86_400_000

function sinceOf(filter: DateFilter, now = new Date()): Date | null {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (filter === "today") return day
  if (filter === "week") return new Date(day.getTime() - 6 * DAY_MS)
  if (filter === "month") return new Date(day.getTime() - 29 * DAY_MS)
  if (filter === "year") return new Date(now.getFullYear(), 0, 1)
  return null
}

const resultCount = (count: number, within: string | null) =>
  `${count} ${count === 1 ? "result" : "results"} ${within ? `in ${within}` : "across Files"}`

function Placeholder({
  art,
  text,
  action,
  onAction,
  role,
}: {
  art?: ReactNode
  text: string
  action?: string
  onAction?: () => void
  role?: "alert"
}) {
  return (
    <div role={role} className="flex flex-col items-center gap-3 rounded-xl px-4 py-12 text-center ring-[0.0625rem] ring-border">
      {art}
      <p className="max-w-[26rem] text-body text-muted-foreground">{text}</p>
      {action && onAction && (
        <Button type="button" variant="outline" size="sm" onClick={onAction}>
          {action}
        </Button>
      )}
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg bg-card ring-[0.0625rem] ring-border">
      <span role="status" className="sr-only">
        Loading files
      </span>
      <div aria-hidden="true">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="flex items-center gap-3 border-b-[0.0625rem] border-border px-3 py-2.5 last:border-b-0">
            <Skeleton className="size-[1.75rem] rounded-md" />
            <Skeleton className="h-[0.9rem] w-[14rem] max-w-[50%]" />
            <Skeleton className="ml-auto h-[0.75rem] w-[5rem] max-sm:hidden" />
          </div>
        ))}
      </div>
    </div>
  )
}

function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger aria-label={label} className={cn("w-auto gap-2 border-transparent bg-app-sunk font-medium", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function SheetField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span aria-hidden="true" className="text-ui font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

type FileBrowserProps = {
  place: FilePlace
  /** The name of the section's root: "My files", a project's name */
  rootLabel: string
  /** Opens a folder of this place, or with `target` a folder somewhere else, such as one found by search */
  onOpenFolder: (folderId: string | null, target?: FilePlace) => void
  /** Inside a page that has its own title, such as a project */
  embedded?: boolean
  onUsage?: (usage: Usage) => void
  /** Shown before the toolbar on phones, such as the section switcher */
  phoneNav?: ReactNode
  /** Look only, as a workspace admin outside the project: no uploads, folders or search */
  readOnly?: boolean
  /** Starts a search, such as Show more in the command menu. A new object searches again */
  searchFor?: { q: string } | null
}

export function FileBrowser({
  place,
  rootLabel,
  onOpenFolder,
  embedded = false,
  onUsage,
  phoneNav,
  readOnly = false,
  searchFor = null,
}: FileBrowserProps) {
  const desktop = useIsDesktop()
  const navigate = useNavigate()
  const { user } = useAuth()
  const me = user?.id ?? null
  // Accounts are per workspace, so the account role is the workspace role
  const workspaceAdmin = user?.role === "admin"
  const [view, setView] = useState<View>(() => readViewPreference(VIEW_KEY, "list", VIEWS))
  const [sort, setSort] = useState<SortChoice>("name-asc")
  const [query, setQuery] = useState("")
  const [type, setType] = useState<TypeGroup | "any">("any")
  const [owner, setOwner] = useState<OwnerFilter>("any")
  const [date, setDate] = useState<DateFilter>("any")
  const [hint, setHint] = useState<{ id: string; trail: TrailStep[] } | null>(null)
  const [preview, setPreview] = useState<PreviewFile | null>(null)
  const [renaming, setRenaming] = useState<RowItem | null>(null)
  const [moving, setMoving] = useState<RowItem | null>(null)
  const [describing, setDescribing] = useState<FileItem | null>(null)
  const [sharing, setSharing] = useState<RowItem | null>(null)
  const [linking, setLinking] = useState<RowItem | null>(null)
  const [deletingForGood, setDeletingForGood] = useState<FileItem | null>(null)
  const [creating, setCreating] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const newButton = useRef<HTMLButtonElement>(null)
  const fabButton = useRef<HTMLButtonElement>(null)
  const [dropping, setDropping] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const wide = useMediaQuery(WIDE_QUERY)
  const filtersButton = useRef<HTMLButtonElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const searchBox = useRef<HTMLInputElement>(null)

  const { section } = place
  // A search belongs to the place it was typed in, so moving anywhere else drops it
  const placeId = `${section}:${place.projectId ?? ""}:${place.folderId ?? ""}`
  const [searchedIn, setSearchedIn] = useState(placeId)
  if (searchedIn !== placeId) {
    // Filters belong to the section, so they stay while folders open inside it
    if (searchedIn.split(":").slice(0, 2).join(":") !== placeId.split(":").slice(0, 2).join(":")) {
      setType("any")
      setOwner("any")
      setDate("any")
    }
    setSearchedIn(placeId)
    if (query) setQuery("")
  }
  useEffect(() => {
    if (searchFor) setQuery(searchFor.q)
  }, [searchFor])
  const canUpload = !readOnly && (section === "mine" || section === "project" || section === "recent")
  const canCreateFolder = !readOnly && (section === "mine" || section === "project")
  // Search never reaches into a project the viewer is not a member of
  const searchable = !readOnly
  const [sortKey, dir] = sort.split("-") as [FileSort, "asc" | "desc"]

  const q = query.trim()
  const since = sinceOf(date)
  const filterCount = [type, owner, date].filter((value) => value !== "any").length
  const filtersOn = filterCount > 0
  // A name or any filter searches on the server, inside the open folder or project when there is one
  const limited = section === "project" || !!place.folderId
  const search: FileSearchQuery | null =
    (q || filtersOn) && searchable
      ? {
          q: q || undefined,
          type: type === "any" ? undefined : type,
          owner: owner === "any" ? undefined : owner,
          after: since ? since.toISOString() : undefined,
          projectId: section === "project" ? (place.projectId ?? undefined) : undefined,
          folderId: place.folderId ?? undefined,
        }
      : null
  const files = useFiles(place, { sort: sortKey, dir, search })
  const { refresh, update } = files

  useEffect(() => {
    if (files.usage) onUsage?.(files.usage)
  }, [files.usage, onUsage])

  // Until the server's trail arrives, a folder opened from a row already knows its name and the path above it
  const shownTrail: TrailStep[] =
    files.status === "ready" || files.status === "error" ? files.trail : hint && hint.id === place.folderId ? hint.trail : []
  const trail = place.folderId ? shownTrail : []
  const title = place.folderId ? (trail.at(-1)?.name ?? "Folder") : section === "project" ? rootLabel : SECTION_LABELS[section]
  const crumbs = place.folderId ? [{ id: null, name: rootLabel }, ...trail.slice(0, -1)] : []
  const openCrumb = (id: string | null) => {
    const at = trail.findIndex((step) => step.id === id)
    setHint(id && at >= 0 ? { id, trail: trail.slice(0, at + 1) } : null)
    onOpenFolder(id)
  }
  const here = place.folderId ? title : section === "recent" ? "My files" : rootLabel

  // Inside a page of its own the window is named after the open folder
  useEffect(() => {
    if (!embedded) document.title = [title, "Files", "Nerla"].join(" · ")
  }, [embedded, title])

  const removeRow = useCallback(
    (row: RowItem) =>
      update(({ folders, files: list }) =>
        row.kind === "file"
          ? { folders, files: list.filter((file) => file.id !== row.item.id) }
          : { folders: folders.filter((folder) => folder.id !== row.item.id), files: list },
      ),
    [update],
  )

  const replaceRow = useCallback(
    (row: RowItem) =>
      update(({ folders, files: list }) =>
        row.kind === "file"
          ? { folders, files: list.map((file) => (file.id === row.item.id ? row.item : file)) }
          : { folders: folders.map((folder) => (folder.id === row.item.id ? { ...folder, ...row.item } : folder)), files: list },
      ),
    [update],
  )

  const upload = async (list: File[]) => {
    if (!canUpload || list.length === 0) return
    const target = {
      purpose: "file" as const,
      projectId: section === "project" ? place.projectId : null,
      folderId: section === "recent" ? null : place.folderId,
    }
    const toastId = toast.loading(list.length === 1 ? `Uploading ${list[0].name}` : `Uploading ${list.length} files`)
    const limit = batchLimit()
    let done = 0
    for (const file of list) {
      // The toast moves in quarters, so a screen reader hears a few steps and not every percent
      let quarter = 0
      try {
        await filesAPI.uploadFile(file, {
          ...target,
          onProgress: (fraction) => {
            const next = Math.floor(Math.min(1, fraction) * 4)
            if (next === quarter) return
            quarter = next
            toast.loading(`Uploading ${file.name}, ${next * 25}%`, { id: toastId })
          },
        })
        done += 1
      } catch (err) {
        const message = await uploadFailure(err, file, limit)
        toast.error(message, { description: file.name })
        // A full storage refuses the rest too
        if (isFull(message)) break
      }
    }
    if (done > 0) {
      toast.success(done === 1 ? "File uploaded" : `${done} files uploaded`, { id: toastId })
      refresh()
    } else toast.dismiss(toastId)
  }

  const run = async (work: () => Promise<void>, failed: string) => {
    try {
      await work()
    } catch (err) {
      toast.error(capRefusal(err) ?? messageOf(err, failed))
    }
  }

  const moveRow = async (row: RowItem, folderId: string | null) => {
    if (row.kind === "file") await fileBrowserAPI.updateFile(row.item.id, { folderId })
    else await fileBrowserAPI.updateFolder(row.item.id, { parentId: folderId })
    if (folderId !== (place.folderId ?? null)) removeRow(row)
    toast.success(`Moved ${row.item.name}`)
  }

  const dropItem = (item: DraggedItem, folderId: string | null) => {
    const row: RowItem | undefined =
      item.kind === "file"
        ? (() => {
            const file = files.files.find((f) => f.id === item.id)
            return file && { kind: "file" as const, item: file }
          })()
        : (() => {
            const folder = files.folders.find((f) => f.id === item.id)
            return folder && { kind: "folder" as const, item: folder }
          })()
    if (!row || !row.item.can.includes("move") || row.item.id === folderId) return
    void run(() => moveRow(row, folderId), "Couldn't move it. Try again.")
  }

  const restore = async (row: RowItem) => {
    if (row.kind === "file") await fileBrowserAPI.restoreFile(row.item.id)
    else await fileBrowserAPI.restoreFolder(row.item.id)
  }

  const actions: FileActions = {
    open: (row) => {
      if (row.kind === "folder") {
        const folder = row.item
        if (search) {
          // A folder found by search opens in its own place, with the search and filters cleared
          setQuery("")
          clearFilters()
          setHint({ id: folder.id, trail: [{ id: folder.id, name: folder.name, color: folder.color }] })
          const target: FilePlace = folder.projectId
            ? { section: "project", projectId: folder.projectId, folderId: folder.id }
            : { section: folder.can.includes("rename") ? "mine" : "shared", folderId: folder.id }
          onOpenFolder(folder.id, target)
          return
        }
        setHint({ id: folder.id, trail: [...trail, { id: folder.id, name: folder.name, color: folder.color }] })
        onOpenFolder(folder.id)
        return
      }
      const file = row.item
      const route = docRoute(file)
      if (route) return void navigate(route)
      setPreview({ id: file.id, name: file.name, size: file.size, mimeType: file.mimeType, altText: file.altText })
    },
    download: (file) => void run(() => downloadAttachment({ id: file.id, file_name: file.name }), "Couldn't download the file."),
    rename: setRenaming,
    move: setMoving,
    copy: (file) =>
      void run(async () => {
        await fileBrowserAPI.copyFile(file.id)
        toast.success(`Saved ${file.name} to My files`)
        if (section === "mine" && !place.folderId) refresh()
      }, "Couldn't save the file. Try again."),
    describe: setDescribing,
    trash: (row) =>
      void run(async () => {
        if (row.kind === "file") await fileBrowserAPI.trashFile(row.item.id)
        else await fileBrowserAPI.trashFolder(row.item.id)
        removeRow(row)
        toast.success(`Moved ${row.item.name} to the trash`, {
          action: {
            label: "Undo",
            onClick: () =>
              void run(async () => {
                await restore(row)
                refresh()
              }, "Couldn't restore it. Try again."),
          },
        })
      }, "Couldn't delete it. Try again."),
    onShare: setSharing,
    onLink: setLinking,
    onManageLinks: workspaceAdmin ? setLinking : undefined,
    onDeleteForGood: workspaceAdmin ? setDeletingForGood : undefined,
  }

  const startUpload = () => picker.current?.click()
  const startFolder = () => setCreating(true)
  // A paper or board made in Recent goes to My files, like an upload there
  const startDoc = (docType: DocType) =>
    void run(
      async () => {
        const file = await papersAPI.create({
          docType,
          projectId: section === "project" ? place.projectId : null,
          folderId: section === "recent" ? null : place.folderId,
        })
        navigate(`/${docType}/${file.id}`)
      },
      docType === "paper" ? "Couldn't make the paper. Try again." : "Couldn't make the board. Try again.",
    )

  const newEntries: MenuEntry[] = []
  if (canCreateFolder) newEntries.push({ label: "Folder", Icon: FolderPlus, run: startFolder })
  if (canUpload) {
    newEntries.push({ label: "Paper", Icon: Paper, run: () => startDoc("paper") })
    newEntries.push({ label: "Board", Icon: Board, run: () => startDoc("board") })
    newEntries.push({ label: "Upload", Icon: Upload, run: startUpload, shortcut: "u" })
  }
  const canCreate = newEntries.length > 0

  const keys = useRef({ startUpload, canUpload, canCreate, searchable })
  keys.current = { startUpload, canUpload, canCreate, searchable }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || shouldIgnoreKey(event)) return
      const key = event.key.toLowerCase()
      if (key === "u" && keys.current.canUpload) {
        event.preventDefault()
        keys.current.startUpload()
      } else if (key === "c" && keys.current.canCreate) {
        event.preventDefault()
        setNewOpen(true)
      } else if (key === "/" && keys.current.searchable) {
        event.preventDefault()
        searchBox.current?.focus()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const dragDepth = useRef(0)
  const dropZone = canUpload
    ? {
        onDragEnter: (event: DragEvent) => {
          if (!carriesFiles(event)) return
          dragDepth.current += 1
          setDropping(true)
        },
        onDragOver: (event: DragEvent) => {
          if (!carriesFiles(event)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
        },
        onDragLeave: (event: DragEvent) => {
          if (!carriesFiles(event)) return
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDropping(false)
        },
        onDrop: (event: DragEvent) => {
          if (!carriesFiles(event)) return
          event.preventDefault()
          dragDepth.current = 0
          setDropping(false)
          void upload(Array.from(event.dataTransfer.files))
        },
      }
    : {}

  const effectiveView: View = desktop ? view : "list"
  const changeView = (next: View) => {
    setView(next)
    saveViewPreference(VIEW_KEY, next)
  }

  const clearFilters = () => {
    setType("any")
    setOwner("any")
    setDate("any")
  }

  // On a phone the Files page's New is the floating button, so no other New competes with it
  const fab = !desktop && canCreate && !embedded
  // Inside a project, New task is the page's primary, so New steps down to sky
  const newMenuButton = canCreate && !fab && (
    <Button
      ref={newButton}
      type="button"
      variant={embedded ? "sky" : "default"}
      shortcut="C"
      aria-haspopup="menu"
      aria-expanded={newOpen}
      onClick={() => setNewOpen((open) => !open)}
    >
      New
    </Button>
  )

  const listSection = search ? "recent" : section
  const empty = files.files.length === 0 && files.folders.length === 0
  let content: ReactNode
  if (files.status === "loading") content = <ListSkeleton />
  else if (files.status === "missing")
    content = (
      <NotFoundView heading="h2" title="This folder wandered off" text="It may be in the trash, or you no longer have access.">
        <Button type="button" variant="outline" size="sm" onClick={() => onOpenFolder(null)}>
          {`Back to ${rootLabel}`}
        </Button>
      </NotFoundView>
    )
  else if (files.status === "error" && empty)
    content = <Placeholder role="alert" text={files.error ?? "Couldn't load files."} action="Try again" onAction={refresh} />
  else if (empty)
    content =
      q && search ? (
        <Placeholder art={<CatSearching />} text={`Nothing found for “${q}”`} />
      ) : search ? (
        <Placeholder text="No files match these filters." action="Clear filters" onAction={clearFilters} />
      ) : (
        <Placeholder
          art={place.folderId || section === "project" ? <CatInFolder /> : undefined}
          text={place.folderId ? "This folder is empty" : readOnly ? "No project files yet." : EMPTY_TEXT[section]}
          action={canUpload && !fab ? "Upload" : undefined}
          onAction={startUpload}
        />
      )
  else {
    const props = { folders: files.folders, files: files.files, section: listSection, me, actions, onDropItem: dropItem }
    content = (
      <div className="flex flex-col gap-3">
        {effectiveView === "grid" ? <FileGrid {...props} /> : <FileList {...props} />}
        {files.hasMore && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={files.loadMore}
            disabled={files.loadingMore}
            aria-busy={files.loadingMore || undefined}
            className="self-center"
          >
            {files.loadingMore ? "Loading" : "Show more"}
          </Button>
        )}
      </div>
    )
  }

  const placeKey = `${section}:${place.projectId ?? ""}:${place.folderId ?? ""}:${search ? "search" : ""}`

  return (
    <div {...dropZone} className="relative flex min-w-0 flex-col gap-3.5">
      {!embedded && (
        <div className="flex flex-col gap-1">
          {crumbs.length > 0 && <Breadcrumbs crumbs={crumbs} onOpen={openCrumb} onDropItem={dropItem} />}
          <PageHeader titleRef={heading} title={<span className="min-w-0 truncate">{title}</span>} actions={newMenuButton} />
        </div>
      )}
      {!embedded && <FirstTip id="files" />}
      {fab && (
        <CreateFab
          ref={fabButton}
          label="New"
          shortcut="n"
          aria-haspopup="menu"
          aria-expanded={newOpen}
          onClick={() => setNewOpen((open) => !open)}
        />
      )}
      <MenuPopover
        open={newOpen && canCreate}
        onOpenChange={setNewOpen}
        anchor={() => (fab ? fabButton.current : newButton.current)}
        label="New"
        entries={newEntries}
        widthRem={11}
      />
      {phoneNav}
      {embedded && crumbs.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-0.5">
          <Breadcrumbs crumbs={crumbs} onOpen={openCrumb} onDropItem={dropItem} />
          <span className="truncate px-1.5 text-body font-semibold text-foreground">{title}</span>
        </div>
      )}

      {embedded && !wide && newMenuButton && <div className="flex items-center gap-2">{newMenuButton}</div>}
      <div className={cn("flex items-center gap-2", wide && "flex-wrap")}>
        {searchable && (
          <label className="relative flex min-w-0 flex-1 items-center sm:max-w-[20rem] sm:min-w-[12rem]">
            <span className="sr-only">Search files</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 size-[0.95rem] text-muted-foreground" />
            <input
              ref={searchBox}
              type="search"
              value={query}
              placeholder="Search files"
              aria-keyshortcuts="/"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault()
                  setQuery("")
                }
              }}
              className="h-8 w-full rounded-md bg-app-sunk pr-8 pl-8 text-ui text-foreground placeholder:text-muted-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:h-11 max-lg:pr-11 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("")
                  searchBox.current?.focus()
                }}
                className="absolute right-1 flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:right-0 max-lg:size-11"
              >
                <X aria-hidden="true" className="size-[0.85rem]" />
              </button>
            )}
          </label>
        )}
        {wide ? (
          <>
            {searchable && (
              <>
                <FilterSelect label="Type" value={type} options={TYPES} onChange={setType} />
                <FilterSelect label="Owner" value={owner} options={OWNERS} onChange={setOwner} />
                <FilterSelect label="Updated" value={date} options={DATES} onChange={setDate} />
              </>
            )}
            {!search && <FilterSelect label="Sort" value={sort} options={SORTS} onChange={setSort} />}
          </>
        ) : (
          <Button
            ref={filtersButton}
            type="button"
            variant="secondary"
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen(true)}
            className={cn("shrink-0", !searchable && "ml-auto")}
          >
            <Sort aria-hidden="true" className="size-[1rem]" />
            {searchable ? "Filters" : "Sort"}
            {filterCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-app-pistachio px-1.5 text-micro font-semibold text-app-pistachio-ink tabular-nums">
                <span className="sr-only">, </span>
                {filterCount}
                <span className="sr-only"> on</span>
              </span>
            )}
          </Button>
        )}
        {desktop && (
          <SegmentedControl
            label="Layout"
            value={view}
            onChange={changeView}
            iconOnly={embedded}
            className="ml-auto"
            options={[
              { value: "list", label: "List", icon: <List aria-hidden="true" className="size-[0.95rem]" /> },
              { value: "grid", label: "Grid", icon: <Grid aria-hidden="true" className="size-[0.95rem]" /> },
            ]}
          />
        )}
        {embedded && wide && newMenuButton && <div className={cn("flex items-center gap-2", !desktop && "ml-auto")}>{newMenuButton}</div>}
      </div>

      {!wide && (
        <BottomSheet
          open={filtersOpen}
          onOpenChange={setFiltersOpen}
          title={searchable ? "Filters" : "Sort"}
          showTitle
          returnFocus={() => filtersButton.current?.focus()}
        >
          <div className="flex flex-col gap-3 px-2 pb-2">
            {searchable && (
              <>
                <SheetField label="Type">
                  <FilterSelect label="Type" value={type} options={TYPES} onChange={setType} className="w-full" />
                </SheetField>
                <SheetField label="Person">
                  <FilterSelect label="Person" value={owner} options={OWNERS} onChange={setOwner} className="w-full" />
                </SheetField>
                <SheetField label="Time">
                  <FilterSelect label="Time" value={date} options={DATES} onChange={setDate} className="w-full" />
                </SheetField>
              </>
            )}
            {!search && (
              <SheetField label="Sort">
                <FilterSelect label="Sort" value={sort} options={SORTS} onChange={setSort} className="w-full" />
              </SheetField>
            )}
            <div className="flex gap-2 pt-1">
              {searchable && (
                <Button type="button" variant="ghost" onClick={clearFilters} disabled={!filtersOn}>
                  Clear filters
                </Button>
              )}
              <Button type="button" className="flex-1" onClick={() => setFiltersOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        </BottomSheet>
      )}

      {search && (
        <p aria-live="polite" className="text-ui text-muted-foreground">
          {files.status === "ready" ? resultCount(files.files.length + files.folders.length, limited ? here : null) : "Searching"}
          {filtersOn && !limited && <span className="block">Filters search all your files</span>}
        </p>
      )}
      {files.status === "error" && !empty && (
        <div role="alert" className="flex items-center gap-2.5 rounded-lg border-[0.0625rem] border-border bg-card py-1 pr-1 pl-3 text-ui">
          <Warning aria-hidden="true" weight="fill" className="size-[1rem] shrink-0 text-app-berry" />
          <span className="min-w-0 flex-1 text-app-berry-text">{files.error}</span>
          <Button type="button" variant="ghost" size="sm" onClick={refresh}>
            Try again
          </Button>
        </div>
      )}

      <div key={placeKey} className="motion-panel animate-in fade-in-0 motion-safe:slide-in-from-bottom-1">
        {content}
      </div>

      {dropping && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-2 z-20 flex items-center justify-center rounded-xl bg-app-sky-soft/90 text-app-sky-ink ring-[0.125rem] ring-app-sky-strong"
        >
          <span className="flex flex-col items-center gap-2 text-body font-medium">
            <DropUpload aria-hidden="true" className="size-[2rem]" />
            Drop to upload to {here}
          </span>
        </div>
      )}

      <input
        ref={picker}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const chosen = Array.from(event.target.files ?? [])
          event.target.value = ""
          void upload(chosen)
        }}
      />

      <FilePreviewDialog file={preview} onClose={() => setPreview(null)} onMissing={refresh} />
      <NewFolderDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreate={async (name, color, icon) => {
          await fileBrowserAPI.createFolder({
            name,
            color,
            icon,
            parentId: place.folderId ?? null,
            projectId: section === "project" ? place.projectId : null,
          })
          refresh()
        }}
      />
      <NameDialog
        open={renaming?.kind === "file"}
        title="Rename file"
        label="Name"
        initial={renaming?.kind === "file" ? renaming.item.name : ""}
        selectStem
        saveLabel="Rename"
        failed="Couldn't rename it. Try again."
        onClose={() => setRenaming(null)}
        onSave={async (name) => {
          if (renaming?.kind === "file") replaceRow({ kind: "file", item: await fileBrowserAPI.updateFile(renaming.item.id, { name }) })
        }}
      />
      <EditFolderDialog
        folder={renaming?.kind === "folder" ? renaming.item : null}
        onClose={() => setRenaming(null)}
        onSave={async (folder, name, color, icon) => {
          replaceRow({ kind: "folder", item: await fileBrowserAPI.updateFolder(folder.id, { name, color, icon }) })
        }}
      />
      <MoveDialog
        row={moving}
        rootLabel={moving?.item.projectId ? (section === "project" ? rootLabel : "Project files") : "My files"}
        onMove={moveRow}
        onClose={() => setMoving(null)}
        fallbackFocus={() => heading.current}
      />
      <AltTextDialog file={describing} onClose={() => setDescribing(null)} onSaved={(file) => replaceRow({ kind: "file", item: file })} />
      <ConfirmDialog
        open={deletingForGood !== null}
        title="Delete forever?"
        confirmLabel="Delete forever"
        busyLabel="Deleting"
        failed="Couldn't delete it. Try again."
        onClose={() => setDeletingForGood(null)}
        fallbackFocus={() => heading.current}
        onConfirm={async () => {
          if (!deletingForGood) return
          await fileSharingAPI.deleteForGood(deletingForGood.id)
          removeRow({ kind: "file", item: deletingForGood })
          toast.success("File deleted")
        }}
      >
        <span className="font-semibold text-foreground">{deletingForGood?.name}</span> will be deleted forever, and its owner loses it. This
        can't be undone.
      </ConfirmDialog>
      <ShareDialog row={sharing} onClose={() => setSharing(null)} />
      <LinkDialog row={linking} onClose={() => setLinking(null)} />
    </div>
  )
}

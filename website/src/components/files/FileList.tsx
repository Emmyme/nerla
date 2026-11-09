import { useState, type DragEvent, type ReactNode } from "react"
import { Link } from "react-router"
import { markedVia } from "@/components/ai/via"
import { ViaMark } from "@/components/ai/ViaMark"
import { fileIcon, KIND_ICONS } from "@/components/tasks/AttachmentPreview"
import type { FileItem, FileSection, FolderItem } from "@/lib/api/files"
import { formatLongDate, formatShortDate } from "@/lib/dates"
import { cn } from "@/lib/utils"
import { carriesItem, droppedItem, startDrag, type DraggedItem } from "./fileDrag"
import { fileKind, formatFileSize, type AttachmentKind } from "./fileKinds"
import { FileRowMenu, type FileActions, type RowItem } from "./FileRowMenu"
import { FolderMark } from "./FolderGlyph"

export type ListProps = {
  folders: FolderItem[]
  files: FileItem[]
  section: FileSection
  me: string | null
  actions: FileActions
  onDropItem?: (item: DraggedItem, folderId: string | null) => void
}

/** The soft fill of each kind, shared by list glyphs, grid tiles and the admin's file rows */
export const TONES: Record<AttachmentKind, string> = {
  image: "bg-app-pistachio-soft text-app-pistachio-ink",
  pdf: "bg-app-bubblegum-soft text-app-bubblegum-ink",
  video: "bg-app-lavender-soft text-app-lavender-ink",
  audio: "bg-app-lemon-soft text-app-lemon-ink",
  file: "bg-app-sunk text-muted-foreground",
  paper: "bg-app-sky-soft text-app-sky-ink",
  board: "bg-app-pistachio-soft text-app-pistachio-ink",
}

type Named = Pick<FileItem, "name" | "mimeType">

export const kindOf = (file: Named): AttachmentKind => fileKind(file)

export function FileGlyph({ file, className }: { file: Named; className?: string }) {
  const kind = kindOf(file)
  const Icon = fileIcon(file.name, kind)
  return (
    <span aria-hidden="true" className={cn("flex size-[1.75rem] shrink-0 items-center justify-center rounded-md", TONES[kind], className)}>
      <Icon className="size-[1rem]" />
    </span>
  )
}

/** A kind's glyph where the name is not shown, as on the admin's storage view */
export function KindGlyph({ kind, className }: { kind: AttachmentKind; className?: string }) {
  const Icon = KIND_ICONS[kind]
  return (
    <span aria-hidden="true" className={cn("flex size-[1.75rem] shrink-0 items-center justify-center rounded-md", TONES[kind], className)}>
      <Icon className="size-[1rem]" />
    </span>
  )
}

/** "From a removed member, deleted on 30 November 2026", for a file whose owner has left */
export function removalNote(file: FileItem): string | null {
  return file.removalDeadline && !file.deletedAt ? `From a removed member, deleted on ${formatLongDate(file.removalDeadline)}` : null
}

/** "1 item" or "4 items", and "Empty" for a folder with nothing the user can see in it */
export const itemCountLabel = (count: number) => (count === 0 ? "Empty" : count === 1 ? "1 item" : `${count} items`)

/** A folder's size for the Size column, "Empty" when it holds nothing, or blank where the reply carries none */
const folderSize = (folder: FolderItem) =>
  folder.itemCount === undefined ? "" : folder.itemCount === 0 ? "Empty" : formatFileSize(folder.size ?? 0)

export const ownerName = (file: FileItem, me: string | null) => (file.owner.id === me ? "You" : file.owner.name)

/** The mark by the owner of a paper or board their AI or agent created */
function CreatedMark({ file }: { file: FileItem }) {
  return markedVia(file.done_via) ? (
    <ViaMark via={file.done_via} personName={file.owner.name} verb="Created" className="relative z-10" />
  ) : null
}

/** A name with the created mark beside it */
export function WithMark({ file, children, className }: { file: FileItem; children: ReactNode; className?: string }) {
  if (!markedVia(file.done_via)) return <>{children}</>
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      <span className="min-w-0 truncate">{children}</span>
      <CreatedMark file={file} />
    </span>
  )
}

/** Where a shared file reached the user, linking back to that chat, task or project */
export function ContextLink({ context }: { context: NonNullable<FileItem["context"]> }) {
  return (
    <Link
      to={context.href}
      className="relative z-10 truncate rounded-sm text-caption text-muted-foreground underline-offset-[0.2em] hover:text-foreground hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
    >
      {context.where}
    </Link>
  )
}

/** Drag a row onto a folder to move it there */
export function useFolderDrop(folderId: string, onDropItem?: (item: DraggedItem, folderId: string | null) => void) {
  const [over, setOver] = useState(false)
  if (!onDropItem) return { over: false, props: {} }
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!carriesItem(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "move"
        setOver(true)
      },
      onDragLeave: (event: DragEvent) => {
        if (!(event.currentTarget as Node).contains(event.relatedTarget as Node | null)) setOver(false)
      },
      onDrop: (event: DragEvent) => {
        setOver(false)
        const item = droppedItem(event)
        if (!item || item.id === folderId) return
        event.preventDefault()
        event.stopPropagation()
        onDropItem(item, folderId)
      },
    },
  }
}

export function dragProps(row: RowItem) {
  if (!row.item.can.includes("move")) return {}
  return { draggable: true, onDragStart: (event: DragEvent) => startDrag(event, { kind: row.kind, id: row.item.id }) }
}

const COLUMNS = "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_minmax(8rem,13rem)_7rem_5rem_2rem]"
const ROW =
  "group relative grid items-center gap-x-3 px-3 py-1.5 transition-colors duration-150 hover:bg-app-hover has-[[data-open]:focus-visible]:bg-app-hover max-sm:py-2"
const OPEN =
  "min-w-0 cursor-pointer truncate rounded-sm text-left text-ui font-medium text-foreground outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-md focus-visible:after:ring-[0.125rem] focus-visible:after:ring-inset focus-visible:after:ring-ring"

function Cells({
  glyph,
  name,
  label,
  open,
  note,
  from,
  date,
  size,
  menu,
  phoneMeta,
  labels,
}: {
  glyph: ReactNode
  name: ReactNode
  label?: string
  open: () => void
  note?: string | null
  from: ReactNode
  date: string
  size: string
  menu: ReactNode
  phoneMeta: string
  /** The column names, read before each cell since the header row is hidden from screen readers */
  labels: { from: string; date: string }
}) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-2.5">
        {glyph}
        <span className="flex min-w-0 flex-col">
          <button type="button" data-open="" aria-label={label} onClick={open} className={OPEN}>
            {name}
          </button>
          {note && <span className="truncate text-caption text-app-berry-text">{note}</span>}
          <span className="truncate text-caption text-muted-foreground sm:hidden">{phoneMeta}</span>
        </span>
      </span>
      <span className="min-w-0 truncate text-ui text-muted-foreground max-sm:hidden">
        {from && <span className="sr-only">{labels.from}: </span>}
        {from}
      </span>
      <span className="text-ui text-muted-foreground tabular-nums max-sm:hidden">
        <span className="sr-only">{labels.date}: </span>
        {date}
      </span>
      <span className="text-right text-ui text-muted-foreground tabular-nums max-sm:hidden">
        {size && <span className="sr-only">Size: </span>}
        {size}
      </span>
      <span className="flex justify-end">{menu}</span>
    </>
  )
}

function FolderRow({
  folder,
  section,
  actions,
  onDropItem,
  labels,
}: { folder: FolderItem; labels: { from: string; date: string } } & Pick<ListProps, "section" | "actions" | "onDropItem">) {
  const row: RowItem = { kind: "folder", item: folder }
  const drop = useFolderDrop(folder.id, onDropItem)
  const date = formatShortDate(folder.updatedAt)
  const size = folderSize(folder)
  // Folders carry no owner, and every folder in My files is the user's own
  const owner = section === "mine" ? "You" : ""
  return (
    <li {...dragProps(row)} {...drop.props} className={cn(ROW, COLUMNS, drop.over && "bg-app-sky-soft hover:bg-app-sky-soft")}>
      <Cells
        glyph={<FolderMark color={folder.color} />}
        name={folder.name}
        label={`${folder.name}, folder`}
        open={() => actions.open(row)}
        from={owner}
        date={date}
        size={size}
        phoneMeta={size ? `Folder · ${date} · ${size}` : `Folder · ${date}`}
        labels={labels}
        menu={<FileRowMenu row={row} actions={actions} />}
      />
    </li>
  )
}

function FileRow({
  file,
  section,
  me,
  actions,
  labels,
}: { file: FileItem; labels: { from: string; date: string } } & Pick<ListProps, "section" | "me" | "actions">) {
  const row: RowItem = { kind: "file", item: file }
  const date = formatShortDate(file.updatedAt)
  const owner = ownerName(file, me)
  const from =
    section === "shared" && file.context ? (
      <span className="flex min-w-0 flex-col leading-tight">
        <WithMark file={file}>
          <span className="truncate text-foreground">{file.context.by}</span>
        </WithMark>
        <ContextLink context={file.context} />
      </span>
    ) : (
      <WithMark file={file}>{owner}</WithMark>
    )
  const where = section === "shared" && file.context ? `${file.context.by} in ${file.context.where}` : owner
  return (
    <li {...dragProps(row)} className={cn(ROW, COLUMNS)}>
      <Cells
        glyph={<FileGlyph file={file} />}
        name={file.name}
        open={() => actions.open(row)}
        note={removalNote(file)}
        from={from}
        date={date}
        size={formatFileSize(file.size)}
        phoneMeta={`${where} · ${date} · ${formatFileSize(file.size)}`}
        labels={labels}
        menu={<FileRowMenu row={row} actions={actions} />}
      />
    </li>
  )
}

export function FileList({ folders, files, section, me, actions, onDropItem }: ListProps) {
  const fromLabel = section === "shared" ? "From" : "Owner"
  const dateLabel = "Updated"
  const labels = { from: fromLabel, date: dateLabel }
  return (
    <div className="overflow-hidden rounded-lg bg-card ring-[0.0625rem] ring-border">
      <div
        aria-hidden="true"
        className={cn(
          "grid items-center gap-x-3 border-b-[0.0625rem] border-border px-3 py-2 text-caption font-medium text-muted-foreground max-sm:hidden",
          COLUMNS,
        )}
      >
        <span>Name</span>
        <span>{fromLabel}</span>
        <span>{dateLabel}</span>
        <span className="text-right">Size</span>
        <span />
      </div>
      <ul aria-label="Files" className="divide-y-[0.0625rem] divide-border">
        {folders.map((folder) => (
          <FolderRow key={folder.id} folder={folder} section={section} actions={actions} onDropItem={onDropItem} labels={labels} />
        ))}
        {files.map((file) => (
          <FileRow key={file.id} file={file} section={section} me={me} actions={actions} labels={labels} />
        ))}
      </ul>
    </div>
  )
}

import { useEffect, useState } from "react"
import { Ellipsis } from "@/components/icons"
import { fileIcon } from "@/components/tasks/AttachmentPreview"
import type { FileItem, FolderItem } from "@/lib/api/files"
import { leaseBlobUrl } from "@/lib/blobCache"
import { formatShortDate } from "@/lib/dates"
import { useSettledInView } from "@/lib/useInView"
import { cn } from "@/lib/utils"
import { formatFileSize, hasThumbnail } from "./fileKinds"
import {
  ContextLink,
  dragProps,
  itemCountLabel,
  kindOf,
  ownerName,
  removalNote,
  TONES,
  useFolderDrop,
  WithMark,
  type ListProps,
} from "./FileList"
import { FileRowMenu, type RowItem } from "./FileRowMenu"
import { FolderGlyph } from "./FolderGlyph"

const OPEN =
  "cursor-pointer truncate text-left text-ui font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:after:ring-[0.125rem] focus-visible:after:ring-ring"
const RELEASE_MS = 10_000
const TILE =
  "group relative flex min-w-0 flex-col rounded-lg bg-card ring-[0.0625rem] ring-border transition-colors duration-150 hover:bg-app-hover"

/** Loads an image once its tile has settled in view, and lets the cache have it back after a while out of view */
function useVisibleBlob(file: FileItem) {
  const { ref, visible } = useSettledInView<HTMLDivElement>(hasThumbnail(file), RELEASE_MS)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!visible) return
    let active = true
    const lease = leaseBlobUrl(file.id)
    lease.url.then(
      (next) => {
        if (active) setUrl(next)
      },
      () => undefined,
    )
    return () => {
      active = false
      lease.release()
      setUrl(null)
    }
  }, [visible, file.id])

  return { ref, url }
}

function Thumb({ file }: { file: FileItem }) {
  const { ref, url } = useVisibleBlob(file)
  const [broken, setBroken] = useState(false)
  const kind = kindOf(file)
  const Icon = fileIcon(file.name, kind)
  const picture = url && !broken
  return (
    <div
      ref={ref}
      className={cn(
        "relative m-1.5 mb-0 flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md",
        kind === "image" ? "bg-app-sunk" : TONES[kind],
      )}
    >
      {picture ? (
        <img src={url} alt={file.altText || file.name} onError={() => setBroken(true)} className="size-full object-cover" />
      ) : (
        <Icon aria-hidden="true" className={cn("size-[2rem]", kind === "image" && "text-muted-foreground")} />
      )}
    </div>
  )
}

// The whole corner is the menu button, 2.75rem for touch at any width, with the chip inside it
const FOLDER_MENU =
  "absolute right-0 top-0 size-11 items-start justify-end rounded-none bg-transparent p-1 hover:bg-transparent focus-visible:ring-0 aria-expanded:opacity-100 max-lg:size-11 lg:pointer-fine:size-9 lg:pointer-fine:opacity-0 lg:pointer-fine:focus-visible:opacity-100 lg:pointer-fine:group-hover/folder:opacity-100 lg:pointer-fine:group-focus-within/folder:opacity-100 [&:focus-visible>span]:ring-[0.125rem] [&:focus-visible>span]:ring-ring [&:hover>span]:bg-app-hover [&[aria-expanded=true]>span]:bg-app-hover"

function FolderTile({ folder, actions, onDropItem }: { folder: FolderItem } & Pick<ListProps, "actions" | "onDropItem">) {
  const row: RowItem = { kind: "folder", item: folder }
  const drop = useFolderDrop(folder.id, onDropItem)
  return (
    <li
      {...dragProps(row)}
      {...drop.props}
      className={cn(
        "group/folder relative flex min-w-0 flex-col items-center gap-1.5 rounded-lg px-1.5 pt-3 pb-2 transition-colors duration-150 hover:bg-app-hover has-[[aria-expanded=true]]:bg-app-hover has-[[data-open]:focus-visible]:bg-app-hover",
        drop.over && "bg-app-sky-soft hover:bg-app-sky-soft",
      )}
    >
      <FolderGlyph color={folder.color} symbol={folder.icon} className="w-[4.5rem]" />
      <button
        type="button"
        data-open=""
        aria-label={`${folder.name}, folder`}
        title={folder.name}
        onClick={() => actions.open(row)}
        className="line-clamp-2 w-full cursor-pointer text-center text-ui leading-snug font-medium break-words text-foreground outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:after:ring-[0.125rem] focus-visible:after:ring-ring"
      >
        {folder.name}
      </button>
      {folder.itemCount !== undefined && (
        <span className="-mt-1 text-caption text-muted-foreground tabular-nums">{itemCountLabel(folder.itemCount)}</span>
      )}
      <FileRowMenu
        row={row}
        actions={actions}
        className={FOLDER_MENU}
        trigger={
          <span className="flex size-7 items-center justify-center rounded-md bg-card text-foreground shadow-[0_0_0_0.0625rem_var(--color-border)] transition-colors duration-150">
            <Ellipsis aria-hidden="true" weight="bold" className="size-[1rem]" />
          </span>
        }
      />
    </li>
  )
}

function FileTile({ file, section, me, actions }: { file: FileItem } & Pick<ListProps, "section" | "me" | "actions">) {
  const row: RowItem = { kind: "file", item: file }
  const note = removalNote(file)
  const context = section === "shared" ? file.context : null
  const meta = context ? context.by : ownerName(file, me)
  return (
    <li {...dragProps(row)} className={TILE}>
      <Thumb file={file} />
      <div className="flex min-w-0 items-center gap-1 py-1.5 pr-1 pl-2.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <button type="button" onClick={() => actions.open(row)} className={OPEN}>
            {file.name}
          </button>
          <WithMark file={file} className="text-caption text-muted-foreground">
            <span className="truncate text-caption text-muted-foreground tabular-nums">
              {note ?? `${meta} · ${formatShortDate(file.updatedAt)} · ${formatFileSize(file.size)}`}
            </span>
          </WithMark>
          {context && !note && <ContextLink context={context} />}
        </div>
        <FileRowMenu row={row} actions={actions} />
      </div>
    </li>
  )
}

export function FileGrid({ folders, files, section, me, actions, onDropItem }: ListProps) {
  return (
    <div className="flex flex-col gap-4">
      {folders.length > 0 && (
        <section aria-label="Folders" className="flex flex-col gap-2">
          <h2 className="text-caption font-medium text-muted-foreground">Folders</h2>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-1">
            {folders.map((folder) => (
              <FolderTile key={folder.id} folder={folder} actions={actions} onDropItem={onDropItem} />
            ))}
          </ul>
        </section>
      )}
      {files.length > 0 && (
        <section aria-label="Files" className="flex flex-col gap-2">
          {folders.length > 0 && <h2 className="text-caption font-medium text-muted-foreground">Files</h2>}
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
            {files.map((file) => (
              <FileTile key={file.id} file={file} section={section} me={me} actions={actions} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

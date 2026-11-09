import type { ReactNode } from "react"
import { ArrowRight, Copy, Download, Eye, Link, Pencil, Share, TextLeft, Trash } from "@/components/icons"
import type { FileAction, FileItem, FolderItem } from "@/lib/api/files"
import { ActionMenu, type MenuEntry } from "./ActionMenu"
import { fileKind } from "./fileKinds"

export type RowItem = { kind: "file"; item: FileItem } | { kind: "folder"; item: FolderItem }

/** What a row can do. Share, Get link and the admin's entries show only when the page hands them in */
export type FileActions = {
  open: (row: RowItem) => void
  download: (file: FileItem) => void
  rename: (row: RowItem) => void
  move: (row: RowItem) => void
  copy: (file: FileItem) => void
  describe: (file: FileItem) => void
  trash: (row: RowItem) => void
  onShare?: (row: RowItem) => void
  onLink?: (row: RowItem) => void
  /** A workspace admin turning off links on an item they can see but not link */
  onManageLinks?: (row: RowItem) => void
  /** A workspace admin deleting a file they can see but not delete themselves */
  onDeleteForGood?: (file: FileItem) => void
}

export function menuEntries(row: RowItem, actions: FileActions): MenuEntry[] {
  const can = (action: FileAction) => row.item.can.includes(action)
  const file = row.kind === "file" ? row.item : null
  const entries: MenuEntry[] = []
  const add = (when: unknown, entry: MenuEntry) => {
    if (when) entries.push(entry)
  }
  add(can("view"), { label: "Open", Icon: Eye, run: () => actions.open(row) })
  // A paper or board downloads as PDF from its own page
  if (file && !file.docType) add(can("view"), { label: "Download", Icon: Download, run: () => actions.download(file) })
  add(can("rename"), { label: file ? "Rename…" : "Edit folder…", Icon: Pencil, run: () => actions.rename(row) })
  add(can("move"), { label: "Move…", Icon: ArrowRight, run: () => actions.move(row) })
  add(can("share") && actions.onShare, { label: "Share…", Icon: Share, run: () => actions.onShare?.(row) })
  add(can("link") && actions.onLink, { label: "Get link…", Icon: Link, run: () => actions.onLink?.(row) })
  add(!can("link") && actions.onManageLinks, { label: "Links…", Icon: Link, run: () => actions.onManageLinks?.(row) })
  if (file) {
    add(can("copy"), { label: "Save to my files", Icon: Copy, run: () => actions.copy(file) })
    add(fileKind(file) === "image" && can("editAlt"), { label: "Description…", Icon: TextLeft, run: () => actions.describe(file) })
  }
  add(can("trash"), { label: "Delete", Icon: Trash, run: () => actions.trash(row), danger: true })
  if (file)
    add(!can("trash") && actions.onDeleteForGood, {
      label: "Delete forever…",
      Icon: Trash,
      run: () => actions.onDeleteForGood?.(file),
      danger: true,
    })
  return entries
}

/** The ⋯ button on a row and its menu, which lists only what the row's `can` allows */
export function FileRowMenu({
  row,
  actions,
  className,
  trigger,
}: {
  row: RowItem
  actions: FileActions
  className?: string
  trigger?: ReactNode
}) {
  return <ActionMenu label={`Actions for ${row.item.name}`} entries={menuEntries(row, actions)} className={className} trigger={trigger} />
}

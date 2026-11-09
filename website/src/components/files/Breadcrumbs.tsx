import { useState, type DragEvent } from "react"
import { ChevronRight } from "@/components/icons"
import { cn } from "@/lib/utils"
import { carriesItem, droppedItem, type DraggedItem } from "./fileDrag"
import { FolderGlyph } from "./FolderGlyph"

type Crumb = { id: string | null; name: string | null; color?: string | null }

/** The folders above the open one, from the section down. Rows dropped on a crumb move there */
export function Breadcrumbs({
  crumbs,
  onOpen,
  onDropItem,
}: {
  crumbs: Crumb[]
  onOpen: (id: string | null) => void
  onDropItem?: (item: DraggedItem, folderId: string | null) => void
}) {
  const [over, setOver] = useState<number | null>(null)

  const dropProps = (index: number, folderId: string | null) =>
    onDropItem
      ? {
          onDragOver: (event: DragEvent) => {
            if (!carriesItem(event)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = "move"
            setOver(index)
          },
          onDragLeave: () => setOver((current) => (current === index ? null : current)),
          onDrop: (event: DragEvent) => {
            setOver(null)
            const item = droppedItem(event)
            if (!item) return
            event.preventDefault()
            onDropItem(item, folderId)
          },
        }
      : {}

  return (
    <nav aria-label="Breadcrumb" className="-ml-1.5 min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-0.5">
        {crumbs.map((crumb, index) => (
          <li key={crumb.id ?? "root"} className="flex min-w-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => onOpen(crumb.id)}
              {...dropProps(index, crumb.id)}
              className={cn(
                "flex h-8 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-ui font-medium text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:h-11",
                over === index && "bg-app-sky-soft text-app-sky-ink",
              )}
            >
              {crumb.id && <FolderGlyph color={crumb.color} className="w-[1rem]" />}
              <span className="max-w-[12rem] truncate">{crumb.name ?? "Folder"}</span>
            </button>
            <ChevronRight aria-hidden="true" className="size-[0.8rem] shrink-0 text-muted-foreground" />
          </li>
        ))}
      </ol>
    </nav>
  )
}

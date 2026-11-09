import { markedVia } from "@/components/ai/via"
import { ViaMark } from "@/components/ai/ViaMark"
import { ActionMenu, type MenuEntry } from "@/components/files/ActionMenu"
import { FileGlyph, KindGlyph } from "@/components/files/FileList"
import { FolderMark } from "@/components/files/FolderGlyph"
import { Calendar, CheckCircle, Restore, Trash } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { IdentityTile } from "@/components/ui/identity-tile"
import type { TrashItem } from "@/lib/api/trash"
import { deletedLine, KIND_NAMES, leftLine, placeLine } from "@/lib/trashText"
import { cn } from "@/lib/utils"
import { trashActions } from "./trashActions"

const GLYPH = "flex size-[1.75rem] shrink-0 items-center justify-center rounded-md"

function Glyph({ item }: { item: TrashItem }) {
  if (item.kind === "file") return <FileGlyph file={{ name: item.name, mimeType: "" }} />
  if (item.kind === "paper" || item.kind === "board") return <KindGlyph kind={item.kind} />
  if (item.kind === "folder") return <FolderMark />
  if (item.kind === "project") {
    return (
      <span aria-hidden="true" className={GLYPH}>
        <IdentityTile color={item.color} symbol={item.icon} size="md" />
      </span>
    )
  }
  const [Icon, tone] =
    item.kind === "task"
      ? [CheckCircle, "bg-app-lavender-soft text-app-lavender-ink"]
      : [Calendar, "bg-app-bubblegum-soft text-app-bubblegum-ink"]
  return (
    <span aria-hidden="true" className={cn(GLYPH, tone)}>
      <Icon className="size-[1rem]" />
    </span>
  )
}

/** One Trash entry. On phones its two actions sit in a menu */
export function TrashRow({
  item,
  now,
  me,
  wide,
  busy,
  onRestore,
  onPurge,
}: {
  item: TrashItem
  now: Date
  me: string | null
  wide: boolean
  busy: boolean
  onRestore: (item: TrashItem) => void
  onPurge: (item: TrashItem) => void
}) {
  const place = placeLine(item)
  const via = markedVia(item.deletedVia) ? item.deletedVia : null
  const named = `${KIND_NAMES[item.kind].toLowerCase()} ${item.name}`
  const left = leftLine(item.purgeAt, now)
  const allowed = trashActions(item)
  const entries: MenuEntry[] = []
  if (allowed.includes("restore")) entries.push({ label: "Restore", Icon: Restore, run: () => onRestore(item) })
  if (allowed.includes("purge")) entries.push({ label: "Delete forever…", Icon: Trash, run: () => onPurge(item), danger: true })

  return (
    <li data-trash-row={item.id} aria-busy={busy || undefined} className="flex items-center gap-3 px-3 py-2.5">
      <Glyph item={item} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-ui">
          <span className="sr-only">{KIND_NAMES[item.kind]}: </span>
          <span className="min-w-0 truncate font-medium text-foreground">{item.name}</span>
          {item.detail && <span className="min-w-0 truncate text-muted-foreground">{item.detail}</span>}
        </p>
        <p className={cn("flex min-w-0 items-center gap-x-1.5 text-caption text-muted-foreground", wide ? "flex-wrap" : "flex-nowrap")}>
          {place && (
            <>
              <span className="min-w-0 truncate">{place}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="inline-flex shrink-0 items-center gap-1">
            {deletedLine(item, now, me)}
            {via && <ViaMark via={via} personName={item.deletedBy?.name ?? "someone"} verb="Deleted" />}
          </span>
          {wide && (
            <>
              <span aria-hidden="true">·</span>
              <span>{left}</span>
            </>
          )}
        </p>
        {!wide && <p className="text-caption text-muted-foreground">{left}</p>}
        {item.blocked && <p className="text-caption text-app-berry-text">{item.blocked}</p>}
      </div>
      {wide ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {allowed.includes("restore") && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-busy={busy || undefined}
              aria-label={`Restore ${named}`}
              onClick={() => onRestore(item)}
            >
              {busy ? "Restoring" : "Restore"}
            </Button>
          )}
          {allowed.includes("purge") && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Delete forever: ${named}`}
              onClick={() => onPurge(item)}
              className="text-app-berry-text"
            >
              Delete forever
            </Button>
          )}
        </div>
      ) : (
        <ActionMenu label={busy ? `Restoring ${named}` : `Actions for ${named}`} entries={entries} disabled={busy} />
      )}
    </li>
  )
}

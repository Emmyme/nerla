import { symbolFor } from "@/components/ui/symbols"
import { FOLDER_COLORS, type FolderColor } from "@/lib/folderColors"
import { cn } from "@/lib/utils"

export const FOLDER_COLOR_NAMES: Record<FolderColor, string> = {
  sky: "Sky",
  pistachio: "Pistachio",
  bubblegum: "Bubblegum",
  lavender: "Lavender",
  lemon: "Lemon",
}

export const folderColorOf = (color: string | null | undefined): FolderColor =>
  FOLDER_COLORS.includes(color as FolderColor) ? (color as FolderColor) : "sky"

export const folderFront = (color: string | null | undefined) => `var(--color-folder-${folderColorOf(color)}-front)`

/** A Finder-like folder: the back with its tab in the strong step, and a shorter front in the base step, with its symbol on the front */
export function FolderGlyph({ color, symbol, className }: { color?: string | null; symbol?: string | null; className?: string }) {
  const tone = folderColorOf(color)
  const entry = symbolFor(symbol)
  return (
    <svg aria-hidden="true" viewBox="0 0 64 50" className={cn("block h-auto w-full shrink-0", className)}>
      <path
        style={{ fill: `var(--color-folder-${tone}-back)` }}
        d="M5 0h16.6a4 4 0 0 1 3.2 1.6L28 6h31a5 5 0 0 1 5 5v34a5 5 0 0 1-5 5H5a5 5 0 0 1-5-5V5a5 5 0 0 1 5-5Z"
      />
      <path
        style={{ fill: `var(--color-folder-${tone}-front)` }}
        d="M0 18a5 5 0 0 1 5-5h54a5 5 0 0 1 5 5v27a5 5 0 0 1-5 5H5a5 5 0 0 1-5-5Z"
      />
      {entry && <entry.Icon x={23} y={22.5} width={18} height={18} weight="fill" color={`var(--color-folder-${tone}-back)`} />}
    </svg>
  )
}

/** The folder glyph at the size of a list row's file glyph */
export function FolderMark({ color, className }: { color?: string | null; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("flex size-[1.75rem] shrink-0 items-center justify-center", className)}>
      <FolderGlyph color={color} className="w-[1.375rem]" />
    </span>
  )
}

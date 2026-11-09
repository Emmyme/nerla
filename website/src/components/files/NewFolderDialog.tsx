import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { Check } from "@/components/icons"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { SymbolPicker } from "@/components/ui/identity-tile"
import { Input } from "@/components/ui/input"
import { symbolFor, type SymbolKey } from "@/components/ui/symbols"
import { FOLDER_COLORS, type FolderColor } from "@/lib/folderColors"
import type { FolderItem } from "@/lib/api/files"
import { messageOf } from "@/lib/taskStore"
import { cn } from "@/lib/utils"
import { FOLDER_COLOR_NAMES, folderColorOf, folderFront } from "./FolderGlyph"

const NAME_MAX = 255

const STEP = new Map([
  ["ArrowRight", 1],
  ["ArrowDown", 1],
  ["ArrowLeft", -1],
  ["ArrowUp", -1],
])

export function ColorPicker({
  value,
  onChange,
  labelledBy,
}: {
  value: FolderColor
  onChange: (color: FolderColor) => void
  labelledBy: string
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = FOLDER_COLORS.indexOf(value)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = FOLDER_COLORS.length
    const step = STEP.get(event.key)
    const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : step === undefined ? null : (selected + step + count) % count
    if (next === null) return
    event.preventDefault()
    onChange(FOLDER_COLORS[next])
    buttons.current[next]?.focus()
  }

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown} className="flex flex-wrap gap-1">
      {FOLDER_COLORS.map((color, i) => {
        const active = color === value
        return (
          <button
            key={color}
            ref={(el) => {
              buttons.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={FOLDER_COLOR_NAMES[color]}
            title={FOLDER_COLOR_NAMES[color]}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(color)}
            className="group flex size-[2.75rem] cursor-pointer items-center justify-center rounded-full focus-visible:outline-none lg:size-[2rem]"
          >
            <span
              aria-hidden="true"
              style={{ backgroundColor: folderFront(color) }}
              className={cn(
                "flex size-[2.125rem] items-center justify-center rounded-full transition-transform duration-150 group-focus-visible:outline-[0.125rem] group-focus-visible:outline-offset-[0.3125rem] group-focus-visible:outline-ring lg:size-[1.5rem]",
                active
                  ? "ring-[0.125rem] ring-foreground ring-offset-[0.125rem] ring-offset-card"
                  : "shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--color-text)_14%,transparent)] group-hover:scale-110",
              )}
            >
              {active && <Check weight="bold" className="size-[0.875rem] text-app-on-accent lg:size-[0.75rem]" />}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** A name for something new or a new name for something, and a folder's colour and symbol when `initialColor` is set */
export function NameDialog({
  open,
  title,
  label,
  initial = "",
  initialColor,
  initialSymbol = null,
  saveLabel,
  failed,
  selectStem = false,
  onSave,
  onClose,
}: {
  open: boolean
  title: string
  label: string
  initial?: string
  initialColor?: FolderColor
  initialSymbol?: SymbolKey | null
  saveLabel: string
  failed: string
  selectStem?: boolean
  onSave: (name: string, color: FolderColor, symbol: SymbolKey | null) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(initial)
  const [color, setColor] = useState<FolderColor>(initialColor ?? "sky")
  const [symbol, setSymbol] = useState<SymbolKey | null>(initialSymbol)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    setName(initial)
    setColor(initialColor ?? "sky")
    setSymbol(initialSymbol)
    setError(null)
  }, [open, initial, initialColor, initialSymbol])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    setError(null)
    try {
      await onSave(trimmed, color, symbol)
      onClose()
    } catch (err) {
      setError(messageOf(err, failed))
    } finally {
      setSaving(false)
    }
  }

  return (
    <BaseModal
      isOpen={open}
      onClose={() => !saving && onClose()}
      title={title}
      maxWidth="sm"
      initialFocus={() => {
        const field = input.current
        // A file keeps its extension selected out, so typing replaces only the name
        const dot = selectStem ? initial.lastIndexOf(".") : -1
        if (field) requestAnimationFrame(() => field.setSelectionRange(0, dot > 0 ? dot : field.value.length))
        return field
      }}
    >
      <form onSubmit={submit} className="flex flex-col gap-4 p-6">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-ui font-medium text-foreground">
            {label}
          </label>
          <Input
            ref={input}
            id={id}
            value={name}
            maxLength={NAME_MAX}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {error && (
            <p id={`${id}-error`} role="alert" className="text-ui text-app-berry-text">
              {error}
            </p>
          )}
        </div>
        {initialColor && (
          <div className="flex flex-col gap-1.5">
            <span id={`${id}-color`} className="text-ui font-medium text-foreground">
              Colour
            </span>
            <ColorPicker value={color} onChange={setColor} labelledBy={`${id}-color`} />
          </div>
        )}
        {initialColor && (
          <div className="flex flex-col gap-1.5">
            <span id={`${id}-symbol`} className="text-ui font-medium text-foreground">
              Symbol
            </span>
            <SymbolPicker value={symbol} onChange={setSymbol} labelledBy={`${id}-symbol`} />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim() || saving} aria-busy={saving || undefined}>
            {saveLabel}
          </Button>
        </div>
      </form>
    </BaseModal>
  )
}

export function NewFolderDialog({
  open,
  onCreate,
  onClose,
}: {
  open: boolean
  onCreate: (name: string, color: FolderColor, symbol: SymbolKey | null) => Promise<void>
  onClose: () => void
}) {
  return (
    <NameDialog
      open={open}
      title="New folder"
      label="Name"
      initial="Untitled folder"
      initialColor="sky"
      saveLabel="Create"
      failed="Couldn't create the folder. Try again."
      onSave={onCreate}
      onClose={onClose}
    />
  )
}

export function EditFolderDialog({
  folder,
  onSave,
  onClose,
}: {
  folder: FolderItem | null
  onSave: (folder: FolderItem, name: string, color: FolderColor, symbol: SymbolKey | null) => Promise<void>
  onClose: () => void
}) {
  return (
    <NameDialog
      open={folder !== null}
      title="Edit folder"
      label="Name"
      initial={folder?.name ?? ""}
      initialColor={folderColorOf(folder?.color)}
      initialSymbol={symbolFor(folder?.icon)?.key ?? null}
      saveLabel="Save"
      failed="Couldn't save the folder. Try again."
      onSave={async (name, color, symbol) => {
        if (folder) await onSave(folder, name, color, symbol)
      }}
      onClose={onClose}
    />
  )
}

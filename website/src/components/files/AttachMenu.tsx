import { useRef, useState, type ReactNode } from "react"
import { Folder, Paperclip, Upload } from "@/components/icons"
import type { FileItem } from "@/lib/api/files"
import { cn } from "@/lib/utils"
import { ActionMenu } from "./ActionMenu"
import { FilePicker } from "./FilePicker"

/** The paperclip: "From Nerla" picks files already here, "From computer" uploads new ones */
export function AttachMenu({
  projectId,
  onFiles,
  onPick,
  disabled = false,
  className,
  iconClassName,
  label = "Attach files",
  align = "start",
  children,
}: {
  /** Inside a project its files can be picked too */
  projectId: string | null
  onFiles: (files: File[]) => void
  onPick: (files: FileItem[]) => void
  disabled?: boolean
  className?: string
  iconClassName?: string
  label?: string
  align?: "start" | "end"
  /** A visible label in place of the paperclip */
  children?: ReactNode
}) {
  const input = useRef<HTMLInputElement>(null)
  const [picking, setPicking] = useState(false)

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ""
          if (files.length > 0) onFiles(files)
        }}
      />
      <ActionMenu
        label={label}
        title={children ? undefined : label}
        align={align}
        widthRem={11}
        disabled={disabled}
        className={cn("z-auto", className)}
        trigger={children ?? <Paperclip aria-hidden="true" className={cn("size-4", iconClassName)} />}
        entries={[
          { label: "From Nerla", Icon: Folder, run: () => setPicking(true) },
          { label: "From computer", Icon: Upload, run: () => input.current?.click() },
        ]}
      />
      <FilePicker open={picking} projectId={projectId} onPick={onPick} onClose={() => setPicking(false)} />
    </>
  )
}

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { fileBrowserAPI } from "@/lib/api/files"
import type { DocMeta } from "@/lib/api/papers"
import { messageOf } from "@/lib/taskStore"

/** A paper or board's name, which its owner and project members rename in place */
export function DocTitle({ meta, onRenamed }: { meta: DocMeta; onRenamed: (name: string) => void }) {
  const [name, setName] = useState(meta.file.name)
  const saving = useRef(false)
  const kind = meta.docType === "board" ? "board" : "paper"
  useEffect(() => setName(meta.file.name), [meta.file.name])

  if (!meta.file.can.includes("rename")) {
    return <span className="min-w-0 truncate">{meta.file.name}</span>
  }

  const save = async () => {
    const next = name.trim()
    if (!next || next === meta.file.name) return setName(meta.file.name)
    if (saving.current) return
    saving.current = true
    try {
      const saved = await fileBrowserAPI.updateFile(meta.file.id, { name: next })
      onRenamed(saved.name)
    } catch (err) {
      setName(meta.file.name)
      toast.error(messageOf(err, `Couldn't rename the ${kind}. Try again.`))
    } finally {
      saving.current = false
    }
  }

  return (
    <input
      aria-label={kind === "board" ? "Board name" : "Paper name"}
      value={name}
      maxLength={255}
      onChange={(event) => setName(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur()
        if (event.key === "Escape") {
          setName(meta.file.name)
          requestAnimationFrame(() => (event.target as HTMLInputElement).blur())
        }
      }}
      size={Math.max(8, Math.min(name.length + 1, 48))}
      className="-mx-1.5 max-w-full min-w-0 truncate rounded-md bg-transparent px-1.5 text-foreground transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-sunk focus-visible:outline-none"
    />
  )
}

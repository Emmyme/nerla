import { useEffect, useId, useState, type FormEvent } from "react"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { fileBrowserAPI, type FileItem } from "@/lib/api/files"
import { messageOf } from "@/lib/taskStore"

const ALT_TEXT_MAX = 500
// The live region only changes at these steps, so a screen reader hears it once per step, not per keystroke
const NOTICE_STEPS = [50, 20, 10]

function limitNotice(left: number): string {
  if (left <= 0) return "Character limit reached"
  const step = NOTICE_STEPS.findLast((at) => left <= at)
  return step ? `${step} characters left or fewer` : ""
}

/** The description a screen reader reads for an image, saved on the file */
export function AltTextDialog({
  file,
  onSaved,
  onClose,
}: {
  file: Pick<FileItem, "id" | "altText"> | null
  onSaved: (file: FileItem) => void
  onClose: () => void
}) {
  const [text, setText] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()

  useEffect(() => {
    if (!file) return
    setText(file.altText ?? "")
    setError(null)
  }, [file])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!file || saving) return
    setSaving(true)
    setError(null)
    try {
      onSaved(await fileBrowserAPI.updateFile(file.id, { altText: text.trim() || null }))
      onClose()
    } catch (err) {
      setError(messageOf(err, "Couldn't save the description. Try again."))
    } finally {
      setSaving(false)
    }
  }

  return (
    <BaseModal isOpen={file !== null} onClose={() => !saving && onClose()} title="Description" maxWidth="sm" describedBy={`${id}-hint`}>
      <form onSubmit={submit} className="flex flex-col gap-4 p-6">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="sr-only">
            Description
          </label>
          <p id={`${id}-hint`} className="text-ui text-muted-foreground">
            Describe the image for people who use a screen reader.
          </p>
          <textarea
            id={id}
            value={text}
            rows={4}
            maxLength={ALT_TEXT_MAX}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setText(event.target.value)}
            className="w-full resize-none rounded-md border border-input bg-card px-3 py-2 text-ui text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
          />
          <span aria-hidden="true" className="self-end text-caption text-muted-foreground tabular-nums">
            {text.length} of {ALT_TEXT_MAX}
          </span>
          <span aria-live="polite" className="sr-only">
            {limitNotice(ALT_TEXT_MAX - text.length)}
          </span>
          {error && (
            <p role="alert" className="text-ui text-app-berry-text">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving} aria-busy={saving || undefined}>
            Save
          </Button>
        </div>
      </form>
    </BaseModal>
  )
}

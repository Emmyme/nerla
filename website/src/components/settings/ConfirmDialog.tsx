import { useEffect, useId, useState, type ReactNode } from "react"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { messageOf } from "@/lib/taskStore"

/** A confirm for a destructive action that runs once the user agrees */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  busyLabel,
  failed,
  onConfirm,
  onClose,
  fallbackFocus,
  children,
}: {
  open: boolean
  title: string
  confirmLabel: string
  busyLabel: string
  failed: string
  onConfirm: () => Promise<void>
  onClose: () => void
  /** Where focus goes when the button that opened the confirm is gone */
  fallbackFocus: () => HTMLElement | null
  children: ReactNode
}) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bodyId = useId()

  useEffect(() => {
    if (open) setError(null)
  }, [open])

  const confirm = async () => {
    setWorking(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(messageOf(err, failed))
    } finally {
      setWorking(false)
    }
  }

  return (
    <BaseModal
      isOpen={open}
      onClose={() => {
        if (!working) onClose()
      }}
      title={title}
      maxWidth="sm"
      fallbackFocus={fallbackFocus}
      describedBy={bodyId}
    >
      <div className="flex flex-col gap-4 p-6">
        <p id={bodyId} className="text-body leading-[1.5] text-muted-foreground">
          {children}
        </p>
        {error && (
          <p role="alert" className="text-ui text-app-berry-text">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" autoFocus onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={() => void confirm()} disabled={working}>
            {working ? busyLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </BaseModal>
  )
}

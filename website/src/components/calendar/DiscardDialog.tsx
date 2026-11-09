import { useCallback, useState } from "react"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"

/**
 * Runs an action that would drop the editor's changes, asking "Discard unsaved changes?" first when
 * there are any. An unchanged editor goes without asking. `onKeep` runs when the user keeps editing.
 */
export function useDiscardGuard(dirty: () => boolean): [(action: () => void, onKeep?: () => void) => void, JSX.Element] {
  const [pending, setPending] = useState<{ action: () => void; onKeep?: () => void } | null>(null)

  const guard = useCallback(
    (action: () => void, onKeep?: () => void) => {
      if (dirty()) setPending({ action, onKeep })
      else action()
    },
    [dirty],
  )

  const keep = () => {
    pending?.onKeep?.()
    setPending(null)
  }

  const dialog = (
    <BaseModal isOpen={!!pending} onClose={keep} title="Discard unsaved changes?" maxWidth="sm" showCloseButton={false}>
      <div className="flex justify-end gap-2 p-5">
        <Button type="button" variant="ghost" onClick={keep}>
          Keep editing
        </Button>
        <Button
          type="button"
          onClick={() => {
            const action = pending?.action
            setPending(null)
            action?.()
          }}
        >
          Discard
        </Button>
      </div>
    </BaseModal>
  )

  return [guard, dialog]
}

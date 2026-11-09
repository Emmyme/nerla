import { toast } from "sonner"
import { trashAPI, type Restored, type TrashRef } from "@/lib/api/trash"
import { messageOf } from "@/lib/taskStore"

const UNDO_FAILED = "Couldn't bring it back. You can still restore it from the trash."

/**
 * "Task moved to Trash" with Undo, which restores exactly the entry the delete made. Restore answers the same when the
 * item is already back, and the action runs once, so a double click never shows an error
 */
export function movedToTrash(text: string, entry: TrashRef, onRestored: (restored: Restored) => void) {
  let used = false
  toast.success(text, {
    action: {
      label: "Undo",
      onClick: () => {
        if (used) return
        used = true
        trashAPI.restore(entry).then(onRestored, (err: unknown) => toast.error(messageOf(err, UNDO_FAILED)))
      },
    },
  })
}

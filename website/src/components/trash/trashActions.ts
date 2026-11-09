import type { TrashItem } from "@/lib/api/trash"

type TrashAction = "restore" | "purge"

/** What this viewer may do with an entry, as the server decided. The buttons and the phone menu offer only these */
export const trashActions = (item: Pick<TrashItem, "can">): TrashAction[] => [
  ...(item.can.restore ? (["restore"] as const) : []),
  ...(item.can.purge ? (["purge"] as const) : []),
]

import type { DragEvent } from "react"

export type DraggedItem = { kind: "file" | "folder"; id: string }

const DRAG_TYPE = "application/x-nerla-file"

export function startDrag(event: DragEvent, item: DraggedItem) {
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item))
  event.dataTransfer.effectAllowed = "move"
}

/** A row being dragged inside Files, as opposed to files from the computer */
export const carriesItem = (event: DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE)
export const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files")

export function droppedItem(event: DragEvent): DraggedItem | null {
  try {
    const item = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)) as DraggedItem
    return item && (item.kind === "file" || item.kind === "folder") && typeof item.id === "string" ? item : null
  } catch {
    return null
  }
}

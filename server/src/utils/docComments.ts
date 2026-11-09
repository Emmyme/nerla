/** Where a thread sits: a text selection as Yjs relative positions in base64, or a spot on a board */
export type CommentAnchor =
  { type: "text"; from: string; to: string; quote: string } | { type: "board"; boardId: string | null; x: number; y: number }

type ThreadRow = { id: string; parentId: string | null; deletedAt: string | null }

export type Thread<T> = { root: T; replies: T[] }

/**
 * The threads the user sees, in the rows' order. A thread they hid stays hidden with every reply, later ones included.
 * A deleted reply is gone, and a deleted root stays only while it has replies
 */
export function visibleThreads<T extends ThreadRow>(rows: T[], hiddenRootIds: ReadonlySet<string>): Thread<T>[] {
  const threads = new Map<string, Thread<T>>()
  for (const row of rows) {
    if (!row.parentId && !hiddenRootIds.has(row.id)) threads.set(row.id, { root: row, replies: [] })
  }
  for (const row of rows) {
    if (row.parentId && !row.deletedAt) threads.get(row.parentId)?.replies.push(row)
  }
  return [...threads.values()].filter((thread) => !thread.root.deletedAt || thread.replies.length > 0)
}

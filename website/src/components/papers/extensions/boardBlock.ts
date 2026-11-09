import { createElement } from "react"
import { mergeAttributes, Node, type Editor } from "@tiptap/core"
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import * as Y from "yjs"
import { ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react"
import type { HocuspocusProvider } from "@hocuspocus/provider"
import type { DocLevel } from "@/lib/api/files"
import { boardsOf, BoardBlockView, ensureBoard } from "../BoardBlockView"
import type { BoardAccess } from "../boardFiles"

export type BoardBlockOptions = {
  /** The paper's doc, and its live connection when there is one. A version preview has none */
  live: { doc: Y.Doc; provider?: HocuspocusProvider } | null
  fileId: string | null
  level: DocLevel
  access: BoardAccess
  canUpload: boolean
}

const newBoardId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)

/** A new board at the caret, with its entry made at once so a second editor never makes another */
export function insertBoard(editor: Editor) {
  const boardId = newBoardId()
  const inserted = editor
    .chain()
    .focus()
    .insertContent({ type: "boardBlock", attrs: { boardId } })
    // The caret goes on below the board, so the next key types there rather than replacing it
    .command(({ tr }) => {
      let end = -1
      tr.doc.descendants((node, pos) => {
        if (end < 0 && node.type.name === "boardBlock" && node.attrs.boardId === boardId) end = pos + node.nodeSize
        return end < 0
      })
      if (end < 0) return true
      if (!tr.doc.nodeAt(end)?.isTextblock) tr.insert(end, tr.doc.type.schema.nodes.paragraph.create())
      tr.setSelection(TextSelection.create(tr.doc, end + 1))
      return true
    })
    .run()
  const live = (
    editor.extensionManager.extensions.find((extension) => extension.name === "boardBlock")?.options as BoardBlockOptions | undefined
  )?.live
  if (inserted && live) ensureBoard(live.doc, boardId)
}

/** A board's elements as plain JSON, deleted ones left out, for the clipboard */
function boardJson(doc: Y.Doc | undefined, boardId: string | null): string | null {
  const board = doc && boardId ? boardsOf(doc).get(boardId) : null
  if (!(board instanceof Y.Map)) return null
  const elements = [...board.values()].filter((element) => !(element as { isDeleted?: boolean }).isDeleted)
  return elements.length ? JSON.stringify(elements) : null
}

function mapNodes(fragment: Fragment, change: (node: PMNode) => PMNode): Fragment {
  const nodes: PMNode[] = []
  fragment.forEach((node) => nodes.push(change(node.copy(mapNodes(node.content, change)))))
  return Fragment.from(nodes)
}

/**
 * A pasted board gets its own board. A copy of a block still in this paper gets a new id and a copy of its elements,
 * cut and paste or a drag keeps the id, and a block from another paper brings its elements along from the clipboard
 */
function pasteBoards(slice: Slice, doc: Y.Doc, present: Set<string>, moving: boolean): Slice {
  const boards = boardsOf(doc)
  const content = mapNodes(slice.content, (node) => {
    if (node.type.name !== "boardBlock") return node
    const { boardId, pasted } = node.attrs as { boardId: string | null; pasted: string | null }
    let id = boardId
    const source = boardId ? boards.get(boardId) : null
    if (!id || (present.has(id) && !moving)) id = newBoardId()
    if (id !== boardId || !(source instanceof Y.Map)) {
      let elements: unknown[] = []
      if (source instanceof Y.Map) elements = [...source.values()]
      else if (pasted) {
        try {
          elements = JSON.parse(pasted) as unknown[]
        } catch {
          elements = []
        }
      }
      const board = new Y.Map<unknown>()
      for (const element of elements) {
        const value = element as { id?: unknown }
        if (typeof value?.id === "string") board.set(value.id, JSON.parse(JSON.stringify(element)))
      }
      if (!boards.has(id)) boards.set(id, board)
    }
    present.add(id)
    return node.type.create({ ...node.attrs, boardId: id, pasted: null })
  })
  return new Slice(content, slice.openStart, slice.openEnd)
}

/** A board drawn inside the paper. Its elements live in the doc's `boards` map under `boardId` */
export const BoardBlock = Node.create<BoardBlockOptions>({
  name: "boardBlock",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { live: null, fileId: null, level: "view", access: async () => ({}), canUpload: false }
  },

  addAttributes() {
    return {
      boardId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-board-id"),
        renderHTML: (attributes: { boardId?: string | null }) => (attributes.boardId ? { "data-board-id": attributes.boardId } : {}),
      },
      // The elements a copied block carries on the clipboard, read once when it is pasted
      pasted: {
        default: null,
        rendered: false,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-board-elements"),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="board-block"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const elements = boardJson(this.options.live?.doc, node.attrs.boardId as string | null)
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "board-block" }, elements ? { "data-board-elements": elements } : {})]
  },

  addProseMirrorPlugins() {
    const doc = this.options.live?.doc
    if (!doc) return []
    return [
      new Plugin({
        key: new PluginKey("boardPaste"),
        props: {
          transformPasted: (slice, view) => {
            const present = new Set<string>()
            view.state.doc.descendants((node) => {
              if (node.type.name === "boardBlock" && node.attrs.boardId) present.add(node.attrs.boardId as string)
            })
            return pasteBoards(slice, doc, present, !!view.dragging?.move)
          },
        },
      }),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer((props: ReactNodeViewProps) =>
      createElement(BoardBlockView, {
        boardId: props.node.attrs.boardId as string | null,
        selected: props.selected,
        options: this.options,
      }),
    )
  },
})

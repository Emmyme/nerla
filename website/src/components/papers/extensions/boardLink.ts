import { createElement } from "react"
import { mergeAttributes, Node } from "@tiptap/core"
import { ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react"
import { BoardLinkCard } from "../BoardLinkCard"

/** Guests in a call have no account, so a linked board is never theirs to see */
type BoardLinkOptions = { member: boolean }

/** A board file shown inside the paper, by its `fileId` */
export const BoardLink = Node.create<BoardLinkOptions>({
  name: "boardLink",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { member: true }
  },

  addAttributes() {
    return {
      fileId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-file-id"),
        renderHTML: (attributes: { fileId?: string | null }) => (attributes.fileId ? { "data-file-id": attributes.fileId } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="board-link"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "board-link" })]
  },

  addNodeView() {
    return ReactNodeViewRenderer((props: ReactNodeViewProps) =>
      createElement(BoardLinkCard, {
        fileId: props.node.attrs.fileId as string | null,
        selected: props.selected,
        member: this.options.member,
      }),
    )
  },
})

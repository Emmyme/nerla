import { Extension, type Editor } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "@tiptap/y-tiptap"
import * as Y from "yjs"
import type { CommentAnchor } from "@/lib/api/papers"
import { fromBase64, toBase64 } from "@/lib/base64"

export type TextAnchor = Extract<CommentAnchor, { type: "text" }>

const QUOTE_MAX = 500
/** The draft comment's anchor, highlighted until it is posted */
export const PENDING = "pending"

function syncOf(state: EditorState) {
  const sync = ySyncPluginKey.getState(state) as { type: Y.XmlFragment; binding: { mapping: Map<unknown, unknown> } } | undefined
  return sync?.type && sync.binding ? sync : null
}

/**
 * The selection as Yjs relative positions in the paper's text, so it follows the words as other users edit. The start holds
 * on to the first letter and the end on to the last, so text typed right before or after the words stays outside
 */
export function anchorFor(editor: Editor, from: number, to: number): TextAnchor {
  const sync = syncOf(editor.state)
  const ydoc = sync?.type.doc
  if (!sync || !ydoc) throw new Error("The paper isn't live yet")
  // A double click takes the space after a word too, which isn't part of what is commented on
  const { doc } = editor.state
  while (from < to && !doc.textBetween(from, from + 1).trim()) from++
  while (to > from && !doc.textBetween(to - 1, to).trim()) to--
  const at = (pos: number, assoc: number) => {
    const relative = absolutePositionToRelativePosition(pos, sync.type, sync.binding.mapping as never)
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, ydoc)
    const held =
      absolute?.type instanceof Y.XmlText ? Y.createRelativePositionFromTypeIndex(absolute.type, absolute.index, assoc) : relative
    return toBase64(Y.encodeRelativePosition(held))
  }
  return { type: "text", from: at(from, 0), to: at(to, -1), quote: editor.state.doc.textBetween(from, to, " ").slice(0, QUOTE_MAX) }
}

/** The block a position sits in was taken out of the paper, as a restore does when it puts back clones of old blocks */
function blockGone(ydoc: Y.Doc, fragment: Y.XmlFragment, position: Y.RelativePosition): boolean {
  const absolute = Y.createAbsolutePositionFromRelativePosition(position, ydoc)
  if (!absolute) return true
  for (
    let type: Y.AbstractType<unknown> = absolute.type;
    type !== fragment && type._item;
    type = type._item.parent as Y.AbstractType<unknown>
  ) {
    if (type._item.deleted) return true
  }
  return false
}

/** The one place the quote reads in the paper, or null when it reads nowhere or in more than one place */
function uniqueQuote(doc: PMNode, quote: string): { from: number; to: number } | null {
  if (!quote.trim()) return null
  let text = ""
  // The doc position of each letter, and -1 for the space between two blocks
  const at: number[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock && text) {
      text += " "
      at.push(-1)
    }
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) at.push(pos + i)
      text += node.text
    }
    return true
  })
  const first = text.indexOf(quote)
  if (first < 0 || text.indexOf(quote, first + 1) >= 0) return null
  const from = at[first]
  const last = at[first + quote.length - 1]
  return from >= 0 && last >= 0 ? { from, to: last + 1 } : null
}

/**
 * Where an anchor's words are now, or null once they are gone. When a restore replaced their block, the words come
 * back on this screen if their quote reads in exactly one place, and the stored anchor stays as it was
 */
function rangeIn(state: EditorState, anchor: TextAnchor): { from: number; to: number } | null {
  const sync = syncOf(state)
  const ydoc = sync?.type.doc
  if (!sync || !ydoc) return null
  try {
    const start = Y.decodeRelativePosition(fromBase64(anchor.from))
    const end = Y.decodeRelativePosition(fromBase64(anchor.to))
    const at = (position: Y.RelativePosition) =>
      relativePositionToAbsolutePosition(ydoc, sync.type, position, sync.binding.mapping as never)
    const from = at(start)
    const to = at(end)
    if (from !== null && to !== null && from < to && to <= state.doc.content.size && state.doc.textBetween(from, to, " ").trim())
      return { from, to }
    if (blockGone(ydoc, sync.type, start) || blockGone(ydoc, sync.type, end)) return uniqueQuote(state.doc, anchor.quote)
    return null
  } catch {
    return null
  }
}

export function rangeOf(editor: Editor, anchor: CommentAnchor): { from: number; to: number } | null {
  return anchor.type === "text" ? rangeIn(editor.state, anchor) : null
}

export type ShownAnchor = { id: string; anchor: TextAnchor }

type Highlights = { anchors: ShownAnchor[]; active: string | null; decorations: DecorationSet; attached: ReadonlySet<string> }

const highlightsKey = new PluginKey<Highlights>("commentHighlights")

function draw(state: EditorState, anchors: ShownAnchor[], active: string | null): Highlights {
  const decorations: Decoration[] = []
  for (const { id, anchor } of anchors) {
    const range = rangeIn(state, anchor)
    if (!range) continue
    const className = ["paper-comment", id === active && "is-active", id === PENDING && "is-pending"].filter(Boolean).join(" ")
    decorations.push(Decoration.inline(range.from, range.to, { class: className, "data-comment": id }, { id }))
  }
  const set = DecorationSet.create(state.doc, decorations)
  return { anchors, active, decorations: set, attached: attachedIn(set) }
}

const attachedIn = (set: DecorationSet) => new Set(set.find().map((decoration) => (decoration.spec as { id: string }).id))

/** Shows the threads' words, and the draft's, as highlights that live only on this screen */
export function showAnchors(editor: Editor, anchors: ShownAnchor[], active: string | null) {
  if (editor.isDestroyed) return
  try {
    editor.view.dispatch(editor.state.tr.setMeta(highlightsKey, { anchors, active }))
  } catch {
    // The view isn't mounted yet, and the first sync shows them again
  }
}

/** The threads whose words are still in the paper */
export const attachedAnchors = (editor: Editor): ReadonlySet<string> => highlightsKey.getState(editor.state)?.attached ?? new Set()

/**
 * Comment highlights are decorations, never marks, so they never reach other users' papers or the print. Remote
 * changes redraw them from their relative positions, and local ones move them along
 */
export const CommentHighlights = Extension.create<{ onOpen: (id: string) => void }>({
  name: "commentHighlights",
  addOptions: () => ({ onOpen: () => undefined }),
  addProseMirrorPlugins() {
    const { onOpen } = this.options
    return [
      new Plugin<Highlights>({
        key: highlightsKey,
        state: {
          init: () => ({ anchors: [], active: null, decorations: DecorationSet.empty, attached: new Set() }),
          apply: (tr, value, _old, state) => {
            const shown = tr.getMeta(highlightsKey) as { anchors: ShownAnchor[]; active: string | null } | undefined
            if (shown) return draw(state, shown.anchors, shown.active)
            if (!tr.docChanged) return value
            if ((tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin)
              return draw(state, value.anchors, value.active)
            const decorations = value.decorations.map(tr.mapping, tr.doc)
            return { ...value, decorations, attached: attachedIn(decorations) }
          },
        },
        props: {
          decorations: (state) => highlightsKey.getState(state)?.decorations,
          handleClick: (view, pos) => {
            const hit = highlightsKey
              .getState(view.state)
              ?.decorations.find(pos, pos)
              .map((decoration) => (decoration.spec as { id: string }).id)
              .find((id) => id !== PENDING)
            if (hit) onOpen(hit)
            return false
          },
        },
      }),
    ]
  },
})

import { Extension } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

type FindRange = { from: number; to: number }
type FindState = { query: string; matches: FindRange[]; index: number }

const findKey = new PluginKey<FindState>("findReplace")

const EMPTY: FindState = { query: "", matches: [], index: 0 }

/** Every place the query appears, ignoring case, inside each block of text. Marks may split a match */
function matchesIn(doc: PMNode, query: string): FindRange[] {
  const typed = query.toLowerCase()
  if (!typed) return []
  const found: FindRange[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let text = ""
    const at: number[] = []
    node.forEach((child, offset) => {
      const start = pos + 1 + offset
      if (child.isText && child.text) {
        for (let i = 0; i < child.text.length; i++) at.push(start + i)
        text += child.text
      } else {
        at.push(start)
        text += "￼"
      }
    })
    const lower = text.toLowerCase()
    const haystack = lower.length === text.length ? lower : text
    for (let i = haystack.indexOf(typed); i !== -1; i = haystack.indexOf(typed, i + typed.length)) {
      found.push({ from: at[i], to: at[i + typed.length - 1] + 1 })
    }
    return false
  })
  return found
}

type Meta = { query?: string; index?: number }

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    findReplace: {
      setFindQuery: (query: string) => ReturnType
      findStep: (step: 1 | -1) => ReturnType
      replaceMatch: (text: string) => ReturnType
      replaceAllMatches: (text: string) => ReturnType
    }
  }
}

export const findState = (state: EditorState): FindState => findKey.getState(state) ?? EMPTY

function current(state: EditorState): FindRange | null {
  const find = findState(state)
  return find.matches[find.index] ?? null
}

/** Ctrl F finds in the paper, and editors replace too */
export const FindReplace = Extension.create({
  name: "findReplace",

  addCommands() {
    return {
      setFindQuery:
        (query) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(findKey, { query, index: 0 } satisfies Meta))
          return true
        },
      findStep:
        (step) =>
        ({ state, tr, dispatch }) => {
          const find = findState(state)
          if (find.matches.length === 0) return false
          const index = (find.index + step + find.matches.length) % find.matches.length
          if (dispatch) dispatch(tr.setMeta(findKey, { index } satisfies Meta))
          return true
        },
      replaceMatch:
        (text) =>
        ({ state, tr, dispatch }) => {
          const range = current(state)
          if (!range) return false
          if (dispatch) dispatch(text ? tr.insertText(text, range.from, range.to) : tr.delete(range.from, range.to))
          return true
        },
      replaceAllMatches:
        (text) =>
        ({ state, tr, dispatch }) => {
          const { matches } = findState(state)
          if (matches.length === 0) return false
          if (dispatch) {
            for (const range of [...matches].reverse()) {
              if (text) tr.insertText(text, range.from, range.to)
              else tr.delete(range.from, range.to)
            }
            dispatch(tr)
          }
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => EMPTY,
          apply: (tr, prev) => {
            const meta = tr.getMeta(findKey) as Meta | undefined
            const query = meta?.query ?? prev.query
            if (!meta && !tr.docChanged) return prev
            const matches = meta?.query !== undefined || tr.docChanged ? matchesIn(tr.doc, query) : prev.matches
            const index = Math.min(meta?.index ?? prev.index, Math.max(0, matches.length - 1))
            return { query, matches, index }
          },
        },
        props: {
          decorations: (state) => {
            const find = findState(state)
            if (find.matches.length === 0) return DecorationSet.empty
            return DecorationSet.create(
              state.doc,
              find.matches.map((range, index) =>
                Decoration.inline(range.from, range.to, {
                  class: index === find.index ? "paper-find-match is-current" : "paper-find-match",
                }),
              ),
            )
          },
        },
      }),
    ]
  },
})

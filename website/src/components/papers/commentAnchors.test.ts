// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import StarterKit from "@tiptap/starter-kit"
import * as Y from "yjs"
import { anchorFor, rangeOf } from "./commentAnchors"

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

async function paperWith(text: string) {
  const doc = new Y.Doc()
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit.configure({ undoRedo: false }), Collaboration.configure({ document: doc, field: "default" })],
  })
  editors.push(editor)
  // The binding draws the shared text a moment after the view exists
  await new Promise((resolve) => setTimeout(resolve, 10))
  editor.commands.setContent(`<p>${text}</p>`)
  return { doc, editor }
}

function find(editor: Editor, words: string) {
  let found: { from: number; to: number } | null = null
  editor.state.doc.descendants((node, pos) => {
    const at = node.isText ? (node.text ?? "").indexOf(words) : -1
    if (!found && at >= 0) found = { from: pos + at, to: pos + at + words.length }
  })
  if (!found) throw new Error(`No "${words}" in the paper`)
  return found as { from: number; to: number }
}

const sentenceOf = (doc: Y.Doc) => (doc.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText

const wordsAt = (editor: Editor, range: { from: number; to: number } | null) =>
  range ? editor.state.doc.textBetween(range.from, range.to) : null

/** What the server's restore does to a paper's text: clones of the old blocks in place of the live ones */
function restore(doc: Y.Doc, version: Uint8Array) {
  const old = new Y.Doc()
  Y.applyUpdate(old, version)
  doc.transact(() => {
    const text = doc.getXmlFragment("default")
    text.delete(0, text.length)
    text.insert(
      0,
      old
        .getXmlFragment("default")
        .toArray()
        .map((child) => child.clone() as Y.XmlElement),
    )
  })
}

describe("comment anchors", () => {
  it("keeps to its words while text arrives around them, and lets go once they are gone", async () => {
    const { doc, editor } = await paperWith("The quick brown fox jumps.")
    const { from, to } = find(editor, "brown fox")
    const anchor = anchorFor(editor, from, to)
    expect(anchor).toMatchObject({ type: "text", quote: "brown fox" })

    const sentence = sentenceOf(doc)
    sentence.insert(0, "Look, ")
    sentence.insert("Look, The quick brown fox".length, "y")
    sentence.insert("Look, The quick ".length, "big ")
    expect(wordsAt(editor, rangeOf(editor, anchor))).toBe("brown fox")

    sentence.delete(0, sentence.length)
    expect(rangeOf(editor, anchor)).toBeNull()
  })

  it("finds its words again after a restore only when the quote reads in exactly one place", async () => {
    const { doc, editor } = await paperWith("brown fox and brown fox")
    const twice = Y.encodeStateAsUpdate(doc)
    editor.commands.setContent("<p>Nothing to see</p>")
    const never = Y.encodeStateAsUpdate(doc)
    editor.commands.setContent("<p>The quick brown fox jumps.</p>")
    const unique = Y.encodeStateAsUpdate(doc)
    const { from, to } = find(editor, "brown fox")
    const anchor = anchorFor(editor, from, to)

    restore(doc, unique)
    expect(wordsAt(editor, rangeOf(editor, anchor))).toBe("brown fox")
    restore(doc, twice)
    expect(rangeOf(editor, anchor)).toBeNull()
    restore(doc, never)
    expect(rangeOf(editor, anchor)).toBeNull()
  })
})

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import StarterKit from "@tiptap/starter-kit"
import * as Y from "yjs"
import { ReadOnlyPaper } from "./readOnlyPaper"

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

const paper = (doc: Y.Doc, readOnly: boolean) => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: doc, field: "default" }),
      ...(readOnly ? [ReadOnlyPaper] : []),
    ],
  })
  editors.push(editor)
  return editor
}

// The binding draws the shared text a moment after the view exists
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("ReadOnlyPaper", () => {
  it("refuses a commenter's own changes and keeps their selection", async () => {
    const doc = new Y.Doc()
    const writer = paper(doc, false)
    const commenter = paper(doc, true)
    await settle()
    writer.commands.setContent("<p>Hello there</p>")
    await settle()

    commenter.commands.insertContentAt(1, "Oops ")
    commenter.commands.toggleBold()
    expect(commenter.getText()).toBe("Hello there")
    expect(writer.getText()).toBe("Hello there")

    commenter.commands.setTextSelection({ from: 1, to: 6 })
    expect(commenter.state.doc.textBetween(commenter.state.selection.from, commenter.state.selection.to)).toBe("Hello")
  })

  it("still shows what editors write", async () => {
    const doc = new Y.Doc()
    const writer = paper(doc, false)
    const commenter = paper(doc, true)
    await settle()
    writer.commands.setContent("<p>First</p>")
    await settle()
    writer.commands.insertContentAt(writer.state.doc.content.size - 1, " and more")
    await settle()
    expect(commenter.getText()).toBe("First and more")
  })
})

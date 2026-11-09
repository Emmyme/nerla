import { describe, expect, it } from "vitest"
import { getSchema } from "@tiptap/core"
import { TaskList } from "@tiptap/extension-list"
import { TableKit } from "@tiptap/extension-table"
import StarterKit from "@tiptap/starter-kit"
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap"
import * as Y from "yjs"
// Made by server/scripts/aiDocFixture.ts, run it again after changing the paper converter
import sample from "./fixtures/aiSample.update.txt?raw"
import { BoardBlock } from "./extensions/boardBlock"
import { BoardLink } from "./extensions/boardLink"
import { PaperImage } from "./extensions/image"
import { paperMention } from "./extensions/mention"
import { TaskLine } from "./extensions/taskLine"
import { SuggestionMenuStore } from "./SuggestionMenu"

const NODES = [
  "doc",
  "paragraph",
  "text",
  "heading",
  "hardBreak",
  "mention",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
  "image",
  "boardLink",
  "boardBlock",
]
const MARKS = ["bold", "italic", "underline", "strike", "code", "link"]

// The extensions PaperEditor uses, configured as it does
const schema = getSchema([
  StarterKit.configure({ undoRedo: false, heading: { levels: [1, 2, 3] }, link: { autolink: true, defaultProtocol: "https" } }),
  TaskList,
  TaskLine,
  TableKit.configure({ table: { resizable: false } }),
  PaperImage,
  paperMention({ me: null, people: () => [], menu: new SuggestionMenuStore() }),
  BoardBlock,
  BoardLink,
])

describe("the AI's paper format", () => {
  it("loads the AI's paper in the real editor", () => {
    const doc = new Y.Doc()
    Y.applyUpdate(
      doc,
      Uint8Array.from(atob(sample.trim()), (char) => char.charCodeAt(0)),
    )
    const root = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment("default"), schema)
    root.check()
    const nodes = new Set([root.type.name])
    const marks = new Set<string>()
    root.descendants((node) => {
      nodes.add(node.type.name)
      for (const mark of node.marks) marks.add(mark.type.name)
    })
    expect([...nodes].sort()).toEqual([...NODES].sort())
    expect([...marks].sort()).toEqual([...MARKS].sort())
    const board = root.content.content.find((node) => node.type.name === "boardBlock")
    expect(doc.getMap("boards").get(board?.attrs.boardId as string)).toBeInstanceOf(Y.Map)
  })
})

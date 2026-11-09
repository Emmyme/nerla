import { createElement } from "react"
import { Extension, type Editor, type Range } from "@tiptap/core"
import { isChangeOrigin } from "@tiptap/extension-collaboration"
import { PluginKey } from "@tiptap/pm/state"
import Suggestion from "@tiptap/suggestion"
import {
  Board,
  CheckSquare,
  HeadingOne,
  HeadingThree,
  HeadingTwo,
  Image,
  Link,
  List,
  ListNumbers,
  Table,
  type IconComponent,
} from "@/components/icons"
import type { SuggestionMenuStore } from "../SuggestionMenu"
import { insertBoard } from "./boardBlock"

type SlashItem = { key: string; label: string; Icon: IconComponent; words: string; run: (editor: Editor) => void }

type SlashOptions = {
  menu: SuggestionMenuStore | null
  /** Null where images can't be added, as for a guest in a call */
  onImage: ((editor: Editor) => void) | null
  /** Null where boards can't be looked up, as for a guest in a call */
  onLinkBoard: ((editor: Editor) => void) | null
}

function slashItems({ onImage, onLinkBoard }: Pick<SlashOptions, "onImage" | "onLinkBoard">): SlashItem[] {
  const items: (SlashItem | null)[] = [
    {
      key: "h1",
      label: "Heading 1",
      Icon: HeadingOne,
      words: "title big",
      run: (e) => e.chain().focus().setNode("heading", { level: 1 }).run(),
    },
    {
      key: "h2",
      label: "Heading 2",
      Icon: HeadingTwo,
      words: "subtitle",
      run: (e) => e.chain().focus().setNode("heading", { level: 2 }).run(),
    },
    {
      key: "h3",
      label: "Heading 3",
      Icon: HeadingThree,
      words: "small",
      run: (e) => e.chain().focus().setNode("heading", { level: 3 }).run(),
    },
    { key: "list", label: "List", Icon: List, words: "bullet unordered", run: (e) => e.chain().focus().toggleBulletList().run() },
    {
      key: "numbered",
      label: "Numbered list",
      Icon: ListNumbers,
      words: "ordered",
      run: (e) => e.chain().focus().toggleOrderedList().run(),
    },
    { key: "checklist", label: "Checklist", Icon: CheckSquare, words: "todo task", run: (e) => e.chain().focus().toggleTaskList().run() },
    {
      key: "table",
      label: "Table",
      Icon: Table,
      words: "grid",
      run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    onImage && { key: "image", label: "Image", Icon: Image, words: "picture photo", run: onImage },
    {
      key: "board",
      label: "Board",
      Icon: Board,
      words: "draw whiteboard sketch",
      run: insertBoard,
    },
    onLinkBoard && { key: "link-board", label: "Link a board", Icon: Link, words: "board embed", run: onLinkBoard },
  ]
  return items.filter((item): item is SlashItem => item !== null)
}

const matches = (item: SlashItem, query: string) => {
  const typed = query.trim().toLowerCase()
  return !typed || item.label.toLowerCase().includes(typed) || item.words.includes(typed)
}

/** Typing `/` offers the blocks a paper can hold */
export const SlashMenu = Extension.create<SlashOptions>({
  name: "slashMenu",

  addOptions() {
    return { menu: null, onImage: null, onLinkBoard: null }
  },

  addProseMirrorPlugins() {
    const { menu } = this.options
    if (!menu) return []
    const items = slashItems(this.options)
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey("slashMenu"),
        char: "/",
        shouldShow: ({ transaction }) => !isChangeOrigin(transaction),
        allow: ({ editor }) => editor.isEditable,
        items: ({ query }) => items.filter((item) => matches(item, query)),
        render: menu.renderer<SlashItem>("Blocks", (item) => ({
          key: item.key,
          label: item.label,
          icon: createElement(item.Icon, { "aria-hidden": true, className: "size-[1rem]" }),
        })),
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => {
          editor.chain().focus().deleteRange(range).run()
          props.run(editor)
        },
      }),
    ]
  },
})

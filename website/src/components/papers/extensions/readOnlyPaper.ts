import { Extension } from "@tiptap/core"
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state"
import { ySyncPluginKey } from "@tiptap/y-tiptap"

/** Only changes that come in from the live paper go through. The selection may move freely */
const keepsPaper = (tr: Transaction) => !tr.docChanged || tr.getMeta(ySyncPluginKey) !== undefined

/**
 * For commenters: the paper stays editable to the browser, so a caret, the arrow keys and Shift selection all work,
 * while every change of their own is refused
 */
export const ReadOnlyPaper = Extension.create({
  name: "readOnlyPaper",

  addProseMirrorPlugins() {
    return [new Plugin({ key: new PluginKey("readOnlyPaper"), filterTransaction: keepsPaper })]
  },
})

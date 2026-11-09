import type { Editor } from "@tiptap/core"
import { TaskItem, type TaskItemOptions } from "@tiptap/extension-list"
import type { Node as PMNode } from "@tiptap/pm/model"
import type { EditorState } from "@tiptap/pm/state"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "@tiptap/y-tiptap"
import { TaskLineView } from "../TaskLineView"
import type { TaskSummaries } from "../taskSummaries"

export type MakeTaskRequest = { text: string; setTaskId: (taskId: string) => void }

type TaskLineOptions = TaskItemOptions & {
  summaries: TaskSummaries | null
  /** Null where tasks can't be made, as for a guest in a call */
  onMakeTask: ((request: MakeTaskRequest) => void) | null
}

/** Opens Make task for the current line, announced on its button */
const MAKE_TASK_KEYS = "Mod-Shift-Enter"
export const MAKE_TASK_ARIA = "Control+Shift+Enter Meta+Shift+Enter"

/** The innermost checklist line holding `pos` */
function lineAt(state: EditorState, pos: number): { pos: number; node: PMNode } | null {
  if (pos < 0 || pos > state.doc.content.size) return null
  const $pos = state.doc.resolve(pos)
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === "taskItem") return { pos: $pos.before(depth), node: $pos.node(depth) }
  }
  return null
}

/**
 * Asks for Make task on the line holding `pos`. The line is kept as a Yjs position, so it is still found when
 * other users edit the paper while the dialog is open
 */
export function requestTask(editor: Editor, pos: number, onMakeTask: ((request: MakeTaskRequest) => void) | null): boolean {
  const line = lineAt(editor.state, pos)
  if (!onMakeTask || !editor.isEditable || !line || line.node.attrs.taskId) return false
  const inside = line.pos + 2
  const sync = ySyncPluginKey.getState(editor.state)
  const anchor = sync?.binding ? absolutePositionToRelativePosition(inside, sync.type, sync.binding.mapping) : null
  onMakeTask({
    text: line.node.firstChild?.textContent.trim() ?? "",
    setTaskId: (taskId) => {
      if (editor.isDestroyed) return
      const now = ySyncPluginKey.getState(editor.state)
      const at = anchor && now?.binding ? relativePositionToAbsolutePosition(now.doc, now.type, anchor, now.binding.mapping) : inside
      const target = at === null ? null : lineAt(editor.state, at)
      if (!target || target.node.attrs.taskId) return
      editor
        .chain()
        .command(({ tr }) => (tr.setNodeAttribute(target.pos, "taskId", taskId), true))
        .run()
    },
  })
  return true
}

/** A checklist line, which can become a task. The line keeps the task's id in `taskId` */
export const TaskLine = TaskItem.extend<TaskLineOptions>({
  addOptions() {
    return { ...this.parent!(), nested: true, summaries: null, onMakeTask: null }
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      taskId: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-task-id"),
        renderHTML: (attributes: { taskId?: string | null }) => (attributes.taskId ? { "data-task-id": attributes.taskId } : {}),
      },
    }
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      [MAKE_TASK_KEYS]: ({ editor }) => requestTask(editor, editor.state.selection.from, this.options.onMakeTask),
    }
  },

  addNodeView() {
    // The list item itself, so the list holds only list items
    return ReactNodeViewRenderer(TaskLineView, {
      as: "li",
      attrs: ({ node }) => ({ "data-type": "taskItem", "data-checked": String(node.attrs.checked === true) }),
    })
  },
})

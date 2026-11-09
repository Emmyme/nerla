import { NodeViewContent, NodeViewWrapper, useEditorState, type ReactNodeViewProps } from "@tiptap/react"
import { isMac } from "@/components/call/shortcuts"
import { cn } from "@/lib/utils"
import { MAKE_TASK_ARIA, requestTask, type MakeTaskRequest } from "./extensions/taskLine"
import { TaskLineChip } from "./TaskLineChip"
import type { TaskSummaries } from "./taskSummaries"

type Options = { summaries: TaskSummaries | null; onMakeTask: ((request: MakeTaskRequest) => void) | null }

/** A checklist line with its box, its text, and the task it became or "Make task" while the caret is in it */
export function TaskLineView({ node, editor, getPos, updateAttributes, extension }: ReactNodeViewProps) {
  const options = extension.options as Options
  const checked = node.attrs.checked === true
  const taskId = typeof node.attrs.taskId === "string" ? node.attrs.taskId : null
  const text = node.firstChild?.textContent.trim() ?? ""

  // The caret's own line, never a line around it
  const current = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e.isEditable || taskId || !options.onMakeTask) return false
      const { $from } = e.state.selection
      for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type.name === "taskItem") return $from.before(depth) === getPos()
      }
      return false
    },
  })

  const toggle = (next: boolean) => {
    if (editor.isEditable) updateAttributes({ checked: next })
  }

  return (
    <NodeViewWrapper data-checked={checked} className={cn("paper-task", current && "is-current")}>
      <label contentEditable={false} className="paper-task-box">
        <input
          type="checkbox"
          checked={checked}
          disabled={!editor.isEditable}
          aria-label={text ? `Done: ${text}` : "Done"}
          onChange={(event) => toggle(event.target.checked)}
        />
      </label>
      <NodeViewContent as="div" className="paper-task-body" />
      <span contentEditable={false} className="paper-task-side">
        {taskId && options.summaries ? (
          <TaskLineChip taskId={taskId} summaries={options.summaries} />
        ) : (
          editor.isEditable &&
          options.onMakeTask && (
            <button
              type="button"
              tabIndex={current ? 0 : -1}
              aria-keyshortcuts={MAKE_TASK_ARIA}
              title={isMac() ? "Make task, ⌘ Shift Enter" : "Make task, Ctrl Shift Enter"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const pos = getPos()
                if (typeof pos === "number") requestTask(editor, pos + 1, options.onMakeTask)
              }}
              className="paper-task-make h-6 cursor-pointer rounded-md px-1.5 text-caption font-medium text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
            >
              Make task
            </button>
          )
        )}
      </span>
    </NodeViewWrapper>
  )
}

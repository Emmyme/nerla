import { useEffect, useRef, useState } from "react"
import { useEditorState, type Editor } from "@tiptap/react"
import { ChevronDown, ChevronUp, X } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { scrollBehavior } from "@/lib/motion"
import { findState } from "./extensions/findReplace"

const FIELD =
  "h-8 min-w-0 flex-1 rounded-md bg-app-sunk px-2.5 text-ui text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring max-lg:h-11"
const ICON_BUTTON =
  "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 max-lg:size-11"

/** Find in the paper, and replace for editors. Enter goes to the next match, Shift Enter back, Escape closes */
export function FindBar({ editor, canReplace, onClose }: { editor: Editor; canReplace: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("")
  const [replacement, setReplacement] = useState("")
  const field = useRef<HTMLInputElement>(null)
  const { count, index, from } = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const find = findState(e.state)
      return { count: find.matches.length, index: find.index, from: find.matches[find.index]?.from ?? null }
    },
  })

  // The current match comes into view, and the find field keeps focus
  useEffect(() => {
    if (from === null || editor.isDestroyed) return
    const { node } = editor.view.domAtPos(from)
    const element = node instanceof Element ? node : node.parentElement
    element?.scrollIntoView({ block: "center", behavior: scrollBehavior() })
  }, [editor, from, index])

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
    return () => {
      if (!editor.isDestroyed) editor.commands.setFindQuery("")
    }
  }, [editor])

  const close = () => {
    onClose()
    editor.commands.focus()
  }
  const status = query ? (count === 0 ? "No matches" : `${index + 1} of ${count}`) : ""

  return (
    <div
      role="search"
      aria-label="Find in paper"
      className="flex flex-col gap-2 rounded-lg bg-card p-2 shadow-[var(--shadow-popover)] ring-[0.0625rem] ring-border"
    >
      <div className="flex items-center gap-1.5">
        <input
          ref={field}
          type="search"
          aria-label="Find"
          placeholder="Find"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            editor.commands.setFindQuery(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              editor.commands.findStep(event.shiftKey ? -1 : 1)
            } else if (event.key === "Escape") {
              event.preventDefault()
              close()
            }
          }}
          className={`${FIELD} [&::-webkit-search-cancel-button]:hidden`}
        />
        <span aria-live="polite" className="w-[5.5rem] shrink-0 text-center text-caption text-muted-foreground tabular-nums">
          {status}
        </span>
        <button
          type="button"
          aria-label="Previous match"
          disabled={count === 0}
          onClick={() => editor.commands.findStep(-1)}
          className={ICON_BUTTON}
        >
          <ChevronUp aria-hidden="true" className="size-[0.95rem]" />
        </button>
        <button
          type="button"
          aria-label="Next match"
          disabled={count === 0}
          onClick={() => editor.commands.findStep(1)}
          className={ICON_BUTTON}
        >
          <ChevronDown aria-hidden="true" className="size-[0.95rem]" />
        </button>
        <button type="button" aria-label="Close find" onClick={close} className={ICON_BUTTON}>
          <X aria-hidden="true" className="size-[0.9rem]" />
        </button>
      </div>
      {canReplace && (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            aria-label="Replace with"
            placeholder="Replace with"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                editor.commands.replaceMatch(replacement)
              } else if (event.key === "Escape") {
                event.preventDefault()
                close()
              }
            }}
            className={FIELD}
          />
          <Button type="button" variant="secondary" disabled={count === 0} onClick={() => editor.commands.replaceMatch(replacement)}>
            Replace
          </Button>
          <Button type="button" variant="secondary" disabled={count === 0} onClick={() => editor.commands.replaceAllMatches(replacement)}>
            Replace all
          </Button>
        </div>
      )}
    </div>
  )
}

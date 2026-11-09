import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react"
import { MentionContext } from "@/components/chat/MentionPicker"
import { isMac } from "@/components/call/shortcuts"
import { X } from "@/components/icons"
import { TaskPanelSheet } from "@/components/tasks/TaskPanelSheet"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import type { CommentAnchor, CommentThread } from "@/lib/api/papers"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { cn } from "@/lib/utils"
import { NewThread, Thread, type AnchorView } from "./CommentThread"
import type { DocComments, Pending } from "./commentsStore"

export const COMMENT_SHORTCUT = "Control+Alt+M Meta+Alt+M"
export const commentsTitle = () => (isMac() ? "Comments, ⌘ ⌥ M" : "Comments, Ctrl Alt M")
/** Mod Alt M, read from the key's place so it works on every layout, Option and AltGr included */
const isCommentShortcut = (event: Pick<globalThis.KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code">) =>
  (event.ctrlKey || event.metaKey) && event.altKey && !event.shiftKey && event.code === "KeyM"

/**
 * Mod Alt M for one host. With `within` it only counts there, otherwise it skips dialogs, which have their own. Keys
 * typed in a side panel are the panel's
 */
export function useCommentShortcut(
  run: () => void,
  { enabled = true, within }: { enabled?: boolean; within?: RefObject<HTMLElement | null> } = {},
) {
  const latest = useRef(run)
  latest.current = run
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isCommentShortcut(event)) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest("[data-side-panel]")) return
      if (within ? !(target && within.current?.contains(target)) : target?.closest('[role="dialog"]')) return
      event.preventDefault()
      latest.current()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, within])
}

/** The doc's side panel: a column beside the doc on desktop, a full screen sheet on phones. Escape closes it */
export function SidePanel({
  title,
  onClose,
  autoFocus = true,
  className,
  children,
}: {
  title: string
  onClose: () => void
  /** False when it opens from a click in the doc, which keeps focus there */
  autoFocus?: boolean
  className?: string
  children: ReactNode
}) {
  const desktop = useIsDesktop()
  const root = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const headingId = useId()

  useLayoutEffect(() => {
    const active = document.activeElement
    if (!opener.current && active instanceof HTMLElement && active !== document.body) opener.current = active
  }, [])
  // A child that wants focus, such as a new comment's field, takes it first
  const focusFirst = useRef(autoFocus)
  useEffect(() => {
    if (desktop && focusFirst.current && !root.current?.contains(document.activeElement)) heading.current?.focus()
  }, [desktop])

  const close = () => {
    const back = opener.current
    onClose()
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (back?.isConnected && (!active || active === document.body)) back.focus()
    })
  }

  const header = (
    <header className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
      <h2
        ref={heading}
        id={headingId}
        tabIndex={-1}
        className="min-w-0 flex-1 truncate text-body font-semibold text-foreground outline-none"
      >
        {title}
      </h2>
      <button
        type="button"
        aria-label={`Close ${title.toLowerCase()}`}
        title="Close"
        onClick={close}
        className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:size-11"
      >
        <X aria-hidden="true" className="size-[1rem]" />
      </button>
    </header>
  )

  if (!desktop) {
    return (
      <TaskPanelSheet open onOpenChange={(open) => !open && onClose()} label={title}>
        {header}
        {children}
      </TaskPanelSheet>
    )
  }
  return (
    <aside
      ref={root}
      data-side-panel=""
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return
        event.preventDefault()
        close()
      }}
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl bg-card text-foreground ring-[0.0625rem] ring-border", className)}
    >
      {header}
      {children}
    </aside>
  )
}

function PanelSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2 px-3">
      <Skeleton className="h-[5rem] rounded-lg" />
      <Skeleton className="h-[4rem] rounded-lg" />
    </div>
  )
}

/** The comments panel for papers and boards. The host says where each thread sits and how to show it */
export function CommentsPanel({
  comments,
  pending,
  onPendingDone,
  viewOf,
  emptyText,
  onNew,
  onClose,
  autoFocus,
  className,
}: {
  comments: DocComments
  /** The words or spot a new comment is about to go on */
  pending: Pending | null
  onPendingDone: (posted: CommentThread | null) => void
  viewOf: (anchor: CommentAnchor | null, thread: CommentThread | null) => AnchorView
  emptyText: string
  /** Starts a new comment where the host decides, shown while none is being written */
  onNew?: () => void
  onClose: () => void
  autoFocus?: boolean
  className?: string
}) {
  const list = useRef<HTMLDivElement>(null)
  const done = (posted: CommentThread | null) => {
    onPendingDone(posted)
    if (posted) requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-thread="${posted.root.id}"]`)?.focus())
  }
  const pendingView = pending ? viewOf(pending.anchor, null) : null

  return (
    <MentionContext.Provider value={comments.scope}>
      <SidePanel title="Comments" onClose={onClose} autoFocus={autoFocus} className={className}>
        <div ref={list} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
          {pending ? (
            <NewThread label={pendingView?.label ?? ""} comments={comments} pending={pending} onDone={done} />
          ) : (
            onNew && (
              <Button type="button" variant="secondary" onClick={onNew} className="self-start">
                New comment
              </Button>
            )
          )}
          {comments.status === "loading" ? (
            <>
              <span role="status" className="sr-only">
                Loading comments
              </span>
              <PanelSkeleton />
            </>
          ) : comments.status === "error" ? (
            <p role="alert" className="px-1 text-ui text-app-berry-text">
              Couldn't load the comments.{" "}
              <button type="button" onClick={comments.reload} className="cursor-pointer font-medium underline underline-offset-2">
                Try again
              </button>
            </p>
          ) : comments.threads.length === 0 && !pending ? (
            <p className="px-1 py-2 text-ui text-muted-foreground">{emptyText}</p>
          ) : (
            <ol aria-label="Threads" className="flex flex-col gap-2">
              {comments.threads.map((thread) => (
                <Thread key={thread.root.id} thread={thread} comments={comments} view={viewOf(thread.root.anchor, thread)} />
              ))}
            </ol>
          )}
        </div>
      </SidePanel>
    </MentionContext.Provider>
  )
}

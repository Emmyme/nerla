import { lazy, memo, Suspense, useEffect, useRef, type KeyboardEvent } from "react"
import { ArrowsOutSimple, Minus, X } from "@/components/icons"
import { Button } from "@/components/ui/button"
import type { ChatSummary } from "@/lib/api/chat"
import { cn } from "@/lib/utils"
import { Conversation } from "./Conversation"
import { IconTip } from "@/components/ui/icon-tip"

const AiConversation = lazy(() => import("@/components/ai/AiConversation"))

const CONTROL = "size-7 shrink-0 text-muted-foreground hover:text-foreground"

/** One conversation docked along the bottom. It folds to its title bar, opens on the Chat page or closes. No chat means the user's DM with the AI */
export const DockWindow = memo(function DockWindow({
  dockKey,
  chat,
  me,
  minimized,
  hidden,
  visible,
  focusRequest,
  onFocused,
  onMinimize,
  onClose,
  onExpand,
}: {
  dockKey: string
  chat: ChatSummary | null
  me: string
  minimized: boolean
  /** Open but out of view, as when it does not fit beside the list */
  hidden: boolean
  /** False while out of sight, so nothing counts as read */
  visible: boolean
  /** Changes when the user opens this window, which focuses its composer */
  focusRequest: number
  onFocused: () => void
  onMinimize: (key: string, minimized: boolean) => void
  onClose: (key: string) => void
  onExpand: (chat: ChatSummary | null) => void
}) {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!focusRequest) return
    // The AI's conversation loads on first open, so its composer can take a few frames to arrive
    let frames = 30
    let raf = 0
    const focus = () => {
      const field = root.current?.querySelector<HTMLTextAreaElement>("textarea")
      if (field) {
        field.focus()
        onFocused()
      } else if (frames-- > 0) raf = requestAnimationFrame(focus)
      else onFocused()
    }
    focus()
    return () => cancelAnimationFrame(raf)
  }, [focusRequest, onFocused])

  const toggle = () => onMinimize(dockKey, !minimized)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || minimized || (e.target as HTMLElement).closest('[role="dialog"]')) return
    e.preventDefault()
    root.current?.querySelector<HTMLElement>("[data-dock-title]")?.focus()
    onMinimize(dockKey, true)
  }

  const close = (
    <IconTip label="Close">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Close"
        onClick={() => onClose(dockKey)}
        className={cn(CONTROL, minimized && "rounded-full")}
      >
        <X aria-hidden="true" className="size-4" />
      </Button>
    </IconTip>
  )
  // Folded down, the window is a chip like the chat bar: its title opens it again
  const controls = minimized ? (
    close
  ) : (
    <>
      <IconTip label="Minimize">
        <Button type="button" variant="ghost" size="icon" aria-label="Minimize" onClick={toggle} className={CONTROL}>
          <Minus aria-hidden="true" className="size-4" />
        </Button>
      </IconTip>
      <IconTip label="Open in Chat">
        <Button type="button" variant="ghost" size="icon" aria-label="Open in Chat" onClick={() => onExpand(chat)} className={CONTROL}>
          <ArrowsOutSimple aria-hidden="true" className="size-4" />
        </Button>
      </IconTip>
      {close}
    </>
  )

  return (
    <div
      ref={root}
      onKeyDown={onKeyDown}
      data-dock-window={dockKey}
      data-minimized={minimized ? "" : undefined}
      className={cn(
        "pointer-events-auto flex shrink-0 origin-bottom flex-col overflow-hidden border border-border bg-popover shadow-[var(--shadow-popover)]",
        // Each form eases in as it takes over: the window rises open, and the folded chip settles in place
        minimized
          ? "motion-chip-in h-9 max-w-64 rounded-full"
          : "motion-panel h-112 w-80 rounded-xl animate-in fade-in-0 motion-safe:slide-in-from-bottom-4",
        hidden && "hidden",
      )}
    >
      {chat ? (
        <Conversation
          chat={chat}
          me={me}
          onLeft={() => onClose(dockKey)}
          active={visible && !minimized}
          compact={{ minimized, onToggle: toggle, controls }}
        />
      ) : (
        <Suspense fallback={null}>
          <AiConversation active={visible && !minimized} compact={{ minimized, onToggle: toggle, controls }} />
        </Suspense>
      )}
    </div>
  )
})

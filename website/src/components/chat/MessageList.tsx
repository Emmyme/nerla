import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { LoadingSpinner } from "@/components/ui/spinner"
import { useIsDesktop } from "@/lib/useMediaQuery"
import type { ChatKind } from "@/lib/api/chat"
import { FILE_PLACEHOLDER } from "@/lib/chatModel"
import type { ChatStatus, StoreMessage } from "@/lib/chatStore"
import { renderMentionText, type MentionNames } from "@/lib/mentions"
import { cn, TAP } from "@/lib/utils"
import { personName } from "./ChatListRow"
import { useMentionScope } from "./MentionPicker"
import { groupMessages } from "./messageGroups"
import { MessageItem, type MessageActions } from "./MessageItem"

// Within this many px of an edge counts as being there, measured like the scroll position itself
const NEAR_BOTTOM = 96
const NEAR_TOP = 320
const RETRY_MS = 5000

function DaySeparator({ label }: { label: string }) {
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-3 pt-5 pb-1">
      <span className="h-px flex-1 bg-border" />
      <span className="text-caption font-medium text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

const rowOf = (scroller: HTMLElement, id: string) => scroller.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)

function announcementOf(message: StoreMessage, names: MentionNames): string {
  const what =
    message.kind === "call"
      ? "Started a call"
      : message.content === FILE_PLACEHOLDER
        ? "Sent an attachment"
        : renderMentionText(message.content, names)
  return `${personName(message.sender)}: ${what}`
}

export function MessageList({
  messages,
  me,
  kind,
  chatId,
  canPin,
  status,
  error,
  hasOlder,
  loadingOlder,
  loadOlder,
  hasNewer = false,
  loadNewer,
  onRetry,
  editingId,
  highlightId,
  intro,
  actions,
  scrollerRef,
  compact = false,
  footer,
}: {
  messages: StoreMessage[]
  me: string
  kind: ChatKind
  chatId: string
  canPin: boolean
  status: ChatStatus
  error: string | null
  hasOlder: boolean
  loadingOlder: boolean
  loadOlder: () => Promise<void>
  /** Showing a page around an older message, so newer pages load on the way down */
  hasNewer?: boolean
  loadNewer?: () => Promise<void>
  onRetry: () => void
  editingId: string | null
  highlightId: string | null
  /** What an empty conversation shows, just above the composer */
  intro: ReactNode
  actions: MessageActions
  scrollerRef: RefObject<HTMLDivElement>
  compact?: boolean
  /** Below the newest message, such as the AI's cards for the user in this chat */
  footer?: ReactNode
}) {
  const desktop = useIsDesktop()
  const stick = useRef(true)
  // Newer pages join below, so the view never follows the bottom while there are more of them
  const lastTop = useRef(0)
  const following = useRef(!hasNewer)
  following.current = !hasNewer
  // The row that was first when an older page was asked for, and how far below the top of the view it sat
  const anchor = useRef<{ firstId: string; offset: number } | null>(null)
  const lastId = useRef<string | undefined>(undefined)
  const firstId = useRef<string | undefined>(undefined)
  const retryAt = useRef(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  // Every message this list has shown, so a delete or a discarded send never reads out an older one as new
  const seen = useRef<Set<string> | null>(null)
  const { names } = useMentionScope()
  const namesNow = useRef(names)
  namesNow.current = names
  const [announcement, setAnnouncement] = useState<{ id: string; text: string } | null>(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the clock is read again each time the messages change
  const now = useMemo(() => new Date(), [messages])
  const blocks = useMemo(() => groupMessages(messages, now), [messages, now])
  const tabbableId = activeId && messages.some((m) => m.id === activeId) ? activeId : messages.at(-1)?.id

  const older = () => {
    const node = scrollerRef.current
    const first = messages[0]
    if (!node || !first || !hasOlder || loadingOlder || anchor.current || Date.now() < retryAt.current) return
    const row = rowOf(node, first.id)
    anchor.current = { firstId: first.id, offset: row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : 0 }
    void loadOlder().finally(() =>
      requestAnimationFrame(() => {
        // Nothing was added, so there is nothing to hold in place, and a failure waits before asking again
        if (!anchor.current || firstId.current !== anchor.current.firstId) return
        anchor.current = null
        retryAt.current = Date.now() + RETRY_MS
      }),
    )
  }

  // Older messages keep the view where it was, new ones follow the bottom when it was in view
  useLayoutEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    const first = messages[0]?.id
    const last = messages.at(-1)
    const appended = !!last && lastId.current !== undefined && last.id !== lastId.current
    if (anchor.current && first !== anchor.current.firstId) {
      // The old first row goes back where it was, so a message arriving meanwhile cannot move the view
      const row = rowOf(node, anchor.current.firstId)
      if (row) node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.current.offset
      anchor.current = null
    } else if (following.current && (stick.current || (appended && last.sender_id === me))) {
      node.scrollTop = node.scrollHeight
      stick.current = true
    }
    // What the first page brings is history, so tracking starts once the conversation has loaded
    const known = seen.current
    if (known && last && !known.has(last.id) && last.sender_id !== me && !last.id.startsWith("temp-"))
      setAnnouncement({ id: last.id, text: announcementOf(last, namesNow.current) })
    if (known || status === "ready") {
      const next = new Set(known)
      for (const message of messages) next.add(message.id)
      seen.current = next
    }
    lastId.current = last?.id
    firstId.current = first
  }, [messages, me, scrollerRef, status])

  // Late layout, such as fonts or a preview settling, keeps the bottom in view when it was there
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = content.current
    if (!node || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      const scroller = scrollerRef.current
      if (scroller && following.current && stick.current && !anchor.current) scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [scrollerRef])

  // A first page shorter than the view cannot be scrolled up, so it asks for more itself
  useEffect(() => {
    const node = scrollerRef.current
    if (node && status === "ready" && hasOlder && !loadingOlder && node.scrollHeight <= node.clientHeight + NEAR_TOP) older()
  })

  const onScroll = () => {
    const node = scrollerRef.current
    if (!node) return
    stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_BOTTOM
    if (node.scrollTop < NEAR_TOP) older()
    // Only on the way down, so the jump that lands on a message does not fetch past it by itself
    const down = node.scrollTop > lastTop.current
    lastTop.current = node.scrollTop
    if (hasNewer && down && node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_TOP) void loadNewer?.()
  }

  // Arrow keys move between messages, so the list is one tab stop
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || !(e.target as HTMLElement).hasAttribute("data-message-row")) return
    const rows = [...(scrollerRef.current?.querySelectorAll<HTMLElement>("[data-message-row]") ?? [])]
    const next = rows[rows.indexOf(e.target as HTMLElement) + (e.key === "ArrowUp" ? -1 : 1)]
    if (!next) return
    e.preventDefault()
    next.focus()
  }

  let body
  if (status === "loading" && messages.length === 0) {
    body = (
      <div aria-label="Loading messages" className="flex flex-col gap-5 pt-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          </div>
        ))}
      </div>
    )
  } else if (status === "error" && messages.length === 0) {
    body = (
      <div role="alert" className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-ui text-muted-foreground">{error ?? "Couldn't load the chat."}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    )
  } else if (messages.length === 0) {
    body = <div className="flex flex-1 flex-col justify-end pt-10 pb-2">{intro}</div>
  } else {
    // One flat row per message, keyed by the message, so a page merging into a group never remounts a row
    const rows: ReactNode[] = []
    for (const block of blocks) {
      if (block.kind === "day") {
        rows.push(<DaySeparator key={`day-${block.label}`} label={block.label} />)
        continue
      }
      block.items.forEach((message, index) => {
        const lead = index === 0
        rows.push(
          // The gap above a run is outside the row, so the hover fill and the action bar stay with their message
          <div key={message.client_id || message.id} className={lead ? "pt-3" : "pt-0.5"}>
            <MessageItem
              message={message}
              me={me}
              kind={kind}
              chatId={chatId}
              canPin={canPin}
              lead={lead}
              editing={editingId === message.id}
              tabbable={tabbableId === message.id}
              highlighted={highlightId === message.id}
              actions={actions}
              touch={!desktop}
              compact={compact}
            />
          </div>,
        )
      })
    }
    body = (
      <>
        <div className="flex h-10 items-center justify-center">
          {loadingOlder ? (
            <LoadingSpinner />
          ) : error && hasOlder ? (
            <p role="alert" className="flex items-center gap-2 text-caption text-muted-foreground">
              Couldn't load older messages.
              <button
                type="button"
                onClick={() => {
                  retryAt.current = 0
                  older()
                }}
                className={cn("font-medium text-foreground underline-offset-2 hover:underline", TAP)}
              >
                Try again
              </button>
            </p>
          ) : !hasOlder ? (
            <span className="text-caption text-muted-foreground">Start of the conversation</span>
          ) : null}
        </div>
        {rows}
        {!hasNewer && footer}
        {hasNewer && (
          <div className="flex h-10 items-center justify-center">
            <LoadingSpinner />
          </div>
        )}
      </>
    )
  }

  return (
    <>
      {/* Only new messages from others are read out, never a page of older ones */}
      <p aria-live="polite" data-chat-announcer="" className="sr-only">
        {/* A new node per message, so two identical messages in a row are both read out */}
        {announcement && <span key={announcement.id}>{announcement.text}</span>}
      </p>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          const id = (e.target as HTMLElement).closest("[data-message-row]")?.getAttribute("data-message-id")
          if (id) setActiveId(id)
        }}
        role="region"
        aria-label="Messages"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div ref={content} className={cn("flex min-h-full flex-col", compact ? "px-3 pb-3" : "px-4 pb-4 lg:px-6")}>
          {body}
        </div>
      </div>
    </>
  )
}

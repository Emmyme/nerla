import { FirstTip } from "@/components/onboarding/FirstTip"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { toast } from "sonner"
import type { CompactHeader } from "@/components/chat/ConversationHeader"
import { IconTip } from "@/components/ui/icon-tip"
import { MenuPopover, useMenuButton } from "@/components/files/ActionMenu"
import { ArrowLeft, Ellipsis, Send, Stop, Trash } from "@/components/icons"
import { BellSlot } from "@/components/notifications/BellSlot"
import { ConfirmDialog } from "@/components/settings/ConfirmDialog"
import { AutosizeTextarea } from "@/components/ui/autosize-textarea"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { LoadingSpinner } from "@/components/ui/spinner"
import { TypingDots } from "@/components/ui/typing-dots"
import type { AiHeld, AiMessage } from "@/lib/api/ai"
import {
  answerCard,
  askAi,
  clearAiChat,
  ensureAiThread,
  loadOlderAi,
  stopAi,
  useAiSelect,
  useAiTeammate,
  useAiViewing,
} from "@/lib/aiStore"
import { formatTime, parseServerDate } from "@/lib/dates"
import { messageOf } from "@/lib/taskStore"
import { cn, TAP } from "@/lib/utils"
import { AiBadge, AiFace } from "./AiAvatar"
import { plainText } from "./aiMarkdown"
import AiText from "./AiText"
import { HeldCard } from "./HeldCard"

const MAX_ASK = 20_000
const GROUP_MS = 5 * 60 * 1000
const NEAR_BOTTOM = 96
const NEAR_TOP = 320
const SEND_FAILED = "Couldn't send. Check your connection and try again."
const CLEAR_FAILED = "Couldn't clear your chat. Check your connection and try again."

// Unsent text survives closing the window for the session
let draft = ""

type Item =
  | { kind: "message"; key: string; at: number; message: AiMessage }
  | { kind: "card"; key: string; at: number; held: AiHeld }
  | { kind: "typing"; key: string; at: number }

const timeOf = (value: string) => parseServerDate(value)?.getTime() ?? Date.now()

// The cat beside the bell already tells screen readers the AI is working, so the dots stay quiet
function Typing() {
  return (
    <span className="flex h-6 items-center text-muted-foreground">
      <TypingDots />
    </span>
  )
}

function AssistantRow({ lead, name, at, children }: { lead: boolean; name: string; at: string | null; children: ReactNode }) {
  return (
    <div className="flex gap-3 px-0 py-0.5">
      <div className="w-8 shrink-0">{lead && <AiFace size={2} className="mt-0.5" />}</div>
      <div className="flex max-w-[min(36rem,85%)] min-w-0 flex-1 flex-col items-start max-lg:max-w-full">
        {lead && (
          <p className="flex max-w-full items-center gap-2">
            <span className="truncate text-ui font-semibold text-foreground">{name}</span>
            <AiBadge />
            {at && <span className="shrink-0 text-caption text-muted-foreground tabular-nums">{formatTime(at)}</span>}
          </p>
        )}
        {children}
      </div>
    </div>
  )
}

const NOTE: Partial<Record<AiMessage["status"], string>> = {
  stopped: "Stopped",
  failed: "This answer didn't finish",
}

/** The chat's own menu, with Clear chat behind a confirm */
function ChatMenu({ compact, className }: { compact?: boolean; className?: string }) {
  const menu = useMenuButton()
  const [confirming, setConfirming] = useState(false)
  const empty = useAiSelect(
    (s) => s.thread.messages.length === 0 && !s.held.some((card) => card.source === "ai" && card.place?.kind === "dm"),
  )
  const button = (
    <Button
      ref={menu.button}
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Chat menu"
      aria-haspopup="menu"
      aria-expanded={menu.open}
      onClick={menu.toggle}
      onKeyDown={menu.onKeyDown}
      className={cn(
        "shrink-0",
        compact && "size-7 text-muted-foreground hover:text-foreground max-lg:size-7",
        menu.open && "bg-app-hover text-foreground",
        className,
      )}
    >
      <Ellipsis aria-hidden="true" weight="bold" className={compact ? "size-4" : "size-5"} />
    </Button>
  )
  return (
    <>
      {compact ? <IconTip label="Chat menu">{button}</IconTip> : button}
      <MenuPopover
        {...menu.popover}
        label="Chat menu"
        entries={[{ label: "Clear chat", Icon: Trash, danger: true, disabled: empty, run: () => setConfirming(true) }]}
      />
      <ConfirmDialog
        open={confirming}
        title="Clear this chat?"
        confirmLabel="Clear chat"
        busyLabel="Clearing"
        failed={CLEAR_FAILED}
        onConfirm={clearAiChat}
        onClose={() => setConfirming(false)}
        fallbackFocus={() => menu.button.current}
      >
        Its messages and summary are deleted for good. What the AI did stays done.
      </ConfirmDialog>
    </>
  )
}

function Header({ name, onBack, compact }: { name: string; onBack?: () => void; compact?: CompactHeader }) {
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (onBack) back.current?.focus()
  }, [onBack])

  if (compact) {
    const { minimized, onToggle, controls } = compact
    return (
      <header className={cn("flex shrink-0 items-center gap-1", minimized ? "h-full px-1" : "h-11 border-b border-border px-1.5")}>
        <button
          type="button"
          data-dock-title=""
          onClick={onToggle}
          aria-expanded={!minimized}
          aria-label={name}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 text-left transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
            minimized ? "h-8 rounded-full pr-1.5" : "h-9 rounded-md px-1",
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center">
            <AiFace size={1.5} />
          </span>
          <span className="truncate text-ui font-medium text-foreground">{name}</span>
          <AiBadge />
        </button>
        {!minimized && <ChatMenu compact />}
        {controls}
      </header>
    )
  }

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
      {onBack && (
        <Button ref={back} type="button" variant="ghost" size="icon" aria-label="Back to chats" onClick={onBack} className="-ml-2 shrink-0">
          <ArrowLeft aria-hidden="true" className="size-5" />
        </Button>
      )}
      <span className="flex size-9 shrink-0 items-center justify-center">
        <AiFace size={2} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="flex min-w-0 items-center gap-2 text-lead font-semibold text-foreground">
          <span className="truncate">{name}</span>
          <AiBadge />
        </h2>
        <p className="truncate text-caption text-muted-foreground">Only you see this conversation</p>
      </div>
      <ChatMenu className={onBack ? "-mr-2" : undefined} />
      {!onBack && <BellSlot />}
    </header>
  )
}

/** The user's DM with the AI teammate: the thread, typing dots with Stop while it works, and its cards inline */
export default function AiConversation({
  onBack,
  compact,
  active = true,
}: {
  onBack?: () => void
  compact?: CompactHeader
  active?: boolean
}) {
  const teammate = useAiTeammate()
  const name = teammate?.name ?? "Nerla AI"
  const thread = useAiSelect((s) => s.thread)
  const running = useAiSelect((s) => s.running)
  const inDm = useAiSelect((s) => s.inDm)
  const held = useAiSelect((s) => s.held)
  const [text, setText] = useState(draft)
  const [stopping, setStopping] = useState(false)
  const [olderFailed, setOlderFailed] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const rows = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  const before = useRef<number | null>(null)
  const seen = useRef<Set<string> | null>(null)
  const [announcement, setAnnouncement] = useState<{ id: string; text: string } | null>(null)
  const minimized = !!compact?.minimized
  useAiViewing(active && !minimized)

  useEffect(() => ensureAiThread(), [])
  useEffect(() => {
    draft = text
  }, [text])

  const working = running.filter((id) => inDm.includes(id))
  const current = working[working.length - 1] ?? null

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [
      ...thread.messages.map((message): Item => ({
        kind: "message",
        key: message.clientId || message.id,
        at: timeOf(message.createdAt),
        message,
      })),
      ...held
        .filter((card) => card.source === "ai" && card.place?.kind === "dm")
        .map((card): Item => ({ kind: "card", key: `card-${card.id}`, at: timeOf(card.createdAt), held: card })),
    ]
    list.sort((a, b) => a.at - b.at)
    // The answer lands a moment before its request ends, and the dots go with it
    const answered = thread.messages.some((m) => m.role === "assistant" && m.requestId === current)
    if (current && !answered) list.push({ kind: "typing", key: `typing-${current}`, at: Date.now() })
    return list
  }, [thread.messages, held, current])

  const pin = useCallback(() => {
    const node = scroller.current
    if (node && stick.current) node.scrollTop = node.scrollHeight
  }, [])

  // The bottom stays in view while it was, and an older page keeps the view where it was
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    if (items.length === 0) stick.current = true
    if (before.current !== null) {
      node.scrollTop += node.scrollHeight - before.current
      before.current = null
    } else pin()
  }, [items, pin])

  // Opening the window always shows the last message
  useLayoutEffect(() => {
    if (minimized) return
    stick.current = true
    pin()
  }, [minimized, pin])

  // Folded or hidden, the list has no height to scroll, and messages and cards still grow after they render
  useEffect(() => {
    const node = scroller.current
    const inner = rows.current
    if (!node || !inner || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(pin)
    observer.observe(node)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [pin])

  // Only answers that arrive while open are read out, never the history
  useEffect(() => {
    if (thread.status !== "ready") return
    const known = seen.current
    const next = new Set(thread.messages.map((m) => m.id))
    if (known) {
      const fresh = thread.messages.filter((m) => !known.has(m.id) && m.role === "assistant")
      const last = fresh[fresh.length - 1]
      if (last) setAnnouncement({ id: last.id, text: `${name}: ${plainText(last.content)}` })
    }
    seen.current = next
  }, [thread.messages, thread.status, name])

  const older = () => {
    const node = scroller.current
    if (!node || !thread.hasOlder || thread.loadingOlder) return
    before.current = node.scrollHeight
    setOlderFailed(false)
    loadOlderAi().catch(() => {
      before.current = null
      setOlderFailed(true)
    })
  }

  const onScroll = () => {
    const node = scroller.current
    if (!node) return
    stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_BOTTOM
    if (node.scrollTop < NEAR_TOP && !olderFailed) older()
  }

  const content = text.trim()
  const canSend = !!content && content.length <= MAX_ASK && !current

  const send = () => {
    if (!canSend) return
    setText("")
    stick.current = true
    askAi(content).catch((err: unknown) => {
      setText((shown) => shown || content)
      toast.error(messageOf(err, SEND_FAILED))
    })
    field.current?.focus()
  }

  const stop = async () => {
    if (!current || stopping) return
    setStopping(true)
    try {
      await stopAi(current)
    } catch (err) {
      toast.error(messageOf(err, "Couldn't stop it. Try again."))
    } finally {
      setStopping(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  let body
  if (thread.status !== "ready" && thread.messages.length === 0) {
    body =
      thread.status === "error" ? (
        <div role="alert" className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-ui text-muted-foreground">Couldn't load your chat with {name}.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => ensureAiThread()}>
            Try again
          </Button>
        </div>
      ) : (
        <div aria-label="Loading messages" className="flex flex-col gap-5 pt-6">
          {[0, 1].map((i) => (
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
  } else if (items.length === 0) {
    body = (
      <div className="flex flex-1 flex-col justify-end pt-10 pb-2">
        <div className="flex flex-col items-start gap-3">
          <AiFace size={3} />
          <div className="flex flex-col gap-1">
            <p className="flex items-center gap-2 text-title font-semibold text-foreground">
              {name}
              <AiBadge />
            </p>
            <p className="text-ui text-muted-foreground">Ask {name} about your work. It sees only what you can see.</p>
          </div>
        </div>
      </div>
    )
  } else {
    body = (
      <>
        <div className="flex h-10 items-center justify-center">
          {thread.loadingOlder ? (
            <LoadingSpinner />
          ) : olderFailed ? (
            <p role="alert" className="flex items-center gap-2 text-caption text-muted-foreground">
              Couldn't load older messages.
              <button
                type="button"
                onClick={() => {
                  setOlderFailed(false)
                  older()
                }}
                className={cn("font-medium text-foreground underline-offset-2 hover:underline", TAP)}
              >
                Try again
              </button>
            </p>
          ) : !thread.hasOlder ? (
            <span className="text-caption text-muted-foreground">Start of the conversation</span>
          ) : null}
        </div>
        {items.map((item, index) => {
          const prev = items[index - 1]
          const role = item.kind === "message" ? item.message.role : item.kind === "typing" ? "assistant" : null
          const prevRole = prev?.kind === "message" ? prev.message.role : prev?.kind === "typing" ? "assistant" : null
          const lead = !prev || role !== prevRole || item.at - prev.at > GROUP_MS
          const gap = lead ? "pt-3" : "pt-0.5"
          if (item.kind === "card") {
            return (
              <div key={item.key} className="flex gap-3 pt-3">
                <div className="w-8 shrink-0" />
                <HeldCard
                  held={item.held}
                  aiName={name}
                  onAnswer={(decision, chosen) => answerCard(item.held, decision, chosen)}
                  className="max-w-[min(36rem,85%)] min-w-0 flex-1 max-lg:max-w-full"
                />
              </div>
            )
          }
          if (item.kind === "typing") {
            return (
              <div key={item.key} className={gap} aria-busy="true">
                <AssistantRow lead={lead} name={name} at={null}>
                  <Typing />
                </AssistantRow>
              </div>
            )
          }
          const { message } = item
          if (message.role === "user") {
            return (
              <div key={item.key} className={cn("flex justify-end", gap)}>
                <p
                  title={formatTime(message.createdAt)}
                  className={cn(
                    "max-w-[min(40rem,85%)] rounded-lg bg-app-sky-soft px-3 py-1.5 text-body leading-normal break-words whitespace-pre-wrap text-app-sky-ink max-lg:max-w-[90%]",
                    message.id.startsWith("temp-") && "opacity-60",
                  )}
                >
                  {message.content}
                </p>
              </div>
            )
          }
          const note = NOTE[message.status]
          return (
            <div key={item.key} className={gap}>
              <AssistantRow lead={lead} name={name} at={message.createdAt}>
                {message.content && <AiText text={message.content} />}
                {note && <p className="mt-0.5 text-caption text-muted-foreground">{note}</p>}
              </AssistantRow>
            </div>
          )
        })}
      </>
    )
  }

  return (
    <section
      aria-label={name}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", compact ? "bg-popover" : "bg-card", !minimized && "h-full")}
    >
      <Header name={name} onBack={onBack} compact={compact} />
      <div className={cn("flex min-h-0 flex-1 flex-col", minimized && "hidden")}>
        <FirstTip id="ai" className={compact ? "mx-3 mt-2" : "mx-4 mt-3 lg:mx-6"} />
        <p aria-live="polite" className="sr-only">
          {announcement && <span key={announcement.id}>{announcement.text}</span>}
        </p>
        <div
          ref={scroller}
          onScroll={onScroll}
          role="region"
          aria-label="Messages"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div ref={rows} className={cn("flex min-h-full flex-col", compact ? "px-3 pb-3" : "px-4 pb-4 lg:px-6")}>
            {body}
          </div>
        </div>
        <div className={cn("shrink-0", compact ? "px-3 pt-1 pb-3" : "px-4 pt-2 pb-4 lg:px-6")}>
          <div className="flex items-end gap-1 rounded-lg border border-input bg-card p-1 transition-colors duration-150 focus-within:border-muted-foreground has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-ring has-[textarea:focus-visible]:ring-offset-2 has-[textarea:focus-visible]:ring-offset-background">
            <AutosizeTextarea
              ref={field}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              maxLength={MAX_ASK}
              placeholder={`Message ${name}`}
              aria-label={`Message ${name}`}
              cap={compact ? "max-h-32" : "max-h-48"}
              containerClassName="min-w-0 flex-1"
              className="w-full bg-transparent px-1.5 py-1.5 text-body leading-normal text-foreground placeholder:text-muted-foreground focus-visible:outline-none max-lg:py-2.5"
            />
            {current ? (
              <Button
                type="button"
                size="icon"
                aria-label="Stop"
                title="Stop"
                onClick={() => void stop()}
                aria-busy={stopping || undefined}
                className="shrink-0 bg-app-berry text-app-bg hover:bg-app-berry/90"
              >
                <Stop aria-hidden="true" weight="fill" className="size-4" />
              </Button>
            ) : (
              <Button
                type="button"
                variant={canSend ? "default" : "ghost"}
                size="icon"
                aria-label="Send"
                title="Send"
                disabled={!canSend}
                onClick={send}
                className={cn("shrink-0 disabled:opacity-100", !canSend && "text-muted-foreground")}
              >
                <Send aria-hidden="true" weight="fill" className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

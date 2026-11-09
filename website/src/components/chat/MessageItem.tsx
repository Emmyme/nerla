import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { toast } from "sonner"
import { AiFace } from "@/components/ai/AiAvatar"
import { markedVia, saidByAi } from "@/components/ai/via"
import { AiByline, AiSaidText, ViaMark } from "@/components/ai/ViaMark"
import { AddReaction, Checklist, Ellipsis, Pencil, Pin, PinOff, Reply, Trash, Video } from "@/components/icons"
import { AttachmentPreview } from "@/components/tasks/AttachmentPreview"
import { AnchoredPopover } from "@/components/ui/anchored-popover"
import { AutosizeTextarea } from "@/components/ui/autosize-textarea"
import { BottomSheet } from "@/components/ui/bottom-sheet"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/ui/user-avatar"
import { isRemoved, type Attachment, type TaskAttachment } from "@/lib/api/files"
import type { ChatKind, ChatMessage } from "@/lib/api/chat"
import { editMessage, pinMessage, react } from "@/lib/chatSend"
import { FILE_PLACEHOLDER } from "@/lib/chatModel"
import type { StoreMessage } from "@/lib/chatStore"
import { formatTime } from "@/lib/dates"
import { openMeetingWindow, type CallChat } from "@/lib/meetingWindow"
import { onRoomPresence, onSocketReconnect } from "@/lib/socket"
import { mentionedPeople, renderMentionText } from "@/lib/mentions"
import { cn, remPx, TAP } from "@/lib/utils"
import { personName } from "./ChatListRow"
import { usePopoverToggle } from "@/components/ui/use-popover-toggle"
import { IconTip } from "@/components/ui/icon-tip"
import { messageRights } from "./messageRights"
import { MentionText, useMentionComposer, useMentionScope } from "./MentionPicker"
import { groupReactions, REACTIONS, type Reaction } from "./reactions"

const LONG_PRESS_MS = 450
const PRESS_SLOP = 10

export type MessageActions = {
  onReply: (message: StoreMessage) => void
  onTask: (message: StoreMessage) => void
  onDelete: (message: StoreMessage) => void
  onEdit: (id: string | null) => void
  onOpenFile: (file: TaskAttachment) => void
  /** Takes a file off the user's own message, a removed one too */
  onRemoveFile: (message: StoreMessage, file: Attachment) => void
  /** The file answered 404, so every tile of it says it was removed */
  onFileMissing: (fileId: string) => void
  onFileDescribed: (fileId: string, altText: string | null) => void
  onJump: (id: string) => void
  onCheckCall: (id: string) => Promise<void>
}

const BAR_BUTTON =
  "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring"
const MENU_ITEM =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui font-medium text-foreground transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover focus-visible:outline-none max-lg:min-h-11"
const SHEET_ROW =
  "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-body font-medium text-foreground transition-colors duration-150 active:bg-app-sunk focus-visible:bg-app-hover focus-visible:outline-none"
const ROW_FOCUS = "focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-inset focus-visible:ring-ring"
// Hidden until the row is hovered or holds focus
const ON_HOVER = "invisible group-hover/msg:visible group-focus-within/msg:visible"

const PILL = "inline-flex h-7 items-center gap-1 rounded-full border px-2 text-ui font-medium tabular-nums transition-colors duration-150"

/** A reaction's recoloured icon, the logo or a cat scene, or the stored text when it has no match */
function ReactionIcon({ reaction, value, className }: { reaction: Reaction | undefined; value: string; className: string }) {
  if (!reaction) return <span aria-hidden="true">{value}</span>
  if (reaction.scene) {
    const Scene = reaction.scene
    return <Scene className={cn("shrink-0", className)} />
  }
  if (reaction.image) return <img src={reaction.image} alt="" draggable={false} className={cn("shrink-0 object-contain", className)} />
  const Icon = reaction.icon
  return Icon && <Icon aria-hidden="true" weight="fill" className={cn("shrink-0", reaction.color, className)} />
}

const hasReacted = (message: ChatMessage, me: string, key: string) => message.reactions.some((r) => r.user_id === me && r.emoji === key)

function ReactionPills({ message, me, onToggle }: { message: ChatMessage; me: string; onToggle: (value: string) => void }) {
  if (message.reactions.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {groupReactions(message.reactions, me).map(({ key, reaction, people, mine }) => {
        const names = people.map((p) => (p.user_id === me ? "You" : personName(p.user))).join(", ")
        const label = `${reaction?.label ?? key}, ${people.length}, ${names}`
        const content = (
          <>
            <ReactionIcon reaction={reaction} value={key} className="size-5" />
            {people.length}
          </>
        )
        return (
          <button
            key={key}
            type="button"
            aria-pressed={mine}
            aria-label={label}
            title={names}
            onClick={() => onToggle(key)}
            className={cn(
              PILL,
              "focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
              TAP,
              mine ? "border-app-sky-strong bg-app-selected text-foreground" : "border-border bg-card text-foreground hover:bg-app-hover",
            )}
          >
            {content}
          </button>
        )
      })}
    </div>
  )
}

function ReplyQuote({ message, onJump }: { message: ChatMessage; onJump: (id: string) => void }) {
  const { names } = useMentionScope()
  const quoted = message.reply_to
  if (!quoted) return null
  return (
    <button
      type="button"
      onClick={() => onJump(quoted.id)}
      className={cn(
        "mb-0.5 flex max-w-full min-w-0 items-center gap-1.5 rounded-sm text-left text-caption text-muted-foreground hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
        TAP,
      )}
    >
      <Reply aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium">{personName(quoted.sender)}</span>
      <span className="truncate">{quoted.content === FILE_PLACEHOLDER ? "Attachment" : renderMentionText(quoted.content, names)}</span>
    </button>
  )
}

function Attachments({ message, me, actions, compact }: { message: StoreMessage; me: string; actions: MessageActions; compact: boolean }) {
  const mine = message.sender_id === me && !message.id.startsWith("temp-")
  if (message.attachments.length === 0) return null
  return (
    <ul
      className={cn(
        "mt-1.5 grid max-w-full gap-2",
        message.attachments.length === 1
          ? cn("grid-cols-1", compact ? "w-60" : "w-80")
          : cn("grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))]", compact ? "w-full" : "w-md"),
      )}
    >
      {message.attachments.map((file) => (
        <li
          key={file.id}
          className={cn(
            "w-full min-w-0 has-[[data-media-open]]:col-span-full",
            message.attachments.length > 1 && "has-[[data-removed]]:col-span-full",
          )}
        >
          <AttachmentPreview
            attachment={file}
            onOpen={() => !isRemoved(file) && actions.onOpenFile(file)}
            onMissing={() => actions.onFileMissing(file.id)}
            onDescribed={(altText) => actions.onFileDescribed(file.id, altText)}
            actions={{
              canSave: !isRemoved(file) && !!file.uploaded_by && file.uploaded_by !== me,
              canDescribe: !isRemoved(file) && file.uploaded_by === me,
              onRemove: mine ? () => actions.onRemoveFile(message, file) : undefined,
              removeLabel: "Remove from message",
            }}
          />
        </li>
      ))}
    </ul>
  )
}

/** A call is its own row: a video tile in the avatar gutter, who started it and when, and Join while it is live */
function CallRow({
  message,
  mine,
  chat,
  tabbable,
  onCheck,
}: {
  message: StoreMessage
  mine: boolean
  chat: CallChat
  tabbable: boolean
  onCheck: (id: string) => Promise<void>
}) {
  const live = message.live
  const room = message.meta?.roomName

  // A live row asks again when its call's count changes and after a socket drop
  useEffect(() => {
    if (!live || !room) return
    const check = () => void onCheck(message.id)
    const offPresence = onRoomPresence((event) => event.roomName.toLowerCase() === room.toLowerCase() && check())
    const offReconnect = onSocketReconnect(check)
    return () => {
      offPresence()
      offReconnect()
    }
  }, [live, room, message.id, onCheck])

  const who = mine ? "You" : personName(message.sender)
  return (
    <div
      data-message-id={message.id}
      data-message-row=""
      data-call-row=""
      tabIndex={tabbable ? 0 : -1}
      className={cn("-mx-2 flex items-center gap-3 rounded-md px-2 py-1", ROW_FOCUS)}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md",
          live ? "bg-app-sky text-app-sky-ink" : "bg-app-sunk text-muted-foreground",
        )}
      >
        <Video aria-hidden="true" weight="fill" className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <p className="min-w-0 truncate text-ui font-medium text-foreground">
          {who} started a call
          <span className="text-muted-foreground tabular-nums">
            {" · "}
            {formatTime(message.created_at)}
            {!live && " · Call ended"}
          </span>
        </p>
        {live && room && (
          <Button type="button" variant="join" size="sm" onClick={() => void openMeetingWindow(room, { chat })} className="shrink-0">
            Join
          </Button>
        )}
      </div>
    </div>
  )
}

function EditBox({
  message,
  kind,
  chatId,
  width,
  onDone,
}: {
  message: StoreMessage
  kind: ChatKind
  chatId: string
  width: number | null
  onDone: () => void
}) {
  const { names } = useMentionScope()
  const [seed] = useState(() => mentionedPeople(message.content, names))
  const [text, setText] = useState(() => renderMentionText(message.content, names))
  const box = useRef<HTMLTextAreaElement>(null)
  const mentions = useMentionComposer({ text, setText, field: box, seed })

  useEffect(() => {
    const node = box.current
    if (!node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [])

  const save = () => {
    const next = mentions.toStored(text).trim()
    onDone()
    if (!next || next === message.content.trim()) return
    void editMessage(kind, chatId, message.id, next).then((error) => error && toast.error(error))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(e)) return
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      onDone()
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      save()
    }
  }

  return (
    // As wide as the bubble it replaces, so the message keeps its place while it is edited
    <div className="relative flex max-w-full min-w-64 flex-col items-end gap-1" style={width ? { width: `${width}rem` } : undefined}>
      {mentions.picker}
      <AutosizeTextarea
        ref={box}
        value={text}
        {...mentions.inputProps}
        onChange={(e) => {
          setText(e.target.value)
          mentions.track()
        }}
        onKeyDown={onKeyDown}
        aria-label="Edit message"
        cap="max-h-60"
        containerClassName="w-full"
        className="w-full rounded-lg bg-app-sky-soft px-3 py-1.5 text-body leading-normal text-app-sky-ink transition-shadow duration-150 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
      />
      <p className="text-caption text-muted-foreground">Enter to save, Escape to cancel</p>
    </div>
  )
}

function ActionBar({
  message,
  me,
  mine,
  canDelete,
  kind,
  chatId,
  canPin,
  actions,
}: {
  message: StoreMessage
  me: string
  mine: boolean
  /** The user's to take back, as is what the AI said for them */
  canDelete: boolean
  kind: ChatKind
  chatId: string
  canPin: boolean
  actions: MessageActions
}) {
  const [menu, setOpen] = useState<"react" | "more" | null>(null)
  const reactButton = useRef<HTMLButtonElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const reactToggle = usePopoverToggle(menu === "react", (open) => setOpen(open ? "react" : null))
  const moreToggle = usePopoverToggle(menu === "more", (open) => setOpen(open ? "more" : null))

  const toggleReaction = (key: string) => {
    setOpen(null)
    void react(kind, chatId, message.id, key).then((error) => error && toast.error(error))
  }
  const run = (fn: () => void) => () => {
    setOpen(null)
    fn()
  }

  // One tab stop, and the arrow keys move between the buttons
  const [current, setCurrent] = useState(0)
  const stop = Math.min(current, canDelete || canPin ? 3 : 2)
  const roving = (index: number) => ({ "data-bar-button": "", tabIndex: stop === index ? 0 : -1, onFocus: () => setCurrent(index) })
  const onBarKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-bar-button]"))
    const at = buttons.indexOf(e.target as HTMLElement)
    if (at < 0) return
    const last = buttons.length - 1
    const next = { ArrowRight: at === last ? 0 : at + 1, ArrowLeft: at === 0 ? last : at - 1, Home: 0, End: last }[e.key]
    if (next === undefined) return
    e.preventDefault()
    buttons[next].focus()
  }

  return (
    // Hidden bars take no tab stops, and a bar with a menu open stays while focus is in the menu.
    // It rises into the gap above the row, so it never covers the row below
    <div
      role="toolbar"
      aria-label="Message actions"
      aria-orientation="horizontal"
      onKeyDown={onBarKeyDown}
      data-open={menu ? "" : undefined}
      className={cn(
        "absolute -top-3 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 shadow-[var(--shadow-popover)] data-[open]:visible",
        ON_HOVER,
      )}
    >
      <IconTip label="React">
        <button
          ref={reactButton}
          type="button"
          aria-label="React"
          aria-expanded={menu === "react"}
          className={BAR_BUTTON}
          {...reactToggle}
          {...roving(0)}
        >
          <AddReaction aria-hidden="true" className="size-4" />
        </button>
      </IconTip>
      <IconTip label="Reply">
        <button type="button" aria-label="Reply" className={BAR_BUTTON} onClick={() => actions.onReply(message)} {...roving(1)}>
          <Reply aria-hidden="true" className="size-4" />
        </button>
      </IconTip>
      <IconTip label="Turn into task">
        <button type="button" aria-label="Turn into task" className={BAR_BUTTON} onClick={() => actions.onTask(message)} {...roving(2)}>
          <Checklist aria-hidden="true" className="size-4" />
        </button>
      </IconTip>
      {(canDelete || canPin) && (
        <IconTip label="More">
          <button
            ref={moreButton}
            type="button"
            aria-label="More"
            aria-expanded={menu === "more"}
            className={BAR_BUTTON}
            {...moreToggle}
            {...roving(3)}
          >
            <Ellipsis aria-hidden="true" weight="bold" className="size-4" />
          </button>
        </IconTip>
      )}

      <AnchoredPopover
        open={menu === "react"}
        onOpenChange={(open) => setOpen(open ? "react" : null)}
        anchor={menu === "react" ? reactButton.current : null}
        side="bottom"
        title="Add a reaction"
        returnFocus={() => reactButton.current?.focus()}
      >
        <div className="flex gap-0.5 p-1">
          {REACTIONS.map((reaction) => (
            <IconTip key={reaction.key} label={reaction.label}>
              <button
                type="button"
                aria-label={reaction.label}
                aria-pressed={hasReacted(message, me, reaction.key)}
                onClick={() => toggleReaction(reaction.key)}
                className="flex size-8 items-center justify-center rounded-md transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover focus-visible:outline-none aria-pressed:bg-app-selected"
              >
                <ReactionIcon reaction={reaction} value={reaction.key} className="size-5" />
              </button>
            </IconTip>
          ))}
        </div>
      </AnchoredPopover>

      <AnchoredPopover
        open={menu === "more"}
        onOpenChange={(open) => setOpen(open ? "more" : null)}
        anchor={menu === "more" ? moreButton.current : null}
        side="bottom"
        title="More actions"
        returnFocus={() => moreButton.current?.focus()}
      >
        <div className="flex w-44 flex-col p-1">
          {mine && (
            <button type="button" className={MENU_ITEM} onClick={run(() => actions.onEdit(message.id))}>
              <Pencil aria-hidden="true" className="size-4 text-muted-foreground" />
              Edit
            </button>
          )}
          {canPin && (
            <button
              type="button"
              className={MENU_ITEM}
              onClick={run(
                () => void pinMessage(kind, chatId, message.id, !message.is_pinned).then((error) => error && toast.error(error)),
              )}
            >
              {message.is_pinned ? (
                <PinOff aria-hidden="true" className="size-4 text-muted-foreground" />
              ) : (
                <Pin aria-hidden="true" className="size-4 text-muted-foreground" />
              )}
              {message.is_pinned ? "Unpin" : "Pin"}
            </button>
          )}
          {canDelete && (
            <button type="button" className={cn(MENU_ITEM, "text-app-berry-text")} onClick={run(() => actions.onDelete(message))}>
              <Trash aria-hidden="true" className="size-4" />
              Delete
            </button>
          )}
        </div>
      </AnchoredPopover>
    </div>
  )
}

/** The phone's version of the action bar, opened by a long press on the message */
function ActionSheet({
  message,
  me,
  mine,
  canDelete,
  kind,
  chatId,
  canPin,
  actions,
  onClose,
  returnFocus,
}: {
  message: StoreMessage
  me: string
  mine: boolean
  canDelete: boolean
  kind: ChatKind
  chatId: string
  canPin: boolean
  actions: MessageActions
  onClose: () => void
  returnFocus: () => void
}) {
  // An action that moves focus elsewhere, such as Reply into the composer, keeps it there
  const moved = useRef(false)
  // The sheet slides away first, and the action runs once it has let go of focus
  const [open, setOpen] = useState(true)
  const pending = useRef<(() => void) | null>(null)
  const run =
    (fn: () => void, keepsFocus = true) =>
    () => {
      moved.current = keepsFocus
      pending.current = fn
      setOpen(false)
    }
  const row = (label: string, icon: ReactNode, fn: () => void, className?: string) => (
    <button type="button" className={cn(SHEET_ROW, className)} onClick={run(fn)}>
      {icon}
      {label}
    </button>
  )

  return (
    <BottomSheet
      open={open}
      onOpenChange={(next) => !next && setOpen(false)}
      title="Message actions"
      // The sheet itself takes focus, so the first reaction's label does not pop up on open
      onOpenAutoFocus={(e) => {
        e.preventDefault()
        const sheet = e.target as HTMLElement | null
        sheet?.focus()
      }}
      returnFocus={() => {
        if (!moved.current) returnFocus()
        onClose()
        const fn = pending.current
        pending.current = null
        if (fn) setTimeout(fn, 0)
      }}
    >
      <p className="px-3 pb-1 text-caption text-muted-foreground tabular-nums">
        {mine ? "You" : personName(message.sender)} · {formatTime(message.created_at)}
      </p>
      <div className="grid grid-cols-5 justify-items-center gap-y-1 px-1 pb-2 min-[28rem]:grid-cols-9">
        {REACTIONS.map((reaction) => (
          <IconTip key={reaction.key} label={reaction.label}>
            <button
              type="button"
              aria-label={reaction.label}
              aria-pressed={hasReacted(message, me, reaction.key)}
              onClick={run(() => void react(kind, chatId, message.id, reaction.key).then((error) => error && toast.error(error)), false)}
              className="flex size-11 items-center justify-center rounded-full transition-colors duration-150 focus-visible:bg-app-hover focus-visible:outline-none active:bg-app-sunk aria-pressed:bg-app-selected"
            >
              <ReactionIcon reaction={reaction} value={reaction.key} className="size-5" />
            </button>
          </IconTip>
        ))}
      </div>
      <div role="separator" className="mx-1 mb-1 h-px bg-border" />
      {row("Reply", <Reply aria-hidden="true" className="size-5 text-muted-foreground" />, () => actions.onReply(message))}
      {row("Turn into task", <Checklist aria-hidden="true" className="size-5 text-muted-foreground" />, () => actions.onTask(message))}
      {canPin &&
        row(
          message.is_pinned ? "Unpin" : "Pin",
          message.is_pinned ? (
            <PinOff aria-hidden="true" className="size-5 text-muted-foreground" />
          ) : (
            <Pin aria-hidden="true" className="size-5 text-muted-foreground" />
          ),
          () => void pinMessage(kind, chatId, message.id, !message.is_pinned).then((error) => error && toast.error(error)),
        )}
      {mine && row("Edit", <Pencil aria-hidden="true" className="size-5 text-muted-foreground" />, () => actions.onEdit(message.id))}
      {canDelete && row("Delete", <Trash aria-hidden="true" className="size-5" />, () => actions.onDelete(message), "text-app-berry-text")}
    </BottomSheet>
  )
}

// A press held still on a phone opens the action sheet, as the browser's own menu would
function useLongPress(enabled: boolean, onPress: () => void) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => cancel, [])
  if (!enabled) return {}
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType === "mouse" || (e.target as HTMLElement).closest("textarea")) return
      cancel()
      press.current = { timer: setTimeout(() => ((press.current = null), onPress()), LONG_PRESS_MS), x: e.clientX, y: e.clientY }
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const start = press.current
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > PRESS_SLOP) cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: { preventDefault: () => void; target: EventTarget }) => {
      if ((e.target as HTMLElement).closest("textarea")) return
      e.preventDefault()
      cancel()
      onPress()
    },
  }
}

export const MessageItem = memo(function MessageItem({
  message,
  me,
  kind,
  chatId,
  canPin,
  lead,
  editing,
  tabbable,
  highlighted,
  actions,
  touch = false,
  compact = false,
}: {
  message: StoreMessage
  me: string
  kind: ChatKind
  chatId: string
  canPin: boolean
  /** The first message of a run from one sender, which carries the avatar and name */
  lead: boolean
  editing: boolean
  tabbable: boolean
  highlighted: boolean
  actions: MessageActions
  /** A phone, where a long press opens a sheet instead of the hover bar */
  touch?: boolean
  compact?: boolean
}) {
  // What the AI said for the user shows as the AI's, on the other side, and only taking it back stays with the user
  const aiSaid = saidByAi(message.done_via)
  const rights = messageRights(message, me, canPin)
  const mine = rights.edit
  const canDelete = rights.delete
  const via = markedVia(message.done_via) ? message.done_via : null
  const local = message.id.startsWith("temp-")
  const text = message.content === FILE_PLACEHOLDER && message.attachments.length > 0 ? "" : message.content
  const canAct = !editing && !local
  const time = formatTime(message.created_at)
  const row = useRef<HTMLDivElement>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const bubbleWidth = useRef<number | null>(null)
  const [sheet, setSheet] = useState(false)
  const openSheet = () => {
    window.getSelection()?.removeAllRanges()
    setSheet(true)
  }
  const press = useLongPress(touch && canAct && message.kind !== "call", openSheet)

  // The edit box takes the width of the bubble it replaces
  useLayoutEffect(() => {
    if (!mine || editing || !bubble.current) return
    const rem = remPx()
    bubbleWidth.current = bubble.current.offsetWidth / rem
  }, [mine, editing, text])

  if (message.kind === "call") {
    return <CallRow message={message} mine={mine} chat={{ kind, id: chatId }} tabbable={tabbable} onCheck={actions.onCheckCall} />
  }

  // The user's own time hangs left of the bubble, on its bottom line, so it never shifts the bubble
  const ownTime = (node: ReactNode) => (
    <div className="relative max-w-full">
      <span
        className={cn(
          "absolute right-full bottom-0 mr-2 pb-1.5 text-caption whitespace-nowrap text-muted-foreground tabular-nums",
          ON_HOVER,
        )}
      >
        {time}
      </span>
      {node}
    </div>
  )
  const bubbleText = text && (
    <div
      ref={mine ? bubble : undefined}
      className={cn(
        "text-body leading-normal break-words whitespace-pre-wrap",
        mine ? "rounded-lg bg-app-sky-soft px-3 py-1.5 text-app-sky-ink transition-shadow duration-150" : "text-foreground",
        mine && message.pending && "opacity-60",
      )}
    >
      {aiSaid ? <AiSaidText text={text} /> : <MentionText text={text} />}
      {message.is_edited && <span className={cn("ml-1.5 text-caption", mine ? "opacity-70" : "text-muted-foreground")}>(edited)</span>}
      {mine && via && <ViaMark via={via} personName={personName(message.sender)} className="ml-1.5 align-[-0.125em] text-app-sky-ink" />}
    </div>
  )
  const files = <Attachments message={message} me={me} actions={actions} compact={compact} />

  const body = editing ? (
    <EditBox message={message} kind={kind} chatId={chatId} width={bubbleWidth.current} onDone={() => actions.onEdit(null)} />
  ) : (
    <>
      <ReplyQuote message={message} onJump={actions.onJump} />
      {mine && text ? ownTime(bubbleText) : bubbleText}
      {mine && !text ? ownTime(files) : files}
      {/* A message that is only files keeps its robot below them */}
      {mine && !text && via && <ViaMark via={via} personName={personName(message.sender)} className="mt-1" />}
      <ReactionPills
        message={message}
        me={me}
        onToggle={(emoji) => void react(kind, chatId, message.id, emoji).then((error) => error && toast.error(error))}
      />
    </>
  )

  const pinned = message.is_pinned && !editing && (
    <span className="mb-0.5 flex items-center gap-1 text-caption text-muted-foreground">
      <Pin aria-hidden="true" weight="fill" className="size-3" />
      Pinned
    </span>
  )

  const failed = message.failed && (
    <p role="alert" className="mt-1 flex flex-wrap items-center gap-x-3 text-caption text-app-berry-text">
      {message.error ?? "Couldn't send"}
      <button type="button" onClick={() => void message.retry?.()} className={cn("font-medium underline-offset-2 hover:underline", TAP)}>
        Retry
      </button>
      <button
        type="button"
        onClick={() => message.discard?.()}
        className={cn("font-medium text-muted-foreground underline-offset-2 hover:underline", TAP)}
      >
        Discard
      </button>
    </p>
  )

  const rowProps = {
    ref: row,
    "data-message-id": message.id,
    "data-message-row": "",
    tabIndex: tabbable ? 0 : -1,
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      // On a phone the sheet is the way to the actions, from the keyboard too
      if (
        touch &&
        canAct &&
        e.target === e.currentTarget &&
        (e.key === "Enter" || e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
      ) {
        e.preventDefault()
        openSheet()
      }
    },
    ...press,
  }

  const extras = (
    <>
      {canAct && !touch && (
        <ActionBar
          message={message}
          me={me}
          mine={mine}
          canDelete={canDelete}
          kind={kind}
          chatId={chatId}
          canPin={rights.pin}
          actions={actions}
        />
      )}
      {sheet && (
        <ActionSheet
          message={message}
          me={me}
          mine={mine}
          canDelete={canDelete}
          kind={kind}
          chatId={chatId}
          canPin={rights.pin}
          actions={actions}
          onClose={() => setSheet(false)}
          returnFocus={() => row.current?.focus()}
        />
      )}
    </>
  )

  if (mine) {
    // The user's own messages sit in their sky fill, so the row takes no fill of its own. The time shows beside the bubble on hover
    return (
      <div
        {...rowProps}
        className={cn(
          "group/msg relative -mx-2 flex justify-end rounded-md px-2 py-0.5",
          touch && "[-webkit-touch-callout:none]",
          ROW_FOCUS,
          highlighted && "motion-flash",
        )}
      >
        <div className={cn("flex max-w-[min(40rem,85%)] min-w-0 flex-col items-end max-lg:max-w-[90%]", editing && "max-w-full")}>
          {pinned}
          {body}
          {failed}
        </div>
        {extras}
      </div>
    )
  }

  return (
    <div
      {...rowProps}
      className={cn(
        "group/msg relative -mx-2 flex gap-3 rounded-md px-2 py-0.5 transition-colors duration-150",
        touch && "[-webkit-touch-callout:none]",
        ROW_FOCUS,
        highlighted ? "motion-flash" : "hover:bg-app-hover has-[[role=toolbar][data-open]]:bg-app-hover",
        sheet && "bg-app-hover",
      )}
    >
      <div className="w-8 shrink-0">
        {lead && aiSaid ? (
          <AiFace size={2} className="mt-0.5" />
        ) : lead ? (
          <UserAvatar user={message.sender ?? { id: message.sender_id }} size="md" className="mt-0.5" profile tabIndex={-1} />
        ) : (
          // The first line's own line box, so the time sits on the message's baseline
          <p aria-hidden="true" className="text-center text-body leading-normal whitespace-nowrap">
            <span className={cn("text-micro text-muted-foreground tabular-nums", ON_HOVER)}>{time}</span>
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-start">
        {lead && (
          <p className={cn("flex max-w-full gap-2", aiSaid || via ? "items-center" : "items-baseline")}>
            {aiSaid ? (
              <AiByline asker={personName(message.sender)} className="text-ui" />
            ) : (
              <>
                <span className="truncate text-ui font-semibold text-foreground">{personName(message.sender)}</span>
                {via && <ViaMark via={via} personName={personName(message.sender)} />}
              </>
            )}
            <span className="shrink-0 text-caption text-muted-foreground tabular-nums">{time}</span>
          </p>
        )}
        {pinned}
        <div className={cn("flex max-w-[min(36rem,85%)] min-w-0 flex-col items-start max-lg:max-w-full", message.pending && "opacity-60")}>
          {body}
        </div>
        {failed}
      </div>
      {extras}
    </div>
  )
})

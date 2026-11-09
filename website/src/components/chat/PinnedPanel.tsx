import { useId, useRef, useState } from "react"
import { toast } from "sonner"
import { Paperclip, Pin, PinOff } from "@/components/icons"
import { AnchoredPopover } from "@/components/ui/anchored-popover"
import { BottomSheet } from "@/components/ui/bottom-sheet"
import { Button } from "@/components/ui/button"
import { LoadingSpinner } from "@/components/ui/spinner"
import { UserAvatar } from "@/components/ui/user-avatar"
import { isRemoved } from "@/lib/api/files"
import type { ChatMessage, ChatSummary } from "@/lib/api/chat"
import { chatKey, FILE_PLACEHOLDER } from "@/lib/chatModel"
import { pinMessage } from "@/lib/chatSend"
import { usePins } from "@/lib/chatHooks"
import { formatRelative } from "@/lib/dates"
import { FADE_MOTION } from "@/lib/motion"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { cn } from "@/lib/utils"
import { personName } from "./ChatListRow"
import { usePopoverToggle } from "@/components/ui/use-popover-toggle"
import { IconTip } from "@/components/ui/icon-tip"
import { MentionText } from "./MentionPicker"

const EMPTY = "No pinned messages yet. Pin important messages to find them here."

function PinRow({ message, onJump, onUnpin }: { message: ChatMessage; onJump: (id: string) => void; onUnpin?: (id: string) => void }) {
  const text = message.content === FILE_PLACEHOLDER && message.attachments.length > 0 ? "" : message.content
  const name = personName(message.sender)
  return (
    <li className="flex gap-2.5 rounded-md px-2 py-2">
      <UserAvatar user={message.sender ?? { id: message.sender_id }} size="md" className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-ui font-semibold text-foreground">{name}</span>
          <span className="shrink-0 text-caption text-muted-foreground">{formatRelative(message.created_at)}</span>
        </p>
        {text && (
          <p className="line-clamp-3 text-ui break-words whitespace-pre-wrap text-foreground">
            <MentionText text={text} />
          </p>
        )}
        {message.attachments.length > 0 && (
          <ul aria-label="Attachments" className="mt-0.5 flex flex-wrap gap-1">
            {message.attachments.map((file) => (
              <li
                key={file.id}
                className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-app-sunk px-2 text-caption text-muted-foreground"
              >
                <Paperclip aria-hidden="true" className="size-3 shrink-0" />
                <span className="truncate">{isRemoved(file) ? "File removed" : file.file_name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 items-start gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-pin-jump=""
          onClick={() => onJump(message.id)}
          aria-label={`Jump to the message from ${name}`}
        >
          Jump
        </Button>
        {onUnpin && (
          <IconTip label="Unpin">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Unpin message"
              onClick={() => onUnpin(message.id)}
              className="size-7 text-muted-foreground max-lg:size-11"
            >
              <PinOff aria-hidden="true" className="size-4" />
            </Button>
          </IconTip>
        )}
      </div>
    </li>
  )
}

function PinList({ chat, open, onJump }: { chat: ChatSummary; open: boolean; onJump: (id: string) => void }) {
  const { pins, status, error, reload } = usePins(chatKey(chat.kind, chat.id), open)
  const list = useRef<HTMLUListElement>(null)

  // The row leaves with the button that had focus, so focus moves to the next row, or the panel when none is left
  const unpin = (id: string) => {
    const panel = list.current?.closest<HTMLElement>('[role="dialog"]')
    const index = pins.findIndex((m) => m.id === id)
    void pinMessage(chat.kind, chat.id, id, false).then((failed) => failed && toast.error(failed))
    requestAnimationFrame(() => {
      if (!panel || panel.contains(document.activeElement)) return
      const jumps = panel.querySelectorAll<HTMLElement>("[data-pin-jump]")
      ;(jumps[Math.min(index, jumps.length - 1)] ?? panel).focus()
    })
  }

  if (status === "loading" && pins.length === 0) {
    return (
      <div className="flex justify-center py-6">
        <LoadingSpinner />
      </div>
    )
  }
  if (status === "error") {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 px-4 py-6 text-center">
        <p className="text-ui text-muted-foreground">{error}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
          Try again
        </Button>
      </div>
    )
  }
  if (pins.length === 0) return <p className="px-4 py-6 text-center text-ui text-muted-foreground">{EMPTY}</p>
  return (
    <ul ref={list} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-1 pb-1">
      {pins.map((message) => (
        <PinRow key={message.id} message={message} onJump={onJump} onUnpin={chat.can_pin ? unpin : undefined} />
      ))}
    </ul>
  )
}

/** The header's pin button and the list it opens, a popover on a desktop and a sheet on a phone */
export function PinnedButton({ chat, onJump, compact = false }: { chat: ChatSummary; onJump: (id: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const jumping = useRef(false)
  const toggle = usePopoverToggle(open, setOpen)
  const desktop = useIsDesktop()
  const panelId = useId()
  const { count } = usePins(chatKey(chat.kind, chat.id), open)

  // A jump moves focus to the message, so closing must not take it back to the button
  const jump = (id: string) => {
    jumping.current = true
    setOpen(false)
    onJump(id)
  }
  const returnFocus = () => {
    if (!jumping.current) button.current?.focus()
    jumping.current = false
  }
  const list = <PinList chat={chat} open={open} onJump={jump} />

  return (
    <>
      <IconTip label="Pinned messages">
        <Button
          ref={button}
          type="button"
          variant="ghost"
          size="icon"
          aria-label={count > 0 ? `Pinned messages, ${count}` : "Pinned messages"}
          aria-expanded={open}
          aria-controls={panelId}
          {...toggle}
          className={cn(
            "shrink-0 gap-1 text-muted-foreground hover:text-foreground",
            compact ? "size-7 max-lg:size-7" : "",
            count > 0 && (compact ? "w-auto px-1.5 max-lg:w-auto" : "w-auto px-2 max-lg:w-auto max-lg:px-2.5"),
          )}
        >
          <Pin aria-hidden="true" className={compact ? "size-4" : "size-5"} />
          {count > 0 && <span className="text-caption tabular-nums">{count}</span>}
        </Button>
      </IconTip>
      {desktop ? (
        <AnchoredPopover
          open={open}
          onOpenChange={setOpen}
          anchor={open ? button.current : null}
          side="bottom"
          title="Pinned messages"
          id={panelId}
          returnFocus={returnFocus}
          className={cn("max-h-112 w-88", FADE_MOTION, "motion-safe:data-[state=closed]:zoom-out-95")}
        >
          <p aria-hidden="true" className="shrink-0 px-3 pt-2.5 pb-1.5 text-ui font-semibold text-foreground">
            Pinned messages
          </p>
          {list}
        </AnchoredPopover>
      ) : (
        <BottomSheet open={open} onOpenChange={setOpen} title="Pinned messages" id={panelId} showTitle returnFocus={returnFocus}>
          {list}
        </BottomSheet>
      )}
    </>
  )
}

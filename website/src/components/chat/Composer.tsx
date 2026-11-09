import { useEffect, useId, useState, type KeyboardEvent, type RefObject } from "react"
import { toast } from "sonner"
import { AiFace } from "@/components/ai/AiAvatar"
import { AttachMenu } from "@/components/files/AttachMenu"
import { DraftChips } from "@/components/files/DraftChips"
import { skippedText, useDraftUploads } from "@/components/files/useDraftUploads"
import { Reply, Send, X } from "@/components/icons"
import { AutosizeTextarea } from "@/components/ui/autosize-textarea"
import { Button } from "@/components/ui/button"
import { TypingDots } from "@/components/ui/typing-dots"
import type { ChatKind } from "@/lib/api/chat"
import { chatKey, FILE_PLACEHOLDER } from "@/lib/chatModel"
import { sendMessage } from "@/lib/chatSend"
import { startTyping } from "@/lib/chatLive"
import type { StoreMessage, TypingPerson } from "@/lib/chatStore"
import { renderMentionText } from "@/lib/mentions"
import { cn } from "@/lib/utils"
import { firstName, personName } from "./ChatListRow"
import { useMentionComposer, useMentionScope } from "./MentionPicker"

/** The server's limit, with a quiet count from a thousand characters before it */
export const MAX_MESSAGE = 50_000
const COUNT_FROM = 49_000
// English copy, so English digit grouping
const count = new Intl.NumberFormat("en-GB")
export const overText = (over: number) => `${count.format(over)} ${over === 1 ? "character" : "characters"} over the limit`

// Unsent text survives switching chats for the session
const drafts = new Map<string, string>()

function typingText(people: TypingPerson[]): string {
  const first = people.map((person) => firstName(person.name))
  if (first.length === 0) return ""
  if (first.length === 1) return `${first[0]} is typing`
  if (first.length === 2) return `${first[0]} and ${first[1]} are typing`
  return "Several people are typing"
}

export function Composer({
  kind,
  chatId,
  projectId,
  placeholder,
  replyTo,
  onCancelReply,
  onEditLast,
  typing,
  inputRef,
  compact = false,
}: {
  kind: ChatKind
  chatId: string
  /** A project chat can attach the project's files */
  projectId: string | null
  placeholder: string
  replyTo: StoreMessage | null
  onCancelReply: () => void
  onEditLast: () => boolean
  typing: TypingPerson[]
  inputRef: RefObject<HTMLTextAreaElement>
  compact?: boolean
}) {
  const key = chatKey(kind, chatId)
  const [text, setText] = useState(() => drafts.get(key) ?? "")
  const { uploads, addFiles, addPicked, remove, describe, clear, uploading, ready } = useDraftUploads()
  const countId = useId()
  const { names } = useMentionScope()
  const mentions = useMentionComposer({ text, setText, field: inputRef })
  const stored = mentions.toStored(text)

  useEffect(() => {
    if (text) drafts.set(key, text)
    else drafts.delete(key)
  }, [key, text])

  const tooLong = stored.length > MAX_MESSAGE
  const canSend = !uploading && !tooLong && (text.trim() !== "" || ready.length > 0)

  const send = () => {
    if (!canSend) return
    void sendMessage(kind, chatId, {
      content: stored.trim(),
      fileIds: ready.map((file) => file.id),
      replyToId: replyTo?.id,
      attachments: ready,
      onSkipped: (count) => toast.error(skippedText(count)),
    })
    setText("")
    mentions.reset()
    clear()
    onCancelReply()
    inputRef.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || mentions.onKeyDown(e)) return
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === "Escape" && replyTo) {
      e.preventDefault()
      e.stopPropagation()
      onCancelReply()
    } else if (e.key === "ArrowUp" && text === "" && onEditLast()) {
      e.preventDefault()
    }
  }

  return (
    <div className={cn("shrink-0", compact ? "px-3 pb-3" : "px-4 pb-4 lg:px-6")}>
      <div className={cn("flex items-baseline gap-3 px-1", compact ? "h-5 pt-0.5" : "h-6 pt-1")}>
        <p aria-live="polite" className="flex min-w-0 flex-1 items-center gap-1.5 self-center text-caption text-muted-foreground">
          {typing.length > 0 && (
            <>
              {typing.some((person) => person.ai) && <AiFace size={1} />}
              <TypingDots />
              <span className="truncate">{typingText(typing)}</span>
            </>
          )}
        </p>
        {stored.length >= COUNT_FROM && (
          <p id={countId} className={cn("shrink-0 text-caption tabular-nums", tooLong ? "text-app-berry-text" : "text-muted-foreground")}>
            {tooLong ? overText(stored.length - MAX_MESSAGE) : `${count.format(stored.length)} of ${count.format(MAX_MESSAGE)}`}
          </p>
        )}
      </div>
      <div className="relative rounded-lg border border-input bg-card transition-colors duration-150 focus-within:border-muted-foreground has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-ring has-[textarea:focus-visible]:ring-offset-2 has-[textarea:focus-visible]:ring-offset-background">
        {mentions.picker}
        {replyTo && (
          <div className="flex items-center gap-2 border-b border-border py-1.5 pr-1.5 pl-3 text-caption">
            <Reply aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-muted-foreground">
              Replying to <span className="font-medium text-foreground">{personName(replyTo.sender)}</span>
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {replyTo.content === FILE_PLACEHOLDER ? "Attachment" : renderMentionText(replyTo.content, names)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Cancel reply"
              onClick={onCancelReply}
              className="size-6 shrink-0 text-muted-foreground"
            >
              <X aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        )}

        {/* Chips are not kept per chat like the text, so the composer says what leaving does */}
        <div className={cn(uploads.length > 0 && "border-b border-border p-1.5")}>
          <DraftChips uploads={uploads} onRemove={remove} onDescribed={describe} />
          {uploads.length > 0 && (
            <p className="px-1 pt-1.5 text-caption text-muted-foreground">Attachments are removed when you leave the chat.</p>
          )}
        </div>

        <div className="flex items-end gap-1 p-1">
          <AttachMenu projectId={projectId} onFiles={addFiles} onPick={addPicked} className="hover:text-foreground" />
          <AutosizeTextarea
            ref={inputRef}
            value={text}
            {...mentions.inputProps}
            onChange={(e) => {
              setText(e.target.value)
              mentions.track()
              if (e.target.value.trim()) startTyping(kind, chatId)
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              if (e.clipboardData.files.length > 0) {
                e.preventDefault()
                addFiles(Array.from(e.clipboardData.files))
              }
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-describedby={stored.length >= COUNT_FROM ? countId : undefined}
            aria-invalid={tooLong || undefined}
            cap={compact ? "max-h-32" : "max-h-48"}
            containerClassName="min-w-0 flex-1"
            className="w-full bg-transparent px-1.5 py-1.5 text-body leading-normal text-foreground placeholder:text-muted-foreground focus-visible:outline-none max-lg:py-2.5"
          />
          {/* Quiet until there is something to send, then the primary color */}
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
        </div>
      </div>
    </div>
  )
}

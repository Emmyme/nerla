import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { useChat } from "@livekit/components-react"
import { toast } from "sonner"
import { Send } from "@/components/icons"
import { formatTime } from "@/lib/dates"
import { cn } from "@/lib/utils"
import { CALL_FIELD, CallIconButton } from "./CallIconButton"
import { whoIs } from "./CallTile"
import { CALL_TOASTER } from "./incoming"

type CallChat = ReturnType<typeof useChat>
type ChatMessage = CallChat["chatMessages"][number]

const GROUP_MS = 5 * 60 * 1000

type Group = { key: string; sender: string; time: number; messages: ChatMessage[] }

function groupMessages(messages: ChatMessage[]): Group[] {
  const groups: Group[] = []
  for (const m of messages) {
    const sender = m.from?.identity ?? ""
    const last = groups.at(-1)
    if (last && last.sender === sender && m.timestamp - last.messages[last.messages.length - 1].timestamp < GROUP_MS) {
      last.messages.push(m)
    } else {
      groups.push({ key: m.id, sender, time: m.timestamp, messages: [m] })
    }
  }
  return groups
}

/** Messages for the participants in the call right now. Nothing is stored, so they end with the call */
export function ChatPanel({ chat }: { chat: CallChat }) {
  const [draft, setDraft] = useState("")
  const input = useRef<HTMLTextAreaElement>(null)
  const log = useRef<HTMLDivElement>(null)
  const inputId = useId()
  const messages = chat.chatMessages
  const groups = groupMessages(messages)

  useEffect(() => {
    input.current?.focus()
  }, [])

  useLayoutEffect(() => {
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  const submit = async () => {
    const text = draft.trim()
    if (!text || chat.isSending) return
    setDraft("")
    try {
      await chat.send(text)
    } catch (err) {
      console.error("Chat send failed:", err)
      setDraft(text)
      toast.error("Your message didn't send. Try again.", { toasterId: CALL_TOASTER })
    }
  }

  return (
    <>
      <div ref={log} role="log" aria-label="Messages" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-1 pb-2">
        {groups.length === 0 ? (
          <p className="m-auto max-w-56 text-center text-ui text-app-text-muted">Messages here are only visible during the call.</p>
        ) : (
          groups.map((g) => {
            const from = g.messages[0].from
            const name = from?.isLocal ? "You" : from ? whoIs(from).name : "Someone who left"
            return (
              <div key={g.key} className="flex flex-col gap-0.5">
                <p className="flex items-baseline gap-2">
                  <span className="truncate text-ui font-medium text-app-text">{name}</span>
                  <time dateTime={new Date(g.time).toISOString()} className="shrink-0 text-caption text-app-text-muted tabular-nums">
                    {formatTime(new Date(g.time))}
                  </time>
                </p>
                {g.messages.map((m) => (
                  <p key={m.id} className="text-body break-words whitespace-pre-wrap text-app-text">
                    {m.message}
                  </p>
                ))}
              </div>
            )
          })
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="flex shrink-0 items-end gap-2 p-3"
      >
        <label htmlFor={inputId} className="sr-only">
          Message everyone in the call
        </label>
        <textarea
          ref={input}
          id={inputId}
          rows={1}
          maxLength={2000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return
            e.preventDefault()
            void submit()
          }}
          placeholder="Send a message"
          className={cn("field-sizing-content max-h-32 min-h-9 flex-1 resize-none px-3 py-2 max-lg:min-h-11 max-lg:py-3", CALL_FIELD)}
        />
        <CallIconButton
          type="submit"
          label="Send message"
          tone={draft.trim() ? "active" : "idle"}
          disabled={!draft.trim() || chat.isSending}
          className="size-9 max-lg:size-11 [&_svg]:size-4"
        >
          <Send aria-hidden="true" />
        </CallIconButton>
      </form>
    </>
  )
}

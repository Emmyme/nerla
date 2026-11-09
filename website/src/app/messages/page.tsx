import { FirstTip } from "@/components/onboarding/FirstTip"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate, useSearchParams } from "react-router"
import { ChatList, EmptyChats } from "@/components/chat/ChatList"
import { Conversation } from "@/components/chat/Conversation"
import { NewChatDialog, type NewChatMode } from "@/components/chat/NewChatDialog"
import { BellSlot } from "@/components/notifications/BellSlot"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { useDocumentTitle } from "@/lib/useDocumentTitle"
import { useTaskShortcuts } from "@/lib/useTaskShortcuts"
import type { ChatKind, ChatSummary } from "@/lib/api/chat"
import { useAiTeammate } from "@/lib/aiStore"
import { chatKey } from "@/lib/chatModel"
import { useChats } from "@/lib/chatHooks"
import { loadProfile } from "@/lib/profiles"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"

const AiConversation = lazy(() => import("@/components/ai/AiConversation"))

type Selection = { kind: ChatKind; id: string }

/** The key the user's DM with the AI is selected by, in the list and in the address */
const AI_KEY = "ai"

function selectionOf(params: URLSearchParams): Selection | null {
  const dm = params.get("dm")
  if (dm) return { kind: "dm", id: dm.toLowerCase() }
  const group = params.get("group")
  return group ? { kind: "group", id: group.toLowerCase() } : null
}

// Shown until the list knows the chat, such as a first DM or a group just made
function stub({ kind, id }: Selection, title?: string, person?: ChatSummary["members"][number]): ChatSummary {
  return {
    kind,
    id,
    title: title || (kind === "dm" ? "Direct message" : "Group chat"),
    project_id: null,
    members: person ? [person] : [],
    member_count: kind === "dm" ? 2 : 0,
    can_pin: kind === "dm",
    last_message: null,
    last_activity_at: new Date().toISOString(),
    unread: false,
  }
}

export default function MessagesPage() {
  const { user } = useAuth()
  const me = user?.id ?? ""
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const desktop = useIsDesktop()
  useDocumentTitle("Chat")
  const { chats, status, refresh } = useChats()
  const [drafts, setDrafts] = useState<Record<string, ChatSummary>>({})
  const [newChat, setNewChat] = useState<NewChatMode | null>(null)
  const opening = params.has("new")

  // ?new=group or ?new=dm opens the new chat dialog and then leaves the address
  useEffect(() => {
    if (!opening) return
    const mode = params.get("new")
    if (mode === "group" || mode === "dm") setNewChat(mode)
    const next = new URLSearchParams()
    const current = selectionOf(params)
    if (current) next.set(current.kind, current.id)
    setParams(next, { replace: true })
  }, [opening, params, setParams])

  const teammate = useAiTeammate()
  const aiThere = !!teammate?.available
  // The AI's DM opens only while the AI is available to the user
  const aiOpen = !opening && params.has(AI_KEY) && aiThere
  const selection = opening || aiOpen ? null : selectionOf(params)
  const key = aiOpen ? AI_KEY : selection ? chatKey(selection.kind, selection.id) : null
  const listed = key ? chats.find((c) => chatKey(c.kind, c.id) === key) : undefined
  const chat = selection && key ? (listed ?? drafts[key] ?? stub(selection)) : null

  // A DM with no messages yet is not on the list, so the other user comes from their profile card, cached for the session
  const unnamedId = selection?.kind === "dm" && status === "ready" && !listed && !drafts[key!] ? selection.id : null
  useEffect(() => {
    if (!unnamedId || !me) return
    const unnamed: Selection = { kind: "dm", id: unnamedId }
    let live = true
    void loadProfile(me, unnamed.id).then((entry) => {
      if (!live || entry.status !== "ready") return
      const { profile } = entry
      const person = { id: unnamed.id, first_name: profile.first_name, last_name: profile.last_name, avatar_url: profile.avatar_url }
      const name = [person.first_name, person.last_name].filter(Boolean).join(" ") || profile.email
      setDrafts((shown) => ({ ...shown, [chatKey("dm", unnamed.id)]: stub(unnamed, name, person) }))
    })
    return () => {
      live = false
    }
  }, [unnamedId, me])

  const go = useCallback(
    (search: string, replace = false) => navigate({ search }, { replace, state: replace ? location.state : { fromList: true } }),
    [navigate, location.state],
  )
  const open = useCallback((target: ChatSummary, replace = false) => go(`?${target.kind}=${target.id}`, replace), [go])
  const openAi = useCallback((replace = false) => go(`?${AI_KEY}`, replace), [go])

  // Desktop never shows an empty conversation pane while there are chats, or the AI
  const first = chats[0]
  const asked = params.has(AI_KEY)
  useEffect(() => {
    // An address for the AI waits until it is known whether the AI is there
    if (!desktop || opening || selection || aiOpen || status !== "ready" || (asked && teammate === null)) return
    if (first) open(first, true)
    else if (aiThere) openAi(true)
  }, [desktop, opening, selection, aiOpen, asked, teammate, status, first, open, aiThere, openAi])

  // Back on a phone lands on the row of the chat that was open
  const returnTo = useRef<string | null>(null)
  useEffect(() => {
    if (key || !returnTo.current) return
    document.querySelector<HTMLElement>(`[data-chat-key="${CSS.escape(returnTo.current)}"]`)?.focus()
    returnTo.current = null
  }, [key])

  const back = () => {
    returnTo.current = key
    if ((location.state as { fromList?: boolean } | null)?.fromList) navigate(-1)
    else setParams(new URLSearchParams(), { replace: true })
  }

  // ?message= opens the chat at that message, as a search result does, then leaves the address
  const jumpTo = params.get("message")
  const jumped = useCallback(
    () =>
      setParams(
        (current) => {
          current.delete("message")
          return current
        },
        { replace: true },
      ),
    [setParams],
  )

  const openNew = useCallback(() => setNewChat("dm"), [])
  useTaskShortcuts({ new: openNew })

  // The list may still hold the group just left, so the next chat opens, or the list on a phone
  const left = () => {
    const next = desktop ? chats.find((c) => chatKey(c.kind, c.id) !== key) : undefined
    if (next) open(next, true)
    else navigate({ search: "" }, { replace: true })
  }

  return (
    <div data-full-bleed="" data-phone-bleed="" className="flex h-full min-h-0">
      <aside
        aria-label="Conversations"
        className={cn(
          "flex min-h-0 w-full flex-col bg-background lg:w-80 lg:shrink-0 lg:border-r lg:border-border",
          (chat || aiOpen) && "max-lg:hidden",
        )}
      >
        <FirstTip id="chat" className="mx-3 mt-3" />
        <ChatList
          chats={chats}
          status={status}
          me={me}
          selectedKey={key}
          onSelect={(target) => open(target, desktop)}
          onNewChat={openNew}
          onRetry={refresh}
          onSelectAi={() => openAi(desktop)}
          aiSelected={aiOpen}
        />
      </aside>

      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-card", !chat && !aiOpen && "max-lg:hidden")}>
        {aiOpen ? (
          <Suspense fallback={null}>
            <AiConversation onBack={desktop ? undefined : back} />
          </Suspense>
        ) : chat ? (
          <Conversation key={key} chat={chat} me={me} onBack={desktop ? undefined : back} onLeft={left} jumpTo={jumpTo} onJumped={jumped} />
        ) : status === "ready" && chats.length === 0 ? (
          <div className="relative flex flex-1 items-center justify-center">
            {desktop && (
              <div className="absolute top-4 right-6 flex">
                <BellSlot />
              </div>
            )}
            <EmptyChats onNewChat={openNew} />
          </div>
        ) : null}
      </div>

      <NewChatDialog
        open={newChat !== null}
        mode={newChat ?? "dm"}
        me={me}
        onClose={() => setNewChat(null)}
        onOpenChat={(target) => {
          setDrafts((shown) => ({ ...shown, [chatKey(target.kind, target.id)]: target }))
          open(target, desktop)
        }}
      />
    </div>
  )
}

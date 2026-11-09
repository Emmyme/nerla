import { useEffect, useMemo, useState, type RefObject } from "react"
import { AiBadge, AiFace } from "@/components/ai/AiAvatar"
import { stripMarks } from "@/components/ai/via"
import { Compose, Search } from "@/components/icons"
import { PageHeader } from "@/components/shell/PageHeader"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Skeleton } from "@/components/ui/skeleton"
import type { ChatSummary } from "@/lib/api/chat"
import { ensureAiThread, useAiSelect, useAiTeammate } from "@/lib/aiStore"
import type { ChatStatus } from "@/lib/chatStore"
import { formatRelativeShort } from "@/lib/dates"
import { nearestSwatch } from "@/lib/projectColors"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { useProjects } from "@/lib/useProjects"
import { cn } from "@/lib/utils"
import { IconTip } from "@/components/ui/icon-tip"
import { ChatListRow, personName, type ProjectMark } from "./ChatListRow"

type Filter = "all" | "dm" | "group" | "project"

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "dm", label: "Direct" },
  { value: "group", label: "Groups" },
  { value: "project", label: "Projects" },
]

function matches(chat: ChatSummary, filter: Filter): boolean {
  if (filter === "dm") return chat.kind === "dm"
  if (filter === "group") return chat.kind === "group" && !chat.project_id
  if (filter === "project") return !!chat.project_id
  return true
}

// Relative times move on while the list is open
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function NewChatButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <Button type="button" shortcut="C" onClick={onClick} className={className}>
      New chat
    </Button>
  )
}

/** The user's DM with the AI teammate, always first while the AI is available */
function AiRow({ name, selected, now, onSelect }: { name: string; selected: boolean; now: Date; onSelect: () => void }) {
  const last = useAiSelect((state) => state.thread.messages.at(-1))
  const preview = last
    ? `${last.role === "user" ? "You: " : ""}${last.role === "user" ? last.content.replace(/\s+/g, " ").trim() : stripMarks(last.content)}`
    : `Ask ${name} about your work`
  return (
    <button
      type="button"
      onClick={onSelect}
      data-chat-key="ai"
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "" : undefined}
      className={cn(
        "group flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors duration-150 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset max-lg:min-h-14",
        selected ? "bg-app-selected" : "hover:bg-app-hover",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center">
        <AiFace size={2} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-ui font-medium text-foreground">{name}</span>
          <AiBadge />
          {last && (
            <span className="ml-auto shrink-0 pl-1 text-caption text-muted-foreground tabular-nums">
              {formatRelativeShort(last.createdAt, now)}
            </span>
          )}
        </span>
        <span className="truncate text-caption text-muted-foreground">{preview}</span>
      </span>
    </button>
  )
}

/** The whole page when there is nothing to show yet */
export function EmptyChats({ onNewChat }: { onNewChat: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="flex flex-col gap-1">
        <p className="text-lead font-semibold text-foreground">No conversations yet</p>
        <p className="text-ui text-muted-foreground">Message someone directly or start a group.</p>
      </div>
      <NewChatButton onClick={onNewChat} />
    </div>
  )
}

export function ChatList({
  chats,
  status,
  me,
  selectedKey,
  onSelect,
  onNewChat,
  onRetry,
  compact = false,
  searchRef,
  onSelectAi,
  aiSelected = false,
}: {
  chats: ChatSummary[]
  status: ChatStatus
  me: string
  selectedKey: string | null
  onSelect: (chat: ChatSummary) => void
  onNewChat: () => void
  onRetry: () => void
  /** The docked list: search and a New chat icon button, no filters */
  compact?: boolean
  searchRef?: RefObject<HTMLInputElement>
  /** Opens the user's DM with the AI, whose row shows only while the AI is available */
  onSelectAi?: () => void
  aiSelected?: boolean
}) {
  const [filter, setFilter] = useState<Filter>("all")
  const [query, setQuery] = useState("")
  const { projects } = useProjects()
  const now = useMinute()
  // On desktop the bell sits at the conversation's top right
  const desktop = useIsDesktop()

  const marks = useMemo(
    () =>
      new Map<string, ProjectMark>(
        projects.map((project) => [project.id, { name: project.name, icon: project.icon, ...nearestSwatch(project.color) }]),
      ),
    [projects],
  )
  const term = query.trim().toLowerCase()
  const visible = chats.filter(
    (chat) =>
      (compact || matches(chat, filter)) &&
      (!term || chat.title.toLowerCase().includes(term) || chat.members.some((person) => personName(person).toLowerCase().includes(term))),
  )
  const teammate = useAiTeammate()
  const ai = !!onSelectAi && !!teammate?.available
  const aiShown = ai && (compact || filter === "all" || filter === "dm") && (!term || teammate.name.toLowerCase().includes(term))
  useEffect(() => {
    if (ai) ensureAiThread()
  }, [ai])
  const empty = status === "ready" && chats.length === 0 && !ai

  return (
    <div className="flex h-full min-h-0 flex-col">
      {compact ? (
        <>
          <div className="flex h-11 shrink-0 items-center justify-between pr-1.5 pl-3.5">
            <h2 className="text-ui font-semibold text-foreground">Chats</h2>
            <IconTip label="New chat">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="New chat"
                onClick={onNewChat}
                className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Compose aria-hidden="true" className="size-4" />
              </Button>
            </IconTip>
          </div>
          <div className="shrink-0 border-b border-border px-2 pb-2">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chats"
                aria-label="Search chats"
                className="h-8 pl-8 focus-visible:border-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
              />
            </div>
          </div>
        </>
      ) : (
        <>
          {/* As tall as the conversation header, so both columns start on one line */}
          <div className="flex h-16 shrink-0 items-center border-b border-border px-4">
            <div className="min-w-0 flex-1">
              <PageHeader title="Chat" actions={<NewChatButton onClick={onNewChat} />} bell={!desktop} />
            </div>
          </div>
          {!empty && (
            <div className="flex shrink-0 flex-col gap-3 px-4 pt-3 pb-3">
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search chats"
                  aria-label="Search chats"
                  className="h-8 pl-8"
                />
              </div>
              <SegmentedControl
                value={filter}
                onChange={setFilter}
                options={FILTERS}
                label="Show"
                className="w-full [&>button]:flex-1 [&>button]:justify-center"
              />
            </div>
          )}
        </>
      )}

      <div className={cn("min-h-0 flex-1 overflow-y-auto", compact ? "p-1.5" : "px-2 pt-1 pb-4")}>
        {status === "loading" && chats.length === 0 ? (
          <ul aria-label="Loading chats" className="flex flex-col gap-1 px-2.5 pt-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="flex items-center gap-3 py-2">
                <Skeleton className="size-8 rounded-full" />
                <span className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3 w-2/5" />
                  <Skeleton className="h-2.5 w-4/5" />
                </span>
              </li>
            ))}
          </ul>
        ) : status === "error" ? (
          <div role="alert" className="flex flex-col items-start gap-2 px-2.5 py-2">
            <p className="text-ui text-muted-foreground">Couldn't load your chats.</p>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : empty ? (
          <div className={compact ? undefined : "lg:hidden"}>
            <EmptyChats onNewChat={onNewChat} />
          </div>
        ) : visible.length === 0 && !aiShown ? (
          <p className="px-2.5 py-2 text-ui text-muted-foreground">{term ? "No chats match your search" : "No chats here yet"}</p>
        ) : (
          <ul aria-label="Chats" className="flex flex-col gap-0.5">
            {aiShown && (
              <li>
                <AiRow name={teammate.name} selected={aiSelected} now={now} onSelect={onSelectAi} />
              </li>
            )}
            {visible.map((chat) => {
              const key = `${chat.kind}:${chat.id.toLowerCase()}`
              return (
                <li key={key}>
                  <ChatListRow
                    chat={chat}
                    me={me}
                    now={now}
                    selected={key === selectedKey}
                    project={chat.project_id ? (marks.get(chat.project_id) ?? null) : null}
                    onSelect={() => onSelect(chat)}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

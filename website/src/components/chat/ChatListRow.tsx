import { saidByAi, stripMarks } from "@/components/ai/via"
import type { ChatPerson, ChatSummary } from "@/lib/api/chat"
import { formatRelativeShort } from "@/lib/dates"
import type { ProjectSwatchKey } from "@/lib/projectColors"
import { IdentityTile } from "@/components/ui/identity-tile"
import { symbolFor } from "@/components/ui/symbols"
import { UnreadDot } from "@/components/ui/unread-dot"
import { UserAvatar } from "@/components/ui/user-avatar"
import { useAiTeammate } from "@/lib/aiStore"
import { useAvatarSrc } from "@/lib/useAvatarSrc"
import { cn } from "@/lib/utils"

const SWATCH_RING = "shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--color-text)_14%,transparent)]"

/** What a project chat shows as its mark: the project's symbol, or its first letter, on its swatch */
export type ProjectMark = { name: string; hex: string; key: ProjectSwatchKey; icon: string | null }

export function personName(person: Pick<ChatPerson, "first_name" | "last_name"> | null | undefined): string {
  return [person?.first_name, person?.last_name].filter(Boolean).join(" ") || "Unknown user"
}

export function firstName(name: string): string {
  return name.split(" ")[0] || name
}

// The ring takes the row's own fill, so overlapping avatars stay apart on every state
const RING = "ring-[0.125rem] ring-[color:var(--row-fill,var(--color-bg))]"

const MARK = {
  sm: { box: "size-8", tile: "size-7 rounded-md text-caption", one: "sm", pair: "xs" },
  md: { box: "size-9", tile: "size-9 rounded-md text-ui", one: "md", pair: "sm" },
  header: { box: "size-9", tile: "size-8 rounded-md text-ui", one: "md", pair: "sm" },
  lg: { box: "size-12", tile: "size-12 rounded-lg text-title", one: "lg", pair: "md" },
} as const

type MarkSize = keyof typeof MARK

function ProjectTile({ project, size = "md", className }: { project: ProjectMark; size?: MarkSize; className?: string }) {
  return (
    <IdentityTile color={project.hex} symbol={project.icon} label={project.name} size="lg" className={cn(MARK[size].tile, className)} />
  )
}

/** A group's picture in the shape of its tile, with a quiet fill while it loads */
export function GroupPicture({ url, className }: { url: string; className?: string }) {
  const src = useAvatarSrc(url)
  if (!src) return <span aria-hidden="true" className={cn("block shrink-0 bg-app-sunk", SWATCH_RING, className)} />
  // An outline, as an inset shadow would sit under the picture
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className={cn(
        "shrink-0 object-cover outline-[0.0625rem] -outline-offset-[0.0625rem] outline-[color-mix(in_srgb,var(--color-text)_14%,transparent)] outline-solid",
        className,
      )}
    />
  )
}

/** A project's tile, a group's picture or own tile, one member's avatar, or two on a diagonal, always in the same square */
export function ChatAvatar({
  chat,
  project,
  size = "md",
  className,
  presence = false,
}: {
  chat: Pick<ChatSummary, "kind" | "members" | "icon" | "color" | "avatar_url">
  project?: ProjectMark | null
  size?: MarkSize
  className?: string
  /** The other user's cat badge on a DM. Groups never show one */
  presence?: boolean
}) {
  const mark = MARK[size]
  const people = chat.members.slice(0, 2)
  if (project) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center", mark.box, className)}>
        <ProjectTile project={project} size={size} />
      </span>
    )
  }
  if (chat.kind === "group" && chat.avatar_url) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center", mark.box, className)}>
        <GroupPicture url={chat.avatar_url} className={mark.tile} />
      </span>
    )
  }
  if (chat.kind === "group" && symbolFor(chat.icon)) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center", mark.box, className)}>
        <IdentityTile color={chat.color ?? "sky"} symbol={chat.icon} size="lg" className={mark.tile} />
      </span>
    )
  }
  if (chat.kind === "dm" || people.length <= 1) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center", mark.box, className)}>
        <UserAvatar user={people[0] ?? null} size={mark.one} presence={presence && chat.kind === "dm"} />
      </span>
    )
  }
  return (
    <span aria-hidden="true" className={cn("relative block shrink-0", mark.box, className)}>
      <UserAvatar user={people[0]} size={mark.pair} single className="absolute top-0 left-0" />
      <UserAvatar user={people[1]} size={mark.pair} single className={cn("absolute right-0 bottom-0", RING)} />
    </span>
  )
}

function previewOf(chat: ChatSummary, me: string, aiName: string): string {
  const last = chat.last_message
  if (!last) return "No messages yet"
  // The AI's own words read as the AI's, whoever asked
  if (saidByAi(last.done_via)) return `${aiName}: ${stripMarks(last.preview)}`
  if (last.sender_id === me) return `You: ${last.preview}`
  if (chat.kind === "group") {
    const sender = chat.members.find((person) => person.id === last.sender_id)
    if (sender) return `${firstName(personName(sender))}: ${last.preview}`
  }
  return last.preview
}

export function ChatListRow({
  chat,
  me,
  selected,
  project,
  now,
  onSelect,
}: {
  chat: ChatSummary
  me: string
  selected: boolean
  project: ProjectMark | null
  now: Date
  onSelect: () => void
}) {
  const aiName = useAiTeammate()?.name ?? "Nerla AI"
  return (
    <button
      type="button"
      onClick={onSelect}
      data-chat-key={`${chat.kind}:${chat.id.toLowerCase()}`}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "" : undefined}
      className={cn(
        "group flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors duration-150 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset max-lg:min-h-14",
        selected ? "bg-app-selected [--row-fill:var(--color-selected)]" : "hover:bg-app-hover hover:[--row-fill:var(--color-hover)]",
      )}
    >
      <ChatAvatar chat={chat} project={project} presence />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-ui text-foreground", chat.unread ? "font-semibold" : "font-medium")}>{chat.title}</span>
          {chat.unread && <UnreadDot label="Unread" />}
          <span className="ml-auto shrink-0 pl-1 text-caption text-muted-foreground tabular-nums">
            {formatRelativeShort(chat.last_message?.created_at ?? chat.last_activity_at, now)}
          </span>
        </span>
        <span className={cn("truncate text-caption", chat.unread ? "text-foreground" : "text-muted-foreground")}>
          {previewOf(chat, me, aiName)}
        </span>
      </span>
    </button>
  )
}

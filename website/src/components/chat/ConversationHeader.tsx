import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import { ArrowLeft, ArrowSquareOut, Ellipsis, LogOut, Sparkle, UserPlus, Video, X } from "@/components/icons"
import { folderColorOf } from "@/components/files/FolderGlyph"
import { uploadFailure } from "@/components/files/uploadErrors"
import { BellSlot } from "@/components/notifications/BellSlot"
import { ColorPicker } from "@/components/files/NewFolderDialog"
import { PeopleSearch } from "@/components/projects/PeopleSearch"
import { AnchoredPopover } from "@/components/ui/anchored-popover"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { IdentityTile, SymbolPicker } from "@/components/ui/identity-tile"
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control"
import { symbolFor, type SymbolKey } from "@/components/ui/symbols"
import { LoadingSpinner, Spinner } from "@/components/ui/spinner"
import { usePopoverToggle } from "@/components/ui/use-popover-toggle"
import { UnreadDot } from "@/components/ui/unread-dot"
import { UserAvatar } from "@/components/ui/user-avatar"
import { chatsAPI, groupChatsAPI, type ChatSummary, type GroupChat } from "@/lib/api/chat"
import { filesAPI } from "@/lib/api/files"
import type { FolderColor } from "@/lib/folderColors"
import { refreshChats } from "@/lib/chatList"
import { openMeetingWindow } from "@/lib/meetingWindow"
import { messageOf } from "@/lib/taskStore"
import { cn } from "@/lib/utils"
import { ChatAvatar, GroupPicture, personName, type ProjectMark } from "./ChatListRow"
import { PinnedButton } from "./PinnedPanel"

const CALL_FAILED = "Couldn't start the call. Check your connection and try again."
const MEMBERS_FAILED = "Couldn't load the members. Check your connection and try again."

type Member = { id: string; name: string; avatar: string | null; first_name: string | null; last_name: string | null; admin: boolean }

function membersOf(group: GroupChat): Member[] {
  return (group.members ?? [])
    .flatMap(({ user_id, role, user }) =>
      user
        ? [
            {
              id: user_id,
              name: personName(user),
              avatar: user.avatar_url ?? null,
              first_name: user.first_name,
              last_name: user.last_name,
              admin: role === "admin",
            },
          ]
        : [],
    )
    .sort((a, b) => Number(b.admin) - Number(a.admin) || a.name.localeCompare(b.name))
}

const MAX_PICTURE = 5 * 1024 * 1024
const PICTURE_FAILED = "Couldn't upload the picture. Try again."
const LOOKS: SegmentedOption<"symbol" | "picture">[] = [
  { value: "symbol", label: "Symbol" },
  { value: "picture", label: "Picture" },
]

/** A group admin gives the group a symbol in a colour, or a picture they upload in its place */
function GroupSymbolDialog({
  chat,
  open,
  onClose,
  returnFocus,
}: {
  chat: ChatSummary
  open: boolean
  onClose: () => void
  returnFocus: () => HTMLElement | null
}) {
  const [look, setLook] = useState<"symbol" | "picture">("symbol")
  const [symbol, setSymbol] = useState<SymbolKey | null>(null)
  const [color, setColor] = useState<FolderColor>("sky")
  const [upload, setUpload] = useState<{ id: string; preview: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const ids = useId()

  useEffect(() => {
    if (!open) return
    setLook(chat.avatar_url ? "picture" : "symbol")
    setSymbol(symbolFor(chat.icon)?.key ?? null)
    setColor(folderColorOf(chat.color))
    setUpload(null)
    setError(null)
  }, [open, chat.icon, chat.color, chat.avatar_url])

  useEffect(() => () => void (upload && URL.revokeObjectURL(upload.preview)), [upload])

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return
    if (!file.type.startsWith("image/")) return setError("Choose an image file.")
    if (file.size > MAX_PICTURE) return setError("Choose an image of 5 MB or less.")
    setError(null)
    setUploading(true)
    try {
      const { id } = await filesAPI.uploadFile(file, { purpose: "avatar" })
      setUpload({ id, preview: URL.createObjectURL(file) })
    } catch (err) {
      setError(await uploadFailure(err, file, undefined, PICTURE_FAILED))
    } finally {
      setUploading(false)
    }
  }

  const picture = upload?.preview ?? null
  const hasPicture = !!upload || !!chat.avatar_url
  const busy = saving || uploading

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || (look === "picture" && !hasPicture)) return
    if (look === "picture" && !upload) return onClose()
    setSaving(true)
    setError(null)
    try {
      await groupChatsAPI.updateGroupChat(
        chat.id,
        look === "picture"
          ? { avatar_file_id: upload!.id }
          : { icon: symbol, color: symbol ? color : null, ...(chat.avatar_url && { avatar_file_id: null }) },
      )
      refreshChats()
      onClose()
    } catch (err) {
      setError(messageOf(err, look === "picture" ? "Couldn't save the picture. Try again." : "Couldn't save the symbol. Try again."))
    } finally {
      setSaving(false)
    }
  }

  return (
    <BaseModal isOpen={open} onClose={() => !busy && onClose()} title="Symbol or picture" maxWidth="sm" fallbackFocus={returnFocus}>
      <form onSubmit={save} className="flex flex-col gap-4 p-6">
        <div className="flex items-center gap-3">
          {look === "picture" && picture ? (
            <img src={picture} alt="" className="size-9 shrink-0 rounded-md object-cover" />
          ) : look === "picture" && chat.avatar_url ? (
            <GroupPicture url={chat.avatar_url} className="size-9 rounded-md" />
          ) : symbol && look === "symbol" ? (
            <IdentityTile color={color} symbol={symbol} size="lg" />
          ) : (
            <ChatAvatar chat={{ ...chat, icon: null, avatar_url: null }} className="[--row-fill:var(--color-card)]" />
          )}
          <span className="min-w-0 truncate text-ui font-medium text-foreground">{chat.title}</span>
        </div>
        <SegmentedControl label="Show" value={look} onChange={setLook} options={LOOKS} className="self-start" />
        {look === "symbol" ? (
          <>
            <div className="flex flex-col gap-1.5">
              <span id={`${ids}-symbol`} className="text-ui font-medium text-foreground">
                Symbol
              </span>
              <SymbolPicker value={symbol} onChange={setSymbol} labelledBy={`${ids}-symbol`} disabled={busy} />
            </div>
            {symbol && (
              <div className="flex flex-col gap-1.5">
                <span id={`${ids}-color`} className="text-ui font-medium text-foreground">
                  Colour
                </span>
                <ColorPicker value={color} onChange={setColor} labelledBy={`${ids}-color`} />
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-start gap-1.5">
            <input
              ref={input}
              type="file"
              accept="image/*"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => void pick(event)}
            />
            <Button
              type="button"
              variant="outline"
              aria-disabled={busy || undefined}
              aria-busy={uploading || undefined}
              onClick={() => !busy && input.current?.click()}
            >
              {uploading ? "Uploading" : hasPicture ? "Choose another picture" : "Upload a picture"}
            </Button>
            <p className="text-caption leading-[1.45] text-muted-foreground">
              A square picture works best. Everyone in the group sees it in place of a symbol.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-ui text-app-berry-text">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || (look === "picture" && !hasPicture)} aria-busy={saving || undefined}>
            Save
          </Button>
        </div>
      </form>
    </BaseModal>
  )
}

function GroupDetails({
  chat,
  me,
  onLeave,
  onEditSymbol,
}: {
  chat: ChatSummary
  me: string
  onLeave: () => void
  onEditSymbol: () => void
}) {
  const [group, setGroup] = useState<GroupChat | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const project = !!chat.project_id

  const load = useCallback(() => {
    setError(null)
    groupChatsAPI
      .getGroupChat(chat.id)
      .then(setGroup)
      .catch((err) => setError(messageOf(err, MEMBERS_FAILED)))
  }, [chat.id])

  useEffect(load, [load])

  const members = group ? membersOf(group) : []
  const mine = members.find((m) => m.id === me)
  const canManage = !project && (!!mine?.admin || group?.created_by === me)
  // Only admins change the symbol, as the server checks
  const canStyle = !project && !!mine?.admin

  const change = async (run: () => Promise<unknown>, failed: string) => {
    setBusy(true)
    try {
      await run()
      load()
      refreshChats()
    } catch (err) {
      toast.error(messageOf(err, failed))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex w-72 flex-col py-1.5">
      <p className="px-3 pt-1.5 pb-1 text-caption font-medium text-muted-foreground">
        {project ? "Members follow the project" : "Members"}
      </p>
      {error ? (
        <p role="alert" className="px-3 py-2 text-ui text-app-berry-text">
          {error}
        </p>
      ) : !group ? (
        <div className="flex justify-center py-4">
          <LoadingSpinner />
        </div>
      ) : (
        <ul className="flex max-h-64 flex-col overflow-y-auto">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-2.5 px-3 py-1.5 max-lg:min-h-11">
              <UserAvatar
                user={{ id: member.id, first_name: member.first_name, last_name: member.last_name, avatar_url: member.avatar }}
                size="sm"
                profile={{ actions: true, beside: true }}
              />
              <span className="min-w-0 flex-1 truncate text-ui text-foreground">
                {member.name}
                {member.id === me && <span className="text-muted-foreground"> (you)</span>}
              </span>
              {member.admin && <span className="text-caption text-muted-foreground">Admin</span>}
              {canManage && member.id !== me && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  aria-label={`Remove ${member.name}`}
                  onClick={() => change(() => groupChatsAPI.removeMember(chat.id, member.id), "Couldn't remove them. Try again.")}
                  className="size-7 text-muted-foreground"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="px-3 pt-1.5">
          {adding ? (
            <PeopleSearch
              label="Add people"
              excludeIds={members.map((m) => m.id)}
              busy={busy}
              onPick={(person) => change(() => groupChatsAPI.addMember(chat.id, person.id), "Couldn't add them. Try again.")}
            />
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(true)} className="-ml-2.5">
              <UserPlus aria-hidden="true" className="size-4" />
              Add people
            </Button>
          )}
        </div>
      )}

      {!project && (
        <>
          <div role="separator" className="my-1.5 h-px bg-border" />
          {canStyle && (
            <button
              type="button"
              onClick={onEditSymbol}
              className="mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-ui font-medium text-foreground hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:min-h-11"
            >
              <Sparkle aria-hidden="true" className="size-4" />
              Change symbol or picture
            </button>
          )}
          <button
            type="button"
            onClick={onLeave}
            className="mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-ui font-medium text-app-berry-text hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:min-h-11"
          >
            <LogOut aria-hidden="true" className="size-4" />
            Leave group
          </button>
        </>
      )}
    </div>
  )
}

/** A docked window's title bar. The title folds the window down to this bar and back. */
export type CompactHeader = { minimized: boolean; onToggle: () => void; controls: ReactNode }

function CompactTitleBar({
  chat,
  projectLink,
  compact,
  onJump,
}: {
  chat: ChatSummary
  projectLink: ProjectLink | null
  compact: CompactHeader
  onJump: (id: string) => void
}) {
  const { minimized, onToggle, controls } = compact
  return (
    <header className={cn("flex shrink-0 items-center gap-1", minimized ? "h-full px-1" : "h-11 border-b border-border px-1.5")}>
      <button
        type="button"
        data-dock-title=""
        onClick={onToggle}
        aria-expanded={!minimized}
        aria-label={chat.unread ? `${chat.title}, unread` : chat.title}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 text-left transition-colors duration-150 [--row-fill:var(--color-popover)] hover:bg-app-hover hover:[--row-fill:var(--color-hover)] focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
          minimized ? "h-8 rounded-full pr-1.5" : "h-9 rounded-md px-1",
        )}
      >
        <ChatAvatar chat={chat} project={projectLink?.mark} size="sm" presence />
        <span className={cn("truncate text-ui text-foreground", chat.unread ? "font-semibold" : "font-medium")}>{chat.title}</span>
        {chat.unread && <UnreadDot />}
      </button>
      {!minimized && <PinnedButton chat={chat} onJump={onJump} compact />}
      {controls}
    </header>
  )
}

export type ProjectLink = { slug: string; mark: ProjectMark }

export function ConversationHeader({
  chat,
  me,
  projectLink,
  onBack,
  onLeft,
  onJump,
  compact,
}: {
  chat: ChatSummary
  me: string
  projectLink: ProjectLink | null
  onBack?: () => void
  onLeft: () => void
  /** Shows a message from the pinned list in the conversation */
  onJump: (id: string) => void
  compact?: CompactHeader
}) {
  if (compact) return <CompactTitleBar chat={chat} projectLink={projectLink} compact={compact} onJump={onJump} />
  return <FullHeader chat={chat} me={me} projectLink={projectLink} onBack={onBack} onLeft={onLeft} onJump={onJump} />
}

function FullHeader({
  chat,
  me,
  projectLink,
  onBack,
  onLeft,
  onJump,
}: {
  chat: ChatSummary
  me: string
  projectLink: ProjectLink | null
  onBack?: () => void
  onLeft: () => void
  onJump: (id: string) => void
}) {
  const [calling, setCalling] = useState(false)
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [leaveBusy, setLeaveBusy] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)
  const [styling, setStyling] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  const toggle = usePopoverToggle(open, setOpen)
  const phone = !!onBack

  // On a phone the conversation is a new screen, so focus starts on its way back
  useEffect(() => {
    if (phone) backButton.current?.focus()
  }, [phone])
  const group = chat.kind === "group"
  const others = chat.members.slice(0, 3)

  const call = async () => {
    setCalling(true)
    try {
      const { roomName } = await chatsAPI.call(chat.kind, chat.id)
      await openMeetingWindow(roomName, { chat: { kind: chat.kind, id: chat.id } })
    } catch (err) {
      toast.error(messageOf(err, CALL_FAILED))
    } finally {
      setCalling(false)
    }
  }

  const leave = async () => {
    setLeaveBusy(true)
    setLeaveError(null)
    try {
      await groupChatsAPI.removeMember(chat.id, me)
      setLeaving(false)
      refreshChats()
      onLeft()
    } catch (err) {
      setLeaveError(messageOf(err, "Couldn't leave the group. Check your connection and try again."))
    } finally {
      setLeaveBusy(false)
    }
  }

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
      {onBack && (
        <Button
          ref={backButton}
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Back to chats"
          onClick={onBack}
          className="-ml-2 shrink-0"
        >
          <ArrowLeft aria-hidden="true" className="size-5" />
        </Button>
      )}
      {group ? (
        <ChatAvatar chat={chat} project={projectLink?.mark} size="header" className="[--row-fill:var(--color-card)]" />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center">
          <UserAvatar user={chat.members[0] ?? null} size="md" profile presence />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="flex min-w-0 items-center text-lead font-semibold text-foreground">
          <span className="truncate">{chat.title}</span>
        </h2>
        {group && (
          <p className="flex min-w-0 items-center gap-1.5 truncate text-caption text-muted-foreground">
            <span className="tabular-nums">{chat.member_count} members</span>
            {projectLink && (
              <>
                <span aria-hidden="true">·</span>
                <Link
                  to={`/project/${projectLink.slug}`}
                  className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
                >
                  Open project
                  <ArrowSquareOut aria-hidden="true" className="size-3" />
                </Link>
              </>
            )}
          </p>
        )}
      </div>

      {group && others.length > 0 && (
        <button
          type="button"
          {...toggle}
          aria-label={`Members, ${chat.member_count}`}
          className="hidden items-center rounded-full p-0.5 transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none lg:flex"
        >
          <span className="flex -space-x-1">
            {others.map((person) => (
              <UserAvatar key={person.id} user={person} size="sm" single className="ring-[0.125rem] ring-card" />
            ))}
          </span>
          {chat.member_count > others.length + 1 && (
            <span className="pr-1 pl-1.5 text-caption font-medium text-muted-foreground tabular-nums">
              +{chat.member_count - others.length - 1}
            </span>
          )}
        </button>
      )}

      <PinnedButton chat={chat} onJump={onJump} />

      {phone ? (
        <Button type="button" variant="join" size="icon" aria-label="Call" onClick={call} disabled={calling} className="size-11 shrink-0">
          {calling ? <Spinner className="size-4" /> : <Video aria-hidden="true" weight="fill" className="size-5" />}
        </Button>
      ) : (
        <Button type="button" variant="join" onClick={call} disabled={calling} className="shrink-0">
          {calling ? <Spinner className="size-4" /> : <Video aria-hidden="true" weight="fill" className="size-4" />}
          Call
        </Button>
      )}

      {group && (
        <>
          <Button
            ref={menuButton}
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Chat details"
            aria-expanded={open}
            {...toggle}
            className={cn("shrink-0", phone && "-mr-2")}
          >
            <Ellipsis aria-hidden="true" weight="bold" className="size-5" />
          </Button>
          <AnchoredPopover
            open={open}
            onOpenChange={setOpen}
            anchor={open ? menuButton.current : null}
            side="bottom"
            title="Chat details"
            returnFocus={() => menuButton.current?.focus()}
          >
            <GroupDetails
              chat={chat}
              me={me}
              onLeave={() => {
                setOpen(false)
                setLeaving(true)
              }}
              onEditSymbol={() => {
                setOpen(false)
                setStyling(true)
              }}
            />
          </AnchoredPopover>
          <GroupSymbolDialog chat={chat} open={styling} onClose={() => setStyling(false)} returnFocus={() => menuButton.current} />
          <BaseModal
            isOpen={leaving}
            onClose={() => !leaveBusy && setLeaving(false)}
            title="Leave group?"
            maxWidth="sm"
            fallbackFocus={() => menuButton.current}
          >
            <div className="flex flex-col gap-4 p-6">
              <p className="text-body text-muted-foreground">
                You'll stop getting messages from <span className="font-semibold text-foreground">{chat.title}</span>. Someone in the group
                can add you back.
              </p>
              {leaveError && (
                <p role="alert" className="text-ui text-app-berry-text">
                  {leaveError}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" autoFocus onClick={() => setLeaving(false)} disabled={leaveBusy}>
                  Cancel
                </Button>
                <Button type="button" variant="destructive" onClick={leave} disabled={leaveBusy}>
                  Leave group
                </Button>
              </div>
            </div>
          </BaseModal>
        </>
      )}
      {!phone && <BellSlot />}
    </header>
  )
}

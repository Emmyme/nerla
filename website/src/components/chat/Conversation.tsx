import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { toast } from "sonner"
import { Link, useNavigate } from "react-router"
import { FilePreviewDialog, type PreviewFile } from "@/components/files/FilePreviewDialog"
import { docRoute } from "@/components/files/fileKinds"
import { PlaceCards } from "@/components/ai/PlaceCards"
import { saidByAi } from "@/components/ai/via"
import { ArrowSquareOut } from "@/components/icons"
import { NewTaskDialog } from "@/components/tasks/NewTaskDialog"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/ui/user-avatar"
import { filesAPI, isRemoved, type Attachment, type TaskAttachment } from "@/lib/api/files"
import { messagesAPI, type ChatSummary } from "@/lib/api/chat"
import { deleteMessage, removeAttachment, setCallLive } from "@/lib/chatSend"
import { describeFile, markFileMissing } from "@/lib/chatLive"
import { FILE_PLACEHOLDER } from "@/lib/chatModel"
import { loadAround } from "@/lib/chatLoad"
import { useChatPeople, useConversation } from "@/lib/chatHooks"
import type { StoreMessage } from "@/lib/chatStore"
import { namesOf, renderMentionText } from "@/lib/mentions"
import { messageOf, SAVE_FAILED } from "@/lib/taskStore"
import { nearestSwatch } from "@/lib/projectColors"
import { scrollBehavior } from "@/lib/motion"
import { useProjects } from "@/lib/useProjects"
import { cn } from "@/lib/utils"
import { ChatAvatar, firstName } from "./ChatListRow"
import { Composer } from "./Composer"
import { ConversationHeader, type CompactHeader, type ProjectLink } from "./ConversationHeader"
import { MentionContext, type MentionScope } from "./MentionPicker"
import { MessageList } from "./MessageList"
import type { MessageActions } from "./MessageItem"

const CHECK_RETRY_MS = 4000
const HIGHLIGHT_MS = 1600

const isLocal = (message: StoreMessage) => message.id.startsWith("temp-")
const RENDER_FRAMES = 10

// A page that just loaded can take a frame or two to reach the screen
async function renderedRow(scroller: HTMLElement | null, id: string): Promise<HTMLElement | null> {
  for (let frame = 0; frame < RENDER_FRAMES; frame++) {
    const node = scroller?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
    if (node) return node
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  return null
}

export function Conversation({
  chat,
  me,
  onBack,
  onLeft,
  compact,
  active = true,
  jumpTo,
  onJumped,
}: {
  chat: ChatSummary
  me: string
  onBack?: () => void
  onLeft: () => void
  /** A docked window, with its own title bar */
  compact?: CompactHeader
  /** False while it is out of sight, so it stays live without counting as read */
  active?: boolean
  /** A message to open at once the chat has loaded, such as one found by search */
  jumpTo?: string | null
  onJumped?: () => void
}) {
  const { messages, hasOlder, loadingOlder, loadOlder, hasNewer, loadNewer, reload, status, error, typing } = useConversation(
    chat.kind,
    chat.id,
    { active },
  )
  const [replyTo, setReplyTo] = useState<StoreMessage | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<StoreMessage | null>(null)
  const [taskFrom, setTaskFrom] = useState<string | null>(null)
  const [viewing, setViewing] = useState<PreviewFile | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const latest = useRef(messages)
  latest.current = messages
  const { projects } = useProjects()
  const { kind, id } = chat
  const people = useChatPeople(chat)
  // A mention in a DM between users never reaches the AI, so it is offered only in groups
  const scope = useMemo<MentionScope>(() => ({ names: namesOf(people), people, me, ai: chat.kind === "group" }), [people, me, chat.kind])
  const names = useRef(scope.names)
  names.current = scope.names

  const aiPlace = useMemo(() => ({ kind: "group" as const, id }), [id])
  const project = chat.project_id ? projects.find((p) => p.id === chat.project_id) : undefined
  const projectLink: ProjectLink | null = useMemo(
    () => (project ? { slug: project.slug, mark: { name: project.name, icon: project.icon, ...nearestSwatch(project.color) } } : null),
    [project],
  )
  // A page around the message loads when it is not shown yet, then it is brought into view, focused and briefly filled
  const jump = useCallback(
    async (messageId: string) => {
      const node = (await loadAround(kind, id, messageId)) ? await renderedRow(scroller.current, messageId) : null
      if (!node) {
        toast.error("Couldn't find that message")
        return
      }
      // A long way off goes at once, so the list's own keep-at-bottom cannot catch a long smooth scroll
      const view = scroller.current
      const far = !view || Math.abs(node.getBoundingClientRect().top - view.getBoundingClientRect().top) > view.clientHeight * 2
      node.scrollIntoView({ block: "center", behavior: far ? "auto" : scrollBehavior() })
      node.focus({ preventScroll: true })
      setHighlightId(messageId)
      setTimeout(() => setHighlightId((shown) => (shown === messageId ? null : shown)), HIGHLIGHT_MS)
    },
    [kind, id],
  )

  const jumped = useRef<string | null>(null)
  useEffect(() => {
    // Cleared once the address lets go of it, so the same message can be opened again
    if (!jumpTo) {
      jumped.current = null
      return
    }
    if (status === "loading" || jumped.current === jumpTo) return
    jumped.current = jumpTo
    onJumped?.()
    void jump(jumpTo)
  }, [jumpTo, status, jump, onJumped])

  // The message right after the call bounds a one-message page that holds just the call, with its live state
  const checkCall = useCallback(
    async (callId: string, retry = true) => {
      const list = latest.current
      const index = list.findIndex((m) => m.id === callId)
      if (index < 0) return
      const next = list.slice(index + 1).find((m) => !isLocal(m))
      try {
        const page = await messagesAPI.history(kind, id, next ? { before: next, limit: 1 } : { limit: 1 })
        const found = page.find((m) => m.id === callId)
        if (found) setCallLive(kind, id, callId, found.live)
      } catch {
        // The server pushes again on a change and every 30 s, this covers the wait for it
        if (retry) setTimeout(() => void checkCall(callId, false), CHECK_RETRY_MS)
      }
    },
    [kind, id],
  )

  const navigate = useNavigate()
  const openFile = useCallback(
    (file: TaskAttachment) => {
      const route = docRoute({ id: file.id, mimeType: file.mime_type })
      if (route) return void navigate(route)
      setViewing({ id: file.id, name: file.file_name, size: file.file_size, mimeType: file.mime_type, altText: file.alt_text })
    },
    [navigate],
  )

  // A message that is only this file goes as a whole, through the delete dialog
  const removeFile = useCallback(
    (message: StoreMessage, file: Attachment) => {
      if (message.content === FILE_PLACEHOLDER && message.attachments.length === 1) return setDeleting(message)
      void removeAttachment(kind, id, message.id, file.id).then((failed) => {
        if (failed) return void toast.error(failed)
        // A removed file cannot be attached again, so it goes without an Undo
        if (isRemoved(file)) return void toast.success("Removed the file from the message")
        toast.success(`Removed ${file.file_name} from the message`, {
          action: {
            label: "Undo",
            onClick: () =>
              void filesAPI
                .attachFile({ fileId: file.id, messageId: message.id })
                .catch((err: unknown) => toast.error(messageOf(err, SAVE_FAILED))),
          },
        })
      })
    },
    [kind, id],
  )

  const actions = useMemo<MessageActions>(
    () => ({
      onReply: (message) => {
        setEditingId(null)
        setReplyTo(message)
        composer.current?.focus()
      },
      onTask: (message) => setTaskFrom(message.content === FILE_PLACEHOLDER ? "" : renderMentionText(message.content, names.current)),
      onDelete: setDeleting,
      onEdit: (messageId) => {
        setEditingId(messageId)
        if (messageId === null) composer.current?.focus()
      },
      onOpenFile: openFile,
      onRemoveFile: removeFile,
      onFileMissing: markFileMissing,
      onFileDescribed: describeFile,
      onJump: (messageId) => void jump(messageId),
      onCheckCall: checkCall,
    }),
    [openFile, removeFile, jump, checkCall],
  )

  const editLast = () => {
    const last = [...latest.current]
      .reverse()
      // What the AI said for the user is never theirs to edit
      .find((m) => m.sender_id === me && !saidByAi(m.done_via) && m.kind === "text" && !isLocal(m) && m.content !== FILE_PLACEHOLDER)
    if (!last) return false
    setReplyTo(null)
    setEditingId(last.id)
    return true
  }

  const confirmDelete = async () => {
    const message = deleting
    setDeleting(null)
    if (!message) return
    const failed = await deleteMessage(kind, id, message.id)
    if (failed) toast.error(failed)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || (e.target as HTMLElement).closest('[role="dialog"]')) return
    if (editingId) setEditingId(null)
    else if (replyTo) setReplyTo(null)
    else return
    e.preventDefault()
  }

  const name = firstName(chat.title)
  const intro = (
    <div className="flex flex-col items-start gap-3">
      {kind === "dm" ? (
        <UserAvatar user={chat.members[0] ?? null} size="lg" />
      ) : (
        <ChatAvatar chat={chat} project={projectLink?.mark} size="lg" className="[--row-fill:var(--color-card)]" />
      )}
      <div className="flex flex-col gap-1">
        <p className="text-title font-semibold text-foreground">{chat.title}</p>
        <p className="text-ui text-muted-foreground">
          {kind === "dm"
            ? `This is the start of your messages with ${name}.`
            : projectLink
              ? "Everyone on the project is here. Members follow the project."
              : `This is the start of ${chat.title}.`}
        </p>
        {projectLink && (
          <Link
            to={`/project/${projectLink.slug}`}
            className="mt-1 inline-flex items-center gap-1 self-start rounded-sm text-ui font-medium text-foreground hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
          >
            Open project
            <ArrowSquareOut aria-hidden="true" className="size-3" />
          </Link>
        )}
      </div>
    </div>
  )

  return (
    <MentionContext.Provider value={scope}>
      <section
        aria-label={chat.title}
        onKeyDown={onKeyDown}
        className={cn("flex min-h-0 min-w-0 flex-1 flex-col", compact ? "bg-popover" : "bg-card", !compact?.minimized && "h-full")}
      >
        <ConversationHeader
          chat={chat}
          me={me}
          projectLink={projectLink}
          onBack={onBack}
          onLeft={onLeft}
          onJump={(messageId) => void jump(messageId)}
          compact={compact}
        />
        {/* A minimized window keeps its place, its draft and its uploads */}
        <div className={cn("flex min-h-0 flex-1 flex-col", compact?.minimized && "hidden")}>
          <MessageList
            messages={messages}
            me={me}
            kind={kind}
            chatId={id}
            canPin={chat.can_pin}
            status={status}
            error={error}
            hasOlder={hasOlder}
            loadingOlder={loadingOlder}
            loadOlder={loadOlder}
            hasNewer={hasNewer}
            loadNewer={loadNewer}
            onRetry={() => void reload()}
            editingId={editingId}
            highlightId={highlightId}
            intro={intro}
            actions={actions}
            scrollerRef={scroller}
            compact={!!compact}
            footer={kind === "group" && <PlaceCards place={aiPlace} className="pt-3 [&>div]:max-w-[min(36rem,100%)]" />}
          />
          <Composer
            kind={kind}
            chatId={id}
            projectId={chat.project_id}
            placeholder={kind === "dm" ? `Message ${name}` : `Message ${chat.title}`}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            onEditLast={editLast}
            typing={typing}
            inputRef={composer}
            compact={!!compact}
          />
        </div>

        <BaseModal
          isOpen={deleting !== null}
          onClose={() => setDeleting(null)}
          title="Delete message?"
          maxWidth="sm"
          fallbackFocus={() => composer.current}
        >
          <div className="flex flex-col gap-4 p-6">
            <p className="text-body text-muted-foreground">It will be removed for everyone in the chat. This can't be undone.</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" autoFocus onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" onClick={() => void confirmDelete()}>
                Delete
              </Button>
            </div>
          </div>
        </BaseModal>

        <FilePreviewDialog file={viewing} onClose={() => setViewing(null)} onMissing={markFileMissing} />

        <NewTaskDialog
          open={taskFrom !== null}
          onOpenChange={(open) => !open && setTaskFrom(null)}
          defaultProjectId={chat.project_id}
          initialDescription={taskFrom ?? ""}
          onCreated={(task) => toast.success(`Task "${task.title}" created`)}
          fallbackFocus={() => composer.current}
          source="chat"
        />
      </section>
    </MentionContext.Provider>
  )
}

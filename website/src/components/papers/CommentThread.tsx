import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { AiFace } from "@/components/ai/AiAvatar"
import { AiWorkingRow } from "@/components/ai/AiWorking"
import { PlaceCards } from "@/components/ai/PlaceCards"
import { markedVia, saidByAi } from "@/components/ai/via"
import { AiByline, AiSaidText, ViaMark } from "@/components/ai/ViaMark"
import { overText } from "@/components/chat/Composer"
import { MentionText, useMentionComposer, useMentionScope } from "@/components/chat/MentionPicker"
import { Hide, Pencil, Trash } from "@/components/icons"
import { AutosizeTextarea } from "@/components/ui/autosize-textarea"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/ui/user-avatar"
import type { CommentDto, CommentThread } from "@/lib/api/papers"
import { useAiWorkingIn } from "@/lib/aiStore"
import { formatRelativeShort, formatShortDate, formatTime, parseServerDate } from "@/lib/dates"
import { mentionedPeople, renderMentionText } from "@/lib/mentions"
import { scrollBehavior } from "@/lib/motion"
import { messageOf } from "@/lib/taskStore"
import { cn } from "@/lib/utils"
import { authorName, type DocComments, type Pending } from "./commentsStore"

/** The server's longest comment */
const COMMENT_MAX = 5000
/** A save this soon after posting doesn't count as an edit */
const EDIT_GRACE_MS = 1000

const ICON_BUTTON =
  "relative inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring max-lg:size-11"
const FIELD =
  "w-full rounded-md bg-background px-2.5 py-1.5 text-ui leading-[1.45] text-foreground ring-[0.0625rem] ring-border placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring"
const BUSY = "aria-disabled:pointer-events-none aria-disabled:opacity-50"

function When({ at }: { at: string }) {
  const date = parseServerDate(at)
  if (!date) return null
  return (
    <time dateTime={date.toISOString()} title={`${formatShortDate(date)} ${formatTime(date)}`} className="whitespace-nowrap tabular-nums">
      {formatRelativeShort(date)}
    </time>
  )
}

const edited = (comment: CommentDto) => new Date(comment.updatedAt).getTime() - new Date(comment.createdAt).getTime() > EDIT_GRACE_MS

/** A text box for a comment, with @mentions. Ctrl Enter posts it */
function CommentField({
  label,
  placeholder,
  submitLabel,
  busyLabel,
  failed,
  initial = "",
  autoFocus = false,
  onSubmit,
  onCancel,
}: {
  label: string
  placeholder: string
  submitLabel: string
  busyLabel: string
  failed: string
  initial?: string
  autoFocus?: boolean
  onSubmit: (body: string) => Promise<void>
  /** Cancel, which Escape presses too */
  onCancel: () => void
}) {
  const { names } = useMentionScope()
  const [text, setText] = useState(() => renderMentionText(initial, names))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const mentions = useMentionComposer({ text, setText, field, seed: mentionedPeople(initial, names) })
  const stored = mentions.toStored(text)
  const over = stored.length - COMMENT_MAX

  useEffect(() => {
    if (!autoFocus) return
    const node = field.current
    node?.focus()
    node?.setSelectionRange(node.value.length, node.value.length)
  }, [autoFocus])

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    const body = stored.trim()
    if (!body || busy || over > 0) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(body)
      setText("")
      mentions.reset()
    } catch (err) {
      setError(messageOf(err, failed))
    } finally {
      setBusy(false)
    }
  }

  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || mentions.onKeyDown(event)) return
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void submit()
    } else if (event.key === "Escape") {
      // Escape lets go of the field, never of the whole panel
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <form onSubmit={submit} aria-busy={busy || undefined} className="relative flex flex-col gap-1.5">
      {mentions.picker}
      <AutosizeTextarea
        ref={field}
        aria-label={label}
        value={text}
        readOnly={busy}
        placeholder={placeholder}
        aria-invalid={over > 0 || undefined}
        cap="max-h-[12rem] overflow-y-auto"
        {...mentions.inputProps}
        onChange={(event) => {
          setText(event.target.value)
          mentions.track()
        }}
        onKeyDown={keys}
        className={FIELD}
      />
      {over > 0 && <p className="text-caption text-app-berry-text">{overText(over)}</p>}
      {error && (
        <p role="alert" className="text-caption text-app-berry-text">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" variant="ghost" onClick={() => !busy && onCancel()} aria-disabled={busy || undefined} className={BUSY}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="secondary"
          aria-disabled={busy || undefined}
          disabled={!busy && (!text.trim() || over > 0)}
          className={BUSY}
        >
          {busy ? busyLabel : submitLabel}
        </Button>
      </div>
    </form>
  )
}

/** One comment in a thread, with edit and delete for its author */
function CommentItem({ comment, comments, root }: { comment: CommentDto; comments: DocComments; root: boolean }) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const name = authorName(comment)
  const person =
    comment.author && "id" in comment.author
      ? { id: comment.author.id, first_name: comment.author.name, avatar_url: comment.author.avatarUrl }
      : null
  // A deleted comment keeps its place for its replies, with nothing left to change
  const mine = comment.mine && !comment.deleted && comments.member
  const aiSaid = saidByAi(comment.done_via)

  if (comment.deleted) {
    return (
      <div className="flex min-h-8 items-center text-ui text-muted-foreground">
        <p>This comment was deleted</p>
      </div>
    )
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await comments.remove(comment.id)
    } catch (err) {
      setError(messageOf(err, "Couldn't delete the comment. Try again."))
      setBusy(false)
    }
  }

  return (
    <div className="group flex flex-col gap-1">
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        {aiSaid ? <AiFace size={1.25} /> : <UserAvatar user={person} size="xs" />}
        {aiSaid ? (
          <AiByline asker={name} className="text-ui" />
        ) : (
          <>
            <span className="truncate text-ui font-semibold text-foreground">{name}</span>
            {markedVia(comment.done_via) && <ViaMark via={comment.done_via} personName={name} />}
          </>
        )}
        <span className="shrink-0 text-caption font-medium text-muted-foreground">
          <When at={comment.createdAt} />
          {edited(comment) && " · edited"}
        </span>
        {mine && !editing && !confirming && (
          <span className="ml-auto flex shrink-0 items-center gap-0.5 lg:opacity-0 lg:transition-opacity lg:duration-150 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100">
            {!aiSaid && (
              <button
                ref={editButton}
                type="button"
                aria-label={root ? "Edit comment" : "Edit reply"}
                title="Edit"
                className={ICON_BUTTON}
                onClick={() => setEditing(true)}
              >
                <Pencil aria-hidden="true" className="size-[0.9rem]" />
              </button>
            )}
            <button
              ref={deleteButton}
              type="button"
              aria-label={root ? "Delete comment" : "Delete reply"}
              title="Delete"
              className={ICON_BUTTON}
              onClick={() => setConfirming(true)}
            >
              <Trash aria-hidden="true" className="size-[0.9rem]" />
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <CommentField
          label={root ? "Edit comment" : "Edit reply"}
          placeholder="Comment"
          submitLabel="Save"
          busyLabel="Saving"
          failed="Couldn't save the comment. Try again."
          initial={comment.body}
          autoFocus
          onSubmit={async (body) => {
            if (body !== comment.body) await comments.edit(comment.id, body)
            setEditing(false)
            requestAnimationFrame(() => editButton.current?.focus())
          }}
          onCancel={() => {
            setEditing(false)
            requestAnimationFrame(() => editButton.current?.focus())
          }}
        />
      ) : aiSaid ? (
        <AiSaidText text={comment.body} className="text-ui leading-[1.45]" />
      ) : (
        <p className="text-ui leading-[1.45] break-words whitespace-pre-wrap text-foreground">
          <MentionText text={comment.body} />
        </p>
      )}
      {confirming && (
        <div
          onKeyDown={(event) => {
            if (event.key !== "Escape" || busy) return
            event.preventDefault()
            event.stopPropagation()
            setConfirming(false)
            requestAnimationFrame(() => deleteButton.current?.focus())
          }}
          className="flex flex-wrap items-center justify-end gap-1.5"
        >
          <span className="mr-auto text-caption font-medium text-foreground">{root ? "Delete this comment?" : "Delete this reply?"}</span>
          <Button
            type="button"
            variant="ghost"
            autoFocus
            onClick={() => {
              if (busy) return
              setConfirming(false)
              requestAnimationFrame(() => deleteButton.current?.focus())
            }}
            aria-disabled={busy || undefined}
            className={BUSY}
          >
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={() => void remove()} aria-disabled={busy || undefined} className={BUSY}>
            {busy ? "Deleting" : "Delete"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-caption text-app-berry-text">
          {error}
        </p>
      )}
    </div>
  )
}

export type AnchorView = {
  /** What the thread is about: the words it was left on, a spot on a board, or the whole doc */
  label: string
  /** The words or the board are gone, shown in grey */
  detached?: boolean
  /** Shows the place in the doc */
  onShow?: () => void
}

export function Thread({ thread, comments, view }: { thread: CommentThread; comments: DocComments; view: AnchorView }) {
  const { root, replies } = thread
  const active = comments.activeId === root.id
  const aiPlace = useMemo(() => ({ kind: "doc_comment" as const, fileId: comments.fileId, commentId: root.id }), [comments.fileId, root.id])
  const askedHere = useAiWorkingIn(aiPlace)
  const aiWorking = comments.aiWorking[root.id]
  const [replying, setReplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLElement>(null)
  const stopReplying = () => {
    setReplying(false)
    requestAnimationFrame(() => box.current?.focus())
  }

  useEffect(() => {
    if (active) box.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() })
  }, [active])

  const hide = async () => {
    setError(null)
    try {
      await comments.hide(root.id)
    } catch (err) {
      setError(messageOf(err, "Couldn't hide the thread. Try again."))
    }
  }

  return (
    <li>
      <article
        ref={box}
        tabIndex={-1}
        data-thread={root.id}
        aria-label={root.deleted ? "Thread" : `Comment by ${authorName(root)}`}
        onFocus={() => !active && comments.setActive(root.id)}
        className={cn(
          "flex flex-col gap-2 rounded-lg px-3 py-2.5 transition-colors duration-150 outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring",
          active ? "bg-app-selected" : "bg-app-sunk",
        )}
      >
        <div className="flex min-w-0 items-start gap-1">
          {view.onShow && !view.detached ? (
            <button
              type="button"
              onClick={() => {
                comments.setActive(root.id)
                view.onShow?.()
              }}
              title="Show in the doc"
              className="h-8 min-w-0 flex-1 cursor-pointer truncate rounded-md bg-app-sky-soft px-2 text-left text-caption font-medium text-app-sky-ink transition-colors duration-150 hover:bg-app-sky focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
            >
              {view.label}
            </button>
          ) : (
            <p
              className={cn(
                "h-8 min-w-0 flex-1 truncate px-2 text-caption leading-8 font-medium",
                view.detached ? "text-muted-foreground" : "text-foreground",
              )}
              title={view.detached ? "No longer in the doc" : undefined}
            >
              {view.label}
              {view.detached && <span className="sr-only">, no longer in the doc</span>}
            </p>
          )}
          {comments.member && !root.deleted && (
            <button type="button" aria-label="Hide this thread" title="Hide" onClick={() => void hide()} className={ICON_BUTTON}>
              <Hide aria-hidden="true" className="size-[0.9rem]" />
            </button>
          )}
        </div>
        <CommentItem comment={root} comments={comments} root />
        {replies.length > 0 && (
          <ol aria-label="Replies" className="flex flex-col gap-2">
            {replies.map((reply) => (
              <li key={reply.id}>
                <CommentItem comment={reply} comments={comments} root={false} />
              </li>
            ))}
          </ol>
        )}
        {(askedHere || aiWorking !== undefined) && <AiWorkingRow name={aiWorking} />}
        <PlaceCards place={aiPlace} />
        {replying ? (
          <CommentField
            label="Reply"
            placeholder="Reply, or @ someone"
            submitLabel="Reply"
            busyLabel="Sending"
            failed="Couldn't post the reply. Check your connection and try again."
            autoFocus
            onSubmit={async (body) => {
              await comments.reply(root.id, body)
              stopReplying()
            }}
            onCancel={stopReplying}
          />
        ) : (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              comments.setActive(root.id)
              setReplying(true)
            }}
            className="self-start"
          >
            Reply
          </Button>
        )}
        {error && (
          <p role="alert" className="text-caption text-app-berry-text">
            {error}
          </p>
        )}
      </article>
    </li>
  )
}

/** A new thread on the words or the spot just picked, until it is posted or let go */
export function NewThread({
  label,
  comments,
  pending,
  onDone,
}: {
  label: string
  comments: DocComments
  pending: Pending
  onDone: (posted: CommentThread | null) => void
}) {
  return (
    <div data-thread="" tabIndex={-1} className="flex flex-col gap-2 rounded-lg bg-app-selected px-3 py-2.5 outline-none">
      <p className="truncate rounded-md bg-app-sky px-2 py-0.5 text-caption font-medium text-app-sky-ink">{label}</p>
      <CommentField
        label="New comment"
        placeholder="Comment, or @ someone"
        submitLabel="Comment"
        busyLabel="Sending"
        failed="Couldn't post the comment. Check your connection and try again."
        autoFocus
        onSubmit={async (body) => onDone(await comments.add(body, pending.anchor))}
        onCancel={() => onDone(null)}
      />
    </div>
  )
}

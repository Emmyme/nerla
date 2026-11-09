import { forwardRef, Fragment, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react"
import { AiFace } from "@/components/ai/AiAvatar"
import { AiWorkingRow } from "@/components/ai/AiWorking"
import { PlaceCards } from "@/components/ai/PlaceCards"
import { markedVia, saidByAi } from "@/components/ai/via"
import { AiByline, AiSaidText, ViaMark } from "@/components/ai/ViaMark"
import { MAX_MESSAGE, overText } from "@/components/chat/Composer"
import { MentionContext, MentionText, useMentionComposer, useMentionScope, type MentionScope } from "@/components/chat/MentionPicker"
import { AttachMenu } from "@/components/files/AttachMenu"
import { DraftChips } from "@/components/files/DraftChips"
import { useDraftUploads } from "@/components/files/useDraftUploads"
import { Calendar, ChevronDown, File, Folder, Paperclip, Pencil, Plus, Restore, Trash, User } from "@/components/icons"
import { AutosizeTextarea } from "@/components/ui/autosize-textarea"
import { Button } from "@/components/ui/button"
import { PriorityIcon } from "@/components/ui/priority-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusIcon } from "@/components/ui/status-icon"
import { UserAvatar } from "@/components/ui/user-avatar"
import { isRemoved, type TaskAttachment } from "@/lib/api/files"
import type { Task, TaskActivity, TaskComment } from "@/lib/api/tasks"
import type { UserSummary } from "@/lib/api/users"
import { useAiWorkingIn } from "@/lib/aiStore"
import { formatRelativeShort, formatShortDate, formatTime, parseServerDate } from "@/lib/dates"
import { mentionedPeople, namesOf, renderMentionText } from "@/lib/mentions"
import { messageOf } from "@/lib/taskStore"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"
import { TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from "@/types/tasks"
import { actorName, describeActivity, mergeFeed, type Segment } from "./taskFeed"

export type FeedStatus = "loading" | "ready" | "error"

const COMMENT_FAILED = "Couldn't post the comment. Check your connection and try again."
const EDIT_FAILED = "Couldn't save the comment. Try again."
const DELETE_FAILED = "Couldn't delete the comment. Try again."

const TOUCH =
  "relative max-lg:after:absolute max-lg:after:left-1/2 max-lg:after:top-1/2 max-lg:after:size-11 max-lg:after:-translate-x-1/2 max-lg:after:-translate-y-1/2 max-lg:after:content-['']"
const SMALL_ICON_BUTTON = cn(
  TOUCH,
  "inline-flex size-[1.5rem] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-card hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
)
const BUSY = "aria-disabled:pointer-events-none aria-disabled:opacity-50"
const FIELD =
  "w-full rounded-md bg-card px-2 py-1.5 text-ui leading-[1.45] text-foreground ring-[0.0625rem] ring-border placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring"

function timeTitle(value: string): string {
  const date = parseServerDate(value)
  return date ? `${formatShortDate(date)} ${formatTime(date)}` : ""
}

function When({ at, className }: { at: string; className?: string }) {
  const date = parseServerDate(at)
  if (!date) return null
  return (
    <time dateTime={date.toISOString()} title={timeTitle(at)} className={cn("whitespace-nowrap tabular-nums", className)}>
      {formatRelativeShort(date)}
    </time>
  )
}

/** `mark` goes right after the first segment, the user who did it */
function Sentence({ segments, mark }: { segments: Segment[]; mark?: ReactNode }) {
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {segment.strong ? <span className="font-semibold text-foreground">{segment.text}</span> : segment.text}
          {index === 0 && mark && <> {mark}</>}
        </Fragment>
      ))}
    </>
  )
}

/** A description an agent or the AI replaced, kept whole so it can be put back by hand */
function OldText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
        className="mt-1 flex cursor-pointer items-center gap-1 rounded-sm text-caption font-medium text-foreground hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
      >
        {open ? "Hide old text" : "Show old text"}
        <ChevronDown aria-hidden="true" className={cn("motion-rotate size-3", open && "rotate-180")} />
      </button>
      {open && (
        <span
          id={id}
          className="mt-1 block max-h-64 overflow-y-auto rounded-md bg-app-sunk px-2.5 py-2 wrap-anywhere whitespace-pre-wrap text-foreground"
        >
          {text}
        </span>
      )}
    </>
  )
}

const fullName = (person: Pick<UserSummary, "first_name" | "last_name"> | null | undefined) =>
  (person && [person.first_name, person.last_name].filter(Boolean).join(" ")) || "Someone"

const markFor = (via: TaskActivity["done_via"], person: Pick<UserSummary, "first_name" | "last_name"> | null | undefined) =>
  markedVia(via) ? <ViaMark via={via} personName={fullName(person)} className="align-[-0.125em]" /> : null

function activityIcon(activity: TaskActivity): ReactNode {
  const icon = "size-[1rem]"
  switch (activity.field) {
    case "status":
      return TASK_STATUSES.includes(activity.to_value as TaskStatus) ? <StatusIcon status={activity.to_value as TaskStatus} /> : null
    case "priority":
      return TASK_PRIORITIES.includes(activity.to_value as TaskPriority) ? (
        <PriorityIcon priority={activity.to_value as TaskPriority} />
      ) : null
    case "assignee":
      return <User className={icon} />
    case "due_date":
      return <Calendar className={icon} />
    case "project":
      return <Folder className={icon} />
    case "title":
    case "description":
      return <Pencil className={icon} />
    case "trash":
      return activity.to_value === "restored" ? <Restore className={icon} /> : <Trash className={icon} />
    default:
      return null
  }
}

function EventLine({ icon, at, children }: { icon: ReactNode; at: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-muted-foreground">
      <span aria-hidden="true" className="flex h-[1.18rem] w-[1rem] shrink-0 items-center justify-center">
        {icon}
      </span>
      <p className="min-w-0 flex-1 leading-[1.45]">{children}</p>
      <When at={at} className="ml-auto shrink-0 pl-1.5 text-caption leading-[1.18rem]" />
    </li>
  )
}

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      <p role="status" className="sr-only">
        Loading activity
      </p>
      <div aria-hidden="true" className="flex items-center gap-2">
        <Skeleton className="size-[1rem] rounded-full" />
        <Skeleton className="h-[0.7rem] w-[11rem]" />
      </div>
      <div aria-hidden="true" className="flex items-start gap-2">
        <Skeleton className="size-[1.5rem] shrink-0 rounded-full" />
        <Skeleton className="h-[3.4rem] flex-1 rounded-lg" />
      </div>
      <div aria-hidden="true" className="flex items-center gap-2">
        <Skeleton className="size-[1rem] rounded-full" />
        <Skeleton className="h-[0.7rem] w-[14rem] max-w-full" />
      </div>
    </div>
  )
}

function isEdited(comment: TaskComment): boolean {
  const created = parseServerDate(comment.created_at)?.getTime()
  const updated = parseServerDate(comment.updated_at)?.getTime()
  return created !== undefined && updated !== undefined && updated - created > 1000
}

function CommentItem({
  comment,
  mine,
  onEdit,
  onDelete,
  onDeleted,
  onOpenAttachment,
}: {
  comment: TaskComment
  mine: boolean
  onEdit?: (id: string, text: string) => Promise<void>
  onDelete?: (id: string) => Promise<void>
  onDeleted?: () => void
  onOpenAttachment?: (attachment: TaskAttachment) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const { names } = useMentionScope()
  const mentions = useMentionComposer({ text: draft ?? "", setText: setDraft, field: editRef })
  const name = fullName(comment.user)
  const aiSaid = saidByAi(comment.done_via)

  const stopEditing = () => {
    setDraft(null)
    setError(null)
    requestAnimationFrame(() => editButton.current?.focus())
  }

  const stored = draft === null ? "" : mentions.toStored(draft)
  const over = stored.length - MAX_MESSAGE

  const save = async (e?: FormEvent) => {
    e?.preventDefault()
    const text = stored.trim()
    if (!text || busy || !onEdit || over > 0) return
    if (text === comment.content) return stopEditing()
    setBusy(true)
    setError(null)
    try {
      await onEdit(comment.id, text)
      stopEditing()
    } catch (err) {
      setError(messageOf(err, EDIT_FAILED))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (busy || !onDelete) return
    setBusy(true)
    setError(null)
    try {
      await onDelete(comment.id)
      onDeleted?.()
    } catch (err) {
      setError(messageOf(err, DELETE_FAILED))
      setBusy(false)
    }
  }

  const cancelDelete = () => {
    setConfirming(false)
    requestAnimationFrame(() => deleteButton.current?.focus())
  }

  const editKeys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || mentions.onKeyDown(e)) return
    if (e.key === "Escape") {
      e.stopPropagation()
      stopEditing()
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void save()
    }
  }

  return (
    <li className="flex items-start gap-2">
      <span className="flex pt-0.5">{aiSaid ? <AiFace size={1.5} /> : <UserAvatar user={comment.user} size="sm" profile />}</span>
      <div className="group min-w-0 flex-1 rounded-lg bg-app-sunk px-2.5 py-2 leading-[1.45]">
        <div className="flex min-h-[1.5rem] min-w-0 items-center gap-1">
          {aiSaid ? (
            <AiByline asker={name} />
          ) : (
            <>
              <span className="truncate font-semibold text-foreground">{name}</span>
              {markFor(comment.done_via, comment.user)}
            </>
          )}
          <span className="shrink-0 text-caption font-medium text-muted-foreground">
            <When at={comment.created_at} />
            {isEdited(comment) && " · edited"}
          </span>
          {mine && draft === null && !confirming && (
            <span className="ml-auto flex shrink-0 items-center gap-0.5 max-lg:gap-5 lg:opacity-0 lg:transition-opacity lg:duration-150 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100">
              {!aiSaid && (
                <button
                  ref={editButton}
                  type="button"
                  aria-label="Edit comment"
                  className={SMALL_ICON_BUTTON}
                  onClick={() => {
                    mentions.reset(mentionedPeople(comment.content, names))
                    setDraft(renderMentionText(comment.content, names))
                    requestAnimationFrame(() => {
                      const field = editRef.current
                      field?.focus()
                      field?.setSelectionRange(field.value.length, field.value.length)
                    })
                  }}
                >
                  <Pencil aria-hidden="true" className="size-[0.9rem]" />
                </button>
              )}
              <button
                ref={deleteButton}
                type="button"
                aria-label="Delete comment"
                className={SMALL_ICON_BUTTON}
                onClick={() => setConfirming(true)}
              >
                <Trash aria-hidden="true" className="size-[0.9rem]" />
              </button>
            </span>
          )}
        </div>

        {draft !== null ? (
          <form onSubmit={save} className="relative mt-1 flex flex-col gap-1.5">
            {mentions.picker}
            <AutosizeTextarea
              ref={editRef}
              aria-label="Edit comment"
              value={draft}
              maxLength={MAX_MESSAGE}
              readOnly={busy}
              aria-busy={busy || undefined}
              aria-invalid={over > 0 || undefined}
              {...mentions.inputProps}
              onChange={(e) => {
                setDraft(e.target.value)
                mentions.track()
              }}
              onKeyDown={editKeys}
              className={FIELD}
            />
            {over > 0 && <p className="text-caption text-app-berry-text">{overText(over)}</p>}
            <div className="flex items-center justify-end gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => !busy && stopEditing()}
                aria-disabled={busy || undefined}
                className={BUSY}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="secondary"
                size="sm"
                aria-disabled={busy || undefined}
                disabled={!busy && (!draft.trim() || over > 0)}
                className={cn("bg-card", BUSY)}
              >
                {busy ? "Saving" : "Save"}
              </Button>
            </div>
          </form>
        ) : aiSaid ? (
          <AiSaidText text={comment.content} className="text-ui leading-[1.45]" />
        ) : (
          <p className="break-words whitespace-pre-wrap text-foreground">
            <MentionText text={comment.content} />
          </p>
        )}

        {comment.attachments.length > 0 && (
          <ul aria-label="Attached files" className="mt-2 flex flex-wrap gap-1">
            {comment.attachments.map((attachment) => (
              <li key={attachment.id} className="flex max-w-full">
                {isRemoved(attachment) ? (
                  <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-app-sunk px-2 py-0.5 text-caption font-medium text-muted-foreground">
                    <File aria-hidden="true" className="size-[0.8rem] shrink-0 opacity-60" />
                    File removed
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpenAttachment?.(attachment)}
                    className={cn(
                      TOUCH,
                      "inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full bg-card px-2 py-0.5 text-caption font-medium text-foreground ring-[0.0625rem] ring-border transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none",
                    )}
                  >
                    <Paperclip aria-hidden="true" className="size-[0.8rem] shrink-0 text-muted-foreground" />
                    <span className="truncate">{attachment.file_name}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {confirming && (
          <div
            onKeyDown={(e) => {
              if (e.key !== "Escape" || busy) return
              e.stopPropagation()
              cancelDelete()
            }}
            className="mt-2 flex flex-wrap items-center justify-end gap-1.5"
          >
            <span className="mr-auto text-caption font-medium text-foreground">Delete this comment?</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              autoFocus
              onClick={() => !busy && cancelDelete()}
              aria-disabled={busy || undefined}
              className={BUSY}
            >
              Cancel
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={remove} aria-disabled={busy || undefined} className={BUSY}>
              {busy ? "Deleting" : "Delete"}
            </Button>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-1.5 text-caption text-app-berry-text">
            {error}
          </p>
        )}
      </div>
    </li>
  )
}

const Composer = forwardRef<
  HTMLTextAreaElement,
  { projectId: string | null; onComment: (text: string, fileIds: string[]) => Promise<void> }
>(function Composer({ projectId, onComment }, ref) {
  const [text, setText] = useState("")
  const { uploads, addFiles, addPicked, remove, describe, hold, clear, uploading, ready } = useDraftUploads()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement | null>(null)
  const id = useId()
  const mentions = useMentionComposer({ text, setText, field })

  const setField = (node: HTMLTextAreaElement | null) => {
    field.current = node
    if (typeof ref === "function") ref(node)
    else if (ref) ref.current = node
  }

  const stored = mentions.toStored(text)
  const over = stored.length - MAX_MESSAGE

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const content = stored.trim()
    if (!content || sending || uploading || over > 0) return
    setSending(true)
    setError(null)
    const fileIds = ready.map((file) => file.id)
    // While the post runs, closing the task or removing a chip must not delete a file it is linking
    const release = hold(fileIds)
    try {
      await onComment(content, fileIds)
      setText("")
      mentions.reset()
      clear()
      field.current?.focus()
    } catch (err) {
      setError(messageOf(err, COMMENT_FAILED))
    } finally {
      release()
      setSending(false)
    }
  }

  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || mentions.onKeyDown(e)) return
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    } else if (e.key === "Escape" && (text || uploads.length > 0)) {
      e.stopPropagation()
      e.currentTarget.closest<HTMLElement>("[data-task-panel]")?.focus()
    }
  }

  return (
    <form
      onSubmit={submit}
      aria-busy={sending || undefined}
      className="relative rounded-lg border-[0.0625rem] border-border bg-card px-3 pt-2 pb-1.5 transition-colors duration-150 has-[textarea:focus-visible]:border-ring"
    >
      {mentions.picker}
      <label htmlFor={`${id}-comment`} className="sr-only">
        Comment
      </label>
      <AutosizeTextarea
        ref={setField}
        id={`${id}-comment`}
        value={text}
        maxLength={MAX_MESSAGE}
        readOnly={sending}
        aria-busy={sending || undefined}
        aria-invalid={over > 0 || undefined}
        {...mentions.inputProps}
        onChange={(e) => {
          setText(e.target.value)
          mentions.track()
        }}
        onKeyDown={keys}
        placeholder={uploads.length > 0 && !text ? "Add a note about the files…" : "Leave a comment…"}
        className="bg-transparent text-ui leading-[1.45] text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
      />

      <DraftChips uploads={uploads} onRemove={remove} onDescribed={describe} disabled={sending} className="mt-2" />

      {over > 0 && <p className="mt-1.5 text-caption text-app-berry-text">{overText(over)}</p>}

      {error && (
        <p role="alert" className="mt-1.5 text-caption text-app-berry-text">
          {error}
        </p>
      )}

      <div className="mt-1 flex items-center justify-between gap-2">
        <AttachMenu
          projectId={projectId}
          onFiles={addFiles}
          onPick={addPicked}
          disabled={sending}
          className="-ml-1.5 size-[2rem] hover:text-foreground max-lg:size-11"
          iconClassName="size-[1.05rem]"
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          aria-disabled={sending || uploading || undefined}
          disabled={!sending && (!text.trim() || over > 0)}
          className={BUSY}
        >
          {sending ? "Sending" : "Comment"}
        </Button>
      </div>
    </form>
  )
})

export function ActivityFeed({
  task,
  activity,
  comments,
  onComment,
  members = [],
  status = "ready",
  onRetry,
  onEditComment,
  onDeleteComment,
  onOpenAttachment,
}: {
  task: Task
  activity: TaskActivity[]
  comments: TaskComment[]
  /** Without it there is no composer and no editing, for a viewer who can only read */
  onComment?: (text: string, fileIds: string[]) => Promise<void>
  members?: UserSummary[]
  status?: FeedStatus
  onRetry?: () => void
  onEditComment?: (id: string, text: string) => Promise<void>
  onDeleteComment?: (id: string) => Promise<void>
  onOpenAttachment?: (attachment: TaskAttachment) => void
}) {
  const { user } = useAuth()
  const meId = user?.id ?? null
  const headingId = useId()
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const feed = useMemo(() => mergeFeed(activity, comments, task), [activity, comments, task])
  const aiPlace = useMemo(() => ({ kind: "task_comment" as const, taskId: task.id }), [task.id])
  const aiWorking = useAiWorkingIn(aiPlace)

  const people = useMemo(() => {
    const known = new Map<string, Pick<UserSummary, "id" | "first_name" | "last_name">>()
    for (const person of [...members, task.assignee, ...activity.map((row) => row.user), ...comments.map((row) => row.user)]) {
      if (person && !known.has(person.id)) known.set(person.id, person)
    }
    return known
  }, [members, task.assignee, activity, comments])

  // Anyone the feed knows reads by name, while only members of the task's project can be picked, and nobody on a personal task
  const scope = useMemo<MentionScope>(() => {
    const mine = user && { id: user.id, first_name: user.firstName, last_name: user.lastName }
    return { names: namesOf([mine, ...people.values()]), people: task.project_id ? members : [], me: meId, ai: true }
  }, [people, members, user, meId, task.project_id])

  return (
    <MentionContext.Provider value={scope}>
      <section aria-labelledby={headingId} className="flex flex-col gap-2.5 text-ui">
        <h3 id={headingId} className="text-body font-semibold tracking-normal text-foreground">
          Activity
        </h3>

        {status === "loading" ? (
          <FeedSkeleton />
        ) : (
          <ol className="flex flex-col gap-2.5">
            {feed.map((item) => {
              if (item.kind === "created") {
                const creator = item.userId ? (people.get(item.userId) ?? { id: item.userId, first_name: null, last_name: null }) : null
                return (
                  <EventLine key={item.key} at={item.at} icon={<Plus className="size-[1rem]" />}>
                    <span className="font-semibold text-foreground">{actorName(creator, meId)}</span>
                    {markedVia(task.done_via) && <> {markFor(task.done_via, creator)}</>} created this task
                  </EventLine>
                )
              }
              if (item.kind === "activity") {
                return (
                  <EventLine key={item.key} at={item.at} icon={activityIcon(item.activity)}>
                    <Sentence segments={describeActivity(item.activity, meId)} mark={markFor(item.activity.done_via, item.activity.user)} />
                    {item.activity.field === "description" && item.activity.from_value && <OldText text={item.activity.from_value} />}
                  </EventLine>
                )
              }
              return (
                <CommentItem
                  key={item.key}
                  comment={item.comment}
                  mine={!!onComment && item.comment.user_id === meId}
                  onEdit={onEditComment}
                  onDelete={onDeleteComment}
                  onDeleted={() => composerRef.current?.focus()}
                  onOpenAttachment={onOpenAttachment}
                />
              )
            })}
          </ol>
        )}

        {status === "error" && (
          <p role="alert" className="text-caption text-app-berry-text">
            Couldn't load the comments and history.{" "}
            {onRetry && (
              <button type="button" onClick={onRetry} className="cursor-pointer font-medium underline underline-offset-2">
                Try again
              </button>
            )}
          </p>
        )}

        {aiWorking && <AiWorkingRow />}
        <PlaceCards place={aiPlace} />

        {onComment && <Composer ref={composerRef} projectId={task.project_id} onComment={onComment} />}
      </section>
    </MentionContext.Provider>
  )
}

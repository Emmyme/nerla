import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from "react"
import { Link as RouterLink, useNavigate } from "react-router"
import { toast } from "sonner"
import { appPath } from "@/lib/appPath"
import { AttachMenu } from "@/components/files/AttachMenu"
import { DraftChips } from "@/components/files/DraftChips"
import { docRoute } from "@/components/files/fileKinds"
import { FilePreviewDialog } from "@/components/files/FilePreviewDialog"
import { skippedFiles, skippedText, useDraftUploads } from "@/components/files/useDraftUploads"
import { ChevronRight, Ellipsis, Link, Plus, Trash, X } from "@/components/icons"
import BaseModal from "@/components/ui/BaseModal"
import { AutosizeTextarea } from "@/components/ui/autosize-textarea"
import { Button } from "@/components/ui/button"
import { useMenuKeys } from "@/components/ui/check-menu"
import { filesAPI, isRemoved, type Attachment, type TaskAttachment } from "@/lib/api/files"
import { tasksAPI, type Task, type TaskActivity, type TaskComment, type TaskPatch } from "@/lib/api/tasks"
import type { Project } from "@/lib/api/projects"
import type { UserSummary } from "@/lib/api/users"
import { readNotificationsAt, watchNotificationPlaces } from "@/lib/notificationStore"
import { useTimeTracking } from "@/lib/timeStore"
import { TaskTimeLine } from "@/components/time/TaskTimeLine"
import { useTimeImpactText } from "@/components/time/timeImpact"
import { messageOf, SAVE_FAILED } from "@/lib/taskStore"
import { useAiSelect } from "@/lib/aiStore"
import { useAuth } from "@/providers/AuthProvider"
import { matchesMedia } from "@/lib/useMediaQuery"
import { cn } from "@/lib/utils"
import { useCoverDock } from "@/lib/dockCover"
import { TASK_DESCRIPTION_MAX } from "@/types/tasks"
import { ActivityFeed, type FeedStatus } from "./ActivityFeed"
import { AttachmentPreview } from "./AttachmentPreview"
import { DueDatePopover } from "./DueDatePopover"
import { AssigneePicker, PriorityPicker, ProjectPicker, StatusPicker } from "./pickers"
import { ProjectChip } from "./ProjectChip"
import { whenSelectionRests } from "./useTaskPanelRoute"

export type TaskPanelPicker = "status" | "priority" | "assignee"
type PanelProject = Pick<Project, "id" | "name" | "slug" | "key" | "color"> & { status?: string }

type TaskPanelProps = {
  task: Task | null
  members: UserSummary[]
  projects: PanelProject[]
  onClose: () => void
  onUpdate: (patch: TaskPatch) => Promise<string | null>
  onDelete: () => Promise<void>
  pickerOpen?: TaskPanelPicker | null
  onPickerOpenChange?: (picker: TaskPanelPicker | null) => void
  /** Look only, as a workspace admin outside the project */
  readOnly?: boolean
}

const DELETE_FAILED = "Couldn't delete the task. Check your connection and try again."
const ATTACH_FAILED = "Couldn't add the file. Try again."
const REMOVE_FAILED = "Couldn't remove the file. Try again."
const SAVED = "Saved"

const ACTIVITY_REFETCH_MS = 250
const NOTICE_MS = 2000
const FEED_CACHE_SIZE = 200

// Task lists carry no files, so the panel loads the task's own files with its feed
type Feed = { activity: TaskActivity[]; comments: TaskComment[]; files: Attachment[] }

// Feeds stay for the session, so a task opened again shows at once and refreshes in the background
const feeds = new Map<string, Feed>()

function rememberFeed(id: string, feed: Feed) {
  feeds.delete(id)
  feeds.set(id, feed)
  if (feeds.size > FEED_CACHE_SIZE) feeds.delete(feeds.keys().next().value!)
}

const PICKER = "-ml-2 px-2"
const HEADER_BUTTON = "size-[1.75rem] rounded-md text-muted-foreground hover:text-foreground max-lg:size-11"
const EDITABLE =
  "-mx-1.5 rounded-md bg-transparent px-1.5 text-foreground transition-colors duration-150 placeholder:font-normal placeholder:text-muted-foreground hover:bg-app-hover focus-visible:bg-app-sunk focus-visible:outline-none focus-visible:ring-[0.0625rem] focus-visible:ring-border"
const READABLE =
  "-mx-1.5 rounded-md bg-transparent px-1.5 text-foreground placeholder:font-normal placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-[0.0625rem] focus-visible:ring-border"
// A picker that only shows its value keeps full colour
const SHOWN = "disabled:opacity-100"

function titleFirst(): boolean {
  return matchesMedia("(pointer: fine) and (min-width: 64rem)")
}

function openedByKeyboard(opener: Element | null): boolean {
  try {
    return !!opener?.matches(":focus-visible")
  } catch {
    return false
  }
}

function taskLink(task: Task): string {
  const path = task.project ? `/project/${task.project.slug}?task=${task.id}` : `/?task=${task.id}`
  return `${window.location.origin}${appPath(path)}`
}

export function TaskPanel(props: TaskPanelProps) {
  const openId = props.task?.id ?? null
  useCoverDock(openId !== null)
  useEffect(() => {
    if (!openId) return
    // An open task reads what points at it, including what arrives while it is on screen
    const place = `task:${openId.toLowerCase()}`
    readNotificationsAt(place)
    return watchNotificationPlaces((at) => at === place && document.visibilityState === "visible")
  }, [openId])
  const rootRef = useRef<HTMLElement | null>(null)
  const titleRef = useRef<HTMLTextAreaElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const shownId = useRef<string | null>(null)

  const restoreFocus = useCallback(() => {
    const opener = openerRef.current
    if (opener?.isConnected) opener.focus()
  }, [])

  useLayoutEffect(() => {
    const previous = shownId.current
    shownId.current = openId
    if (openId === previous) return
    const active = document.activeElement
    const lost = !active || active === document.body
    if (openId === null) {
      if (lost) restoreFocus()
      return
    }
    const inside = !!active && !!rootRef.current?.contains(active)
    if (!inside && !lost && active instanceof HTMLElement) openerRef.current = active
    // Switching tasks from the list keeps focus on the list, so J and K keep working.
    // Only a keyboard open on desktop lands in the title. A click or a touch gets the panel itself.
    const toTitle = titleFirst() && openedByKeyboard(active)
    if (previous === null || lost || inside) (toTitle ? titleRef.current : rootRef.current)?.focus({ preventScroll: true })
  }, [openId, restoreFocus])

  useLayoutEffect(
    () => () => {
      const active = document.activeElement
      const inside =
        !active ||
        active === document.body ||
        !!rootRef.current?.contains(active) ||
        !!active.closest('[role="dialog"][aria-modal="true"], [role="listbox"]')
      if (shownId.current !== null && inside) restoreFocus()
      shownId.current = null
    },
    [restoreFocus],
  )

  if (!props.task) return null
  return <TaskPanelBody key={props.task.id} {...props} task={props.task} rootRef={rootRef} titleRef={titleRef} />
}

function TaskPanelBody({
  task,
  members,
  projects,
  onClose,
  onUpdate,
  onDelete,
  pickerOpen,
  onPickerOpenChange,
  readOnly = false,
  rootRef,
  titleRef,
}: TaskPanelProps & {
  task: Task
  rootRef: MutableRefObject<HTMLElement | null>
  titleRef: MutableRefObject<HTMLTextAreaElement | null>
}) {
  const ids = useId()
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null)
  const [innerPicker, setInnerPicker] = useState<TaskPanelPicker | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [cached] = useState(() => feeds.get(task.id))
  const [activity, setActivity] = useState<TaskActivity[]>(cached?.activity ?? [])
  const [comments, setComments] = useState<TaskComment[]>(cached?.comments ?? [])
  const [feedStatus, setFeedStatus] = useState<FeedStatus>(cached ? "ready" : "loading")
  const [reloadKey, setReloadKey] = useState(0)
  const [viewing, setViewing] = useState<TaskAttachment | null>(null)
  const navigate = useNavigate()
  const [taskFiles, setTaskFiles] = useState<Attachment[]>(cached?.files ?? task.attachments)
  // A removed file has no name left to show
  const [removingFile, setRemovingFile] = useState<{ id: string; file_name: string | null } | null>(null)
  const [fileBusy, setFileBusy] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  // Only a load with nothing cached to show says so, and the section never stands in as an empty list
  const [filesFailed, setFilesFailed] = useState(false)
  const [filesRetrying, setFilesRetrying] = useState(false)
  const adding = useDraftUploads()
  const attaching = useRef(new Set<string>())
  const { user } = useAuth()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>()
  const activityRequest = useRef(0)
  const seenUpdatedAt = useRef(task.updated_at)

  const personal = task.project_id === null
  const timeOn = useTimeTracking().enabled
  const impact = useTimeImpactText(confirmingDelete ? { taskId: task.id } : null, "task")
  const openPicker = pickerOpen !== undefined ? pickerOpen : innerPicker
  const setPicker = useCallback(
    (picker: TaskPanelPicker | null) => {
      if (pickerOpen === undefined) setInnerPicker(picker)
      onPickerOpenChange?.(picker)
    },
    [pickerOpen, onPickerOpenChange],
  )
  const pickerControl = (picker: TaskPanelPicker) => ({
    open: openPicker === picker,
    onOpenChange: (open: boolean) => setPicker(open ? picker : null),
  })

  useEffect(() => {
    if (personal && openPicker === "assignee") setPicker(null)
  }, [personal, openPicker, setPicker])

  // A cached feed refreshes quietly, a failed refresh keeps what is shown
  useEffect(() => {
    const controller = new AbortController()
    const quiet = reloadKey === 0 && cached !== undefined
    if (!quiet) setFeedStatus("loading")
    const cancel = whenSelectionRests(() => {
      const request = ++activityRequest.current
      const { signal } = controller
      Promise.allSettled([
        tasksAPI.getTaskActivity(task.id, signal),
        tasksAPI.getTaskComments(task.id, signal),
        tasksAPI.getTask(task.id, signal),
      ]).then(([rows, list, full]) => {
        if (signal.aborted) return
        if (rows.status === "fulfilled" && request === activityRequest.current) setActivity(rows.value)
        if (list.status === "fulfilled") setComments(list.value)
        if (full.status === "fulfilled") setTaskFiles(full.value.attachments)
        setFilesFailed(full.status === "rejected" && !cached?.files)
        const ok = rows.status === "fulfilled" && list.status === "fulfilled"
        if (ok || !quiet) setFeedStatus(ok ? "ready" : "error")
      })
    })
    return () => {
      cancel()
      controller.abort()
    }
  }, [task.id, reloadKey, cached])

  // The AI may have changed the task or answered in its comments, so its feed refreshes quietly when a request ends
  const aiEnded = useAiSelect((state) => state.endedAt)
  const seenAiEnd = useRef(aiEnded)
  useEffect(() => {
    if (aiEnded === seenAiEnd.current) return
    seenAiEnd.current = aiEnded
    const controller = new AbortController()
    const request = ++activityRequest.current
    Promise.allSettled([tasksAPI.getTaskActivity(task.id, controller.signal), tasksAPI.getTaskComments(task.id, controller.signal)]).then(
      ([rows, list]) => {
        if (controller.signal.aborted) return
        if (rows.status === "fulfilled" && request === activityRequest.current) setActivity(rows.value)
        if (list.status === "fulfilled") setComments(list.value)
      },
    )
    return () => controller.abort()
  }, [aiEnded, task.id])

  // Saves in quick succession refetch the activity once
  useEffect(() => {
    if (seenUpdatedAt.current === task.updated_at) return
    seenUpdatedAt.current = task.updated_at
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const request = ++activityRequest.current
      tasksAPI
        .getTaskActivity(task.id, controller.signal)
        .then((rows) => {
          if (request === activityRequest.current) setActivity(rows)
        })
        .catch(() => {})
    }, ACTIVITY_REFETCH_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [task.id, task.updated_at])

  useEffect(() => {
    if (feedStatus === "ready") rememberFeed(task.id, { activity, comments, files: taskFiles })
  }, [task.id, feedStatus, activity, comments, taskFiles])

  useEffect(() => () => clearTimeout(noticeTimer.current), [])

  const flash = (text: string) => {
    setNotice(text)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS)
  }

  const update = (patch: TaskPatch) => {
    setUpdateError(null)
    onUpdate(patch)
      .catch((err: unknown) => messageOf(err, SAVE_FAILED))
      .then((message) => {
        setUpdateError(message)
        if (message === null) flash(SAVED)
        else setNotice((current) => (current === SAVED ? null : current))
      })
  }

  const commitTitle = () => {
    if (titleDraft === null) return
    const next = titleDraft.replace(/\s+/g, " ").trim()
    setTitleDraft(null)
    if (next && next !== task.title) update({ title: next })
  }

  const commitDescription = () => {
    if (descriptionDraft === null) return
    const next = descriptionDraft.trim()
    setDescriptionDraft(null)
    if (next !== (task.description ?? "").trim()) update({ description: next || null })
  }

  const titleKeys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === "Enter") {
      e.preventDefault()
      descriptionRef.current?.focus()
    } else if (e.key === "Escape" && titleDraft !== null && titleDraft !== task.title) {
      e.stopPropagation()
      setTitleDraft(null)
    }
  }

  const descriptionKeys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === "Escape" && descriptionDraft !== null && descriptionDraft !== (task.description ?? "")) {
      e.stopPropagation()
      setDescriptionDraft(null)
    }
  }

  const closeOnEscape = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return
    e.preventDefault()
    onClose()
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(taskLink(task))
      flash("Link copied")
    } catch {
      flash("Couldn't copy the link")
    }
  }

  const confirmDelete = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await onDelete()
      setConfirmingDelete(false)
    } catch (err) {
      setDeleteError(messageOf(err, DELETE_FAILED))
    } finally {
      setDeleting(false)
    }
  }

  const postComment = async (text: string, fileIds: string[]) => {
    const comment = await tasksAPI.createTaskComment(task.id, text, fileIds)
    setComments((current) => [...current, comment])
    const skipped = Array.isArray(comment.attachments) ? skippedFiles(fileIds, comment.attachments) : 0
    if (skipped > 0) toast.error(skippedText(skipped))
  }

  // Each chip is attached as soon as its upload is in, or at once for a file picked from Nerla
  const { uploads: addingUploads, drop: dropAdding, fail: failAdding, hold: holdAdding } = adding
  useEffect(() => {
    const keepFile = (attachment: Attachment) =>
      setTaskFiles((current) => (current.some((file) => file.id === attachment.id) ? current : [...current, attachment]))
    for (const upload of addingUploads) {
      if (!upload.file || upload.error || attaching.current.has(upload.key)) continue
      attaching.current.add(upload.key)
      const release = holdAdding([upload.file.id])
      filesAPI.attachFile({ fileId: upload.file.id, taskId: task.id }).then(
        (attachment) => {
          attaching.current.delete(upload.key)
          // Removed from the chips while it was being attached, so it comes off the task again
          if (upload.abort.signal.aborted) {
            filesAPI.removeFromTask(task.id, attachment.id).then(release, () => {
              release()
              keepFile(attachment)
              toast.error(REMOVE_FAILED)
            })
            return
          }
          keepFile(attachment)
          dropAdding(upload)
          release()
        },
        (err: unknown) => {
          attaching.current.delete(upload.key)
          release()
          if (!upload.abort.signal.aborted) failAdding(upload.key, messageOf(err, ATTACH_FAILED))
        },
      )
    }
  }, [addingUploads, dropAdding, failAdding, holdAdding, task.id])

  const retryFiles = async () => {
    setFilesRetrying(true)
    try {
      setTaskFiles((await tasksAPI.getTask(task.id)).attachments)
      setFilesFailed(false)
    } catch {
      setFilesFailed(true)
    } finally {
      setFilesRetrying(false)
    }
  }

  const removeFile = async () => {
    const file = removingFile
    if (!file) return
    setFileBusy(true)
    setFileError(null)
    try {
      await filesAPI.removeFromTask(task.id, file.id)
      setTaskFiles((current) => current.filter((other) => other.id !== file.id))
      setRemovingFile(null)
    } catch (err) {
      setFileError(messageOf(err, REMOVE_FAILED))
    } finally {
      setFileBusy(false)
    }
  }

  const editComment = async (id: string, text: string) => {
    const saved = await tasksAPI.updateTaskComment(id, text)
    setComments((current) => current.map((comment) => (comment.id === id ? saved : comment)))
  }

  const deleteComment = async (id: string) => {
    await tasksAPI.deleteTaskComment(id)
    setComments((current) => current.filter((comment) => comment.id !== id))
  }

  const openFile = (file: TaskAttachment) => {
    const route = docRoute({ id: file.id, mimeType: file.mime_type })
    if (route) navigate(route)
    else setViewing(file)
  }

  const onComments = (change: (file: Attachment) => Attachment) =>
    setComments((current) =>
      current.map((comment) =>
        Array.isArray(comment.attachments) && comment.attachments.some((file) => change(file) !== file)
          ? { ...comment, attachments: comment.attachments.map(change) }
          : comment,
      ),
    )

  // A 404 means the file is gone, so its tile says so at once. The next load of the task brings the rest
  const markMissing = (fileId: string) => {
    const change = (file: Attachment): Attachment => (file.id === fileId && !isRemoved(file) ? { id: file.id, removed: true } : file)
    setTaskFiles((current) => (current.some((file) => change(file) !== file) ? current.map(change) : current))
    onComments(change)
  }

  const describeFile = (fileId: string, altText: string | null) => {
    const change = (file: Attachment): Attachment => (file.id === fileId && !isRemoved(file) ? { ...file, alt_text: altText } : file)
    setTaskFiles((current) => current.map(change))
    onComments(change)
  }

  const files = useMemo(() => {
    const all = [...taskFiles, ...comments.flatMap((comment) => comment.attachments)]
    return all.filter((file, index) => all.findIndex((other) => other.id === file.id) === index)
  }, [taskFiles, comments])
  const onTask = useMemo(() => new Set(taskFiles.map((file) => file.id)), [taskFiles])

  const projectChoices = useMemo(() => {
    const choices: PanelProject[] = projects.filter((project) => project.status !== "archived" || project.id === task.project_id)
    if (task.project && !choices.some((project) => project.id === task.project_id)) choices.unshift(task.project)
    return choices
  }, [projects, task.project, task.project_id])

  return (
    <section
      ref={rootRef}
      data-task-panel=""
      tabIndex={-1}
      aria-label={task.identifier ? `${task.identifier} ${task.title}` : task.title}
      onKeyDown={closeOnEscape}
      className="flex h-full min-h-0 flex-col bg-card text-foreground outline-none"
    >
      <header className="flex shrink-0 items-center gap-1.5 px-5 pt-3.5 pb-1 text-caption font-medium text-muted-foreground max-lg:px-4 max-lg:pt-1.5">
        {task.project ? (
          <RouterLink
            to={`/project/${task.project.slug}`}
            className="flex min-w-0 rounded-sm transition-colors duration-150 hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
          >
            <ProjectChip project={task.project} className="text-inherit" />
          </RouterLink>
        ) : (
          <ProjectChip project={null} />
        )}
        {task.identifier && (
          <>
            <ChevronRight aria-hidden="true" weight="bold" className="size-[0.7rem] shrink-0" />
            <span className="shrink-0 tracking-[0.01em] tabular-nums">{task.identifier}</span>
          </>
        )}
        <span role="status" className="min-w-0 truncate pl-1.5 font-medium">
          {notice}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <MoreMenu onCopyLink={copyLink} onDelete={readOnly ? undefined : () => setConfirmingDelete(true)} />
          <Button type="button" variant="ghost" size="icon" aria-label="Close task" onClick={onClose} className={HEADER_BUTTON}>
            <X aria-hidden="true" className="size-[1rem]" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex flex-col gap-3.5 px-5 pt-2 pb-6 max-lg:px-4">
          <div className="flex flex-col gap-1">
            <AutosizeTextarea
              ref={titleRef}
              aria-label="Title"
              value={titleDraft ?? task.title}
              maxLength={255}
              readOnly={readOnly}
              onChange={(e) => setTitleDraft(e.target.value.replace(/\n/g, " "))}
              onBlur={commitTitle}
              onKeyDown={titleKeys}
              className={cn(readOnly ? READABLE : EDITABLE, "py-0.5 text-title leading-[1.25] font-semibold tracking-[-0.01em]")}
            />
            <AutosizeTextarea
              ref={descriptionRef}
              aria-label="Description"
              value={descriptionDraft ?? task.description ?? ""}
              maxLength={TASK_DESCRIPTION_MAX}
              cap="max-h-[min(24rem,50dvh)]"
              placeholder={readOnly ? "No description" : "Add a description…"}
              readOnly={readOnly}
              onChange={(e) => setDescriptionDraft(e.target.value)}
              onBlur={commitDescription}
              onKeyDown={descriptionKeys}
              className={cn(readOnly ? READABLE : EDITABLE, "py-1 text-ui leading-[1.55]")}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1 border-y-[0.0625rem] border-border py-2.5 text-ui">
              <Property label="Status">
                <StatusPicker
                  value={task.status}
                  onChange={(status) => update({ status })}
                  {...pickerControl("status")}
                  disabled={readOnly}
                  className={cn(PICKER, SHOWN)}
                />
              </Property>
              <Property label="Priority">
                <PriorityPicker
                  value={task.priority}
                  onChange={(priority) => update({ priority })}
                  {...pickerControl("priority")}
                  disabled={readOnly}
                  className={cn(PICKER, SHOWN)}
                />
              </Property>
              {!personal && (
                <Property label="Assignee">
                  <AssigneePicker
                    value={task.assigned_to}
                    members={members}
                    assignee={task.assignee}
                    profile
                    onChange={(assigned_to) => update({ assigned_to })}
                    {...pickerControl("assignee")}
                    disabled={readOnly}
                    className={cn(PICKER, SHOWN)}
                  />
                </Property>
              )}
              <Property label="Due date">
                <DueDatePopover
                  value={task.due_date}
                  onChange={(due_date) => update({ due_date })}
                  disabled={readOnly}
                  className={cn(PICKER, SHOWN)}
                />
              </Property>
              <Property label="Project">
                <ProjectPicker
                  value={task.project_id}
                  projects={projectChoices}
                  onChange={(project_id) => update({ project_id })}
                  disabled={readOnly}
                  className={cn(PICKER, SHOWN)}
                />
              </Property>
              {timeOn && (
                <Property label="Time" top>
                  <TaskTimeLine task={task} readOnly={readOnly} />
                </Property>
              )}
            </dl>
            {updateError && (
              <p role="alert" className="text-caption text-app-berry-text">
                {updateError}
              </p>
            )}
          </div>

          <section aria-labelledby={`${ids}-files`} className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <h3 id={`${ids}-files`} className="flex items-baseline gap-1.5 text-body font-semibold tracking-normal text-foreground">
                Files
                {files.length > 0 && !filesFailed && (
                  <span className="text-caption font-medium text-muted-foreground tabular-nums">{files.length}</span>
                )}
              </h3>
              {!readOnly && (
                <AttachMenu
                  projectId={task.project_id}
                  label="Add files"
                  align="end"
                  onFiles={adding.addFiles}
                  onPick={adding.addPicked}
                  className="-mr-1.5 h-8 w-auto gap-1.5 px-2 text-caption font-medium max-lg:h-11 max-lg:w-auto"
                >
                  <Plus aria-hidden="true" className="size-[0.9rem]" />
                  Add files
                </AttachMenu>
              )}
            </div>
            {!readOnly && <DraftChips uploads={adding.uploads} onRemove={adding.remove} onDescribed={adding.describe} />}
            {filesFailed && (
              <p role="alert" className="text-caption text-muted-foreground">
                Couldn't load this task's files.{" "}
                <button
                  type="button"
                  onClick={() => void retryFiles()}
                  aria-busy={filesRetrying || undefined}
                  className="cursor-pointer rounded-sm font-medium text-foreground underline underline-offset-2 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none aria-busy:opacity-50"
                >
                  Try again
                </button>
              </p>
            )}
            {files.length > 0 && (
              <ul className="grid grid-flow-row-dense grid-cols-[repeat(auto-fill,minmax(5.75rem,1fr))] gap-x-2 gap-y-3">
                {files.map((file) => (
                  <li key={file.id} className="min-w-0 has-[[data-media-open]]:col-span-full has-[[data-removed]]:col-span-2">
                    <AttachmentPreview
                      attachment={file}
                      onOpen={() => !isRemoved(file) && openFile(file)}
                      onMissing={() => markMissing(file.id)}
                      onDescribed={(altText) => describeFile(file.id, altText)}
                      actions={{
                        canSave: !isRemoved(file) && !!file.uploaded_by && file.uploaded_by !== user?.id,
                        canDescribe: !readOnly && !isRemoved(file) && !!user && file.uploaded_by === user.id,
                        onRemove:
                          !readOnly && onTask.has(file.id)
                            ? () => {
                                setFileError(null)
                                setRemovingFile({ id: file.id, file_name: isRemoved(file) ? null : file.file_name })
                              }
                            : undefined,
                        removeLabel: "Remove from task",
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
            {removingFile && (
              <div
                onKeyDown={(e) => {
                  if (e.key !== "Escape" || fileBusy) return
                  e.stopPropagation()
                  setRemovingFile(null)
                }}
                className="flex flex-wrap items-center justify-end gap-1.5 rounded-lg bg-app-sunk px-3 py-2"
              >
                <span className="mr-auto min-w-0 text-caption font-medium text-foreground">
                  {removingFile.file_name ? (
                    <>
                      Remove <span className="break-all">{removingFile.file_name}</span> from this task? It stays in Files.
                    </>
                  ) : (
                    "Remove this file from the task?"
                  )}
                </span>
                <Button type="button" variant="ghost" size="sm" autoFocus disabled={fileBusy} onClick={() => setRemovingFile(null)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={fileBusy}
                  aria-busy={fileBusy || undefined}
                  onClick={() => void removeFile()}
                >
                  Remove
                </Button>
              </div>
            )}
            {fileError && (
              <p role="alert" className="text-caption text-app-berry-text">
                {fileError}
              </p>
            )}
          </section>

          <ActivityFeed
            task={task}
            activity={activity}
            comments={comments}
            members={members}
            status={feedStatus}
            onRetry={() => setReloadKey((key) => key + 1)}
            onComment={readOnly ? undefined : postComment}
            onEditComment={readOnly ? undefined : editComment}
            onDeleteComment={readOnly ? undefined : deleteComment}
            onOpenAttachment={openFile}
          />
        </div>
      </div>

      <FilePreviewDialog
        file={
          viewing && {
            id: viewing.id,
            name: viewing.file_name,
            size: viewing.file_size,
            mimeType: viewing.mime_type,
            altText: viewing.alt_text,
          }
        }
        onClose={() => setViewing(null)}
        onMissing={markMissing}
      />

      <BaseModal
        isOpen={confirmingDelete}
        onClose={() => {
          if (!deleting) setConfirmingDelete(false)
        }}
        title="Delete task?"
        maxWidth="sm"
      >
        <div className="flex flex-col gap-4 p-6">
          <p className="text-body leading-[1.5] text-muted-foreground">
            <span className="font-semibold text-foreground">{task.title}</span>
          </p>
          <p className="-mt-2 text-body leading-[1.5] text-muted-foreground">
            It moves to Trash with its comments. You can restore it for 30 days.
            {impact && ` ${impact}`}
          </p>
          {deleteError && (
            <p role="alert" className="text-ui text-app-berry-text">
              {deleteError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" autoFocus onClick={() => setConfirmingDelete(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Deleting" : "Delete task"}
            </Button>
          </div>
        </div>
      </BaseModal>
    </section>
  )
}

function Property({ label, top = false, children }: { label: string; top?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className={cn("font-medium text-muted-foreground", top && "self-start leading-[1.875rem] max-lg:leading-11")}>{label}</dt>
      <dd className="flex min-w-0 items-center">{children}</dd>
    </>
  )
}

function MoreMenu({ onCopyLink, onDelete }: { onCopyLink: () => void; onDelete?: () => void }) {
  const { open, setOpen, button: buttonRef, menu: menuRef, close, onKeyDown: menuKeys } = useMenuKeys()
  const menuId = useId()

  const choose = (action: () => void) => {
    close()
    action()
  }

  const item =
    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-ui font-medium outline-none transition-colors duration-150 hover:bg-app-hover focus-visible:bg-app-hover max-lg:min-h-11"

  return (
    <div className="relative">
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault()
            setOpen(true)
          }
        }}
        className={cn(HEADER_BUTTON, open && "bg-app-hover text-foreground")}
      >
        <Ellipsis aria-hidden="true" weight="bold" className="size-[1rem]" />
      </Button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Task actions"
          onKeyDown={menuKeys}
          className="absolute top-full right-0 z-20 mt-1 flex min-w-[11rem] flex-col rounded-lg border-[0.0625rem] border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-popover)] duration-150 animate-in fade-in-0 zoom-in-95"
        >
          <button type="button" role="menuitem" tabIndex={-1} className={cn(item, "text-foreground")} onClick={() => choose(onCopyLink)}>
            <Link aria-hidden="true" className="size-[1rem] text-muted-foreground" />
            Copy link
          </button>
          {onDelete && (
            <button type="button" role="menuitem" tabIndex={-1} className={cn(item, "text-foreground")} onClick={() => choose(onDelete)}>
              <Trash aria-hidden="true" className="size-[1rem] text-muted-foreground" />
              Delete task…
            </button>
          )}
        </div>
      )}
    </div>
  )
}

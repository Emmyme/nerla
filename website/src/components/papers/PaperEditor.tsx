import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type * as Y from "yjs"
import { toast } from "sonner"
import Collaboration from "@tiptap/extension-collaboration"
import CollaborationCaret from "@tiptap/extension-collaboration-caret"
import { TaskList } from "@tiptap/extension-list"
import Placeholder from "@tiptap/extension-placeholder"
import { TableKit } from "@tiptap/extension-table"
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { batchLimit, uploadFailure } from "@/components/files/uploadErrors"
import { Comment, Eye, Recent, Search, WifiSlash } from "@/components/icons"
import { Skeleton } from "@/components/ui/skeleton"
import { filesAPI, type DocLevel, type FileItem } from "@/lib/api/files"
import { papersAPI, type CommentAnchor, type CommentThread, type DocAccess, type DocPerson } from "@/lib/api/papers"
import type { Task } from "@/lib/api/tasks"
import { createDocProvider, type DocProvider } from "@/lib/collab"
import { docColor } from "@/lib/docColors"
import { scrollBehavior } from "@/lib/motion"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"
import { BoardLinkPicker } from "./BoardLinkPicker"
import { anchorFor, attachedAnchors, CommentHighlights, PENDING, rangeOf, showAnchors, type ShownAnchor } from "./commentAnchors"
import { COMMENT_SHORTCUT, CommentsPanel, commentsTitle, useCommentShortcut } from "./CommentsPanel"
import { DocCommentsContext, useDocComments, type Pending } from "./commentsStore"
import type { AnchorView } from "./CommentThread"
import { BoardBlock } from "./extensions/boardBlock"
import { BoardLink } from "./extensions/boardLink"
import { FindReplace } from "./extensions/findReplace"
import { PaperImage } from "./extensions/image"
import { paperMention } from "./extensions/mention"
import { ReadOnlyPaper } from "./extensions/readOnlyPaper"
import { SlashMenu } from "./extensions/slashMenu"
import { TaskLine, type MakeTaskRequest } from "./extensions/taskLine"
import { FindBar } from "./FindBar"
import { MakeTaskDialog } from "./MakeTaskDialog"
import { PaperToolbar } from "./PaperToolbar"
import { SuggestionMenu, SuggestionMenuStore } from "./SuggestionMenu"
import { TaskSummaries } from "./taskSummaries"
import { useLiveStatus } from "./useLiveStatus"
import { VersionHistory } from "./VersionHistory"
import "./paper.css"

export type PaperEditorProps = {
  fileId: string
  level: DocLevel
  /** The call share the paper opened through */
  shareId?: string
  /** A guest in a call signs in with a fresh doc token */
  guestToken?: () => Promise<string>
  /** How a guest shows to other users in the paper */
  guestName?: string
  /** Laid into an empty paper once, only by the editor of the user who made it */
  template?: JSONContent[]
  /** Inside the call's panel */
  compact?: boolean
  /** The paper's project, where Make task starts */
  projectId?: string | null
  /** The live server let the editor in again at another level, or turned it away */
  onAccessChange?: () => void
  /** The editor once it exists, for printing */
  onEditor?: (editor: Editor | null) => void
}

const LEVEL_TAG: Record<Exclude<DocLevel, "edit">, string> = { view: "View only", comment: "Can comment" }

const imagesIn = (list: FileList | null | undefined) => Array.from(list ?? []).filter((file) => file.type.startsWith("image/"))

const TOP_BUTTON =
  "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-ring max-lg:size-11 aria-expanded:bg-app-selected aria-expanded:text-foreground"
/** Beside the paper on desktop, kept in view while the paper scrolls and clear of the chat bar */
const SIDE_PANEL =
  "lg:sticky lg:top-4 lg:h-[calc(100dvh-var(--titlebar-h)-var(--chat-space,0rem)-8rem)] lg:min-h-[20rem] lg:w-[22rem] lg:shrink-0 lg:self-start"

type Panel = "comments" | "history"

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id))

function EditorSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 pt-2">
      <Skeleton className="h-[1rem] w-[70%]" />
      <Skeleton className="h-[1rem] w-[85%]" />
      <Skeleton className="h-[1rem] w-[55%]" />
    </div>
  )
}

/** A paper, live with every user who has it open. Viewers and commenters read it, editors write */
export default function PaperEditor(props: PaperEditorProps) {
  const { fileId, shareId, guestToken } = props
  const [live, setLive] = useState<DocProvider | null>(null)
  const token = useRef(guestToken)
  token.current = guestToken
  const asGuest = !!guestToken

  useEffect(() => {
    const created = createDocProvider(fileId, { shareId, guestToken: asGuest ? () => token.current!() : undefined })
    setLive(created)
    return () => {
      setLive(null)
      created.destroy()
    }
  }, [fileId, shareId, asGuest])

  if (!live) {
    return (
      <div className={cn("paper-content", props.compact && "is-compact")}>
        <span role="status" className="sr-only">
          Opening the paper
        </span>
        <EditorSkeleton />
      </div>
    )
  }
  // A new level makes a new editor on the same connection, so every part of it reads the level afresh
  return <LiveEditor key={props.level} live={live} {...props} />
}

function LiveEditor({
  live,
  fileId,
  level,
  shareId,
  guestToken,
  guestName,
  template,
  compact = false,
  projectId = null,
  onAccessChange,
  onEditor,
}: PaperEditorProps & { live: DocProvider }) {
  const { user } = useAuth()
  const me = user?.id ?? null
  const editable = level === "edit"
  // Guests have no account, so images, board links and tasks stay with members. The server refuses them anyway
  const member = !guestToken
  const canUpload = editable && member
  const menu = useMemo(() => new SuggestionMenuStore(), [])
  const summaries = useMemo(() => new TaskSummaries(), [])
  const people = useRef<DocPerson[]>([])
  const { synced, offline, denied } = useLiveStatus(live.provider, onAccessChange)
  const [finding, setFinding] = useState(false)
  const [making, setMaking] = useState<MakeTaskRequest | null>(null)
  const [linking, setLinking] = useState(false)
  const imagePicker = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const access = useRef<() => Promise<DocAccess>>(async () => ({}))
  access.current = async () => ({ shareId: shareId ?? null, docToken: guestToken ? await guestToken() : null })
  const make = useRef<(request: MakeTaskRequest) => void>(() => undefined)
  make.current = setMaking
  const desktop = useIsDesktop()
  // Viewers never get comments, so nothing about them mounts for a viewer
  const canComment = level !== "view"
  // A commenter moves a caret and selects with the keyboard to comment on words, and still can't change them
  const commenting = level === "comment"
  // Whom a mention can name, read once for the paper and its comments. A guest and a viewer have none to offer
  const peopleRead = useMemo(() => {
    if (!member || !canComment) return null
    const read = papersAPI.people(fileId, shareId)
    read.catch(() => undefined)
    return read
  }, [fileId, shareId, member, canComment])
  const comments = useDocComments(
    canComment ? { fileId, provider: live.provider, access: () => access.current(), member, people: peopleRead } : null,
  )
  const [panel, setPanel] = useState<Panel | null>(null)
  const [panelFocus, setPanelFocus] = useState(true)
  const [pending, setPending] = useState<Pending | null>(null)
  const [attached, setAttached] = useState<ReadonlySet<string>>(() => new Set())
  const openThread = useRef<(id: string) => void>(() => undefined)

  const editorRef = useRef<Editor | null>(null)
  const upload = useCallback(
    async (files: File[], at?: number) => {
      const limit = batchLimit()
      for (const file of files) {
        const toastId = toast.loading(`Uploading ${file.name}`)
        try {
          const saved = await filesAPI.uploadFile(file, { purpose: "doc", docId: fileId, shareId })
          const editor = editorRef.current
          if (!editor || editor.isDestroyed) return toast.dismiss(toastId)
          const node = { type: "image", attrs: { fileId: saved.id, alt: "" } }
          if (at === undefined) editor.chain().focus().insertContent(node).run()
          else editor.chain().focus().insertContentAt(at, node).run()
          toast.dismiss(toastId)
        } catch (err) {
          toast.error(await uploadFailure(err, file, limit), { id: toastId, description: file.name })
        }
      }
    },
    [fileId, shareId],
  )

  const name = guestToken
    ? (guestName ?? "Guest")
    : user
      ? [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email
      : "Guest"
  const editor = useEditor(
    {
      editable,
      // Editable to the browser only, so the editor's own parts still see a read only paper
      ...(commenting ? { enableCoreExtensions: { editable: false } } : {}),
      extensions: [
        StarterKit.configure({
          undoRedo: false,
          heading: { levels: [1, 2, 3] },
          link: { openOnClick: !editable, autolink: true, defaultProtocol: "https" },
        }),
        Collaboration.configure({ document: live.doc, field: "default" }),
        CollaborationCaret.configure({
          provider: live.provider,
          user: { name, color: docColor(me ?? String(live.doc.clientID)) },
          render: (person: Record<string, string>) => {
            const caret = document.createElement("span")
            caret.className = "collaboration-carets__caret"
            caret.style.setProperty("--caret-color", person.color)
            const label = document.createElement("span")
            label.className = "collaboration-carets__label"
            label.textContent = person.name
            caret.append(label)
            return caret
          },
          selectionRender: (person: Record<string, string>) => ({
            nodeName: "span",
            class: "collaboration-carets__selection",
            style: `background-color: ${person.color}55`,
          }),
        }),
        TaskList,
        TaskLine.configure({ summaries: member ? summaries : null, onMakeTask: member ? (request) => make.current(request) : null }),
        TableKit.configure({ table: { resizable: false } }),
        PaperImage.configure({ access: () => access.current(), docId: fileId }),
        paperMention({ me, people: () => people.current, menu }),
        Placeholder.configure({ placeholder: "Write something, or type / for blocks" }),
        SlashMenu.configure({
          menu,
          onImage: canUpload ? () => imagePicker.current?.click() : null,
          onLinkBoard: member ? () => setLinking(true) : null,
        }),
        BoardBlock.configure({ live, fileId, level, access: () => access.current(), canUpload }),
        BoardLink.configure({ member }),
        FindReplace,
        ...(canComment ? [CommentHighlights.configure({ onOpen: (id) => openThread.current(id) })] : []),
        ...(commenting ? [ReadOnlyPaper] : []),
      ],
      editorProps: {
        attributes: {
          "aria-label": "Paper",
          class: "focus-visible:outline-none",
          // No keyboard pops up on a phone, and no spelling marks on words that can't be changed
          ...(commenting ? { "aria-readonly": "true", inputmode: "none", spellcheck: "false" } : {}),
        },
        handlePaste: (_view, event) => {
          const files = imagesIn(event.clipboardData?.files)
          if (!canUpload || files.length === 0) return false
          event.preventDefault()
          void upload(files)
          return true
        },
        handleDrop: (view, event, _slice, moved) => {
          const files = imagesIn(event.dataTransfer?.files)
          if (!canUpload || moved || files.length === 0) return false
          event.preventDefault()
          void upload(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos)
          return true
        },
      },
    },
    [],
  )
  editorRef.current = editor

  const reportEditor = useRef(onEditor)
  reportEditor.current = onEditor
  useEffect(() => {
    reportEditor.current?.(editor)
    return () => reportEditor.current?.(null)
  }, [editor])

  useEffect(() => {
    summaries.open()
    return () => summaries.close()
  }, [summaries])

  // Whom a mention can name
  useEffect(() => {
    if (!peopleRead) return
    let active = true
    peopleRead.then(
      (found) => {
        if (active) people.current = found
      },
      () => undefined,
    )
    return () => {
      active = false
    }
  }, [peopleRead])

  // A layout such as meeting notes goes into an empty paper once, by the editor that made it
  const laidOut = useRef(false)
  useEffect(() => {
    if (!synced || !template || !editable || laidOut.current || editor.isDestroyed) return
    laidOut.current = true
    if (live.doc.getXmlFragment("default").length > 0) return
    editor.commands.setContent(template)
  }, [synced, template, editable, editor, live])

  // Tasks may have moved on while the paper was in the background
  useEffect(() => {
    const onFocus = () => summaries.refresh()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [summaries])

  // Ctrl F finds in the paper. In the call's panel only while the paper has focus
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "f") return
      if (compact && !box.current?.contains(document.activeElement)) return
      event.preventDefault()
      setFinding(true)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [compact])

  const madeTask = (task: Task) => {
    making?.setTaskId(task.id)
    summaries.put({
      id: task.id,
      identifier: task.identifier,
      title: task.title,
      status: task.status,
      assignee: task.assignee
        ? {
            id: task.assignee.id,
            name: [task.assignee.first_name, task.assignee.last_name].filter(Boolean).join(" "),
            avatarUrl: task.assignee.avatar_url,
          }
        : null,
    })
  }

  const linkBoard = (board: FileItem) => {
    setLinking(false)
    editor
      .chain()
      .focus()
      .insertContent({ type: "boardLink", attrs: { fileId: board.id } })
      .run()
  }

  // The threads' words light up in the paper, the open one and the draft's brighter
  const threads = comments?.threads
  const activeId = comments?.activeId ?? null
  useEffect(() => {
    if (!threads) return
    const shown: ShownAnchor[] = threads.flatMap((thread) =>
      thread.root.anchor?.type === "text" ? [{ id: thread.root.id, anchor: thread.root.anchor }] : [],
    )
    if (pending?.anchor?.type === "text") shown.push({ id: PENDING, anchor: pending.anchor })
    showAnchors(editor, shown, activeId)
  }, [editor, threads, activeId, pending, synced])

  // Which threads still have their words, and which boards are still in the paper
  useEffect(() => {
    if (!canComment) return
    const update = () => {
      const present = new Set(attachedAnchors(editor))
      editor.state.doc.descendants((node) => {
        if (node.type.name === "boardBlock" && node.attrs.boardId) present.add(`board:${node.attrs.boardId}`)
        return !node.isTextblock
      })
      setAttached((was) => (sameIds(was, present) ? was : present))
    }
    update()
    editor.on("transaction", update)
    return () => {
      editor.off("transaction", update)
    }
  }, [editor, canComment])

  // A click on highlighted words opens their thread. On a phone an editor keeps typing instead of getting a sheet
  openThread.current = (id: string) => {
    comments?.setActive(id)
    if (panel === "comments" || (!desktop && editable)) return
    setPanelFocus(false)
    setPanel("comments")
  }

  /** With words selected a new comment starts on them, otherwise the panel opens or closes */
  const comment = () => {
    if (!canComment || !synced) return
    const { from, to, empty } = editor.state.selection
    setPanelFocus(true)
    if (empty || !editor.state.doc.textBetween(from, to, " ").trim()) {
      setPanel((was) => (was === "comments" ? null : "comments"))
      return
    }
    setPending({ anchor: anchorFor(editor, from, to) })
    setPanel("comments")
  }
  useCommentShortcut(comment, { enabled: canComment, within: compact ? box : undefined })

  const pendingDone = (posted: CommentThread | null) => {
    const anchored = pending?.anchor
    setPending(null)
    if (!posted) return void (anchored && editor.commands.focus())
    comments?.setActive(posted.root.id)
    // The words are commented on now, so the Comments button opens and closes the panel again
    const { selection } = editor.state
    if (anchored && !selection.empty) editor.commands.setTextSelection(selection.to)
  }

  const closePanel = () => {
    setPanel(null)
    setPending(null)
    comments?.setActive(null)
  }

  const showWords = (anchor: CommentAnchor) => {
    const range = rangeOf(editor, anchor)
    if (!range) return
    const { node } = editor.view.domAtPos(range.from)
    const element = node instanceof Element ? node : node.parentElement
    element?.scrollIntoView({ block: "center", behavior: scrollBehavior() })
  }

  const showBoard = (boardId: string | null) => {
    let found: number | null = null
    editor.state.doc.descendants((node, pos) => {
      if (found === null && node.type.name === "boardBlock" && node.attrs.boardId === boardId) found = pos
      return found === null
    })
    if (found === null) return
    const element = editor.view.nodeDOM(found)
    if (element instanceof Element) element.scrollIntoView({ block: "center" })
  }

  const viewOf = (anchor: CommentAnchor | null, thread: CommentThread | null): AnchorView => {
    if (!anchor) return { label: "On the paper" }
    if (anchor.type === "text") {
      return { label: `“${anchor.quote}”`, detached: !!thread && !attached.has(thread.root.id), onShow: () => showWords(anchor) }
    }
    return attached.has(`board:${anchor.boardId}`)
      ? { label: "On a board", onShow: () => showBoard(anchor.boardId) }
      : { label: "Board removed", detached: true }
  }

  return (
    <DocCommentsContext.Provider value={comments}>
      <div ref={box} className={cn("flex min-w-0", compact ? "flex-col gap-3" : "gap-6")}>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className={cn("sticky top-0 z-10 flex flex-col gap-2 bg-background pb-2", compact ? "pt-1" : "pt-2")}>
            <div className="flex min-h-8 flex-wrap items-center gap-2">
              {editable ? (
                <PaperToolbar
                  editor={editor}
                  onImage={canUpload ? () => imagePicker.current?.click() : undefined}
                  onLinkBoard={member ? () => setLinking(true) : undefined}
                  className="min-w-0 flex-1"
                />
              ) : (
                <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-app-sunk px-2 text-caption font-medium text-muted-foreground">
                  <Eye aria-hidden="true" className="size-[0.85rem]" />
                  {LEVEL_TAG[level as Exclude<DocLevel, "edit">]}
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center">
                <button type="button" aria-label="Find" title="Find" onClick={() => setFinding(true)} className={TOP_BUTTON}>
                  <Search aria-hidden="true" className="size-[1.125rem] max-lg:size-[1.25rem]" />
                </button>
                {canComment && (
                  <button
                    type="button"
                    aria-label="Comments"
                    title={commentsTitle()}
                    aria-keyshortcuts={COMMENT_SHORTCUT}
                    aria-expanded={panel === "comments"}
                    disabled={!synced}
                    // The selection stays put, so a click comments on it
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={comment}
                    className={TOP_BUTTON}
                  >
                    <Comment aria-hidden="true" className="size-[1.125rem] max-lg:size-[1.25rem]" />
                  </button>
                )}
                {editable && member && (
                  <button
                    type="button"
                    aria-label="Version history"
                    title="Version history"
                    aria-expanded={panel === "history"}
                    onClick={() => {
                      setPanelFocus(true)
                      setPending(null)
                      setPanel((was) => (was === "history" ? null : "history"))
                    }}
                    className={TOP_BUTTON}
                  >
                    <Recent aria-hidden="true" className="size-[1.125rem] max-lg:size-[1.25rem]" />
                  </button>
                )}
              </div>
            </div>
            {finding && <FindBar editor={editor} canReplace={editable} onClose={() => setFinding(false)} />}
            {/* A refusal before the first sync shows instead of the skeleton */}
            {(denied || (offline && synced)) && (
              <p role="status" className="flex items-center gap-2 rounded-lg bg-app-sunk px-3 py-1.5 text-ui text-muted-foreground">
                <WifiSlash aria-hidden="true" className="size-[1rem] shrink-0" />
                {denied
                  ? synced
                    ? "You can't open this paper anymore."
                    : "You can't open this paper."
                  : "Offline. Your changes sync when you're back."}
              </p>
            )}
          </div>

          {!synced && !denied && (
            <>
              <span role="status" className="sr-only">
                Opening the paper
              </span>
              <EditorSkeleton />
            </>
          )}
          <EditorContent editor={editor} className={cn("paper-content", compact && "is-compact", !synced && "hidden")} />
          <SuggestionMenu store={menu} />

          <input
            ref={imagePicker}
            type="file"
            accept="image/*"
            multiple
            hidden
            tabIndex={-1}
            onChange={(event) => {
              const chosen = imagesIn(event.target.files)
              event.target.value = ""
              void upload(chosen)
            }}
          />
          <MakeTaskDialog line={making?.text ?? null} projectId={projectId} onCreated={madeTask} onClose={() => setMaking(null)} />
          <BoardLinkPicker open={linking} onPick={linkBoard} onClose={() => setLinking(false)} />
        </div>
        {panel === "comments" && comments && (
          <CommentsPanel
            comments={comments}
            pending={pending}
            onPendingDone={pendingDone}
            viewOf={viewOf}
            onNew={() => setPending({ anchor: null })}
            emptyText="No comments yet. Select some words, then Comments, or start a new comment on the paper."
            onClose={closePanel}
            autoFocus={panelFocus}
            className={compact ? undefined : SIDE_PANEL}
          />
        )}
        {panel === "history" && editable && member && (
          <VersionHistory
            fileId={fileId}
            shareId={shareId}
            onClose={() => setPanel(null)}
            renderPreview={(doc) => <PaperPreview doc={doc} fileId={fileId} access={() => access.current()} member={member} />}
            className={compact ? undefined : SIDE_PANEL}
          />
        )}
      </div>
    </DocCommentsContext.Provider>
  )
}

/** An old version of a paper, read only and on its own, with no live connection */
export function PaperPreview({
  doc,
  fileId,
  access,
  member,
}: {
  doc: Y.Doc
  fileId: string
  access: () => Promise<DocAccess>
  member: boolean
}) {
  const { user } = useAuth()
  const menu = useMemo(() => new SuggestionMenuStore(), [])
  const summaries = useMemo(() => new TaskSummaries(), [])
  const editor = useEditor(
    {
      editable: false,
      extensions: [
        StarterKit.configure({ undoRedo: false, heading: { levels: [1, 2, 3] }, link: { openOnClick: false } }),
        Collaboration.configure({ document: doc, field: "default" }),
        TaskList,
        TaskLine.configure({ summaries, onMakeTask: null }),
        TableKit.configure({ table: { resizable: false } }),
        PaperImage.configure({ access, docId: fileId }),
        paperMention({ me: user?.id ?? null, people: () => [], menu }),
        BoardBlock.configure({ live: { doc }, fileId, level: "view", access, canUpload: false }),
        BoardLink.configure({ member }),
      ],
      editorProps: { attributes: { "aria-label": "Paper version", class: "focus-visible:outline-none" } },
    },
    [doc],
  )

  useEffect(() => {
    summaries.open()
    return () => summaries.close()
  }, [summaries])

  // Boards in an old version stay out of the live paper's comments
  return (
    <DocCommentsContext.Provider value={null}>
      <EditorContent editor={editor} className="paper-content mx-auto max-w-[48rem]" />
    </DocCommentsContext.Provider>
  )
}

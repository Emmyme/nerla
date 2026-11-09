import "@/lib/excalidrawAssets"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  getNonDeletedElements,
  hashElementsVersion,
  MainMenu,
} from "@excalidraw/excalidraw"
import "@excalidraw/excalidraw/index.css"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { ExcalidrawImperativeAPI, UIOptions } from "@excalidraw/excalidraw/types"
import type { Awareness } from "y-protocols/awareness"
import type * as Y from "yjs"
import { uploadFailure } from "@/components/files/uploadErrors"
import { Comment, Question, Sticker as StickerIcon, StickyNote } from "@/components/icons"
import { TOOL, Toolbar } from "@/components/ui/toolbar"
import { filesAPI, type DocLevel } from "@/lib/api/files"
import { papersAPI } from "@/lib/api/papers"
import { runFromMenu } from "@/lib/dialogOpener"
import { docColor } from "@/lib/docColors"
import { applyRemote, bindBoard, bindPresence } from "@/lib/excalidrawYjs"
import { openShortcuts } from "@/lib/shortcutsDialog"
import { useMediaQuery } from "@/lib/useMediaQuery"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"
import { boardFile, withHeldImages, type BoardAccess } from "./boardFiles"
import type { CommentPin } from "./boardComments"
import { COMMENT_SHORTCUT, commentsTitle } from "./CommentsPanel"
import { lightBoardMutedText, lightBoardSurface, useBoardTheme } from "./boardTheme"
import { STICKERS, stickerFile, type Sticker } from "./stickers"
import "./board.css"

export type BoardCanvasProps = {
  map: Y.Map<unknown>
  level: DocLevel
  /** Inside the call's panel */
  compact?: boolean
  /** Fills the screen, so shortcuts work without clicking the canvas first */
  fullScreen?: boolean
  /** The paper or board file the board lives in. Its images upload to that file */
  fileId: string
  /** Tells boards inside one paper apart in awareness */
  boardKey?: string
  awareness?: Awareness | null
  /** How images inside the doc are read: a call share or a guest's doc token */
  access?: BoardAccess
  /** Guests in a call can't upload */
  canUpload?: boolean
  /** Keeps the board file's preview picture fresh, after changes and on leaving */
  thumbnail?: boolean
  onApi?: (api: ExcalidrawImperativeAPI | null) => void
  /** Comment threads on this board, for users who may see them. A click on a pin opens its thread */
  pins?: CommentPin[]
  activePin?: string | null
  onPin?: (id: string) => void
  /** The Comments button among the tools */
  onComments?: () => void
  commentsOpen?: boolean
}

type View = { scrollX: number; scrollY: number; zoom: number }

/** Pins sit at their scene spot and move with the view, above the drawing and below Excalidraw's own controls */
function CommentPins({
  board,
  pins,
  activePin,
  onPin,
}: {
  board: ExcalidrawImperativeAPI
  pins: CommentPin[]
  activePin: string | null
  onPin: (id: string) => void
}) {
  const [view, setView] = useState<View | null>(null)
  useEffect(() => {
    const read = (state: { scrollX: number; scrollY: number; zoom: { value: number } }) =>
      setView((was) =>
        was && was.scrollX === state.scrollX && was.scrollY === state.scrollY && was.zoom === state.zoom.value
          ? was
          : { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value },
      )
    read(board.getAppState())
    return board.onChange((_elements, state) => read(state))
  }, [board])
  if (!view) return null
  return (
    <div className="nerla-board-pins pointer-events-none absolute inset-0 z-[3] overflow-hidden">
      {pins.map((pin) => (
        <button
          key={pin.id}
          type="button"
          aria-label={pin.label}
          title={pin.label}
          aria-pressed={pin.id === activePin}
          onClick={() => onPin(pin.id)}
          style={{ left: (pin.x + view.scrollX) * view.zoom, top: (pin.y + view.scrollY) * view.zoom }}
          className={cn(
            "pointer-events-auto absolute flex size-7 -translate-y-full cursor-pointer items-center justify-center rounded-full rounded-bl-none shadow-[0_0_0_0.125rem_var(--color-surface),var(--shadow-popover)] transition-transform duration-150 hover:scale-110 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:size-9",
            pin.id === activePin ? "bg-app-bubblegum text-app-bubblegum-ink" : "bg-app-sky text-app-sky-ink",
          )}
        >
          <Comment aria-hidden="true" className="size-[0.95rem]" />
        </button>
      ))}
    </div>
  )
}

const NO_ACCESS: BoardAccess = async () => ({})
const PHONE_QUERY = "(max-width: 63.98rem)"
/** A sticky note is Nerla lemon, drawn on the canvas as plain colors */
const NOTE_FILL = "#FFF1A8"
const NOTE_EDGE = "#F5C542"
const NOTE_SIDE = 200
const STICKER_SIDE = 160
const THUMBNAIL_DELAY_MS = 5000
const THUMBNAIL_MAX_BYTES = 200 * 1024
const THUMBNAIL_SIDES = [640, 420, 260]

/** The middle of what the board shows, in scene units, and how much one screen pixel is there */
function viewCenter(api: ExcalidrawImperativeAPI) {
  const { scrollX, scrollY, zoom, width, height } = api.getAppState()
  return { x: width / 2 / zoom.value - scrollX, y: height / 2 / zoom.value - scrollY, unit: 1 / zoom.value }
}

async function thumbnailOf(api: ExcalidrawImperativeAPI, held: ReadonlySet<string>): Promise<Blob | null> {
  const elements = withHeldImages(getNonDeletedElements(api.getSceneElements()), held)
  if (elements.length === 0) return null
  for (const side of THUMBNAIL_SIDES) {
    const blob = await exportToBlob({
      elements,
      files: api.getFiles(),
      mimeType: "image/png",
      maxWidthOrHeight: side,
      exportPadding: 16,
      appState: { exportBackground: false, exportWithDarkMode: false },
    })
    if (blob.size <= THUMBNAIL_MAX_BYTES) return blob
  }
  return null
}

const WRITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
const MODAL = '[role="dialog"][aria-modal="true"], [cmdk-root]'

/** Nerla's keyboard shortcuts at the boards section, in place of Excalidraw's help. Closing them focuses `from` again */
function showBoardShortcuts(from: Element | null | undefined) {
  runFromMenu(from instanceof HTMLElement && from !== document.body ? from : null, () => openShortcuts({ section: "boards" }))
}

/** A ? meant for the board, not typed into a field or pressed in one of Excalidraw's own dialogs */
const isHelpKey = (event: KeyboardEvent | React.KeyboardEvent) =>
  event.key === "?" &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.altKey &&
  !(event.target instanceof Element && event.target.closest(`${WRITABLE}, .excalidraw-modal-container`))

function StickerTray({ onPick }: { onPick: (sticker: Sticker) => void }) {
  const [open, setOpen] = useState(false)
  const [pictures, setPictures] = useState<Record<string, string>>({})
  const box = useRef<HTMLDivElement>(null)
  const panel = useId()

  useEffect(() => {
    if (!open) return
    let live = true
    for (const sticker of STICKERS) {
      void stickerFile(sticker.id).then((file) => {
        if (live && file) setPictures((all) => (all[sticker.id] ? all : { ...all, [sticker.id]: file.dataURL }))
      })
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      live = false
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        {...TOOL}
        aria-label="Stickers"
        title="Stickers"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panel : undefined}
        onClick={() => setOpen((was) => !was)}
        className={cn(
          "flex size-9 cursor-pointer items-center justify-center rounded-md bg-app-surface text-app-text shadow-[0_0_0_0.0625rem_var(--color-border)] transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:size-11",
          open && "bg-app-sky text-app-sky-ink hover:bg-app-sky",
        )}
      >
        <StickerIcon aria-hidden="true" className="size-[1.125rem] max-lg:size-[1.25rem]" />
      </button>
      {open && (
        <div
          id={panel}
          role="dialog"
          aria-label="Stickers"
          className="absolute top-[calc(100%+0.375rem)] right-0 z-10 grid w-[15.5rem] grid-cols-4 gap-1 rounded-lg bg-app-surface p-2 shadow-[0_0_0_0.0625rem_var(--color-border),var(--shadow-popover)]"
        >
          {STICKERS.map((sticker) => (
            <button
              key={sticker.id}
              type="button"
              title={sticker.label}
              aria-label={sticker.label}
              onClick={() => {
                setOpen(false)
                onPick(sticker)
              }}
              className="flex aspect-square cursor-pointer items-center justify-center rounded-md p-1 transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
            >
              {pictures[sticker.id] ? (
                <img src={pictures[sticker.id]} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
              ) : (
                <span aria-hidden="true" className="size-full animate-pulse rounded-md bg-app-sunk" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A board, live with every user who has it open. Editors draw, other users look */
function BoardCanvas({
  map,
  level,
  compact = false,
  fullScreen = false,
  fileId,
  boardKey = "board",
  awareness = null,
  access = NO_ACCESS,
  canUpload = true,
  thumbnail = false,
  onApi,
  pins,
  activePin = null,
  onPin,
  onComments,
  commentsOpen = false,
}: BoardCanvasProps) {
  const { user } = useAuth()
  const box = useRef<HTMLDivElement>(null)
  const theme = useBoardTheme(box)
  const phone = useMediaQuery(PHONE_QUERY, false)
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const pointer = useRef<ReturnType<typeof bindPresence>["pointer"] | null>(null)
  const readAccess = useRef(access)
  readAccess.current = access
  const editable = level === "edit"
  const uploads = editable && canUpload

  useEffect(() => {
    onApi?.(api)
  }, [api, onApi])
  useEffect(() => () => onApi?.(null), [onApi])

  // Changes come through the onChange prop, which outlives Excalidraw remounting itself, unlike its own emitter
  const listeners = useMemo(() => new Set<Parameters<ExcalidrawImperativeAPI["onChange"]>[0]>(), [])
  const onChange = useCallback<Parameters<ExcalidrawImperativeAPI["onChange"]>[0]>(
    (elements, appState, files) => listeners.forEach((listener) => listener(elements, appState, files)),
    [listeners],
  )
  const board = useMemo<ExcalidrawImperativeAPI | null>(
    () =>
      api && {
        ...api,
        onChange: (listener) => {
          listeners.add(listener)
          return () => void listeners.delete(listener)
        },
      },
    [api, listeners],
  )
  // Excalidraw starts from the map each time it sets itself up
  const mapRef = useRef(map)
  mapRef.current = map
  const initialData = useCallback(
    () => ({
      elements: JSON.parse(JSON.stringify(applyRemote(mapRef.current.entries()))) as ExcalidrawElement[],
      appState: { viewBackgroundColor: lightBoardSurface(), currentItemFontFamily: 5 as const },
    }),
    [],
  )

  // Excalidraw's menu button has no name of its own, its help button opens Nerla's shortcuts, and both are rebuilt when
  // the layout changes
  useEffect(() => {
    const root = box.current
    if (!root) return
    const name = () => {
      for (const trigger of root.querySelectorAll(".main-menu-trigger:not([aria-label])")) {
        trigger.setAttribute("aria-label", "Board menu")
        trigger.setAttribute("title", "Board menu")
      }
      for (const help of root.querySelectorAll(".help-icon:not([aria-keyshortcuts])")) {
        help.setAttribute("aria-label", "Keyboard shortcuts")
        help.setAttribute("title", "Keyboard shortcuts")
        help.setAttribute("aria-haspopup", "dialog")
        help.setAttribute("aria-keyshortcuts", "?")
      }
    }
    name()
    const watch = new MutationObserver(name)
    watch.observe(root, { childList: true, subtree: true })
    return () => watch.disconnect()
  }, [])

  const canvasFocus = useCallback(() => box.current?.querySelector(".excalidraw"), [])

  // Anything else that asks for Excalidraw's help, such as its command palette, gets Nerla's shortcuts instead
  useEffect(() => {
    if (!board) return
    return board.onChange((_elements, state) => {
      if (state.openDialog?.name !== "help") return
      board.updateScene({ appState: { openDialog: null } })
      showBoardShortcuts(canvasFocus())
    })
  }, [board, canvasFocus])

  // A board that takes its keys from the whole page takes ? from there too, ahead of Excalidraw's own listener
  useEffect(() => {
    if (!fullScreen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isHelpKey(event)) return
      // Excalidraw never gets it, as it would open its own help even under another dialog
      event.stopPropagation()
      const layer = event.target instanceof Element ? event.target.closest(MODAL) : null
      // Nothing opens when the shell has opened the shortcuts already from the sidebar or the chat, or for a ? pressed
      // in a dialog over the board
      if (event.defaultPrevented || (layer && !layer.contains(box.current))) return
      event.preventDefault()
      showBoardShortcuts(event.target instanceof Element ? event.target : canvasFocus())
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [fullScreen, canvasFocus])

  const onKeyDownCapture = (event: React.KeyboardEvent) => {
    if (!isHelpKey(event)) return
    event.preventDefault()
    event.stopPropagation()
    showBoardShortcuts(event.target as Element)
  }

  const onClickCapture = (event: React.MouseEvent) => {
    const help = event.target instanceof Element ? event.target.closest(".help-icon") : null
    if (!help) return
    event.stopPropagation()
    showBoardShortcuts(help)
  }

  // The binding starts once the scene has loaded, and catches up with anything that came in meanwhile
  const [bound, setBound] = useState(false)
  useEffect(() => {
    if (!board) return
    let unbind: (() => void) | null = null
    const start = () => {
      if (unbind || board.getAppState().isLoading) return
      unbind = bindBoard(map, board)
      setBound(true)
    }
    const off = board.onChange(start)
    start()
    return () => {
      off()
      unbind?.()
      setBound(false)
    }
  }, [board, map])

  useEffect(() => {
    if (!api || !awareness) return
    const me = awareness.getLocalState() as { user?: { name?: string; color?: string } } | null
    if (!me?.user?.color) {
      const name = user ? [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email : "Guest"
      awareness.setLocalStateField("user", { name, color: docColor(user?.id ?? String(awareness.clientID)) })
    }
    const presence = bindPresence(awareness, api, boardKey)
    pointer.current = presence.pointer
    return () => {
      pointer.current = null
      presence.destroy()
    }
  }, [api, awareness, boardKey, user])

  // Pictures load as their elements arrive, and only this doc's own images or stickers count as held. A picture pasted
  // in from another board shows for the user who pasted it but never for other users, and never in the thumbnail
  const held = useRef(new Set<string>())
  useEffect(() => {
    if (!board) return
    const api = board
    const asked = new Set<string>()
    const check = (elements: readonly ExcalidrawElement[]) => {
      for (const element of elements) {
        const id = element.type === "image" && !element.isDeleted ? element.fileId : null
        if (!id || held.current.has(id) || asked.has(id)) continue
        asked.add(id)
        void boardFile(id, fileId, () => readAccess.current()).then((file) => {
          if (!file) return
          held.current.add(id)
          if (!api.getFiles()[id]) api.addFiles([file])
        })
      }
    }
    check(api.getSceneElements())
    return api.onChange((elements) => check(elements))
  }, [board, fileId])

  // The board file's preview: after changes settle, and once more on leaving
  useEffect(() => {
    if (!board || !bound || !thumbnail || !editable) return
    const api = board
    let saved = hashElementsVersion(api.getSceneElementsIncludingDeleted())
    let timer: ReturnType<typeof setTimeout> | null = null
    let dirty = false
    const save = async () => {
      if (timer) clearTimeout(timer)
      timer = null
      if (!dirty) return
      dirty = false
      saved = hashElementsVersion(api.getSceneElementsIncludingDeleted())
      try {
        const png = await thumbnailOf(api, held.current)
        if (png) await papersAPI.saveThumbnail(fileId, png)
      } catch {
        // The preview catches up after the next change
      }
    }
    const unsubscribe = api.onChange((elements) => {
      if (hashElementsVersion(elements) === saved) return
      dirty = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void save(), THUMBNAIL_DELAY_MS)
    })
    const onHide = () => {
      if (document.visibilityState === "hidden") void save()
    }
    document.addEventListener("visibilitychange", onHide)
    return () => {
      unsubscribe()
      document.removeEventListener("visibilitychange", onHide)
      void save()
    }
  }, [board, bound, thumbnail, editable, fileId])

  const generateIdForFile = useCallback(
    async (file: File) => {
      if (!uploads) throw new Error("Images can't be added here")
      try {
        // A user editing through a call share uploads through it too
        const { shareId } = await readAccess.current()
        const id = (await filesAPI.uploadFile(file, { purpose: "doc", docId: fileId, shareId: shareId ?? undefined })).id
        held.current.add(id)
        return id
      } catch (err) {
        throw new Error(await uploadFailure(err, file))
      }
    },
    [fileId, uploads],
  )

  const addSticker = useCallback(
    async (sticker: Sticker) => {
      if (!api) return
      const file = await stickerFile(sticker.id)
      if (!file) return void toast.error("Couldn't add the sticker. Try again.")
      held.current.add(file.id)
      api.addFiles([file])
      const { x, y, unit } = viewCenter(api)
      const scale = (STICKER_SIDE * unit) / Math.max(file.width, file.height)
      const width = file.width * scale
      const height = file.height * scale
      const [element] = convertToExcalidrawElements([
        { type: "image", fileId: file.id, status: "saved", x: x - width / 2, y: y - height / 2, width, height },
      ])
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), element],
        appState: { selectedElementIds: { [element.id]: true } },
        captureUpdate: "IMMEDIATELY",
      })
    },
    [api],
  )

  const addNote = useCallback(() => {
    if (!api) return
    const { x, y, unit } = viewCenter(api)
    const side = NOTE_SIDE * unit
    const [note] = convertToExcalidrawElements([
      {
        type: "rectangle",
        x: x - side / 2,
        y: y - side / 2,
        width: side,
        height: side,
        backgroundColor: NOTE_FILL,
        strokeColor: NOTE_EDGE,
        fillStyle: "solid",
        strokeWidth: 1,
        roughness: 0,
        roundness: { type: 3 },
      },
    ])
    api.setActiveTool({ type: "selection" })
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), note],
      appState: { selectedElementIds: { [note.id]: true } },
      captureUpdate: "IMMEDIATELY",
    })
    // Enter on a selected shape starts writing inside it, which is what a sticky note wants
    requestAnimationFrame(() => {
      box.current?.querySelector(".excalidraw")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }))
    })
  }, [api])

  const uiOptions = useMemo<Partial<UIOptions>>(
    () => ({
      canvasActions: {
        changeViewBackgroundColor: false,
        clearCanvas: editable,
        export: false,
        loadScene: false,
        saveAsImage: false,
        saveToActiveFile: false,
        toggleTheme: null,
      },
      // On a phone a board is for reading, notes and stickers. board.css hides the drawing tools there
      tools: { image: uploads && !phone },
    }),
    [editable, phone, uploads],
  )

  // Hosts pass a new handler each render, so the button reads the latest one and is only rebuilt when it shows or toggles
  const commentsHandler = useRef(onComments)
  commentsHandler.current = onComments
  const hasComments = !!onComments
  const commentsButton = useMemo(
    () =>
      hasComments && (
        <button
          type="button"
          {...TOOL}
          aria-label="Comments"
          title={commentsTitle()}
          aria-keyshortcuts={COMMENT_SHORTCUT}
          aria-expanded={commentsOpen}
          onClick={() => commentsHandler.current?.()}
          className={cn(
            "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md bg-app-surface text-app-text shadow-[0_0_0_0.0625rem_var(--color-border)] transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:size-11",
            commentsOpen && "bg-app-sky text-app-sky-ink hover:bg-app-sky",
          )}
        >
          <Comment aria-hidden="true" className="size-[1.125rem] max-lg:size-[1.25rem]" />
        </button>
      ),
    [hasComments, commentsOpen],
  )

  const tools = useCallback(
    () =>
      editable ? (
        <Toolbar label="Board tools" className="nerla-board-tools">
          {commentsButton}
          <button
            type="button"
            {...TOOL}
            onClick={addNote}
            // Icon only in a narrow board, as the stickers beside it, so every control fits the call's panel
            title={compact ? "Sticky note" : undefined}
            className={cn(
              "flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-app-lemon px-2.5 text-ui font-medium whitespace-nowrap text-app-lemon-ink transition-[filter] duration-150 hover:brightness-95 focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:h-11 max-lg:px-3",
              compact && "w-9 justify-center px-0 max-lg:w-11 max-lg:px-0",
            )}
          >
            <StickyNote aria-hidden="true" className="size-[1.125rem] max-lg:size-[1.25rem]" />
            <span className={cn(compact && "sr-only", "max-lg:sr-only")}>Sticky note</span>
          </button>
          <StickerTray onPick={(sticker) => void addSticker(sticker)} />
        </Toolbar>
      ) : null,
    [editable, addNote, addSticker, compact, commentsButton],
  )

  return (
    <div
      ref={box}
      className={cn("nerla-board relative h-full w-full", compact && "is-compact", theme === "dark" && "is-dark")}
      onKeyDownCapture={onKeyDownCapture}
      onClickCapture={onClickCapture}
      style={{ "--board-hint": lightBoardMutedText() } as React.CSSProperties}
    >
      <Excalidraw
        excalidrawAPI={setApi}
        // The canvas stays light so candy colors keep their brightness. board.css gives the controls Nerla's dark mode
        theme="light"
        viewModeEnabled={!editable}
        handleKeyboardGlobally={fullScreen}
        aiEnabled={false}
        generateIdForFile={generateIdForFile}
        onPointerUpdate={({ pointer: at, button }) => pointer.current?.(at, button)}
        UIOptions={uiOptions}
        renderTopRightUI={tools}
        initialData={initialData}
        onChange={onChange}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.Item
            icon={<Question aria-hidden="true" />}
            onSelect={() => showBoardShortcuts(box.current?.querySelector(".main-menu-trigger"))}
          >
            Keyboard shortcuts
          </MainMenu.Item>
          {editable && <MainMenu.DefaultItems.ClearCanvas />}
        </MainMenu>
      </Excalidraw>
      {board && pins && pins.length > 0 && onPin && <CommentPins board={board} pins={pins} activePin={activePin} onPin={onPin} />}
      {/* Excalidraw drops its top bar in view mode on phones, so users who only comment get the button over the canvas */}
      {!editable && commentsButton && <div className="absolute top-4 right-4 z-[5]">{commentsButton}</div>}
    </div>
  )
}

export default BoardCanvas

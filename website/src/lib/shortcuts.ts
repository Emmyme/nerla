import { isMac } from "@/components/call/shortcuts"

export type ShortcutScope = "everywhere" | "sidebar" | "tasks" | "calendar" | "files" | "papers" | "boards" | "chat" | "calls"

/**
 * One shortcut. `keys` holds the alternatives, each a sequence of chords such as "Mod+Alt+m" or "g" then "h", and
 * `macKeys` replaces them on a Mac where they differ. `action` names what a key hook runs for it, and `path` is where a
 * go-to key leads
 */
type Shortcut = {
  id: string
  scope: ShortcutScope
  label: string
  keys: string[][]
  macKeys?: string[][]
  action?: string
  path?: string
}

export const SHORTCUT_GROUPS: { scope: ShortcutScope; title: string; note?: string }[] = [
  {
    scope: "everywhere",
    title: "Everywhere",
    note: "Letter keys wait while you type, while a dialog is open and inside a paper or a board.",
  },
  { scope: "sidebar", title: "Sidebar", note: "Tab reaches the list in one stop, on the page you're on." },
  { scope: "tasks", title: "Tasks", note: "On Home and in a project. The arrow keys work inside a task list or the Board view." },
  { scope: "calendar", title: "Calendar" },
  { scope: "files", title: "Files" },
  { scope: "papers", title: "Papers" },
  { scope: "boards", title: "Boards", note: "While the board has focus. Single letters pick a tool, and the number keys 1 to 0 do too." },
  { scope: "chat", title: "Chat" },
  { scope: "calls", title: "Calls" },
]

const goTo = (letter: string, label: string, path: string): Shortcut => ({
  id: `goto.${letter}`,
  scope: "everywhere",
  label: `Go to ${label}`,
  keys: [["g", letter]],
  action: "goto",
  path,
})

export const SHORTCUTS: Shortcut[] = [
  { id: "command-menu", scope: "everywhere", label: "Search or jump to", keys: [["Mod+k"]] },
  { id: "shortcuts", scope: "everywhere", label: "Show keyboard shortcuts", keys: [["?"]] },
  goTo("h", "Home", "/"),
  goTo("c", "Chat", "/messages"),
  goTo("a", "Calendar", "/calendar"),
  goTo("f", "Files", "/files"),
  goTo("t", "Time", "/time"),
  goTo("p", "Projects", "/projects"),
  goTo("s", "Settings", "/settings"),
  goTo("x", "Trash", "/trash"),
  { id: "region-next", scope: "everywhere", label: "Move to the next area: the sidebar, the page or the chat", keys: [["F6"]] },
  { id: "region-previous", scope: "everywhere", label: "Move to the area before", keys: [["Shift+F6"]] },
  { id: "toasts", scope: "everywhere", label: "Reach the toast messages, also from a dialog", keys: [["Alt+t"]] },
  { id: "create", scope: "everywhere", label: "Create on this page: a task, an event, a chat or a project", keys: [["c"]] },

  { id: "sidebar.move", scope: "sidebar", label: "Move up and down the list", keys: [["ArrowUp"], ["ArrowDown"]] },
  { id: "sidebar.ends", scope: "sidebar", label: "Go to the first or last item", keys: [["Home"], ["End"]] },
  { id: "sidebar.actions", scope: "sidebar", label: "Reach a row's buttons, and come back", keys: [["ArrowRight"], ["ArrowLeft"]] },
  { id: "sidebar.open", scope: "sidebar", label: "Open the item", keys: [["Enter"]] },

  { id: "tasks.new", scope: "tasks", label: "New task", keys: [["c"]], action: "new" },
  { id: "tasks.next", scope: "tasks", label: "Next task", keys: [["j"], ["ArrowDown"]], action: "next" },
  { id: "tasks.prev", scope: "tasks", label: "Previous task", keys: [["k"], ["ArrowUp"]], action: "prev" },
  { id: "tasks.open", scope: "tasks", label: "Open the selected task", keys: [["Enter"]], action: "open" },
  { id: "tasks.close", scope: "tasks", label: "Close the task", keys: [["Escape"]], action: "close" },
  { id: "tasks.status", scope: "tasks", label: "Change status, in a project", keys: [["s"]], action: "status" },
  { id: "tasks.priority", scope: "tasks", label: "Change priority, in a project", keys: [["p"]], action: "priority" },
  { id: "tasks.assignee", scope: "tasks", label: "Assign, in a project", keys: [["a"]], action: "assignee" },

  { id: "calendar.create", scope: "calendar", label: "New event", keys: [["c"]], action: "create" },
  { id: "calendar.meeting", scope: "calendar", label: "New meeting", keys: [["n"]], action: "meeting" },
  { id: "calendar.today", scope: "calendar", label: "Go to today", keys: [["t"]], action: "today" },
  { id: "calendar.next", scope: "calendar", label: "Next period", keys: [["j"]], action: "next" },
  { id: "calendar.prev", scope: "calendar", label: "Previous period", keys: [["k"]], action: "prev" },
  { id: "calendar.day", scope: "calendar", label: "Day view", keys: [["d"]], action: "day" },
  { id: "calendar.week", scope: "calendar", label: "Week view", keys: [["w"]], action: "week" },
  { id: "calendar.month", scope: "calendar", label: "Month view", keys: [["m"]], action: "month" },
  { id: "calendar.schedule", scope: "calendar", label: "Schedule view", keys: [["a"]], action: "schedule" },
  { id: "calendar.close", scope: "calendar", label: "Close the event", keys: [["Escape"]], action: "close" },
  {
    id: "calendar.nudge",
    scope: "calendar",
    label: "Move the focused event",
    keys: [["Alt+ArrowUp"], ["Alt+ArrowDown"], ["Alt+ArrowLeft"], ["Alt+ArrowRight"]],
  },
  {
    id: "calendar.resize",
    scope: "calendar",
    label: "Make the focused event longer or shorter",
    keys: [["Alt+Shift+ArrowUp"], ["Alt+Shift+ArrowDown"]],
  },

  { id: "files.upload", scope: "files", label: "Upload", keys: [["u"]] },
  { id: "files.new", scope: "files", label: "New paper, board or folder", keys: [["c"]] },
  { id: "files.search", scope: "files", label: "Search files", keys: [["/"]] },

  { id: "papers.bold", scope: "papers", label: "Bold", keys: [["Mod+b"]] },
  { id: "papers.italic", scope: "papers", label: "Italic", keys: [["Mod+i"]] },
  { id: "papers.underline", scope: "papers", label: "Underline", keys: [["Mod+u"]] },
  { id: "papers.strike", scope: "papers", label: "Strikethrough", keys: [["Mod+Shift+s"]] },
  { id: "papers.code", scope: "papers", label: "Code", keys: [["Mod+e"]] },
  { id: "papers.headings", scope: "papers", label: "Heading 1, 2 or 3", keys: [["Mod+Alt+1"], ["Mod+Alt+2"], ["Mod+Alt+3"]] },
  { id: "papers.bullets", scope: "papers", label: "Bulleted list", keys: [["Mod+Shift+8"]] },
  { id: "papers.numbers", scope: "papers", label: "Numbered list", keys: [["Mod+Shift+7"]] },
  { id: "papers.checklist", scope: "papers", label: "Checklist", keys: [["Mod+Shift+9"]] },
  { id: "papers.quote", scope: "papers", label: "Quote", keys: [["Mod+Shift+b"]] },
  { id: "papers.blocks", scope: "papers", label: "Insert a block", keys: [["/"]] },
  { id: "papers.task", scope: "papers", label: "Make a task from the checklist line", keys: [["Mod+Shift+Enter"]] },
  { id: "papers.comment", scope: "papers", label: "Comment", keys: [["Mod+Alt+m"]] },
  { id: "papers.find", scope: "papers", label: "Find and replace", keys: [["Mod+f"]] },
  { id: "papers.print", scope: "papers", label: "Print or save as PDF", keys: [["Mod+p"]] },
  { id: "papers.undo", scope: "papers", label: "Undo", keys: [["Mod+z"]] },
  { id: "papers.redo", scope: "papers", label: "Redo", keys: [["Mod+Shift+z"], ["Mod+y"]] },

  { id: "boards.select", scope: "boards", label: "Select", keys: [["v"], ["1"]] },
  { id: "boards.rectangle", scope: "boards", label: "Rectangle", keys: [["r"], ["2"]] },
  { id: "boards.diamond", scope: "boards", label: "Diamond", keys: [["d"], ["3"]] },
  { id: "boards.ellipse", scope: "boards", label: "Ellipse", keys: [["o"], ["4"]] },
  { id: "boards.arrow", scope: "boards", label: "Arrow", keys: [["a"], ["5"]] },
  { id: "boards.line", scope: "boards", label: "Line", keys: [["l"], ["6"]] },
  { id: "boards.draw", scope: "boards", label: "Draw", keys: [["p"], ["x"], ["7"]] },
  { id: "boards.text", scope: "boards", label: "Text", keys: [["t"], ["8"]] },
  { id: "boards.image", scope: "boards", label: "Image, where you can upload", keys: [["9"]] },
  { id: "boards.eraser", scope: "boards", label: "Eraser", keys: [["e"], ["0"]] },
  { id: "boards.hand", scope: "boards", label: "Hand, to move around", keys: [["h"]] },
  { id: "boards.frame", scope: "boards", label: "Frame", keys: [["f"]] },
  { id: "boards.laser", scope: "boards", label: "Laser pointer", keys: [["k"]] },
  { id: "boards.keep-tool", scope: "boards", label: "Keep the tool after drawing", keys: [["q"]] },
  { id: "boards.pick-color", scope: "boards", label: "Pick a color from the board", keys: [["i"]] },
  { id: "boards.edit-text", scope: "boards", label: "Write in the selected shape", keys: [["Enter"]] },
  {
    id: "boards.move",
    scope: "boards",
    label: "Move the selection, further with Shift",
    keys: [["ArrowUp"], ["ArrowDown"], ["ArrowLeft"], ["ArrowRight"]],
  },
  { id: "boards.text-size", scope: "boards", label: "Make the text bigger or smaller", keys: [["Mod+Shift+>"], ["Mod+Shift+<"]] },
  { id: "boards.zoom-in", scope: "boards", label: "Zoom in", keys: [["Mod++"]] },
  { id: "boards.zoom-out", scope: "boards", label: "Zoom out", keys: [["Mod+-"]] },
  { id: "boards.zoom-reset", scope: "boards", label: "Zoom to 100%", keys: [["Mod+0"]] },
  { id: "boards.zoom-fit", scope: "boards", label: "Zoom to fit everything", keys: [["Shift+1"]] },
  { id: "boards.zoom-selection", scope: "boards", label: "Zoom to the selection", keys: [["Shift+2"]] },
  { id: "boards.select-all", scope: "boards", label: "Select all", keys: [["Mod+a"]] },
  { id: "boards.duplicate", scope: "boards", label: "Duplicate", keys: [["Mod+d"]] },
  { id: "boards.delete", scope: "boards", label: "Delete", keys: [["Delete"], ["Backspace"]] },
  { id: "boards.cut", scope: "boards", label: "Cut", keys: [["Mod+x"]] },
  { id: "boards.copy", scope: "boards", label: "Copy", keys: [["Mod+c"]] },
  { id: "boards.paste", scope: "boards", label: "Paste", keys: [["Mod+v"]] },
  { id: "boards.group", scope: "boards", label: "Group", keys: [["Mod+g"]] },
  { id: "boards.ungroup", scope: "boards", label: "Ungroup", keys: [["Mod+Shift+g"]] },
  { id: "boards.lock", scope: "boards", label: "Lock or unlock the selection", keys: [["Mod+Shift+l"]] },
  { id: "boards.backward", scope: "boards", label: "Send backward", keys: [["Mod+["]] },
  { id: "boards.forward", scope: "boards", label: "Bring forward", keys: [["Mod+]"]] },
  { id: "boards.back", scope: "boards", label: "Send to back", keys: [["Mod+Shift+["]], macKeys: [["Mod+Alt+["]] },
  { id: "boards.front", scope: "boards", label: "Bring to front", keys: [["Mod+Shift+]"]], macKeys: [["Mod+Alt+]"]] },
  { id: "boards.flip", scope: "boards", label: "Flip across or up and down", keys: [["Shift+h"], ["Shift+v"]] },
  { id: "boards.undo", scope: "boards", label: "Undo", keys: [["Mod+z"]] },
  { id: "boards.redo", scope: "boards", label: "Redo", keys: [["Mod+y"], ["Mod+Shift+z"]], macKeys: [["Mod+Shift+z"]] },
  { id: "boards.comment", scope: "boards", label: "Comment", keys: [["Mod+Alt+m"]] },
  { id: "boards.help", scope: "boards", label: "Show keyboard shortcuts", keys: [["?"]] },
  { id: "boards.leave", scope: "boards", label: "Leave the full screen board in a paper", keys: [["Escape"]] },

  { id: "chat.new", scope: "chat", label: "New chat, on the Chat page", keys: [["c"]] },
  { id: "chat.send", scope: "chat", label: "Send", keys: [["Enter"]] },
  { id: "chat.line", scope: "chat", label: "New line", keys: [["Shift+Enter"]] },
  { id: "chat.edit", scope: "chat", label: "Edit your last message, from an empty message box", keys: [["ArrowUp"]] },
  { id: "chat.cancel", scope: "chat", label: "Stop replying or editing", keys: [["Escape"]] },
  { id: "chat.messages", scope: "chat", label: "Move between messages", keys: [["ArrowUp"], ["ArrowDown"]] },
  { id: "chat.mention", scope: "chat", label: "Mention someone", keys: [["@"]] },

  { id: "calls.mic", scope: "calls", label: "Turn the microphone on or off", keys: [["Mod+d"]] },
  { id: "calls.camera", scope: "calls", label: "Turn the camera on or off", keys: [["Mod+e"]] },
]

const shortcut = (id: string): Shortcut | undefined => SHORTCUTS.find((entry) => entry.id === id)

/** The keys a shortcut takes on this computer */
export const keysOn = (entry: Shortcut, mac = isMac()) => (mac && entry.macKeys) || entry.keys

/** Single key hooks read their keys here: the lower case key name to the action it runs */
export function keyActions<A extends string>(scope: ShortcutScope): Map<string, A> {
  const map = new Map<string, A>()
  for (const entry of SHORTCUTS) {
    if (entry.scope !== scope || !entry.action) continue
    for (const sequence of entry.keys) map.set(sequence[0].toLowerCase(), entry.action as A)
  }
  return map
}

const CAPS: Record<string, [mac: string, other: string]> = {
  Mod: ["⌘", "Ctrl"],
  Alt: ["⌥", "Alt"],
  Shift: ["⇧", "Shift"],
  ArrowUp: ["↑", "↑"],
  ArrowDown: ["↓", "↓"],
  ArrowLeft: ["←", "←"],
  ArrowRight: ["→", "→"],
  Escape: ["Esc", "Esc"],
  Backspace: ["⌫", "Backspace"],
  Delete: ["Del", "Delete"],
}
const SPOKEN: Record<string, [mac: string, other: string]> = {
  Mod: ["Command", "Control"],
  Alt: ["Option", "Alt"],
  ArrowUp: ["Up arrow", "Up arrow"],
  ArrowDown: ["Down arrow", "Down arrow"],
  ArrowLeft: ["Left arrow", "Left arrow"],
  ArrowRight: ["Right arrow", "Right arrow"],
  "/": ["Slash", "Slash"],
  "?": ["Question mark", "Question mark"],
  "@": ["At sign", "At sign"],
  "+": ["Plus", "Plus"],
  "-": ["Minus", "Minus"],
  "[": ["Left bracket", "Left bracket"],
  "]": ["Right bracket", "Right bracket"],
}

const parts = (chord: string) => chord.split(/\+(?=.)/)
const named = (table: Record<string, [string, string]>, part: string, mac: boolean) =>
  table[part]?.[mac ? 0 : 1] ?? (part.length === 1 ? part.toUpperCase() : part)

/** A chord as its key caps read, "⌘ ⌥ M" on a Mac and "Ctrl Alt M" elsewhere */
export const chordCaps = (chord: string, mac = isMac()) =>
  parts(chord)
    .map((part) => named(CAPS, part, mac))
    .join(" ")

/** The keys as a screen reader says them, such as "G then H" or "J or Down arrow" */
export const spokenKeys = (keys: string[][], mac = isMac()) =>
  keys
    .map((sequence) =>
      sequence
        .map((chord) =>
          parts(chord)
            .map((part) => named(SPOKEN, part, mac))
            .join(" "),
        )
        .join(" then "),
    )
    .join(" or ")

/** A shortcut's first keys in one line, such as "G H", for a menu row */
export const shortcutCaps = (id: string) => {
  const entry = shortcut(id)
  return (
    entry &&
    keysOn(entry)[0]
      .map((chord) => chordCaps(chord))
      .join(" ")
  )
}

/** The go-to keys for a page, such as G then H for Home */
export const goToKeys = (path: string) => SHORTCUTS.find((entry) => entry.action === "goto" && entry.path === path)?.keys

export const GO_TO_WINDOW_MS = 1500

/** One key press in a go-to sequence. G arms it, and a go-to letter soon after picks where to go */
export function goToStep(armedAt: number | null, key: string, now: number): { armedAt: number | null; goto: Shortcut | null } {
  const letter = key.toLowerCase()
  if (armedAt !== null && now - armedAt <= GO_TO_WINDOW_MS) {
    const target = SHORTCUTS.find((entry) => entry.action === "goto" && entry.keys[0][1] === letter)
    if (target) return { armedAt: null, goto: target }
  }
  return { armedAt: letter === "g" ? now : null, goto: null }
}

const TYPING_TARGET = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
].join(", ")
const BLOCKING_LAYER = '[role="dialog"][aria-modal="true"], [cmdk-root]'

function typingOrBlocked(e: KeyboardEvent): boolean {
  const target = e.target
  if (target instanceof Element && ((target as HTMLElement).isContentEditable || target.closest(TYPING_TARGET))) return true
  return document.querySelector(BLOCKING_LAYER) !== null
}

/** Whether a page's single key shortcuts should skip this press: a modifier, a typing target or a modal layer */
export function shouldIgnoreKey(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || e.altKey || typingOrBlocked(e)
}

const OUTSIDE_BOARD = '[data-region="sidebar"], [data-region="dock"], [data-region="tabbar"]'
const OWN_LAYER = '[role="dialog"], [data-radix-popper-content-wrapper], .excalidraw'

/**
 * Whether a letter key such as a go-to key or ? should be left alone: while typing, with Ctrl, Alt or Cmd, with a
 * dialog open, inside a dialog, panel or popover, or with a board on screen, which takes its keys from anywhere but
 * the sidebar and the chat. `altGr` lets AltGr through, which some layouts need for ?
 */
export function leaveKeyAlone(e: KeyboardEvent, { altGr = false }: { altGr?: boolean } = {}): boolean {
  const modifier = (e.ctrlKey || e.metaKey || e.altKey) && !(altGr && e.getModifierState?.("AltGraph"))
  if (e.isComposing || modifier || typingOrBlocked(e)) return true
  const target = e.target instanceof Element ? e.target : null
  if (target?.closest(OWN_LAYER)) return true
  return !!document.querySelector(".excalidraw") && !target?.closest(OUTSIDE_BOARD)
}

/** The letter a key press stands for, read from the key's place when the layout types something else */
export const letterOf = (e: Pick<KeyboardEvent, "key" | "code">) =>
  /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key

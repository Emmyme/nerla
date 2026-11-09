import { useRef, useState, type ReactNode } from "react"
import { useEditorState, type Editor } from "@tiptap/react"
import {
  Board,
  Bold,
  CheckSquare,
  HeadingOne,
  HeadingThree,
  HeadingTwo,
  Image,
  Italic,
  Link,
  List,
  ListNumbers,
  Redo,
  Strikethrough,
  Table,
  Underline,
  Undo,
  type IconComponent,
} from "@/components/icons"
import { MenuPopover, useMenuButton, type MenuEntry } from "@/components/files/ActionMenu"
import { AnchoredPopover } from "@/components/ui/anchored-popover"
import { Button } from "@/components/ui/button"
import { TOOL, Toolbar } from "@/components/ui/toolbar"
import { cn } from "@/lib/utils"
import { insertBoard } from "./extensions/boardBlock"

function ToolButton({
  label,
  Icon,
  active = false,
  toggle = false,
  disabled = false,
  onClick,
  buttonRef,
  popup,
  popupKind = "dialog",
  onKeyDown,
}: {
  label: string
  Icon: IconComponent
  active?: boolean
  /** Turns a format on and off, so its state is read out as pressed */
  toggle?: boolean
  disabled?: boolean
  onClick: () => void
  buttonRef?: React.Ref<HTMLButtonElement>
  /** Opens a small dialog or menu, and whether it is open */
  popup?: boolean
  popupKind?: "dialog" | "menu"
  onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      {...TOOL}
      aria-label={label}
      title={label}
      aria-pressed={toggle ? active : undefined}
      aria-haspopup={popup === undefined ? undefined : popupKind}
      aria-expanded={popup}
      // Stays focusable, so the arrow keys never skip it
      aria-disabled={disabled || undefined}
      // The caret stays in the paper
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => !disabled && onClick()}
      onKeyDown={onKeyDown}
      className={cn(
        "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground max-lg:size-11",
        active && "bg-app-selected text-foreground hover:bg-app-selected",
      )}
    >
      <Icon aria-hidden="true" className="size-[1.125rem] max-lg:size-[1.25rem]" />
    </button>
  )
}

const Divider = () => <span aria-hidden="true" className="mx-0.5 h-5 w-[0.0625rem] shrink-0 bg-border" />

function Group({ children }: { children: ReactNode }) {
  return <div className="flex items-center">{children}</div>
}

/** A link on the selection, typed in a small popover */
function LinkButton({ editor, active }: { editor: Editor; active: boolean }) {
  const [open, setOpen] = useState(false)
  const [href, setHref] = useState("")
  const button = useRef<HTMLButtonElement>(null)

  const start = () => {
    setHref((editor.getAttributes("link").href as string | undefined) ?? "")
    setOpen(true)
  }
  const save = () => {
    const value = href.trim()
    const chain = editor.chain().focus().extendMarkRange("link")
    if (!value) chain.unsetLink().run()
    else chain.setLink({ href: /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}` }).run()
    setOpen(false)
  }

  return (
    <>
      <ToolButton buttonRef={button} label="Link" Icon={Link} active={active} popup={open} onClick={start} />
      <AnchoredPopover
        open={open}
        onOpenChange={setOpen}
        anchor={open ? button.current : null}
        side="bottom"
        title="Link"
        returnFocus={() => editor.commands.focus()}
        className="w-[20rem] p-2"
      >
        <form
          // A bare domain is fine here, it gets https:// on save
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
          className="flex items-center gap-2"
        >
          <input
            autoFocus
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-label="Address"
            placeholder="Paste a link"
            value={href}
            onChange={(event) => setHref(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md bg-app-sunk px-2.5 text-ui text-foreground placeholder:text-muted-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
          />
          <Button type="submit">{href.trim() || !active ? "Save" : "Remove"}</Button>
        </form>
      </AnchoredPopover>
    </>
  )
}

/** A new board at the caret, or a menu that also links one from elsewhere where boards can be looked up */
function BoardButton({ editor, onLinkBoard }: { editor: Editor; onLinkBoard?: () => void }) {
  const menu = useMenuButton()
  // Focus goes back to the paper first, so a new board lands at the caret and a picker returns focus there
  const inPaper = (then: () => void) => () => {
    editor.view.focus()
    then()
  }

  if (!onLinkBoard) return <ToolButton label="Board" Icon={Board} onClick={inPaper(() => insertBoard(editor))} />
  const entries: MenuEntry[] = [
    { label: "New board", Icon: Board, run: inPaper(() => insertBoard(editor)) },
    { label: "Link a board", Icon: Link, run: inPaper(onLinkBoard) },
  ]
  return (
    <>
      <ToolButton
        buttonRef={menu.button}
        label="Board"
        Icon={Board}
        popup={menu.open}
        popupKind="menu"
        onClick={menu.toggle}
        onKeyDown={menu.onKeyDown}
      />
      <MenuPopover {...menu.popover} label="Board" entries={entries} align="start" widthRem={11} />
    </>
  )
}

/** Formatting for editors, from undo to tables */
export function PaperToolbar({
  editor,
  onImage,
  onLinkBoard,
  className,
}: {
  editor: Editor
  onImage?: () => void
  /** Missing where boards can't be looked up, as for a guest in a call */
  onLinkBoard?: () => void
  className?: string
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      link: e.isActive("link"),
      table: e.isActive("table"),
      undo: e.can().undo(),
      redo: e.can().redo(),
    }),
  })
  const run = (command: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => command(editor.chain().focus()).run()

  return (
    // One row that scrolls sideways on a phone, and wraps on a wider screen
    <Toolbar
      label="Formatting"
      className={cn("flex items-center gap-y-1 max-lg:overflow-x-auto max-lg:[scrollbar-width:none] lg:flex-wrap", className)}
    >
      <Group>
        <ToolButton label="Undo" Icon={Undo} disabled={!state.undo} onClick={() => run((c) => c.undo())} />
        <ToolButton label="Redo" Icon={Redo} disabled={!state.redo} onClick={() => run((c) => c.redo())} />
      </Group>
      <Divider />
      <Group>
        <ToolButton
          toggle
          label="Heading 1"
          Icon={HeadingOne}
          active={state.h1}
          onClick={() => run((c) => c.toggleHeading({ level: 1 }))}
        />
        <ToolButton
          toggle
          label="Heading 2"
          Icon={HeadingTwo}
          active={state.h2}
          onClick={() => run((c) => c.toggleHeading({ level: 2 }))}
        />
        <ToolButton
          toggle
          label="Heading 3"
          Icon={HeadingThree}
          active={state.h3}
          onClick={() => run((c) => c.toggleHeading({ level: 3 }))}
        />
      </Group>
      <Divider />
      <Group>
        <ToolButton toggle label="Bold" Icon={Bold} active={state.bold} onClick={() => run((c) => c.toggleBold())} />
        <ToolButton toggle label="Italic" Icon={Italic} active={state.italic} onClick={() => run((c) => c.toggleItalic())} />
        <ToolButton toggle label="Underline" Icon={Underline} active={state.underline} onClick={() => run((c) => c.toggleUnderline())} />
        <ToolButton toggle label="Strikethrough" Icon={Strikethrough} active={state.strike} onClick={() => run((c) => c.toggleStrike())} />
        <LinkButton editor={editor} active={state.link} />
      </Group>
      <Divider />
      <Group>
        <ToolButton toggle label="List" Icon={List} active={state.bullet} onClick={() => run((c) => c.toggleBulletList())} />
        <ToolButton
          toggle
          label="Numbered list"
          Icon={ListNumbers}
          active={state.ordered}
          onClick={() => run((c) => c.toggleOrderedList())}
        />
        <ToolButton toggle label="Checklist" Icon={CheckSquare} active={state.task} onClick={() => run((c) => c.toggleTaskList())} />
      </Group>
      <Divider />
      <Group>
        {onImage && <ToolButton label="Image" Icon={Image} onClick={onImage} />}
        <ToolButton
          label="Table"
          Icon={Table}
          active={state.table}
          onClick={() => run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}
        />
        <BoardButton editor={editor} onLinkBoard={onLinkBoard} />
      </Group>
    </Toolbar>
  )
}

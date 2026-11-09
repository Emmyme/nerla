import type { Editor } from "@tiptap/core"
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types"
import "./print.css"

const ROOT_ID = "nerla-print"
const PRINTING = "nerla-printing"
const BOARDS_WAIT_MS = 5000

/** Shows the copy alone for the print dialog, where the user picks Save as PDF, and clears it afterwards */
async function printAlone(content: HTMLElement) {
  document.getElementById(ROOT_ID)?.remove()
  const root = document.createElement("div")
  root.id = ROOT_ID
  root.setAttribute("data-theme", "nerla")
  root.setAttribute("data-mode", "light")
  root.append(content)
  document.body.append(root)
  const html = document.documentElement
  html.classList.add(PRINTING)
  const clear = () => {
    root.remove()
    html.classList.remove(PRINTING)
  }
  window.addEventListener("afterprint", clear, { once: true })
  await Promise.all([document.fonts.ready, ...[...root.querySelectorAll("img")].map((image) => image.decode().catch(() => undefined))])
  window.print()
}

/** Board previews in a paper render after their code loads, so printing waits for them a moment */
async function boardsReady(scope: HTMLElement) {
  const started = Date.now()
  while (scope.querySelector('[data-board-preview="loading"]') && Date.now() - started < BOARDS_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const unwrap = (element: Element) => element.replaceWith(...element.childNodes)

/** A paper as it reads, with its boards as pictures. Carets, marks, placeholders, toolbars and comments stay out */
export async function printPaper(editor: Editor, title?: string) {
  await boardsReady(editor.view.dom)
  const sheet = document.createElement("article")
  sheet.className = "paper-content"
  if (title) {
    const heading = document.createElement("h1")
    heading.className = "print-title"
    heading.textContent = title
    sheet.append(heading)
  }
  const body = editor.view.dom.cloneNode(true) as HTMLElement
  body.querySelectorAll(".collaboration-carets__caret, [data-print='hide']").forEach((element) => element.remove())
  body.querySelectorAll(".collaboration-carets__selection, .paper-find-match, .paper-comment").forEach(unwrap)
  body.querySelectorAll("[contenteditable]").forEach((element) => element.removeAttribute("contenteditable"))
  // The empty line's placeholder is a hint for writing, not part of the paper
  body.querySelectorAll("[data-placeholder]").forEach((element) => {
    element.removeAttribute("data-placeholder")
    element.classList.remove("is-empty", "is-editor-empty")
  })
  body.removeAttribute("contenteditable")
  sheet.append(body)
  await printAlone(sheet)
}

/** A board on one page, turned to fit its shape */
export async function printBoard(api: ExcalidrawImperativeAPI) {
  const { exportToCanvas, exportToSvg, getNonDeletedElements } = await import("@excalidraw/excalidraw")
  const elements = getNonDeletedElements(api.getSceneElements())
  // The board's fonts are loaded into the page, which prints them, so the picture needn't carry them
  const text = elements.filter((element) => element.type === "text")
  if (text.length) await exportToCanvas({ elements: text, files: null, maxWidthOrHeight: 1 })
  const svg = await exportToSvg({
    elements,
    files: api.getFiles(),
    exportPadding: 24,
    skipInliningFonts: true,
    appState: { exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
  })
  const width = Number(svg.getAttribute("width")) || 1
  const height = Number(svg.getAttribute("height")) || 1
  svg.removeAttribute("width")
  svg.removeAttribute("height")
  const page = document.createElement("div")
  page.className = width > height ? "print-board is-landscape" : "print-board"
  page.append(svg)
  await printAlone(page)
}

import { createElement, type ReactElement } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types"
import type { FileId } from "@excalidraw/excalidraw/element/types"
import catLogo from "@/assets/cat-logo.png"
import { GrinFace } from "@/components/chat/GrinFace"
import { FolderGlyph } from "@/components/files/FolderGlyph"
import { CatInFolder, CatInTrash, CatNapping, CatNappingReaction, CatSearching, CatSearchingReaction } from "@/components/ui/cat-scenes"
import { LOGO_H, LOGO_W } from "@/components/ui/cat-scene-layout"
import { loadSolidCat } from "@/components/ui/presence-cat"
import { PriorityIcon } from "@/components/ui/priority-icon"
import { StatusIcon } from "@/components/ui/status-icon"
import { readAsDataUrl, toBase64 } from "@/lib/base64"

/** A sticker's file id, the same on every board, so its picture is drawn again from code and never stored */
const STICKER_PREFIX = "sticker-"

export type Sticker = { id: string; label: string; render: () => ReactElement }

/** The logo cat recoloured, its holes left open */
function TintedCat({ fill }: { fill: string }) {
  return createElement(
    "svg",
    { viewBox: `0 0 ${LOGO_W} ${LOGO_H}` },
    createElement(
      "mask",
      { id: "cat", style: { maskType: "alpha" } },
      createElement("image", { href: catLogo, width: LOGO_W, height: LOGO_H }),
    ),
    createElement("rect", { width: LOGO_W, height: LOGO_H, mask: "url(#cat)", style: { fill } }),
  )
}

const folder = (color: string) => () => createElement(FolderGlyph, { color })

export const STICKERS: Sticker[] = [
  { id: "sticker-cat", label: "Nerla cat", render: () => createElement(TintedCat, { fill: "var(--color-bubblegum)" }) },
  { id: "sticker-cat-grey", label: "Grey cat", render: () => createElement(TintedCat, { fill: "var(--color-text-muted)" }) },
  { id: "sticker-cat-napping", label: "Napping cat", render: () => createElement(CatNapping) },
  { id: "sticker-cat-searching", label: "Searching cat", render: () => createElement(CatSearching) },
  { id: "sticker-cat-folder", label: "Cat in a folder", render: () => createElement(CatInFolder) },
  { id: "sticker-cat-trash", label: "Cat in the trash", render: () => createElement(CatInTrash) },
  { id: "sticker-purr", label: "Sleepy", render: () => createElement(CatNappingReaction) },
  { id: "sticker-peek", label: "Looking into it", render: () => createElement(CatSearchingReaction) },
  { id: "sticker-backlog", label: "Backlog", render: () => createElement(StatusIcon, { status: "backlog" }) },
  { id: "sticker-todo", label: "To do", render: () => createElement(StatusIcon, { status: "todo" }) },
  { id: "sticker-progress", label: "In progress", render: () => createElement(StatusIcon, { status: "in_progress" }) },
  { id: "sticker-done", label: "Done", render: () => createElement(StatusIcon, { status: "done" }) },
  { id: "sticker-urgent", label: "Urgent", render: () => createElement(PriorityIcon, { priority: "urgent" }) },
  { id: "sticker-grin", label: "Grin", render: () => createElement(GrinFace, { style: { color: "var(--color-bubblegum-strong)" } }) },
  { id: "sticker-folder-sky", label: "Sky folder", render: folder("sky") },
  { id: "sticker-folder-pistachio", label: "Pistachio folder", render: folder("pistachio") },
  { id: "sticker-folder-bubblegum", label: "Bubblegum folder", render: folder("bubblegum") },
  { id: "sticker-folder-lavender", label: "Lavender folder", render: folder("lavender") },
  { id: "sticker-folder-lemon", label: "Lemon folder", render: folder("lemon") },
]

export const isSticker = (fileId: string | null | undefined) => !!fileId && fileId.startsWith(STICKER_PREFIX)

/** The painted look of each part, copied from the page so the picture keeps it on its own */
const PAINT = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linejoin",
  "stroke-linecap",
  "paint-order",
  "opacity",
  "mask-type",
  "font-weight",
  "font-size",
]
/** The longest side of a sticker's picture, in pixels */
const SIDE = 480

function inlinePaint(source: Element, target: Element) {
  const style = getComputedStyle(source)
  target.setAttribute("style", PAINT.map((name) => `${name}:${style.getPropertyValue(name)}`).join(";") + ";font-family:sans-serif")
  target.removeAttribute("class")
  for (let i = 0; i < source.children.length; i++) inlinePaint(source.children[i], target.children[i])
}

let logoData: Promise<string> | null = null
const logoDataUrl = () =>
  (logoData ??= fetch(catLogo)
    .then((res) => res.blob())
    .then(readAsDataUrl))

/** One of Nerla's drawings as a self-contained SVG, in the light palette on a white board */
async function drawSvg(sticker: Sticker): Promise<{ svg: string; width: number; height: number }> {
  await loadSolidCat()
  const logo = await logoDataUrl()
  const host = document.createElement("div")
  host.setAttribute("data-theme", "nerla")
  host.setAttribute("data-mode", "light")
  host.setAttribute("aria-hidden", "true")
  host.style.cssText = "position:fixed;left:-200rem;top:0;pointer-events:none;--row-fill:#FFFFFF"
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(sticker.render()))
    const source = host.querySelector("svg")
    if (!source) throw new Error("No drawing")
    const copy = source.cloneNode(true) as SVGSVGElement
    inlinePaint(source, copy)
    copy.querySelectorAll("image").forEach((image) => {
      const href = image.getAttribute("href") ?? ""
      if (!href.startsWith("data:")) image.setAttribute("href", logo)
    })
    const box = source.viewBox.baseVal
    const scale = SIDE / Math.max(box.width, box.height)
    const width = Math.round(box.width * scale)
    const height = Math.round(box.height * scale)
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg")
    copy.setAttribute("width", String(width))
    copy.setAttribute("height", String(height))
    copy.removeAttribute("role")
    copy.removeAttribute("aria-label")
    copy.style.overflow = "visible"
    return { svg: new XMLSerializer().serializeToString(copy), width, height }
  } finally {
    root.unmount()
    host.remove()
  }
}

/** A PNG, so the board's dark theme keeps the colors as it does for photos. SVG when the canvas refuses */
async function rasterize(
  svg: string,
  width: number,
  height: number,
): Promise<{ dataURL: string; mimeType: "image/png" | "image/svg+xml" }> {
  const svgUrl = `data:image/svg+xml;base64,${toBase64(new TextEncoder().encode(svg))}`
  try {
    const image = new Image()
    image.src = svgUrl
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    canvas.getContext("2d")!.drawImage(image, 0, 0, width, height)
    return { dataURL: canvas.toDataURL("image/png"), mimeType: "image/png" }
  } catch {
    return { dataURL: svgUrl, mimeType: "image/svg+xml" }
  }
}

type StickerFile = BinaryFileData & { width: number; height: number }

const drawn = new Map<string, Promise<StickerFile | null>>()

/** The picture behind a sticker's file id, drawn once per session */
export function stickerFile(fileId: string): Promise<StickerFile | null> {
  const sticker = STICKERS.find((entry) => entry.id === fileId)
  if (!sticker) return Promise.resolve(null)
  let file = drawn.get(fileId)
  if (!file) {
    file = drawSvg(sticker)
      .then(async ({ svg, width, height }) => {
        const { dataURL, mimeType } = await rasterize(svg, width, height)
        return { id: fileId as FileId, mimeType, dataURL: dataURL as DataURL, created: Date.now(), width, height }
      })
      .catch(() => {
        drawn.delete(fileId)
        return null
      })
    drawn.set(fileId, file)
  }
  return file
}

import "@/lib/excalidrawAssets"
import { useEffect, useRef, useState } from "react"
import { exportToCanvas, exportToSvg } from "@excalidraw/excalidraw"
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { BinaryFiles } from "@excalidraw/excalidraw/types"
import type * as Y from "yjs"
import { applyRemote } from "@/lib/excalidrawYjs"
import { boardFile, missingFileIds, withHeldImages, type BoardAccess } from "./boardFiles"

const RENDER_DELAY_MS = 300

/** A board inside a paper as a picture, redrawn as users draw. It is also what the paper prints */
function BoardPreview({
  map,
  docId,
  access,
  onReady,
}: {
  map: Y.Map<unknown>
  /** The paper the board lives in, whose own images are the only ones it shows */
  docId: string
  access: BoardAccess
  onReady: (empty: boolean) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const ready = useRef(onReady)
  ready.current = onReady
  const readAccess = useRef(access)
  readAccess.current = access
  const [empty, setEmpty] = useState(false)

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let run = 0
    const draw = async () => {
      timer = null
      const turn = ++run
      const elements = JSON.parse(
        JSON.stringify(applyRemote(map.entries()).filter((element) => !element.isDeleted)),
      ) as NonDeletedExcalidrawElement[]
      if (elements.length === 0) {
        box.current?.replaceChildren()
        setEmpty(true)
        ready.current(true)
        return
      }
      const files: BinaryFiles = {}
      const found = await Promise.all(missingFileIds(elements, files).map((id) => boardFile(id, docId, () => readAccess.current())))
      for (const file of found) if (file) files[file.id] = file
      const shown = withHeldImages(elements, new Set(Object.keys(files)))
      let svg: SVGSVGElement
      try {
        // A tiny canvas export loads the text's fonts into the page, so the picture needn't carry them
        const text = elements.filter((element) => element.type === "text")
        if (text.length) await exportToCanvas({ elements: text, files: null, maxWidthOrHeight: 1 })
        svg = await exportToSvg({
          elements: shown,
          files,
          exportPadding: 16,
          skipInliningFonts: true,
          appState: { exportBackground: false, exportWithDarkMode: false },
        })
      } catch {
        if (live && turn === run) ready.current(false)
        return
      }
      if (!live || turn !== run || !box.current) return
      svg.removeAttribute("width")
      svg.removeAttribute("height")
      svg.setAttribute("aria-hidden", "true")
      svg.classList.add("size-full")
      box.current.replaceChildren(svg)
      setEmpty(false)
      ready.current(false)
    }
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void draw(), RENDER_DELAY_MS)
    }
    void draw()
    map.observe(schedule)
    return () => {
      live = false
      if (timer) clearTimeout(timer)
      map.unobserve(schedule)
    }
  }, [map, docId])

  return (
    <>
      <div ref={box} className="flex size-full items-center justify-center p-3" />
      {empty && <span className="absolute inset-0 flex items-center justify-center text-ui text-muted-foreground">Empty board</span>}
    </>
  )
}

export default BoardPreview

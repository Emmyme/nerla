import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { cn, remPx } from "@/lib/utils"
import { usePortalContainer } from "./portal-container"

export type AnchorRect = { top: number; left: number; bottom: number; right: number }
/** Anything that can say where it is, such as an element or a drag selection, with the element it follows if any */
export type VirtualAnchor = { getBoundingClientRect: () => AnchorRect; element?: () => Element | null }
/** Below the anchor and flipped above when it does not fit, or beside it and flipped to the other side */
export type PopoverSide = "bottom" | "right"

export const POPOVER_SURFACE =
  "rounded-lg border-[0.0625rem] border-border bg-popover text-popover-foreground shadow-[var(--shadow-popover)] outline-none animate-in fade-in-0 motion-safe:zoom-in-95 duration-150"

/** Pure placement in px. The caller turns it into rem. */
function placePopover(
  box: AnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  rem: number,
  side: PopoverSide = "bottom",
): { top: number; left: number } {
  const gap = 0.3 * rem
  const margin = 0.5 * rem
  const { width, height } = size
  if (side === "right") {
    const fitsRight = box.right + gap + width <= viewport.width - margin
    const fitsLeft = box.left - gap - width >= margin
    const left = fitsRight || !fitsLeft ? Math.min(box.right + gap, viewport.width - margin - width) : box.left - gap - width
    const top = Math.min(box.top, viewport.height - margin - height)
    return { top: Math.max(margin, top), left: Math.max(margin, left) }
  }
  const fitsBelow = box.bottom + gap + height <= viewport.height - margin
  const fitsAbove = box.top - gap - height >= margin
  const top = fitsBelow || !fitsAbove ? Math.min(box.bottom + gap, viewport.height - margin - height) : box.top - gap - height
  const left = Math.min(box.left, viewport.width - margin - width)
  return { top: Math.max(margin, top), left: Math.max(margin, left) }
}

/**
 * Keeps a popover next to its anchor and inside the viewport, measured in rem like the rest of the app.
 * The anchor is `anchorRef`, or `virtual` when given.
 */
export function useAnchoredPosition<T extends HTMLElement = HTMLButtonElement>(
  open: boolean,
  { virtual, side = "bottom" }: { virtual?: VirtualAnchor | null; side?: PopoverSide } = {},
) {
  const anchorRef = useRef<T>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const virtualRef = useRef(virtual)
  virtualRef.current = virtual
  // Transparent rather than hidden until measured, so content can take focus as the popover opens
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0 })

  const place = useCallback(() => {
    const anchor = virtualRef.current ?? anchorRef.current
    const content = contentRef.current
    if (!anchor || !content) return
    const rem = remPx()
    const { top, left } = placePopover(
      anchor.getBoundingClientRect(),
      { width: content.offsetWidth, height: content.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      rem,
      side,
    )
    const next = { top: `${top / rem}rem`, left: `${left / rem}rem` }
    setStyle((shown) => (shown.top === next.top && shown.left === next.left ? shown : next))
  }, [side])

  useEffect(() => {
    if (!open) return
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [open, place])

  // A region that changes size moves the anchor without a scroll or resize, such as the dock once its chat list closes
  useEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") return
    const anchor = virtual ?? anchorRef.current
    const element = anchor instanceof Element ? anchor : anchor?.element?.()
    const region = element?.closest("[data-region]") ?? element?.parentElement
    if (!region) return
    const observer = new ResizeObserver(() => place())
    observer.observe(region)
    return () => observer.disconnect()
  }, [open, virtual, place])

  useEffect(() => {
    if (open && virtual) place()
  }, [open, virtual, place])

  // Content that changes size, such as a menu that swaps its view, stays in place and on screen
  const resized = useRef<ResizeObserver | null>(null)
  const contentCallback = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node
      resized.current?.disconnect()
      resized.current = null
      if (!node) return
      place()
      if (typeof ResizeObserver === "undefined") return
      resized.current = new ResizeObserver(() => place())
      resized.current.observe(node)
    },
    [place],
  )

  return { anchorRef, contentRef: contentCallback, style, reposition: place }
}

/**
 * A non-modal popover anchored to a rect rather than a trigger, for event blocks and drag selections.
 * Escape and a click outside close it through `onOpenChange`. With no trigger to go back to, focus
 * returns to `returnFocus()` on close, unless the close came from a press outside.
 */
export function AnchoredPopover({
  open,
  onOpenChange,
  anchor,
  side = "right",
  title,
  id,
  className,
  onOpenAutoFocus,
  returnFocus,
  onPointerEnter,
  onPointerLeave,
  keepOnAnchorPress = false,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchor: VirtualAnchor | null
  side?: PopoverSide
  title: string
  id?: string
  className?: string
  onOpenAutoFocus?: (event: Event) => void
  returnFocus?: () => void
  onPointerEnter?: (event: PointerEvent<HTMLDivElement>) => void
  onPointerLeave?: (event: PointerEvent<HTMLDivElement>) => void
  /** A press on the anchor element is left to the anchor's own click, rather than closing as a press outside */
  keepOnAnchorPress?: boolean
  children: ReactNode
}) {
  const { contentRef, style } = useAnchoredPosition(open, { virtual: anchor, side })
  const pressedOutside = useRef(false)
  const container = usePortalContainer()
  useEffect(() => {
    if (open) pressedOutside.current = false
  }, [open])
  return (
    <Dialog.Root open={open && !!anchor} onOpenChange={onOpenChange} modal={false}>
      <Dialog.Portal container={container}>
        <Dialog.Content
          ref={contentRef}
          id={id}
          aria-describedby={undefined}
          style={style}
          onOpenAutoFocus={onOpenAutoFocus}
          onInteractOutside={(event) => {
            if (keepOnAnchorPress && anchor instanceof Element && event.target instanceof Node && anchor.contains(event.target)) {
              event.preventDefault()
              return
            }
            pressedOutside.current = true
          }}
          onCloseAutoFocus={
            returnFocus
              ? (event) => {
                  event.preventDefault()
                  if (!pressedOutside.current) returnFocus()
                }
              : undefined
          }
          onKeyDown={(event) => event.stopPropagation()}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          className={cn("fixed z-50 flex max-h-[calc(100dvh-1rem)] flex-col overflow-y-auto", POPOVER_SURFACE, className)}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

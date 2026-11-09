import { useLayoutEffect, useRef, type ReactNode } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { FADE_MOTION, SHEET_MOTION, type Presence } from "@/lib/motion"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { cn } from "@/lib/utils"

/**
 * The docked panel column on desktop, the same on every page that opens tasks. The page keeps its column while
 * `presence.mounted`, so the panel can ease out with what it last showed.
 */
export function TaskPanelDock({ presence, children, className }: { presence: Presence; children: ReactNode; className?: string }) {
  const last = useRef(children)
  if (presence.state === "open") last.current = children
  return (
    <div
      ref={presence.ref}
      data-state={presence.state}
      className={cn(
        "min-h-0 border-l-[0.0625rem] border-border bg-card",
        FADE_MOTION,
        "data-[state=closed]:pointer-events-none motion-safe:data-[state=closed]:slide-out-to-right-4 motion-safe:data-[state=open]:slide-in-from-right-4",
        className,
      )}
    >
      {presence.state === "open" ? children : last.current}
    </div>
  )
}

export function TaskPanelSheet({
  open,
  onOpenChange,
  label,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  label: string
  children: ReactNode
}) {
  const desktop = useIsDesktop()
  const contentRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const pendingEscape = useRef<KeyboardEvent | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const active = document.activeElement
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
  }, [open])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={!desktop}>
      <Dialog.Portal>
        <Dialog.Content
          ref={contentRef}
          aria-modal={desktop ? undefined : "true"}
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            // The panel handles Escape itself, so a menu or a dirty field can claim it first
            event.preventDefault()
            if (event.isComposing) return
            if (event.target instanceof Node && contentRef.current?.contains(event.target)) pendingEscape.current = event
            else onOpenChange(false)
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.nativeEvent.isComposing || event.nativeEvent !== pendingEscape.current) return
            pendingEscape.current = null
            onOpenChange(false)
          }}
          onInteractOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const active = document.activeElement
            const opener = openerRef.current
            if ((!active || active === document.body) && opener?.isConnected) opener.focus()
          }}
          className={cn(
            "fixed inset-x-0 top-titlebar bottom-0 z-50 flex flex-col overflow-hidden bg-card text-foreground outline-none",
            "lg:left-auto lg:w-[23rem] lg:border-l-[0.0625rem] lg:border-border lg:shadow-[var(--shadow-popover)]",
            SHEET_MOTION.right,
          )}
        >
          <Dialog.Title className="sr-only">{label}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

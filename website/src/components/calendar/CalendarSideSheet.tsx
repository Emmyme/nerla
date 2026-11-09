import type { ReactNode } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { X } from "@/components/icons"
import { FADE_MOTION, SHEET_MOTION, useOpenTransition } from "@/lib/motion"
import { cn, keepToasts } from "@/lib/utils"

/** The calendars side on a phone, as a sheet from the left. `keepFocus` true leaves focus where it went, as on a new event's title */
export function CalendarSideSheet({
  open,
  onOpenChange,
  keepFocus,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  keepFocus: () => boolean
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={cn("fixed inset-x-0 top-titlebar bottom-0 z-40 bg-app-scrim", FADE_MOTION)} />
        <Dialog.Content
          onInteractOutside={keepToasts}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (keepFocus()) event.preventDefault()
          }}
          className={cn(
            "fixed top-titlebar bottom-0 left-0 z-50 flex w-[min(20rem,88vw)] flex-col overflow-y-auto bg-card px-3 pt-3 pb-6 shadow-[var(--shadow-popover)] outline-none",
            SHEET_MOTION.left,
          )}
        >
          <div className="mb-2 flex items-center justify-between">
            <Dialog.Title className="px-2 text-title font-semibold text-foreground">Calendars</Dialog.Title>
            <Dialog.Close
              aria-label="Close calendars"
              className="flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-app-hover hover:text-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
            >
              <X aria-hidden="true" weight="bold" className="size-[1rem]" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The calendars side on a desktop. Eases its width so the grid narrows and widens with it, and its content is gone once it has closed */
export function SideColumn({ open, children }: { open: boolean; children: ReactNode }) {
  const { ref, expanded, hidden } = useOpenTransition<HTMLElement>(open)
  return (
    <aside
      ref={ref}
      aria-label="Calendars"
      hidden={hidden}
      data-open={expanded ? "" : undefined}
      className={cn("motion-size shrink-0 overflow-hidden", expanded ? "w-[16.75rem] opacity-100" : "w-0 opacity-0")}
    >
      <div className="h-full w-[16rem] overflow-y-auto pr-1 pb-4">{!hidden && children}</div>
    </aside>
  )
}

import type { ReactNode } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { FADE_MOTION, SHEET_MOTION } from "@/lib/motion"
import { cn, keepToasts } from "@/lib/utils"
import { usePortalContainer } from "./portal-container"

/** A phone sheet over a scrim, rising from the bottom edge */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  id,
  showTitle = false,
  returnFocus,
  onOpenAutoFocus,
  className,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  id?: string
  showTitle?: boolean
  returnFocus?: () => void
  onOpenAutoFocus?: (event: Event) => void
  className?: string
  children: ReactNode
}) {
  const container = usePortalContainer()
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className={cn("fixed inset-0 z-50 bg-app-scrim", FADE_MOTION)} />
        <Dialog.Content
          onInteractOutside={keepToasts}
          id={id}
          aria-describedby={undefined}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={
            returnFocus
              ? (event) => {
                  event.preventDefault()
                  returnFocus()
                }
              : undefined
          }
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col overflow-y-auto rounded-t-xl bg-popover px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-popover-foreground outline-none",
            SHEET_MOTION.bottom,
            className,
          )}
        >
          <Dialog.Title className={showTitle ? "px-2 pt-1 pb-2 text-body font-semibold text-foreground" : "sr-only"}>{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

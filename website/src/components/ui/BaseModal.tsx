import { useId, useLayoutEffect, useRef } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { X } from "@/components/icons"
import { FADE_MOTION } from "@/lib/motion"
import { usePortalContainer } from "./portal-container"
import { keepToasts } from "@/lib/utils"
import { takeMenuOpener } from "@/lib/dialogOpener"

interface BaseModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: React.ReactNode
  maxWidth?: "sm" | "md" | "lg" | "xl"
  showHeader?: boolean
  showCloseButton?: boolean
  fallbackFocus?: () => HTMLElement | null | undefined
  /** What takes focus when the dialog opens, in place of its first control */
  initialFocus?: () => HTMLElement | null | undefined
  /** The id of body text that describes the dialog, read out with its title */
  describedBy?: string
}

const maxWidthClasses = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
}

export default function BaseModal({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  maxWidth = "md",
  showHeader = true,
  showCloseButton = true,
  fallbackFocus,
  initialFocus,
  describedBy,
}: BaseModalProps) {
  const subtitleId = useId()
  const opener = useRef<HTMLElement | null>(null)

  // There is no Radix trigger to hand focus back to, so remember what had it before the dialog took it
  useLayoutEffect(() => {
    if (!isOpen) return
    const active = document.activeElement
    opener.current = takeMenuOpener() ?? (active instanceof HTMLElement && active !== document.body ? active : null)
  }, [isOpen])

  const container = usePortalContainer()

  const restoreFocus = (event: Event) => {
    const target = opener.current?.isConnected ? opener.current : fallbackFocus?.()
    opener.current = null
    if (!target) return
    event.preventDefault()
    target.focus()
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      {/* Inside the dark call the dialog keeps the call's tokens */}
      <Dialog.Portal container={container}>
        <Dialog.Overlay className={`fixed inset-0 z-50 bg-app-scrim ${FADE_MOTION}`} />
        <Dialog.Content
          onInteractOutside={keepToasts}
          aria-modal="true"
          aria-describedby={[subtitle ? subtitleId : null, describedBy].filter(Boolean).join(" ") || undefined}
          onCloseAutoFocus={restoreFocus}
          onOpenAutoFocus={(event) => {
            const target = initialFocus?.()
            if (!target) return
            event.preventDefault()
            target.focus()
          }}
          className={`modal-content-in fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-card shadow-[var(--shadow-popover)] ${maxWidthClasses[maxWidth]}`}
        >
          {showHeader ? (
            <div className="flex items-start justify-between border-b border-border p-6">
              <div className="flex-1">
                <Dialog.Title className="modal-title">{title}</Dialog.Title>
                {subtitle && (
                  <p id={subtitleId} className="mt-1 text-ui text-muted-foreground">
                    {subtitle}
                  </p>
                )}
              </div>
              {showCloseButton && (
                <Dialog.Close
                  className="-m-2 ml-4 flex size-11 items-center justify-center rounded-md transition-colors duration-150 hover:bg-app-hover sm:m-0 sm:ml-4 sm:size-8"
                  aria-label="Close modal"
                >
                  <X className="size-5 text-muted-foreground" strokeWidth={2} />
                </Dialog.Close>
              )}
            </div>
          ) : (
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
          )}

          <div className="flex-1 overflow-y-auto">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

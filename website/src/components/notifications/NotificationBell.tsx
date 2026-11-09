import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router"
import * as Dialog from "@radix-ui/react-dialog"
import { isTauri } from "@tauri-apps/api/core"
import { AiCatButton } from "@/components/ai/AiCatButton"
import { usePopoverToggle } from "@/components/ui/use-popover-toggle"
import { IconTip } from "@/components/ui/icon-tip"
import { Bell } from "@/components/icons"
import { WINDOW_BUTTON } from "@/components/shell/WindowControls"
import { AnchoredPopover } from "@/components/ui/anchored-popover"
import { Button } from "@/components/ui/button"
import { usePortalContainer } from "@/components/ui/portal-container"
import { UnreadDot } from "@/components/ui/unread-dot"
import type { NotificationItem } from "@/lib/api/notifications"
import { FADE_MOTION, SHEET_MOTION } from "@/lib/motion"
import { loadNotifications, readNotification, useUnreadNotifications } from "@/lib/notificationStore"
import { useIsDesktop } from "@/lib/useMediaQuery"
import { cn, keepToasts } from "@/lib/utils"
import { subscribeSlots, topSlot } from "./BellSlot"
import { NotificationList } from "./NotificationList"

function bellLabel(unread: number) {
  return unread > 0 ? `Notifications, ${unread} unread` : "Notifications"
}

/**
 * The bell, once for the shell. The desktop window shows it in the title bar. Elsewhere it sits in the page header's
 * slot, or in the top right corner of a page without one. Desktop opens a popover and a phone a full-screen sheet.
 */
export function NotificationBell() {
  const titlebar = isTauri()
  const slot = useSyncExternalStore(subscribeSlots, topSlot, () => null)
  const unread = useUnreadNotifications()
  const desktop = useIsDesktop()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const toggle = usePopoverToggle(open, setOpen)
  const button = useRef<HTMLButtonElement>(null)
  const opening = useRef(false)
  const listId = useId()
  const container = usePortalContainer()

  useEffect(() => {
    if (open) loadNotifications()
  }, [open])

  const openItem = (item: NotificationItem) => {
    if (!item.href) return
    readNotification(item)
    opening.current = true
    setOpen(false)
    navigate(item.href)
  }
  const returnFocus = () => {
    if (!opening.current) button.current?.focus()
    opening.current = false
  }

  const dot = unread > 0 && (
    <UnreadDot
      className={cn("pointer-events-none absolute", titlebar ? "top-1.5 right-3.5" : "top-2 right-2 max-lg:top-2.5 max-lg:right-2.5")}
    />
  )
  const trigger = titlebar ? (
    <button
      ref={button}
      type="button"
      aria-label={bellLabel(unread)}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      title="Notifications"
      {...toggle}
      className={cn(WINDOW_BUTTON, "app-region-no-drag relative")}
    >
      <Bell aria-hidden="true" className="size-[1.125rem]" />
      {dot}
    </button>
  ) : (
    <IconTip label="Notifications">
      <Button
        ref={button}
        type="button"
        variant="ghost"
        size="icon"
        aria-label={bellLabel(unread)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        {...toggle}
        className="relative size-10 shrink-0 text-muted-foreground hover:text-foreground max-lg:size-11"
      >
        <Bell aria-hidden="true" className="size-5 max-lg:size-[1.375rem]" />
        {dot}
      </Button>
    </IconTip>
  )

  const list = desktop ? (
    <AnchoredPopover
      open={open}
      onOpenChange={setOpen}
      anchor={open ? button.current : null}
      side="bottom"
      title="Notifications"
      id={listId}
      returnFocus={returnFocus}
      className={cn(
        "max-h-[min(36rem,calc(100dvh-6rem))] w-96 overflow-hidden",
        FADE_MOTION,
        "motion-safe:data-[state=closed]:zoom-out-95",
      )}
    >
      <NotificationList onOpen={openItem} />
    </AnchoredPopover>
  ) : (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal container={container}>
        <Dialog.Content
          onInteractOutside={keepToasts}
          id={listId}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            returnFocus()
          }}
          className={cn(
            "fixed inset-x-0 top-titlebar bottom-0 z-50 flex flex-col bg-popover pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-popover-foreground outline-none",
            SHEET_MOTION.bottom,
          )}
        >
          <Dialog.Title className="sr-only">Notifications</Dialog.Title>
          <NotificationList onOpen={openItem} onClose={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )

  // The AI's cat sits just before the bell wherever the bell goes, so the two always move together
  const pair = (
    <>
      <AiCatButton titlebar={titlebar} />
      {trigger}
    </>
  )
  const placed = titlebar ? (
    pair
  ) : slot ? (
    createPortal(pair, slot)
  ) : (
    <div className="absolute top-4 right-4 z-20 flex items-center gap-1 lg:top-6 lg:right-6">{pair}</div>
  )

  return (
    <>
      {placed}
      {list}
    </>
  )
}

import { toast } from "sonner"
import { markedVia } from "@/components/ai/via"
import { ViaMark } from "@/components/ai/ViaMark"
import { Bell, X } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { CatNapping } from "@/components/ui/cat-scenes"
import { LoadingSpinner } from "@/components/ui/spinner"
import { UnreadDot } from "@/components/ui/unread-dot"
import { avatarOf, UserAvatar } from "@/components/ui/user-avatar"
import type { NotificationItem } from "@/lib/api/notifications"
import { formatRelative } from "@/lib/dates"
import { loadMoreNotifications, loadNotifications, readAllNotifications, readNotification, useNotifications } from "@/lib/notificationStore"
import { cn } from "@/lib/utils"

const READ_ALL_FAILED = "Couldn't mark them as read. Check your connection and try again."

const ROW =
  "flex w-full gap-3 rounded-md px-2.5 py-2.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-[0.125rem] focus-visible:ring-inset focus-visible:ring-ring"

function Row({ item, onOpen }: { item: NotificationItem; onOpen: (item: NotificationItem) => void }) {
  const gone = item.href === null
  const face = (
    <>
      {gone || !item.actor ? (
        <span
          aria-hidden="true"
          className="flex size-[2rem] shrink-0 items-center justify-center rounded-full bg-app-sunk text-muted-foreground"
        >
          <Bell className="size-[1rem]" />
        </span>
      ) : (
        <UserAvatar user={avatarOf(item.actor)} size="md" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-ui leading-[1.4]", gone ? "text-muted-foreground" : "font-medium text-foreground")}>
          {item.title}
          {!gone && markedVia(item.via) && (
            <ViaMark via={item.via} personName={item.actor?.name ?? "Someone"} inside className="ml-1.5 align-[-0.125rem]" />
          )}
        </span>
        {!gone && item.snippet && <span className="line-clamp-2 text-caption leading-[1.45] text-muted-foreground">{item.snippet}</span>}
        <span className="flex items-baseline gap-3">
          <time dateTime={item.createdAt} className="text-caption text-muted-foreground">
            {formatRelative(item.createdAt)}
          </time>
          {gone && !item.read && (
            <button
              type="button"
              onClick={() => readNotification(item)}
              className="rounded-sm text-caption font-medium text-foreground underline-offset-[0.2rem] hover:underline focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:-my-2 max-lg:py-2"
            >
              Mark as read
            </button>
          )}
        </span>
      </span>
      {!item.read && <UnreadDot label="Unread" className="mt-1.5" />}
    </>
  )
  const fill = item.read ? "hover:bg-app-hover" : "bg-app-selected hover:bg-app-hover"

  return (
    <li>
      {gone ? (
        <div className={cn(ROW, "items-start", !item.read && "bg-app-selected")}>{face}</div>
      ) : (
        <button type="button" onClick={() => onOpen(item)} className={cn(ROW, "items-start", fill)}>
          {face}
        </button>
      )}
    </li>
  )
}

/** The bell's list, newest first. Rows open their place, and the list never reads anything by being open */
export function NotificationList({ onOpen, onClose }: { onOpen: (item: NotificationItem) => void; onClose?: () => void }) {
  const { items, unread, status, loaded, nextCursor, loadingMore } = useNotifications()

  const readAll = async () => {
    if (unread === 0) return
    if (!(await readAllNotifications())) toast.error(READ_ALL_FAILED)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b-[0.0625rem] border-border px-3 py-2 max-lg:px-4 max-lg:py-1.5">
        <h2 className="min-w-0 flex-1 truncate text-ui font-semibold text-foreground max-lg:text-lead">Notifications</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-disabled={unread === 0 || undefined}
          onClick={() => void readAll()}
          className="-mr-1 text-muted-foreground hover:text-foreground"
        >
          Mark all as read
        </Button>
        {onClose && (
          <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose} className="-mr-2 shrink-0">
            <X aria-hidden="true" className="size-5" />
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5 max-lg:px-2">
        {!loaded && status === "error" ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <p className="text-ui text-muted-foreground">Couldn't load your notifications. Check your connection and try again.</p>
            <Button type="button" variant="outline" size="sm" onClick={loadNotifications}>
              Try again
            </Button>
          </div>
        ) : !loaded ? (
          <div className="flex justify-center py-10">
            <LoadingSpinner />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <CatNapping />
            <p className="text-body font-semibold text-foreground">All quiet</p>
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5">
              {items.map((item) => (
                <Row key={item.id} item={item} onOpen={onOpen} />
              ))}
            </ul>
            {nextCursor && (
              <div className="flex justify-center py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-busy={loadingMore || undefined}
                  onClick={loadMoreNotifications}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {loadingMore ? "Loading" : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

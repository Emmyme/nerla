import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { filesPath } from "@/components/files/FilesNav"
import { ConfirmDialog } from "@/components/settings/ConfirmDialog"
import { Button } from "@/components/ui/button"
import { CatInTrash } from "@/components/ui/cat-scenes"
import { Skeleton } from "@/components/ui/skeleton"
import { LoadingSpinner } from "@/components/ui/spinner"
import { trashAPI, type Restored, type TrashFilterKey, type TrashItem } from "@/lib/api/trash"
import { refreshCalendar } from "@/lib/calendarStore"
import { dayKey, parseServerDate } from "@/lib/dates"
import { messageOf, notifyTasksChanged } from "@/lib/taskStore"
import { EMPTY_TEXT, KIND_NAMES, restoredTo } from "@/lib/trashText"
import { useMediaQuery } from "@/lib/useMediaQuery"
import { returnProject } from "@/lib/useProjects"
import { useAuth } from "@/providers/AuthProvider"
import { TrashRow } from "./TrashRow"

const LOAD_FAILED = "Couldn't load the trash. Check your connection and try again."
const RESTORE_FAILED = "Couldn't restore it. Try again."
const PURGE_FAILED = "Couldn't delete it. Try again."

type Status = "loading" | "ready" | "error"

/** Where Open goes once an item is back */
function openPath(item: TrashItem, restored: Restored): string {
  if (restored.kind === "task") {
    const { task } = restored
    return task.project ? `/project/${task.project.slug}?task=${task.id}` : `/?task=${task.id}`
  }
  if (restored.kind === "project") return `/project/${restored.project.slug}`
  if (restored.kind === "event") {
    const start = "starts_at" in restored.event ? parseServerDate(restored.event.starts_at) : null
    return start ? `/calendar?date=${dayKey(start)}&event=${restored.event.id}` : "/calendar"
  }
  if (item.kind === "paper" || item.kind === "board") return `/${item.kind}/${item.id}`
  // A folder opens itself, a file the folder it sits in
  const folderId = item.kind === "folder" ? item.id : (item.folderId ?? null)
  return filesPath(item.projectId ? { section: "project", projectId: item.projectId, folderId } : { section: "mine", folderId })
}

const rowButton = (root: HTMLElement | null, id: string | null) =>
  (id ? root?.querySelector<HTMLElement>(`[data-trash-row="${id}"] button`) : null) ?? null

/** What else on screen learns the item is back */
function announce(restored: Restored) {
  if (restored.kind === "task") notifyTasksChanged()
  if (restored.kind === "project") {
    returnProject(restored.project)
    notifyTasksChanged()
  }
  if (restored.kind === "event") void refreshCalendar()
}

function Placeholder({ text, art, alert, onRetry }: { text: string; art?: boolean; alert?: boolean; onRetry?: () => void }) {
  return (
    <div
      role={alert ? "alert" : undefined}
      className="flex flex-col items-center gap-3 rounded-xl px-4 py-12 text-center ring-[0.0625rem] ring-border"
    >
      {art && <CatInTrash />}
      <p className="max-w-[26rem] text-body text-muted-foreground">{text}</p>
      {onRetry && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg bg-card ring-[0.0625rem] ring-border">
      <span role="status" className="sr-only">
        Loading Trash
      </span>
      <div aria-hidden="true">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-3 border-b-[0.0625rem] border-border px-3 py-3 last:border-b-0">
            <Skeleton className="size-[1.75rem] rounded-md" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-[0.9rem] w-[14rem] max-w-[60%]" />
              <Skeleton className="h-[0.7rem] w-[20rem] max-w-[80%]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** One filter's Trash, newest deleted first, 50 at a time with more on scroll */
export function TrashList({ kind, fallbackFocus }: { kind: TrashFilterKey; fallbackFocus: () => HTMLElement | null }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const wide = useMediaQuery("(min-width: 40rem)")
  const [items, setItems] = useState<TrashItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>("loading")
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState<"idle" | "loading" | "error">("idle")
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [purging, setPurging] = useState<TrashItem | null>(null)
  const [now, setNow] = useState(() => new Date())
  const list = useRef<HTMLUListElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const focusNext = useRef<string | null>(null)
  const purgedNext = useRef<string | null>(null)
  const moreRequest = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    moreRequest.current?.abort()
    setStatus("loading")
    setItems([])
    setCursor(null)
    setMore("idle")
    trashAPI.list(kind, null, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return
        setItems(page.items)
        setCursor(page.nextCursor)
        setNow(new Date())
        setStatus("ready")
      },
      (err: unknown) => {
        if (controller.signal.aborted) return
        setError(messageOf(err, LOAD_FAILED))
        setStatus("error")
      },
    )
    return () => {
      controller.abort()
      moreRequest.current?.abort()
    }
  }, [kind, attempt])

  const loadMore = useCallback(() => {
    if (!cursor || more === "loading") return
    setMore("loading")
    // A reply for a filter that is no longer on screen is dropped
    const controller = new AbortController()
    moreRequest.current = controller
    trashAPI.list(kind, cursor, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return
        setItems((shown) => [...shown, ...page.items.filter((item) => !shown.some((other) => other.id === item.id))])
        setCursor(page.nextCursor)
        setMore("idle")
      },
      () => !controller.signal.aborted && setMore("error"),
    )
  }, [kind, cursor, more])

  useEffect(() => {
    const node = sentinel.current
    if (!node || !cursor || more !== "idle" || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver((seen) => seen.some((entry) => entry.isIntersecting) && loadMore(), { rootMargin: "20rem" })
    observer.observe(node)
    return () => observer.disconnect()
  }, [cursor, more, loadMore])

  // A row that leaves hands focus to the row after it, or the one before, or the page title
  useEffect(() => {
    const id = focusNext.current
    if (id === null) return
    focusNext.current = null
    const active = document.activeElement
    if (active && active !== document.body && list.current?.contains(active)) return
    const target = rowButton(list.current, id) ?? fallbackFocus()
    target?.focus()
  }, [items, fallbackFocus])

  const neighbour = (item: TrashItem) => {
    const index = items.findIndex((other) => other.id === item.id)
    return (items[index + 1] ?? items[index - 1])?.id ?? null
  }
  const remove = (item: TrashItem) => setItems((shown) => shown.filter((other) => other.id !== item.id))

  const restore = (item: TrashItem) => {
    if (busy.has(item.id)) return
    setBusy((running) => new Set(running).add(item.id))
    trashAPI
      .restore(item)
      .then(
        (restored) => {
          focusNext.current = neighbour(item) ?? ""
          remove(item)
          announce(restored)
          toast.success(`Restored to ${restoredTo(item)}`, {
            action: { label: "Open", onClick: () => navigate(openPath(item, restored)) },
          })
        },
        (err: unknown) => toast.error(messageOf(err, RESTORE_FAILED)),
      )
      .finally(() =>
        setBusy((running) => {
          const next = new Set(running)
          next.delete(item.id)
          return next
        }),
      )
  }

  let content
  if (status === "loading") content = <ListSkeleton />
  else if (status === "error") content = <Placeholder alert text={error ?? LOAD_FAILED} onRetry={() => setAttempt((count) => count + 1)} />
  else if (items.length === 0) content = <Placeholder art={kind === "all"} text={EMPTY_TEXT[kind]} />
  else
    content = (
      <div className="flex flex-col gap-3">
        <div className="overflow-hidden rounded-lg bg-card ring-[0.0625rem] ring-border">
          <ul ref={list} aria-label="Items in the trash" className="divide-y-[0.0625rem] divide-border">
            {items.map((item) => (
              <TrashRow
                key={`${item.kind}:${item.id}`}
                item={item}
                now={now}
                me={user?.id ?? null}
                wide={wide}
                busy={busy.has(item.id)}
                onRestore={restore}
                onPurge={setPurging}
              />
            ))}
          </ul>
        </div>
        {cursor && (
          <div ref={sentinel} className="flex justify-center py-2">
            {more === "error" ? (
              <p role="alert" className="flex items-center gap-2 text-ui text-muted-foreground">
                Couldn't load more.
                <Button type="button" variant="outline" size="sm" onClick={loadMore}>
                  Try again
                </Button>
              </p>
            ) : more === "loading" ? (
              <LoadingSpinner aria-label="Loading more" />
            ) : (
              <Button type="button" variant="ghost" size="sm" onClick={loadMore}>
                Show more
              </Button>
            )}
          </div>
        )}
      </div>
    )

  return (
    <>
      {content}
      <ConfirmDialog
        open={purging !== null}
        title="Delete forever?"
        confirmLabel="Delete forever"
        busyLabel="Deleting"
        failed={PURGE_FAILED}
        onClose={() => setPurging(null)}
        fallbackFocus={() => rowButton(list.current, purgedNext.current) ?? fallbackFocus()}
        onConfirm={async () => {
          if (!purging) return
          await trashAPI.purge(purging)
          purgedNext.current = neighbour(purging)
          remove(purging)
          toast.success(`${KIND_NAMES[purging.kind]} deleted for good`)
        }}
      >
        <span className="font-semibold text-foreground">{purging?.name}</span> will be deleted for good
        {purging?.kind === "project"
          ? ", with all of its tasks, files, papers, boards and chat"
          : purging?.kind === "folder"
            ? ", with everything in it"
            : ""}
        . This can't be undone.
      </ConfirmDialog>
    </>
  )
}

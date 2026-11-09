import { useId, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { KindGlyph } from "@/components/files/FileList"
import { downloadCount, expiryText, linkFacts } from "@/components/files/LinkDialog"
import { ChevronDown } from "@/components/icons"
import { formatFileSize } from "@/components/files/fileKinds"
import { Button } from "@/components/ui/button"
import { Collapse } from "@/components/ui/collapse"
import { Skeleton } from "@/components/ui/skeleton"
import { LoadingSpinner } from "@/components/ui/spinner"
import { avatarOf, UserAvatar } from "@/components/ui/user-avatar"
import { fileSharingAPI, type StorageDetail, type StorageMember } from "@/lib/api/fileSharing"
import { formatShortDate, parseServerDate } from "@/lib/dates"
import { messageOf } from "@/lib/taskStore"
import { useBusyLoad } from "@/lib/useBusyRetry"
import { cn } from "@/lib/utils"
import { ConfirmDialog } from "./ConfirmDialog"
import { LoadError, LoadingRows } from "./LoadState"
import { SettingsSection } from "./SettingsSection"

const LOAD_FAILED = "Couldn't load storage use. Check your connection and try again."
const DETAIL_FAILED = "Couldn't load their files and links. Try again."

const KIND_LABEL: Record<StorageDetail["files"][number]["kind"], string> = {
  image: "Image",
  pdf: "PDF",
  video: "Video",
  audio: "Audio",
  file: "File",
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const of = (used: number, cap: number | null | undefined) =>
  cap ? `${formatFileSize(used)} of ${formatFileSize(cap)}` : formatFileSize(used)
const fileLine = (file: StorageDetail["files"][number]) =>
  `${KIND_LABEL[file.kind]} · ${formatFileSize(file.size)} · ${formatShortDate(parseServerDate(file.updatedAt) ?? file.updatedAt)}`

type FileRow = StorageDetail["files"][number]

/** Each user's storage, for an admin freeing space: sizes and types, never file names */
export function StorageUsage({ perPersonCap, totalCap }: { perPersonCap: number | null; totalCap: number | null }) {
  const { data: usage, setData: setUsage, loadError, busy, reload, retry } = useBusyLoad(fileSharingAPI.usage, LOAD_FAILED)
  const [open, setOpen] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, StorageDetail | "error">>({})
  const [deleting, setDeleting] = useState<{ member: StorageMember; file: FileRow } | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const ids = useId()

  const loadDetail = (userId: string) => {
    setDetails((all) => {
      const rest = { ...all }
      delete rest[userId]
      return rest
    })
    fileSharingAPI.usageOf(userId).then(
      (detail) => setDetails((all) => ({ ...all, [userId]: detail })),
      () => setDetails((all) => ({ ...all, [userId]: "error" })),
    )
  }

  const toggle = (userId: string) => {
    const next = open === userId ? null : userId
    setOpen(next)
    if (next && (!details[next] || details[next] === "error")) loadDetail(next)
  }

  const changeMember = (userId: string, change: (member: StorageMember) => StorageMember) =>
    setUsage(
      (current) =>
        current && {
          ...current,
          members: current.members.map((member) => (member.userId === userId ? change(member) : member)),
        },
    )

  const deleteFile = async ({ member, file }: { member: StorageMember; file: FileRow }) => {
    await fileSharingAPI.deleteForGood(file.id)
    // The purge takes the file's links with it, so both lists come fresh from the server
    loadDetail(member.userId)
    reload()
    toast.success("File deleted")
  }

  const turnOff = async (member: StorageMember, linkId: string) => {
    try {
      await fileSharingAPI.turnOffLink(linkId)
      setDetails((all) => {
        const detail = all[member.userId]
        return detail && detail !== "error"
          ? { ...all, [member.userId]: { ...detail, links: detail.links.filter((l) => l.id !== linkId) } }
          : all
      })
      changeMember(member.userId, (m) => ({ ...m, linkCount: Math.max(0, m.linkCount - 1) }))
      toast.success("Link turned off")
    } catch (err) {
      toast.error(messageOf(err, "Couldn't turn the link off. Try again."))
    }
  }

  return (
    <SettingsSection
      title="Storage use"
      meta={usage && of(usage.total, totalCap)}
      description="Files show by size and type. Links show what was shared outside."
    >
      {loadError ? (
        <LoadError message={loadError} onRetry={retry} />
      ) : !usage ? (
        <LoadingRows label="Loading storage use" busy={busy}>
          <Skeleton className="h-[2.75rem] rounded-lg" />
          <Skeleton className="h-[2.75rem] rounded-lg" />
        </LoadingRows>
      ) : (
        <ul ref={list} aria-label="Storage use by person" className="flex flex-col divide-y divide-border">
          {usage.members.map((member) => {
            const expanded = open === member.userId
            const detail = details[member.userId]
            const panel = `${ids}-${member.userId}`
            return (
              <li key={member.userId} className="py-1 first:pt-0 last:pb-0">
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={panel}
                  onClick={() => toggle(member.userId)}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:min-h-11"
                >
                  <UserAvatar user={avatarOf({ id: member.userId, name: member.name, avatarUrl: member.avatarUrl })} size="md" />
                  <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
                    <span className="flex min-w-0 flex-col sm:flex-1">
                      <span className="truncate text-body font-medium text-foreground">{member.name}</span>
                      <span className="truncate text-caption text-muted-foreground">{member.email}</span>
                    </span>
                    <span className="flex shrink-0 flex-wrap gap-x-3 text-ui text-muted-foreground tabular-nums">
                      <span className="font-medium text-foreground">{of(member.used, perPersonCap)}</span>
                      <span>{count(member.fileCount, "file", "files")}</span>
                      <span>{count(member.linkCount, "link", "links")}</span>
                    </span>
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      "size-[0.9rem] shrink-0 text-muted-foreground transition-transform duration-150",
                      expanded && "rotate-180",
                    )}
                  />
                </button>
                <Collapse open={expanded} id={panel} unmountClosed className="flex flex-col gap-4 px-2 pt-2 pb-3 sm:pl-13">
                  {detail === undefined ? (
                    <p role="status" className="flex items-center gap-2 text-ui text-muted-foreground">
                      <LoadingSpinner aria-hidden="true" />
                      Loading
                    </p>
                  ) : detail === "error" ? (
                    <LoadError message={DETAIL_FAILED} onRetry={() => loadDetail(member.userId)} />
                  ) : (
                    <>
                      <DetailList title="Largest files" empty="No files">
                        {detail.files.map((file) => (
                          <li key={file.id} className="flex min-h-[2.25rem] items-center gap-2.5 rounded-md py-1 pr-1 pl-1.5">
                            <KindGlyph kind={file.kind} />
                            <span className="min-w-0 flex-1 truncate text-ui text-foreground tabular-nums">{fileLine(file)}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-app-berry-text"
                              aria-label={`Delete ${fileLine(file).replaceAll(" · ", ", ")}`}
                              onClick={() => setDeleting({ member, file })}
                            >
                              Delete
                            </Button>
                          </li>
                        ))}
                      </DetailList>
                      <DetailList title="Links" empty="No active links">
                        {detail.links.map((link) => (
                          <li key={link.id} className="flex min-h-[2.25rem] items-center gap-2 rounded-md py-1 pr-1 pl-2.5">
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-ui font-medium text-foreground">{link.name}</span>
                              <span className="text-caption text-muted-foreground tabular-nums">
                                {expiryText(link.expiresAt)} · {downloadCount(link.downloadCount)}
                              </span>
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-app-berry-text"
                              aria-label={`Turn off the link to ${link.name}, ${linkFacts(link)}`}
                              onClick={() => void turnOff(member, link.id)}
                            >
                              Turn off
                            </Button>
                          </li>
                        ))}
                      </DetailList>
                    </>
                  )}
                </Collapse>
              </li>
            )
          })}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Delete forever?"
        confirmLabel="Delete forever"
        busyLabel="Deleting"
        failed="Couldn't delete the file. Try again."
        onConfirm={() => (deleting ? deleteFile(deleting) : Promise.resolve())}
        onClose={() => setDeleting(null)}
        fallbackFocus={() => list.current}
      >
        This file will be deleted forever, and its owner loses it. This can't be undone.
      </ConfirmDialog>
    </SettingsSection>
  )
}

function DetailList({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-ui font-semibold text-foreground">{title}</h3>
      {children.length === 0 ? (
        <p className="text-ui text-muted-foreground">{empty}</p>
      ) : (
        <ul aria-label={title} className="flex flex-col gap-0.5 rounded-lg bg-app-sunk p-1">
          {children}
        </ul>
      )}
    </div>
  )
}

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { JSONContent } from "@tiptap/core"
import { useParticipants } from "@livekit/components-react"
import { toast } from "sonner"
import { ArrowLeft, Board, Paper, Plus, Share } from "@/components/icons"
import { FilePicker } from "@/components/files/FilePicker"
import type { BoardPanel, LiveBoardReach } from "@/components/papers/LiveBoard"
import { Button } from "@/components/ui/button"
import { RadioList } from "@/components/ui/radio-list"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { ApiError } from "@/lib/api/request"
import { papersAPI, type CallShare, type DocMeta } from "@/lib/api/papers"
import type { DocLevel, DocType, FileItem } from "@/lib/api/files"
import { messageOf } from "@/lib/taskStore"
import { cn } from "@/lib/utils"
import { useAuth } from "@/providers/AuthProvider"
import { CallIconButton } from "./CallIconButton"
import { CallPanel } from "./CallPanel"
import { CALL_TOASTER } from "./incoming"
import { GuestDocTokens, meetingNotes, type CallPapers } from "./paperShare"

const PaperEditor = lazy(() => import("@/components/papers/PaperEditor"))
const LiveBoard = lazy(() => import("@/components/papers/LiveBoard"))

const LEVELS: { value: DocLevel; label: string; description: string }[] = [
  { value: "view", label: "Can view", description: "People in the call read along." },
  { value: "comment", label: "Can comment", description: "People in the call read and comment." },
  { value: "edit", label: "Can edit", description: "People in the call write and draw together." },
]
// The same order the server counts levels in
const RANK: Record<DocLevel, number> = { view: 1, comment: 2, edit: 3 }

const TONE: Record<DocType | "share", string> = {
  paper: "bg-app-sky-soft text-app-sky-ink",
  board: "bg-app-pistachio-soft text-app-pistachio-ink",
  share: "bg-app-lavender-soft text-app-lavender-ink",
}

/** Inside the panel the editor's sticky toolbar sits on the panel's own surface */
const ON_SURFACE = "lg:[--background:var(--color-surface)] lg:[--color-background:var(--color-surface)]"

type DocPick = { kind: "new"; docType: DocType; template: "blank" | "meeting" } | { kind: "existing"; file: FileItem; own: DocLevel }
type Step = { at: "start" } | { at: "paper" } | { at: "level"; pick: DocPick; level: DocLevel }

type GuestSide = { pass: () => string; name: string }

function Choice({
  tone,
  icon,
  label,
  description,
  onClick,
}: {
  tone: string
  icon: ReactNode
  label: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-app-hover focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none max-lg:min-h-11"
    >
      <span aria-hidden="true" className={cn("flex size-8 shrink-0 items-center justify-center rounded-md [&_svg]:size-[1.1rem]", tone)}>
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-ui font-medium text-app-text">{label}</span>
        <span className="text-caption text-app-text-muted">{description}</span>
      </span>
    </button>
  )
}

function pickName(pick: DocPick): string {
  if (pick.kind === "existing") return pick.file.name
  if (pick.docType === "board") return "New board"
  return pick.template === "meeting" ? "New paper with meeting notes" : "New paper"
}

/** New paper, then Blank or Meeting notes, New board, or a paper or board from Files, then the level for the call */
function Chooser({
  roomName,
  onShown,
  onCancel,
}: {
  roomName: string
  onShown: (share: CallShare, pick: DocPick) => void
  onCancel?: () => void
}) {
  const [step, setStep] = useState<Step>({ at: "start" })
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = (pick: DocPick) => {
    setError(null)
    setStep({ at: "level", pick, level: pick.kind === "existing" ? pick.own : "edit" })
  }

  const picked = async ([file]: FileItem[]) => {
    if (!file) return
    setError(null)
    try {
      const meta = await papersAPI.get(file.id)
      choose({ kind: "existing", file, own: meta.level })
    } catch (err) {
      setError(messageOf(err, "Couldn't open that one. Try another."))
    }
  }

  const show = async (pick: DocPick, level: DocLevel) => {
    setBusy(true)
    setError(null)
    try {
      const { share } = await papersAPI.openCallShare(
        pick.kind === "new"
          ? { roomName, level, create: { docType: pick.docType, template: pick.template } }
          : { roomName, level, fileId: pick.file.id },
      )
      // A doc already shown keeps its level unless this asked for more and could give it
      if (share.level !== level) toast(`Already shown at ${share.level}`, { toasterId: CALL_TOASTER })
      onShown(share, pick)
      setStep({ at: "start" })
    } catch (err) {
      setError(messageOf(err, "Couldn't show it in the call. Try again."))
    } finally {
      setBusy(false)
    }
  }

  const back = (to: Step) => (
    <Button type="button" variant="ghost" size="sm" onClick={() => (setError(null), setStep(to))} className="self-start">
      <ArrowLeft aria-hidden="true" className="size-[0.9rem]" />
      Back
    </Button>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-4 lg:px-3">
      {step.at === "start" && (
        <>
          <p className="px-2.5 text-ui text-app-text-muted">Show a paper or board beside the video, for everyone in the call.</p>
          <div className="flex flex-col gap-0.5">
            <Choice
              tone={TONE.paper}
              icon={<Paper />}
              label="New paper"
              description="Write together, from blank or meeting notes."
              onClick={() => setStep({ at: "paper" })}
            />
            <Choice
              tone={TONE.board}
              icon={<Board />}
              label="New board"
              description="Draw and add sticky notes together."
              onClick={() => choose({ kind: "new", docType: "board", template: "blank" })}
            />
            <Choice
              tone={TONE.share}
              icon={<Share />}
              label="Share a paper or board"
              description="Show one you can open in Files."
              onClick={() => setPicking(true)}
            />
          </div>
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel} className="self-start">
              Cancel
            </Button>
          )}
        </>
      )}
      {step.at === "paper" && (
        <>
          {back({ at: "start" })}
          <div className="flex flex-col gap-0.5">
            <Choice
              tone={TONE.paper}
              icon={<Paper />}
              label="Blank"
              description="An empty paper, for anything."
              onClick={() => choose({ kind: "new", docType: "paper", template: "blank" })}
            />
            <Choice
              tone={TONE.paper}
              icon={<Paper />}
              label="Meeting notes"
              description="The title, date and who joined, with Agenda, Notes and Action items."
              onClick={() => choose({ kind: "new", docType: "paper", template: "meeting" })}
            />
          </div>
        </>
      )}
      {step.at === "level" && (
        <>
          {back(step.pick.kind === "new" && step.pick.docType === "paper" ? { at: "paper" } : { at: "start" })}
          <p className="truncate px-1 text-ui font-medium text-app-text">{pickName(step.pick)}</p>
          <fieldset className="flex flex-col gap-2 px-1">
            <legend className="mb-2 text-caption font-medium text-app-text-muted">People in the call</legend>
            <RadioList
              name="call-level"
              value={step.level}
              options={LEVELS.filter((option) => step.pick.kind === "new" || RANK[option.value] <= RANK[step.pick.own])}
              onChange={(level) => setStep({ ...step, level })}
            />
          </fieldset>
          <div className="flex justify-end px-1">
            <Button type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void show(step.pick, step.level)}>
              Show in the call
            </Button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="px-2.5 text-ui text-app-berry-text">
          {error}
        </p>
      )}
      <FilePicker open={picking} projectId={null} docs onPick={(files) => void picked(files)} onClose={() => setPicking(false)} />
    </div>
  )
}

function DocSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 pt-2">
      <Skeleton className="h-[1rem] w-[70%]" />
      <Skeleton className="h-[1rem] w-[85%]" />
      <Skeleton className="h-[1rem] w-[55%]" />
    </div>
  )
}

/** A board file in the call, with its comments under it */
function CallBoard({
  fileId,
  level,
  reach,
  thumbnail,
  onAccessChange,
}: {
  fileId: string
  level: DocLevel
  reach: LiveBoardReach
  thumbnail: boolean
  onAccessChange: () => void
}) {
  const [panel, setPanel] = useState<BoardPanel | null>(null)
  return (
    <Suspense fallback={<Skeleton className="min-h-[18rem] flex-1 rounded-lg" />}>
      <LiveBoard
        fileId={fileId}
        level={level}
        reach={reach}
        layout="call"
        thumbnail={thumbnail}
        panel={panel}
        onPanel={setPanel}
        onAccessChange={onAccessChange}
      />
    </Suspense>
  )
}

/** The shown doc for a member, at the level the share or their own access gives them */
function MemberDoc({
  share,
  me,
  template,
  onStop,
  onGone,
}: {
  share: CallShare
  me: string | null
  template?: JSONContent[]
  onStop: (() => void) | null
  onGone: () => void
}) {
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const gone = useRef(onGone)
  gone.current = onGone

  const read = useCallback(
    (signal?: AbortSignal) =>
      papersAPI.get(share.fileId, share.id, signal).then(
        (next) => {
          setMeta(next)
          setFailed(null)
        },
        (err: unknown) => {
          if (signal?.aborted) return
          if (err instanceof ApiError && err.status === 404) return gone.current()
          setFailed(messageOf(err, "Couldn't open it. Try again."))
        },
      ),
    [share.fileId, share.id],
  )
  useEffect(() => {
    const abort = new AbortController()
    void read(abort.signal)
    return () => abort.abort()
  }, [read])

  // The share may have closed or changed, so the call's list and this doc's level are read again
  const accessChange = useCallback(() => {
    gone.current()
    void read()
  }, [read])

  const owner = meta?.file.owner.id === me
  const stop = onStop && (share.openedBy.id === me || owner) ? onStop : null

  if (failed) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 px-4">
        <p className="text-ui text-app-text-muted">{failed}</p>
        <Button type="button" variant="secondary" onClick={() => void read()}>
          Try again
        </Button>
      </div>
    )
  }
  return (
    <DocFrame share={share} stop={stop}>
      {!meta ? (
        <DocSkeleton />
      ) : share.docType === "paper" ? (
        <Suspense fallback={<DocSkeleton />}>
          <PaperEditor
            fileId={share.fileId}
            level={meta.level}
            shareId={share.id}
            template={template}
            compact
            projectId={meta.file.projectId}
            onAccessChange={accessChange}
          />
        </Suspense>
      ) : (
        <CallBoard
          fileId={share.fileId}
          level={meta.level}
          reach={{ shareId: share.id }}
          thumbnail={share.openedBy.id === me && meta.level === "edit"}
          onAccessChange={accessChange}
        />
      )}
    </DocFrame>
  )
}

/** Who showed the doc and what the call may do with it, above the doc */
function DocFrame({ share, stop, children }: { share: CallShare; stop: (() => void) | null; children: ReactNode }) {
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2">
        <p className="min-w-0 flex-1 truncate text-caption text-app-text-muted">
          Shown by {share.openedBy.name}, people in the call can {share.level}
        </p>
        {stop && (
          <Button type="button" variant="secondary" size="sm" onClick={stop} className="shrink-0">
            Stop sharing
          </Button>
        )}
      </div>
      <div
        className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4", share.docType === "board" && "overflow-hidden", ON_SURFACE)}
      >
        {children}
      </div>
    </>
  )
}

/**
 * The call's paper panel: the paper or board shown in the call, at the level it was shown at, and for members the
 * chooser that shows a new or existing one. Loaded only when the panel first opens
 */
export default function PaperPanel({
  title,
  roomName,
  papers,
  focus,
  onFocus,
  guest,
  guestPass,
  hidden,
  onClose,
}: {
  /** The call's name, the title of meeting notes */
  title: string
  roomName: string
  papers: CallPapers
  focus: string | null
  onFocus: (shareId: string | null) => void
  guest: boolean
  /** Null for members, and for a guest whose lobby gave no pass, who then only sees that nothing is shown */
  guestPass: GuestSide | null
  hidden: boolean
  onClose: () => void
}) {
  const { user } = useAuth()
  const me = guest ? null : (user?.id ?? null)
  const participants = useParticipants()
  const [choosing, setChoosing] = useState(false)
  const layouts = useRef(new Map<string, JSONContent[]>())
  const stoppedHere = useRef(new Set<string>())
  const { shares } = papers
  const current = shares.find((share) => share.id === focus) ?? shares[0] ?? null

  const passRef = useRef(guestPass?.pass)
  passRef.current = guestPass?.pass
  const hasPass = !!guestPass
  const tokens = useMemo(
    () => (hasPass ? new GuestDocTokens((shareId) => papersAPI.guestToken(shareId, passRef.current!())) : null),
    [hasPass],
  )

  // Another participant stopped a share this panel knew about
  const seen = useRef(new Map<string, string>())
  useEffect(() => {
    const ids = new Set(shares.map((share) => share.id))
    for (const [id, name] of seen.current) {
      if (!ids.has(id) && !stoppedHere.current.has(id)) toast(`${name} is no longer shown in the call`, { toasterId: CALL_TOASTER })
    }
    seen.current = new Map(shares.map((share) => [share.id, share.name]))
  }, [shares])

  const shown = (share: CallShare, pick: DocPick) => {
    if (pick.kind === "new" && pick.template === "meeting") {
      const people = participants.map((p) => ({ id: p.identity.startsWith("guest-") ? null : p.identity, name: p.name || "Someone" }))
      layouts.current.set(share.id, meetingNotes(title, new Date(), people))
    }
    papers.opened(share)
    onFocus(share.id)
    papers.announce(share.id)
    setChoosing(false)
  }

  const stop = async (share: CallShare) => {
    try {
      await papersAPI.closeCallShare(share.id)
      stoppedHere.current.add(share.id)
      papers.stopped(share.id)
      papers.announce(share.id)
    } catch (err) {
      toast.error(messageOf(err, "Couldn't stop sharing. Try again."), { toasterId: CALL_TOASTER })
    }
  }

  const showChooser = !guest && (choosing || !current)
  const panelTitle = showChooser || !current ? "Paper" : current.name

  const actions =
    !guest && current && !showChooser ? (
      <CallIconButton
        label="Show another paper or board"
        side="bottom"
        onClick={() => setChoosing(true)}
        className="size-8 bg-transparent [&_svg]:size-4"
      >
        <Plus aria-hidden="true" />
      </CallIconButton>
    ) : null

  const switcher = shares.length > 1 && current && !showChooser && (
    <div className="shrink-0 px-4 pb-2">
      <Select value={current.id} onValueChange={(id) => onFocus(id)}>
        <SelectTrigger aria-label="Shown in the call" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {shares.map((share) => (
            <SelectItem key={share.id} value={share.id}>
              {share.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <CallPanel title={panelTitle} onClose={onClose} actions={actions} wide hidden={hidden}>
      {showChooser ? (
        <Chooser roomName={roomName} onShown={shown} onCancel={current ? () => setChoosing(false) : undefined} />
      ) : !current ? (
        <p className="px-4 text-ui text-app-text-muted">Nothing is shown in the call right now.</p>
      ) : (
        <>
          {switcher}
          {guest ? (
            !guestPass || !tokens ? (
              <p className="px-4 text-ui text-app-text-muted">Nothing is shown in the call right now.</p>
            ) : (
              <DocFrame key={current.id} share={current} stop={null}>
                {current.docType === "paper" ? (
                  <Suspense fallback={<DocSkeleton />}>
                    <PaperEditor
                      fileId={current.fileId}
                      level={current.level}
                      guestToken={() => tokens.get(current.id)}
                      guestName={guestPass.name}
                      compact
                      onAccessChange={papers.reload}
                    />
                  </Suspense>
                ) : (
                  <CallBoard
                    fileId={current.fileId}
                    level={current.level}
                    reach={{ guestToken: () => tokens.get(current.id), guestName: guestPass.name }}
                    thumbnail={false}
                    onAccessChange={papers.reload}
                  />
                )}
              </DocFrame>
            )
          ) : (
            <MemberDoc
              key={current.id}
              share={current}
              me={me}
              template={layouts.current.get(current.id)}
              onStop={() => void stop(current)}
              onGone={papers.reload}
            />
          )}
        </>
      )}
    </CallPanel>
  )
}

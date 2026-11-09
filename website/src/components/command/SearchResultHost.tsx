import { createContext, lazy, Suspense, useContext, useMemo, useRef, useState, type ReactNode } from "react"
import type { PreviewFile } from "@/components/files/FilePreviewDialog"
import type { VirtualAnchor } from "@/components/ui/anchored-popover"
import type { AvatarUser } from "@/components/ui/user-avatar"
import { remPx } from "@/lib/utils"

const FilePreviewDialog = lazy(() => import("@/components/files/FilePreviewDialog").then((m) => ({ default: m.FilePreviewDialog })))
const ProfileCard = lazy(() => import("@/components/people/ProfileCard").then((m) => ({ default: m.ProfileCard })))

/** `from` is what had focus before the menu, where focus goes back when the result closes */
type Host = { openFile(file: PreviewFile, from: HTMLElement | null): void; openPerson(person: AvatarUser, from: HTMLElement | null): void }

const HostContext = createContext<Host | null>(null)

const CARD_REM = 20

// Where the menu was, so the card sits in the middle near the top
const centre: VirtualAnchor = {
  getBoundingClientRect: () => {
    const rem = remPx()
    const left = Math.max(0, window.innerWidth / 2 - (CARD_REM * rem) / 2)
    const top = window.innerHeight * 0.15
    return { top, bottom: top, left, right: left }
  },
}

/** The command menu closes as a result opens, so a file preview or a profile card shows from here, outside it */
export function SearchResultHost({ children }: { children: ReactNode }) {
  const [file, setFile] = useState<PreviewFile | null>(null)
  // Loaded on first use, then kept so the preview can ease out as it closes
  const [previewed, setPreviewed] = useState(false)
  const [person, setPerson] = useState<AvatarUser | null>(null)
  const returnTo = useRef<HTMLElement | null>(null)

  const host = useMemo<Host>(
    () => ({
      openFile: (next, from) => {
        returnTo.current = from
        setPreviewed(true)
        setFile(next)
      },
      openPerson: (next, from) => {
        returnTo.current = from
        setPerson(next)
      },
    }),
    [],
  )
  const back = () => {
    if (returnTo.current?.isConnected) returnTo.current.focus()
  }

  return (
    <HostContext.Provider value={host}>
      {children}
      <Suspense fallback={null}>
        {previewed && (
          <FilePreviewDialog
            file={file}
            onClose={() => {
              setFile(null)
              requestAnimationFrame(back)
            }}
          />
        )}
        {person && <ProfileCard userId={person.id} user={person} anchor={centre} onClose={() => setPerson(null)} returnFocus={back} />}
      </Suspense>
    </HostContext.Provider>
  )
}

export function useSearchResultHost(): Host {
  const host = useContext(HostContext)
  if (!host) throw new Error("useSearchResultHost must be used within a SearchResultHost")
  return host
}

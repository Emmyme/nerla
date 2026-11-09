import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { AiAvatar } from "@/components/ai/AiAvatar"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { CatInFolder, CatSearching } from "@/components/ui/cat-scenes"
import { PresenceCat } from "@/components/ui/presence-cat"
import { useAiTeammate } from "@/lib/aiStore"
import { closeWelcome, loadOnboarding, useOnboarding } from "@/lib/onboarding"
import { chordCaps } from "@/lib/shortcuts"
import { useIsDesktop } from "@/lib/useMediaQuery"

type Card = { title: string; body: string; art: ReactNode }

function cardsFor(aiName: string | null, desktop: boolean): Card[] {
  const cards: Card[] = [
    {
      title: "Find and make anything",
      body: desktop
        ? `Press ${chordCaps("Mod+k")} to jump to any task, file, person or page. Press C to create what fits the page you are on, such as a task or an event. Press ? to see every shortcut.`
        : "Tap More, then Search, to jump to any task, file, person or page. The + button on Home, Calendar, Files and projects creates what fits the page, such as a task or an event.",
      art: <CatSearching />,
    },
    {
      title: "Projects keep work together",
      body: `A project holds its tasks, papers, boards and files. Make one ${desktop ? "with the + next to Projects in the sidebar" : "from the Projects tab"}. Only the people in a project can see what is inside it.`,
      art: <CatInFolder />,
    },
    {
      title: "Chat, call and set your status",
      body: `Write to one teammate or a group in Chat, and use the call button at the top of a chat to start a call. ${desktop ? "Click your name at the bottom left" : "Tap More"} to set your status, so others know when you are busy.`,
      art: (
        <span className="flex items-end gap-3">
          <PresenceCat state="available" className="size-12" />
          <PresenceCat state="secret" className="size-14" />
          <PresenceCat state="ooo" className="size-12" />
        </span>
      ),
    },
  ]
  if (aiName) {
    cards.push({
      title: `Ask ${aiName}`,
      body: `Write to ${aiName} in Chat, or type @${aiName} in a group chat or a comment on a task or paper to ask it right there. Before it changes anything others can see, it shows you the change and waits for your Allow.`,
      art: <AiAvatar size={5} />,
    })
  }
  return cards
}

/** The welcome cards, shown once on the user's first sign-in and again from the sidebar or the command menu */
export function WelcomeDialog() {
  const { welcomeOpen } = useOnboarding()
  const teammate = useAiTeammate()
  const cards = cardsFor(teammate?.available ? teammate.name : null, useIsDesktop())
  const [index, setIndex] = useState(0)
  const next = useRef<HTMLButtonElement>(null)

  useEffect(() => void loadOnboarding(), [])
  useEffect(() => {
    if (welcomeOpen) setIndex(0)
  }, [welcomeOpen])

  const at = Math.min(index, cards.length - 1)
  const card = cards[at]
  const last = at === cards.length - 1
  const forward = () => (last ? closeWelcome() : setIndex(at + 1))
  const back = () => {
    if (at === 0) return
    setIndex(at - 1)
    // Back leaves on the first card, so focus stays on the dialog's main button
    if (at === 1) next.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowRight" && !last) setIndex(at + 1)
    else if (event.key === "ArrowLeft") back()
  }

  return (
    <BaseModal isOpen={welcomeOpen} onClose={closeWelcome} title="Welcome tour" showHeader={false} initialFocus={() => next.current}>
      <div onKeyDown={onKeyDown}>
        <div className="flex flex-col items-center gap-5 px-6 pt-8 pb-6 text-center [--row-fill:var(--color-card)]">
          <div className="flex h-28 items-end justify-center">{card.art}</div>
          <div aria-live="polite" className="flex flex-col gap-2">
            <h2 className="text-title font-semibold text-foreground">{card.title}</h2>
            <p className="text-body text-muted-foreground">{card.body}</p>
          </div>
          <p className="text-caption text-muted-foreground tabular-nums">
            {at + 1} of {cards.length}
          </p>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-6 py-4">
          {!last && (
            <Button type="button" variant="ghost" onClick={closeWelcome}>
              Skip
            </Button>
          )}
          <span className="flex-1" />
          {at > 0 && (
            <Button type="button" variant="outline" onClick={back}>
              Back
            </Button>
          )}
          <Button ref={next} type="button" onClick={forward}>
            {last ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </BaseModal>
  )
}

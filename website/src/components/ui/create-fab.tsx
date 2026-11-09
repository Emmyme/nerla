import { forwardRef, type ButtonHTMLAttributes } from "react"
import { Plus } from "@/components/icons"
import { Button } from "./button"

type CreateFabProps = { label: string; shortcut?: string; onClick: () => void } & Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-haspopup" | "aria-expanded"
>

/** The phone's one Create button, floating above the tab bar. Desktop pages keep theirs in the header. */
export const CreateFab = forwardRef<HTMLButtonElement, CreateFabProps>(function CreateFab({ label, shortcut, onClick, ...aria }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      size="icon"
      aria-label={label}
      aria-keyshortcuts={shortcut}
      onClick={onClick}
      {...aria}
      className="fixed right-4 bottom-above-tabbar z-30 size-11 rounded-full shadow-[var(--shadow-popover)]"
    >
      <Plus aria-hidden="true" weight="bold" className="size-[1.1rem]" />
    </Button>
  )
})

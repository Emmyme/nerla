import { useCallback, useEffect, useId, useRef, useState } from "react"
import BaseModal from "@/components/ui/BaseModal"
import { Button } from "@/components/ui/button"
import { RadioList } from "@/components/ui/radio-list"
import type { RecurrenceScope } from "@/lib/api/calendar"

type ScopeAction = "edit" | "delete"
type ScopeRequest = (action: ScopeAction, options?: { allowThis?: boolean }) => Promise<RecurrenceScope | null>

const OPTIONS: { value: RecurrenceScope; label: string }[] = [
  { value: "this", label: "This event" },
  { value: "following", label: "This and following events" },
  { value: "all", label: "All events" },
]

const TITLE: Record<ScopeAction, string> = { edit: "Edit recurring event", delete: "Delete recurring event" }

type Ask = { action: ScopeAction; allowThis: boolean; resolve: (scope: RecurrenceScope | null) => void }

/**
 * Asks which occurrences a change is for, as Google does. The request resolves with the scope, or
 * null when the dialog is cancelled. "This event" is left out when the change is to the rule itself,
 * which the server only takes for a whole series or its rest.
 */
export function useRecurrenceScope(fallbackFocus?: () => HTMLElement | null): [ScopeRequest, JSX.Element] {
  const [ask, setAsk] = useState<Ask | null>(null)
  const askRef = useRef<Ask | null>(null)
  askRef.current = ask

  const request = useCallback<ScopeRequest>(
    (action, options) =>
      new Promise((resolve) => {
        askRef.current?.resolve(null)
        setAsk({ action, allowThis: options?.allowThis ?? true, resolve })
      }),
    [],
  )

  useEffect(() => () => askRef.current?.resolve(null), [])

  const finish = (scope: RecurrenceScope | null) => {
    ask?.resolve(scope)
    setAsk(null)
  }

  const dialog = <RecurrenceScopeDialog ask={ask} onDone={finish} fallbackFocus={fallbackFocus} />
  return [request, dialog]
}

function RecurrenceScopeDialog({
  ask,
  onDone,
  fallbackFocus,
}: {
  ask: Ask | null
  onDone: (scope: RecurrenceScope | null) => void
  fallbackFocus?: () => HTMLElement | null
}) {
  const options = OPTIONS.filter((option) => option.value !== "this" || ask?.allowThis !== false)
  const [choice, setChoice] = useState<RecurrenceScope>(options[0].value)
  const [shown, setShown] = useState(ask)
  if (ask !== shown) {
    setShown(ask)
    setChoice(options[0].value)
  }
  const name = useId()
  const action = ask?.action ?? "edit"

  return (
    <BaseModal
      isOpen={!!ask}
      onClose={() => onDone(null)}
      title={TITLE[action]}
      maxWidth="sm"
      showCloseButton={false}
      fallbackFocus={fallbackFocus}
    >
      <form
        className="flex flex-col gap-5 p-6"
        onSubmit={(event) => {
          event.preventDefault()
          onDone(choice)
        }}
      >
        <fieldset>
          <legend className="sr-only">{TITLE[action]}</legend>
          <RadioList name={name} value={choice} options={options} onChange={setChoice} />
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button type="submit" variant={action === "delete" ? "destructive" : "default"}>
            {action === "delete" ? "Delete" : "Save"}
          </Button>
        </div>
      </form>
    </BaseModal>
  )
}

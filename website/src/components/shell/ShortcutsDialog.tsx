import { useEffect, useId, useRef, useState } from "react"
import BaseModal from "@/components/ui/BaseModal"
import { ShortcutKeys } from "@/components/ui/shortcut-keys"
import { keysOn, SHORTCUT_GROUPS, SHORTCUTS, spokenKeys } from "@/lib/shortcuts"
import { closeShortcuts, useShortcutsDialog } from "@/lib/shortcutsDialog"
import { useTimeTracking } from "@/lib/timeStore"

/** Every shortcut in Nerla, grouped by where it works, opened with ? or from the sidebar. Opened at a group, it shows that group alone */
export function ShortcutsDialog() {
  const { open, section } = useShortcutsDialog()
  const { enabled: timeOn } = useTimeTracking()
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement>(null)
  const ids = useId()

  useEffect(() => {
    if (open) setQuery("")
  }, [open])

  const q = query.trim().toLowerCase()
  const first = SHORTCUT_GROUPS.find((group) => group.scope === section)
  const groups = (first ? [first] : SHORTCUT_GROUPS)
    .map((group) => ({
      ...group,
      items: SHORTCUTS.filter(
        (entry) =>
          entry.scope === group.scope &&
          (timeOn || entry.path !== "/time") &&
          (!q || `${group.title} ${entry.label} ${spokenKeys(keysOn(entry))}`.toLowerCase().includes(q)),
      ),
    }))
    .filter((group) => group.items.length > 0)
  const count = groups.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <BaseModal
      isOpen={open}
      onClose={closeShortcuts}
      title={first ? `Keyboard shortcuts for ${first.title.toLowerCase()}` : "Keyboard shortcuts"}
      maxWidth="xl"
      initialFocus={() => search.current}
    >
      <div className="sticky top-0 z-10 bg-card px-6 pt-4 pb-2">
        <input
          ref={search}
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-label="Search shortcuts"
          placeholder="Search shortcuts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 w-full rounded-md bg-app-sunk px-2.5 text-ui text-foreground placeholder:text-muted-foreground focus-visible:ring-[0.125rem] focus-visible:ring-ring focus-visible:outline-none"
        />
        <p role="status" className="sr-only">
          {count === 1 ? "1 shortcut" : `${count} shortcuts`}
        </p>
      </div>
      <div className="flex flex-col gap-6 px-6 pt-2 pb-6">
        {groups.map((group) => (
          <section key={group.scope} aria-labelledby={`${ids}-${group.scope}`} className="flex flex-col gap-1">
            <h3 id={`${ids}-${group.scope}`} className="text-ui font-semibold text-foreground">
              {group.title}
            </h3>
            {group.note && <p className="text-caption leading-[1.45] text-muted-foreground">{group.note}</p>}
            <ul className="mt-1 flex flex-col divide-y divide-border">
              {group.items.map((entry) => (
                <li key={entry.id} className="flex min-h-[2.25rem] items-center justify-between gap-4 py-1.5">
                  <span className="min-w-0 text-ui text-foreground">{entry.label}</span>
                  <ShortcutKeys keys={keysOn(entry)} className="shrink-0 justify-end" />
                </li>
              ))}
            </ul>
          </section>
        ))}
        {count === 0 && <p className="py-6 text-center text-ui text-muted-foreground">No shortcuts match “{query.trim()}”</p>}
      </div>
    </BaseModal>
  )
}

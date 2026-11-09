import { useId, type ReactNode } from "react"
import { useLocation } from "react-router"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { sectionAt } from "./settingsSections"

/** One titled part of a settings page. Sections stack with a hairline between them. */
export function SettingsSection({
  title,
  description,
  children,
  footer,
  meta,
  action,
}: {
  title: string
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** A short muted note after the title, such as a count */
  meta?: ReactNode
  /** A control at the end of the title row */
  action?: ReactNode
}) {
  const id = useId()
  // On a phone the page header above already names the section, so a title repeating it stays for screen readers only
  const repeatsPage = sectionAt(useLocation().pathname)?.label === title
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 border-t-[0.0625rem] border-border py-6 first:border-t-0 first:pt-0">
      <div className={cn("flex gap-3", description ? "items-start" : "items-center")}>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <h2 id={id} className={cn("text-lead font-semibold text-foreground", repeatsPage && "max-lg:sr-only")}>
              {title}
            </h2>
            {meta != null && <span className="text-caption text-muted-foreground tabular-nums">{meta}</span>}
          </div>
          {description && <p className="text-ui leading-[1.5] text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {children}
      {footer && <div className="flex flex-wrap items-center gap-2">{footer}</div>}
    </section>
  )
}

/** Save and Cancel for a page's unsaved changes, kept in view at the bottom of the settings column while the form is dirty */
export function SaveBar({ saving, onSave, onCancel }: { saving: boolean; onSave: () => void; onCancel: () => void }) {
  const id = useId()
  return (
    <div
      role="region"
      aria-labelledby={id}
      className="sticky bottom-flush z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-t-[0.0625rem] border-border bg-background py-3"
    >
      <div className="flex items-center gap-2">
        <Button type="button" aria-disabled={saving || undefined} aria-busy={saving || undefined} onClick={() => !saving && onSave()}>
          {saving ? "Saving" : "Save"}
        </Button>
        <Button type="button" variant="ghost" aria-disabled={saving || undefined} onClick={() => !saving && onCancel()}>
          Cancel
        </Button>
      </div>
      <p id={id} className="text-ui text-muted-foreground">
        Unsaved changes
      </p>
    </div>
  )
}

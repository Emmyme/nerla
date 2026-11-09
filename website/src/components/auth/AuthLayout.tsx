import type { ReactNode } from "react"
import catLogo from "@/assets/cat-logo.png"

/** The page every sign-in and setup screen sits on: the mark, one panel, and an optional line below it */
export function AuthLayout({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="flex min-h-window flex-col items-center justify-start gap-6 bg-app-bg px-4 pt-auth pb-10">
      <div className="flex items-center gap-2.5">
        <img src={catLogo} alt="" className="h-10 w-auto" />
      </div>
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 max-sm:p-6">{children}</div>
      {footer && <div className="w-full max-w-sm text-center text-caption text-muted-foreground">{footer}</div>}
    </main>
  )
}

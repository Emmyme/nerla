import type { ReactNode } from "react"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"

/** The big berry 404 for anything that isn't there, with a context line, an optional note and the way home */
export function NotFoundView({
  title = "This page wandered off",
  text,
  heading: Heading = "h1",
  children,
}: {
  title?: string
  text?: string
  heading?: "h1" | "h2"
  /** Actions shown before Home */
  children?: ReactNode
}) {
  return (
    <div className="mx-auto flex max-w-[24rem] flex-col items-center gap-2 px-4 py-20 text-center">
      <p aria-hidden="true" className="mb-2 text-[6rem] leading-none font-extrabold tracking-[-0.04em] text-app-berry">
        404
      </p>
      <Heading className="text-title font-semibold tracking-[-0.01em] text-foreground">{title}</Heading>
      {text && <p className="text-body text-muted-foreground">{text}</p>}
      <div className="mt-2.5 flex flex-wrap justify-center gap-2">
        {children}
        <Button asChild variant="outline" size="sm">
          <Link to="/">Home</Link>
        </Button>
      </div>
    </div>
  )
}

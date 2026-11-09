import { useEffect } from "react"

/** Sets the window title to the given parts, most specific first, ending in Nerla */
export function useDocumentTitle(...parts: (string | null | undefined)[]) {
  const title = [...parts.filter(Boolean), "Nerla"].join(" · ")
  useEffect(() => {
    document.title = title
  }, [title])
}

import { useEffect, useState } from "react"

const COPIED_MS = 2000

/** A flag for a copy button's "Copied" state, which turns itself off after two seconds */
export function useCopied(): [copied: boolean, markCopied: () => void] {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  return [copied, () => setCopied(true)]
}

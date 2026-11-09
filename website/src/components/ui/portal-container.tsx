import { createContext, useContext } from "react"

/** Where tooltips and menus portal to, so a themed subtree such as the dark call stage keeps its tokens */
export const PortalContainer = createContext<HTMLElement | null>(null)

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainer) ?? undefined
}

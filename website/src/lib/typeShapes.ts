import { useAccessibility } from "./accessibility"

/** Calendar event types show a small shape beside their color. Saved on the account with the other accessibility choices */
export function useTypeShapes(): boolean {
  return useAccessibility().typeShapes
}

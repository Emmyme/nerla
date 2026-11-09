type MinimizeAction = "mini" | "minimize" | "none"

/**
 * What a minimize does in a call window. A desktop meeting window in a call goes to the corner instead,
 * the corner window minimizes for real, and the web has no window to minimize.
 */
export function minimizeAction({ inCall, mini, tauri }: { inCall: boolean; mini: boolean; tauri: boolean }): MinimizeAction {
  if (!tauri) return "none"
  return inCall && !mini ? "mini" : "minimize"
}

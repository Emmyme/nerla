let handed: HTMLElement | null = null

/**
 * Runs a menu entry that may open a dialog. The entry goes away with its menu in the same render the dialog
 * opens in, so the dialog is told to hand focus back to the menu's button instead
 */
export function runFromMenu(button: HTMLElement | null, run: () => void) {
  handed = button
  try {
    run()
  } finally {
    window.setTimeout(() => {
      if (handed === button) handed = null
    })
  }
}

/** The menu button a dialog opening right now should return focus to, if a menu entry opened it */
export function takeMenuOpener(): HTMLElement | null {
  const button = handed
  handed = null
  return button?.isConnected ? button : null
}

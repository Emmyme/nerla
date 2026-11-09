import React, { createContext, useContext, useEffect, useMemo, useState } from "react"
import { useMediaQuery } from "@/lib/useMediaQuery"

export type ThemeModePreference = "system" | "light" | "dark"

const THEME_NAME = "nerla"
const STORAGE_MODE = "nerla-mode"

type DarkModeContextType = {
  themeMode: ThemeModePreference
  resolvedMode: "light" | "dark"
  setThemeMode: (mode: ThemeModePreference) => void
}

const DarkModeContext = createContext<DarkModeContextType | undefined>(undefined)

function readStoredMode(): ThemeModePreference {
  try {
    const v = localStorage.getItem(STORAGE_MODE)
    if (v === "system" || v === "light" || v === "dark") return v
  } catch {
    // Storage blocked, so the system mode applies
  }
  return "system"
}

function applyDocumentTheme(resolved: "light" | "dark") {
  const html = document.documentElement
  html.setAttribute("data-theme", THEME_NAME)
  html.setAttribute("data-mode", resolved)
  html.classList.toggle("dark", resolved === "dark")
}

export function useDarkMode() {
  const context = useContext(DarkModeContext)
  if (context === undefined) {
    throw new Error("useDarkMode must be used within a DarkModeProvider")
  }
  return context
}

export function DarkModeProvider({ children }: { children: React.ReactNode }) {
  const [themeMode, setThemeMode] = useState<ThemeModePreference>(readStoredMode)
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)", false)
  const resolvedMode = themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode

  useEffect(() => {
    applyDocumentTheme(resolvedMode)
    try {
      localStorage.setItem(STORAGE_MODE, themeMode)
    } catch {
      // Storage blocked, so the choice lasts for this visit only
    }
  }, [resolvedMode, themeMode])

  const value = useMemo(() => ({ themeMode, resolvedMode, setThemeMode }), [themeMode, resolvedMode])

  return <DarkModeContext.Provider value={value}>{children}</DarkModeContext.Provider>
}

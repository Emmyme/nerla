import React from "react"
import ReactDOM from "react-dom/client"
import { RouterProvider } from "react-router"
import { router } from "@/router"
import "@/fonts"
import "@/app/globals.css"
import { startAccessibility } from "@/lib/accessibility"
import { inCall } from "@/lib/socket"
import { isTauri } from "@tauri-apps/api/core"

startAccessibility()
if (isTauri()) void import("@/lib/desktopUpdate").then((m) => m.startDesktopUpdateCheck())

// After an update renames the code files, a page opened before it loads the new ones by reloading once
window.addEventListener("vite:preloadError", (event) => {
  if (inCall()) return
  try {
    if (sessionStorage.getItem("nerla-reloaded-for-update")) return
    sessionStorage.setItem("nerla-reloaded-for-update", "1")
  } catch {
    return
  }
  event.preventDefault()
  location.reload()
})
window.addEventListener("load", () => {
  try {
    setTimeout(() => sessionStorage.removeItem("nerla-reloaded-for-update"), 10_000)
  } catch {
    // Storage blocked, so the guard above never set the flag
  }
})

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)

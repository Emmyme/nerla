import { Outlet } from "react-router"
import { isTauri } from "@tauri-apps/api/core"
import Providers from "@/components/Providers"
import Titlebar from "@/components/Titlebar"

// Every offset that clears the desktop title bar reads this, and it stays 0rem on web
if (typeof document !== "undefined" && isTauri()) document.documentElement.style.setProperty("--titlebar-h", "2rem")

export default function App() {
  return (
    <Providers>
      <Titlebar />
      <Outlet />
    </Providers>
  )
}

import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { Outlet, useLocation, useNavigate } from "react-router"
import { isTauri } from "@tauri-apps/api/core"
import RequireAuth from "./RequireAuth"
import Sidebar from "./Sidebar"
import { TabBar } from "./TabBar"
import { tabBarHidden } from "./tabs"
import { DockedChat } from "@/components/chat/DockedChat"
import { CommandMenuProvider, useRegisterCommands } from "@/components/command/registry"
import CommandMenu from "@/components/command/CommandMenu"
import { ReminderScheduler } from "@/components/calendar/ReminderScheduler"
import type { NewChatMode } from "@/components/chat/NewChatDialog"
import { openChat } from "@/lib/chatDock"
import { meetNow, NEW_MEETING_PATH } from "@/lib/meetNow"
import { useAuth } from "@/providers/AuthProvider"
import { TitleStrip, useShellTitlebar } from "@/components/Titlebar"
import { WindowControls } from "./WindowControls"
import { NotificationBell } from "@/components/notifications/NotificationBell"
import { startTimeTracking, stopTimer, useTimeTracking } from "@/lib/timeStore"
import { useShellKeys } from "@/lib/useShellKeys"
import { shortcutCaps } from "@/lib/shortcuts"
import { ShortcutsDialog } from "./ShortcutsDialog"
import { WelcomeDialog } from "@/components/onboarding/WelcomeDialog"

const NewChatDialog = lazy(() => import("@/components/chat/NewChatDialog").then((m) => ({ default: m.NewChatDialog })))

export default function AppShell() {
  return (
    <RequireAuth>
      <CommandMenuProvider>
        <ShellLayout />
        <CommandMenu />
      </CommandMenuProvider>
    </RequireAuth>
  )
}

// Meeting commands work from every page in the shell. N only works on the calendar, so only there does it show
function useMeetingCommands(pathname: string) {
  const navigate = useNavigate()
  const shortcut = pathname === "/calendar" ? "N" : undefined
  useRegisterCommands([
    {
      id: "meeting-new",
      title: "New meeting",
      group: "Actions",
      shortcut,
      keywords: ["meeting", "video", "call", "invite", "schedule"],
      run: () => navigate(NEW_MEETING_PATH),
    },
    {
      id: "meeting-now",
      title: "Meet now",
      group: "Actions",
      keywords: ["meeting", "call", "video", "instant"],
      run: () => void meetNow(),
    },
  ])
}

// Go to Time while time tracking is on, and Stop timer while one runs
function useTimeCommands() {
  const navigate = useNavigate()
  const { enabled, timer } = useTimeTracking()
  useEffect(() => startTimeTracking(), [])
  useRegisterCommands([
    ...(enabled
      ? [
          {
            id: "nav-time",
            title: "Go to Time",
            group: "Navigate" as const,
            shortcut: shortcutCaps("goto.t"),
            keywords: ["time", "hours", "timesheet", "report"],
            run: () => navigate("/time"),
          },
        ]
      : []),
    ...(timer
      ? [{ id: "time-stop", title: "Stop timer", group: "Actions" as const, keywords: ["time", "clock"], run: () => void stopTimer() }]
      : []),
  ])
}

// Start chat and New group from any page. The chat opens in the dock when it is in view, otherwise on the Chat page
function ChatCommands() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [mode, setMode] = useState<NewChatMode | null>(null)
  useRegisterCommands([
    {
      id: "chat-start",
      title: "Start chat",
      group: "Actions",
      keywords: ["message", "direct", "dm", "person", "people"],
      run: () => setMode("dm"),
    },
    { id: "chat-group", title: "New group", group: "Actions", keywords: ["chat", "group", "message", "team"], run: () => setMode("group") },
  ])
  if (!mode) return null
  return (
    <Suspense fallback={null}>
      <NewChatDialog open mode={mode} me={user?.id ?? ""} onClose={() => setMode(null)} onOpenChat={(chat) => openChat(chat, navigate)} />
    </Suspense>
  )
}

function ShellLayout() {
  const { pathname, search } = useLocation()
  useMeetingCommands(pathname)
  useTimeCommands()
  useShellTitlebar()
  const navigate = useNavigate()
  const { enabled: timeOn } = useTimeTracking()
  useShellKeys(navigate, (path) => path !== "/time" || timeOn)
  const tauri = isTauri()
  const main = useRef<HTMLElement>(null)
  // The docked chat's bar sits in the bottom right corner on desktop, except on the Chat page
  const chatBar = pathname !== "/messages"
  const tabBar = !tabBarHidden(pathname, search)

  return (
    <div className="flex h-dvh bg-background">
      <a
        href="#main"
        onClick={(event) => {
          // The desktop build routes on the hash, so the link moves focus itself
          event.preventDefault()
          main.current?.focus()
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-below-titlebar focus:left-4 focus:z-60 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-ui focus:font-medium focus:text-foreground focus:shadow-[var(--shadow-popover)] focus:ring-[0.125rem] focus:ring-ring focus:outline-none"
      >
        Skip to content
      </a>
      <aside aria-label="Sidebar" data-region="sidebar" className="hidden h-full lg:block">
        <Sidebar />
      </aside>

      <div className={`relative flex flex-1 flex-col overflow-hidden ${tabBar ? "max-lg:pb-tabbar" : ""}`}>
        {tauri ? (
          <TitleStrip>
            <NotificationBell />
            <WindowControls />
          </TitleStrip>
        ) : (
          <NotificationBell />
        )}
        {/* A page marked data-full-bleed fills main on desktop and reads --chat-space to stay clear of the chat bar. data-phone-bleed fills it on phones too. */}
        <main
          ref={main}
          id="main"
          data-region="main"
          tabIndex={-1}
          className={`relative flex-1 overflow-auto p-4 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring has-[[data-phone-bleed]]:p-0 lg:p-6 lg:has-[[data-full-bleed]]:p-0 ${chatBar ? "[--chat-space:5rem] lg:pb-20" : ""}`}
        >
          <Outlet />
        </main>
      </div>

      {tabBar && <TabBar />}

      <ReminderScheduler />
      <ChatCommands />
      <ShortcutsDialog />
      <WelcomeDialog />

      <DockedChat boundsRef={main} />
    </div>
  )
}

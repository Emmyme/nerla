import { lazy, Suspense, type ReactNode } from "react"
import { createBrowserRouter, createHashRouter } from "react-router"
import { isTauri } from "@tauri-apps/api/core"
import App from "@/App"
import RequireAuth from "@/components/shell/RequireAuth"
import AppShell from "@/components/shell/AppShell"
import Home from "@/app/page"
import Calendar from "@/app/calendar/page"
import Files from "@/app/files/page"
import Messages from "@/app/messages/page"
import NotFound from "@/app/not-found"
import Project from "@/app/project/[slug]/page"
import Projects from "@/app/projects/page"
import PublicLink from "@/app/s/[token]/page"
import SettingsLayout from "@/app/settings/layout"
import SignIn from "@/app/sign-in/page"
import Time from "@/app/time/page"
import Trash from "@/app/trash/page"
import AccessibilitySettings from "@/components/settings/AccessibilitySettings"
import AiSettings from "@/components/settings/AiSettings"
import ProfileSettings from "@/components/settings/ProfileSettings"
import MembersSettings from "@/components/settings/MembersSettings"
import NotificationSettings from "@/components/settings/NotificationSettings"
import SetupCheck from "@/components/settings/SetupCheck"
import SharingSettings from "@/components/settings/SharingSettings"
import WorkspaceAiSettings from "@/components/settings/WorkspaceAiSettings"
import WorkspaceSettings from "@/components/settings/WorkspaceSettings"
import { Skeleton } from "@/components/ui/skeleton"

// The editors and the call code load only when a paper, board or call opens, so the rest of the app stays light
const PaperPage = lazy(() => import("@/app/paper/[id]/page"))
const BoardPage = lazy(() => import("@/app/board/[id]/page"))
const Join = lazy(() => import("@/app/join/[roomId]/page"))
const MeetingRoom = lazy(() => import("@/app/meeting-room/[roomId]/page"))

/** What a paper, board or call page looks like while its code loads */
function DocPageSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[48rem] flex-col gap-3 px-4 pt-6 pb-10 max-lg:pt-4">
      <span role="status" className="sr-only">
        Opening
      </span>
      <Skeleton className="h-[2rem] w-[16rem]" />
      <div aria-hidden="true" className="flex flex-col gap-3 pt-4">
        <Skeleton className="h-[1rem] w-[70%]" />
        <Skeleton className="h-[1rem] w-[85%]" />
        <Skeleton className="h-[1rem] w-[55%]" />
      </div>
    </div>
  )
}

const Lazy = ({ children }: { children: ReactNode }) => <Suspense fallback={<DocPageSkeleton />}>{children}</Suspense>

// Web uses clean URLs with index.html as the proxy's fallback. The desktop app routes on the hash, so its bundled
// asset server needs no deep-link fallback
const create = isTauri() ? createHashRouter : createBrowserRouter

export const router = create([
  {
    element: <App />,
    children: [
      {
        path: "/join/:roomId",
        element: (
          <Lazy>
            <Join />
          </Lazy>
        ),
      },
      { path: "/s/:token", element: <PublicLink /> },
      { path: "/sign-in", element: <SignIn /> },
      {
        path: "/meeting-room/:roomId",
        element: (
          <RequireAuth>
            <Lazy>
              <MeetingRoom />
            </Lazy>
          </RequireAuth>
        ),
      },
      {
        element: <AppShell />,
        children: [
          { path: "/", element: <Home /> },
          { path: "/calendar", element: <Calendar /> },
          {
            // One layout for every section, so the usage, sort and filters stay put while moving between them
            path: "/files",
            element: <Files />,
            children: [
              { index: true, element: null },
              { path: "shared", element: null },
              { path: "recent", element: null },
              { path: "folder/:id", element: null },
            ],
          },
          { path: "/trash", element: <Trash /> },
          {
            path: "/paper/:id",
            element: (
              <Lazy>
                <PaperPage />
              </Lazy>
            ),
          },
          {
            path: "/board/:id",
            element: (
              <Lazy>
                <BoardPage />
              </Lazy>
            ),
          },
          { path: "/messages", element: <Messages /> },
          { path: "/project/:slug", element: <Project /> },
          { path: "/projects", element: <Projects /> },
          {
            // The week and the reports share one page, so the header and the tabs stay put between them
            path: "/time",
            element: <Time />,
            children: [
              { index: true, element: null },
              { path: "reports", element: null },
            ],
          },
          {
            path: "/settings",
            element: <SettingsLayout />,
            children: [
              { index: true, element: null },
              { path: "profile", element: <ProfileSettings /> },
              { path: "notifications", element: <NotificationSettings /> },
              { path: "calendar", element: <SharingSettings /> },
              { path: "accessibility", element: <AccessibilitySettings /> },
              { path: "ai", element: <AiSettings /> },
              { path: "workspace-ai", element: <WorkspaceAiSettings /> },
              { path: "workspace", element: <WorkspaceSettings /> },
              { path: "members", element: <MembersSettings /> },
              { path: "setup-check", element: <SetupCheck /> },
              // Keeps unknown paths inside the layout, which sends them to the right place for the screen size
              { path: "*", element: null },
            ],
          },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
])

type SettingsSection =
  "profile" | "notifications" | "calendar" | "accessibility" | "ai" | "workspace-ai" | "workspace" | "members" | "setup-check"

type SettingsSectionLink = { id: SettingsSection; label: string; path: string }

type SectionEntry = SettingsSectionLink & { admin: boolean; ai?: boolean }

// Workspace AI comes before Workspace, so a path match finds it first
const SECTIONS: SectionEntry[] = [
  { id: "profile", label: "Profile", path: "/settings/profile", admin: false },
  { id: "notifications", label: "Notifications", path: "/settings/notifications", admin: false },
  { id: "calendar", label: "Calendar sharing", path: "/settings/calendar", admin: false },
  { id: "accessibility", label: "Accessibility", path: "/settings/accessibility", admin: false },
  { id: "ai", label: "AI and agents", path: "/settings/ai", admin: false, ai: true },
  { id: "workspace-ai", label: "Workspace AI", path: "/settings/workspace-ai", admin: true },
  { id: "workspace", label: "Workspace", path: "/settings/workspace", admin: true },
  { id: "members", label: "Members", path: "/settings/members", admin: true },
  { id: "setup-check", label: "Setup check", path: "/settings/setup-check", admin: true },
]

/** `aiVisible` is true while the workspace has the AI teammate or MCP access on */
export function settingsSections({ isAdmin, aiVisible }: { isAdmin: boolean; aiVisible: boolean }): SettingsSectionLink[] {
  return SECTIONS.filter((section) => (isAdmin || !section.admin) && (aiVisible || !section.ai)).map(({ id, label, path }) => ({
    id,
    label,
    path,
  }))
}

/** The section a path opens, including the admin ones, so a member's direct visit can be sent back */
export function sectionAt(pathname: string): SectionEntry | null {
  return SECTIONS.find((section) => pathname === section.path || pathname.startsWith(`${section.path}/`)) ?? null
}

/** Where a member who opened an admin section goes, once the membership is known */
export function adminRedirect(pathname: string, isAdmin: boolean, loading: boolean): string | null {
  return !loading && !isAdmin && sectionAt(pathname)?.admin ? "/settings/profile" : null
}

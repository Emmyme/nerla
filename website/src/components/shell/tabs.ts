export type Tab = "home" | "chat" | "calendar" | "projects" | "more"

const under = (pathname: string, route: string) => pathname === route || pathname.startsWith(`${route}/`)

export function activeTab(pathname: string): Tab | null {
  if (pathname === "/") return "home"
  if (pathname === "/messages") return "chat"
  if (under(pathname, "/calendar")) return "calendar"
  if (pathname === "/projects" || pathname.startsWith("/project/")) return "projects"
  if (under(pathname, "/settings") || under(pathname, "/files") || under(pathname, "/time")) return "more"
  return null
}

/** A phone conversation is its own screen with a way back, so it has no tab bar */
export function tabBarHidden(pathname: string, search: string): boolean {
  return pathname === "/messages" && /[?&](dm|group)=/.test(search)
}

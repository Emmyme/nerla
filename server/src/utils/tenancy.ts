export type OrgRole = "admin" | "member"
export type OrgContext = { organizationId: string; role: OrgRole }
export type OrgRefusal = { status: 403; error: "no-organization" } | { status: 409; error: "multiple-organizations" }

export const refusalMessages: Record<OrgRefusal["error"], string> = {
  "no-organization": "Not a member of an organization",
  "multiple-organizations": "This account belongs to more than one workspace",
}

export const isRefusal = (result: OrgContext | OrgRefusal): result is OrgRefusal => "status" in result

/**
 * Accounts are per workspace, so a second organization is refused rather than guessed between. Duplicate rows of
 * one organization count once, and admin only when every row says so.
 */
export function pickOrg(memberships: { organizationId: string; role: string }[]): OrgContext | OrgRefusal {
  const orgs = new Set(memberships.map((membership) => membership.organizationId))
  if (orgs.size === 0) return { status: 403, error: "no-organization" }
  if (orgs.size > 1) return { status: 409, error: "multiple-organizations" }
  const admin = memberships.every((membership) => membership.role === "admin")
  return { organizationId: memberships[0].organizationId, role: admin ? "admin" : "member" }
}

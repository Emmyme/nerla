import type { ItemRef } from "../../utils/aiTypes"
import { isRefusal, type OrgContext, type OrgRefusal } from "../../utils/tenancy"
import { canRead } from "../aiReach"
import { resolveOrgs } from "../tenancy"

/** `canRead` for each member of the place, with their own admin rights, asked once per user and item */
export function placeReader(organizationId: string, audience: string[]) {
  let orgs: Promise<Map<string, OrgContext | OrgRefusal>> | null = null
  const asked = new Map<string, Promise<boolean>>()
  const read = async (userId: string, ref: ItemRef) => {
    const org = (await (orgs ??= resolveOrgs(audience))).get(userId)
    if (!org || isRefusal(org) || org.organizationId !== organizationId) return false
    return canRead({ userId, organizationId, isOrgAdmin: org.role === "admin" }, ref)
  }
  return (userId: string, ref: ItemRef) => {
    const key = `${userId}:${ref.kind}:${ref.id}`
    if (!asked.has(key)) asked.set(key, read(userId, ref))
    return asked.get(key)!
  }
}

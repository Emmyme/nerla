import { createContext, useContext } from "react"
import type { Organization } from "@/lib/api/organizations"

/** `error` is set when the load failed, so a null `org` alone does not mean "not in a workspace" */
export type SettingsOrg = { org: Organization | null; isAdmin: boolean; loading: boolean; error: string | null; refresh(): Promise<void> }

export const SettingsOrgContext = createContext<SettingsOrg | null>(null)

/** The current organization and the user's role in it, loaded once by the settings layout */
export function useSettingsOrg(): SettingsOrg {
  const value = useContext(SettingsOrgContext)
  if (!value) throw new Error("useSettingsOrg must be used inside the settings layout")
  return value
}

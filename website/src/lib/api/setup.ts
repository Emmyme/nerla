import { get } from "@/lib/api/request"

/** One part of the install as the setup check sees it. Only workspace admins may ask */
export interface SetupItem {
  id: string
  status: "ok" | "warning" | "problem"
  title: string
  detail: string
  fix?: { text: string; href?: string }
}

export const setupAPI = {
  check: async (): Promise<SetupItem[]> => (await get<{ items: SetupItem[] }>("/setup/check")).items,
}

export type Caps = { perPerson: number | null; total: number | null; maxFile: number | null; ceiling: number }
export type CapRefusal = { ok: false; reason: "file-too-large" | "person-full" | "workspace-full"; limit: number }

const MB = 1024 * 1024
const DEFAULT_UPLOAD_MB = 200

/** The server's own upload ceiling in bytes, from `MAX_UPLOAD_MB` */
export function uploadCeiling(value = process.env.MAX_UPLOAD_MB): number {
  const mb = Number(value)
  return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_UPLOAD_MB) * MB)
}

/** The largest file allowed. The admin's maximum can only lower the ceiling */
export const maxFileOf = (caps: Caps): number => Math.min(caps.maxFile ?? caps.ceiling, caps.ceiling)

/** Project files count toward the workspace total only */
export function capCheck(
  size: number,
  usage: { person: number; workspace: number },
  caps: Caps,
  projectFile: boolean,
): { ok: true } | CapRefusal {
  const maxFile = maxFileOf(caps)
  if (size > maxFile) return { ok: false, reason: "file-too-large", limit: maxFile }
  if (!projectFile && caps.perPerson !== null && usage.person + size > caps.perPerson) {
    return { ok: false, reason: "person-full", limit: caps.perPerson }
  }
  if (caps.total !== null && usage.workspace + size > caps.total) {
    return { ok: false, reason: "workspace-full", limit: caps.total }
  }
  return { ok: true }
}

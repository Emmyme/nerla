export type CapUnit = "MB" | "GB"

const UNIT_BYTES: Record<CapUnit, number> = { MB: 1024 ** 2, GB: 1024 ** 3 }

/** A cap field's value in bytes. Empty means no limit, and so does anything that is not a positive number */
export function capToBytes(value: string, unit: CapUnit): number | null {
  const text = value.trim().replace(",", ".")
  // A trailing dot, as in "1." while typing, reads as the whole number
  if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return null
  const bytes = Math.round(Number(text) * UNIT_BYTES[unit])
  return bytes > 0 && Number.isSafeInteger(bytes) ? bytes : null
}

/** A stored cap as the field shows it: whole or near-whole gigabytes in GB, anything smaller in MB */
export function bytesToCap(bytes: number | null | undefined): { value: string; unit: CapUnit } {
  if (!bytes) return { value: "", unit: "GB" }
  const unit: CapUnit = bytes >= UNIT_BYTES.GB ? "GB" : "MB"
  const value = Math.round((bytes / UNIT_BYTES[unit]) * 100) / 100
  return { value: String(value), unit }
}

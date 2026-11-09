import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"

// Derived on each use, since JWT_SECRET may come from its file after this module loads
const key = () => Buffer.from(hkdfSync("sha256", process.env.JWT_SECRET!, "", "nerla jobs", 32))

/** Encrypts a secret a job payload carries, so reading the jobs table alone does not reveal it */
export function seal(text: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".")
}

/** Throws when the value was changed, or sealed under another JWT_SECRET */
export function open(sealed: string): string {
  const [iv, tag, data] = sealed.split(".").map((part) => Buffer.from(part, "base64url"))
  const decipher = createDecipheriv("aes-256-gcm", key(), iv, { authTagLength: 16 })
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
}

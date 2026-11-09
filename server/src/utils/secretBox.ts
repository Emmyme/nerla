import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

export class NoMasterKey extends Error {
  constructor() {
    super("Keys need AI_MASTER_KEY on the server")
    this.name = "NoMasterKey"
  }
}

const TAG_BYTES = 16

const masterKey = (): Buffer => {
  const hex = process.env.AI_MASTER_KEY?.trim()
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new NoMasterKey()
  return Buffer.from(hex, "hex")
}

/** Encrypts with AES-256-GCM as `v1:{iv}:{tag}:{data}` in base64 */
export function seal(plain: string): string {
  const key = masterKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES })
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":")
}

/** Throws when the text was changed or sealed under another key */
export function open(sealed: string): string {
  const key = masterKey()
  const [version, iv, tag, data, ...rest] = sealed.split(":")
  if (version !== "v1" || !iv || !tag || data === undefined || rest.length) throw new Error("Not a sealed value")
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"), { authTagLength: TAG_BYTES })
  const tagBytes = Buffer.from(tag, "base64")
  if (tagBytes.length !== TAG_BYTES) throw new Error("Not a sealed value")
  decipher.setAuthTag(tagBytes)
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8")
}

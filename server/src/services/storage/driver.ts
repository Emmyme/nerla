import type { Readable } from "stream"

/** What Nerla needs from a file store. `delete` succeeds on a key that is already gone, `get` throws `StorageMissing` */
export type StorageDriver = {
  put(key: string, stream: Readable, contentType: string): Promise<void>
  get(key: string): Promise<Readable>
  copy(from: string, to: string): Promise<void>
  delete(key: string): Promise<void>
  /** Rejects with a plain reason, naming the setting to fix, when the store can't be used. A warning means it works but needs attention */
  check(): Promise<void | { warning: string }>
}

export class StorageMissing extends Error {
  constructor(key: string) {
    super(`The file ${key} is not in file storage.`)
    this.name = "StorageMissing"
  }
}

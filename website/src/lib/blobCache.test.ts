import { describe, expect, it, vi } from "vitest"

const started: string[] = []
vi.mock("@/lib/api/files", () => ({
  filesAPI: {
    downloadFile: (id: string, signal: AbortSignal) => {
      started.push(id)
      return new Promise<Blob>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))
    },
  },
}))

const { leaseBlobUrl } = await import("./blobCache")

describe("the shared download queue", () => {
  it("runs four at a time, lets a preview go first, and drops a cancelled wait", async () => {
    const thumbs = ["a", "b", "c", "d", "e", "f"].map((id) => leaseBlobUrl(id))
    expect(started).toEqual(["a", "b", "c", "d"])

    leaseBlobUrl("preview", { urgent: true })
    expect(started).toEqual(["a", "b", "c", "d", "preview"])

    // "e" is cancelled while it waits, and the preview holds a lane, so "f" starts once two others end
    thumbs[4].release()
    thumbs[0].release()
    thumbs[1].release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(["a", "b", "c", "d", "preview", "f"])
  })
})

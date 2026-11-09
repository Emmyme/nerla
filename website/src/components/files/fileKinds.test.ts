import { describe, expect, it } from "vitest"
import { fileKind, previewKind } from "./fileKinds"

describe("previewKind", () => {
  it("previews safe types within their size limits", () => {
    expect(previewKind("image/png", 1e6)).toBe("image")
    expect(previewKind("text/x-python", 1e3)).toBe("text")
    expect(previewKind("video/mp4", 150e6)).toBe("video")
  })

  it("leaves large or opaque files to download", () => {
    expect(previewKind("image/png", 30e6)).toBe("none")
    expect(previewKind("application/octet-stream", 10)).toBe("none")
  })

  it("never opens SVG, and shows it as a plain file", () => {
    expect(previewKind("image/svg+xml", 10)).toBe("none")
    expect(fileKind({ name: "logo.svg", mimeType: "image/svg+xml" })).toBe("file")
    expect(fileKind({ name: "logo.svg", mimeType: null })).toBe("file")
  })

  it("judges a file sent without a type by its name", () => {
    expect(fileKind({ name: "photo.JPG", mimeType: "application/octet-stream" })).toBe("image")
    expect(previewKind(null, 10, "clip.mp4")).toBe("video")
  })
})

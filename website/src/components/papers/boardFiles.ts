import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types"
import type { BinaryFileData, BinaryFiles, DataURL } from "@excalidraw/excalidraw/types"
import type { DocAccess } from "@/lib/api/papers"
import { readAsDataUrl } from "@/lib/base64"
import { docImageBlob } from "./docImages"
import { isSticker, stickerFile } from "./stickers"

export type BoardAccess = () => Promise<DocAccess>

/**
 * A picture on a board: a sticker drawn from code, or an image uploaded to this doc, fetched with the doc's access
 * through the cache papers use too. The server only hands over images of `docId`, so a file from anywhere else never
 * shows
 */
export async function boardFile(fileId: string, docId: string, access: BoardAccess): Promise<BinaryFileData | null> {
  if (isSticker(fileId)) return stickerFile(fileId)
  try {
    const blob = await docImageBlob(fileId, docId, await access())
    return {
      id: fileId as FileId,
      mimeType: blob.type as BinaryFileData["mimeType"],
      dataURL: (await readAsDataUrl(blob)) as DataURL,
      created: Date.now(),
    }
  } catch {
    return null
  }
}

/** The ids of pictures the elements show that `files` doesn't hold yet */
export function missingFileIds(elements: readonly ExcalidrawElement[], files: BinaryFiles): string[] {
  const ids = new Set<string>()
  for (const element of elements) {
    if (element.type === "image" && !element.isDeleted && element.fileId && !files[element.fileId]) ids.add(element.fileId)
  }
  return [...ids]
}

/** The elements to draw or export: an image only when its picture is one this doc holds */
export function withHeldImages<T extends ExcalidrawElement>(elements: readonly T[], held: ReadonlySet<string>): T[] {
  return elements.filter((element) => element.type !== "image" || (!!element.fileId && held.has(element.fileId)))
}

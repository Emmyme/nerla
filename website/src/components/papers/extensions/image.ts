import { Image, type ImageOptions } from "@tiptap/extension-image"
import { ReactNodeViewRenderer } from "@tiptap/react"
import type { DocAccess } from "@/lib/api/papers"
import { PaperImageView } from "../PaperImageView"

type PaperImageOptions = ImageOptions & { access: () => Promise<DocAccess>; docId: string }

/**
 * An image uploaded into the paper, kept by its file id. It loads through the signed-in download, or the call share
 * or doc token the paper opened with. Images pasted from elsewhere by address are left out
 */
export const PaperImage = Image.extend<PaperImageOptions>({
  addOptions() {
    return { ...this.parent!(), access: async () => ({}), docId: "" }
  },

  addAttributes() {
    return {
      fileId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-file-id"),
        renderHTML: (attributes: { fileId?: string | null }) => (attributes.fileId ? { "data-file-id": attributes.fileId } : {}),
      },
      alt: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: "img[data-file-id]" }]
  },

  addNodeView() {
    return ReactNodeViewRenderer(PaperImageView)
  },
})

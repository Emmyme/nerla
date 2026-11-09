/** The colours a folder or a group chat can take */
export const FOLDER_COLORS = ["sky", "pistachio", "bubblegum", "lavender", "lemon"] as const

/** A stored null means sky */
export type FolderColor = (typeof FOLDER_COLORS)[number]

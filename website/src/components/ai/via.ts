import type { Via } from "@/lib/api/ai"

export type ViaVerb = "Done" | "Created" | "Deleted"

/** What the marker says about an item an agent or the AI did or made for a user */
export function viaLabel(via: Via, personName: string, aiName: string, verb: ViaVerb = "Done"): string {
  return via.kind === "agent" ? `${verb} by ${personName}'s agent (${via.tokenName})` : `${verb} by ${aiName} for ${personName}`
}

/** The AI said it itself, so it shows as the AI with "Asked by" */
export const saidByAi = (via: Via | null | undefined): boolean => via?.kind === "ai" && via.speaker === "ai"

/** Made through an agent or the AI for the user, so it carries the marker */
export const markedVia = (via: Via | null | undefined): via is Via => !!via && !saidByAi(via)

/** Markdown marks taken off for a one-line preview: paired marks, link targets, and list, heading and quote markers at line starts */
export function stripMarks(text: string): string {
  return text
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d{1,9}[.)]\s+|>\s?)/gm, "")
    .replace(/!?\[([^\]\n]*)\]\([^)\s]+[^)\n]*\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\p{L}\p{N}*_])([*_])(?=[^\s*_])([\s\S]*?[^\s*_])\2(?![\p{L}\p{N}*_])/gu, "$1$3")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

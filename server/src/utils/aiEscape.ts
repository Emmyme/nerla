/** A tag inside the text can't end an untrusted block early */
export const escapeTag = (text: string) => text.replace(/<(\/?)untrusted/gi, "&lt;$1untrusted")

export const escapeAttribute = (text: string) => text.replace(/[^\w .:/-]/g, "")

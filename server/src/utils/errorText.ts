/** The message of a caught value, which need not be an Error */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

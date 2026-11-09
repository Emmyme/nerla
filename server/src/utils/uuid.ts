/** A UUID in any case, as Postgres reads one. For use inside a larger pattern */
export const UUID_TEXT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

export const UUID = new RegExp(`^${UUID_TEXT}$`, "i")

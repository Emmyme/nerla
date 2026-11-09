import { describe, expect, it } from "vitest"
import { trashActions } from "./trashActions"

describe("trashActions", () => {
  it("offers Restore and Delete forever only where the server allows them", () => {
    expect(trashActions({ can: { restore: true, purge: true } })).toEqual(["restore", "purge"])
    expect(trashActions({ can: { restore: true, purge: false } })).toEqual(["restore"])
    expect(trashActions({ can: { restore: false, purge: true } })).toEqual(["purge"])
    expect(trashActions({ can: { restore: false, purge: false } })).toEqual([])
  })
})

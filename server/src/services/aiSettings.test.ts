import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { seal } from "../utils/secretBox"
import { modelChoice, type AiPersonalRow, type AiSettingsRow } from "./aiSettings"

vi.mock("../db", () => ({ db: {}, aiSettings: {}, aiPersonal: {}, fileAttachments: {} }))

describe("modelChoice", () => {
  const before = process.env.AI_MASTER_KEY
  beforeEach(() => {
    process.env.AI_MASTER_KEY = "cd".repeat(32)
  })
  afterEach(() => {
    if (before === undefined) delete process.env.AI_MASTER_KEY
    else process.env.AI_MASTER_KEY = before
  })

  const org = () =>
    ({
      baseUrl: "https://models.example.com/v1",
      model: "work",
      keyCipher: seal("sk-workspace"),
      allowPersonalKey: true,
      allowPersonalUrl: true,
      localNetwork: true,
    }) as AiSettingsRow
  const personal = (fields: Partial<AiPersonalRow>) => ({ baseUrl: null, model: null, keyCipher: null, ...fields }) as AiPersonalRow

  it("never sends the workspace key to a personal address", () => {
    const choice = modelChoice(org(), personal({ baseUrl: "https://mine.example.com/v1", model: "own" }))
    expect(choice).toMatchObject({ baseUrl: "https://mine.example.com/v1", model: "own", key: null, local: false, personal: true })
  })

  it("uses the workspace key at the workspace address, or the user's own key when they have one", () => {
    expect(modelChoice(org(), null)).toMatchObject({
      baseUrl: "https://models.example.com/v1",
      key: "sk-workspace",
      local: true,
      personal: false,
    })
    expect(modelChoice({ ...org(), localNetwork: false }, personal({ keyCipher: seal("sk-mine") }))).toMatchObject({
      key: "sk-mine",
      personal: true,
    })
    // A local model or one with no key of its own would run on the member's key for free, so the budgets still count it
    expect(modelChoice(org(), personal({ keyCipher: seal("sk-mine") }))).toMatchObject({ key: "sk-mine", personal: false })
  })

  it("never sends a key saved for a personal address to the workspace address", () => {
    const own = personal({ baseUrl: "https://mine.example.com/v1", model: "own", keyCipher: seal("sk-mine") })
    expect(modelChoice({ ...org(), allowPersonalUrl: false }, own)).toMatchObject({
      baseUrl: "https://models.example.com/v1",
      key: "sk-workspace",
    })
    const noModel = personal({ baseUrl: "https://mine.example.com/v1", keyCipher: seal("sk-mine") })
    expect(modelChoice(org(), noModel)).toMatchObject({ baseUrl: "https://models.example.com/v1", key: "sk-workspace", personal: false })
  })
})

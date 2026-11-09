import { useRef, useState } from "react"
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MentionContext, useMentionComposer } from "./MentionPicker"

const PEOPLE = [
  { id: "a0000000-0000-4000-8000-000000000001", first_name: "Anna", last_name: "Berg" },
  { id: "b0000000-0000-4000-8000-000000000002", first_name: "Bo", last_name: null },
]

function Field() {
  const [text, setText] = useState("")
  const field = useRef<HTMLTextAreaElement>(null)
  const mentions = useMentionComposer({ text, setText, field })
  return (
    <>
      <textarea
        ref={field}
        aria-label="Message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onInput={mentions.track}
        {...mentions.inputProps}
      />
      {mentions.picker}
    </>
  )
}

describe("useMentionComposer", () => {
  it("lists users as soon as a bare @ is typed", async () => {
    render(
      <MentionContext.Provider value={{ names: new Map(), people: PEOPLE, me: null }}>
        <Field />
      </MentionContext.Provider>,
    )
    await userEvent.type(screen.getByRole("combobox", { name: "Message" }), "@")
    expect(screen.getAllByRole("option")).toHaveLength(2)
  })
})

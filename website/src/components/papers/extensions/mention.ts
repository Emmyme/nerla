import { createElement } from "react"
import Mention from "@tiptap/extension-mention"
import { isChangeOrigin } from "@tiptap/extension-collaboration"
import { avatarOf, UserAvatar } from "@/components/ui/user-avatar"
import type { DocPerson } from "@/lib/api/papers"
import { matchPeople } from "@/lib/mentions"
import type { SuggestionMenuStore } from "../SuggestionMenu"

const MAX_OPTIONS = 8
const PILL = "paper-mention rounded-sm px-0.5 font-semibold [box-decoration-break:clone]"

/**
 * "@Name" pills over the users who can open the paper. A mention is stored as a node with the user's `id`, which the
 * server reads to notify them
 */
export function paperMention({ me, people, menu }: { me: string | null; people: () => DocPerson[]; menu: SuggestionMenuStore }) {
  return Mention.configure({
    renderText: ({ node }) => `@${node.attrs.label ?? ""}`,
    renderHTML: ({ node }) => [
      "span",
      {
        "data-type": "mention",
        "data-id": node.attrs.id,
        class: `${PILL} ${node.attrs.id === me ? "bg-app-bubblegum text-app-bubblegum-ink" : "bg-app-lavender text-app-lavender-ink"}`,
      },
      `@${node.attrs.label ?? "Someone"}`,
    ],
    suggestion: {
      char: "@",
      // An @ typed by another collaborator never opens the local list
      shouldShow: ({ transaction }) => !isChangeOrigin(transaction),
      items: ({ query }) =>
        matchPeople(
          people().filter((person) => person.id !== me),
          query,
        ).slice(0, MAX_OPTIONS),
      render: menu.renderer<DocPerson>("People to mention", (person) => ({
        key: person.id,
        label: person.name,
        icon: createElement(UserAvatar, { user: avatarOf(person), size: "xs" }),
      })),
      command: ({ editor, range, props }) => {
        const person = props as unknown as DocPerson
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            { type: "mention", attrs: { id: person.id, label: person.name } },
            { type: "text", text: " " },
          ])
          .run()
      },
    },
  })
}

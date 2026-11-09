import type { BoardPlan } from "../../src/utils/boardLayout"
import { createBoard, createPaper } from "./build"
import type { Crew, Projects } from "./showcaseCrew"

const BRAND_BRIEF = [
  "## Who they are",
  "A family bakery with three shops in Stockholm. Sourdough, cardamom buns and a queue out the door on Saturdays.",
  "## What the brand should feel like",
  "- Warm, like the shop at seven in the morning",
  "- Handmade, never rustic for the sake of it",
  "- Easy to read on a chalkboard from across the street",
  "> We want people to recognise the bag before they read the name.",
  "## Deliverables",
  "| Item | Team | Due |",
  "| --- | --- | --- |",
  "| Logo and stamp | Brand | This week |",
  "| Bread bag dieline | Design | Next week |",
  "| Menu boards | Brand | In two weeks |",
  "## Before the presentation",
  "- [x] Agree on the palette",
  "- [x] Print the packaging samples",
  "- [ ] Confirm the typeface licence",
  "- [ ] Book the photographer",
].join("\n")

const SPRINT_PLAN = [
  "## Goal",
  "Patients book a time in under a minute, on any phone, with a screen reader or without.",
  "## In this sprint",
  "1. Booking flow, second round",
  "2. Accessible date picker",
  "3. Clinic list API",
  "4. Reminder settings screen",
  "## Risks",
  "- The clinic list API is two endpoints short",
  "- Push notification copy still needs the clinics' sign-off",
  "## Checklist for the demo",
  "- [x] Test build on the clinic tablets",
  "- [ ] Sample bookings for three clinics",
  "- [ ] Questions for the clinic owners",
  "| Area | Status |",
  "| --- | --- |",
  "| Booking | In progress |",
  "| Reminders | Not started |",
  "| Login | Done |",
].join("\n")

const INTERVIEWS = [
  "Eight patients from three clinics, interviewed over two weeks.",
  "## Key findings",
  "1. Most people book on their phone, often on the bus",
  "2. Time slots below the fold are easy to miss",
  "3. Reminders by text message are trusted more than email",
  "> I just want to know when to show up and what to bring.",
  "## What changes",
  "- Time slots move to the top of the booking screen",
  "- One reminder the day before, by text message",
  "- A clear note on what to bring",
  "## Next steps",
  "- [x] Share the notes with the team",
  "- [ ] Run the synthesis workshop",
  "- [ ] Present the findings to Sample Client",
].join("\n")

const JOURNEY: BoardPlan = {
  layout: "flow",
  groups: [],
  items: [
    { id: "open", kind: "note", text: "Opens the app from a reminder", color: "sky" },
    { id: "clinic", kind: "note", text: "Picks a clinic near home", color: "sky" },
    { id: "time", kind: "note", text: "Chooses a time slot", color: "pistachio" },
    { id: "confirm", kind: "note", text: "Confirms and gets a text message", color: "pistachio" },
    { id: "visit", kind: "note", text: "Arrives knowing what to bring", color: "bubblegum" },
  ],
  connections: [
    { from: "open", to: "clinic", kind: "arrow" },
    { from: "clinic", to: "time", kind: "arrow" },
    { from: "time", to: "confirm", kind: "arrow", label: "Under a minute" },
    { from: "confirm", to: "visit", kind: "arrow" },
  ],
}

/** Gives back the sprint paper's id, which the AI teammate links to */
export async function seedShowcaseDocs(crew: Crew, projects: Projects): Promise<{ sprintPaper: string }> {
  await createPaper(crew.test, projects.tallow, "Sample Bakery brand brief", BRAND_BRIEF)
  const sprintPaper = await createPaper(crew.penny, projects.sampleClient, "Sample Client sprint 14", SPRINT_PLAN)
  await createPaper(crew.penny, projects.research, "Onboarding interviews", INTERVIEWS)
  await createBoard(crew.john, projects.sampleClient, "Booking journey", JOURNEY)
  return { sprintPaper }
}

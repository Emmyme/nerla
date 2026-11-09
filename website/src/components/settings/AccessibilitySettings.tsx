import { toast } from "sonner"
import { setAccessibility, useAccessibility, type AccessibilityKey } from "@/lib/accessibility"
import { ToggleRow } from "./AiConnectionFields"
import { SettingsSection } from "./SettingsSection"

const CHOICES: { key: AccessibilityKey; label: string; description: string }[] = [
  {
    key: "reduceMotion",
    label: "Turn off animations",
    description: "Keeps Nerla still, even if your device allows motion. Loading spinners still turn.",
  },
  {
    key: "stillZs",
    label: "Keep sleeping z's still",
    description: "The z's above sleeping cats stop moving. Everything else keeps its animations.",
  },
  {
    key: "easierReading",
    label: "Easier reading",
    description: "A clearer font with more space between letters, words and lines.",
  },
  {
    key: "largerText",
    label: "Larger text",
    description: "Makes the smaller text in Nerla a little bigger.",
  },
  {
    key: "moreContrast",
    label: "More contrast",
    description: "Darker text and clearer edges. Turns on by itself when your device asks for more contrast.",
  },
  {
    key: "typeShapes",
    label: "Show shapes with colors",
    description: "Calendar event types get a small shape beside their color, so you can tell them apart without the color.",
  },
]

/** Choices for how Nerla looks and moves, saved on the account so they follow the user to every device */
export default function AccessibilitySettings() {
  const choices = useAccessibility()
  const change = (key: AccessibilityKey, on: boolean) => {
    setAccessibility(key, on).catch(() => toast.error("Couldn't save that setting"))
  }
  return (
    <div className="flex flex-col">
      <SettingsSection title="Accessibility" description="These choices are saved on your account and follow you to every device.">
        {CHOICES.map((choice) => (
          <ToggleRow
            key={choice.key}
            label={choice.label}
            description={choice.description}
            checked={choices[choice.key]}
            onChange={(on) => change(choice.key, on)}
          />
        ))}
      </SettingsSection>
    </div>
  )
}

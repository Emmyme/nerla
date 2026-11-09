import { defineConfig } from "vitest/config"
import { shared, unit } from "./vitest.config"

// Stryker runs the unit project only, since every worker would otherwise rebuild the shared db template
export default defineConfig({ test: { ...shared, projects: [unit] } })

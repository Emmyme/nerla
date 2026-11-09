import { configDefaults, defineConfig, type TestProjectInlineConfiguration } from "vitest/config"

export const shared = {
  environment: "node",
} as const

export const unit: TestProjectInlineConfiguration = {
  extends: true,
  test: { name: "unit", include: ["src/**/*.test.ts"], exclude: [...configDefaults.exclude, "src/**/*.db.test.ts"] },
}

export default defineConfig({
  test: {
    ...shared,
    projects: [
      unit,
      {
        extends: true,
        test: {
          name: "db",
          include: ["src/**/*.db.test.ts"],
          globalSetup: ["src/test/dbGlobalSetup.ts"],
          setupFiles: ["src/test/dbSetup.ts"],
          // A cold build of the whole app can take longer than the default 10 seconds, and a busy machine slows real queries
          hookTimeout: 60_000,
          testTimeout: 20_000,
        },
      },
    ],
  },
})

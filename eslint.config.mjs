import js from "@eslint/js"
import { defineConfig } from "eslint/config"
import prettier from "eslint-config-prettier"
import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"
import tseslint from "typescript-eslint"

export default defineConfig(
  {
    // Generated, vendored and local tool output
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      ".yarn/**",
      "server/drizzle/**",
      "docs/**",
      "website/public/**",
      "desktop/src-tauri/gen/**",
      "desktop/src-tauri/target/**",
      ".claude/**",
      ".superpowers/**",
      ".impeccable/**",
      "website/.screenshots/**",
      "**/coverage/**",
      "**/.stryker-tmp/**",
      "server/reports/**",
      "e2e/test-results/**",
      "e2e/playwright-report/**",
      "website/dist-e2e/**",
      "**/.next/**",
      "**/build/**",
      "**/out/**",
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [tseslint.configs.recommended],
    rules: {
      // A leading underscore marks a value left out on purpose, such as a field dropped from a rest spread
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ["server/**", "scripts/**", "website/scripts/**", "website/*.{ts,mjs}", "e2e/**"],
    languageOptions: { globals: globals.node },
  },
  {
    // Screenshot scripts pass callbacks that run inside the browser page
    files: ["website/**"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["website/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // These React Compiler rules judge compiler readiness, and Nerla does not use the compiler
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/globals": "off",
      "react-hooks/static-components": "off",
      "react-hooks/use-memo": "off",
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "**/test/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  prettier,
)

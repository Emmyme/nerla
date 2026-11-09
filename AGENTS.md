# Nerla for AI coding agents

A quick overview to get started in this repository. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the layout in detail and the rules the checks enforce. [DESIGN.md](DESIGN.md) covers the UI.

## What it is

Nerla is a self-hosted workspace: tasks and projects, a calendar, chat and calls, papers and boards, files, time tracking and an AI that asks before it acts. It is one Yarn 4 workspace:

| Package    | What it is                                                                     |
| ---------- | ------------------------------------------------------------------------------ |
| `server/`  | Fastify API, live servers, job worker and Drizzle schema on PostgreSQL          |
| `website/` | The React app, built with Vite, used in the browser and inside the desktop app |
| `desktop/` | The Tauri shell around the website                                             |
| `e2e/`     | Playwright journeys against a real server on a seeded database                 |

The server runs in Docker on port 5000 (`docker compose up -d --build server` after a server change), and `yarn dev:web` serves the website on 3001.

## Before a change is done

- `yarn format:check`, `yarn lint`, `yarn knip` and `yarn test` pass, plus `yarn workspace server typecheck` and `yarn workspace website typecheck`.
- A change to a user journey also runs `yarn test:e2e`.
- The commit hook runs. Never skip it with `--no-verify`.

## Rules the code relies on

- Every query is scoped to the user's workspace. A query scoped another way says why in a `// tenancy:` comment, and one that reads trashed rows in a `// trash:` comment. Guard tests check both.
- Every AI tool call goes through the gate in `server/src/services/aiGate.ts`.
- Input is validated at every trust boundary with the Zod schemas in `server/src/validation/`.
- Schema changes follow [Changing the database](CONTRIBUTING.md#changing-the-database). Jobs are added in the same transaction as their data.
- Reuse the helper, component or pattern that already exists. Unused code is deleted, and `yarn knip` finds it.
- A shortcut with a known limit gets a comment in the form `shortcut: <the limit>, <when to lift it>`.

## Data and secrets

- Never reset, reseed or migrate a database that holds someone's work. `db:seed --reset` and servers run for a check use a scratch database and a bucket of their own.
- Never print secrets from `.env`.

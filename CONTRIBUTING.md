# Contributing to Nerla

Thanks for your interest in contributing to Nerla! Here's how to get started. You don't need to know the repo, every step is below.

## Getting started

1. Fork the repository and clone your fork.
2. Run `./setup-dev.sh` once, or `setup.ps1` on Windows. It writes a `.env` with development secrets and starts the services in Docker. You can also copy `.env.example` to `.env` yourself and run `docker compose up -d`.
3. Run `yarn install`. It installs every workspace and sets `core.hooksPath` in your clone, so the commit hook runs. If git can't be configured it prints a warning instead. Then run `git config core.hooksPath .githooks` yourself.
4. Create a feature branch from `main`.

## Development setup

- **Requirements**: Node.js 26 (see `.nvmrc`) and Yarn 4 through Corepack. Node 25 and newer no longer bundle Corepack, so install it once with `npm i -g corepack && corepack enable`. Docker runs the database and the other services.
- **Server**: Node.js + Fastify + Drizzle ORM (PostgreSQL)
- **Website**: Vite single-page app (React)
- **Desktop**: the same website bundle wrapped in Tauri

The server runs in Docker on port 5000, built from your source. After a server change, rebuild it with `docker compose up -d --build server`. Start the website with `yarn dev:web` and open http://localhost:3001. `yarn dev:desktop` opens the desktop app instead.

## How the code is laid out

Nerla is one Yarn 4 workspace with four packages:

| Package    | What it is                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `server/`  | The Fastify API, the live servers for chat, presence and papers, the job worker and the database     |
| `website/` | The React app, built with Vite, used in the browser and inside the desktop app                       |
| `desktop/` | The Tauri shell that wraps the website as a native app with auto-update                              |
| `e2e/`     | Playwright journeys against a real server on a fresh seeded database                                 |

At the root, `nerla` is the management command for an install, `setup-dev.sh` and `setup.ps1` set up development, and `scripts/` holds backup, restore, release and size budget scripts.

### The server

```
server/src
├── index.ts, app.ts, config.ts   start, plugins and routes, settings checks
├── routes/                       one Fastify plugin per area
├── middleware/                   sign-in check and error handler
├── services/                     the logic routes call, including the AI
├── services/aiTools/             the AI's tools
├── utils/                        pure functions: access rules, time maths, formats
├── db/                           Drizzle schema, client and migration runner
├── jobs/                         Postgres job queue and schedules
├── live/                         in-memory pub/sub between parts of one process
└── validation/                   zod request schemas
```

Migrations live in `server/drizzle`, and the seed in `server/scripts/seed`.

### The website

```
website/src
├── router.tsx, App.tsx       routes, lazy pages, shell
├── app/                      one folder per page, plus the theme CSS
├── components/               one folder per feature, plus ui/ for the design system
├── lib/                      API client, socket, stores, dates, shortcuts
├── store/                    time tracking and toast stores
└── providers/, contexts/     auth and theme
```

### Key choices

Read these before you change code in the area.

- **Every query is scoped to a workspace.** Routes run `authMiddleware` then `orgMiddleware` and read the workspace with `orgOf(request)`. `resolveOrg` in `server/src/services/tenancy.ts` is the only place that reads memberships by user alone.
- **Guard tests read the source.** `server/src/tenancy.guard.test.ts` and `server/src/trash.guard.test.ts` scan every query. A query scoped another way needs a `// tenancy: <why>` comment, and one that reads trashed rows a `// trash: <why>` comment.
- **Access rules are pure functions** in `server/src/utils/`: `canAccessTask` (`taskAccess.ts`), `can` (`fileAccess.ts`), `docLevel` (`docAccess.ts`) and `visibilityFor` (`eventVisibility.ts`). Services load the rows and these decide, so the rules have unit tests without a database.
- **One gate for every AI tool call.** The built-in AI and MCP agents run tools through `callTool` in `server/src/services/aiGate.ts`. The gate checks scopes and step caps, and decides per change whether it needs the user's Allow.
- **Taint decides Allow.** A request is tainted once it read anything written by another user or an unknown author (`isTainting` in `server/src/utils/aiGate.ts`). Its changes that others can see then wait for Allow, so text someone else wrote can never act through the AI unseen. Untrusted text reaches the model inside `<untrusted>` blocks (`server/src/utils/aiPrompt.ts`).
- **Tools act through the app's own routes** with `callAs` in `server/src/services/acting.ts`. Permissions and side effects are exactly what the user gets in the UI.
- **Nerla has its own migration runner** (`server/src/db/migrate.ts`). It checks a hash of every migration that ran, and `server/src/db/migrationRules.ts` refuses migrations that would lose data or lock tables. See [Changing the database](#changing-the-database).
- **Jobs live in Postgres** (`server/src/jobs/queue.ts`). `addJob` runs in the caller's transaction, so a job exists only if its change committed. See [Background jobs](#background-jobs).
- **Times are UTC wall time.** The database client forces UTC and stores times in zone-less columns. Read them with `storedMs`, write with `writeInstant`, and handle daylight saving with `fromWallClock`, all in `server/src/utils/eventTime.ts`.
- **The website keeps state in small module stores** read through `useSyncExternalStore`, not React context, for example `website/src/lib/chatStore.ts` and `website/src/lib/calendarStore.ts`.
- **One WebSocket** (`website/src/lib/socket.ts`) carries every live event. Each store catches up after a reconnect through `onSocketReconnect`.
- **One REST client.** Every call goes through `request` in `website/src/lib/api/request.ts`, with one module per area beside it.

For UI work, read [DESIGN.md](DESIGN.md) first. It covers the tokens, the components and the rules the UI guard tests enforce.

## Formatting and lint

- Prettier formats the whole repo: no semicolons, double quotes, lines up to 140 characters. `yarn format` formats everything and `yarn format:check` only checks.
- `yarn lint` runs ESLint over the whole repo and allows 0 warnings.
- `yarn knip` finds unused files, exports and dependencies. CI runs it too, so remove what you stop using.
- You rarely need Prettier or ESLint by hand, since the commit hook formats and lints what you stage.

## Tests

- `yarn test` runs the server suite, then the website suite. The end-to-end tests run on their own, as below.
- `yarn workspace server test:unit` runs the server's unit tests only. They need no database.
- `yarn workspace website test` runs the website suite. The first run of a session is slow, later runs take about 25 seconds.
- `yarn workspace server typecheck` and `yarn workspace website typecheck` check the types, tests included.

The server has two test projects. `unit` is plain code. `db` runs against a real Postgres, with one fresh database per test file, dropped afterwards.

- Start Postgres with `docker compose up -d postgres`. It listens on port 5432.
- The db tests log in with `DB_USER` and `DB_PASSWORD` from the root `.env`, the same user setup creates. Nothing else to set.
- To use another Postgres, set `TEST_DATABASE_URL`, for example `postgresql://user:password@localhost:5432/postgres`. The user must be allowed to create databases.
- If Postgres isn't running, or refuses the login, the db tests fail at once and say what to do. They never hang.
- Run one test run at a time against the same Postgres, since runs share a template database.

### End-to-end tests

The e2e tests drive the built website in Chromium against a real server, on a fresh database seeded with two workspaces. `yarn test` never runs them.

1. Install Chromium once with `yarn workspace e2e playwright install chromium`.
2. Start the services with `docker compose up -d postgres garage mailpit`.
3. Run `yarn test:e2e`. It builds the server and the website when they changed, makes the database again, seeds it and runs every journey. A run with nothing to build takes about two minutes.

They use their own ports and data, so the dev stack keeps running beside them:

- the server on port 5100, and the website on 4173
- the database `nerla_e2e`, dropped and made again on every run
- the bucket `nerla-e2e`, with a Garage key of its own
- Mailpit on 1025 and 8025 for email

They never touch the dev server on 5000, the dev website on 3001, or the `nerla` database and its files.

When a journey fails, `yarn workspace e2e playwright show-report` opens the report. Open a failed test's trace with `yarn workspace e2e playwright show-trace test-results/<test>/trace.zip`, or drop the file on [trace.playwright.dev](https://trace.playwright.dev), which opens it in your browser without uploading it. In CI the `e2e` job uploads the report and traces as the `e2e-report` artifact, kept for 7 days. `e2e/README.md` explains how to write a journey.

Mutation testing is on demand only. `yarn workspace server mutate` breaks the core permission and time modules on purpose and checks the unit tests notice. It takes about 10 minutes, needs no database, and writes its report to `server/reports/mutation`. It never runs in CI or in the hook.

CI fails when the website's first load or the server image grows past its budget. The budgets live in `scripts/size-budgets.mjs`, and raising one means changing the number there and saying why in the commit.

## Changing the database

1. Edit the area file in `server/src/db/schema/`.
2. Run `yarn workspace server db:generate --name <change>`. It writes a new SQL file in `server/drizzle`.
3. Hand-edit the SQL where a rule needs it. Build indexes with `create index concurrently` and start the file with `-- nerla:no-transaction`, preceded by `drop index concurrently if exists <name>` so a retry works. Add foreign keys `NOT VALID` and validate them after. Set `not null` only after a validated check constraint.
4. Run `yarn workspace server db:migrate` to apply it to your local database.

The tests and CI check these rules. If a change is safe but breaks one, add `-- nerla:allow <rule>: <why>` to the file. Never edit a migration that has shipped, put the change in a new one. CI fails a pull request that does.

The server applies new migrations itself when it starts, so a developer's database moves forward on the next start. `./nerla check` lists setup problems, `/health` answers while the server is up, and `/health/ready` also checks the database, storage and email.

## Background jobs

Work that must happen later, or must survive a restart, goes on the queue in `server/src/jobs/queue.ts`. It is a table in Postgres, so it needs nothing else running. Define a job once with `defineJob`, and add it with `addJob` inside the same transaction as the data it belongs to, so the job exists only if the data does:

```ts
defineJob<{ path: string }>("storage.delete", {}, ({ path }) => deleteObject(path))

await db.transaction(async (tx) => {
  await tx.delete(files).where(eq(files.id, id))
  await addJob(tx, "storage.delete", { path }, { uniqueKey: `storage:${path}` })
})
```

- **Lease.** A worker claims a job and holds it for a lease, 60 seconds unless the job says otherwise, and renews it while the handler runs. If the process dies, the lease runs out and another worker, or the same one after a restart, runs the job again. Each run counts as an attempt, and a job that fails every attempt is marked failed.
- **Unique key.** A key allows one pending or running job at a time. `addJob` returns null when the key is taken. `cancelJobs(db, key)` removes the pending one, which is how a new status end time replaces the old job.
- **Safe to run twice.** A handler must give the same result when it runs again, because a lease can run out on a slow job and a crash can land after the work but before the job is marked done. Delete by path, set a value, check first. Never "add one".
- **Giving up.** A handler that can never succeed throws `FinalError`, and the job fails at once instead of retrying.
- **Schedules.** `defineSchedule(kind, everyMs, handler)` in `schedules.ts` runs a handler once per time slot across all processes.
- **Failed jobs.** The setup check page lists failed jobs from the last 7 days with their last error. `./nerla logs server` has the detail. Finished jobs are removed after 7 days and failed ones after 30.

## Seed data

`yarn workspace server db:seed` fills a database with two workspaces and a few accounts, listed in `server/scripts/seed/accounts.ts`. Every password is `Test@1234`. Add `--reset` to empty the database first, and `--no-storage` when Garage isn't running.

`--reset` deletes everything in the database it points at. Set `DATABASE_URL` to a scratch database first, never the one that holds your own work. A server you run from source for a check needs a scratch database and its own storage bucket too, for example `S3_BUCKET=nerla-scratch`.

## Commit messages

The first line is `type: one plain sentence`, or `type(scope): ...`. Add `!` before the colon for a breaking change. The types are feat, fix, docs, test, ci, style, refactor, perf, build, chore and revert.

- `feat: calls ring on every page`
- `fix(server): a slow query ends`
- `docs: how to restore a backup`
- `refactor: one place decides who can see a note`
- `feat!: drop the old import format`

Merge commits (`Merge branch ...`) and `Revert "..."` are accepted as git writes them. The `.githooks/commit-msg` hook checks this locally and CI checks every commit in a pull request, where `fixup!` and `squash!` are also rejected. The release notes are built from these types.

## The commit hook

The hook in `.githooks/pre-commit` checks only what you stage:

- Prettier formats the staged files and stages them again
- ESLint lints the staged scripts
- the typecheck runs for each workspace with staged code
- TruffleHog scans for secrets
- Semgrep runs Nerla's own rules in `.semgrep/nerla.yml`, offline
- `cargo fmt --check` runs when Rust files are staged
- `yarn npm audit` runs when dependencies change, and only warns

Three of the tools are optional:

- **Docker**, which TruffleHog needs running to run. The first commit pulls the pinned TruffleHog image once.
- **Semgrep**, for example `pip install semgrep`.
- **rustfmt**, with `rustup component add rustfmt`, only if you change Rust files.

When a tool is missing, Docker isn't running, or the TruffleHog image can't be pulled, the hook prints a warning that it skipped that check and lets the commit through. CI runs every check on every pull request, so nothing is skipped for good.

When the hook blocks, it says why. Fix what it reports and commit again. Please never skip it with `--no-verify`.

- If TruffleHog flags a string that isn't a secret, add a `trufflehog:ignore` comment on that line. It also blocks on a string it can't check, for example while you're offline. A fake database connection string with a password in a test needs the comment at the end of its line.
- If Semgrep flags code that is safe, add `// nosemgrep: <rule id>` on the line above, with a short reason.

The first commit in a fresh clone takes a couple of minutes while the typechecks build their cache. Later commits take seconds.

## Cutting a release

Merge to main and wait for green CI, then tag the merge and push the tag:

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

The tag starts the release workflow. It publishes signed images for amd64 and arm64, builds the desktop installers and publishes the release with notes generated from the commit types. Run the workflow by hand on a tag with its dry run option on to check the builds without publishing.

## Pull request guidelines

- Keep PRs focused, one feature or fix per PR
- Write commit messages as described in [Commit messages](#commit-messages)
- Make sure `yarn format:check`, `yarn lint`, `yarn knip` and `yarn test` pass. CI runs them on every PR, with both typechecks, the scans and a server boot check
- Update documentation if your changes affect setup or usage

## Code style

- TypeScript throughout
- Use existing patterns and conventions in the codebase
- Validate all API inputs with Zod schemas
- Use parameterized queries (Drizzle ORM), never raw SQL string concatenation
- Working with an AI coding agent? [AGENTS.md](AGENTS.md) gives it a quick overview of the repo, and `CLAUDE.md` points to it

## Rules the checks enforce

`yarn test`, `yarn knip` and CI fail when one of these breaks:

- **The UI rules in [DESIGN.md](DESIGN.md)**, such as rem only and tokens only. `website/src/app/theme-classes.test.ts` and `website/src/app/tokens.test.ts`.
- **Tenancy and trash markers.** A query not scoped to a workspace needs `// tenancy: <why>`, and one that reads trashed rows needs `// trash: <why>`. `server/src/tenancy.guard.test.ts` and `server/src/trash.guard.test.ts`.
- **The AI gate.** Only `aiGate.ts`, `aiToolRun.ts` and `aiCards.ts` in `server/src/services/` may run a tool. `server/src/aiGate.guard.test.ts`.
- **No dead code.** `yarn knip` finds unused files, exports and dependencies.
- **Migration rules.** `server/src/db/migrationRules.ts`, as in [Changing the database](#changing-the-database).

## Reporting bugs

Open a GitHub issue with:

- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment details (OS, browser, etc.)

## Security issues

Please see [SECURITY.md](SECURITY.md) for reporting security vulnerabilities.

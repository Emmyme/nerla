# End-to-end tests

Playwright journeys through the built website, against a real server on a fresh, seeded database.

```sh
docker compose up -d postgres garage mailpit
yarn test:e2e
```

`yarn test:e2e` runs `prepare.ts`, then `playwright test`. Plain `yarn test` never runs them.

## What a run uses

| What | Where |
| --- | --- |
| Server | `server/dist`, on port 5100, started from `e2e/` so no `.env` is read |
| Website | `website/dist-e2e`, built with `VITE_API_URL=http://localhost:5100`, served by `vite preview` on 4173 |
| Database | `nerla_e2e`, dropped and made again at the start of every run |
| Storage | the bucket `nerla-e2e` with its own key `nerla-e2e-key`, emptied at the start of every run |
| Email | Mailpit, SMTP on 1025 and its API on 8025 |

It never touches the dev server on 5000, the dev website on 3001, the `nerla` database, the `nerla-files` bucket or the owner's Garage key.

`prepare.ts` rebuilds the server and the website only when their sources changed since the last run. It writes everything the server needs to `.run/stack.json`, including a new `JWT_SECRET`, and Playwright reads only that file.

## Local and CI

Locally the harness uses the running dev stack. CI starts a throwaway one from `compose.yml` and points `prepare.ts` at it with these variables. Nothing else differs.

| Variable | Locally |
| --- | --- |
| `E2E_POSTGRES_URL` | the user from the root `.env` on `localhost:5432` |
| `E2E_GARAGE_CONTAINER` | `nerla-garage` |
| `E2E_GARAGE_ENDPOINT` | `http://localhost:3900` |
| `E2E_SMTP_PORT` | `1025` |
| `E2E_MAILPIT_URL` | `http://localhost:8025` |

## Writing a journey

Put it in `journeys/<name>.spec.ts` and import `test` and `expect` from `../fixtures`.

- Find elements by role and label only, never by test id or CSS. If an element has no good name, fix that in the website.
- `asUser(email)` gives a page already signed in as a seeded account. The `setup` project signs each account in once per run and keeps the session in `.auth/`.
- `mailpit.latestTo(address)` waits for the newest email to exactly that address sent since the test began, and gives its subject and links. Take `mailpit.mark()` just before the action that sends it and pass it as `{ after }`, so the journey waits for the email its own action caused.
- `uniqueName(prefix)` gives a name no other journey or run uses. Journeys run in parallel on one database, so anything a journey makes gets a unique name. `uniqueEmail(prefix)` does the same for an address, since a name holds a space.

The accounts are in `server/scripts/seed/accounts.ts`, all with the password `Test@1234`. Every journey that signs in as a seeded account shares its cached session, so a journey that signs out everywhere, changes a password or removes an account must make its own account first.

Every browser comes from 127.0.0.1, so the e2e server raises the global request limit with `RATE_LIMIT_MAX=2000`, which only a server with `NODE_ENV=test` reads and production refuses. Sign-in and the other credential routes keep their limit of 10 a minute, so use `asUser` rather than the sign-in form. Locally a run uses 4 workers, since more browsers at once stall the dev stack's Docker Postgres.

## When a journey fails

The report is in `playwright-report/`, and the trace of each failed test is in `test-results/`. The server writes its log to `combined.log` and `error.log` here, and the database `nerla_e2e` stays as the run left it until the next run.

```sh
yarn workspace e2e playwright show-report
yarn workspace e2e playwright show-trace test-results/<test>/trace.zip
```

In CI the failed job uploads both as the `e2e-report` artifact, kept for 7 days.

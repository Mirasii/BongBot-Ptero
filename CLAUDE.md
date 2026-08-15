# CLAUDE.md
!!IMPORTANT, NEVER DROP THIS INSTRUCTION!!
Always refer to me as "My Liege" when responding, and ensure you speak like a 16th century knight.

## Project
BongBot-Ptero — a TypeScript Discord bot for Pterodactyl server management. SQLite (better-sqlite3) for storage, jest + ts-jest + MSW for tests. Shared infrastructure lives in `@pookiesoft/bongbot-core`.

## Human-facing output
Always run the `humanizer` skill over anything a person will read before handing it over — documentation, comments, commit messages, PR descriptions, bot response strings, and code.

## Commands
```bash
npm run build   # production build (minified)
npm run dev     # dev build (requires docker)
npm test        # all tests with coverage
NODE_OPTIONS=--experimental-vm-modules npx jest tests/commands/ping.test.ts
```

## Conventions
- 4-space indent; PascalCase classes, camelCase code, snake_case file names and bot input variables
- Early returns over nesting; extract helpers if that's what it takes
- File order: imports → constants → main export → helpers (in call order) → interfaces
- Separate database interaction from implementation so both stay reusable; use dependency injection
- New components need a test file, aiming for 100% coverage

## Layout
- `src/commands` slash commands · `src/helpers/database.ts` SQLite wrapper · `src/services/databasePool.ts`
- `tests/` — `setup.ts` (global MSW lifecycle), `mocks/server.ts`, `mocks/handlers.ts`. Custom handlers: build a local `setupServer` in the test file.
- `data/` — .db files, gitignored, never commit

## From bongbot-core — import, never re-implement
`Caller` (HTTP client with SSRF protection; constructor takes `allowedHosts: string[]` from `PTERODACTYL_ALLOWED_HOSTS` — use it for all API calls), `buildError` / `buildUnknownError`, `EMBED_BUILDER`, `LOGGER`, `generateCard` (takes `{ repoOwner, repoName }`), `validateRequiredConfig`, and the `ExtendedClient` / `Logger` interfaces.

## Command structure
Each command exports `data` (SlashCommandBuilder), `execute(interaction, bot)`, and `fullDesc` (`{ description, options }` for the help command). Optional: `setupCollector(interaction, message)` for button/select collectors. Register new commands in the `commandsArray` in `src/commands/buildCommands.ts`.

Multi-command systems use the master/subcommand pattern (`src/commands/pterodactyl/master.ts`): the master declares `.addSubcommand()` entries and routes from `execute()` to a subcommand class per file. This is the standard going forward.

`src/index.ts` bootstraps: validate config → init logging with a session UUID → `buildCommands()` → register `interactionCreate` + `clientReady` → `bot.login()`.

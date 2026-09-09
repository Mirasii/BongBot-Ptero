# BongBot-Ptero Technical Debt Audit

## 1. Prioritised TODOs

No explicit `TODO`/`FIXME`/`HACK` comments were found in the source. The following are inferred incomplete or fragile areas:

### 1.1 Unsafe `as any` Cast for Collector Detection

**Severity**: MEDIUM
**Location**: `src/index.ts`

```typescript
if (command && typeof (command as any).setupCollector === 'function') {
    await (command as any).setupCollector(interaction, message);
}
```

The command type does not encode the optional `setupCollector` method, so `as any` is used as a workaround.

**Fix**: Define a proper type guard:

```typescript
interface CommandWithCollector {
    setupCollector(i: ChatInputCommandInteraction, m: Message): Promise<void>;
}
function hasCollector(c: unknown): c is CommandWithCollector {
    return typeof (c as any).setupCollector === 'function';
}
```

---

### 1.3 Fire-and-Forget Message Edit in Collector Cleanup

**Severity**: LOW
**Location**: `src/commands/pterodactyl/server_status.ts`

```typescript
message.edit({ components: [] }).catch((error) => {
    this._logger.error(error, interaction);
});
```

The promise is not awaited. The error is logged, but the pattern may cause race conditions on shutdown.

---

## 2. Deprecated / Outdated Discord.js Usage

The project uses discord.js v14.25.1. All current patterns are v14-compliant:

- `SlashCommandBuilder`, `ChatInputCommandInteraction`, `MessageFlags.Ephemeral` ✅
- `ButtonBuilder`, `StringSelectMenuBuilder`, `ComponentType` ✅
- `isCommand()` is still valid in v14 ✅

**No deprecated patterns found.**

---

## 3. Magic Values

### 3.1 Collector Timeout

**Location**: `src/commands/pterodactyl/server_status.ts`
**Value**: `600000` (10 minutes)

Currently hardcoded as a raw number. **Proposed fix** — extract to a named constant:

```typescript
const COLLECTOR_TIMEOUT_MS = 10 * 60 * 1000;
```

---

### 3.2 Polling Configuration — resolved

`server_status.ts` uses `ACTION_POLL_INTERVAL_MS` and `ACTION_TIMEOUT_MS`. The polling loop checks elapsed time instead of an attempt count.

---

### 3.3 Embed Colour

**Locations**: `src/commands/pterodactyl/list_servers.ts`, `src/commands/pterodactyl/shared/serverStatusEmbed.ts`
**Value**: `'#0099ff'` (duplicated as a string literal in both files)

**Proposed fix** — extract to a shared constant:

```typescript
// src/constants/colors.ts
export const EMBED_COLORS = { PRIMARY: '#0099ff' } as const;
```

---

### 3.4 Server Name Truncation Limits

**Location**: `src/commands/pterodactyl/shared/serverControlComponents.ts`
**Values**: `80`, `77` (hardcoded inline in a ternary expression)

**Proposed fix** — extract to named constants:

```typescript
const MAX_LABEL_LENGTH = 80; // Discord StringSelectMenu label limit
const TRUNCATED_LENGTH = 77; // 77 chars + '...' = 80
```

---

### 3.5 Component Pagination Limits

**Location**: `src/commands/pterodactyl/shared/serverControlComponents.ts`
**Values**: `3` (max select rows), `25` (options per menu)

`3` is assigned to a local variable `maxRowsForSelects`, but `25` is an inline magic number. Both are Discord API limits and should be named constants with a comment to that effect.

**Proposed fix**:

```typescript
const MAX_SELECT_MENU_ROWS = 3; // Discord message component row budget
const MAX_OPTIONS_PER_MENU = 25; // Discord StringSelectMenu hard limit
```

---

### 3.6 Hardcoded GitHub Repo Owner and Name

**Location**: `src/index.ts`
**Values**: `'Mirasii'`, `'BongBot-Ptero'`

These are hardcoded string constants with no environment variable fallback, making the bot harder to fork or redirect.

**Proposed fix** — allow env var overrides:

```typescript
const GITHUB_REPO_OWNER = process.env.GITHUB_REPO_OWNER ?? 'Mirasii';
const GITHUB_REPO_NAME = process.env.GITHUB_REPO_NAME ?? 'BongBot-Ptero';
```

---

### 3.7 Server State String Literals

**Location**: `src/commands/pterodactyl/shared/serverStatusEmbed.ts`
**Values**: `'running'`, `'offline'`, `'starting'`, `'stopping'`

These are repeated as bare string literals across the file with no shared type definition.

**Proposed fix** — extract to a typed constant:

```typescript
const SERVER_STATES = {
    RUNNING: 'running',
    OFFLINE: 'offline',
    STARTING: 'starting',
    STOPPING: 'stopping',
} as const;
type ServerState = (typeof SERVER_STATES)[keyof typeof SERVER_STATES];
```

---

## 4. Dead / Unused Code

No unused imports or orphaned exports were identified. All exported symbols are consumed by at least one other module or test.

One minor point: the explicit type assertion `interaction as CommandInteraction` on the `isCommand()` branch of `index.ts` is redundant — TypeScript narrows the type automatically after the type guard. The cast can be removed.

---

## 5. Test Coverage Gaps

The original audit recorded 100% statements, 100% functions, and approximately 99% branches. These figures are historical; use a fresh coverage run for the current branch. The single uncovered branch is in `postDeploymentMessage` — the embed description-only match path (`index.ts:66`):

```typescript
embed.title?.includes(GITHUB_REPO_NAME) || embed.description?.includes(GITHUB_REPO_NAME); // ← this branch not covered
```

**Other gaps worth adding**:

- Collector timeout expiry (no test verifies components are removed after 10 minutes)
- Manage polling deadline, repeated resource failures, and collector expiry during reads/edits are covered in `server_status.test.ts`
- Malformed ciphertext passed to `decryptApiKey` (should throw a clear error)
- Transient Discord edit failures and persistent resource-read failures are covered in `server_status.test.ts`

---

## 6. Recommended Cleanup Plan

### Phase 1 — High Priority (1–2 days)

1. Extract all magic values in section 3 to `src/constants/` (`colors.ts`, `timeouts.ts`, `limits.ts`, `states.ts`)
2. Add `ENCRYPTION_KEY` format validation at startup (must be 64 hex chars)

### Phase 2 — Medium Priority (2–3 days)

4. Replace `as any` collector cast with a proper type guard interface
5. Add `ServerState` enum to replace bare string literals
6. Cover the remaining uncovered embed-description branch in tests

### Phase 3 — Low Priority (ongoing)

8. Add collector timeout and polling boundary tests
9. Add malformed ciphertext test for `database.ts`
10. Move GitHub repo constants to env vars

---

## 7. Original Audit Metrics (historical)

| Metric                            | Value | Status |
| --------------------------------- | ----- | ------ |
| Statement coverage                | 100%  | ✅     |
| Branch coverage                   | ~99%  | ✅     |
| Function coverage                 | 100%  | ✅     |
| Deprecated discord.js patterns    | 0     | ✅     |
| Explicit `any` casts              | 2     | ⚠️     |
| Magic values requiring extraction | ~10   | ⚠️     |

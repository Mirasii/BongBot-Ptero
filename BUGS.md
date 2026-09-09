# BUGS.md - BongBot-Ptero Performance & Correctness Analysis

## 1. Critical Correctness Issues

### 1.1 Memory Leak in Message Component Collector — resolved

The manage action now awaits a sequential polling loop. Collector expiry aborts the pending delay and discards resource results that arrive after cancellation. Cleanup waits for an outstanding message edit before removing controls.

---

### 1.2 Unawaited Promise in postDeploymentMessage

**Location**: `index.ts`
**Severity**: HIGH

```typescript
botMessages?.forEach((message: Message) => message.delete());
```

`message.delete()` is async but not awaited. If deletion fails (permission issue, rate limit, message already deleted), errors are silently ignored. This also fires multiple rapid API calls without rate-limit awareness.

**Fix:**

```typescript
await Promise.allSettled(
    botMessages.map((msg) => msg.delete().catch((error) => console.warn(`Failed to delete message: ${error.message}`)))
);
```

---

### 1.3 Empty Catch Handler in setupCollector — resolved

**Location**: `server_status.ts`
**Severity**: MEDIUM

```typescript
}).catch(() => {});
```

Errors from the error follow-up are now sent to the injected logger.

The handler logs the error:

```typescript
.catch((error) => this._logger.error(error as Error));
```

---

### 1.4 Race Condition in pollUntilStateChange — resolved

The detached interval was removed. Each resource read and render finishes before the next delay begins, and the action promise covers the loop's lifetime. A named deadline replaces the attempt limit. An outstanding HTTP request still relies on the API client's timeout.

---

## 2. Performance Bottlenecks

### 2.1 Inefficient Server Lookup by Name

**Location**: `update_server.ts`
**Severity**: MEDIUM

```typescript
const existingServers = this.db.getServersByUserId(userId);
const existingServer = existingServers.find((s) => s.serverName === serverName);
```

Fetches all servers for a user to check if one specific name exists — O(n) DB read + O(n) in-memory scan instead of a targeted query.

**Fix:** Add a `getServerByName(userId, serverName)` method to `Database`.

---

### 2.2 Synchronous Crypto Operations on Every DB Read

**Location**: `database.ts`
**Severity**: MEDIUM

Every call to `getServersByUserId()` or `getServerById()` synchronously decrypts all returned API keys. AES-256-GCM is CPU-bound and blocks the event loop, causing noticeable latency when a user has many registered servers.

**Fix:** Defer decryption until the API key is actually passed to an HTTP call, rather than on every query result.

---

### 2.3 Inefficient Message Filtering on Bot Restart

**Location**: `index.ts`
**Severity**: LOW

The bot fetches the last 100 messages on every `clientReady` event and runs multiple string `includes()` checks on each. No pagination, no caching of the last deployment message ID.

**Fix:** Store the last deployment message ID in the database and fetch it directly on restart.

---

### 2.4 No Rate Limiting on Bulk Server Commands

**Location**: `server_status.ts`
**Severity**: MEDIUM

When stopping all servers, each `sendServerCommand()` fires immediately as a parallel HTTP request:

```typescript
const results = await Promise.all(targets.map((server) => sendServerCommand(...)));
```

No throttling or backoff if Pterodactyl rate-limits the requests. This remains open. Manage status polling now reads unaffected servers once per action and polls only successful command targets; that removes the repeated whole-panel reads but does not solve bulk command rate limiting.

**Fix:** Limit concurrent requests (e.g. with `p-limit`) and add exponential backoff on 429 responses.

---

## 3. Type Safety / Async Gaps

### 3.1 fetchServerResources Returns null for All Errors

**Location**: `pterodactylApi.ts`
**Severity**: MEDIUM

```typescript
} catch {
    return null;
}
```

All failure modes — network errors, SSRF rejection, 401, 404, 500 — collapse to `null`. Callers cannot distinguish between "server offline" and "cannot reach panel".

**Fix:** Return a discriminated union:

```typescript
type ApiResult<T> =
    | { status: 'ok'; data: T }
    | { status: 'error'; code: 'network' | 'notfound' | 'auth'; message: string };
```

---

### 3.2 Component Interaction Parsing Without Validation

**Location**: `server_status.ts`
**Severity**: LOW

```typescript
const [dbServerId, identifier, action] = componentInteraction.values[0].split(':');
```

No check that `values[0]` exists or that the split produces the expected number of parts. Malformed custom IDs fail silently.

**Fix:**

```typescript
const parts = componentInteraction.values[0]?.split(':');
if (!parts || parts.length !== 3) throw new Error('Invalid component interaction format');
const [dbServerId, identifier, action] = parts;
```

---

### 3.3 Unsafe Type Cast After Promise.allSettled — resolved

Bulk commands use `Promise.all` over `sendServerCommand`, which catches errors and returns a boolean. The fulfilled-result cast is no longer needed.

---

## 4. Resource Cleanup

### 4.1 No Graceful Shutdown Handler

**Location**: `databasePool.ts`, `index.ts`
**Severity**: MEDIUM

No `SIGTERM` / `SIGINT` handlers are registered. When the container stops, better-sqlite3 may not flush WAL writes and active Discord collectors are never cleaned up.

**Fix:**

```typescript
process.on('SIGTERM', async () => {
    DatabasePool.getInstance().closeAll();
    bot.destroy();
    process.exit(0);
});
```

---

### 4.2 Collector Has No Idle Timeout

**Location**: `server_status.ts`
**Severity**: MEDIUM

```typescript
const collector = message.createMessageComponentCollector({ time: 600000 });
```

A collector always runs for the full 10 minutes even if the user stopped interacting after the first click. This keeps the collector and its closures in memory unnecessarily.

**Fix:** Add an idle timeout:

```typescript
message.createMessageComponentCollector({ time: 600000, idle: 300000 });
```

---

## 5. Summary

| Issue                                                   | Severity | Category         |
| ------------------------------------------------------- | -------- | ---------------- |
| Unawaited `message.delete()` in postDeploymentMessage   | HIGH     | Race Condition   |
| O(n) server lookup by name                              | MEDIUM   | Performance      |
| Synchronous crypto blocking event loop                  | MEDIUM   | Event Loop       |
| All API errors collapse to `null`                       | MEDIUM   | Type Safety      |
| No graceful shutdown handler                            | MEDIUM   | Resource Cleanup |
| No idle timeout on collector                            | MEDIUM   | Resource Cleanup |
| Unvalidated component interaction parsing               | LOW      | Type Safety      |

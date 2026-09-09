# Issue #67: manage statuses remain stale after actions

Issue: [Manage statuses do not automatically update after an action](https://github.com/PookieSoft/BongBot-Ptero/issues/67).

Analysis date: 9 September 2026. Source revision: `90cf495e8fa70119f98c2bc066581fe01dc44044`.

## Finding

The main defect is in `ServerStatus.pollUntilStateChange`: it polls the API during an action but does not render those observations. It refreshes the manage message only when every affected server reaches the expected state or the attempt limit is reached. Restart also has a premature completion condition: the server can still report its original `running` state immediately after the command is accepted, which stops polling before the restart happens.

These are confirmed control-flow defects in the checked-out source. The issue does not identify the affected actions, wait duration, deployment revision, or runtime errors, so this analysis cannot establish which path occurred in the reporter's session. In particular, ordinary start/stop should eventually refresh if the target state is observed and the final fetch and message edit succeed; the code does not explain every possible case of a permanently stale view by itself.

## Relevant code and cause

- [`master.ts`](src/commands/pterodactyl/master.ts) routes `manage` to `ServerStatus` and exposes its collector setup.
- [`server_status.ts:91–93`](src/commands/pterodactyl/server_status.ts#L91-L93) initially edits only the components to disable them. The old status embed remains visible.
- [`server_status.ts:230–232`](src/commands/pterodactyl/server_status.ts#L230-L232) selects `running` as the target for both start and restart, without tracking whether a restart has begun.
- [`server_status.ts:245–267`](src/commands/pterodactyl/server_status.ts#L245-L267) fetches resources and checks the target. `refreshStatus` is inside the completion/timeout branch, so intermediate `starting`, `stopping`, and individual completions during Stop All are never displayed.
- [`server_status.ts:282–314`](src/commands/pterodactyl/server_status.ts#L282-L314) fetches a separate snapshot for the final render and rebuilds enabled controls. Fetch/edit failures are logged and swallowed, allowing polling to finish without a visible update.
- [`server_status_embed.ts`](src/commands/pterodactyl/shared/server_status_embed.ts) already renders `starting` and `stopping`. The missing updates originate in the action/polling flow, not missing status formatting.

Under the review skill's rules, the missing transition rendering is G2 (expected behavior), and premature restart completion is G3/G21 (boundary conditions and algorithm correctness).

### Observable sequences

| Action      | API observations after command acceptance           | Current display behavior                                                                                |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Start       | `offline → starting → running`                      | Original offline embed remains until running, followed by a separate refresh fetch.                     |
| Stop        | `running → stopping → offline`                      | Original running embed remains until offline.                                                           |
| Restart     | `running → stopping → offline → starting → running` | First running observation can terminate polling. The later transition and completion are not monitored. |
| Stop All    | Servers reach offline at different times            | No progress is rendered until all successful command targets are offline or polling expires.            |
| Slow action | Target not reached within 120 checks                | A single refresh occurs at the attempt limit; later completion is not monitored.                        |

The first check is immediate; subsequent checks are scheduled every 500 ms. With fast requests the limit is reached after roughly 59.5 seconds, not a reliable wall-clock deadline.

### Related reliability defects

`setInterval(async ...)` allows overlapping requests when a check takes longer than 500 ms. The polling method returns after installing the interval, so the caller's `await` does not cover its lifetime. Later callback failures do not flow into the action handler's catch block. The collector's ten-minute end handler removes controls but does not cancel polling; a later refresh can restore controls on an expired view. These problems are also noted in `BUGS.md` sections 1.1 and 1.4. They aggravate the issue but are not necessary to explain missing transition rendering.

`fetchServerResources` returns null on any fetch failure. Null prevents successful completion until the attempt limit, after which refresh may show unknown. A successful power request alone does not establish that the resulting state has been reached.

## Proposed fix

Keep the change focused on the manage action lifecycle in `server_status.ts`, with corresponding tests. Reuse the existing embed and component builders.

1. Replace the detached interval with an awaited, sequential polling loop. Give it named polling/deadline settings, explicit completion, timeout, error and cancellation outcomes, and collector-owned cancellation. Allow only one active action per manage message; guard queued interactions as well as disabling controls.
2. After command acceptance, show a pending-action description immediately while preserving the last observed state. Do not claim that the API has reported `starting` or `stopping` before it does. On each poll, render changed observed states while work remains pending. Use the same snapshot for rendering and completion checks, merging affected-server observations into the view's existing snapshot. Avoid fetching all resources a second time merely to render each poll, and avoid identical Discord edits on every tick.
3. Keep controls disabled throughout the pending action. The current `refreshStatus` cannot simply be called unmodified every tick: it rebuilds enabled controls. Separate rendering from fetching and make control availability follow the action/collector lifecycle. On confirmed completion, render the final snapshot and restore valid controls only if the collector remains active.
4. Track completion per affected server. Start completes at observed running; stop completes at observed offline. For restart, require evidence of the new lifecycle before accepting running: observe a non-running state followed by running, or use a validated new boot/uptime signal relative to a pre-command resource snapshot. The existing resource type exposes uptime, but its behavior must be verified against the deployed panel before relying on it. If polling misses the transition and no reliable restart evidence is available, report completion as unconfirmed at the deadline rather than immediately treating the original running state as success.
5. For Stop All, display each server's progress independently and finish when every successfully commanded server has completed. Preserve failure reporting for unsuccessful commands; do not wait for those commands as though they succeeded.
6. At the deadline, display the latest observations and explicitly say that completion could not be confirmed. Do not present timeout as success. Recover from transient resource errors within the deadline without interpreting null as a target state. Log and handle message-edit failures explicitly, with bounded retries where appropriate; stop when the message can no longer be updated.
7. On collector end, cancel polling and prevent in-flight results from restoring controls. Coordinate the final component removal with any outstanding edit so it remains the last component update. Ensure all terminal paths release the action lock and scheduled work.

This supplies automatic updates during an action. Continuous idle monitoring and a new websocket subsystem are outside this fix. Polling can display observed transitions but cannot guarantee capturing states shorter than its sampling interval.

## Validation required when implementing

Existing polling tests in [`server_status.test.ts:1035–1165`](tests/commands/pterodactyl/server_status.test.ts#L1035-L1165) assert only that `editReply` was called. The initial components-only edit already satisfies that assertion, even if no embed refresh occurs. They do not protect the expected behavior.

Add deterministic tests using controlled resource sequences and fake timers, asserting actual embed content and control state:

- Start and stop publish observed transition states before their terminal state, without another user interaction.
- Restart ignores an initial running response, renders subsequent transitions, and only completes after evidence of the new lifecycle. Cover missed transitions and unconfirmed timeout.
- Stop All renders one server offline while another is stopping; partial command failures remain visible and do not prevent successful targets from updating.
- Slow requests never overlap; the action promise stays pending until the loop finishes.
- Timeout and repeated resource failures produce an explicit unconfirmed outcome and clean up work.
- Collector expiry during a request/edit prevents further polling and leaves controls removed.
- Message-edit failures and rapid repeated interactions cannot leave an unhandled rejection, competing loops, or permanently held action lock.

Then run the relevant Jest suites and project checks. Manually verify start, stop, restart and Stop All against a test panel, watching the original manage message through completion and timeout.

## Analysis-stage work performed

Read the issue and its empty comment history; traced command dispatch, action handling, resource fetching, polling, rendering and existing tests. This is static source analysis, not a live Discord/Pterodactyl reproduction. No implementation or test files were changed, and tests were not run for this documentation-only task. Existing unrelated workspace changes were left untouched.

## Implementation follow-up

Implementation was subsequently authorized on branch `fix/67-manage-status-refresh`. The final design keeps the action lifecycle in `server_status.ts`: single-server actions and Stop All share command submission and an awaited polling loop. No separate polling/state-management helper remains.

The loop renders changed observations from the same resource snapshot used for completion checks, keeps controls disabled while pending, requires a non-running observation before confirming restart, and reports an unconfirmed outcome at timeout. A per-view action guard prevents concurrent actions. Collector expiry cancels scheduled polling, discards outstanding resource results, and removes controls after any outstanding edit finishes. Failed Stop All commands remain identified in the status description.

Each action captures unaffected servers once and polls only successful action targets thereafter. Identical state/description snapshots do not trigger another Discord edit. Existing resource-fetch failures remain represented as unknown and are retried by subsequent polls. The polling deadline is checked between requests; the existing API layer does not expose cancellation of an outstanding HTTP request. A restart whose transition is too brief to observe is reported as unconfirmed at timeout; no assumption about uptime semantics was added.

Validation includes TypeScript checking, the production build, and regression tests for displayed transitions, restart timeout, disabled controls, concurrent interactions, slow reads, collector expiry during an edit, and Stop All progress with partial failure. Live Discord/Pterodactyl verification remains outstanding.

The completion audit also identified and fixed premature polling termination after a transient Discord edit failure. The existing view edit function now retries HTTP 5xx responses once, checks collector cancellation before retrying, and propagates persistent failures to the existing error handler. Regression tests verify recovery through action completion, bounded persistent failures with action-lock release, and explicit timeout after repeated resource failures. All 64 manage tests, TypeScript checking, and the production build pass after this increment. The previously verified component and command-dispatch suites are unchanged.

The remaining manual check requires an identified disposable Discord/Pterodactyl environment. No live power commands have been issued during this work.

## Review follow-up

The code review identified two real state and load issues. Polling now captures unaffected server resources once and polls only successful action targets. The collector keeps the last rendered embed and components, so a later action starts from the current view instead of the original command response. Bulk command failures are logged again, and the open rate-limit TODO remains in the source and in `BUGS.md`.

The review's structural suggestion to split `handleServerAction` into several helpers was not adopted. That method owns one action lifecycle and the proposed helpers would pass the same server, interaction, and view state through multiple layers. The earlier helper extraction was removed because it made the implementation longer and harder to follow. The method's command dispatch, snapshot polling, completion decision, and render are kept together so their ordering is visible.

The dead restart comparison, bulk restart coupling, nested failure-message expression, collector timeout literal, and silent follow-up catch were also addressed. Tests cover target-only polling, consecutive actions, per-target restart evidence, failure logging, and the existing cancellation paths.

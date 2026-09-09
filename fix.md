# Issue #67: manage status refresh and fifth review

Reviewed the fifth pass in `CLAUDE-REVIEW.md` against the current worktree on 9 September 2026. Claude found no correctness defect and confirmed the previous fixes. This document records the current behavior, the latest changes, and the design choices retained after review.

## Current behavior

Manage actions update the original message from an awaited, sequential polling loop. Observed transitions appear while controls remain disabled. Completion restores valid controls and takes precedence over the deadline when the final read both reaches the target state and crosses sixty seconds. Restart requires a non-running observation followed by running for each successful target. Stop All retains individual progress and command-failure details.

The configuration lookup precedes both the pending-action follow-up and the disabling edit. A missing configuration produces only the error response, leaves the message untouched, and releases the action lock. A regression checks that a later valid action can complete.

The collector normalizes Discord message rows into builders once and retains the latest successfully rendered embed and controls. Collector expiry cancels polling and removes controls after any outstanding message edit settles. Transient Discord 5xx edit failures receive one retry. The initial-edit regression checks the actual disabled controls, preserved embed fields and untouched source data.

## Fifth-pass findings

1. **Component type names: fixed (N4/TS3).** The components module now exports `ControlRow`, which the manage view imports. The duplicate `ManageActionRow` alias is gone. The alias extracted from `Message['components']` is now `MessageActionRow`, distinguishing Discord class instances from `ApiControlRow`, the plain JSON shape.

2. **API-row overload and passthrough: retained, with the contract clarified.** Both production call sites pass builders. There is no current production API-row caller, and the earlier claim that existing callers required that shape was too broad. The helper's tested API JSON support remains useful as an explicit compatibility contract; absence of local callers alone does not justify removing it during a status-refresh fix. Discord message class instances are normalized separately at collector setup and are not claimed to match the API JSON overload.

    The review is also right that the helper's name can overpromise. Its documentation now states that it disables buttons and string selects and returns empty or unsupported rows untouched. Passthrough is intentional: the helper does not invent handling for unsupported controls or discard their data. The manage flow builds buttons and string selects, and its synchronous action lock guards concurrent interactions. Tests assert passthrough identity as well as disabled copies and source immutability for supported controls.

3. **Optimistic follow-up before validation: fixed (G2).** The pending-action response now follows the synchronous configuration guard. A missing row no longer produces “Starting…” immediately before “Server configuration not found.” The regression requires exactly one follow-up on that path, alongside its existing no-edit and lock-release checks.

4. **Test readability and simulated read timing: fixed (N1/T5).** `pollingUpdates` names the operation that excludes the initial pending edit; the three duplicated slicing sequences are gone. `observeStates` applies its optional delay at the final supplied observation's read index, independently of the state value. A stop sequence beginning with `running` therefore cannot trigger the delay merely because it is running. The deadline cases still exercise the rendered completion outcome, enabled controls and timer cleanup. Moving the follow-up also exposed a stale error-notification test: it now rejects the first notification and asserts that the failure is logged without rejecting the action.

5. **Smaller notes: deliberate behavior documented.** Non-target resources remain a single snapshot for the action, including the terminal render. For Stop All, every successfully commanded server is a polling target; the baseline applies to failed-command servers. Their displayed state can become stale while other servers are polled. A terminal-only refresh is possible, but adds requests and delays restored controls; no current defect establishes a need to change the accepted read-load tradeoff. Bulk command and resource-read rate limiting remain open in [#73](https://github.com/PookieSoft/BongBot-Ptero/issues/73).

    The empty catch while awaiting `pendingEdit` now explains that the action handler owns edit errors and cleanup must still remove controls after rejection. Logging there would duplicate error ownership. Unchanged `CLAUDE.md` retains its unrelated formatting issue.

## Retained design choices

The fifth review accepts the separate render sites: initial rendering and error recovery fetch fresh resources, while the action loop renders the exact snapshot used to judge completion. Combining them into a fetching render helper would obscure those different data lifetimes. The short status choice stays beside the completion and timeout calculations that also control polling and control availability.

The sixty-second monitoring window remains bounded. Its message says monitoring ended, completion could not be confirmed, and `/pterodactyl manage` can check again. A transitional state does not prove eventual success. The JSON display key remains a collision-resistant representation of the description and ordered states, and optional embed access remains appropriate for views without embed content. Claude explicitly accepted or withdrew the corresponding earlier findings; they require no further changes.

## Validation and limits

- Full Jest suite: 174 tests passed across all 12 suites. This run exposed the stale notification mock described above; its corrected manage-suite rerun is recorded below.
- Final manage-suite rerun: all 70 tests passed. `server_status.ts` has 100% line coverage, 97.38% statements, 94.28% branches and 97.22% functions. The full-suite run confirmed 100% across all four metrics for the shared control-component helper.
- `node node_modules/typescript/bin/tsc --noEmit`: passed.
- `npm run build`: passed.
- `node node_modules/prettier/bin/prettier.cjs --check src tests fix.md`: passed.
- `git diff --check`: passed.

Checks use the installed Node entry points for Jest, TypeScript and Prettier to avoid the broken executable shims. No live Discord/Pterodactyl power commands were issued. Deployment-specific timing has not been manually verified. The deadline is checked between requests and cannot cancel an outstanding HTTP request; polling may miss a brief restart transition and report completion as unconfirmed. There is no continuous idle monitoring.

## GitHub issue migration

`BUGS.md` is retired. [PR #69](https://github.com/PookieSoft/BongBot-Ptero/pull/69) closes [#67](https://github.com/PookieSoft/BongBot-Ptero/issues/67), covering manage updates and the related polling, collector, error-logging and component fixes. The unresolved audit entries are tracked separately:

| Former audit entry                               | GitHub issue                                                 |
| ------------------------------------------------ | ------------------------------------------------------------ |
| 2.1 Targeted server lookup                       | [#70](https://github.com/PookieSoft/BongBot-Ptero/issues/70) |
| 2.2 Unnecessary API-key decryption               | [#71](https://github.com/PookieSoft/BongBot-Ptero/issues/71) |
| 1.2 and 2.3 Deployment-message cleanup           | [#72](https://github.com/PookieSoft/BongBot-Ptero/issues/72) |
| 2.4 Bulk command and resource-read rate limiting | [#73](https://github.com/PookieSoft/BongBot-Ptero/issues/73) |
| 3.1 Resource-fetch failure reasons               | [#74](https://github.com/PookieSoft/BongBot-Ptero/issues/74) |
| 3.2 Component identifier validation              | [#75](https://github.com/PookieSoft/BongBot-Ptero/issues/75) |
| 4.1 Host-owned shutdown cleanup                  | [#76](https://github.com/PookieSoft/BongBot-Ptero/issues/76) |

The deployment-message code now lives in core and already awaits deletions, but ignores individual rejected results and still scans recent history. Its issue records that current behavior. The decryption and shutdown issues omit unproven claims about noticeable latency and WAL data loss. These issues remain open after this PR; migration does not implement them. Source TODOs now link directly to their issues, and the README points contributors to GitHub Issues.

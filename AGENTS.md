# AGENTS.md — opencode-openai-retry

Working notes for a fresh session in this repo. User-facing behavior lives in
README.md; this file holds the non-obvious environment facts and gotchas.

## Commands

- Tests: `npm run test` (all) — `node --test test/retry.test.ts` (unit only,
  fast) or `node --test test/integration.test.ts` (~9 s alone).
- Typecheck: `npm run typecheck`.
- Runtime is Node 26 (no bun installed); OpenCode itself is a Bun binary but
  test code is plain Node with its own strip-types TS support.

## Layout

- `index.ts` — plugin entry. It must stay named `index.ts` at the repo root:
  OpenCode's plugins-directory scanner auto-loads `<plugins-dir>/<plugin>/index.*`.
  `src/`-style layouts are NOT picked up by the scanner.
- `retry.ts` — pure decision module (pattern matching, attempt cap, backoff).
  No OpenCode imports; tested with plain Node. `erased-syntax`-only TS
  (no enums/namespaces) since Node strip-types runs it.

## OpenCode 2.1.1 plugin loading — what actually works

Verified empirically with `opencode run --standalone` probes (2026-10):

- **Loaded automatically**: the `plugins` subdirectories of `~/.config/opencode`,
  `/etc/opencode`, and `<project>/.opencode` are scanned for
  - `*.js` files (loaded directly), and
  - subdirectories containing `index.*` at their root.
- **`plugins` array in `opencode.json`**:
  - npm/git package specs and object form `{package: "npm-or-git-spec"}`
    load normally (options delivered — opencode-auto-permissions is the
    working example).
  - Object form `{package: "/absolute/local/path"}` loads the plugin but
    its `options` object was NOT delivered: the probe (`maxRetries: 0`) had
    no effect and the plugin ran the built-in defaults — 5 agent requests
    under the pre-indefinite default, the full OpenCode ceiling (11
    requests, ~17 min) under the current one. Tests needing a specific
    configuration write a hook shim into the scanned plugins directory
    instead (see `PluginInstall` in `test/helpers.ts`): a bare
    `{ id, setup }` default export loads fine — `Plugin.define` in
    `@opencode/plugin` is only a type wrapper — and the shim imports
    `<repo>/retry.ts` by absolute file URL with its options embedded as a
    literal. Embed options as JavaScript source when a value is `Infinity`:
    the shim's JSON embed renders `JSON.stringify(Infinity)` as `null`.
  - Plain-string absolute paths and `file://...` entries were silently
    dropped — no "loading plugin" log line at all.
- A plain **non-git directory** did not get its `.opencode/` scanned. Git
  repositories did. If auto-load ever "fails", first confirm the containing
  project is a git repo before suspecting the plugin.
- Symlinked plugin directories work; dependency imports resolve through the
  symlink target's realpath (the repo's own `node_modules`).

## Integration test environment quirks

- Integration runs set `HOME`, `OPENCODE_TEST_HOME`, `OPENCODE_CONFIG_DIR`,
  and the XDG base dirs to `<project>/.home`. `--standalone` does not stop
  OpenCode from reading `~/.config/opencode`, `~/.agents`, and `~/.claude`;
  without this override a global retry hook or skill there changes request
  counts and injects prompt text. `/etc/opencode` is still visible; it is
  absent on this machine.
- OpenCode's `run` CLI **hangs (exit 130) when spawned without a tty**
  (plain `execFile` despite `stdio: "ignore"`). The harness's bash has a pty,
  which is why manual probes pass and node-spawned ones don't.
  `test/helpers.ts` wraps every invocation in `script -qec '<command>' /dev/null`
  to allocate one; output is post-processed to strip ANSI and CR.
- The mock's agent-failure budget is stateful across runs and is not shared
  with title completions. A body containing OpenCode 2.1.1's title-agent
  prompt (`You are a title generator`) always succeeds and is not an agent
  request. `Infinity` keeps every agent completion failing, which is what
  the OpenCode-ceiling test needs: any finite budget ends the run at the
  first success, short of the 11 requests the test asserts. Restart the
  server between probes. Each integration test builds its own via
  `test/helpers.ts:startMockServer`.
- Mock servers must support BOTH streaming (SSE) and non-streaming completions;
  OpenCode sends `stream: true`.
- OpenCode classifies the geo 403 as `provider.auth` in `SessionError`,
  with the original message in `error.message` and the raw 403 body in
  `error.response.body`. The plugin matches both fields (see `retry.ts`).
- When OpenCode gives up (ceiling reached), the outgoing run exits non-zero
  and its stdout (json format) carries the `provider.auth` error — the
  ceiling integration test asserts against exactly that.

## Plugin behavior contract

- The retry hook (`ctx.session.hook("retry", ...)`) fires for the agent turn
  and for compaction. It does not run for title generation or
  `session.generate`. A geo error while titling does not kill the turn; if
  the selected title model differs from the primary, OpenCode makes one more
  attempt on the primary, also outside this hook. We write `event.decision`
  when a pattern matches and, if a finite `maxRetries` is set, its cap is not
  reached — the default is indefinite, so the plugin votes retry on every
  matching hook call; otherwise the hook is a no-op and OpenCode's own
  classification stands. Writing nothing does not veto a retry OpenCode
  already decided to make.
- OpenCode's built-in schedule stops calling the hook after 10 retries
  (`Schedule.recurs(10)` in `model-retry.ts` at tag v2.1.1 — re-read from
  source 2026-10; the docs call it "the built-in maximum attempt count
  remains a hard limit"). It is not configurable. Everything the plugin
  decides is still honored — token votes, delays — only the *count* is
  upstream-imposed. No plugin-side value can exceed it, so the plugin's own
  default (indefinite) simply means "never stop on my account": the ceiling
  integration test pins 11 agent requests (1 + 10 forced retries).
- OpenCode 2.1.1 reports the upcoming physical attempt. The first failure
  arrives as attempt 2; the hook is not called for the initial request.
  When OpenCode proposes `retry: false` the plugin forces attempts
  `2..1+maxRetries` for a matched error — with the default Infinity, that
  is every hook call. Delay is `baseDelay * multiplier^(attempt - 2)`, so
  the first forced retry waits `baseDelay`. Treating `attempt` as the
  attempt that just failed drops the last retry and shifts every delay up
  by the multiplier. OpenCode's built-in maximum attempt count is a hard
  ceiling above any plugin-side cap.

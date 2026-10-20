# opencode-openai-retry

An [OpenCode](https://opencode.ai) plugin that retries the spurious OpenAI
failure *"Country, region, or territory not supported"* instead of letting it
kill the turn.

OpenAI occasionally returns a 403 `unsupported_country_region_territory` error
even though the region is fine — OpenCode classifies it as a terminal
`provider.auth` failure, the turn dies in a red error state, and your only
recourse is typing `resume` manually (sometimes several times, because the
error comes back). OpenCode already bounces through transient errors like
`ECONNRESET` on its own; this plugin gives the spurious geo error the same
treatment.

## How it works

OpenCode V2 exposes a [`retry` session hook](https://opencode.ai/v2/docs/build/plugins#retry-policy)
that runs after OpenCode classifies a provider failure and before any retry is
scheduled. The plugin overrides the decision for matched failures:

- **Match**: case-insensitive check of the error message and the raw response
  body for
  - `Country, region, or territory not supported` (the human message), and
  - `unsupported_country_region_territory` (the OpenAI error code).
- **Retry**: `{ retry: true, delay }` so OpenCode re-issues the same request
  mid-turn, with exponential backoff — default 1 s, 2 s, 4 s, 8 s (capped at
  30 s).
- **Cap**: after the retry limit the plugin stops overriding; the error shows
  up in its usual red form and you take over manually. Default: 4 forced
  retries after the initial request (5 attempts total).
- Non-matching failures are left exactly as OpenCode classified them.

## Options

| Option       | Default | Meaning                                             |
| ------------ | ------- | --------------------------------------------------- |
| `maxRetries` | `4`     | Forced retries after the initial request            |
| `baseDelay`  | `1000`  | ms before the first forced retry                    |
| `multiplier` | `2`     | Backoff multiplier per retry                        |
| `maxDelay`   | `30000` | Ceiling for a computed retry delay, ms              |
| `providers`  | all     | Only force retries for these provider IDs           |
| `patterns`   | —       | Extra case-insensitive substrings worth retrying    |

Invalid values fall back to the defaults silently. `maxRetries` must be a
whole number; `2.5` is not a count and falls back to 4. Delays and the
multiplier may be fractional.

Options arrive through the `plugins` object form in `opencode.json`:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-openai-retry",
      "options": { "maxRetries": 6, "providers": ["openai"] }
    }
  ]
}
```

See *Install* — in OpenCode 2.1.1 the package-form loading only applies to
npm/git packages; locally-loading installs started with the defaults.

## Install

In OpenCode **2.1.1** the reliable local route is the plugins directory scan:
any `*.js` file or directory containing an `index.*` entry inside a plugins
directory auto-loads. This repository *is* the plugin (entry `index.ts`), so a
symlink is a working install and changes take effect without copying:

```sh
ln -s /home/user/Work/code/opencode-openai-retry \
      ~/.config/opencode/plugins/opencode-openai-retry
```

(Project-scoped variant: the same symlink under
`<project>/.opencode/plugins/`.)

The `plugins` array in `opencode.json` also loads this plugin when given an
absolute path in object form — `{"package": "/home/user/Work/code/opencode-openai-retry"}`
— but in 2.1.1 the options object is not delivered to locally-pathed plugins,
so that form runs on defaults. When published to npm, the object form with
`options` is the route for custom configuration.

## Development

```sh
npm run test        # unit + integration suite (node --test test/)
npm run typecheck   # tsc --noEmit
```

The unit suite covers the pure decision module (`retry.ts`); the integration
suite runs a real `opencode run --standalone` session against a local
OpenAI-compatible mock server. Title calls succeed and do not spend the
failure budget. The agent turn 403s twice and then recovers, then keeps
403ing until the cap: 5 agent requests, then the error surfaces. See
`test/` and `AGENTS.md` for the environment quirks this depends on.

## Compatibility

- Written against OpenCode V2 plugin API (`@opencode/plugin` 2.1.1) and
  tested with OpenCode 2.1.1.
- OpenCode stops calling the retry hook after 10 retries. A `maxRetries`
  above that cannot be fully honored. At this plugin's own cap the decision
  is left to OpenCode; the geo 403 is already terminal there.
- Provider scopes: matches are text-based, so OpenAI-compatible endpoints
  that pass through OpenAI's geo wall are covered too; narrow with
  `providers` if you need to.

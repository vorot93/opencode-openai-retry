import { test } from "node:test"
import assert from "node:assert/strict"
import { decide, resolveOptions } from "../retry.ts"

const input = (attempt: number, message?: string, providerID = "openai") => ({
  attempt,
  message: message ?? "Error: Country, region, or territory not supported",
  providerID,
})

test("forces the first retry at the base delay when the hook reports upcoming attempt 2", () => {
  // OpenCode 2.1.1 does not present the initial request. The first failure arrives as attempt 2.
  assert.deepEqual(decide(input(2)), { retry: true, delay: 1000 })
})

test("does not force a retry for attempt 1, which is not an upcoming retry", () => {
  assert.equal(decide(input(1)), null)
})

test("backs off from the upcoming attempt, so attempt 3 waits twice the base delay", () => {
  assert.deepEqual(decide(input(3)), { retry: true, delay: 2000 })
  assert.deepEqual(decide(input(4)), { retry: true, delay: 4000 })
  assert.deepEqual(decide(input(5)), { retry: true, delay: 8000 })
})

test("by default forces every hook call, holding the delay at the ceiling", () => {
  // The plugin no longer imposes its own attempt cap: it votes retry whenever
  // OpenCode still asks. OpenCode's built-in schedule (10 retries) is the
  // stopping rule. Defaults hold the delay at the 10-minute ceiling.
  assert.deepEqual(decide(input(5)), { retry: true, delay: 8000 })
  assert.deepEqual(decide(input(6)), { retry: true, delay: 16000 })
  assert.deepEqual(decide(input(12)), { retry: true, delay: 600_000 })
  assert.deepEqual(decide(input(100)), { retry: true, delay: 600_000 })
})

test("stops forcing retries once the upcoming attempt passes 1 + an explicit maxRetries", () => {
  const o = resolveOptions({ maxRetries: 4 })
  assert.deepEqual(decide(input(5), o), { retry: true, delay: 8000 })
  assert.equal(decide(input(6), o), null)
})

test("leaves the decision untouched for other error messages", () => {
  assert.equal(decide(input(2, "Rate limit exceeded")), null)
  assert.equal(decide(input(2, "Connection error: ECONNRESET")), null)
})

test("matches the error code as well as the message", () => {
  const d = decide(
    input(2, "OpenAI POST failed: unsupported_country_region_territory"),
  )
  assert.deepEqual(d, { retry: true, delay: 1000 })
})

test("matches when the region error only appears in the raw response body", () => {
  const d = decide({
    attempt: 2,
    message: "OpenAI API error: 403",
    providerID: "openai",
    body: '{"error":{"message":"Country, region, or territory not supported","code":"unsupported_country_region_territory"}}',
  })
  assert.deepEqual(d, { retry: true, delay: 1000 })
})

test("does not match an unrelated response body", () => {
  assert.equal(
    decide({
      attempt: 2,
      message: "OpenAI API error: 429",
      providerID: "openai",
      body: '{"error":{"message":"Rate limit reached"}}',
    }),
    null,
  )
})

test("matches case-insensitively", () => {
  const d = decide(input(2, "COUNTRY, REGION, OR TERRITORY NOT SUPPORTED"))
  assert.deepEqual(d, { retry: true, delay: 1000 })
})

test("scopes to configured providers only when providers is set", () => {
  const o = resolveOptions({ providers: ["openai"] })
  assert.deepEqual(decide(input(2), o), { retry: true, delay: 1000 })
  assert.equal(
    decide(input(2, "Error: Country, region, or territory not supported", "anthropic"), o),
    null,
  )
})

test("applies to any provider when no scope is configured", () => {
  const d = decide(
    input(2, "Error: Country, region, or territory not supported", "my-custom-openai"),
  )
  assert.deepEqual(d, { retry: true, delay: 1000 })
})

test("matches user-added patterns", () => {
  const o = resolveOptions({ patterns: ["Server is overloaded"] })
  assert.deepEqual(decide(input(2, "api error: Server is overloaded (attempt 1)"), o), {
    retry: true,
    delay: 1000,
  })
  assert.equal(decide(input(2, "Untouched provider error"), o), null)
})

test("honors a custom base delay on the first forced retry", () => {
  const o = resolveOptions({ baseDelay: 500 })
  assert.deepEqual(decide(input(2), o), { retry: true, delay: 500 })
})

test("caps the backoff delay once the upcoming-attempt exponent reaches the ceiling", () => {
  // Explicit maxDelay so the assertion is independent of the plugin's default ceiling.
  const o = resolveOptions({ maxRetries: 10, maxDelay: 30_000 })
  // attempt 6 is the 5th forced retry: 1000 * 2^4 = 16000, still under the ceiling.
  // The old exponent (attempt - 1) would already cap this at 30000.
  assert.deepEqual(decide(input(6), o), { retry: true, delay: 16000 })
  // attempt 7: 1000 * 2^5 = 32000, capped at 30000.
  assert.deepEqual(decide(input(7), o), { retry: true, delay: 30000 })
})

test("forces upcoming attempts 2 through 1 + maxRetries and stops on the next", () => {
  const o = resolveOptions({ maxRetries: 2 })
  assert.deepEqual(decide(input(2), o), { retry: true, delay: 1000 })
  assert.deepEqual(decide(input(3), o), { retry: true, delay: 2000 })
  assert.equal(decide(input(4), o), null)
})

test("forces nothing when maxRetries is 0, because the first hook call is already attempt 2", () => {
  const o = resolveOptions({ maxRetries: 0 })
  assert.equal(decide(input(2), o), null)
})

test("resolveOptions applies documented defaults: indefinite retries, 10-minute delay ceiling", () => {
  assert.deepEqual(resolveOptions(undefined), {
    patterns: [],
    providers: undefined,
    maxRetries: Number.POSITIVE_INFINITY,
    baseDelay: 1000,
    multiplier: 2,
    maxDelay: 600_000,
  })
})

test("resolveOptions falls back for invalid values", () => {
  // Invalid counts fall back to the default, which is now indefinite.
  assert.deepEqual(resolveOptions({ maxRetries: -1 }).maxRetries, Number.POSITIVE_INFINITY)
  assert.deepEqual(resolveOptions({ maxRetries: Number.NaN }).maxRetries, Number.POSITIVE_INFINITY)
  assert.deepEqual(resolveOptions({ maxRetries: 2.5 }).maxRetries, Number.POSITIVE_INFINITY)
  assert.deepEqual(resolveOptions({ baseDelay: 1500.5 }).baseDelay, 1500.5)
  assert.deepEqual(resolveOptions({ multiplier: 1.5 }).multiplier, 1.5)
  assert.deepEqual(resolveOptions({ baseDelay: "x" }).baseDelay, 1000)
  assert.deepEqual(resolveOptions({ multiplier: 0 }).multiplier, 2)
  assert.deepEqual(resolveOptions({ maxDelay: -5 }).maxDelay, 600_000)
  assert.deepEqual(resolveOptions({ providers: "openai" }).providers, undefined)
  assert.deepEqual(resolveOptions({ providers: ["", "  "] }).providers, undefined)
  assert.deepEqual(resolveOptions({ patterns: [4] }).patterns, [])
})

test("resolveOptions accepts Infinity explicitly as no attempt cap", () => {
  assert.deepEqual(resolveOptions({ maxRetries: Number.POSITIVE_INFINITY }).maxRetries, Number.POSITIVE_INFINITY)
})

test("resolveOptions trims and normalizes strings, using them only when valid", () => {
  const o = resolveOptions({
    providers: [" OpenAI "],
    patterns: [" PATTERN A ", ""],
  })
  assert.deepEqual(o.providers, new Set(["openai"]))
  assert.deepEqual(o.patterns, ["PATTERN A"])
})

test("single matching provider is still usable via the set", () => {
  const o = resolveOptions({ providers: ["openai"] })
  assert.ok(o.providers!.has("openai"))
})

test("never forces a retry for a nonsensical attempt number", () => {
  assert.equal(decide(input(0)), null)
  assert.equal(decide(input(-3)), null)
})

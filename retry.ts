/**
 * Retry policy for the plugin, kept free of OpenCode runtime imports so it can
 * be unit-tested with plain Node.
 */

export interface Options {
  /**
   * Extra case-insensitive substrings that make a provider failure retryable.
   * The OpenAI geo-error message and its error code are always matched.
   */
  patterns?: string[]
  /**
   * Only force retries for these provider IDs. Unset applies to every provider,
   * because OpenAI-compatible endpoints can surface the same geo error.
   */
  providers?: string[]
  /**
   * Forced retries after the initial request. Default: indefinite — the plugin
   * votes retry on every matching hook call, and OpenCode's own retry schedule
   * (10 per model call in 2.1.1) is the stopping rule. A finite value restores
   * a plugin-side cap.
   */
  maxRetries?: number
  /** Delay in ms before the first forced retry. Default 1000. */
  baseDelay?: number
  /** Backoff multiplier per forced retry. Default 2. */
  multiplier?: number
  /** Upper bound in ms on a forced retry's delay. Default 600000 (10 minutes). */
  maxDelay?: number
}

export interface Resolved {
  patterns: readonly string[]
  providers: ReadonlySet<string> | undefined
  /** Whole number of forced retries, or Infinity for no plugin-side cap. */
  maxRetries: number
  baseDelay: number
  multiplier: number
  maxDelay: number
}

export interface RetryFailure {
  attempt: number
  message: string
  providerID: string
  /** Raw provider response body, when OpenCode attached it to the error. */
  body?: string
}

export type RetryDecision = { retry: true; delay: number }

/** Substrings matching OpenAI's spurious region error, message and code. */
const GEO_PATTERNS = [
  "country, region, or territory not supported",
  "unsupported_country_region_territory",
] as const

// `maxRetries: Infinity` is indefinite: the plugin never stops voting for retries,
// and OpenCode's built-in schedule (10 retries per model call on 2.1.1) becomes the
// stopping rule. With 1s * 2 backoff those 10 retries span ~17 minutes without ever
// exceeding the 10-minute delay ceiling.
const DEFAULTS = { maxRetries: Infinity, baseDelay: 1000, multiplier: 2, maxDelay: 600_000 } as const

function asNumber(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return fallback
  return value
}

/** A retry count is a whole number of attempts, or Infinity to remove the cap. 2.5 is not one extra try. */
function asCount(value: unknown, fallback: number): number {
  if (value === Infinity) return Infinity
  const count = asNumber(value, fallback, 0)
  return Number.isInteger(count) ? count : fallback
}

/** Normalize a plain array of strings; invalid or empty entries are dropped. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export function resolveOptions(raw: unknown): Resolved {
  const options = (raw ?? {}) as Record<string, unknown>

  const providersList = stringList(options.providers).map((item) => item.toLowerCase())
  const patterns = stringList(options.patterns)

  return {
    patterns,
    providers:
      providersList.length > 0 ? new Set(providersList) : undefined,
    maxRetries: asCount(options.maxRetries, DEFAULTS.maxRetries),
    baseDelay: asNumber(options.baseDelay, DEFAULTS.baseDelay, 0),
    multiplier: asNumber(options.multiplier, DEFAULTS.multiplier, 1),
    maxDelay: asNumber(options.maxDelay, DEFAULTS.maxDelay, 0),
  }
}

/**
 * Decide whether the plugin should force a retry.
 *
 * Returns the replacement decision when this error matches (and no explicit
 * attempt cap has been reached), or null to leave OpenCode's own retry
 * decision untouched.
 */
export function decide(
  failure: RetryFailure,
  options: Resolved = resolveOptions(undefined),
): RetryDecision | null {
  const attempt = Number(failure.attempt)
  // The hook is not called for the initial request. A non-integer, or any
  // attempt below the first upcoming retry, is not a decision this plugin makes.
  if (!Number.isInteger(attempt) || attempt < 2) return null

  if (
    options.providers !== undefined &&
    !options.providers.has(String(failure.providerID ?? "").toLowerCase())
  ) {
    return null
  }

  const message = String(failure.message ?? "").toLowerCase()
  const body = String(failure.body ?? "").toLowerCase()
  const haystack = message.length > 0 ? `${message}\n${body}` : body
  const allPatterns = [...GEO_PATTERNS, ...options.patterns]
  if (!allPatterns.some((pattern) => haystack.includes(pattern.toLowerCase()))) {
    return null
  }

  // OpenCode 2.1.1 reports the upcoming physical attempt. The first failure
  // arrives as 2, so with an explicit cap, attempts 2..1+maxRetries are the
  // forced retries. Stopping at `>= 1 + maxRetries` drops the last one and
  // shifts every delay up by the multiplier. The first forced retry waits
  // baseDelay. Infinity is indefinite: OpenCode's built-in schedule (10
  // retries per model call) stops asking the hook for us, and then classifies
  // the failure on its own.
  if (attempt > 1 + options.maxRetries) return null

  const delay = options.baseDelay * Math.pow(options.multiplier, attempt - 2)
  return { retry: true, delay: Math.min(delay, options.maxDelay) }
}

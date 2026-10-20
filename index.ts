import { Plugin } from "@opencode/plugin"
import { decide, resolveOptions } from "./retry.ts"

/**
 * Retries the spurious OpenAI "Country, region, or territory not supported"
 * failure. OpenCode classifies that 403 as terminal and lets the turn die in
 * an error state; this plugin overrides the retry decision at OpenCode's
 * retry-policy hook, so the same request is issued again — the treatment
 * transient network errors like ECONNRESET already get.
 */
export default Plugin.define({
  id: "openai-region-retry",
  async setup(ctx) {
    const options = resolveOptions(ctx.options)

    const registration = await ctx.session.hook("retry", (event) => {
      const decision = decide(
        {
          attempt: event.attempt,
          message: event.error.message,
          providerID: event.model.providerID,
          body: event.error.response?.body,
        },
        options,
      )
      // Only override when this plugin matched the failure; otherwise leave
      // OpenCode's classification (and any earlier plugin's decision) intact.
      if (decision) event.decision = decision
    })

    return () => registration.dispose()
  },
})

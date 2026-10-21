import { test } from "node:test"
import assert from "node:assert/strict"
import { makeTempProject, runOpenCode, startMockServer } from "./helpers.ts"

const PROMPT = "Reply with exactly MOCK_OK and nothing else"

function counts(mock: { count(): number; agentCount(): number; titleCount(): number }): string {
  return `agent=${mock.agentCount()} title=${mock.titleCount()} total=${mock.count()}`
}

test("recovers from repeated OpenAI region errors through a real opencode session", async () => {
  const mock = await startMockServer(2) // two agent geo 403s, then success
  const project = await makeTempProject(mock.url)
  try {
    const run = await runOpenCode(["run", "--standalone", "--format", "json", PROMPT], project.dir)
    const detail = `code=${run.code} ${counts(mock)}\nSTDOUT:\n${run.stdout}\nSTDERR:\n${run.stderr}`

    // Two agent failures, then the retry hook's third agent request succeeds.
    // The parallel title call must not be one of those three.
    assert.equal(mock.agentCount(), 3, `expected 3 agent requests\n${detail}`)
    assert.ok(mock.titleCount() >= 1, `expected the parallel title call\n${detail}`)
    assert.match(run.stdout, /MOCK_OK/, `assistant reply missing\n${detail}`)
    assert.equal(run.code, 0, `opencode run failed\n${detail}`)
  } finally {
    await project.cleanup()
    await mock.close()
  }
})

test("exhausts OpenCode's built-in retry schedule: 1 attempt + 10 forced retries, then the error surfaces", async () => {
  // Agent completions keep failing. A budget of 5 would let a sixth agent
  // request succeed and hide an extra retry.
  const mock = await startMockServer(Number.POSITIVE_INFINITY)
  const project = await makeTempProject(mock.url, {
    kind: "options-shim",
    // The plugin is indefinite by default now, so the run only ends when
    // OpenCode stops consulting the retry hook — 10 retries in 2.1.1. The
    // default backoff would need ~17 minutes to reach attempt 11, so the
    // shim mirrors index.ts with 10 ms flat waits instead.
    options: { maxRetries: Number.POSITIVE_INFINITY, baseDelay: 10, multiplier: 1 },
  })
  try {
    const run = await runOpenCode(["run", "--standalone", "--format", "json", PROMPT], project.dir)
    const detail = `code=${run.code} ${counts(mock)}\nSTDOUT:\n${run.stdout}\nSTDERR:\n${run.stderr}`

    // 1 initial attempt + 10 forced retries = exactly 11 agent requests.
    // OpenCode's built-in schedule is a hard limit the hook cannot exceed:
    // once its schedule is exhausted it stops calling the hook entirely.
    assert.equal(mock.agentCount(), 11, `expected exactly 11 agent requests\n${detail}`)
    assert.ok(mock.titleCount() >= 1, `expected the parallel title call\n${detail}`)
    assert.match(run.stdout, /provider\.auth/, `expected the error to surface\n${detail}`)
    assert.match(run.stdout, /Country, region, or territory not supported/, `expected the error text\n${detail}`)
    assert.notEqual(run.code, 0, `expected non-zero exit when giving up\n${detail}`)
  } finally {
    await project.cleanup()
    await mock.close()
  }
})

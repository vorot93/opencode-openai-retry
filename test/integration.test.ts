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

test("stops forcing retries once the attempt cap is reached", async () => {
  // Agent completions keep failing. A budget of 5 would let a sixth agent
  // request succeed and hide an extra retry.
  const mock = await startMockServer(Number.POSITIVE_INFINITY)
  const project = await makeTempProject(mock.url)
  try {
    const run = await runOpenCode(["run", "--standalone", "--format", "json", PROMPT], project.dir)
    const detail = `code=${run.code} ${counts(mock)}\nSTDOUT:\n${run.stdout}\nSTDERR:\n${run.stderr}`

    // 1 initial attempt + 4 forced retries = exactly 5 agent requests, then stop.
    assert.equal(mock.agentCount(), 5, `expected exactly 5 agent requests\n${detail}`)
    assert.ok(mock.titleCount() >= 1, `expected the parallel title call\n${detail}`)
    assert.match(run.stdout, /provider\.auth/, `expected the error to surface\n${detail}`)
    assert.match(run.stdout, /Country, region, or territory not supported/, `expected the error text\n${detail}`)
    assert.notEqual(run.code, 0, `expected non-zero exit when giving up\n${detail}`)
  } finally {
    await project.cleanup()
    await mock.close()
  }
})

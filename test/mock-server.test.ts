import { test } from "node:test"
import assert from "node:assert/strict"
import { request } from "node:http"
import { startMockServer } from "./helpers.ts"

const TITLE_BODY = JSON.stringify({
  stream: true,
  messages: [
    {
      role: "system",
      content: "You are a title generator. You output ONLY a thread title. Nothing else.",
    },
    { role: "user", content: "Reply with exactly MOCK_OK and nothing else" },
  ],
})

const AGENT_BODY = JSON.stringify({
  stream: true,
  messages: [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Reply with exactly MOCK_OK and nothing else" },
  ],
})

function post(url: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url + "/v1/chat/completions", { method: "POST" }, (res) => {
      res.resume()
      res.on("end", () => resolve(res.statusCode ?? 0))
    })
    req.on("error", reject)
    req.end(body)
  })
}

test("agent completions keep failing when the agent budget never runs out", async () => {
  const mock = await startMockServer(Number.POSITIVE_INFINITY)
  try {
    assert.equal(await post(mock.url, TITLE_BODY), 200)
    for (let i = 0; i < 6; i++) assert.equal(await post(mock.url, AGENT_BODY), 403)
    assert.equal(mock.agentCount(), 6)
    assert.equal(mock.titleCount(), 1)
  } finally {
    await mock.close()
  }
})

test("an interleaved title completion does not spend the agent failure budget", async () => {
  const mock = await startMockServer(2)
  try {
    assert.equal(await post(mock.url, TITLE_BODY), 200)
    assert.equal(await post(mock.url, AGENT_BODY), 403)
    assert.equal(await post(mock.url, TITLE_BODY), 200)
    assert.equal(await post(mock.url, AGENT_BODY), 403)
    assert.equal(await post(mock.url, AGENT_BODY), 200)
    assert.equal(mock.agentCount(), 3)
    assert.equal(mock.titleCount(), 2)
  } finally {
    await mock.close()
  }
})

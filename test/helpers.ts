import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const REPO = fileURLToPath(new URL("..", import.meta.url))

const GEO_BODY = JSON.stringify({
  error: {
    message: "Country, region, or territory not supported",
    type: "invalid_request_error",
    code: "unsupported_country_region_territory",
  },
})

export interface MockServer {
  url: string
  count(): number
  agentCount(): number
  titleCount(): number
  close(): Promise<void>
}

/**
 * OpenCode 2.1.1's title agent system prompt. A completion whose body contains
 * this is a title call, not the agent turn. Checked against the installed
 * 2.1.1 binary; if that prompt changes, title calls get counted as agent calls
 * and the cap test fails closed.
 */
const TITLE_MARK = "You are a title generator"

/**
 * OpenAI chat-completions mock. `agentFailures` is how many agent completions
 * return the geo 403 before one succeeds. `Infinity` never lets an agent
 * completion succeed. Title completions always succeed and do not spend that
 * budget — a shared counter lets the parallel title call consume a failure
 * the agent turn needed.
 */
export async function startMockServer(agentFailures: number): Promise<MockServer> {
  let requests = 0
  let agentRequests = 0
  let titleRequests = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      let request = ""
      req.on("data", (chunk) => void (request += chunk))
      req.on("end", () => {
        let stream = false
        try {
          const parsed = JSON.parse(request) as { stream?: unknown }
          stream = parsed.stream === true
        } catch {
          res.writeHead(400).end("invalid json")
          return
        }
        const title = request.includes(TITLE_MARK)
        requests += 1
        if (title) titleRequests += 1
        else agentRequests += 1
        if (!title && agentRequests <= agentFailures) {
          res.writeHead(403, { "content-type": "application/json" }).end(GEO_BODY)
          return
        }
        res.writeHead(200, {
          "content-type": stream ? "text/event-stream" : "application/json",
        })
        if (stream) {
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: "MOCK_OK" }, finish_reason: null }],
            })}\n\n`,
          )
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\ndata: [DONE]\n\n`,
          )
        } else {
          res.write(
            JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion",
              created: 1,
              model: "mock-model",
              choices: [
                { index: 0, message: { role: "assistant", content: "MOCK_OK" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            }),
          )
        }
        res.end()
      })
      return
    }
    res.writeHead(404).end()
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("unexpected server address"))
        return
      }
      resolve(address.port)
    })
  })

  return {
    url: `http://127.0.0.1:${port}`,
    count: () => requests,
    agentCount: () => agentRequests,
    titleCount: () => titleRequests,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}

interface Result {
  code: number
  stdout: string
  stderr: string
}

/**
 * Environment for an OpenCode child. User config, skills, and plugins live
 * under the real home (`~/.config/opencode`, `~/.agents`, `~/.claude`).
 * OpenCode 2.1.1 reads `OPENCODE_TEST_HOME` for that home and
 * `OPENCODE_CONFIG_DIR` for the global config directory; XDG roots are
 * captured at process start, so they are set too. `--standalone` does not
 * do this.
 */
export function openCodeEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    OPENCODE_TEST_HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    OPENCODE_CONFIG_DIR: join(homeDir, ".config", "opencode"),
    XDG_DATA_HOME: join(homeDir, ".local", "share"),
    XDG_STATE_HOME: join(homeDir, ".local", "state"),
    XDG_CACHE_HOME: join(homeDir, ".cache"),
  }
}

function execCaller(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0
        resolve({ code, stdout: cleanOutput(String(stdout)), stderr: cleanOutput(String(stderr)) })
      },
    )
  })
}

/**
 * Run the OpenCode CLI; non-zero exit codes are returned, not thrown, since
 * they are often the behavior under test (a terminal error reaching the user).
 *
 * `script -qec` is a pty wrapper: OpenCode's `run` hangs (exit 130) when
 * spawned without a tty, which the harness shell provides naturally but a
 * plain child_process spawn does not.
 */
export async function runOpenCode(
  args: string[],
  cwd: string,
  timeoutMs = 90_000,
): Promise<Result> {
  const homeDir = join(cwd, ".home")
  await mkdir(homeDir, { recursive: true })
  const link = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`
  return execCaller(
    "script",
    ["-qec", ["opencode", ...args].map(link).join(" "), "/dev/null"],
    cwd,
    timeoutMs,
    openCodeEnv(homeDir),
  )
}

function cleanOutput(text: string): string {
  return text
    .replaceAll("\r", "")
    // eslint-disable-next-line no-control-regex
    .replaceAll(/\[[0-9;]*[a-zA-Z]/g, "")
}

export interface TempProject {
  dir: string
  cleanup(): Promise<void>
}

/**
 * Temp git project with the plugin auto-loaded through `.opencode/plugins/`
 * (the loading shape that works in OpenCode 2.1.1) symlinked to the REPO,
 * with the default model wired to the mock server.
 */
export async function makeTempProject(mockUrl: string): Promise<TempProject> {
  const dir = await mkdtemp("/tmp/opencode/openai-retry-e2e-")
  try {
    await mkdir(join(dir, ".opencode/plugins"), { recursive: true })
    await symlink(REPO, join(dir, ".opencode/plugins", "opencode-openai-retry"))
    await writeFile(
      join(dir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "mockai/mock-model",
        providers: {
          mockai: {
            name: "MockAI",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `${mockUrl}/v1`, apiKey: "test-key" },
            models: { "mock-model": { name: "Mock Model" } },
          },
        },
      }),
    )

    const init = await execCaller("git", ["init", "-q"], dir, 15_000)
    if (init.code !== 0) throw new Error(`git init failed: ${init.stderr}`)
    const commit = await execCaller(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "--allow-empty", "-q", "-m", "init"],
      dir,
      15_000,
    )
    if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr}`)

    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import { openCodeEnv } from "./helpers.ts"

test("the opencode child env does not point at the user home or config", () => {
  const env = openCodeEnv("/tmp/opencode/isolated-home")
  assert.equal(env.HOME, "/tmp/opencode/isolated-home")
  assert.equal(env.OPENCODE_TEST_HOME, "/tmp/opencode/isolated-home")
  assert.equal(env.XDG_CONFIG_HOME, "/tmp/opencode/isolated-home/.config")
  assert.equal(env.OPENCODE_CONFIG_DIR, "/tmp/opencode/isolated-home/.config/opencode")
  assert.equal(env.XDG_DATA_HOME, "/tmp/opencode/isolated-home/.local/share")
  assert.notEqual(env.HOME, os.homedir())
  assert.ok(!String(env.OPENCODE_CONFIG_DIR).startsWith(os.homedir()))
})

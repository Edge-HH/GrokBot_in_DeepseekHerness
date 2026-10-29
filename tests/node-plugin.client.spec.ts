import assert from 'node:assert/strict'
import { it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'

it('mounts as the host half of the browser-only plugin', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(plugin)

  await fiber.await()
  assert.equal(typeof plugin.apply, 'function')
  await fiber.dispose()
})

/**
 * 助手 provider 映射层的离线回归（不需要 Electron，系统 Node 24 即可跑）
 *
 * 守住的是三类「不会报错但行为是错的」失败：
 * - 模型根本没注册进 pi，助手表现为「没有可用模型」，而真实原因是一个字段名写错；
 * - 注册给 pi 的模型名用了 Torra 内部 id，端点回 404，助手表现为「发消息没响应」；
 * - API Key 泄漏进落盘配置或注册表，钥匙串加密就白做了。
 *
 * 运行：npm run test:assistant
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import type { ModelConfig } from '../src/shared/types'
import {
  applyModelKey,
  createAssistantRuntime,
  isUsableApiModel,
  piProviderId,
} from '../src/main/assistant/provider'

const REAL_KEY = 'sk-torra-should-never-touch-disk-42'

let pass = 0
let fail = 0

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
    console.log(`       ${(e as Error).message.split('\n')[0]}`)
  }
}

function apiModel(over: Partial<ModelConfig> & { id: string }): ModelConfig {
  return {
    displayName: over.id,
    transport: 'api',
    color: '#888',
    supportsStructuredOutput: true,
    enabled: true,
    api: {
      baseUrl: 'https://api.example.com/v1',
      model: 'some-model',
      apiKeyRef: `${over.id}:key`,
      protocol: 'openai',
      pricePerMTokIn: 1,
      pricePerMTokOut: 2,
      maxContextTokens: 128000,
    },
    ...over,
  } as ModelConfig
}

async function main(): Promise<void> {
  console.log('\n助手 provider 映射回归\n' + '='.repeat(46))

  await it('isUsableApiModel 排除网页通道、停用项与缺端点的模型', () => {
    assert.equal(isUsableApiModel(apiModel({ id: 'ok' })), true)
    assert.equal(isUsableApiModel(apiModel({ id: 'w', transport: 'webview' })), false)
    assert.equal(isUsableApiModel(apiModel({ id: 'd', enabled: false })), false)
    assert.equal(isUsableApiModel(apiModel({ id: 'n', api: undefined })), false)
    assert.equal(
      isUsableApiModel(apiModel({ id: 'b', api: { ...apiModel({ id: 'b' }).api!, baseUrl: '  ' } })),
      false,
    )
  })

  const models: ModelConfig[] = [
    apiModel({ id: 'gpt-like', api: { ...apiModel({ id: 'gpt-like' }).api!, model: 'gpt-upstream' } }),
    apiModel({
      id: 'claude-like',
      api: {
        ...apiModel({ id: 'claude-like' }).api!,
        baseUrl: 'https://anthropic.example.com/v1/',
        model: 'claude-upstream',
        protocol: 'anthropic',
        maxContextTokens: 200000,
      },
    }),
    // 与 gpt-like 同名不同端点：单 provider 装所有模型时这两个会互相顶掉
    apiModel({
      id: 'same-name',
      api: { ...apiModel({ id: 'same-name' }).api!, baseUrl: 'https://other.example.com/v1', model: 'gpt-upstream' },
    }),
    apiModel({ id: 'off', enabled: false }),
    apiModel({ id: 'web', transport: 'webview' }),
  ]

  const dir = mkdtempSync(path.join(os.tmpdir(), 'torra-assistant-test-'))
  const { runtime, models: listed } = await createAssistantRuntime({
    userDataDir: dir,
    models,
    hasKey: (ref) => ref === 'gpt-like:key',
  })

  await it('只注册可用的 API 模型，并给出 Torra id → pi provider/模型名 的对应', () => {
    assert.deepEqual(
      listed.map((m) => m.id).sort(),
      ['claude-like', 'gpt-like', 'same-name'],
    )
    assert.equal(listed.find((m) => m.id === 'gpt-like')?.hasKey, true)
    assert.equal(listed.find((m) => m.id === 'claude-like')?.hasKey, false)
    // 尾部斜杠必须剥掉：pi 会自己拼 /chat/completions，双斜杠会变 404
    assert.equal(listed.find((m) => m.id === 'claude-like')?.baseUrl, 'https://anthropic.example.com/v1')
    assert.equal(listed.find((m) => m.id === 'gpt-like')?.providerId, 'torra-gpt-like')
    assert.equal(listed.find((m) => m.id === 'gpt-like')?.modelId, 'gpt-upstream')
  })

  await it('注册给 pi 的模型名是服务端侧的名字，不是 Torra 内部 id', () => {
    // 请求体里的 model 直接取 Model.id。写过一次 cfg.id，端点回的是
    // 「404 api-user-xxx is not supported」—— 助手表现为「发消息没反应」。
    const oai = runtime.getModel(piProviderId('gpt-like'), 'gpt-upstream')
    assert.ok(oai, '按上游模型名查不到注册结果')
    assert.equal(oai!.id, 'gpt-upstream')
    assert.equal(oai!.name, 'gpt-like')
    assert.equal(runtime.getModel(piProviderId('gpt-like'), 'gpt-like'), undefined)
  })

  await it('同名模型分属各自的 provider，端点不互相覆盖', () => {
    const a = runtime.getModels(piProviderId('gpt-like'))
    const b = runtime.getModels(piProviderId('same-name'))
    assert.equal(a.length, 1)
    assert.equal(b.length, 1)
    assert.equal(a[0]!.baseUrl, 'https://api.example.com/v1')
    assert.equal(b[0]!.baseUrl, 'https://other.example.com/v1')
  })

  await it('协议映射到 pi 的 api 名，元数据取保守值', () => {
    const oai = runtime.getModel(piProviderId('gpt-like'), 'gpt-upstream')
    const ant = runtime.getModel(piProviderId('claude-like'), 'claude-upstream')
    assert.ok(oai && ant)
    assert.equal(oai!.api, 'openai-completions')
    assert.equal(oai!.baseUrl, 'https://api.example.com/v1')
    assert.equal(oai!.provider, piProviderId('gpt-like'))
    assert.equal(oai!.contextWindow, 128000)
    assert.equal(oai!.maxTokens, 8192)
    assert.deepEqual(oai!.input, ['text'])
    assert.equal(oai!.reasoning, false)
    assert.equal(oai!.compat?.supportsDeveloperRole, false)
    assert.equal(oai!.compat?.maxTokensField, 'max_tokens')
    // anthropic 通道不套 OpenAI 的 compat 覆盖
    assert.equal(ant!.api, 'anthropic-messages')
    assert.equal(ant!.compat, undefined)
    assert.equal(ant!.contextWindow, 200000)
  })

  await it('未注入 key 时 provider 判定为未配置', () => {
    assert.equal(runtime.hasConfiguredAuth(piProviderId('gpt-like')), false)
  })

  await it('applyModelKey 注入内存 key 后模型可用，且不落进注册表配置', async () => {
    const model = await applyModelKey(runtime, 'gpt-like', REAL_KEY)
    assert.equal(model.id, 'gpt-upstream')
    assert.equal(runtime.hasConfiguredAuth(piProviderId('gpt-like')), true)
    const cfg = runtime.getRegisteredProviderConfig(piProviderId('gpt-like'))
    assert.ok(cfg)
    assert.doesNotMatch(JSON.stringify(cfg), /should-never-touch-disk/)
    // auth.json 只是路径占位，key 走内存覆盖层，不该被写出来
    const authFile = path.join(dir, 'pi', 'auth.json')
    const exists = require('node:fs').existsSync(authFile) as boolean
    if (exists) {
      assert.doesNotMatch(require('node:fs').readFileSync(authFile, 'utf8'), /should-never-touch-disk/)
    }
  })

  await it('每个模型的 key 各存各的，换模型不会把上一个顶掉', async () => {
    await applyModelKey(runtime, 'gpt-like', REAL_KEY)
    await applyModelKey(runtime, 'claude-like', 'sk-other')
    const got = await runtime.getAuth(piProviderId('claude-like'))
    assert.equal(got?.auth.apiKey, 'sk-other')
    const kept = await runtime.getAuth(piProviderId('gpt-like'))
    assert.equal(kept?.auth.apiKey, REAL_KEY)
  })

  await it('未知模型 / 空 key 明确抛错，不静默返回 undefined', async () => {
    await assert.rejects(() => applyModelKey(runtime, 'nope', REAL_KEY), /尚未注册/)
    await assert.rejects(() => applyModelKey(runtime, 'gpt-like', ''), /缺少 API Key/)
  })

  console.log(`${'-'.repeat(46)}\n${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

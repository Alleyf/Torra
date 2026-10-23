import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { brandDomainFor } from '../src/shared/model-brand'
import { homepageDomainFor, iconDomainChain } from '../src/shared/model-brand'

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    fail++
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${(e as Error).message.split('\n').slice(0, 4).join('\n         ')}`)
  }
}

console.log('\n=== API 模型品牌图标归一 ===\n')

it('网页模型沿用已知站点域名', () => {
  assert.equal(brandDomainFor({ transport: 'webview', domain: 'chat.deepseek.com' }), 'chat.deepseek.com')
})

it('官方 API 主机映射到品牌主站', () => {
  assert.equal(brandDomainFor({ transport: 'api', baseUrl: 'https://api.openai.com/v1', model: 'x' }), 'openai.com')
  assert.equal(brandDomainFor({ transport: 'api', baseUrl: 'https://api.deepseek.com/v1', model: 'x' }), 'deepseek.com')
  assert.equal(
    brandDomainFor({ transport: 'api', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'x' }),
    'google.com',
  )
})

it('中转站仍优先显示模型本身的品牌', () => {
  assert.equal(
    brandDomainFor({
      transport: 'api',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.5',
    }),
    'anthropic.com',
  )
  assert.equal(
    brandDomainFor({
      transport: 'api',
      baseUrl: 'https://gateway.example.com/v1',
      model: 'deepseek-v4-flash',
    }),
    'deepseek.com',
  )
})

it('本地与内网端点不生成公网 favicon', () => {
  assert.equal(
    brandDomainFor({
      transport: 'api',
      baseUrl: 'http://127.0.0.1:3425/v1',
      model: 'group/never-stuck',
      displayName: 'magpie',
    }),
    undefined,
  )
  assert.equal(brandDomainFor({ transport: 'api', baseUrl: 'http://localhost:8080/v1', model: 'x' }), undefined)
  assert.equal(brandDomainFor({ transport: 'api', baseUrl: 'http://192.168.1.5/v1', model: 'x' }), undefined)
})

it('未知公网端点退回父域名，至少有统一兜底图源', () => {
  assert.equal(brandDomainFor({ transport: 'api', baseUrl: 'https://api.acme-llm.com/v1', model: 'private-model' }), 'acme-llm.com')
})

it('favicon.im 是主进程首选源并请求 64px 尺寸', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/net/favicon-cache.ts'), 'utf8')
  const im = src.indexOf('https://favicon.im/')
  const iowen = src.indexOf('https://api.iowen.cn/')
  assert.ok(im >= 0 && iowen >= 0, '两个 favicon 源都必须保留')
  assert.ok(im < iowen, 'favicon.im 实测可用，应排在经常超时的 iowen 前面')
  assert.match(src, /favicon\.im\/\$\{domain\}\?size=64/)
})

it('主页 URL 取 favicon 域名：公网站点按它自己取', () => {
  assert.equal(homepageDomainFor('https://www.deepseek.com'), 'www.deepseek.com')
  assert.equal(homepageDomainFor('https://openrouter.ai/models'), 'openrouter.ai')
})

it('主页 URL 非法或内网时不产生图标域名', () => {
  assert.equal(homepageDomainFor(''), undefined)
  assert.equal(homepageDomainFor('not a url'), undefined)
  assert.equal(homepageDomainFor('file:///etc/passwd'), undefined)
  assert.equal(homepageDomainFor('http://127.0.0.1:3425'), undefined)
  assert.equal(homepageDomainFor('http://192.168.1.5'), undefined)
})

it('图标候选链：自定义 → Base URL 域名 → 主页域名', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/components/ModelAvatar.tsx'), 'utf8')
  const custom = src.indexOf('model.iconUrl')
  const chain = src.indexOf('iconDomainChain(model.domain, model.homepage)')
  assert.ok(custom >= 0 && chain >= 0, '自定义图标与域名链都要在')
  assert.ok(custom < chain, '自定义图标排在最前')
})

it('图标域名顺序：Base URL 在前，主页在后', () => {
  assert.deepEqual(iconDomainChain('api.deepseek.com', 'https://www.deepseek.com'), [
    'api.deepseek.com',
    'www.deepseek.com',
  ])
  assert.deepEqual(iconDomainChain(undefined, 'https://openrouter.ai'), ['openrouter.ai'])
  assert.deepEqual(iconDomainChain('a.com', 'https://a.com'), ['a.com'], '同域名不重复')
  assert.deepEqual(iconDomainChain(undefined, undefined), [])
})

console.log(`\n  通过 ${pass} · 失败 ${fail}\n`)
if (fail > 0) process.exit(1)

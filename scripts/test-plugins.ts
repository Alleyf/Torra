/**
 * 应用插件内核的离线回归（不需要 Electron、不联网、不启动应用）。
 *
 * 这一层最容易出的错不是「崩溃」，而是**边界被悄悄放宽**：
 * 清单多认一个字段、zip 少拦一条路径、面板 SDK 被插件脚本覆盖、能力清单
 * 升级后继续沿用旧授权。所以用例全部围着这些不变量写，而不是围着正常路径。
 *
 * 运行：npm run test:plugins
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { loadManifest } from '../src/main/plugins/manifest'
import { extractZip, ZipError } from '../src/main/plugins/zip'
import { PluginStorage } from '../src/main/plugins/storage'
import { PANEL_MAX_BYTES, injectPanel } from '../src/main/plugins/panel'
import { TORRA_UI_FRAME_MAX_BYTES, torraUiFrameUrl } from '../src/shared/ui-frame'
import { AI_PROMPT_MAX_CHARS, AI_SYSTEM_MAX_CHARS, pickPluginModel } from '../src/main/plugins/ai'
import { PluginRuntime, pluginChildEnv } from '../src/main/plugins/host'
import type { PluginManifest } from '../src/shared/plugins'
import type { ModelConfig } from '../src/shared/types'

const localRequire = createRequire(__filename)
const ROOT = path.resolve(__dirname, '..')
/** 科研工作台：三个模块合并成一个插件，模块代码原样放在 modules/ 下面 */
const RESEARCH_DIR = path.join(ROOT, 'plugins', 'research')
const TRAJECTORY_DIR = path.join(RESEARCH_DIR, 'modules', 'trajectory')
const SCHOLAR_DIR = path.join(RESEARCH_DIR, 'modules', 'scholar')
const SERVER_DIR = path.join(RESEARCH_DIR, 'modules', 'server')
const TECH_DIR = path.join(ROOT, 'plugins', 'tech')
const manifest = JSON.parse(readFileSync(path.join(RESEARCH_DIR, 'torra-plugin.json'), 'utf8')) as {
  contributes: { tools: Array<{ name: string }> }
}
const techManifest = JSON.parse(readFileSync(path.join(TECH_DIR, 'torra-plugin.json'), 'utf8')) as {
  contributes: { tools: Array<{ name: string }> }
}
const RESEARCH_TOOL_NAMES = manifest.contributes.tools.map((t) => t.name)

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

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'torra-plugin-'))
}

/** 写一个最小的 zip：只为触发解包器的闸门，CRC 不参与校验（解包器不验它） */
function makeZip(entries: Array<{ name: string; data: Buffer; method?: number; mode?: number }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const method = entry.method ?? 0
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

async function main(): Promise<void> {
  console.log('\n应用插件内核')

  await it('科研工作台：三个模块合成一个插件，能力清单是三者的并集', () => {
    const r = loadManifest(RESEARCH_DIR)
    assert.equal(r.ok, true, r.ok ? '' : r.errors.join('；'))
    if (!r.ok) return
    assert.equal(r.manifest.id, 'research')
    assert.deepEqual([...r.manifest.permissions].sort(), [
      'ai',
      'net:api.crossref.org',
      'net:api.openalex.org',
      'net:cdn-mineru.openxlab.org.cn',
      'net:export.arxiv.org',
      'net:mineru.net',
      'net:www.ebi.ac.uk',
      'panel',
      'secrets',
      'storage',
      'tools',
    ])
    assert.equal(r.manifest.secrets?.[0]?.name, 'openalex', 'OpenAlex 的 Key 要在清单里声明，设置页才列得出来')
    assert.equal(r.manifest.secrets?.[0]?.optional, true, '不填也能用匿名额度，不能标成必填')
    for (const tool of r.manifest.contributes?.tools ?? []) {
      assert.ok(tool.name.startsWith('research_'), `工具名前缀：${tool.name}`)
    }
    // 三个模块的入口都得在，别合并出一半
    for (const rel of [
      'main.js',
      'modules/scholar/main.js',
      'modules/scholar/ai.js',
      'modules/trajectory/main.js',
      'modules/trajectory/ai.js',
      'modules/server/main.js',
      'modules/scholar/ui.html',
      'modules/trajectory/ui.html',
      'modules/server/ui.html',
    ]) {
      assert.ok(existsSync(path.join(RESEARCH_DIR, rel)), `缺少 ${rel}`)
    }
    const injected = injectPanel(readFileSync(path.join(RESEARCH_DIR, 'ui.html'), 'utf8'), 'tok-r', 'research', 'dark')
    assert.ok(Buffer.byteLength(injected) <= TORRA_UI_FRAME_MAX_BYTES, `面板 ${Buffer.byteLength(injected)}B 超过帧上限`)
  })

  await it('合并后的模块各自带命名空间：工具、接口、存储键都不打架', async () => {
    const backend = await loadBackend(RESEARCH_DIR, 'research')
    const toolNames = Object.keys(backend.tools).sort()
    assert.deepEqual(toolNames, [...RESEARCH_TOOL_NAMES].sort(), '聚合后的工具要跟清单一一对上')
    // 接口名带模块前缀：学者和主线都有 project.list，不加前缀就是静默覆盖
    assert.ok(backend.rpc['scholar.paper.list'], '学者接口应有 scholar. 前缀')
    assert.ok(backend.rpc['trajectory.project.list'], '主线接口应有 trajectory. 前缀')
    assert.ok(backend.rpc['server.server.list'], '看板接口应有 server. 前缀')
    assert.equal(backend.rpc['project.list'], undefined, '不能留下没有前缀的接口')
    assert.equal(backend.rpc['ai.plan'], undefined, 'AI 接口也要分模块')

    // 存储键同样分前缀：三个模块都写过 state
    await backend.rpc['scholar.paper.add']!({ title: '纸', doi: '10.1/x' })
    const created = (await backend.rpc['trajectory.project.create']!({ title: '课题' })) as { project: { id: string } }
    assert.ok(created.project.id, '主线项目要建得起来')
    await backend.rpc['server.server.add']!({ label: '机', host: 'h1', user: 'u1' })
    const keys = backend.keys()
    assert.ok(keys.includes('scholar:state'), `学者状态键没带上前缀：${keys.join(',')}`)
    assert.ok(keys.includes('trajectory:state'), `主线状态键没带上前缀：${keys.join(',')}`)
    assert.ok(keys.includes('server:servers'), `看板服务器键没带上前缀：${keys.join(',')}`)
  })

  await it('技术工作台：清单、面板与域名白名单都在闸门之内', () => {
    const r = loadManifest(TECH_DIR)
    assert.equal(r.ok, true, r.ok ? '' : r.errors.join('；'))
    if (!r.ok) return
    assert.equal(r.manifest.id, 'tech')
    assert.deepEqual([...r.manifest.permissions].sort(), [
      'net:aihot.news',
      'net:github.com',
      'net:hn.algolia.com',
      'net:www.aipromonow.com',
      'panel',
      'storage',
      'tools',
    ])
    for (const tool of r.manifest.contributes?.tools ?? []) {
      assert.ok(tool.name.startsWith('tech_'), `工具名前缀：${tool.name}`)
    }
    const injected = injectPanel(readFileSync(path.join(TECH_DIR, 'ui.html'), 'utf8'), 'tok-t', 'tech', 'dark')
    assert.ok(Buffer.byteLength(injected) <= TORRA_UI_FRAME_MAX_BYTES, `面板 ${Buffer.byteLength(injected)}B 超过帧上限`)
  })

  await it('技术工作台：热点归一化、日期口径与社区榜解析', async () => {
    const tech = localRequire(path.join(TECH_DIR, 'main.js')) as {
      normalizeHot: (payload: unknown) => Array<Record<string, unknown>>
      normalizeItems: (payload: unknown) => Array<Record<string, unknown>>
      normalizeDaily: (payload: unknown) => Record<string, unknown>
      parseHn: (payload: unknown) => Array<Record<string, unknown>>
      parseGithubTrending: (html: string) => Array<Record<string, unknown>>
      daysBetween: (from: string, to: string) => number
      localDayOf: (iso: string) => string
      exportMarkdown: (items: Array<Record<string, unknown>>) => string
    }
    const hot = tech.normalizeHot({
      items: [
        {
          rank: 1,
          id: 'a',
          title: '标题',
          source: { name: '某处' },
          links: { original: 'https://example.com/a' },
          sourceCount: 3,
          signalCount: 9,
          participantCount: 12,
          latestAt: '2026-10-30T00:00:00.000Z',
        },
      ],
    })
    assert.equal(hot.length, 1)
    assert.equal(hot[0]!.source, '某处')
    assert.equal(hot[0]!.signalCount, 9)

    const items = tech.normalizeItems({
      items: [{ id: 'b', title: '条目', summary: '摘要', score: 12, publishedAt: '2026-10-29T10:00:00.000Z' }],
    })
    assert.equal(items[0]!.score, 12)

    const daily = tech.normalizeDaily({
      report: {
        date: '2026-10-29',
        lead: { title: '导语', leadParagraph: '一段话' },
        sections: [{ label: '行业动态', items: [{ title: '一条' }] }],
      },
    })
    assert.equal((daily.sections as unknown[]).length, 1)

    const hn = tech.parseHn({ hits: [{ objectID: '1', title: 'HN', url: 'https://x.dev', points: 10, num_comments: 2 }] })
    assert.equal(hn[0]!.points, 10)

    const gh = tech.parseGithubTrending(
      '<article class="Box-row"><h2 class="h3"><a href="/owner/repo">x</a></h2>' +
        '<p class="col-9 color-fg-muted my-1 pr-4">说明</p>' +
        '<span itemprop="programmingLanguage">Python</span>' +
        '<a href="/owner/repo/stargazers"><svg aria-label="star"></svg> 1,234</a>' +
        '<span class="d-inline-block float-sm-right">56 stars today</span></article>',
    )
    assert.equal(gh.length, 1)
    assert.equal(gh[0]!.repo, 'owner/repo')
    assert.equal(gh[0]!.description, '说明')
    assert.equal(gh[0]!.starsToday, 56)

    assert.equal(tech.daysBetween('2026-10-30', '2026-10-29'), -1)
    assert.equal(tech.daysBetween('2026-10-29', '2026-10-30'), 1)
    assert.equal(tech.localDayOf('2026-10-29T23:30:00.000Z').length, 10)

    const md = tech.exportMarkdown([
      { title: '一条', url: 'https://x.dev', note: '想法', summary: '', tags: ['AI'], status: 'todo' },
    ])
    assert.match(md, /## 待读/)
    assert.match(md, /\[一条\]\(https:\/\/x\.dev\)/)
  })

  await it('技术工作台：AI 羊毛 RSS 解析出干净的链接与时间', () => {
    const tech = localRequire(path.join(TECH_DIR, 'main.js')) as {
      parsePromoRss: (xml: string) => Array<Record<string, string>>
    }
    const items = tech.parsePromoRss(
      '<?xml version="1.0" encoding="UTF-8" ?><rss version="2.0"><channel>' +
        '<item><title><![CDATA[送 100 美元 & 额度]]></title>' +
        '<link>https://www.aipromonow.com/promos/demo-deal?utm_source=rss&amp;utm_medium=referral</link>' +
        '<guid isPermaLink="true">https://www.aipromonow.com/promos/demo-deal</guid>' +
        '<description>前 GitHub CEO 的 &lt;b&gt;平台&lt;/b&gt;</description>' +
        '<pubDate>Thu, 29 Oct 2026 17:47:39 GMT</pubDate></item>' +
        '</channel></rss>',
    )
    assert.equal(items.length, 1)
    const item = items[0]!
    // 链接里的 utm 参数不能带进面板：收藏队列按它去重
    assert.equal(item.id, 'demo-deal')
    assert.equal(item.url, 'https://www.aipromonow.com/promos/demo-deal')
    assert.equal(item.title, '送 100 美元 & 额度')
    assert.equal(item.summary, '前 GitHub CEO 的 平台')
    assert.equal(item.publishedAt, '2026-10-29T17:47:39.000Z')
    assert.deepEqual(tech.parsePromoRss(''), [])
    assert.deepEqual(tech.parsePromoRss('<rss><channel></channel></rss>'), [])
  })

  await it('技术工作台：布局偏好存得下来，坏值回落到三列', async () => {
    const tech = localRequire(path.join(TECH_DIR, 'main.js')) as {
      activate: (ctx: unknown) => Promise<void>
      normalizeLayout: (value: unknown) => string
    }
    assert.equal(tech.normalizeLayout('list'), 'list')
    assert.equal(tech.normalizeLayout('grid2'), 'grid2')
    assert.equal(tech.normalizeLayout('grid3'), 'grid3')
    assert.equal(tech.normalizeLayout('grid9'), 'grid3')
    assert.equal(tech.normalizeLayout(undefined), 'grid3')

    const handlers = new Map<string, (params: unknown) => Promise<unknown>>()
    const store = new Map<string, unknown>()
    // 老用户的状态里没有 layout 字段，读出来要是默认三列
    store.set('state', { saved: [], keywords: [] })
    const ctx = {
      rpc: { handle: (name: string, fn: (params: unknown) => Promise<unknown>) => handlers.set(name, fn) },
      tools: { handle: () => undefined },
      storage: {
        get: async (key: string) => store.get(key),
        set: async (key: string, value: unknown) => { store.set(key, value) },
        list: async () => [...store.keys()],
        delete: async (key: string) => { store.delete(key) },
      },
      log: () => undefined,
      fetch: async () => ({ status: 200, body: '{}' }),
    }
    await tech.activate(ctx)
    const get = handlers.get('prefs.get')
    const set = handlers.get('prefs.set')
    assert.ok(get && set, '没有注册 prefs 接口')
    assert.deepEqual(await get({}), { layout: 'grid3' })
    assert.deepEqual(await set({ layout: 'grid2' }), { layout: 'grid2' })
    assert.deepEqual(await get({}), { layout: 'grid2' })
    assert.deepEqual(await set({ layout: 'grid9' }), { layout: 'grid3' })
  })

  await it('技术工作台：面板上的时间既认 ISO 串也认毫秒数，坏值不印 NaN', () => {
    const ui = readFileSync(path.join(TECH_DIR, 'ui.html'), 'utf8')
    // 面板帧不能加载外部脚本，这里按标记把时间helper抠出来单独跑
    const start = ui.indexOf('/* time-helpers:start')
    const end = ui.indexOf('/* time-helpers:end')
    assert.ok(start > 0 && end > start, '找不到时间helper标记')
    const factory = new Function(
      ui.slice(start, end) + '\nreturn { toMillis: toMillis, dateTime: dateTime, ago: ago, dayOf: dayOf }',
    ) as () => {
      toMillis: (ts: unknown) => number
      dateTime: (ts: unknown) => string
      ago: (ts: unknown) => string
      dayOf: (ts: unknown) => string
    }
    const { toMillis, dateTime, ago, dayOf } = factory()

    const iso = '2026-10-28T22:30:11.000Z'
    assert.equal(toMillis(iso), Date.parse(iso))
    assert.equal(toMillis(1761600000000), 1761600000000)
    assert.equal(toMillis('1761600000000'), 1761600000000)
    assert.equal(toMillis(''), 0)
    assert.equal(toMillis('不是时间'), 0)

    // 曾经这里按 Number(iso) 解析，页面上会印出 NaN-NaN NaN-NaN
    assert.ok(!/NaN/.test(dateTime(iso)), `ISO 时间被印成了 NaN：${dateTime(iso)}`)
    assert.match(dateTime(iso), /^\d{1,2}-\d{2} \d{2}:\d{2}$/)
    assert.equal(dateTime(''), '')
    assert.equal(dateTime('不是时间'), '')
    assert.match(ago(Date.now() - 3600000), /小时前/)

    // 羊毛的日期分类按本地日切分，跨时区的 UTC 时间要落到本地那一天
    const local = new Date(Date.parse(iso))
    const localKey = local.getFullYear() + '-' + String(local.getMonth() + 1).padStart(2, '0') + '-' +
      String(local.getDate()).padStart(2, '0')
    assert.equal(dayOf(iso), localKey)
    assert.equal(dayOf(Date.parse(iso)), localKey)
    assert.equal(dayOf(''), '')
    assert.equal(dayOf('不是时间'), '')
  })

  await it('技术工作台：「近 7 天重排」要顺着 cursor 往下翻，不能只看最新一页', async () => {
    const tech = localRequire(path.join(TECH_DIR, 'main.js')) as {
      activate: (ctx: unknown) => Promise<void>
      dayKey: () => string
      shiftDay: (key: string, delta: number) => string
    }
    // 目标日期取三天前：它落在 7 天窗口里，但肯定不在最新一页
    const target = tech.shiftDay(tech.dayKey(), -3)
    const iso = (day: string, hour: number) => `${day}T0${hour}:00:00.000Z`
    const makeItem = (id: string, day: string, hour: number, score: number) => ({
      id,
      title: `条目 ${id}`,
      summary: '',
      score,
      publishedAt: iso(day, hour),
      source: { name: '某处' },
      links: { original: `https://example.com/${id}` },
    })
    const pages: Record<string, unknown> = {
      '': {
        page: { hasMore: true, nextCursor: 'c2' },
        items: [makeItem('a', tech.shiftDay(target, 1), 3, 50), makeItem('b', target, 5, 40)],
      },
      c2: {
        page: { hasMore: false, nextCursor: '' },
        items: [makeItem('c', target, 9, 70)],
      },
    }
    const requested: string[] = []
    const handlers = new Map<string, (params: unknown) => Promise<unknown>>()
    const store = new Map<string, unknown>()
    const ctx = {
      rpc: { handle: (name: string, fn: (params: unknown) => Promise<unknown>) => handlers.set(name, fn) },
      tools: { handle: () => undefined },
      storage: {
        get: async (key: string) => store.get(key),
        set: async (key: string, value: unknown) => { store.set(key, value) },
        list: async () => [...store.keys()],
        delete: async (key: string) => { store.delete(key) },
      },
      log: () => undefined,
      fetch: async (input: { url: string }) => {
        const cursor = new URL(input.url).searchParams.get('cursor') ?? ''
        requested.push(cursor)
        return { status: 200, body: JSON.stringify(pages[cursor] ?? { page: { hasMore: false }, items: [] }) }
      },
    }
    await tech.activate(ctx)
    const hot = handlers.get('hot')
    assert.ok(hot, '没有注册 hot 接口')
    const payload = (await hot({ date: target })) as { mode: string; items: Array<{ title: string; score: number }> }
    assert.equal(payload.mode, 'rerank')
    assert.deepEqual(requested, ['', 'c2'], `翻页顺序不对：${requested.join(' → ')}`)
    // 目标那天的条目要收齐，并按评分从高到低排
    const titles = payload.items.map((item) => item.title)
    assert.ok(titles.includes('条目 c'), `第二页的条目没进来：${titles.join('、')}`)
    assert.ok(!titles.includes('条目 a'), '别的一天不该混进来')
    assert.equal(payload.items[0]!.score, 70, '同一天内应按评分重排')
  })

  await it('技术工作台：关键词雷达要把关键词的「文本」当成检索词，不能把整个对象传下去', async () => {
    const tech = localRequire(path.join(TECH_DIR, 'main.js')) as {
      activate: (ctx: unknown) => Promise<void>
    }
    const requested: string[] = []
    const handlers = new Map<string, (params: unknown) => Promise<unknown>>()
    const store = new Map<string, unknown>()
    store.set('state', { saved: [], keywords: [{ text: 'agent', createdAt: 1 }] })
    const ctx = {
      rpc: { handle: (name: string, fn: (params: unknown) => Promise<unknown>) => handlers.set(name, fn) },
      tools: { handle: () => undefined },
      storage: {
        get: async (key: string) => store.get(key),
        set: async (key: string, value: unknown) => { store.set(key, value) },
        list: async () => [...store.keys()],
        delete: async (key: string) => { store.delete(key) },
      },
      log: () => undefined,
      fetch: async (input: { url: string }) => {
        const url = new URL(input.url)
        requested.push(url.searchParams.get('q') ?? '')
        return {
          status: 200,
          body: JSON.stringify({ items: [{ id: 'x', title: '条目', summary: '', score: 10, publishedAt: '2026-10-29T10:00:00.000Z' }] }),
        }
      },
    }
    await tech.activate(ctx)
    const radar = handlers.get('radar')
    assert.ok(radar, '没有注册 radar 接口')
    const payload = (await radar({})) as { groups: Array<{ keyword: string; count: number }> }
    assert.equal(payload.groups[0]!.keyword, 'agent')
    assert.equal(payload.groups[0]!.count, 1, '关键词雷达没拿到条目')
    // 曾经这里传的是 keyword 对象，String() 之后变成 "[object Object]"，
    // 服务端不报错，只是静默返回空列表 —— 界面上只会看到「0 条」
    assert.deepEqual(requested, ['agent'], `检索词不对：${requested.join('、')}`)
    assert.ok(!requested.some((q) => q.includes('[object Object]')), '检索词被序列化成了 [object Object]')
  })

  await it('插件子进程保留 Windows OpenSSH 必需的系统环境', () => {
    const env = pluginChildEnv(
      {
        PATH: 'C:\\Windows\\System32\\OpenSSH',
        SystemRoot: 'C:\\Windows',
        ProgramData: 'C:\\ProgramData',
        USERPROFILE: 'C:\\Users\\tester',
        HOME: 'C:\\Users\\tester',
        SSH_AUTH_SOCK: '\\\\.\\pipe\\openssh-ssh-agent',
        API_TOKEN: 'must-not-leak',
      },
      { TORRA_PLUGIN_ID: 'server' },
    )
    assert.equal(env.ProgramData, 'C:\\ProgramData')
    assert.equal(env.SSH_AUTH_SOCK, '\\\\.\\pipe\\openssh-ssh-agent')
    assert.equal(env.TORRA_PLUGIN_ID, 'server')
    assert.equal(env.API_TOKEN, undefined, '插件环境不能继承任意宿主变量')
  })

  await it('未知字段 / 没声明的能力 / 越界入口都被拒绝', () => {
    const cases: Array<{ patch: Record<string, unknown>; pattern: RegExp }> = [
      { patch: { hooks: {} }, pattern: /没实现的字段/ },
      { patch: { main: '../outside.js' }, pattern: /跳出插件目录/ },
      { patch: { main: 'C:outside.js' }, pattern: /相对插件目录/ },
      {
        patch: {
          // 深拷一份：fixture 会按目录名改写工具前缀，直接传引用会污染顶层 manifest
          contributes: { panel: { title: 'x' }, tools: JSON.parse(JSON.stringify(manifest.contributes.tools)) },
          permissions: ['storage', 'tools'],
        },
        pattern: /需要 permissions 里声明 'panel'/,
      },
      // 申请页会被交给系统浏览器：file: / 自定义协议在这里放过去，等于多一条唤醒本机程序的口子
      { patch: { secrets: [{ name: 'svc', label: '服务密钥', url: 'file:///etc/passwd' }] }, pattern: /只支持 http\/https/ },
      // 名称要能直接拼进 plugin:<id>:<name>，大写与空格会让 host 在取值时才拒
      { patch: { secrets: [{ name: 'Bad Name', label: '服务密钥' }] }, pattern: /name 不合法/ },
    ]
    for (const item of cases) {
      const dir = tmpDir()
      try {
        const name = path.basename(dir)
        mkdirSync(path.join(dir, name))
        const base = JSON.parse(readFileSync(path.join(RESEARCH_DIR, 'torra-plugin.json'), 'utf8'))
        const merged = { ...base, ...item.patch }
        if (item.patch.contributes) merged.contributes = item.patch.contributes
        merged.id = name
        embeddedToolNames(merged, name)
        writeFileSync(path.join(dir, name, 'torra-plugin.json'), JSON.stringify(merged))
        writeFileSync(path.join(dir, name, 'main.js'), '')
        writeFileSync(path.join(dir, name, 'ui.html'), '')
        const r = loadManifest(path.join(dir, name))
        assert.equal(r.ok, false, `应被拒绝：${JSON.stringify(item.patch)}`)
        if (!r.ok) assert.match(r.errors.join('；'), item.pattern)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    // 声明了密钥却不肯申请 secrets 能力：用户填了插件也读不到，装的时候就要拦
    const dir = tmpDir()
    try {
      const name = path.basename(dir)
      mkdirSync(path.join(dir, name))
      const base = JSON.parse(readFileSync(path.join(RESEARCH_DIR, 'torra-plugin.json'), 'utf8'))
      base.id = name
      base.permissions = base.permissions.filter((p: string) => p !== 'secrets')
      embeddedToolNames(base, name)
      writeFileSync(path.join(dir, name, 'torra-plugin.json'), JSON.stringify(base))
      writeFileSync(path.join(dir, name, 'main.js'), '')
      writeFileSync(path.join(dir, name, 'ui.html'), '')
      const r = loadManifest(path.join(dir, name))
      assert.equal(r.ok, false, '有 secrets 声明就必须同时声明 secrets 能力')
      if (!r.ok) assert.match(r.errors.join('；'), /secrets.*permissions/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('zip：store 与 deflate 都能解出来', () => {
    const dir = tmpDir()
    try {
      const zip = path.join(dir, 'a.zip')
      writeFileSync(
        zip,
        makeZip([
          { name: 'torra-plugin.json', data: Buffer.from('{}') },
          { name: 'nest/main.js', data: Buffer.from('hello'), method: 8 },
        ]),
      )
      const out = path.join(dir, 'out')
      mkdirSync(out)
      assert.equal(extractZip(zip, out).files, 2)
      assert.equal(readFileSync(path.join(out, 'nest/main.js'), 'utf8'), 'hello')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('zip：路径穿越 / 符号链接 / 未知压缩方式全部拒绝', () => {
    const cases: Array<{ entry: Parameters<typeof makeZip>[0][number]; pattern: RegExp }> = [
      { entry: { name: '../escape.txt', data: Buffer.from('x') }, pattern: /跳出目录/ },
      { entry: { name: 'C:/escape.txt', data: Buffer.from('x') }, pattern: /绝对路径/ },
      { entry: { name: 'link', data: Buffer.from('/etc/passwd'), mode: 0o120777 }, pattern: /符号链接/ },
      { entry: { name: 'x.bin', data: Buffer.from('x'), method: 12 }, pattern: /不支持的压缩方式/ },
    ]
    for (const item of cases) {
      const dir = tmpDir()
      try {
        const zip = path.join(dir, 'bad.zip')
        writeFileSync(zip, makeZip([item.entry]))
        const out = path.join(dir, 'out')
        mkdirSync(out)
        assert.throws(
          () => extractZip(zip, out),
          (e: unknown) => e instanceof ZipError && item.pattern.test(e.message),
          item.entry.name,
        )
        assert.deepEqual(readdirSync(out), [], '拒绝时不能留下半截文件')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  await it('存储：坏键 / 单值超限被拒绝，写入是原子替换', () => {
    const dir = tmpDir()
    try {
      const store = new PluginStorage(path.join(dir, 'store.json'))
      store.set('a.b:c', { x: 1 })
      assert.deepEqual(store.get('a.b:c'), { x: 1 })
      assert.deepEqual(store.list(), ['a.b:c'])
      assert.equal(store.delete('a.b:c'), true)
      assert.equal(store.delete('a.b:c'), false)
      assert.throws(() => store.set('../x', 1), /存储键/)
      assert.throws(() => store.set('big', 'a'.repeat(1024 * 1024 + 8)), /单个值/)
      store.set('ok', 1)
      assert.deepEqual(readdirSync(dir), ['store.json'], '不能留下 .tmp')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('面板：注入 SDK 与主题，且仍在 torra-ui 帧上限内', () => {
    const html = readFileSync(path.join(TRAJECTORY_DIR, 'ui.html'), 'utf8')
    const injected = injectPanel(html, 'tok-123', 'trajectory', 'light')
    assert.match(injected, /<html[^>]*data-theme="light"/)
    assert.ok(injected.includes('data-torra-plugin="sdk"'))
    assert.ok(injected.indexOf('window.torraPlugin') < injected.indexOf('KINDS'))
    assert.ok(injected.includes('"tok-123"'))
    assert.equal((injected.match(/<html[^>]*data-theme=/g) ?? []).length, 1, '只应有一份 data-theme')
    const url = torraUiFrameUrl(injected)
    assert.ok(
      Buffer.byteLength(injected) <= Math.min(PANEL_MAX_BYTES, TORRA_UI_FRAME_MAX_BYTES),
      `面板 ${Buffer.byteLength(injected)}B 超过帧上限`,
    )
    assert.ok(url.startsWith('torra-ui://frame/'))
  })

  await it('面板脚本：顶层函数不重名，界面调用的 RPC 都有注册', () => {
    for (const dir of [TRAJECTORY_DIR, SCHOLAR_DIR, SERVER_DIR, TECH_DIR]) {
      const name = path.basename(dir)
      const ui = readFileSync(path.join(dir, 'ui.html'), 'utf8')
      const main = readFileSync(path.join(dir, 'main.js'), 'utf8')
      // 同一段 IIFE 里后声明的同名函数会静默覆盖前者：顶层声明按两空格缩进识别
      const declared = [...ui.matchAll(/^ {2}function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]!)
      const duplicated = declared.filter((fn, index) => declared.indexOf(fn) !== index)
      assert.deepEqual([...new Set(duplicated)], [], `${name}: 顶层函数重名，后者会覆盖前者`)

      const called = [...new Set([...ui.matchAll(/call\(\s*'([^']+)'/g)].map((m) => m[1]!))]
      const handled = new Set([...main.matchAll(/(?:rpc\.handle|rpc)\(\s*'([^']+)'/g)].map((m) => m[1]!))
      // host.* 由宿主自己拦（读插件内文件、开外链），不经过插件进程
      assert.deepEqual(
        called.filter((method) => !handled.has(method) && !method.startsWith('host.')),
        [],
        `${name}: 面板调用了后端没注册的 RPC`,
      )
      // 两端名字一致也照样起不来：runtime-entry 的 rpc.handle 只认小写开头的写法，
      // 驼峰（ai.evidenceQueries）会让 activate 直接抛错、整个面板打不开
      const badName = [...handled, ...called].find((method) => !/^[a-z][a-z0-9_.-]{0,63}$/.test(method))
      assert.equal(
        badName,
        undefined,
        `${name}: 接口名「${badName}」会被宿主拒绝，必须小写开头、只含小写字母/数字/点/下划线/连字符`,
      )
    }
  })

  await it('服务器看板：族谱页的挂点都在，图谱与轨迹共用一次扫描', () => {
    const ui = readFileSync(path.join(SERVER_DIR, 'ui.html'), 'utf8')
    const main = readFileSync(path.join(SERVER_DIR, 'main.js'), 'utf8')
    const ids = new Set([...ui.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!))
    // lin-zoom 是画图时才插进去的，静态 HTML 里没有它
    const dynamic = new Set(['lin-zoom'])
    const refs = new Set([...ui.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]!))
    const missing = [...refs].filter((id) => id.startsWith('lin-') && !ids.has(id) && !dynamic.has(id))
    assert.deepEqual(missing, [], '族谱页引用了不存在的挂点，点开就是一片空白')

    // 每个标签都要有对应的视图：只有 tab 没有 view，点了没反应
    for (const pair of [
      ['tab-obs', 'view-obs'],
      ['tab-history', 'view-history'],
      ['tab-lineage', 'view-lineage'],
      ['tab-manage', 'view-manage'],
    ]) {
      assert.ok(ids.has(pair[0]!) && ids.has(pair[1]!), `${pair[0]} / ${pair[1]} 不成对`)
    }
    assert.match(ui, /\$\('tab-lineage'\)\.addEventListener/, '族谱标签要能点')

    // 统计卡容器自己就是 .kpis：再套一层，四张卡会被挤成一列
    const stats = /<div class="[^"]*" id="lin-stats">/.exec(ui)
    assert.ok(stats && stats[0].includes('kpis'), 'lin-stats 必须直接是 .kpis 容器')

    // 图谱上的可点对象与连线都要带得住 id，否则点了不知道点的是什么
    assert.match(ui, /data-lin-family="' \+ esc\(family\.id\)/, '卡片要带族 id')
    assert.match(ui, /data-edge="' \+ esc\(edge\.family\.id\)/, '连线要带子族 id')
    assert.match(ui, /data-lin-run="' \+ esc\(member\.id\)/, '轨迹格子要能跳到单次运行')

    // 族谱不另开 ssh：后端在 server.history 的返回里挂上 lineage
    assert.match(main, /parsed\.lineage = buildLineage\(parsed\.runs\)/, 'server.history 要带回族谱')

    // 画布要能按住拖动平移（左键、中键、右键都行），拖完不能误选脚下的卡片
    assert.match(ui, /addEventListener\('pointerdown'/, '族谱画布要能拖动')
    assert.match(ui, /scrollLeft = linDrag\.left - dx/, '拖动要真的挪滚动条')
    assert.match(ui, /addEventListener\('contextmenu'/, '右键拖动不能被系统菜单打断')
    assert.match(ui, /linDrag\.until = Date\.now\(\) \+ 400/, '拖完的点击要在短时窗内吞掉，不能顺手选中卡片')
    assert.match(ui, /lin-scroll\.lin-grabbing/, '拖动时要有抓取光标')

    // 目录规则内置在面板里：不读远端文件，四层结构、词表和红线一打开就能看
    assert.match(ui, /\$\('lin-rules'\)\.addEventListener/, '目录规则要能点开')
    const rulesStart = ui.indexOf('function rulesMarkdown()')
    const rulesEnd = ui.indexOf('function openRulesDrawer()', rulesStart)
    assert.ok(rulesStart > 0 && rulesEnd > rulesStart, '找不到目录规则的内置内容')
    const rules = ui.slice(rulesStart, rulesEnd)
    for (const text of [
      '/workspace/02_runs/',
      '<dataset>_<arm>_<stage>_seed<NN>',
      'icews0515',
      'FINAL test MRR',
      'FAMILY_DIRS',
      '不在 `base` 环境跑实验',
      '`README.md`',
      '结论与遗留',
      '模型与出处',
    ]) {
      assert.ok(rules.includes(text), `目录规则缺少「${text}」`)
    }
  })

  await it('科研外壳：面板调的接口要么是外壳自己的，要么带模块前缀', () => {
    const ui = readFileSync(path.join(RESEARCH_DIR, 'ui.html'), 'utf8')
    const called = [...new Set([...ui.matchAll(/call\(\s*'([^']+)'/g)].map((m) => m[1]!))]
    const shellOwn = new Set([
      'shell.context.get',
      'shell.context.set',
      'shell.modules',
      'shell.status',
      'shell.run',
      'shell.frames.list',
      'shell.frames.clear',
      'shell.approvals.list',
      'shell.approvals.create',
      'shell.approvals.resolve',
      'host.asset',
      'host.open_external',
    ])
    // 外壳自己声明的接口也必须在主进程里真的注册了：
    // 白名单只是「算外壳自己的」，注册表才是「调得通」
    const shellMain = readFileSync(path.join(RESEARCH_DIR, 'main.js'), 'utf8')
    const shellHandled = new Set([...shellMain.matchAll(/rpc\.handle\(\s*'([^']+)'/g)].map((m) => m[1]!))
    const modulePrefix = ['scholar.', 'trajectory.', 'server.']
    for (const method of called) {
      if (shellOwn.has(method)) {
        if (method.startsWith('shell.')) {
          assert.ok(shellHandled.has(method), `外壳的主进程没有注册接口 ${method}`)
        }
        continue
      }
      const prefix = modulePrefix.find((p) => method.startsWith(p))
      assert.ok(prefix, `外壳调了没有归属的接口：${method}`)
      const bare = method.slice(prefix.length)
      const moduleDir = path.join(RESEARCH_DIR, 'modules', prefix.replace('.', ''))
      const main = readFileSync(path.join(moduleDir, 'main.js'), 'utf8')
      const handled = new Set([...main.matchAll(/(?:rpc\.handle|rpc)\(\s*'([^']+)'/g)].map((m) => m[1]!))
      assert.ok(handled.has(bare), `模块 ${prefix} 没有注册接口 ${bare}`)
    }
  })

  await it('科研外壳：每个动作留一帧，破坏性动作先落卡，批准与拒绝都留痕', async () => {
    const backend = await loadBackend(RESEARCH_DIR, 'research')

    // 普通动作：留下一帧，帧里带前后的规模差
    const created = (await backend.rpc['shell.run']!({
      action: 'trajectory.project.create',
      title: '新建研究项目',
      params: { title: 'TKGR 检索增强' },
    })) as {
      ok: boolean
      result: { project: { id: string } }
      frame: { action: string; status: string; delta: string; before: unknown; after: unknown }
    }
    assert.equal(created.ok, true, '动作应该跑通')
    assert.equal(created.frame.status, 'ok')
    assert.equal(created.frame.action, 'trajectory.project.create')
    assert.ok(created.frame.delta.includes('个项目'), `帧里要能看出规模变化：${created.frame.delta}`)
    assert.ok(created.frame.before, '帧里要有动作前的规模')
    assert.ok(created.frame.after, '帧里要有动作后的规模')
    const projectId = created.result.project.id

    // 失败的也要留帧：静默失败会让人以为「这一步没反应」
    const failed = (await backend.rpc['shell.run']!({
      action: 'trajectory.project.create',
      title: '缺标题',
      params: {},
    })) as { ok: boolean; frame: { status: string; summary: string } }
    assert.equal(failed.ok, false, '缺标题的动作应该失败')
    assert.equal(failed.frame.status, 'error')
    assert.ok(failed.frame.summary.length > 0, '失败帧要写清错在哪')

    // 破坏性动作先落卡：没点头之前什么都不该发生
    const card = (await backend.rpc['shell.approvals.create']!({
      action: 'trajectory.project.remove',
      title: '删除项目',
      impact: '节点与台账一起没了',
      params: { projectId },
    })) as { card: { id: string; status: string; action: string } }
    assert.equal(card.card.status, 'pending')
    assert.equal(card.card.action, 'trajectory.project.remove')
    const listed = (await backend.rpc['shell.approvals.list']!()) as {
      pending: Array<{ id: string }>
      decided: Array<{ id: string }>
    }
    assert.equal(listed.pending.length, 1)
    assert.equal(listed.decided.length, 0)
    const stillThere = (await backend.rpc['trajectory.project.list']!()) as { projects: Array<{ id: string }> }
    assert.ok(stillThere.projects.some((p) => p.id === projectId), '没批准之前项目不能被删')

    // 拒绝也要留痕：事后要分得清「没点错」和「没想清楚」
    const rejected = (await backend.rpc['shell.approvals.resolve']!({ id: card.card.id, approved: false })) as {
      executed: boolean
    }
    assert.equal(rejected.executed, false, '拒绝不该执行动作')
    const afterReject = (await backend.rpc['shell.frames.list']!()) as { frames: Array<{ summary: string }> }
    assert.ok(
      afterReject.frames.some((f) => f.summary === '用户拒绝执行'),
      '拒绝也要留下帧',
    )
    const survived = (await backend.rpc['trajectory.project.list']!()) as { projects: Array<{ id: string }> }
    assert.ok(survived.projects.some((p) => p.id === projectId), '拒绝之后项目要还在')

    // 批准才真的删
    const card2 = (await backend.rpc['shell.approvals.create']!({
      action: 'trajectory.project.remove',
      title: '删除项目',
      params: { projectId },
    })) as { card: { id: string } }
    const approved = (await backend.rpc['shell.approvals.resolve']!({ id: card2.card.id, approved: true })) as {
      executed: boolean
      card: { status: string }
    }
    assert.equal(approved.executed, true, '批准应该真的执行')
    assert.equal(approved.card.status, 'approved')
    const gone = (await backend.rpc['trajectory.project.list']!()) as { projects: Array<{ id: string }> }
    assert.equal(gone.projects.some((p) => p.id === projectId), false, '批准后项目应该被删掉')

    // 一张卡只能批一次
    await assert.rejects(
      backend.rpc['shell.approvals.resolve']!({ id: card2.card.id, approved: true }),
      /处理过/,
    )

    // 状态口能看到规模、帧数与待批数
    const status = (await backend.rpc['shell.status']!()) as {
      modules: Array<{ id: string; ok: boolean }>
      counts: { projects: number }
      frames: number
      pending: number
    }
    assert.equal(status.modules.length, 3)
    assert.equal(status.counts.projects, 0, '删完之后不该还剩项目')
    assert.ok(status.frames > 0, '状态里要能看到帧数')
    assert.equal(status.pending, 0, '批完之后不该还有待批')

    // 清空记录
    await backend.rpc['shell.frames.clear']!()
    const cleared = (await backend.rpc['shell.frames.list']!()) as { frames: unknown[] }
    assert.equal(cleared.frames.length, 0)
  })

  await it('插件逻辑：DAG 拒环、假设带证据、删节点清理下游', async () => {
    const backend = await loadBackend(TRAJECTORY_DIR, 'trajectory')
    const created = await backend.rpc['project.create']!({ title: 'T', question: 'Q' })
    const id = (created as { project: { id: string } }).project.id
    const a = (await backend.tools['trajectory_add_node']!({ projectId: id, title: 'A', kind: 'question' })) as { id: string }
    const b = (await backend.tools['trajectory_add_node']!({ projectId: id, title: 'B', kind: 'claim', parents: [a.id] })) as { id: string }
    await assert.rejects(
      backend.tools['trajectory_link_nodes']!({ projectId: id, from: b.id, to: a.id }),
      /环/,
    )
    const h = (await backend.tools['trajectory_add_hypothesis']!({ projectId: id, statement: 'S' })) as { id: string }
    await backend.tools['trajectory_update_hypothesis']!({ projectId: id, hypothesisId: h.id, status: 'supported', evidenceNodeId: b.id })
    await backend.rpc['node.remove']!({ projectId: id, nodeId: b.id })
    const view = (await backend.rpc['project.get']!({ projectId: id })) as { nodes: Array<{ parents: string[] }>; hypotheses: Array<{ evidence: string[] }> }
    assert.equal(view.nodes.length, 1)
    assert.deepEqual(view.hypotheses[0]!.evidence, [], '删掉的证据节点不能留在假设里')
    const registered = Object.keys(backend.tools).sort()
    assertModuleTools(backend, 'trajectory')
  })

  await it('学者工作台：合并去重、精读笔记、Idea 关联、三种引用', async () => {
    const backend = await loadBackend(SCHOLAR_DIR, 'scholar')

    const found = (await backend.rpc['paper.search']!({ query: 'routing', limit: 6 })) as {
      results: Array<{ doi: string; arxivId: string; title: string }>
    }
    assert.equal(found.results.length, 2, '两个源按 DOI 合并后应剩两条')
    assert.equal(found.results[0]!.arxivId, '2401.00001')

    const added = (await backend.rpc['paper.add']!({ doi: '10.1000/test' })) as {
      duplicated: boolean
      paper: { id: string; title: string; year: string; authors: string[] }
    }
    assert.equal(added.duplicated, false)
    assert.equal(added.paper.title, 'Routing at Scale')
    assert.equal(added.paper.year, '2023')
    assert.deepEqual(added.paper.authors, ['Doe, Jane'])

    const dup = (await backend.rpc['paper.add']!({ arxivId: '2401.00001' })) as {
      duplicated: boolean
      paper: { id: string }
    }
    assert.equal(dup.duplicated, true, '同一篇换了标识也必须认出来')
    assert.equal(dup.paper.id, added.paper.id)

    const manual = (await backend.rpc['paper.add']!({
      title: '专家混合的路由容量',
      authors: ['李雷'],
      year: '2024',
      tags: ['MoE'],
    })) as { paper: { id: string } }
    const tagged = (await backend.rpc['paper.list']!({ tag: 'MoE' })) as { papers: Array<{ id: string }> }
    assert.deepEqual(tagged.papers.map((p) => p.id), [manual.paper.id])

    await backend.rpc['reading.save']!({
      paperId: manual.paper.id,
      conclusion: '容量因子决定弃 token 的比例',
      evidence: '表 3',
      question: 'top-k 换 2 会怎样？',
      status: 'reading',
    })
    const card = (await backend.rpc['paper.get']!({ paperId: manual.paper.id })) as {
      paper: { reading: { conclusion: string; questions: Array<{ text: string }> }; status: string }
    }
    assert.equal(card.paper.reading.conclusion, '容量因子决定弃 token 的比例')
    assert.equal(card.paper.reading.questions[0]!.text, 'top-k 换 2 会怎样？')
    assert.equal(card.paper.status, 'reading')

    const gbt = (await backend.rpc['cite']!({ paperIds: [added.paper.id], style: 'gbt' })) as {
      items: Array<{ text: string }>
    }
    assert.match(gbt.items[0]!.text, /\[J\]/)
    assert.match(gbt.items[0]!.text, /DOI: 10\.1000\/test/)
    const apa = (await backend.rpc['cite']!({ paperIds: [added.paper.id], style: 'apa' })) as {
      items: Array<{ text: string }>
    }
    assert.match(apa.items[0]!.text, /\(2023\)/)
    const bib = (await backend.rpc['cite']!({ paperIds: [added.paper.id], style: 'bibtex' })) as {
      items: Array<{ text: string }>
    }
    assert.match(bib.items[0]!.text, /^@article\{/)
    assert.match(bib.items[0]!.text, /doi = \{10\.1000\/test\}/)

    const idea = (await backend.rpc['idea.add']!({
      title: '先固定容量因子',
      paperIds: [manual.paper.id],
    })) as { idea: { id: string; papers: Array<{ title: string }> } }
    assert.equal(idea.idea.papers[0]!.title, '专家混合的路由容量')
    await backend.rpc['idea.update']!({ ideaId: idea.idea.id, status: 'confirmed' })
    const md = (await backend.rpc['export.ideas']!({})) as { markdown: string }
    assert.match(md.markdown, /- 状态：已证实/)
    assert.match(md.markdown, /专家混合的路由容量/)

    await assert.rejects(backend.rpc['compare']!({ paperIds: [added.paper.id] }), /至少选两篇/)
    const cmp = (await backend.rpc['compare']!({ paperIds: [added.paper.id, manual.paper.id] })) as {
      papers: Array<{ sections: unknown[] }>
    }
    assert.equal(cmp.papers.length, 2)
    assert.equal(cmp.papers[0]!.sections.length, 4)

    await backend.rpc['paper.remove']!({ paperId: manual.paper.id })
    const after = (await backend.rpc['idea.list']!({})) as { ideas: Array<{ paperIds: string[] }> }
    assert.deepEqual(after.ideas[0]!.paperIds, [], '删论文要把 Idea 里的关联摘掉')
    assertModuleTools(backend, 'scholar')
  })

  await it('学者工作台：多源检索、年份过滤、编号定位、Europe PMC 与引文扩检', async () => {
    const backend = await loadBackend(SCHOLAR_DIR, 'scholar')

    const multi = (await backend.rpc['paper.search']!({
      query: 'routing',
      limit: 6,
      sources: ['arxiv', 'crossref', 'openalex'],
      sort: 'cited',
    })) as {
      results: Array<{ title: string; sources: string[]; citations: number; doi: string }>
      sources: Array<{ id: string; count: number; error: string }>
    }
    assert.equal(multi.results.length, 2, '三个源按 DOI 合并后仍是两篇')
    assert.deepEqual(multi.results.map((r) => r.citations), [12, 3], '高被引排序用合并后的引用数')
    assert.deepEqual(multi.results[0]!.sources.slice().sort(), ['arxiv', 'crossref', 'openalex'], '同一篇的来源要合并，不能重复计数')
    assert.deepEqual(multi.sources.map((s) => s.id).slice().sort(), ['arxiv', 'crossref', 'openalex'])
    assert.ok(multi.sources.every((s) => s.count > 0 && !s.error), '每个源都要报出取回条数')

    // 429 不是绝症：退避一次再问，成功了就不该把这一路报成「没答复」
    const flaky = (await backend.rpc['paper.search']!({
      query: 'flaky',
      limit: 4,
      sources: ['crossref'],
    })) as { results: Array<{ title: string }>; sources: Array<{ error: string }> }
    assert.ok(flaky.results.length >= 1, '429 后要重试再取，不能一次失败就交白卷')
    assert.ok(flaky.sources.every((s) => !s.error))

    // 只补没答复的几路：并集去重、逐源报告都要回来
    const retried = (await backend.rpc['paper.retry']!({
      queries: ['routing'],
      sources: ['crossref', 'openalex'],
      limit: 6,
    })) as {
      candidates: Array<{ key: string; sources: string[] }>
      sources: Array<{ id: string; count: number; error: string }>
    }
    assert.ok(retried.candidates.length >= 1, '补取要直接把候选交回来')
    assert.ok(retried.candidates.every((c) => Boolean(c.key)), '候选要带稳定的去重键')
    assert.deepEqual(retried.sources.map((s) => s.id).sort(), ['crossref', 'openalex'])
    assert.ok(retried.sources.every((s) => !s.error), '补取成功后逐源报告不该再留错误')

    const recent = (await backend.rpc['paper.search']!({
      query: 'routing',
      limit: 6,
      sources: ['arxiv', 'crossref', 'openalex'],
      yearFrom: '2024',
    })) as { results: Array<{ year: string }> }
    assert.equal(recent.results.length, 1, '年份过滤在合并之后做，别让旧文混进来')
    assert.equal(recent.results[0]!.year, '2024')

    const byDoi = (await backend.rpc['paper.search']!({ query: '10.1000/test', sources: ['arxiv'] })) as {
      results: Array<{ doi: string }>
      identifier: boolean
    }
    assert.equal(byDoi.identifier, true, '直接贴 DOI 走精确题录，不丢给关键词检索')
    assert.equal(byDoi.results[0]!.doi, '10.1000/test')

    const pmc = (await backend.rpc['paper.search']!({
      query: 'cell routing',
      limit: 5,
      sources: ['europepmc'],
    })) as { results: Array<{ title: string; abstract: string; citations: number }> }
    assert.equal(pmc.results.length, 1)
    assert.equal(pmc.results[0]!.title, 'Wet-lab routing study', 'JATS 标签要剥掉')
    assert.match(pmc.results[0]!.abstract, /Cells route & balance/)
    assert.equal(pmc.results[0]!.citations, 4)

    const snow = (await backend.rpc['paper.snowball']!({ doi: '10.1000/test', limit: 5 })) as {
      seed: { openalexId: string; title: string }
      references: Array<{ key: string; title: string; via: string }>
      citing: Array<{ key: string; title: string; via: string }>
    }
    assert.equal(snow.seed.openalexId, 'W1')
    assert.equal(snow.references[0]!.title, 'Routing Foundations')
    assert.equal(snow.references[0]!.via, 'reference')
    assert.match(snow.references[0]!.key, /^doi:10\.1000\/found$/)
    assert.equal(snow.citing[0]!.title, 'Scaling Routing Further')
    assert.equal(snow.citing[0]!.via, 'citing')

    const byTitle = (await backend.rpc['paper.snowball']!({ title: 'Routing at Scale' })) as {
      seed: { openalexId: string }
    }
    assert.equal(byTitle.seed.openalexId, 'W1', '没有 DOI 时按题名对种子')
    await assert.rejects(backend.rpc['paper.snowball']!({ title: '完全不存在的论文' }), /没对上/)

    const tool = (await backend.tools['scholar_snowball']!({ doi: '10.1000/test' })) as {
      references: Array<{ title: string }>
      citing: Array<{ title: string }>
    }
    assert.equal(tool.references[0]!.title, 'Routing Foundations')
    assert.equal(tool.citing[0]!.title, 'Scaling Routing Further')
  })

  await it('OpenAlex Key：配了就带在每条请求上，没配就按匿名额度走', async () => {
    // 两条断言用不同的检索式：模块级结果缓存会命中同一条 query，第二次就不发请求了
    const anon = await loadBackend(SCHOLAR_DIR, 'scholar')
    await anon.rpc['paper.search']!({ query: 'routing anon probe', sources: ['openalex'] })
    assert.ok(openAlexCalls.length > 0, '没配 Key 也要能查（匿名额度）')
    assert.ok(openAlexCalls.every((url) => !url.includes('api_key=')), '没配 Key 时不要塞空参数')

    const keyed = await loadBackend(SCHOLAR_DIR, 'scholar', {
      secret: async (name) => (name === 'openalex' ? 'oa-test-key' : null),
    })
    await keyed.rpc['paper.search']!({ query: 'routing keyed probe', sources: ['openalex'] })
    assert.ok(openAlexCalls.length > 0)
    assert.ok(openAlexCalls.every((url) => url.includes('api_key=oa-test-key')), '每条 OpenAlex 请求都要带 Key')

    // 扩检走的是另一组函数（种子 / 批量取题录 / 引用列表），同样不能漏
    openAlexCalls = []
    await keyed.rpc['paper.snowball']!({ doi: '10.1000/test' })
    assert.ok(openAlexCalls.length >= 2, `扩检至少发两条 OpenAlex 请求，实际 ${openAlexCalls.length}`)
    assert.ok(openAlexCalls.every((url) => url.includes('api_key=oa-test-key')))
  })

  await it('服务器看板：配置校验挡注入，探测解析与失败原因能对上', async () => {
    const backend = await loadBackend(SERVER_DIR, 'server')
    const added = (await backend.rpc['server.add']!({ label: '构建机', host: 'build-01', user: 'ci' })) as {
      server: { id: string; label: string; port: number; keyPath: string; last: unknown }
    }
    assert.equal(added.server.port, 22, '端口缺省 22')
    assert.equal(added.server.keyPath, '')
    assert.equal(added.server.last, null)

    // 值会进 ssh 的 argv：以 - 开头的「主机」就是本机执行任意命令
    await assert.rejects(
      backend.rpc['server.add']!({ label: '坏', host: '-oProxyCommand=calc.exe', user: 'ci' }),
      /主机名/,
    )
    await assert.rejects(backend.rpc['server.add']!({ label: '坏', host: 'build-01', user: 'root -oProxy' }), /用户名/)
    await assert.rejects(backend.rpc['server.add']!({ label: '坏', host: 'build-01', user: 'ci', port: 70000 }), /端口/)
    await assert.rejects(
      backend.rpc['server.add']!({ label: '坏', host: 'build-01', user: 'ci', keyPath: 'id_ed25519' }),
      /绝对路径/,
    )
    await assert.rejects(backend.rpc['server.add']!({ label: '重复', host: 'BUILD-01', user: 'ci' }), /同一台机器/)

    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      probeWith: (runner: unknown, server: Record<string, unknown>) => Promise<Record<string, any>>
      buildProbeArgs: (server: Record<string, unknown>) => string[]
      parseReport: (text: string) => Record<string, any>
    }
    const box = { id: 's1', label: '构建机', host: 'build-01', user: 'ci', port: 22, keyPath: '' }
    const args = serverMod.buildProbeArgs(box)
    assert.ok(args.includes('BatchMode=yes'), '必须禁掉密码交互，否则探测会挂在提示符上')
    assert.equal(args[args.length - 2], 'ci@build-01')
    const keyed = serverMod.buildProbeArgs({ ...box, keyPath: '/home/ci/.ssh/id_ed25519' })
    const at = keyed.indexOf('-i')
    assert.deepEqual(keyed.slice(at, at + 2), ['-i', '/home/ci/.ssh/id_ed25519'])
    assert.throws(() => serverMod.buildProbeArgs({ ...box, host: '-oProxyCommand=calc' }), /主机不合法/)

    const sample = [
      '@@host=build-01',
      '@@os=Ubuntu 22.04.4 LTS',
      '@@cpu=16',
      '@@uptime=1036800',
      '@@load=0.42 0.35 0.28',
      '@@mem=17179869184 9663676416 7516192768',
      '@@disk=257698037760 107374182400 150323855360 42%',
    ].join('\n')
    const good = await serverMod.probeWith(async () => ({ code: 0, stdout: sample, stderr: '' }), { ...box })
    assert.equal(good.ok, true)
    assert.equal(good.metrics.cpu, 16)
    assert.deepEqual(good.metrics.load, [0.42, 0.35, 0.28])
    assert.equal(good.metrics.mem.percent, 56)
    assert.equal(good.metrics.disk.percent, 42)
    assert.equal(good.metrics.os, 'Ubuntu 22.04.4 LTS')

    const denied = await serverMod.probeWith(
      async () => ({ code: 255, stdout: '', stderr: 'ci@build-01: Permission denied (publickey).' }),
      { ...box },
    )
    assert.equal(denied.ok, false)
    assert.match(denied.error, /认证失败/)
    const hung = await serverMod.probeWith(async () => {
      throw new Error('探测超时（10 秒）')
    }, { ...box })
    assert.match(hung.error, /超时/)
    assert.throws(() => serverMod.parseReport('@@host=x\n'), /Linux/)

    const renamed = (await backend.rpc['server.update']!({ serverId: added.server.id, label: '构建机 A' })) as {
      server: { label: string }
    }
    assert.equal(renamed.server.label, '构建机 A')
    await backend.rpc['server.remove']!({ serverId: added.server.id })
    const left = (await backend.rpc['server.list']!({})) as { servers: unknown[] }
    assert.equal(left.servers.length, 0)
    assertModuleTools(backend, 'server')
  })

  await it('服务器看板：从 ~/.ssh/config 读出具体主机，通配与 Include 处理正确', async () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      scanSshConfig: (opts: { homeDir: string; localUser?: string }) => {
        configExists: boolean
        entries: Array<{
          alias: string
          host: string
          user: string
          port: number
          keyPath: string
          keyNote: string
          valid: boolean
          problem: string
        }>
      }
    }
    const home = tmpDir()
    const sshDir = path.join(home, '.ssh')
    mkdirSync(path.join(sshDir, 'config.d'), { recursive: true })
    writeFileSync(path.join(sshDir, 'id_ed25519'), 'PRIVATE KEY FIXTURE', 'utf8')
    writeFileSync(
      path.join(sshDir, 'config'),
      [
        'Host *',
        '  User fallback',
        '  Port 2200',
        '',
        '# 一行多个别名共用一个 Host 块',
        'Host build prod',
        '  HostName 10.0.0.5',
        '  User ci',
        '  IdentityFile ~/.ssh/id_ed25519',
        '  Port = 2222',
        '',
        'Host prod-*',
        '  User produser',
        '',
        'Host prod-eu',
        '  HostName 10.0.0.6',
        '',
        'Host jump-*',
        '  HostName 10.0.0.9',
        '',
        'Match host db',
        '  User from-match',
        '',
        'Host db',
        '  HostName db.internal',
        '  ProxyJump bastion',
        '',
        'Host bad',
        '  HostName -oProxyCommand=calc.exe',
        '',
        'Host nokey',
        '  HostName nokey.internal',
        '  IdentityFile ~/.ssh/missing_key',
        '',
        'Include config.d/*',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      path.join(sshDir, 'config.d', 'extra'),
      ['Host cache', '  HostName 10.0.0.7', '  User redis'].join('\n'),
      'utf8',
    )

    const scan = serverMod.scanSshConfig({ homeDir: home, localUser: 'localme' })
    assert.equal(scan.configExists, true)
    const byAlias = new Map(scan.entries.map((entry) => [entry.alias, entry]))
    assert.deepEqual([...byAlias.keys()], ['build', 'prod', 'prod-eu', 'db', 'bad', 'nokey', 'cache'], '通配不入选，Include 要读进来')
    assert.equal(byAlias.get('build')!.host, '10.0.0.5')
    assert.equal(byAlias.get('prod')!.user, 'ci', '同一 Host 行的多个别名共用配置')
    assert.equal(byAlias.get('build')!.port, 2222)
    assert.equal(byAlias.get('build')!.keyPath, path.join(sshDir, 'id_ed25519'))
    assert.equal(byAlias.get('db')!.port, 2200, 'Host 块没写的端口从 Host * 默认补')
    assert.equal(byAlias.get('db')!.user, 'fallback')
    assert.equal(byAlias.get('prod-eu')!.user, 'produser', 'Host prod-* 的通配默认只给匹配的别名')
    assert.equal(byAlias.get('prod-eu')!.port, 2200)
    assert.match(byAlias.get('db')!.keyNote, /ProxyJump/, '中转设置不能被静默当成已支持')
    assert.equal(byAlias.get('bad')!.valid, false, '以 - 开头的 HostName 不能变成 ssh 选项')
    assert.match(byAlias.get('bad')!.problem, /主机名/)
    assert.equal(byAlias.get('nokey')!.keyPath, '')
    assert.match(byAlias.get('nokey')!.keyNote, /密钥不存在/)
    assert.equal(byAlias.get('cache')!.user, 'redis')
    assert.equal(byAlias.get('cache')!.port, 2200)
    rmSync(home, { recursive: true, force: true })
  })

  await it('服务器看板：ssh.scan / ssh.import 只导入选中项，重复与非法项跳过', async () => {
    const home = tmpDir()
    const sshDir = path.join(home, '.ssh')
    mkdirSync(sshDir, { recursive: true })
    writeFileSync(
      path.join(sshDir, 'config'),
      [
        'Host web',
        '  HostName 10.1.0.2',
        '  User deploy',
        '  Port 2201',
        '',
        'Host broken',
        '  HostName -oProxyCommand=calc',
      ].join('\n'),
      'utf8',
    )
    const savedHome = process.env.HOME
    const savedProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
      const backend = await loadBackend(SERVER_DIR, 'server')
      const scan = (await backend.rpc['ssh.scan']!({})) as {
        entries: Array<{ key: string; alias: string; valid: boolean; exists: boolean }>
      }
      const web = scan.entries.find((entry) => entry.alias === 'web')!
      const broken = scan.entries.find((entry) => entry.alias === 'broken')!
      assert.equal(web.valid, true)
      assert.equal(web.exists, false)
      assert.equal(broken.valid, false, '非法 HostName 不能出现在可导入候选里')

      const first = (await backend.rpc['ssh.import']!({ keys: [web.key, broken.key] })) as {
        added: Array<{ host: string; user: string; port: number }>
        skipped: Array<{ alias: string; reason: string }>
      }
      assert.equal(first.added.length, 1)
      assert.equal(first.added[0]!.host, '10.1.0.2')
      assert.equal(first.added[0]!.user, 'deploy')
      assert.equal(first.added[0]!.port, 2201)
      assert.equal(first.skipped[0]!.alias, 'broken')

      const after = (await backend.rpc['ssh.scan']!({})) as { entries: Array<{ alias: string; exists: boolean }> }
      assert.equal(after.entries.find((entry) => entry.alias === 'web')!.exists, true, '导入后要标成已在看板')

      const again = (await backend.rpc['ssh.import']!({ keys: [web.key] })) as {
        added: unknown[]
        skipped: Array<{ reason: string }>
      }
      assert.equal(again.added.length, 0)
      assert.match(again.skipped[0]!.reason, /已经在看板/)
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      if (savedProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedProfile
      rmSync(home, { recursive: true, force: true })
    }
  })

  await it('服务器工作台：跑完的实验能从目录里找回，指标、搬动记录与删除账本都对得上', () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      parseHistory: (
        text: string,
        root: string,
        now: number,
      ) => {
        root: string
        runs: Array<{
          path: string
          rel: string
          name: string
          project: string
          group: string
          size: number
          metrics: { mr: number | null; mrr: number | null; h1: number | null; h3: number | null; h10: number | null } | null
          metricLine: string
          metricFrom: string
          logs: Array<{ path: string; name: string }>
          results: Array<{ path: string; name: string }>
          resultCount: number
          launch: { path: string; name: string } | null
          movedFrom: string
          movedAt: string
          movedFromPath: string
        }>
        archives: Array<{ path: string; name: string; metrics: { mrr: number | null } | null }>
        deleted: Array<{ type: string; size: number; at: string; path: string }>
        ledgerFiles: Array<{ path: string; name: string }>
        rootFiles: Array<{ path: string; name: string }>
        stats: { runs: number; withMetrics: number; withResults: number; archives: number; deleted: number; moved: number }
      }
    }

    const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')
    const root = '/workspace'
    // 目录树：一次运行一个目录，里面有启动脚本、日志与 results/
    const tree = [
      ['d', 4096, 1760000000, '02_runs'],
      ['d', 4096, 1760000100, '02_runs/tkgr'],
      ['d', 4096, 1760000200, '02_runs/tkgr/cog'],
      ['d', 4096, 1760000300, '02_runs/tkgr/cog/run_a'],
      ['f', 1200, 1760000400, '02_runs/tkgr/cog/run_a/launch.sh'],
      ['f', 2048, 1760000500, '02_runs/tkgr/cog/run_a/train.log'],
      ['d', 4096, 1760000600, '02_runs/tkgr/cog/run_a/results'],
      ['f', 900, 1760000700, '02_runs/tkgr/cog/run_a/results/metrics.json'],
      ['d', 4096, 1760000800, '02_runs/tkgr/cog/run_b'],
      ['f', 4096, 1760000900, '02_runs/tkgr/cog/run_b/eval.log'],
      ['d', 4096, 1760001000, '_logs'],
      ['f', 600, 1760001100, '_logs/old_run.log'],
    ]
      .map((row) => row.join('\t'))
      .join('\n')
    const sizes = ['3502\t02_runs/tkgr/cog/run_a', '1024\t02_runs/tkgr/cog/run_b'].join('\n')
    // 两种成绩写法都要认：管道式与老日志里的 dict 式
    const metrics = [
      '02_runs/tkgr/cog/run_a/train.log:2026-10-05 12:12:25 INFO Time-aware filtering test_time_filter MR: 721.35 | MRR: 0.5769 | H@1: 0.5031 | H@3: 0.6197 | H@10: 0.7153',
      "02_runs/tkgr/cog/run_b/eval.log:TEST :  {'MRR': 0.1508, 'hits@[1,3,10]': tensor([0.0734, 0.1512, 0.3104])}",
      '_logs/old_run.log:2026-09-01 10:00:00 INFO MRR: 0.42 | H@1: 0.3 | H@3: 0.5 | H@10: 0.6',
    ].join('\n')
    const manifest = ['2026-10-29 21:41:13\trun_a\t02_runs/tkgr/cog/run_a'].join('\n')
    const deletedLedger = [
      'type\tsize\tat\tpath',
      'core/tar\t21224230912\t2026-09-19 23:20:28\t/workspace/01_code/vendor/core.111134',
    ].join('\n')
    const ledgerFiles = ['f\t1024\t1760001200\t_migration/FAMILIES.md'].join('\n')
    const rootFiles = ['f\t5179\t1760001300\t./RULES.md'].join('\n')

    const text = [
      '@@root=' + b64(root),
      '@@now=1760002000',
      '@@tree=' + b64(tree),
      '@@sizes=' + b64(sizes),
      '@@metrics=' + b64(metrics),
      '@@ledgername=' + b64('_migration/MANIFEST.tsv'),
      '@@ledger=' + b64(manifest),
      '@@ledgername=' + b64('_migration/DELETED_20261030.tsv'),
      '@@ledger=' + b64(deletedLedger),
      '@@ledgerfiles=' + b64(ledgerFiles),
      '@@rootfiles=' + b64(rootFiles),
    ].join('\n')

    const history = serverMod.parseHistory(text, root, 1760002000)

    assert.equal(history.stats.runs, 2, '只认 run 目录，中间层目录不算实验')
    assert.equal(history.stats.archives, 1, '_logs 里的散日志也要算数')
    assert.equal(history.stats.deleted, 1)
    assert.equal(history.stats.withResults, 1, 'results/ 里的文件要算进结果数')

    const runA = history.runs.find((run) => run.name === 'run_a')!
    assert.ok(runA, 'run_a 应该在列表里')
    assert.equal(runA.path, '/workspace/02_runs/tkgr/cog/run_a', '路径要拼成远端完整路径')
    assert.equal(runA.project, 'tkgr')
    assert.equal(runA.group, 'cog')
    assert.equal(runA.size, 3502 * 1024, '体积按 du 的 KB 换算')
    assert.equal(runA.resultCount, 1)
    assert.equal(runA.launch?.name, 'launch.sh')
    assert.ok(runA.launch?.path.startsWith('/workspace/'), '启动脚本要给完整路径')
    assert.ok(runA.logs[0]!.path.startsWith('/workspace/'), '日志要给完整路径')

    // 管道式成绩
    assert.equal(runA.metrics?.mrr, 0.5769)
    assert.equal(runA.metrics?.mr, 721.35)
    assert.equal(runA.metrics?.h1, 0.5031)
    assert.equal(runA.metrics?.h10, 0.7153)
    assert.match(runA.metricLine, /MRR: 0\.5769/)
    assert.ok(runA.metricFrom.endsWith('/train.log'), '指标要记着是从哪个日志读出来的')

    // 老日志里的 dict 式成绩
    const runB = history.runs.find((run) => run.name === 'run_b')!
    assert.equal(runB.metrics?.mrr, 0.1508)
    assert.equal(runB.metrics?.h1, 0.0734)
    assert.equal(runB.metrics?.h3, 0.1512)
    assert.equal(runB.metrics?.h10, 0.3104)

    // 整理前是平铺的，搬过的实验要能说清原来在哪
    assert.equal(runA.movedFrom, 'run_a')
    assert.equal(runA.movedFromPath, '/workspace/run_a')
    assert.equal(history.stats.moved, 1)

    assert.equal(history.archives[0]!.metrics?.mrr, 0.42)
    assert.ok(history.archives[0]!.path.startsWith('/workspace/_logs/'))
    assert.equal(history.deleted[0]!.size, 21224230912)
    assert.equal(history.ledgerFiles[0]!.name, 'FAMILIES.md')
    assert.equal(history.rootFiles[0]!.name, 'RULES.md')
    assert.equal(history.rootFiles[0]!.path, '/workspace/RULES.md')
  })

  await it('服务器工作台：族谱把运行认回各族，父子、阶段与 Δ 都能对上', () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      parseHistory: (text: string, root: string, now: number) => {
        runs: Array<{
          id: string
          rel: string
          name: string
          metrics: { mrr: number | null } | null
          metricFrom: string
        }>
        stats: { runs: number }
      }
      buildLineage: (runs: unknown[]) => {
        families: Array<{
          id: string
          parent: string | null
          count: number
          depth: number
          mrr: number | null
          delta: number | null
          seeds: number[]
          parentPresent?: boolean
          parentTitle?: string
          members: Array<{ name: string; seed: number | null; delta: number | null; isRef: boolean; mrr: number | null }>
        }>
        ungrouped: Array<{ rel: string }>
        missing: Array<{ id: string; codeOnly: boolean; parent?: string; title?: string }>
        stats: { runs: number; grouped: number; ungrouped: number; families: number; drift: number; ledger?: number }
      }
    }

    const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')
    const root = '/workspace'
    const runDir = (name: string) => `02_runs/tkgr/cog/${name}`
    // 三条真名字：c0 底座 → e2 gate → e2 relation 两 seed
    const tree = [
      ['d', 4096, 1760000000, '02_runs'],
      ['d', 4096, 1760000100, '02_runs/tkgr'],
      ['d', 4096, 1760000200, '02_runs/tkgr/cog'],
      ['d', 4096, 1760000300, runDir('cog_c0_0515_seed42')],
      ['f', 900, 1760000400, runDir('cog_c0_0515_seed42') + '/launch.sh'],
      ['d', 4096, 1760000500, runDir('cog_c0_0515_seed42') + '/results'],
      ['f', 900, 1760000600, runDir('cog_c0_0515_seed42') + '/results/test.log'],
      ['d', 4096, 1760000700, runDir('cog_e2_05_15')],
      ['f', 900, 1760000800, runDir('cog_e2_05_15') + '/launch.sh'],
      ['f', 1200, 1760000900, runDir('cog_e2_05_15') + '/test.log'],
      ['d', 4096, 1760001000, runDir('cog_e2_relation_icews14_seed42')],
      ['f', 900, 1760001100, runDir('cog_e2_relation_icews14_seed42') + '/launch.sh'],
      ['d', 4096, 1760001200, runDir('cog_e2_relation_icews14_seed42') + '/results'],
      ['f', 1400, 1760001300, runDir('cog_e2_relation_icews14_seed42') + '/results/test.log'],
      // 分频段切片比 test.log 新，但它的 MRR 只是某个频段，不是整体成绩
      ['f', 1400, 1760001900, runDir('cog_e2_relation_icews14_seed42') + '/results/frequency_slices.log'],
      ['d', 4096, 1760001400, runDir('cog_e2_relation_icews14_seed43')],
      ['f', 900, 1760001500, runDir('cog_e2_relation_icews14_seed43') + '/launch.sh'],
      ['f', 1200, 1760001600, runDir('cog_e2_relation_icews14_seed43') + '/test.log'],
      // 续跑留下的 checkpoint 目录：自己带日志，也不是一次实验
      ['d', 4096, 1760001700, runDir('cog_e2_relation_icews14_seed43') + '/checkpoint'],
      ['f', 1200, 1760001800, runDir('cog_e2_relation_icews14_seed43') + '/checkpoint/test.log'],
      // 源码工作树：有 src/ 与启动脚本，但从没跑过
      ['d', 4096, 1760001850, runDir('cog_e2_relation_src')],
      ['f', 900, 1760001860, runDir('cog_e2_relation_src') + '/launch.sh'],
      // 名字对不上任何一族
      ['d', 4096, 1760002000, '02_runs/tkgr/rase/rase_mvp_logs'],
      ['f', 900, 1760002050, '02_runs/tkgr/rase/rase_mvp_logs/launch.sh'],
      ['f', 600, 1760002100, '02_runs/tkgr/rase/rase_mvp_logs/run.log'],
    ]
      .map((row) => row.join('\t'))
      .join('\n')
    const sizes = [
      ['3502', runDir('cog_c0_0515_seed42')],
      ['3502', runDir('cog_e2_05_15')],
      ['3502', runDir('cog_e2_relation_icews14_seed42')],
      ['3502', runDir('cog_e2_relation_icews14_seed43')],
    ]
      .map((row) => row.join('\t'))
      .join('\n')
    const metrics = [
      runDir('cog_c0_0515_seed42') + '/results/test.log:MRR: 0.3100 | H@1: 0.2 | H@3: 0.3 | H@10: 0.4',
      runDir('cog_e2_05_15') + '/test.log:MRR: 0.3300 | H@1: 0.2 | H@3: 0.3 | H@10: 0.4',
      runDir('cog_e2_relation_icews14_seed42') + '/results/test.log:MRR: 0.3500 | H@1: 0.2 | H@3: 0.3 | H@10: 0.4',
      runDir('cog_e2_relation_icews14_seed42') + '/results/frequency_slices.log:{"MRR": 0.0015}',
      runDir('cog_e2_relation_icews14_seed42') + '/results/test.log:MRR: 0.3500 | H@1: 0.2 | H@3: 0.3 | H@10: 0.4',
      runDir('cog_e2_relation_icews14_seed43') + '/test.log:MRR: 0.3700 | H@1: 0.2 | H@3: 0.3 | H@10: 0.4',
      runDir('cog_e2_relation_icews14_seed43') + '/checkpoint/test.log:MRR: 0.0100 | H@1: 0.0 | H@3: 0.0 | H@10: 0.0',
      '02_runs/tkgr/rase/rase_mvp_logs/run.log:MRR: 0.2000 | H@1: 0.1 | H@3: 0.2 | H@10: 0.3',
    ].join('\n')

    const text = [
      '@@root=' + b64(root),
      '@@now=1760003000',
      '@@tree=' + b64(tree),
      '@@sizes=' + b64(sizes),
      '@@metrics=' + b64(metrics),
    ].join('\n')

    const history = serverMod.parseHistory(text, root, 1760003000)
    // checkpoint 里的日志、`*_src` 源码树都不能算成独立实验
    assert.equal(history.stats.runs, 5, `run 数应为 5，实际 ${history.runs.map((run) => run.rel).join(' / ')}`)
    assert.ok(history.runs.every((run) => !run.rel.includes('/checkpoint')), 'checkpoint 不该被当成一次实验')
    assert.ok(history.runs.every((run) => !/_src$/.test(run.rel)), '源码工作树不该被当成一次实验')

    // 取错日志会把 0.35 的 run 显示成 0.0015：切片日志永远排在最后
    const seed42 = history.runs.find((run) => run.name === 'cog_e2_relation_icews14_seed42')!
    assert.equal(seed42.metrics?.mrr, 0.35, '整体成绩要来自 test.log，不是 frequency_slices.log')
    assert.ok(seed42.metricFrom.endsWith('/results/test.log'), `指标来源：${seed42.metricFrom}`)

    const lineage = serverMod.buildLineage(history.runs)
    assert.equal(lineage.stats.runs, 5)
    assert.equal(lineage.stats.grouped, 4, '四个 run 能认回族谱')
    assert.equal(lineage.stats.ungrouped, 1, 'rase 名字对不上任何一族，要单列')
    assert.equal(lineage.ungrouped[0]!.rel, 'tkgr/rase/rase_mvp_logs', '未归族的相对路径去掉 02_runs/ 前缀')
    assert.equal(lineage.stats.families, 3, '这次扫描里有三族有运行')
    // 图上只画这台机器上真实存在的族：台账里的其余族不摊成节点，只报个数
    assert.ok(lineage.families.every((family) => family.count > 0), '族谱里不该出现没有运行的族')
    assert.ok(
      lineage.families.every((family) => !['cog.e2f', 'tkgr.adatkg', 'm18.f.main'].includes(family.id)),
      '这台机器上没跑过的族不能进图谱',
    )
    assert.equal(lineage.stats.drift, lineage.missing.length, '台账缺口 = 台账里有、这台机器上还没有的族')
    assert.ok(lineage.stats.drift > 10, `台账里有 ${lineage.stats.drift} 族没在这台机器上落地`)
    assert.ok(lineage.missing.some((item) => item.id === 'cog.e2f' && item.codeOnly))

    const byId = new Map(lineage.families.map((family) => [family.id, family]))
    const c0 = byId.get('cog.c0')!
    const gate = byId.get('cog.e2.gate')!
    const relation = byId.get('cog.e2.relation')!
    assert.equal(c0.mrr, 0.31)
    assert.equal(c0.parent, 'tkgr.history9')
    assert.equal(c0.delta, null, '上游没有分数就不算 Δ，不拿 0 冒充')
    assert.equal(gate.parent, 'cog.c0')
    assert.equal(gate.delta, 0.02, 'gate 比 c0 高 0.02')
    assert.equal(relation.parent, 'cog.e2.gate')
    assert.equal(relation.count, 2)
    assert.deepEqual(relation.seeds, [42, 43])
    assert.equal(relation.mrr, 0.36, '族的中位数取两个 seed 的中间')
    assert.equal(relation.delta, 0.03, '相对上游用中位数之差')
    assert.ok(relation.depth > gate.depth && gate.depth > c0.depth, '深度要一层层加上去')

    // 族内对照点是最早阶段、最小 seed 的那次；其余 Δ 相对它
    const ref = relation.members.find((member) => member.isRef)!
    assert.equal(ref.seed, 42)
    assert.equal(ref.delta, 0)
    const seed43 = relation.members.find((member) => member.seed === 43)!
    assert.equal(seed43.delta, 0.02)
  })

  await it('服务器工作台：10-30 收进来的 transfir / adatkg / case 三条线各自归族', () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      buildLineage: (runs: unknown[]) => {
        families: Array<{
          id: string
          lane: string
          parent: string
          count: number
          seeds: number[]
          members: Array<{ name: string; seed: number | null; label: string }>
        }>
        ungrouped: Array<{ rel: string }>
        stats: { ungrouped: number }
      }
    }

    // 这几条的叶子名是 full / mini / s42，单看名字分不出是哪一族，
    // 所以按路径认；下面就是 10-30 迁移后 /workspace 上真实存在的目录。
    const rels = [
      'tkgr/transfir/icews14_pilot_s42',
      'tkgr/transfir/icews0515_prep',
      'tkgr/transfir/icews14_state/gamma1_s42',
      'tkgr/transfir/icews14_state/gamma1_200ep/s42',
      'tkgr/transfir/icews14_state/gamma1_200ep/s123',
      'tkgr/transfir/icews14_state/killtrain_s42',
      'tkgr/transfir/icews14_state/stateinit_random/s42',
      'tkgr/transfir/icews14_state/stateinit_random/s123',
      'tkgr/transfir/icews14_dualstate/s42',
      'tkgr/transfir/icews14_dualstate/s123',
      'tkgr/transfir/icews14_prior_gate_s42',
      'tkgr/transfir/icews0515_prior_gate_s42',
      'tkgr/adatkg/icews14_ema_s42',
      'tkgr/adatkg/icews0515_ema_s42',
      'tkgr/baselines/fitcarl_few3',
      'tkgr/baselines/fitter_icews14',
      'tkgr/case/_prep_logs',
      'tkgr/case/echr/mini',
      'tkgr/case/echr/full',
      'tkgr/case/echr/legal',
      'tkgr/case/echr/g2',
      'tkgr/case/echr/g4',
      'tkgr/case/echr/gamma_eval',
      'tkgr/case/echr/gcn',
      'tkgr/case/echr/rootcause',
      'tkgr/case/echr/baselines/ingram1',
      'tkgr/case/echr/baselines/ingram2',
      'tkgr/case/echr/baselines/ingram3',
      'tkgr/case/echr/baselines/regcn_mini',
      'tkgr/case/echr/baselines/dbg',
      'tkgr/case/collab/mini',
      'tkgr/case/collab/sub',
      // rase 一个目录里塞了五种配置，不是「一次运行」，仍旧单列
      'rase/rase_mvp_logs'
    ]
    const runs = rels.map((rel) => ({ id: `02_runs/${rel}`, rel: `02_runs/${rel}`, name: rel.split('/').pop() }))
    const lineage = serverMod.buildLineage(runs)
    const byId = new Map(lineage.families.map((family) => [family.id, family]))

    assert.equal(lineage.stats.ungrouped, 1, `只剩 rase 未归族，实际：${lineage.ungrouped.map((run) => run.rel).join(' / ')}`)
    assert.equal(lineage.ungrouped[0]!.rel, 'rase/rase_mvp_logs')

    // 只有 full / mini 两个名字的族：靠父目录认，不能靠叶子名
    const echr = byId.get('case.echr.base')!
    assert.equal(echr.count, 2)
    assert.deepEqual(echr.members.map((member) => member.name).sort(), ['full', 'mini'])
    assert.equal(echr.lane, 'case', '案例线单独一条道，不和 ICEWS 的分数混读')

    // 两 seed 的族要真把 seed 认出来：s42 / s123 这种写法也算
    const ep200 = byId.get('tkgr.transfir.state.200ep')!
    assert.deepEqual(ep200.seeds, [42, 123], 's42/s123 要当成 seed，不能当成名字的一部分')
    assert.equal(ep200.members[0]!.seed, 42, 's42 排在 s123 前面，对照点才是它')

    // 上下游不能断：门控换数据集、重评复用 legal 的权重
    assert.equal(byId.get('tkgr.transfir.prior_gate_0515')!.parent, 'tkgr.transfir.prior_gate')
    assert.equal(byId.get('case.echr.eval')!.parent, 'case.echr.legal')
    assert.equal(byId.get('case.collab')!.parent, 'case.prep')
    assert.equal(byId.get('tkgr.adatkg')!.lane, 'tkgr')
  })

  await it('服务器工作台：规范目录落地后，运行名不再背族名也能归族', () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      buildLineage: (runs: unknown[]) => {
        families: Array<{
          id: string
          count: number
          seeds: number[]
          members: Array<{ name: string; seed: number | null; stage: string }>
        }>
        ungrouped: Array<{ rel: string }>
        stats: { ungrouped: number; families: number }
      }
    }

    // 目录规范之后运行名只剩 <数据集>_<臂>_<阶段>_<seed>，
    // 族靠父目录认；state / state_200ep、m25 / m25_control 这类前缀必须分得开。
    const rels = [
      'tkgr/c0/history9/icews14_baseline_converged_seed43',
      'tkgr/transfir/state/icews14_gamma1_full_seed42',
      'tkgr/transfir/state_200ep/icews14_gamma1_200ep_full_seed123',
      'tkgr/transfir/prior_gate_0515/icews0515_prior_gate_full_seed42',
      'tkgr/adatkg/ema/icews14_ema_full_seed42',
      'tkgr/repro/fitcarl/icews14_fitcarl_few3_full_nonseed',
      'tkgr/cog/c0/icews14_c0_full_seed42',
      'tkgr/cog/m25/icews14_m25_full_seed42',
      'tkgr/cog/m25_control/icews14_m25_control_full_seed42',
      'tkgr/cog/e2_relation/icews14_relation_full_seed42',
      'tkgr/cog/e2_gate/icews14_gate_fast_full_seed42',
      'tkgr/m18/align/icews14_align_c0_full_seed42',
      'tkgr/m18/f_ablate_a1/icews14_candidates_only_full_seed42',
      'tkgr/m20/ablation/icews14_dualrole_full_multiseed_seed43',
      'tkgr/m31-32/ablate_time/icews14_ablate_time_full_seed42',
      'tkgr/m31-32/ablate_constraint/icews14_ablate_consistency_full_seed42',
      'tkgr/case/echr_base/echr_base_mini_full_seed42',
      'tkgr/case/echr_eval/echr_ingram_dbg_full_nonseed',
      'tkgr/case/collab/collab_mini_full_seed42'
    ]
    const runs = rels.map((rel) => ({ id: `02_runs/${rel}`, rel: `02_runs/${rel}`, name: rel.split('/').pop() }))
    const lineage = serverMod.buildLineage(runs)
    const byId = new Map(lineage.families.map((family) => [family.id, family]))

    assert.equal(lineage.stats.ungrouped, 0, `规范目录下不该有未归族：${lineage.ungrouped.map((run) => run.rel).join(' / ')}`)
    assert.equal(lineage.stats.families, 19, '每个族目录各认回一条')

    assert.equal(byId.get('tkgr.transfir.state')!.count, 1, 'state 不能把 state_200ep 吃进来')
    assert.equal(byId.get('tkgr.transfir.state.200ep')!.count, 1)
    assert.equal(byId.get('cog.m25')!.count, 1, 'm25 不能把 m25_control 吃进来')
    assert.equal(byId.get('cog.m25.control')!.count, 1)
    assert.equal(byId.get('case.echr.base')!.members[0]!.name, 'echr_base_mini_full_seed42')

    // 新名字里的阶段与 seed 要能从名字本身读出来，别再贴回族名
    const converged = byId.get('tkgr.history9')!.members[0]!
    assert.equal(converged.stage, 'converged（收敛）')
    assert.equal(converged.seed, 43)
    const nonseed = byId.get('case.echr.eval')!.members[0]!
    assert.equal(nonseed.seed, null, 'nonseed 是「没按 seed 分队」，别猜成 42')
    assert.equal(byId.get('tkgr.transfir.state.200ep')!.members[0]!.seed, 123)
  })

  await it('服务器工作台：族谱按服务器画，空机器上不摊开整本台账', () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      buildLineage: (runs: unknown[]) => {
        families: Array<{
          id: string
          count: number
          parent: string
          parentPresent?: boolean
          parentTitle?: string
        }>
        ungrouped: Array<{ rel: string }>
        missing: Array<{ id: string; parent: string }>
        stats: { families: number; grouped: number; ungrouped: number; drift: number; ledger?: number }
      }
    }

    // 一台还没跑过任何实验的机器：台账照样在，图上却不该有一张卡
    const empty = serverMod.buildLineage([])
    assert.equal(empty.families.length, 0, '空机器上不该画出任何族')
    assert.equal(empty.stats.families, 0)
    assert.equal(empty.stats.grouped, 0)
    assert.equal(empty.stats.ungrouped, 0)
    assert.equal(empty.stats.drift, empty.missing.length, '台账缺口 = 台账里有、这台机器上还没有的族')
    assert.ok((empty.stats.ledger ?? 0) > 50, '台账里登记的族要有一个总数')

    // 换一台机器，图就得换一幅：只扫到一族，就只画这一族
    const one = serverMod.buildLineage([
      { id: '02_runs/tkgr/case/echr/full', rel: '02_runs/tkgr/case/echr/full', name: 'full' },
    ])
    assert.equal(one.families.length, 1, '只扫到一族就只画一族')
    assert.equal(one.families[0]!.id, 'case.echr.base')
    // 上游在这台机器上没有：名字要留着，但图上不画它的卡
    assert.equal(one.families[0]!.parent, 'case.prep')
    assert.equal(one.families[0]!.parentPresent, false)
    assert.ok(one.families[0]!.parentTitle, '上游的名字要留着，不能把来路掐断')
    assert.ok(one.missing.some((item) => item.id === 'case.prep'), '上游要出现在「这台机器上还没有」的名单里')
  })

  await it('服务器工作台：远程根目录与项目内路径的安全边界', () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      normalizeRemoteRoot: (value: unknown) => string
      resolveRemotePath: (root: unknown, maybePath: unknown, allowRoot?: boolean) => string
    }

    assert.equal(serverMod.normalizeRemoteRoot('/srv/proj/'), '/srv/proj')
    assert.equal(serverMod.normalizeRemoteRoot('/srv/proj/../data'), '/srv/data')
    assert.throws(() => serverMod.normalizeRemoteRoot('srv/proj'), /绝对路径/)
    assert.throws(() => serverMod.normalizeRemoteRoot('/'), /根目录/)
    assert.throws(() => serverMod.normalizeRemoteRoot('/srv/proj\u0000x'), /控制字符/)
    assert.throws(() => serverMod.normalizeRemoteRoot('/srv/' + 'a'.repeat(5000)), /过长/)

    assert.equal(serverMod.resolveRemotePath('/srv/proj', 'logs/train'), '/srv/proj/logs/train')
    assert.equal(serverMod.resolveRemotePath('/srv/proj/', '/srv/proj/logs/train.log'), '/srv/proj/logs/train.log')
    assert.equal(serverMod.resolveRemotePath('/srv/proj', '', true), '/srv/proj')
    assert.throws(() => serverMod.resolveRemotePath('/srv/proj', '', false), /路径不能为空/)
    assert.throws(() => serverMod.resolveRemotePath('/srv/proj', '../outside'), /超出/)
    assert.throws(() => serverMod.resolveRemotePath('/srv/proj', '/srv/project/outside'), /超出/)
    assert.throws(() => serverMod.resolveRemotePath('/srv/proj', '/tmp/outside'), /超出/)
  })

  await it('服务器工作台：文件列表按目录优先解析，时间戳转毫秒', () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      parseFileListing: (text: string) => {
        root: string
        path: string
        entries: Array<{ name: string; path: string; type: string; size: number; modified: number }>
      }
    }
    const root = '/srv/proj'
    const listing = ['logs', 'd', '0', '1700000000.5', 'train.log', 'f', '42', '1700000001.25', 'latest', 'l', '0', '1700000002']
      .join('\u0000') + '\u0000'
    const text = [
      '@@root=' + Buffer.from(root).toString('base64'),
      '@@path=' + Buffer.from(root).toString('base64'),
      '@@data=' + Buffer.from(listing).toString('base64'),
    ].join('\n')
    const result = serverMod.parseFileListing(text)

    assert.equal(result.root, root)
    assert.equal(result.path, root)
    assert.deepEqual(result.entries.map((entry) => entry.name), ['logs', 'latest', 'train.log'])
    assert.deepEqual(result.entries.map((entry) => entry.type), ['dir', 'link', 'file'])
    assert.equal(result.entries[0]!.path, '/srv/proj/logs')
    assert.equal(result.entries[1]!.path, '/srv/proj/latest')
    assert.equal(result.entries[2]!.size, 42)
    assert.equal(result.entries[2]!.modified, 1700000001250)
  })

  await it('服务器工作台：全机扫描实验，绑定目录外的进程保留并标注，启动器的日志传给子进程', () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      parseExperiments: (
        text: string,
        root: string,
        now: number,
      ) => {
        metrics: { load: number[] }
        experiments: Array<{
          pid: number
          name: string
          condaEnv: string
          command: string
          cwd: string
          insideRoot: boolean
          startedAt: number
          runtimeSec: number
          kind: string
          totalEpochs: number
          logPath: string
          logSource: string
          logReadable: boolean
          logShared: boolean
          logPeers: number[]
          children: number
        }>
        gpu: Array<{ index: number; name: string; usedMiB: number; totalMiB: number; util: number }>
        gpuError: string
      }
    }
    const root = '/workspace'
    const b64 = (value: string): string => Buffer.from(value).toString('base64')
    const exp = (
      pid: number,
      ppid: number,
      etimes: string,
      env: string,
      cwd: string,
      log: string,
      launcher: string,
      command: string,
      source = '',
    ): string => b64([String(pid), String(ppid), etimes, env, cwd, '0', log, launcher, source, command].join('\t'))
    const launcher = 'bash -c cd /root/AdaTKG && source /root/miniconda3/etc/profile.d/conda.sh && conda activate transfir && nohup bash run_experiment.sh AdaTKG-EMA train ICEWS05-15 1 > /workspace/TKGR_case/results/adatkg.log 2>&1 &'
    const text = [
      '@@root=' + b64(root),
      '@@host=gpupod',
      '@@os=Ubuntu 22.04.5 LTS',
      '@@cpu=128',
      '@@uptime=86400',
      '@@load=32.89 31.61 27.93',
      '@@mem=8589934592 4294967296 4294967296',
      '@@disk=107374182400 53687091200 53687091200 50%',
      '@@now=1700000100',
      '@@exp=' + exp(3000, 1, '7200', '', '/root/AdaTKG', '/workspace/TKGR_case/results/adatkg.log', '1', launcher, 'arg'),
      '@@exp=' + exp(3001, 3000, '7100', 'transfir', '/root/AdaTKG', '', '0', 'bash run_experiment.sh AdaTKG-EMA train ICEWS05-15 1'),
      '@@exp=' + exp(3002, 3001, '7000', 'transfir', '/root/AdaTKG', '', '0', 'python -u main.py --dataset ICEWS05-15 --epochs 200'),
      '@@exp=' + exp(4000, 1, '3600', 'transfir', '/root/TransFIR', '', '0', 'python main.py --dataset ICEWS05-15 --gpu 0 --epochs 200'),
      '@@exp=' + exp(4001, 4000, '3599', 'transfir', '/root/TransFIR', '', '0', 'python main.py --dataset ICEWS05-15 --gpu 0 --epochs 200'),
      '@@exp=' + exp(5000, 1, '60', '', '/workspace/TKGR_case', '/workspace/TKGR_case/results/x.log', '0', 'python train.py'),
      '@@gpuerr=' + b64('NVIDIA-SMI has failed because it could not communicate with the driver'),
    ].join('\n')
    const result = serverMod.parseExperiments(text, root, 1700000100)

    assert.deepEqual(result.metrics.load, [32.89, 31.61, 27.93])
    assert.match(result.gpuError, /NVIDIA-SMI has failed/)
    // 启动器不算实验；脚本与其 python 子进程归成一条，DataLoader 类重复进程也折叠
    assert.deepEqual(result.experiments.map((item) => item.pid), [5000, 3001, 4000])

    const outside = result.experiments.find((item) => item.pid === 3001)!
    assert.equal(outside.cwd, '/root/AdaTKG')
    assert.equal(outside.insideRoot, false, '绑定目录外也要保留，只标注')
    assert.equal(outside.name, 'run_experiment.sh')
    assert.equal(outside.kind, 'script')
    assert.equal(outside.condaEnv, 'transfir')
    assert.equal(outside.children, 1)
    assert.equal(outside.logPath, '/workspace/TKGR_case/results/adatkg.log', '启动器的输出重定向要传给子进程')
    assert.equal(outside.logSource, 'arg', '来源要一并传下来，猜出来的日志不能当准的')
    assert.equal(outside.logReadable, true, '日志在绑定目录内就能读，哪怕进程 cwd 在外面')
    assert.equal(outside.startedAt, 1699993000000)

    const main = result.experiments.find((item) => item.pid === 4000)!
    assert.equal(main.name, 'main.py', 'python -u main.py 的名字不能是 -u')
    assert.equal(main.kind, 'training')
    assert.equal(main.totalEpochs, 200)
    assert.equal(main.children, 1)
    assert.equal(main.logReadable, false)

    const inside = result.experiments.find((item) => item.pid === 5000)!
    assert.equal(inside.insideRoot, true)
    assert.equal(inside.name, 'train.py')
  })

  await it('服务器工作台：多个实验解析到同一份日志时标注共用，并给出同类 PID', () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      parseExperiments: (
        text: string,
        root: string,
        now: number,
      ) => {
        experiments: Array<{
          pid: number
          logPath: string
          logSource: string
          logShared: boolean
          logPeers: number[]
        }>
      }
    }
    const root = '/workspace'
    const b64 = (value: string): string => Buffer.from(value).toString('base64')
    const exp = (pid: number, log: string, source: string, command: string): string =>
      b64([String(pid), '1', '600', '', '/workspace/TKGR_case', '1', log, '0', source, command].join('\t'))
    const shared = '/workspace/TKGR_case/results/ablation_random_s123.log'
    const text = [
      '@@root=' + b64(root),
      '@@load=8.00 7.50 7.00',
      '@@now=1700000100',
      '@@exp=' + exp(7001, shared, 'fd', 'python main.py --model transfer --seed 123'),
      '@@exp=' + exp(7002, shared, 'arg', 'python main.py --model transfer --seed 456'),
      '@@exp=' + exp(7003, '/workspace/TKGR_case/results/own.log', 'fd', 'python main.py --model transfer --seed 789'),
    ].join('\n')
    const result = serverMod.parseExperiments(text, root, 1700000100)

    const first = result.experiments.find((item) => item.pid === 7001)!
    const second = result.experiments.find((item) => item.pid === 7002)!
    const own = result.experiments.find((item) => item.pid === 7003)!
    assert.equal(first.logSource, 'fd')
    assert.equal(second.logSource, 'arg')
    assert.equal(first.logShared, true, '同一份日志的两个实验要标成共用')
    assert.deepEqual(first.logPeers, [7002])
    assert.deepEqual(second.logPeers, [7001])
    assert.equal(own.logShared, false)
    assert.deepEqual(own.logPeers, [])
  })

  await it('服务器工作台：实验名取脚本而不是解释器参数', () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      commandName: (command: string) => string
      epochsFromCommand: (command: string) => number
    }
    assert.equal(serverMod.commandName('python -u main.py --epochs 200'), 'main.py')
    assert.equal(serverMod.commandName('python3 train.py'), 'train.py')
    assert.equal(serverMod.commandName('bash run_experiment.sh AdaTKG-EMA train'), 'run_experiment.sh')
    assert.equal(serverMod.commandName('nohup python3 -m torch.distributed.launch main.py'), 'main.py')
    assert.equal(serverMod.commandName('torchrun --nproc_per_node=4 train.py'), 'train.py')
    assert.equal(serverMod.epochsFromCommand('python main.py --epochs 200'), 200)
    assert.equal(serverMod.epochsFromCommand('python main.py --epoch 30'), 30)
    assert.equal(serverMod.epochsFromCommand('python main.py'), 0)
  })

  await it('服务器工作台：日志指标曲线只收训练指标，epoch 进度与百分比能从日志里认出来', () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      parseProgress: (text: string) => {
        series: Array<{ key: string; points: number[]; min: number; max: number; last: number; delta: number }>
        epoch: { current: number; total: number }
        percent: number | null
      }
    }
    const log = [
      'Epoch 3/200 loss: 0.4321 acc=0.81 mrr=0.22 lr: 0.0005',
      '2026-10-29 13:00:01 INFO checkpoint saved to /workspace/runs/a.log',
      'Epoch 4/200 - loss: 0.3912 acc=0.83 mrr=0.24 hits@10=0.5',
      '  50%|#####     | 100/200 [01:02<01:02, 1.60it/s]',
    ].join('\n')
    const result = serverMod.parseProgress(log)
    const keys = result.series.map((item) => item.key)
    assert.ok(keys.includes('loss'), '缺少 loss')
    assert.ok(keys.includes('acc'))
    assert.ok(keys.includes('mrr'))
    assert.ok(keys.includes('lr'))
    assert.ok(keys.includes('hits@10'))
    assert.ok(!keys.includes('info'), 'INFO 这类词不能当指标')
    assert.deepEqual(result.series.find((item) => item.key === 'loss')!.points, [0.4321, 0.3912])
    const loss = result.series.find((item) => item.key === 'loss')!
    assert.ok(Math.abs(loss.delta + 0.0409) < 1e-9)
    assert.equal(result.series[0]!.key, 'loss', 'loss 类排最前')
    assert.deepEqual(result.epoch, { current: 4, total: 200 })
    assert.equal(result.percent, 50)
    // 只有时间戳、没有指标的日志不该被画成曲线
    assert.equal(serverMod.parseProgress('10/29 13:00:01 started\nnothing here').series.length, 0)

    // 真机日志：AdaTKG 用 `[Train] epoch=9 loss=… H@1=…`，tqdm 用 \r 原地刷新
    const adatkg = [
      "2026-10-29 10:28:02,828 - INFO - Namespace(dataset='ICEWS05-15', lr=0.0001, epochs=1000, gpu=0)",
      '2026-10-29 14:29:14,819 - INFO - [Train] epoch=9 loss=2.3987 MRR=0.5981 H@1=0.4752 H@3=0.6805 H@10=0.8204',
      '2026-10-29 14:29:14,819 - INFO - [Valid] MRR=0.5261 H@1=0.4045 H@3=0.5998 H@10=0.7558',
      'Epoch 10 train:   0%|          | 0/2008 [00:00<?, ?it/s]\rEpoch 10 train:  82%|████████▏ | 1651/2008 [17:37<03:50,  1.55it/s]',
    ].join('\n')
    const ada = serverMod.parseProgress(adatkg)
    const adaKeys = ada.series.map((item) => item.key)
    assert.deepEqual(ada.epoch, { current: 10, total: 1000 }, '总轮数从日志开头的 epochs= 来')
    assert.equal(ada.percent, 82, '\\r 刷新后要取最后一段进度')
    assert.ok(adaKeys.includes('train.loss'))
    assert.ok(adaKeys.includes('train.hits@1'), 'H@1 与 hits@1 是同一条曲线')
    assert.ok(adaKeys.includes('valid.mrr'))
    assert.ok(!adaKeys.includes('loss'), '训练集和验证集的同名指标不能混成一条线')

    // 真机日志：TransFIR 用 `Epoch: 0, Train Loss: …`
    const transfir = [
      '2026-10-29 13:00:08,749 - INFO - Namespace(dataset=\'ICEWS05-15\', lr=0.0001, epochs=200, gpu=0)',
      '2026-10-29 13:42:59,674 - INFO - Epoch: 3, Train Loss: 4.6317',
      '2026-10-29 13:53:27,288 - INFO - Epoch: 3, Valid Loss: 4.3706',
    ].join('\n')
    const trans = serverMod.parseProgress(transfir)
    assert.deepEqual(trans.epoch, { current: 3, total: 200 })
    const transKeys = trans.series.map((item) => item.key)
    assert.ok(transKeys.includes('train.loss'))
    assert.ok(transKeys.includes('valid.loss'))
    assert.ok(!transKeys.includes('loss'))
  })

  await it('服务器工作台：固定脚本做 realpath 边界检查，读文件限制字节与尾部行数', () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      buildReadScript: (root: string, target: string, maxBytes: number, lines: number | null) => string
      buildFilesScript: (root: string, target: string) => string
    }
    const read = serverMod.buildReadScript('/srv/proj', '/srv/proj/train.log', 1234, 80)
    assert.match(read, /readlink -f/)
    assert.ok(read.includes('case "$target" in "$root"|"$root"/*'))
    assert.match(read, /tail -n 80/)
    assert.match(read, /tail -c 1234/)
    const head = serverMod.buildReadScript('/srv/proj', '/srv/proj/config.json', 4096, null)
    assert.match(head, /head -c 4096/)
    const files = serverMod.buildFilesScript('/srv/proj', '/srv/proj/logs')
    assert.match(files, /find "\$target" -mindepth 1 -maxdepth 1/)
    assert.ok(!files.includes('cd /srv/proj'), '远程路径只能通过 base64 进入固定脚本')
  })

  await it('服务器工作台：收流上限容得下满额日志，超限与异常终止都有话说', () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      WORKSPACE_MAX_OUTPUT: number
      READ_MAX_BYTES: number
      explainFailure: (code: number, stderr: string) => string
    }
    // 读满 256KB 尾部再 base64 会膨胀约 4/3；上限比它还小就会被自己 kill 掉，
    // 表现成「ssh 退出码 -1，没有输出」——两小时的训练日志必然踩到
    const worstCase = Math.ceil(serverMod.READ_MAX_BYTES / 3) * 4
    assert.ok(
      serverMod.WORKSPACE_MAX_OUTPUT > worstCase,
      `收流上限 ${serverMod.WORKSPACE_MAX_OUTPUT} 要大于最大载荷 ${worstCase}`,
    )
    assert.match(serverMod.explainFailure(-1, ''), /异常终止/)
    assert.ok(!serverMod.explainFailure(-1, '').includes('退出码 -1'), '没有退出码就别硬报 -1')
    assert.match(serverMod.explainFailure(255, 'ssh: connect to host x port 22: Connection refused'), /连接被拒绝/)
  })

  await it('服务器工作台：冷启动握手超时会重连一次，认证失败则不重试', async () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      runWorkspaceWith: (
        runner: (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
        server: { host: string; port: number; user: string; keyPath?: string },
        script: string,
      ) => Promise<{ code: number; stdout: string; stderr: string }>
    }
    const server = { host: '192.168.88.122', port: 31022, user: 'root', keyPath: 'C:/Users/Administrator/.ssh/id_rsa' }

    // 主机刚被唤醒时，第一次 ssh 会卡在握手阶段；第二次连接通常立刻就通
    let calls = 0
    const flaky = async () => {
      calls += 1
      if (calls === 1) return { code: 255, stdout: '', stderr: 'ssh: connect to host 192.168.88.122 port 31022: Connection timed out during banner exchange' }
      return { code: 0, stdout: '@@host=gpu-master\n', stderr: '' }
    }
    const ok = await serverMod.runWorkspaceWith(flaky, server, 'echo hi')
    assert.equal(ok.code, 0, '握手超时后重连应该成功')
    assert.equal(calls, 2, '应该重连一次')

    // 认证失败重连多少次都一样，直接报错，别让用户等两轮
    let authCalls = 0
    const denied = async () => {
      authCalls += 1
      return { code: 255, stdout: '', stderr: 'root@192.168.88.122: Permission denied (publickey).' }
    }
    await assert.rejects(
      () => serverMod.runWorkspaceWith(denied, server, 'echo hi'),
      /认证失败/,
    )
    assert.equal(authCalls, 1, '认证失败不该重试')

    // 两次都连不上时，报的还是连接超时，只是把话说明白
    let deadCalls = 0
    const dead = async () => {
      deadCalls += 1
      return { code: 255, stdout: '', stderr: 'ssh: connect to host 192.168.88.122 port 31022: Connection timed out during banner exchange' }
    }
    await assert.rejects(() => serverMod.runWorkspaceWith(dead, server, 'echo hi'), /连接超时/)
    assert.equal(deadCalls, 2, '最多重连一次')
  })

  await it('服务器工作台：UI 使用可暂停的 setTimeout 轮询并覆盖全部只读 RPC', () => {
    const ui = readFileSync(path.join(SERVER_DIR, 'ui.html'), 'utf8')
    assert.ok(!ui.includes('requestAnimationFrame'), '轮询不能依赖 rAF，隐藏窗口会被整批暂停')
    assert.match(ui, /window\.setTimeout\(/)
    assert.match(ui, /visibilitychange/)
    for (const method of ['server.metrics', 'server.experiments', 'server.progress', 'server.files', 'server.dirs', 'server.read_text', 'server.log_tail', 'server.history']) {
      assert.ok(ui.includes(method), `缺少 ${method}`)
    }
    // hist-stats 自己就是 .kpis 容器：卡片再套一层网格，内层就只占外层三列里的一列，
    // 四张卡被挤成百来像素宽，标题会折成「跑过的 / 实验」
    assert.match(ui, /class="kpis" id="hist-stats"/, 'hist-stats 应当就是 .kpis 容器')
    assert.ok(
      !/\$\('hist-stats'\)\.innerHTML\s*=\s*'<div class="kpis">'/.test(ui),
      '卡片不能再套一层 .kpis 网格',
    )
  })

  await it('服务器工作台：目录下拉只走绝对路径，子目录按真实父路径拼', () => {
    const mod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      normalizeBrowsePath: (value: unknown) => string
      parseDirListing: (text: string) => {
        home: string
        path: string
        parent: string
        canUp: boolean
        dirs: Array<{ name: string; path: string; hidden: boolean }>
      }
    }

    // 空串与 ~ 都表示家目录：展开 $HOME 是远端脚本的事，这里只把三种写法归一
    assert.equal(mod.normalizeBrowsePath(''), '')
    assert.equal(mod.normalizeBrowsePath('~'), '')
    assert.equal(mod.normalizeBrowsePath('~/repo'), '~/repo')
    assert.equal(mod.normalizeBrowsePath(' /data/proj/ '), '/data/proj/')
    assert.throws(() => mod.normalizeBrowsePath('data/proj'), /绝对路径/, '相对路径会被远端解析到别处')
    assert.throws(() => mod.normalizeBrowsePath('/data/a\u0000b'), /控制字符/)

    const enc = (v: string) => Buffer.from(v, 'utf8').toString('base64')
    const listing = mod.parseDirListing(
      [
        '@@home=' + enc('/home/me'),
        '@@path=' + enc('/workspace'),
        '@@parent=' + enc('/'),
        '@@data=' + enc('run-01\u0000.cache\u0000data\u0000'),
      ].join('\n'),
    )
    assert.equal(listing.path, '/workspace')
    assert.equal(listing.parent, '/')
    assert.equal(listing.canUp, true)
    const byName = new Map(listing.dirs.map((d) => [d.name, d]))
    assert.equal(byName.get('data')!.path, '/workspace/data', '子目录路径必须拼上真实父路径')
    assert.equal(byName.get('.cache')!.hidden, true, '点目录要标出来，前端才好把它排淡')

    // 根目录没有上一级：还显示「↑」只会让人以为能上去
    const top = mod.parseDirListing(['@@path=' + enc('/'), '@@parent=' + enc('/')].join('\n'))
    assert.equal(top.canUp, false)
    assert.deepEqual(top.dirs, [])
  })

  await it('服务器工作台：Markdown 预览只认白名单语法，原文里的标签不会变成元素', () => {
    const ui = readFileSync(path.join(SERVER_DIR, 'ui.html'), 'utf8')
    // 面板帧不能加载外部脚本，渲染器只能内联；这里按标记把它抠出来单独跑
    const start = ui.indexOf('/* markdown-preview:start')
    const end = ui.indexOf('/* markdown-preview:end')
    assert.ok(start > 0 && end > start, '找不到 Markdown 渲染器标记')
    const factory = new Function(
      ui.slice(start, end) + '\nreturn { markdownToHtml: markdownToHtml, isMarkdownFile: isMarkdownFile }',
    ) as () => { markdownToHtml: (source: string) => string; isMarkdownFile: (path: string) => boolean }
    const { markdownToHtml, isMarkdownFile } = factory()

    const raw = markdownToHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    assert.ok(!/<script|<img/i.test(raw), '原文里的标签不能原样出现在输出里')
    assert.match(raw, /&lt;script&gt;/)

    const links = markdownToHtml('[a](https://example.com/x?y=1&z=2) [b](javascript:alert(1))')
    assert.match(links, /<a class="md-link" href="https:\/\/example\.com\/x\?y=1&amp;z=2"/)
    assert.ok(!/javascript:/i.test(links), 'javascript: 链接不能被渲染成可点链接')

    const doc = markdownToHtml([
      '# 标题',
      '',
      '| 目录 | 内容 |',
      '| --- | :---: |',
      '| `01_code` | 代码 |',
      '',
      '- [x] 完成',
      '- [ ] 待办',
      '',
      '```bash',
      'grep -h "mrr" *.json',
      '```',
      '',
      '> 引用',
      '',
      '---',
    ].join('\n'))
    assert.match(doc, /<h1>标题<\/h1>/)
    assert.match(doc, /<table>/)
    assert.match(doc, /<th style="text-align:center">内容<\/th>/)
    assert.match(doc, /<code>01_code<\/code>/)
    assert.match(doc, /<li class="md-task"><input type="checkbox" disabled checked \/>/)
    assert.match(doc, /<span class="md-code-lang">bash<\/span><code>grep -h &quot;mrr&quot; \*\.json<\/code>/)
    assert.match(doc, /<blockquote>/)
    assert.match(doc, /<hr \/>/)

    assert.equal(isMarkdownFile('/workspace/README.md'), true)
    assert.equal(isMarkdownFile('/workspace/README'), true)
    assert.equal(isMarkdownFile('/workspace/train.log'), false)

    // 抽屉要真的走这条渲染路径，而不是继续 textContent 铺平
    assert.match(ui, /body\.innerHTML = markdownToHtml\(drawerText\)/)
    assert.match(ui, /id="drawer-mode"/)
  })

  await it('服务器工作台：实验详情能打开 run 的 README，点选实验时文件树定位到工作目录', () => {
    const ui = readFileSync(path.join(SERVER_DIR, 'ui.html'), 'utf8')

    // 「打开 README」由 cwd 拼出路径，只在绑定根内出现；点击走同一条只读抽屉
    assert.match(ui, /data-open-readme="' \+ esc\(readmePath\)/)
    assert.match(ui, /runDir \+ '\/README\.md'/)
    assert.match(ui, /closest\('\[data-open-readme\]'\)[\s\S]{0,140}openRunReadme\(/)
    assert.match(ui, /function openRunReadme\(path\)[\s\S]{0,260}openFile\(path,/)
    // README 不存在是常态：说清该补什么，而不是只显示远程退出码
    assert.match(ui, /missingNote && message\.indexOf\('不是普通文件'\)/)
    assert.match(ui, /文件不存在/)
    // 点选实验才展开文件树；轮询自动选中不跳
    assert.match(ui, /selectedExp = key[\s\S]{0,240}revealRunDir\(exp\)/)

    // 路径边界抠出来单跑：/workspace2 不能被当成 /workspace 的子目录
    const start = ui.indexOf('function runDirOf(')
    const end = ui.indexOf('function revealRunDir(')
    assert.ok(start > 0 && end > start, '找不到工作目录与根边界辅助函数')
    const helpers = new Function(
      ui.slice(start, end) + '\nreturn { runDirOf: runDirOf, pathInsideRoot: pathInsideRoot }',
    ) as () => {
      runDirOf: (exp: { cwd?: string } | null) => string
      pathInsideRoot: (path: string, root: string) => boolean
    }
    const { runDirOf, pathInsideRoot } = helpers()

    assert.equal(runDirOf({ cwd: '/workspace/02_runs/tkgr/c0/x/' }), '/workspace/02_runs/tkgr/c0/x')
    assert.equal(runDirOf(null), '')
    assert.equal(pathInsideRoot('/workspace/02_runs/x', '/workspace'), true)
    assert.equal(pathInsideRoot('/workspace/02_runs/x', '/workspace/'), true)
    assert.equal(pathInsideRoot('/workspace', '/workspace'), true)
    assert.equal(pathInsideRoot('/workspace2/x', '/workspace'), false, '/workspace2 不是 /workspace 的子目录')
    assert.equal(pathInsideRoot('/root/TransFIR', '/workspace'), false)
    assert.equal(pathInsideRoot('', '/workspace'), false)
    assert.equal(pathInsideRoot('/workspace/x', ''), false)
  })

  await it('科研工作台：合成一个面板后，应用层不再按插件 id 特判', () => {
    const panels = readFileSync(path.join(ROOT, 'src', 'renderer', 'components', 'PluginPanels.tsx'), 'utf8')
    assert.equal(panels.indexOf('export function ResearchWorkspace'), -1, '旧的双框工作区应该删掉')
    const app = readFileSync(path.join(ROOT, 'src', 'renderer', 'App.tsx'), 'utf8')
    assert.equal(app.indexOf('ResearchWorkspace'), -1, '应用层不该再按插件 id 特判')
    // 外壳自己用嵌套帧装模块：文档由宿主代读（host.asset），再塞进 srcdoc
    const shell = readFileSync(path.join(RESEARCH_DIR, 'ui.html'), 'utf8')
    assert.match(shell, /host\.asset/)
    assert.match(shell, /srcdoc/)
  })

  await it('AI 能力：清单认 ai，模型挑选只认带 Key 的 API 通道', () => {
    const mk = (id: string, patch: Partial<ModelConfig> = {}): ModelConfig => ({
      id,
      displayName: id,
      transport: 'api',
      api: { baseUrl: 'https://api.test', model: id, apiKeyRef: 'key:' + id },
      color: '#000000',
      supportsStructuredOutput: true,
      enabled: true,
      ...patch,
    })
    const models = [
      mk('web', { transport: 'webview', api: undefined }),
      mk('good'),
      mk('alt'),
      mk('nokey', { api: { baseUrl: 'https://api.test', model: 'nokey', apiKeyRef: 'key:nokey' } }),
      mk('off', { enabled: false }),
    ]
    const hasKey = (ref: string) => ref === 'key:good' || ref === 'key:alt'
    assert.equal(pickPluginModel(models, undefined, hasKey)?.id, 'good', '默认取第一个已启用且有 Key 的 API 模型')
    assert.equal(pickPluginModel(models, undefined, hasKey, 'alt')?.id, 'alt', '不点名时跟助手的模型走')
    assert.equal(pickPluginModel(models, undefined, hasKey, 'off')?.id, 'good', '助手选的模型停用了，退回首个可用')
    assert.equal(pickPluginModel(models, undefined, hasKey, 'nokey')?.id, 'good', '助手选的模型没 Key，不能借道')
    assert.equal(pickPluginModel(models, 'alt', hasKey, 'good')?.id, 'alt', '点名优先于跟随助手')
    assert.equal(pickPluginModel(models, 'good', hasKey)?.id, 'good')
    assert.equal(pickPluginModel(models, 'nokey', hasKey), null, '指定了没 Key 的模型不能借道')
    assert.equal(pickPluginModel(models, 'web', hasKey), null, '网页通道不能借给插件')
    assert.equal(pickPluginModel(models, 'missing', hasKey), null)
    assert.equal(pickPluginModel([], undefined, hasKey), null)
  })

  await it('宿主 AI 闸门：没声明 / 超长 / 无通道 / 并发都被拒', async () => {
    const dir = tmpDir()
    const manifestOf = (permissions: string[]): PluginManifest => ({
      id: 'probe',
      name: 'probe',
      version: '0.0.0',
      apiVersion: 1,
      description: '',
      permissions: permissions as PluginManifest['permissions'],
    })
    const deps = (ai?: {
      complete(req: { prompt: string }): Promise<unknown>
      models?(): {
        models: Array<{ id: string; name: string; model: string; enabled: boolean; hasKey: boolean }>
        preferred: string | null
      }
    }) => ({
      dataDir: dir,
      entryPath: path.join(dir, 'runtime-entry.js'),
      secrets: { get: () => null },
      log() {},
      ...(ai ? { ai } : {}),
    })
    const gateOf = (runtime: PluginRuntime) => (method: string, params: Record<string, unknown>) => {
      const host = runtime as unknown as {
        handleHostCall(m: string, p: Record<string, unknown>): Promise<unknown>
      }
      return host.handleHostCall(method, params)
    }
    const reply = {
      text: 'ok',
      modelId: 'm',
      model: 'M',
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
    }
    try {
      const seen: Array<{ prompt: string }> = []
      const allowed = new PluginRuntime(manifestOf(['ai']), dir, deps({
        async complete(req) {
          seen.push(req)
          return reply
        },
        models: () => ({
          models: [{ id: 'm', name: 'M', model: 'm-1', enabled: true, hasKey: true }],
          preferred: 'm',
        }),
      }))
      const out = (await gateOf(allowed)('ai.complete', { prompt: 'ping', system: 'sys' })) as { text: string }
      assert.equal(out.text, 'ok')
      assert.equal(seen.length, 1)
      assert.equal(seen[0]!.prompt, 'ping')
      const listed = (await gateOf(allowed)('ai.models', {})) as { preferred: string | null }
      assert.equal(listed.preferred, 'm', '面板要能列出模型，并知道不指定时用谁')

      const denied = new PluginRuntime(manifestOf(['storage']), dir, deps({ async complete() { return reply } }))
      await assert.rejects(gateOf(denied)('ai.complete', { prompt: 'x' }), /没有声明「ai」/)
      await assert.rejects(gateOf(denied)('ai.models', {}), /没有声明「ai」/)
      const noChannel = new PluginRuntime(manifestOf(['ai']), dir, deps())
      await assert.rejects(gateOf(noChannel)('ai.complete', { prompt: 'x' }), /没有接入/)
      await assert.rejects(gateOf(noChannel)('ai.models', {}), /没有接入/)
      await assert.rejects(gateOf(allowed)('ai.complete', { prompt: '   ' }), /缺少 prompt/)
      await assert.rejects(
        gateOf(allowed)('ai.complete', { prompt: 'x'.repeat(AI_PROMPT_MAX_CHARS + 1) }),
        /过长/,
      )
      await assert.rejects(
        gateOf(allowed)('ai.complete', { prompt: 'x', system: 's'.repeat(AI_SYSTEM_MAX_CHARS + 1) }),
        /系统提示过长/,
      )

      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let active = 0
      let peak = 0
      const bounded = new PluginRuntime(manifestOf(['ai']), dir, deps({
        async complete() {
          active += 1
          peak = Math.max(peak, active)
          await gate
          active -= 1
          return reply
        },
      }))
      const first = gateOf(bounded)('ai.complete', { prompt: 'a' })
      const second = gateOf(bounded)('ai.complete', { prompt: 'b' })
      const third = gateOf(bounded)('ai.complete', { prompt: 'c' })
      await assert.rejects(third, /2 个 AI 请求/)
      release()
      await Promise.all([first, second])
      assert.equal(peak, 2, '并发上限 2 要真生效')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('研究主线图 AI：起草/推演/评审先预览，accept 才落库', async () => {
    const backend = await loadBackend(TRAJECTORY_DIR, 'trajectory')
    const created = (await backend.rpc['project.create']!({ title: 'MoE', question: '容量因子怎么调' })) as {
      project: { id: string }
    }
    const pid = created.project.id
    const seed = (await backend.rpc['node.add']!({ projectId: pid, title: '已有种子节点', kind: 'claim' })) as {
      id: string
    }

    const status = (await backend.rpc['ai.status']!({})) as { available: boolean; model: string }
    assert.equal(status.available, true)
    assert.equal(status.model, '')

    const draft = (await backend.rpc['ai.plan']!({ projectId: pid, question: '容量因子怎么调', goal: '找方法' })) as {
      nodes: Array<{ key: string; title: string; parents: string[] }>
      hypotheses: Array<{ statement: string; evidence: string[] }>
      summary: string
      model: string
    }
    assert.equal(draft.nodes.length, 3)
    assert.deepEqual(draft.nodes[1]!.parents, ['a1', seed.id], '只保留本次 key 或已有 id，编出来的上游丢掉')
    assert.deepEqual(draft.hypotheses[0]!.evidence, ['a2'], '不存在的证据 id 不能进草案')
    assert.equal(draft.model, '测试模型')
    assert.ok(draft.summary.includes('对照实验'))

    const accepted = (await backend.rpc['ai.accept.plan']!({ projectId: pid, draft })) as {
      added: Array<{ key: string; id: string }>
      links: number
      hypotheses: number
      warnings: string[]
      project: { nodes: Array<{ id: string; parents: string[] }>; hypotheses: Array<{ id: string; evidence: string[] }> }
    }
    assert.equal(accepted.added.length, 3)
    assert.ok(accepted.links >= 3)
    assert.equal(accepted.hypotheses, 1)
    assert.deepEqual(accepted.warnings, [])
    const a1 = accepted.added.find((n) => n.key === 'a1')!
    const a2 = accepted.added.find((n) => n.key === 'a2')!
    assert.deepEqual(
      accepted.project.nodes.find((n) => n.id === a2.id)!.parents,
      [a1.id, seed.id],
    )

    const partial = (await backend.rpc['ai.accept.plan']!({
      projectId: pid,
      draft: {
        nodes: [
          { key: 'x1', title: '补充节点', kind: 'claim', parents: ['ghost'] },
          { key: 'x2', title: '', kind: 'claim' },
        ],
        hypotheses: [],
      },
    })) as { added: unknown[]; links: number; warnings: string[] }
    assert.equal(partial.added.length, 1, '空标题节点不能写入')
    assert.equal(partial.links, 0, '不认识的上游不能连边')
    assert.match(partial.warnings[0]!, /标题不能为空/)

    const step = (await backend.rpc['ai.next']!({ projectId: pid, focus: '推进实验' })) as {
      proposals: Array<Record<string, unknown>>
    }
    assert.equal(step.proposals.length, 3, '认不出的假设 id 在预览阶段就被丢掉')
    const update = step.proposals.find((p) => p.type === 'update_node') as { nodeId: string; status: string }
    assert.equal(update.nodeId, seed.id)
    assert.equal(update.status, 'doing')
    const added = step.proposals.find((p) => p.type === 'add_node') as { parents: string[] }
    assert.deepEqual(added.parents, [])

    const applied = (await backend.rpc['ai.accept.proposals']!({
      projectId: pid,
      proposals: [...step.proposals, { type: 'update_node', nodeId: 'n_ghost', status: 'done' }],
    })) as { applied: Array<{ type: string }>; warnings: string[] }
    assert.equal(applied.applied.length, 3)
    assert.match(applied.warnings[0]!, /n_ghost/)

    const review = (await backend.rpc['ai.critique']!({ projectId: pid })) as {
      issues: Array<{ severity: string; target: string; topic: string }>
      facts: Array<{ label: string }>
    }
    assert.equal(review.issues[0]!.severity, 'high', '按严重度排序')
    assert.equal(review.issues.find((i) => i.topic === '结论早于实验')!.target, seed.id)
    assert.equal(review.issues.find((i) => i.topic === '假设无证据')!.target, '', '编出来的 target 要清空')
    assert.ok(review.facts.some((f) => f.label === '没有上游的节点'), '本地结构信号要随评审一起给')

    const hypothesisId = accepted.project.hypotheses[0]!.id
    const q = (await backend.rpc['ai.evidence.queries']!({ projectId: pid, hypothesisId })) as { queries: string[] }
    assert.equal(q.queries.length, 2)
    const found = (await backend.rpc['ai.evidence.search']!({ queries: q.queries, perQuery: 4 })) as {
      candidates: Array<{ key: string; title: string }>
    }
    assert.equal(found.candidates.length, 2, 'arXiv 与 Crossref 的同一篇按 DOI 合并')
    assert.equal(found.candidates[0]!.key, 'doi:10.1000/test')
    const screened = (await backend.rpc['ai.evidence.screen']!({
      projectId: pid,
      hypothesisId,
      candidates: found.candidates,
    })) as { picks: Array<{ key: string; stance: string }> }
    assert.deepEqual(screened.picks.map((p) => p.key), found.candidates.map((c) => c.key), '只保留候选表里的 id')
    assert.equal(screened.picks[1]!.stance, 'neutral')

    const evidenceInput = { projectId: pid, hypothesisId, candidates: found.candidates, picks: screened.picks }
    const ev = (await backend.rpc['ai.accept.evidence']!(evidenceInput)) as {
      added: Array<{ title: string; stance: string }>
      duplicated: number
      total: number
    }
    assert.equal(ev.added.length, 2)
    assert.equal(ev.total, 2)
    const again = (await backend.rpc['ai.accept.evidence']!(evidenceInput)) as {
      added: unknown[]
      duplicated: number
      total: number
    }
    assert.equal(again.added.length, 0)
    assert.equal(again.duplicated, 2)
    assert.equal(again.total, 2)

    const toolAdd = (await backend.tools['trajectory_add_source']!({
      projectId: pid,
      hypothesisId,
      title: '另一篇',
      doi: '10.1000/third',
      stance: 'refutes',
      why: '结果相反',
    })) as { added: string[]; total: number }
    assert.deepEqual(toolAdd.added, ['另一篇'])
    assert.equal(toolAdd.total, 3)
    const dupTool = (await backend.tools['trajectory_add_source']!({
      projectId: pid,
      hypothesisId,
      title: '同 DOI 换写法',
      doi: 'https://doi.org/10.1000/THIRD',
      stance: 'neutral',
    })) as { added: string[]; total: number }
    assert.deepEqual(dupTool.added, [], 'DOI 换了写法也是同一篇')
    assert.equal(dupTool.total, 3)

    const offline = await loadBackend(TRAJECTORY_DIR, 'trajectory', { ai: false })
    assert.equal(((await offline.rpc['ai.status']!({})) as { available: boolean }).available, false)
    const offProject = (await offline.rpc['project.create']!({ title: 'T' })) as { project: { id: string } }
    await assert.rejects(offline.rpc['ai.plan']!({ projectId: offProject.project.id, question: 'Q' }), /AI 通道/)
    const offSearch = (await offline.rpc['ai.evidence.search']!({ queries: ['routing'] })) as {
      candidates: unknown[]
    }
    assert.equal(offSearch.candidates.length, 2, '检索不依赖模型：AI 通道断了也能先取回候选')
  })

  await it('学者工作台 AI：检索式→筛选→精读→对比→Idea→入库全链路', async () => {
    const backend = await loadBackend(SCHOLAR_DIR, 'scholar')
    const status = (await backend.rpc['ai.status']!({})) as { available: boolean }
    assert.equal(status.available, true)

    const list = (await backend.rpc['ai.models']!({})) as {
      supported: boolean
      selected: string
      preferred: string
      models: Array<{ id: string; enabled: boolean; hasKey: boolean }>
    }
    assert.equal(list.supported, true)
    assert.equal(list.selected, '', '默认跟随助手，不替用户锁死一个模型')
    assert.equal(list.preferred, 'm1')
    assert.equal(list.models.length, 4)
    await assert.rejects(backend.rpc['ai.set-model']!({ modelId: 'ghost' }), /不在可用清单/)
    await assert.rejects(backend.rpc['ai.set-model']!({ modelId: 'm3' }), /已停用/)
    await assert.rejects(backend.rpc['ai.set-model']!({ modelId: 'm4' }), /还没有 API Key/)
    const switched = (await backend.rpc['ai.set-model']!({ modelId: 'm2' })) as { selected: string }
    assert.equal(switched.selected, 'm2')
    assert.equal(
      ((await backend.rpc['ai.models']!({})) as { selected: string }).selected,
      'm2',
      '重开面板还要记得上次选的模型',
    )

    const plan = (await backend.rpc['ai.plan']!({ question: 'MoE 路由容量怎么调', goal: '综述' })) as {
      queries: string[]
      include: string[]
      note: string
      model: string
    }
    assert.equal(plan.queries.length, 2)
    assert.equal(plan.include[0], '实证研究')
    assert.equal(plan.model, '测试模型')
    assert.equal(lastAiModelId, 'm2', '面板选的模型要真的传给宿主，不能只停在界面上')

    const gather = (await backend.rpc['ai.gather']!({ queries: plan.queries, perQuery: 4 })) as {
      candidates: Array<{ key: string; title: string }>
    }
    assert.equal(gather.candidates.length, 2)

    // 取回这一步的检索路线要真的传下去：源、排序、年份都在检索层生效
    const routed = (await backend.rpc['ai.gather']!({
      queries: ['routing'],
      perQuery: 3,
      sources: ['crossref', 'openalex'],
      sort: 'cited',
      yearFrom: '2023',
    })) as {
      candidates: Array<{ year: string; sources: string[] }>
      sources: Array<{ id: string; count: number }>
    }
    assert.equal(routed.candidates.length, 1, '年份过滤应把 2022 那篇挡在外面')
    assert.equal(routed.candidates[0]!.year, '2023')
    assert.deepEqual(routed.sources.map((s) => s.id).slice().sort(), ['crossref', 'openalex'])
    assert.ok(routed.candidates[0]!.sources.includes('openalex'), '合并后的条目要带上它出现过的源')

    const screen = (await backend.rpc['ai.screen']!({ question: 'MoE', candidates: gather.candidates })) as {
      picks: Array<{ key: string; relevance: string }>
    }
    assert.deepEqual(screen.picks.map((p) => p.key), gather.candidates.map((c) => c.key))
    assert.equal(screen.picks[0]!.relevance, 'high')

    const notes = (await backend.rpc['ai.notes']!({ question: 'MoE', papers: gather.candidates })) as {
      notes: Array<{ key: string; conclusion: string; experiments: string }>
    }
    assert.equal(notes.notes.length, 2, '编出来的论文 id 不能进精读卡片')
    assert.match(notes.notes[0]!.experiments, /摘要未提/)

    const noteOf = new Map(notes.notes.map((n) => [n.key, n]))
    const synth = (await backend.rpc['ai.synthesize']!({
      question: 'MoE',
      papers: gather.candidates.map((c) => ({ ...c, ...noteOf.get(c.key) })),
    })) as {
      dimensions: string[]
      rows: Array<{ key: string; cells: string[] }>
      summary: string
      gaps: string[]
    }
    assert.equal(synth.dimensions.length, 2)
    assert.equal(synth.rows.length, 2)
    assert.ok(synth.rows.every((r) => r.cells.length === 2), '单元格数补齐到维度数')

    const ideas = (await backend.rpc['ai.ideas']!({
      question: 'MoE',
      papers: gather.candidates,
      gaps: synth.gaps,
    })) as { ideas: Array<{ title: string; paperKeys: string[] }> }
    assert.deepEqual(ideas.ideas[0]!.paperKeys, [gather.candidates[0]!.key], '编出来的论文 id 不能进 Idea 关联')

    const accepted = (await backend.rpc['ai.accept']!({
      candidates: gather.candidates,
      keys: gather.candidates.map((c) => c.key),
      notes: notes.notes,
      tag: 'AI 调研',
    })) as {
      added: string[]
      duplicated: string[]
      saved: Array<{ key: string; id: string }>
      notesWritten: number
    }
    assert.equal(accepted.added.length, 2)
    assert.equal(accepted.duplicated.length, 0)
    assert.equal(accepted.notesWritten, 2)

    const firstId = accepted.saved[0]!.id
    await backend.rpc['reading.save']!({ paperId: firstId, conclusion: '人手写的结论' })
    const again = (await backend.rpc['ai.accept']!({
      candidates: gather.candidates,
      keys: [gather.candidates[0]!.key],
      notes: [{ key: gather.candidates[0]!.key, conclusion: 'AI 想覆盖', evidence: '证据' }],
      tag: 'AI 调研',
    })) as { added: string[]; duplicated: string[]; notesWritten: number }
    assert.deepEqual(again.duplicated, [firstId])
    assert.equal(again.notesWritten, 0, '已有人工笔记时不能再写')
    const card = (await backend.rpc['paper.get']!({ paperId: firstId })) as {
      paper: { reading: { conclusion: string; evidence: string } }
    }
    assert.equal(card.paper.reading.conclusion, '人手写的结论')
    assert.ok(card.paper.reading.evidence.length > 0)

    const offline = await loadBackend(SCHOLAR_DIR, 'scholar', { ai: false })
    assert.equal(((await offline.rpc['ai.status']!({})) as { available: boolean }).available, false)
    assert.equal(((await offline.rpc['ai.models']!({})) as { supported: boolean }).supported, false, '没有 AI 通道时不显示模型下拉')
    await assert.rejects(offline.rpc['ai.plan']!({ question: 'Q' }), /AI 通道/)
    const offGather = (await offline.rpc['ai.gather']!({ queries: ['routing'] })) as { candidates: unknown[] }
    assert.equal(offGather.candidates.length, 2, '检索不依赖模型：AI 通道断了也能先取回候选')
  })

  await it('学者工作台：MinerU 全文按需解析，全文进精读而不是只喂摘要', async () => {
    const backend = await loadBackend(SCHOLAR_DIR, 'scholar')

    const added = (await backend.rpc['paper.add']!({ arxivId: '2401.00001' })) as {
      paper: { id: string; title: string; arxivId: string }
    }
    const card = (await backend.rpc['paper.get']!({ paperId: added.paper.id })) as {
      paper: { pdfUrl: string; full: { state: string } }
    }
    assert.equal(card.paper.pdfUrl, 'https://arxiv.org/pdf/2401.00001', 'arXiv 编号要能推导出公开 PDF')
    assert.equal(card.paper.full.state, 'idle')

    const started = (await backend.rpc['fulltext.start']!({ paperId: added.paper.id })) as {
      full: { state: string; taskId: string; url: string }
    }
    assert.equal(started.full.state, 'queued')
    assert.equal(started.full.taskId, 'task-ok')
    assert.equal(mineruSubmit?.body.url, 'https://arxiv.org/pdf/2401.00001', '交给 MinerU 的必须是推导出的 PDF 地址')

    const done = (await backend.rpc['fulltext.poll']!({ paperId: added.paper.id })) as {
      full: { state: string; chars: number; trimmed: boolean }
    }
    assert.equal(done.full.state, 'done')
    assert.ok(done.full.chars > 0)
    const ftKey = `ft:${added.paper.id}`
    assert.ok(backend.keys().includes(ftKey), '全文要单独存一个键，删论文时能一起清掉')

    const got = (await backend.rpc['fulltext.get']!({ paperId: added.paper.id })) as { text: string; chars: number }
    assert.match(got.text, /8 GPUs/, '正文里的实验细节要读得到')
    assert.doesNotMatch(got.text, /!\[/, '图片链接不落盘，免得到处是破图')

    // 全文已经在本机：精读提示词里要出现节选，不能再只写「题名与摘要」
    const notes = (await backend.rpc['ai.notes']!({
      question: 'Transformer 怎么训练',
      papers: [{ id: added.paper.id, title: added.paper.title, arxivId: '2401.00001', abstract: '摘要' }],
    })) as { notes: Array<{ key: string }> }
    assert.equal(notes.notes.length, 1)
    assert.match(lastAiPrompt, /全文节选（MinerU 解析/, '有全文就该把节选喂给精读')
    assert.match(lastAiPrompt, /8 GPUs/, '节选要带正文里的数字')

    // 解析失败要留下原因，而不是只给一个 failed
    const broken = (await backend.rpc['paper.add']!({
      title: '没有公开全文',
      url: 'https://example.com/fail.pdf',
    })) as { paper: { id: string } }
    await backend.rpc['fulltext.start']!({ paperId: broken.paper.id })
    const failed = (await backend.rpc['fulltext.poll']!({ paperId: broken.paper.id })) as {
      full: { state: string; note: string }
    }
    assert.equal(failed.full.state, 'failed')
    assert.match(failed.full.note, /20 页/)

    // 没有公开 PDF 的论文不要硬提交
    const manual = (await backend.rpc['paper.add']!({ title: '付费墙里的论文' })) as { paper: { id: string } }
    await assert.rejects(backend.rpc['fulltext.start']!({ paperId: manual.paper.id }), /公开 PDF/)

    await backend.rpc['fulltext.clear']!({ paperId: added.paper.id })
    assert.ok(!backend.keys().includes(ftKey), '清除后不留全文')
    const cleared = (await backend.rpc['fulltext.get']!({ paperId: added.paper.id })) as { full: { state: string } }
    assert.equal(cleared.full.state, 'idle')

    // 纯函数：地址推导、节选去参考文献、按字节截断
    const ft = localRequire(path.join(SCHOLAR_DIR, 'fulltext.js')) as {
      pdfUrlFor: (paper: Record<string, unknown>) => string
      excerpt: (text: string, max: number) => string
      trimToBytes: (text: string, max: number) => { text: string; trimmed: boolean }
    }
    assert.equal(ft.pdfUrlFor({ doi: '10.48550/arXiv.1706.03762' }), 'https://arxiv.org/pdf/1706.03762')
    assert.equal(ft.pdfUrlFor({ url: 'https://example.org/paper.pdf?dl=1' }), 'https://example.org/paper.pdf?dl=1')
    assert.equal(ft.pdfUrlFor({ url: 'https://doi.org/10.1000/paywall' }), '', 'DOI 落地页不是 PDF，别硬发')
    const long = '实验段落。'.repeat(3000) + '\n\n## References\n' + 'x'.repeat(5000)
    const ex = ft.excerpt(long, 5000)
    assert.ok(ex.length <= 5050, '节选要守上限')
    assert.doesNotMatch(ex, /References/, '节选丢掉参考文献，别把额度浪费在引用列表上')
    const trimmed = ft.trimToBytes('汉'.repeat(400000), 100 * 1024)
    assert.equal(trimmed.trimmed, true)
    assert.ok(Buffer.byteLength(trimmed.text, 'utf8') <= 100 * 1024, '截断按字节算，中文不能按字符糊弄')

    const ui = readFileSync(path.join(SCHOLAR_DIR, 'ui.html'), 'utf8')
    assert.match(ui, /data-ft-start/, '精读页要有解析入口')
    assert.match(ui, /setInterval\(ftTick, 5000\)/, '解析要轮询，不能卡住一次长请求')
    assert.match(ui, /id="read-fulltext"/, '全文状态要有落点')
  })

  await it('学者工作台：项目/会话/文件随会话持久，删项目只把会话退到未归类', async () => {
    const backend = await loadBackend(SCHOLAR_DIR, 'scholar')

    const project = (await backend.rpc['project.create']!({ title: 'MoE 调研' })) as { project: { id: string } }
    await assert.rejects(backend.rpc['project.create']!({ title: 'MoE 调研' }), /同名项目/)
    const session = (await backend.rpc['session.create']!({ projectId: project.project.id, goal: '综述' })) as {
      session: { id: string; title: string; goal: string }
    }
    assert.equal(session.session.title, '新会话')
    await assert.rejects(backend.rpc['session.create']!({ projectId: 'prj_missing' }), /项目不存在/)
    await assert.rejects(backend.rpc['session.append']!({ sessionId: 's_missing', kind: 'question', text: 'x' }), /找不到这个会话/)

    const asked = (await backend.rpc['session.append']!({
      sessionId: session.session.id,
      role: 'user',
      kind: 'question',
      text: 'MoE 路由容量怎么调',
    })) as { message: { role: string; kind: string }; session: { title: string } }
    assert.equal(asked.message.role, 'user')
    assert.equal(asked.session.title, 'MoE 路由容量怎么调', '第一个问题成为会话标题')

    const planned = (await backend.rpc['session.append']!({
      sessionId: session.session.id,
      role: 'ai',
      kind: 'plan',
      data: { queries: ['moe routing'] },
    })) as { session: { messages: number } }
    assert.equal(planned.session.messages, 2)

    const huge = (await backend.rpc['session.append']!({
      sessionId: session.session.id,
      role: 'ai',
      kind: 'gather',
      data: { candidates: [{ key: 'k', title: 'x'.repeat(70000) }] },
    })) as { message: { data: { truncated?: boolean; preview?: string } } }
    assert.equal(huge.message.data.truncated, true, '单条消息过大时退化成预览，别撑爆存储')

    const file = (await backend.rpc['session.attach']!({
      sessionId: session.session.id,
      name: '检索计划.md',
      kind: 'note',
      text: '# 计划',
    })) as { file: { id: string }; session: { files: number } }
    assert.equal(file.session.files, 1)

    const got = (await backend.rpc['session.get']!({ sessionId: session.session.id })) as {
      session: { messages: Array<{ kind: string }>; files: Array<{ id: string; text: string }> }
      project: { id: string } | null
    }
    assert.deepEqual(got.session.messages.map((m) => m.kind), ['question', 'plan', 'gather'])
    assert.equal(got.session.files[0]!.text, '# 计划')
    assert.equal(got.project!.id, project.project.id)

    await backend.rpc['session.detach']!({ sessionId: session.session.id, fileId: file.file.id })
    const listed = (await backend.rpc['session.list']!({ projectId: project.project.id })) as {
      sessions: Array<{ id: string; files: number }>
    }
    assert.equal(listed.sessions[0]!.files, 0)

    const removed = (await backend.rpc['project.remove']!({ projectId: project.project.id })) as { detached: number }
    assert.equal(removed.detached, 1)
    const orphan = (await backend.rpc['session.get']!({ sessionId: session.session.id })) as {
      session: { projectId: string }
      project: null
    }
    assert.equal(orphan.session.projectId, '')
    assert.equal(orphan.project, null)
    const loose = (await backend.rpc['session.list']!({ projectId: '' })) as { sessions: unknown[] }
    assert.equal(loose.sessions.length, 1, '未归类按空 projectId 过滤，不是「不过滤」')
    assert.equal(((await backend.rpc['session.list']!({})) as { sessions: unknown[] }).sessions.length, 1)
  })

  await it('学者工作台：文档写作 + [CITE:] 标注 + 多格式导出', async () => {
    const backend = await loadBackend(SCHOLAR_DIR, 'scholar')

    const project = (await backend.rpc['project.create']!({ title: '写作项目' })) as { project: { id: string } }
    const p1 = (await backend.rpc['paper.add']!({
      title: 'Routing at Scale',
      authors: ['Doe, Jane'],
      year: '2023',
      venue: 'SIGIR',
      impactFactor: 9.5,
    })) as { paper: { id: string; impactFactor: number } }
    const p2 = (await backend.rpc['paper.add']!({
      title: '专家混合的路由容量',
      authors: ['李雷'],
      year: '2024',
      venue: '计算机学报',
      impactFactor: 3.2,
    })) as { paper: { id: string } }
    const p3 = (await backend.rpc['paper.add']!({
      title: 'Unrated Preprint',
      authors: ['Smith, Ann'],
      year: '2022',
      impactFactor: -1,
    })) as { paper: { id: string; impactFactor: string } }
    assert.equal(p1.paper.impactFactor, 9.5)
    assert.equal(p3.paper.impactFactor, '', '非法影响因子留空，不拿 0 冒充')

    const byImpact = (await backend.rpc['paper.list']!({ minImpact: 5 })) as { papers: Array<{ id: string }> }
    assert.deepEqual(byImpact.papers.map((p) => p.id), [p1.paper.id])
    const byYear = (await backend.rpc['paper.list']!({ yearFrom: '2024' })) as { papers: Array<{ id: string }> }
    assert.deepEqual(byYear.papers.map((p) => p.id), [p2.paper.id])
    const byVenue = (await backend.rpc['paper.list']!({ venue: 'sigir' })) as { papers: Array<{ id: string }> }
    assert.deepEqual(byVenue.papers.map((p) => p.id), [p1.paper.id])

    await assert.rejects(backend.rpc['doc.create']!({ projectId: 'prj_missing' }), /项目不存在/)
    const doc = (await backend.rpc['doc.create']!({ projectId: project.project.id, title: 'MoE 综述' })) as {
      doc: { id: string; title: string; history: Array<{ kind: string }> }
    }
    assert.equal(doc.doc.title, 'MoE 综述')
    assert.equal(doc.doc.history[0]!.kind, 'create')

    const body =
      '路由容量是核心问题 [CITE:Routing at Scale]；中文路线 [CITE:专家混合 2024]；再提一次 [CITE:Routing at Scale]。'
    const saved = (await backend.rpc['doc.update']!({ docId: doc.doc.id, body })) as {
      doc: { pending: number; citations: { unresolved: Array<{ hint: string; count: number }> } }
    }
    assert.equal(saved.doc.pending, 3)
    assert.deepEqual(
      saved.doc.citations.unresolved.map((u) => [u.hint, u.count]),
      [['Routing at Scale', 2], ['专家混合 2024', 1]],
    )

    const hinted = (await backend.rpc['doc.suggest']!({ hint: 'Routing at Scale' })) as {
      items: Array<{ paper: { id: string }; why: string }>
    }
    assert.equal(hinted.items[0]!.paper.id, p1.paper.id)
    assert.ok(hinted.items[0]!.why.length > 0)
    await assert.rejects(backend.rpc['doc.suggest']!({ hint: '   ' }), /标记是空的/)
    await assert.rejects(
      backend.rpc['doc.annotate']!({ docId: doc.doc.id, hint: '不存在', paperId: p1.paper.id }),
      /找不到这个标记/,
    )

    const first = (await backend.rpc['doc.annotate']!({
      docId: doc.doc.id,
      hint: 'Routing at Scale',
      paperId: p1.paper.id,
    })) as { doc: { body: string; cites: number } }
    assert.equal(
      (first.doc.body.match(new RegExp('\\[CITE:#' + p1.paper.id + '\\]', 'g')) || []).length,
      2,
      '同一提示的重复标记一起替换',
    )
    assert.equal(first.doc.cites, 1)

    const second = (await backend.rpc['doc.annotate']!({
      docId: doc.doc.id,
      hint: '专家混合 2024',
      paperId: p2.paper.id,
    })) as { doc: { body: string; pending: number; cites: number } }
    assert.equal(second.doc.pending, 0)
    assert.equal(second.doc.cites, 2)

    const md = (await backend.rpc['doc.export']!({ docId: doc.doc.id, format: 'markdown' })) as {
      text: string
      filename: string
    }
    assert.match(md.text, /\[1\]/)
    assert.match(md.text, /\[2\]/)
    assert.match(md.text, /## 参考文献/)
    assert.match(md.filename, /MoE 综述-\d{4}-\d{2}-\d{2}\.md$/)

    const html = (await backend.rpc['doc.export']!({ docId: doc.doc.id, format: 'html' })) as { text: string }
    assert.match(html.text, /<ol>/)
    assert.match(html.text, /<li>/)

    const bib = (await backend.rpc['doc.export']!({ docId: doc.doc.id, format: 'bibtex' })) as {
      text: string
      filename: string
    }
    assert.match(bib.text, /@(article|misc)\{/)
    assert.match(bib.filename, /\.bib$/)

    const ris = (await backend.rpc['doc.export']!({ docId: doc.doc.id, format: 'ris' })) as {
      text: string
      filename: string
    }
    assert.match(ris.text, /TY {2}- JOUR/)
    assert.match(ris.text, /ER {2}- /)
    assert.match(ris.filename, /\.ris$/)

    const reopened = (await backend.rpc['doc.get']!({ docId: doc.doc.id })) as {
      doc: { history: Array<{ kind: string }> }
    }
    assert.equal(reopened.doc.history[0]!.kind, 'export', '导出会写进历史')

    await backend.rpc['doc.update']!({ docId: doc.doc.id, body: second.doc.body + '\n待补 [CITE:冷启动]' })
    const pendingDoc = (await backend.rpc['doc.export']!({ docId: doc.doc.id, format: 'markdown' })) as { text: string }
    assert.match(pendingDoc.text, /\[\?\]/, '没标完的提示在导出里显示 [?]，不假装已解决')

    const risStyle = (await backend.rpc['cite']!({ paperIds: [p1.paper.id, p2.paper.id], style: 'ris' })) as {
      items: Array<{ text: string }>
    }
    assert.match(risStyle.items[0]!.text, /^TY {2}- JOUR/)
    const mdStyle = (await backend.rpc['cite']!({ paperIds: [p1.paper.id], style: 'markdown' })) as {
      items: Array<{ text: string }>
    }
    assert.match(mdStyle.items[0]!.text, /^1\. /)
    const htmlStyle = (await backend.rpc['cite']!({ paperIds: [p1.paper.id], style: 'html' })) as {
      items: Array<{ text: string }>
    }
    assert.match(htmlStyle.items[0]!.text, /^<li>/)

    const listed = (await backend.rpc['doc.list']!({ projectId: project.project.id })) as { docs: Array<{ id: string }> }
    assert.equal(listed.docs.length, 1)
    const removed = (await backend.rpc['project.remove']!({ projectId: project.project.id })) as { detached: number }
    assert.equal(removed.detached, 1)
    const loose = (await backend.rpc['doc.list']!({ projectId: '' })) as { docs: Array<{ id: string; projectId: string }> }
    assert.equal(loose.docs.length, 1)
    assert.equal(loose.docs[0]!.projectId, '', '删项目只把文档退到未归类')

    await backend.rpc['doc.remove']!({ docId: doc.doc.id })
    assert.equal(((await backend.rpc['doc.list']!({})) as { docs: unknown[] }).docs.length, 0)
  })

  console.log(`${'-'.repeat(46)}\n${pass} passed, ${fail} failed\n`)

  if (fail > 0) process.exit(1)
}

/** 清单 fixture 里的 id 改成目录名后，工具前缀也要跟着改，否则会先撞上前缀校验 */
function embeddedToolNames(m: Record<string, any>, id: string): void {
  const contributes = m.contributes
  if (!contributes || !Array.isArray(contributes.tools)) return
  for (const tool of contributes.tools) {
    tool.name = String(tool.name).replace(/^research_/, `${id}_`)
  }
}

/** 模块工具与合并清单的对应关系：模块叫 scholar_add_paper，清单里就是 research_add_paper */
function assertModuleTools(backend: { tools: Record<string, unknown> }, moduleId: string): void {
  const names = Object.keys(backend.tools).sort()
  assert.ok(names.length > 0, `${moduleId}: 没有注册工具`)
  for (const name of names) {
    assert.ok(name.startsWith(`${moduleId}_`), `${name} 不该属于 ${moduleId}`)
    const tail = name.slice(moduleId.length + 1)
    assert.ok(RESEARCH_TOOL_NAMES.includes(`research_${tail}`), `合并清单里缺 research_${tail}`)
  }
}

/** 用内存存储把真入口跑起来：工具与面板接口共用同一份状态 */
async function loadBackend(
  dir: string,
  id: string,
  opts: {
    ai?: boolean
    /** 插件密钥：缺省返回 null，和「用户没填」一致 */
    secret?: (name: string) => Promise<string | null>
  } = {},
): Promise<{
  tools: Record<string, (params: Record<string, unknown>) => Promise<unknown>>
  rpc: Record<string, (params: Record<string, unknown>) => Promise<unknown>>
  /** 落过的存储键：合并插件靠它验证命名空间 */
  keys(): string[]
}> {
  const store = new Map<string, unknown>()
  const tools: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {}
  const rpc: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {}
  lastAiModelId = ''
  lastAiPrompt = ''
  mineruSubmit = null
  openAlexCalls = []
  const mod = localRequire(path.join(dir, 'main.js')) as { activate(ctx: unknown): Promise<void> }
  const ctx = {
    id,
    version: '0.1.0',
    dataDir: 'memory',
    log() {},
    storage: {
      async get(key: string) {
        return store.get(key)
      },
      async set(key: string, value: unknown) {
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
      async delete(key: string) {
        return store.delete(key)
      },
      async list() {
        return [...store.keys()]
      },
    },
    /** 假元数据服务：只认 arXiv / Crossref 两个域名，形状与真响应一致 */
    async fetch(input: { url: string; method?: string; body?: string }) {
      return fakeMetadata(input)
    },
    // 清单声明了 secrets 才会走到这里；没配密钥时插件按匿名额度继续
    secret: opts.secret ?? (async () => null),
    // 默认给一个确定性的假模型：只按 system 提示词分发 JSON，测试里不联网、不花钱
    ...(opts.ai === false ? {} : { ai: fakeAi() }),
    tools: { handle(name: string, fn: (params: Record<string, unknown>) => Promise<unknown>) { tools[name] = fn } },
    rpc: { handle(name: string, fn: (params: Record<string, unknown>) => Promise<unknown>) { rpc[name] = fn } },
  }
  await mod.activate(ctx)
  return { tools, rpc, keys: () => [...store.keys()] }
}

const ARXIV_ENTRY = (id: string, title: string, doi: string) => `
  <entry>
    <id>http://arxiv.org/abs/${id}v2</id>
    <published>2024-01-02T00:00:00Z</published>
    <title>${title}</title>
    <summary>We study routing &amp; balance.</summary>
    <author><name>Jane Doe</name></author>
    <author><name>李雷</name></author>
    <arxiv:doi>${doi}</arxiv:doi>
  </entry>`

/** OpenAlex 的作品：W1/W2 是检索能命中的两篇，W9 是种子引用过的，W3 是引用了种子的 */
const OPENALEX_W1 = {
  id: 'https://openalex.org/W1',
  doi: 'https://doi.org/10.1000/test',
  display_name: 'Routing at Scale',
  publication_year: 2023,
  cited_by_count: 12,
  referenced_works: ['https://openalex.org/W9'],
  primary_location: { source: { display_name: 'Journal of Tests' } },
  authorships: [{ author: { display_name: 'Jane Doe' } }],
  abstract_inverted_index: { Big: [0], small: [1] },
  type: 'article',
}
const OPENALEX_W2 = {
  ...OPENALEX_W1,
  id: 'https://openalex.org/W2',
  doi: 'https://doi.org/10.1000/other',
  display_name: 'Sparse Routing',
  publication_year: 2022,
  cited_by_count: 3,
  referenced_works: [],
  abstract_inverted_index: { Sparse: [0], gates: [1] },
}
const OPENALEX_W9 = {
  ...OPENALEX_W1,
  id: 'https://openalex.org/W9',
  doi: 'https://doi.org/10.1000/found',
  display_name: 'Routing Foundations',
  publication_year: 2019,
  cited_by_count: 100,
  referenced_works: [],
}
const OPENALEX_W3 = {
  ...OPENALEX_W1,
  id: 'https://openalex.org/W3',
  doi: 'https://doi.org/10.1000/citing',
  display_name: 'Scaling Routing Further',
  publication_year: 2024,
  cited_by_count: 1,
  referenced_works: ['https://openalex.org/W1'],
}
const OPENALEX_WORKS = [OPENALEX_W1, OPENALEX_W2, OPENALEX_W9, OPENALEX_W3]

let crossrefFlaky = 0
/** OpenAlex 收到的每一条 URL：验证用户配的 Key 真的带上了，而不是只存在钥匙串里 */
let openAlexCalls: string[] = []
/** 最近一次交给 MinerU 的提交：验证从 arXiv 编号推导出的 PDF 地址真的传下去了 */
let mineruSubmit: { url: string; body: { url?: string } } | null = null

const MINERU_MD = [
  '# Attention Is All You Need',
  '## Abstract',
  'We propose the Transformer, based solely on attention mechanisms.',
  '## 3 Model Architecture',
  'The encoder stacks six identical layers. 表 3 给出不同层数下的结果。',
  '![](images/fig1.jpg)',
  '## 5 Training',
  'We trained on 8 GPUs for 12 hours; the base model reaches 27.3 BLEU.',
  '## References',
  '1. Bahdanau et al. Neural machine translation.',
].join('\n\n')

function fakeMetadata(input: { url: string; method?: string; body?: string }): {
  status: number
  headers: Record<string, string>
  body: string
} {
  const url = input.url
  const ok = (body: string) => ({ status: 200, headers: {}, body })
  if (url.includes('mineru.net/api/v1/agent/parse/url')) {
    const payload = JSON.parse(input.body || '{}') as { url?: string }
    mineruSubmit = { url, body: payload }
    const pdf = String(payload.url || '')
    return ok(JSON.stringify({ code: 0, msg: 'ok', data: { task_id: pdf.includes('fail') ? 'task-fail' : 'task-ok' } }))
  }
  if (url.includes('mineru.net/api/v1/agent/parse/task-ok')) {
    return ok(
      JSON.stringify({
        code: 0,
        data: { task_id: 'task-ok', state: 'done', markdown_url: 'https://cdn-mineru.openxlab.org.cn/mock/full.md' },
      }),
    )
  }
  if (url.includes('mineru.net/api/v1/agent/parse/task-fail')) {
    return ok(JSON.stringify({ code: 0, data: { task_id: 'task-fail', state: 'failed', err_msg: '页数超过 20 页' } }))
  }
  if (url.includes('cdn-mineru.openxlab.org.cn')) return ok(MINERU_MD)
  // 同一条检索式第一次回 429、第二次恢复：验证网络层会退避重试，而不是直接判「没答复」
  if (url.includes('query.bibliographic=flaky') && crossrefFlaky === 0) {
    crossrefFlaky += 1
    return { status: 429, headers: {}, body: '{"message":"Too many requests"}' }
  }
  if (url.includes('export.arxiv.org')) {
    return ok(
      `<?xml version="1.0"?><feed>${ARXIV_ENTRY('2401.00001', 'Mixture of Experts Routing', '10.1000/test')}</feed>`,
    )
  }
  if (url.includes('www.ebi.ac.uk')) {
    return ok(
      JSON.stringify({
        resultList: {
          result: [
            {
              id: 'PMC1',
              source: 'MED',
              title: 'Wet-lab <i>routing</i> study',
              authorString: 'Ann Lee, Bo Chen',
              pubYear: '2021',
              journalInfo: { journal: { title: 'Lab Journal' } },
              doi: '10.1000/lab',
              abstractText: '<h4>Background</h4><p>Cells route &amp; balance.</p>',
              citedByCount: 4,
            },
          ],
        },
      }),
    )
  }
  if (url.includes('api.openalex.org')) {
    openAlexCalls.push(url)
    if (url.includes('/works/doi:')) return ok(JSON.stringify(OPENALEX_W1))
    if (url.includes('filter=openalex_id:')) {
      const raw = url.split('filter=openalex_id:')[1]!.split('&')[0]!
      const ids = decodeURIComponent(raw).split('|')
      return ok(
        JSON.stringify({
          results: OPENALEX_WORKS.filter((w) => ids.includes(w.id.replace('https://openalex.org/', ''))),
        }),
      )
    }
    if (url.includes('filter=cites:')) return ok(JSON.stringify({ results: [OPENALEX_W3] }))
    // 按题名找种子时 select 里带 referenced_works；普通检索不带
    if (url.includes('referenced_works')) return ok(JSON.stringify({ results: [OPENALEX_W1] }))
    return ok(JSON.stringify({ results: [OPENALEX_W1, OPENALEX_W2] }))
  }
  const work = {
    title: ['Routing at Scale'],
    author: [{ family: 'Doe', given: 'Jane' }],
    issued: { 'date-parts': [[2023]] },
    'container-title': ['Journal of Tests'],
    DOI: '10.1000/test',
    URL: 'https://doi.org/10.1000/test',
    abstract: '<jats:p>Big &amp; small.</jats:p>',
  }
  if (url.includes('/works/10.')) return ok(JSON.stringify({ message: work }))
  return ok(
    JSON.stringify({
      message: {
        items: [
          work,
          {
            ...work,
            title: ['Sparse Routing'],
            DOI: '10.1000/other',
            URL: '',
            issued: { 'date-parts': [[2022]] },
          },
        ],
      },
    }),
  )
}


/** 最近一次假模型调用点名的模型 id：验证「面板选的模型真的传下去了」 */
let lastAiModelId = ''
let lastAiPrompt = ''

/** 假模型：把 system 提示词当路由键，回一份确定性的 JSON；不联网、不花钱 */
function fakeAi(): {
  complete(req: { system?: string; prompt: string; modelId?: string }): Promise<{
    text: string
    modelId: string
    model: string
    usage: { promptTokens: number; completionTokens: number; costUsd: number }
  }>
  models(): {
    models: Array<{ id: string; name: string; model: string; enabled: boolean; hasKey: boolean }>
    preferred: string | null
  }
} {
  return {
    async models() {
      return {
        models: [
          { id: 'm1', name: '测试模型', model: 'test-1', enabled: true, hasKey: true },
          { id: 'm2', name: '备用模型', model: 'test-2', enabled: true, hasKey: true },
          { id: 'm3', name: '停用的模型', model: 'test-3', enabled: false, hasKey: true },
          { id: 'm4', name: '没 Key 的模型', model: 'test-4', enabled: true, hasKey: false },
        ],
        preferred: 'm1',
      }
    },
    async complete(req) {
      lastAiModelId = String(req.modelId ?? '')
      const prompt = String(req.prompt ?? '')
      lastAiPrompt = prompt
      const system = String(req.system ?? '')
      const ids = [...prompt.matchAll(/id=(\S+)/g)].map((m) => m[1]!)
      const nodeIds = [...new Set(prompt.match(/\bn_[0-9a-z]{10}\b/g) ?? [])]
      let payload: unknown = {}
      if (system.includes('检索规划助手')) {
        payload = {
          queries: ['mixture of experts routing', 'sparse gate'],
          include: ['实证研究'],
          exclude: ['纯综述'],
          note: '覆盖路由与稀疏门控',
        }
      } else if (system.includes('研究规划助手')) {
        payload = {
          nodes: [
            { key: 'a1', title: '把问题拆成研究节点', kind: 'question', parents: [] },
            {
              key: 'a2',
              title: '验证容量因子对弃 token 的影响',
              kind: 'experiment',
              note: '固定 top-k',
              parents: ['a1', ...(nodeIds[0] ? [nodeIds[0]] : []), 'ghost'],
            },
            { key: 'a3', title: '汇总成结论', kind: 'conclusion', parents: ['a2'] },
          ],
          hypotheses: [{ statement: '容量因子是可调的关键旋钮', evidence: ['a2', 'n_ghost'] }],
          summary: '先拆问题，再做对照实验，最后收束。',
        }
      } else if (system.includes('研究推进助手')) {
        payload = {
          proposals: [
            { type: 'update_node', why: '种子节点该推进了', nodeId: nodeIds[0], status: 'doing' },
            {
              type: 'add_node',
              why: '缺对照',
              title: '补一个对照实验',
              kind: 'experiment',
              parents: ['n_ghost'],
            },
            { type: 'update_hypothesis', why: '编的', hypothesisId: 'h_ghost', status: 'supported' },
            { type: 'ledger', why: '记录进度', text: '跑完对照实验', result: '' },
          ],
          summary: '把主线推到实验阶段。',
        }
      } else if (system.includes('研究评审')) {
        payload = {
          issues: [
            {
              severity: 'low',
              target: 'ghost',
              topic: '假设无证据',
              detail: '这条假设没有外部来源',
              suggestion: '先补两篇',
            },
            {
              severity: 'high',
              target: nodeIds[0],
              topic: '结论早于实验',
              detail: '结论节点没有实验支撑',
              suggestion: '补对照实验',
            },
            { severity: 'medium', topic: '缺少结论', detail: '整体还停在问题层', suggestion: '推进到实验' },
          ],
          summary: '主线有推进空间。',
        }
      } else if (system.includes('学术检索助手')) {
        payload = { queries: ['mixture of experts capacity factor', 'expert dropout routing'], note: '找支持与反驳' }
      } else if (system.includes('文献筛选助手')) {
        payload = {
          picks: [
            { id: ids[0], relevance: 'high', why: '直接研究路由' },
            { id: ids[1], relevance: 'medium', why: '提供基线' },
            { id: 'doi:ghost', relevance: 'high', why: '编的' },
          ],
          note: '筛掉纯背景',
        }
      } else if (system.includes('论文精读助手')) {
        payload = {
          notes: [
            ...ids.map((id, index) => ({
              id,
              conclusion: '结论 ' + (index + 1),
              evidence: '证据 ' + (index + 1),
              experiments: '摘要未提',
              limitations: '摘要未提',
              relation: '提供方法',
            })),
            { id: 'doi:ghost', conclusion: '编的', evidence: '', experiments: '', limitations: '', relation: '' },
          ],
        }
      } else if (system.includes('研究综述助手')) {
        payload = {
          dimensions: ['方法', '结论'],
          rows: [
            ...ids.map((id, index) => ({ id, cells: ['方法 ' + (index + 1)] })),
            { id: 'doi:ghost', cells: ['x', 'y'] },
          ],
          summary: '这些工作把路由容量推进到可调阶段。',
          gaps: ['缺少端到端基准', '容量因子与吞吐的联合约束'],
        }
      } else if (system.includes('研究选题助手')) {
        payload = {
          ideas: [
            {
              title: '把容量因子做成可学习参数',
              innovation: '现有工作固定容量',
              evidence: '暂无直接证据，属推断',
              test: '同算力下扫容量因子',
              paperIds: [ids[0], 'doi:ghost'],
            },
          ],
        }
      } else if (system.includes('证据筛选助手')) {
        payload = {
          picks: [
            { id: ids[0], stance: 'supports', why: '摘要结论一致' },
            { id: ids[1], stance: 'neutral', why: '相关但无法判定' },
            { id: 'doi:ghost', stance: 'supports', why: '编的' },
          ],
          note: '两篇够用',
        }
      }
      return {
        text: JSON.stringify(payload),
        modelId: 'test',
        model: '测试模型',
        usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
      }
    },
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

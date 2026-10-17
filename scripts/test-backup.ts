/**
 * 数据备份与同步（GitHub 仓库）的离线验证。
 *
 * 分两层：shared/backup 的纯函数（归一化、合并、密钥闸门）直接断言；
 * 落盘那层（collect / apply / push / pull）在临时目录里跑真文件，GitHub 用
 * 一个假的 fetch 顶掉 —— 这一套的价值就在于**不进网络也能把失败路径走一遍**：
 * 密钥泄漏要中止、令牌过期要说人话、owner 不是自己时不许建仓。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  BACKUP_SCHEMA_VERSION,
  bundleStat,
  findSecretLeaks,
  isBackupPath,
  isReadableBundle,
  mergeBundles,
  normalizeRel,
  parseBackupTarget,
  scrubBundle,
  type BackupBundle,
} from '../src/shared/backup'
import { applyBundle, collectBundle, pullBackup, pushBackup, testTarget } from '../src/main/backup/sync'
import { BackupService } from '../src/main/backup/service'

let pass = 0
const failed: string[] = []
async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    failed.push(`${name}: ${(e as Error).message}`)
    console.log(`  [FAIL] ${name}\n         ${(e as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// 假 GitHub：够用就好，只认这套里真正会打到的那几个端点
// ---------------------------------------------------------------------------

interface Call {
  method: string
  path: string
  body: Record<string, unknown> | null
}

interface GhStub {
  fetch: (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<unknown>
  calls: Call[]
  bundle: () => string | null
}

function makeGh(
  opts: { token?: string; login?: string; repoExists?: boolean; pushPermission?: boolean; bundle?: string | null } = {},
): GhStub {
  const token = opts.token ?? 'good-token'
  const login = opts.login ?? 'alice'
  const calls: Call[] = []
  let repoExists = opts.repoExists ?? true
  let bundle = opts.bundle ?? null
  let sha = 7

  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  })

  const fetchFn = async (
    input: unknown,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    const p = url.replace('https://api.github.com', '')
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null
    calls.push({ method, path: p, body })

    if ((init.headers?.Authorization ?? '') !== `Bearer ${token}`) {
      return reply(401, { message: 'Bad credentials' })
    }
    if (p === '/user') return reply(200, { login })
    if (method === 'POST' && p === '/user/repos') {
      repoExists = true
      return reply(201, { full_name: `${login}/${String(body?.name)}`, private: true, default_branch: 'main' })
    }
    const repo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(p)
    if (repo && method === 'GET') {
      if (!repoExists) return reply(404, { message: 'Not Found' })
      return reply(200, {
        full_name: `${repo[1]}/${repo[2]}`,
        private: true,
        default_branch: 'main',
        permissions: { push: opts.pushPermission ?? true },
      })
    }
    const content = /^\/repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)(?:\?ref=(.+))?$/.exec(p)
    if (content && method === 'GET') {
      if (!repoExists || bundle === null) return reply(404, { message: 'Not Found' })
      return reply(200, { content: Buffer.from(bundle, 'utf8').toString('base64'), encoding: 'base64', sha: String(sha) })
    }
    if (content && method === 'PUT') {
      bundle = Buffer.from(String(body?.content), 'base64').toString('utf8')
      sha += 1
      return reply(200, { commit: { sha: 'c0ffee' } })
    }
    return reply(404, { message: 'Not Found' })
  }

  return { fetch: fetchFn as GhStub['fetch'], calls, bundle: () => bundle }
}

function bundleOf(files: Record<string, string>, times: Record<string, number> = {}, device = 'dev-a'): BackupBundle {
  return { app: 'torra', schemaVersion: BACKUP_SCHEMA_VERSION, generatedAt: 1000, device, files, fileTimes: times }
}

async function tmpDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'torra-backup-'))
}

async function seed(dir: string, rel: string, text: string): Promise<void> {
  const abs = path.join(dir, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, text)
}

interface ServiceEnv {
  prefs: Record<string, unknown>
  keys: Map<string, string>
  sent: string[]
  reloads: () => number
}

/** 服务层的依赖都是注入进来的，测试里给一份内存实现即可，不用碰真偏好文件 */
function makeService(dataDir: string, env: ServiceEnv): BackupService {
  let reloads = 0
  const svc = new BackupService({
    dataDir,
    device: 'dev-a',
    secrets: {
      get: (ref: string) => env.keys.get(ref) ?? null,
      set: async (ref: string, v: string) => void env.keys.set(ref, v),
      delete: async (ref: string) => void env.keys.delete(ref),
    } as never,
    readPreferences: async () => env.prefs,
    patchPreferences: async (patch) => Object.assign(env.prefs, patch),
    send: (ch) => env.sent.push(ch),
    reloadData: async () => void (reloads += 1),
  })
  env.reloads = () => reloads
  return svc
}

function emptyEnv(): ServiceEnv {
  return { prefs: {}, keys: new Map(), sent: [], reloads: () => 0 }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n== 仓库地址：能写什么、不能写什么 ==')

  await it('owner/repo 与各种 GitHub 地址形态都认得出来', () => {
    const a = parseBackupTarget('Alleyf/torra-backup')
    assert.ok(a.ok)
    assert.deepEqual([a.target.owner, a.target.repo, a.target.branch], ['Alleyf', 'torra-backup', 'main'])

    const b = parseBackupTarget('https://github.com/Alleyf/torra-backup.git')
    assert.ok(b.ok)
    assert.equal(b.target.repo, 'torra-backup')

    // 带 /tree/<branch> 的链接：分支要从地址里看出来，不能还按默认分支推
    const c = parseBackupTarget('https://github.com/Alleyf/torra-backup/tree/nightly/')
    assert.ok(c.ok)
    assert.equal(c.target.branch, 'nightly')

    // 地址里没带分支时，用界面上填的那个
    const d = parseBackupTarget('https://github.com/Alleyf/torra-backup', 'backup')
    assert.ok(d.ok && d.target.branch === 'backup')
  })

  await it('不是 github.com、或者压根不是仓库地址的，一律说清原因', () => {
    const gitlab = parseBackupTarget('https://gitlab.com/a/b')
    assert.ok(!gitlab.ok && gitlab.reason.includes('github.com'))

    const scp = parseBackupTarget('git@github.com:Alleyf/torra-backup.git')
    assert.ok(!scp.ok, 'SCP 形态没有 http 前缀，不能被当成 github 地址放过')

    assert.ok(!parseBackupTarget('   ').ok)
    assert.ok(!parseBackupTarget('a/b/c').ok, '多余的一段路径不猜，让用户自己改成 owner/repo')
    assert.ok(!parseBackupTarget('a b/c').ok)
  })

  console.log('\n== 收纳清单：什么进备份包、什么永远不进 ==')

  await it('会话存档 / 报告 / 适配器 / 偏好 / 模型清单进，密钥与图片不进', () => {
    for (const ok of [
      'sessions/abc.json',
      'sessions/reports/abc.json',
      'sessions/abc.digest.md',
      'adapters/x.json',
      'preferences.json',
      'models.json',
    ]) {
      assert.ok(isBackupPath(ok), `${ok} 应该进备份包`)
    }
    for (const no of [
      'keys/openai-key.json',
      'chat-assets/a.png',
      'exports/report.md',
      'flags/x.json',
      'logs/app.log',
      'sessions/abc.events.jsonl',
      'sessions/abc.diag.jsonl',
    ]) {
      assert.ok(!isBackupPath(no), `${no} 不该进备份包`)
    }
  })

  await it('越界路径一律拒绝（备份包来自远端，是外部输入）', () => {
    for (const bad of ['../evil.json', 'sessions/../../evil.json', '/abs.json', 'C:/evil.json', '.', '']) {
      assert.ok(!isBackupPath(bad), `${bad} 不该被当成合法路径`)
    }
    // 反斜杠目录分隔符按同一套口径归一，避免 Windows 上「看起来合法」地穿透出去
    assert.equal(normalizeRel('sessions\\a.json'), 'sessions/a.json')
  })

  await it('结构版本比本机新的包直接拒读，不要拿旧代码去解析新字段', () => {
    const good = bundleOf({ 'sessions/a.json': '{}' })
    assert.ok(isReadableBundle(good))
    assert.ok(!isReadableBundle({ ...good, schemaVersion: BACKUP_SCHEMA_VERSION + 1 }))
    assert.ok(!isReadableBundle({ ...good, app: 'other' }))
    assert.ok(!isReadableBundle({ ...good, files: { '../x.json': '{}' } }))
    assert.ok(!isReadableBundle({ ...good, files: [] as unknown as Record<string, string> }))
    assert.ok(!isReadableBundle(null))
  })

  console.log('\n== 合并口径：逐份取较新的，不传播删除 ==')

  await it('四类结果各归各的格，时间戳相同时本机那份说了算', () => {
    const local = bundleOf(
      { 'sessions/a.json': 'local-a', 'sessions/b.json': 'local-b', 'sessions/c.json': 'same' },
      { 'sessions/a.json': 200, 'sessions/b.json': 500, 'sessions/c.json': 100 },
    )
    const remote = bundleOf(
      { 'sessions/b.json': 'remote-b', 'sessions/c.json': 'same', 'sessions/d.json': 'remote-d' },
      { 'sessions/b.json': 300, 'sessions/c.json': 100, 'sessions/d.json': 50 },
    )
    const { bundle, stat } = mergeBundles(local, remote)
    assert.deepEqual(stat.pushed, ['sessions/a.json', 'sessions/b.json'])
    assert.deepEqual(stat.same, ['sessions/c.json'])
    assert.deepEqual(stat.added, ['sessions/d.json'])
    assert.deepEqual(stat.pulled, [])
    assert.equal(bundle.files['sessions/b.json'], 'local-b', '本机更新（500 > 300）就该留本机那份')
    assert.equal(bundle.files['sessions/d.json'], 'remote-d', '远端独有的那份要收进来，不能当成「本地没有」丢掉')
    assert.equal(bundle.fileTimes['sessions/b.json'], 500)
  })

  await it('远端确实更新时才取远端那份', () => {
    const { bundle, stat } = mergeBundles(
      bundleOf({ 'sessions/a.json': 'old' }, { 'sessions/a.json': 100 }),
      bundleOf({ 'sessions/a.json': 'new' }, { 'sessions/a.json': 900 }),
    )
    assert.deepEqual(stat.pulled, ['sessions/a.json'])
    assert.equal(bundle.files['sessions/a.json'], 'new')
  })

  await it('远端没有这个文件时不是删除，是「本机新写的」，照推', () => {
    const { stat } = mergeBundles(bundleOf({ 'sessions/a.json': 'x' }, { 'sessions/a.json': 100 }), null)
    assert.deepEqual(stat.pushed, ['sessions/a.json'])
    assert.deepEqual(stat.added, [])
  })

  await it('本机删掉的场次不会把远端那份一起抹掉（删除不传播）', () => {
    const { bundle } = mergeBundles(
      bundleOf({ 'sessions/keep.json': 'k' }, { 'sessions/keep.json': 10 }),
      bundleOf(
        { 'sessions/keep.json': 'k', 'sessions/history.json': 'h' },
        { 'sessions/keep.json': 10, 'sessions/history.json': 10 },
      ),
    )
    assert.ok(bundle.files['sessions/history.json'], '只有远端还有的存档要留着，一次误删不该反噬历史')
  })

  await it('统计口径：场次 / 报告 / 适配器 / 字节数', () => {
    const stat = bundleStat(
      bundleOf({
        'sessions/a.json': '{}',
        'sessions/reports/a.json': '{}',
        'adapters/w.json': '{}',
        'preferences.json': '{}',
      }),
    )
    assert.equal(stat.sessions, 1)
    assert.equal(stat.reports, 1)
    assert.equal(stat.adapters, 1)
    assert.ok(stat.bytes >= 8)
  })

  console.log('\n== 密钥闸门 ==')

  await it('体外的密钥认得出来，密钥「引用名」不算泄漏', () => {
    assert.equal(findSecretLeaks({ 'x.json': JSON.stringify({ apiKeyRef: 'openai:key' }) }).length, 0)
    assert.equal(findSecretLeaks({ 'x.json': 'hello world' }).length, 0)
    assert.ok(findSecretLeaks({ 'x.json': 'k = sk-abcdefghijklmnopqrstuvwx' }).length > 0)
    assert.ok(findSecretLeaks({ 'x.json': `token: ghp_${'a'.repeat(30)}` }).length > 0)
    assert.ok(findSecretLeaks({ 'x.json': JSON.stringify({ apiKey: 'x'.repeat(30) }) }).length > 0)
    // 命中要说清是哪份文件，不然用户不知道该去看啥
    assert.equal(findSecretLeaks({ 'adapters/w.json': `ghp_${'b'.repeat(30)}` })[0]?.path, 'adapters/w.json')
  })

  await it('Cookie 串与 Authorization 头也算泄漏（网页模型登录态不能进备份）', () => {
    // 网页模型的会话 cookie 常以整串散落在适配器配置 / 会话存档里，属于登录凭据
    assert.ok(findSecretLeaks({ 'adapters/w.yaml': 'cookie: "sessionid=abcdef0123456789abcdef; token=ghp_0123456789abcdef0123456789"' }).length > 0)
    assert.ok(findSecretLeaks({ 'sessions/a.json': 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' }).length > 0)
    // 引用名不是泄漏：models.json 里只有 apiKeyRef / headersRef 这类指针
    assert.equal(findSecretLeaks({ 'models.json': JSON.stringify({ apiKeyRef: 'openai:key', headersRef: 'openai:headers' }) }).length, 0)
  })

  await it('scrubBundle 把 cookie / cookies 字段整键剔掉', () => {
    const out = scrubBundle(
      bundleOf({
        'adapters/w.json': JSON.stringify({
          entry: 'https://example.com',
          cookie: 'sessionid=abcdef0123456789abcdef',
          cookies: { sid: 'keep-out' },
          headers: { 'x-csrf': 'keep-me' },
        }),
        'sessions/a.json': '{"id":"a"}',
      }),
    )
    const kept = JSON.parse(out.bundle.files['adapters/w.json'] ?? '{}') as Record<string, unknown>
    assert.equal(kept.cookie, undefined, 'cookie 字段该没')
    assert.equal(kept.cookies, undefined, 'cookies 字段该没')
    assert.equal((kept.headers as Record<string, unknown>)?.['x-csrf'], 'keep-me', '普通请求头不动')
  })

  await it('推送前先剔掉疑似密钥字段，并报告剔了哪些', () => {
    const out = scrubBundle(
      bundleOf({
        'adapters/w.json': JSON.stringify({
          name: 'wallstreet',
          http_headers: { Authorization: 'Bearer x' },
          auth: { token: 'abc', tokenizer: 'keep-me' },
        }),
        'sessions/a.json': '{"id":"a"}',
      }),
    )
    const kept = JSON.parse(out.bundle.files['adapters/w.json'] ?? '{}') as Record<string, unknown>
    assert.equal(kept.http_headers, undefined, 'http_headers 整个字段该没')
    assert.deepEqual(kept.auth, { tokenizer: 'keep-me' }, '只剔 token 本身，别把 tokenizer 误伤')
    assert.ok(out.removed.some((p) => p.endsWith('http_headers')))
    assert.equal(out.bundle.files['sessions/a.json'], '{"id":"a"}', '没命中字段的文件原样留着，别顺手重排 JSON')
  })

  console.log('\n== 收集与落盘（真文件、临时目录）==')

  await it('收集只拿清单上的文件，落盘时越界路径被跳过', async () => {
    const dir = await tmpDataDir()
    try {
      await seed(dir, 'sessions/1.json', '{"id":"1"}')
      await seed(dir, 'sessions/1.events.jsonl', '{"delta":1}')
      await seed(dir, 'sessions/reports/1.json', '{"ok":true}')
      await seed(dir, 'adapters/w.json', '{"name":"w"}')
      await seed(dir, 'preferences.json', '{"theme":"dark"}')
      await seed(dir, 'models.json', '{"models":[]}')
      await seed(dir, 'keys/openai.json', '{"secret":1}')
      await seed(dir, 'chat-assets/a.png', 'PNG')

      const collected = await collectBundle(dir, 'dev-a')
      assert.deepEqual(Object.keys(collected.files).sort(), [
        'adapters/w.json',
        'models.json',
        'preferences.json',
        'sessions/1.json',
        'sessions/reports/1.json',
      ])
      assert.ok(collected.fileTimes['sessions/1.json'] !== undefined, '合并要靠修改时间，收集时必须一并带上')

      const applied = await applyBundle(dir, bundleOf({ '../escaped.json': 'nope', 'sessions/2.json': '{"id":"2"}' }))
      assert.equal(applied.written, 1)
      assert.deepEqual(applied.skipped, ['../escaped.json'])
      assert.equal(await fs.readFile(path.join(dir, 'sessions/2.json'), 'utf8'), '{"id":"2"}')
      await assert.rejects(fs.stat(path.join(dir, '..', 'escaped.json')), '越界那份绝不能在 dataDir 外面落地')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  console.log('\n== 推送：拿假 GitHub 把失败路径走一遍 ==')

  await it('第一次推送：没有 sha 也照样写，提交信息说得清是哪台机器推的', async () => {
    const dir = await tmpDataDir()
    const gh = makeGh()
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      await seed(dir, 'sessions/1.json', '{"id":"1"}')
      await seed(dir, 'models.json', '{"models":[]}')
      const out = await pushBackup('good-token', { owner: 'alice', repo: 'torra-backup', branch: 'main' }, dir, 'dev-a')
      assert.ok(out.ok, out.reason)
      assert.equal(out.sessions, 1)
      assert.equal(out.pushed, 2)
      const put = gh.calls.find((c) => c.method === 'PUT')
      assert.ok(put, '该有一次 PUT')
      assert.equal(put.body?.sha, undefined, '远端还没有这个文件时不能带 sha，带了 GitHub 会报 422')
      assert.match(String(put.body?.message), /Torra 备份/)
      assert.match(String(put.body?.message), /dev-a/)
      assert.ok(gh.bundle()?.includes('sessions/1.json'))
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await it('远端那份更新时不会覆盖它，两边各有新场次时两场都在', async () => {
    const dir = await tmpDataDir()
    // 真文件的 mtime 就是「现在」，所以远端那些「更新时间」得围着 now 来定，
    // 不然本机随便一个新写的文件都比它新，测出来的合并方向是假的
    const base = Date.now()
    const remote = bundleOf(
      { 'sessions/old.json': 'remote-old', 'sessions/1.json': 'remote-1' },
      { 'sessions/old.json': base - 120_000, 'sessions/1.json': base - 30_000 },
    )
    const gh = makeGh({ bundle: JSON.stringify(remote) })
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      await seed(dir, 'sessions/1.json', 'local-1')
      await seed(dir, 'sessions/new.json', 'local-new')
      await fs.utimes(path.join(dir, 'sessions/1.json'), new Date(base - 60_000), new Date(base - 60_000))
      await fs.utimes(path.join(dir, 'sessions/new.json'), new Date(base - 5_000), new Date(base - 5_000))
      const out = await pushBackup('good-token', { owner: 'alice', repo: 'r', branch: 'main' }, dir, 'dev-a')
      assert.ok(out.ok, out.reason)
      assert.equal(out.pulled, 1, 'sessions/1.json 远端更新，应当按远端那份为准')
      assert.equal(out.added, 1, '远端独有的 old.json 不该在这次推送里消失')
      assert.equal(out.pushed, 1, '本机刚写的 new.json 要推上去')
      const pushed = JSON.parse(gh.bundle() ?? '{}') as BackupBundle
      assert.equal(pushed.files['sessions/1.json'], 'remote-1')
      assert.ok(pushed.files['sessions/old.json'])
      assert.ok(pushed.files['sessions/new.json'])
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await it('本机文件里混进密钥就中止推送，一个字节都不发', async () => {
    const dir = await tmpDataDir()
    const gh = makeGh()
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      await seed(dir, 'sessions/1.json', JSON.stringify({ id: '1', note: `sk-${'c'.repeat(30)}` }))
      const out = await pushBackup('good-token', { owner: 'alice', repo: 'r', branch: 'main' }, dir, 'dev-a')
      assert.ok(!out.ok)
      assert.match(String(out.reason), /密钥/)
      assert.equal(gh.calls.filter((c) => c.method === 'PUT').length, 0, '泄漏时不能有任何写动作')
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  console.log('\n== 恢复 ==')

  await it('远端那份落盘，本机较新的场次原地保留，且一个字都不回写', async () => {
    const dir = await tmpDataDir()
    const base = Date.now()
    const remote = bundleOf(
      { 'sessions/1.json': 'remote-1', 'sessions/2.json': 'remote-2' },
      { 'sessions/1.json': base - 1_000, 'sessions/2.json': base - 100 },
    )
    const gh = makeGh({ bundle: JSON.stringify(remote) })
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      await seed(dir, 'sessions/1.json', 'local-1')
      await seed(dir, 'sessions/3.json', 'local-3')
      await fs.utimes(path.join(dir, 'sessions/1.json'), new Date(base - 60_000), new Date(base - 60_000))
      await fs.utimes(path.join(dir, 'sessions/3.json'), new Date(base), new Date(base))
      const out = await pullBackup('good-token', { owner: 'alice', repo: 'r', branch: 'main' }, dir, 'dev-b')
      assert.ok(out.ok, out.reason)
      assert.equal(out.remoteDevice, 'dev-a')
      assert.equal(await fs.readFile(path.join(dir, 'sessions/1.json'), 'utf8'), 'remote-1')
      assert.equal(await fs.readFile(path.join(dir, 'sessions/2.json'), 'utf8'), 'remote-2')
      assert.equal(await fs.readFile(path.join(dir, 'sessions/3.json'), 'utf8'), 'local-3')
      assert.equal(gh.calls.filter((c) => c.method === 'PUT').length, 0, '恢复只读不写，不然会顶掉别台机器刚推的那份')
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await it('远端包结构版本更新时宁可报错也不猜', async () => {
    const dir = await tmpDataDir()
    const gh = makeGh({ bundle: JSON.stringify({ ...bundleOf({ 'sessions/1.json': '{}' }), schemaVersion: 99 }) })
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      const out = await pullBackup('good-token', { owner: 'alice', repo: 'r', branch: 'main' }, dir, 'dev-b')
      assert.ok(!out.ok)
      assert.match(String(out.reason), /版本/)
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  console.log('\n== 连接自检 ==')

  await it('令牌无效时给的是人话，不是 GitHub 的英文原文', async () => {
    const gh = makeGh({ token: 'right' })
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      const out = await testTarget('wrong', { owner: 'alice', repo: 'r', branch: 'main' }, false)
      assert.ok(!out.ok)
      assert.match(String(out.reason), /令牌/)
    } finally {
      globalThis.fetch = real
    }
  })

  await it('建仓只在 owner 就是自己时才会发生，且一定是私有仓库', async () => {
    const gh = makeGh({ repoExists: false, login: 'alice' })
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      const other = await testTarget('good-token', { owner: 'someone-else', repo: 'r', branch: 'main' }, true)
      assert.ok(!other.ok)
      assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 0, '别人名下的仓库不许代建')

      const mine = await testTarget('good-token', { owner: 'alice', repo: 'r', branch: 'main' }, true)
      assert.ok(mine.ok, mine.reason)
      assert.equal(mine.created, true)
      const post = gh.calls.find((c) => c.method === 'POST')
      assert.equal(post?.body?.private, true, '数据备份默认必须是私有仓库')
      assert.equal(mine.hasBundle, false, '刚建的仓库里没有备份包')
    } finally {
      globalThis.fetch = real
    }
  })

  await it('仓库在但没写权限时提前拦住', async () => {
    const gh = makeGh({ pushPermission: false })
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      const out = await testTarget('good-token', { owner: 'alice', repo: 'r', branch: 'main' }, false)
      assert.ok(!out.ok)
      assert.match(String(out.reason), /权限/)
    } finally {
      globalThis.fetch = real
    }
  })

  console.log('\n== 服务层：配置与状态怎么进 preferences ==')

  await it('仓库地址归一成 owner/repo，令牌只进钥匙串', async () => {
    const env = emptyEnv()
    const svc = makeService('C:/tmp', env)
    await svc.init()
    assert.equal(svc.snapshot().configured, false)

    const bad = await svc.saveConfig({ repo: 'https://gitlab.com/a/b' })
    assert.ok(!bad.ok, '非 github 地址要当场拒绝，不能等推送时才报错')

    const ok = await svc.saveConfig({ repo: 'https://github.com/alice/torra-backup', branch: 'main', token: 'tok' })
    assert.ok(ok.ok, ok.reason)
    assert.equal(svc.snapshot().target, 'alice/torra-backup')
    assert.equal(svc.snapshot().hasToken, true)
    assert.equal(env.keys.size, 1, '令牌只进钥匙串')
    assert.ok(!JSON.stringify(env.prefs).includes('tok'), '偏好文件里绝不能出现令牌本体')
    assert.equal(svc.repoUrl(), 'https://github.com/alice/torra-backup')
    assert.ok(env.sent.includes('backup:state'), '每次变更都要推状态，渲染层不然是死的')
  })

  await it('令牌留空表示不改动，清空是显式的另一步', async () => {
    const env = emptyEnv()
    const svc = makeService('C:/tmp', env)
    await svc.init()
    await svc.saveConfig({ repo: 'alice/r', token: 'first' })
    await svc.saveConfig({ branch: 'backup' })
    assert.equal(svc.snapshot().hasToken, true, 'token 不传就当作「不改动」')
    assert.equal(svc.snapshot().branch, 'backup')

    await svc.saveConfig({ token: '' })
    assert.equal(svc.snapshot().hasToken, false)
    assert.equal(env.keys.size, 0)
    assert.equal(svc.snapshot().configured, true, '清令牌不该把仓库配置一起清掉')
  })

  await it('没令牌时推送当场给理由，不去打网络，失败也留在状态里', async () => {
    const env = emptyEnv()
    env.prefs.backup = { repo: 'alice/r', branch: 'main' }
    const svc = makeService('C:/tmp', env)
    await svc.init()
    assert.equal(svc.snapshot().configured, true, '仓库配好了就显示配好了，令牌是另一边的事')

    const real = globalThis.fetch
    let called = 0
    globalThis.fetch = (async () => {
      called += 1
      throw new Error('不该打网络')
    }) as typeof fetch
    try {
      const out = await svc.push()
      assert.ok(!out.ok)
      assert.match(String(out.reason), /令牌/)
      assert.equal(called, 0)
      // 这一路是「还没发起就被拦下」，不算一次同步失败 —— 状态位上不该留下「上次失败」
      assert.equal(svc.snapshot().lastOk, null)
    } finally {
      globalThis.fetch = real
    }
  })

  await it('推送成功后留下时间与结果，恢复才重建内存数据视图', async () => {
    const dir = await tmpDataDir()
    const gh = makeGh()
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      await seed(dir, 'sessions/1.json', '{"id":"1"}')
      const env = emptyEnv()
      const svc = makeService(dir, env)
      await svc.init()
      await svc.saveConfig({ repo: 'alice/torra-backup', token: 'good-token' })

      const out = await svc.push()
      assert.ok(out.ok, out.reason)
      const st = svc.snapshot()
      assert.equal(st.lastOk, true)
      assert.ok(st.lastPushAt && st.lastPushAt > 0)
      assert.match(String(st.lastNote), /已备份/)
      assert.equal(st.busy, null, '动作收尾必须把 busy 放掉，不然按钮永久锁死')
      const stored = (env.prefs.backup ?? {}) as Record<string, unknown>
      assert.equal(stored.repo, 'alice/torra-backup')
      assert.ok(stored.lastPushAt)
      // 恢复会覆盖磁盘上那份，因此必须重建内存视图；推送本不动本地，不能白重建
      assert.equal(env.reloads(), 0)

      const pulled = await svc.pull()
      assert.ok(pulled.ok, pulled.reason)
      assert.equal(env.reloads(), 1, '拉取落地后要重建内存里的会话列表，否则界面还是旧的')
      assert.ok(svc.snapshot().lastPullAt)
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * 界面接线的一条硬约束：令牌框留空时，「保存」必须把 token 字段整个省掉。
   *
   * 主进程把空串读成「清掉令牌」（见上面那条）。界面要是照直把输入框的值传下去，
   * 用户每次只改仓库名再点一次保存，都会顺手删掉自己刚存的令牌 —— 症状是
   * 「令牌明明填过」，之后无论怎么测都说没有令牌。主进程那侧的语义全绿也拦不住这个，
   * 渲染层又没有 DOM 测试，所以只能扫源码把这条接线钉死。
   */
  await it('界面里的「保存」不许把空令牌传下去（那等于点一次保存删一次令牌）', async () => {
    const src = (await fs.readFile(path.resolve(__dirname, '..', 'src/renderer/components/BackupSection.tsx'), 'utf8')).replace(/\r\n/g, '\n')
    assert.match(
      src,
      /backupSave\(\{[^}]*token: token\.trim\(\) \|\| undefined/,
      '「保存」要把空令牌收成 undefined：空串在主进程眼里是「清掉令牌」',
    )
    assert.match(src, /backupSave\(\{ token: '' \}\)/, '清除令牌是另一步，只有它才显式传空串')
  })

  console.log(`\n通过 ${pass} · 失败 ${failed.length}`)
  if (failed.length > 0) {
    for (const f of failed) console.error(`! ${f}`)
    process.exit(1)
  }
}

void main()

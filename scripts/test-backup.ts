/**
 * 数据备份与同步（GitHub 仓库）的离线验证。
 *
 * 分两层：shared/backup 的纯函数（归一化、合并、密钥闸门、密钥袋的信封判据）直接断言；
 * 落盘那层（collect / apply / push / pull）在临时目录里跑真文件，GitHub 用
 * 一个假的 fetch 顶掉 —— 这一套的价值就在于**不进网络也能把失败路径走一遍**：
 * 密钥泄漏要中止、令牌过期要说人话、owner 不是自己时不许建仓。
 *
 * 密钥袋的加解密跑的是真 node:crypto：这一层不能只看形状，
 * 「换个口令解不开」「改了 refs 数字就整个袋子作废」只能靠真 ciphertext 断言。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  BACKUP_SCHEMA_VERSION,
  AUTO_BACKUP_INTERVALS,
  BAG_EXCLUDED_REFS,
  BUNDLE_FILE,
  NO_BAG_OUTCOME,
  PASSPHRASE_MAX,
  PASSPHRASE_MIN,
  SCRYPT_KDF,
  SECRETS_FILE,
  autoBackupGateBlocked,
  bagPathUsable,
  bagWord,
  bundleStat,
  checkPassphrase,
  dueForAutoBackup,
  initialAutoBackupConfig,
  initialSecretsBagState,
  findSecretLeaks,
  isBackupPath,
  isReadableBundle,
  isReadableSecretsEnvelope,
  mergeBundles,
  normalizeRel,
  normalizeAutoBackupConfig,
  normalizeSecretsBagConfig,
  parseBackupTarget,
  scrubBundle,
  secretsFileFor,
  type BackupBundle,
  type BackupTarget,
  type SecretsEnvelope,
} from '../src/shared/backup'
import { applyBundle, collectBundle, pullBackup, pushBackup, testTarget } from '../src/main/backup/sync'
import { buildBag, openBag } from '../src/main/backup/secrets-bag'
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
  /** 远端那份密钥袋（没有就是 null）—— 断言「数据推上去了但袋子没动」要看这一格 */
  secrets: (file?: string) => string | null
  /** 往远端塞一份密钥袋：模拟「另一台机器已经带上过钥匙」 */
  seedSecrets: (text: string, file?: string) => void
  /** 数一下从上次 reset 起发了几次请求（断言「这一拍什么都没动」用） */
  reset: () => void
}

/**
 * 造一个假的 GitHub。
 *
 * 仓库里的文件按**路径**分格存：数据包与密钥袋是两个文件，用一个变量存两份
 * 就会出现「断言袋子没被写上，其实是被数据包盖掉了」这种看不出来的错。
 * `reset()` 只为「这一拍一个请求都没发」这条断言服务：calls 是累积的，
 * 不清零就没法区分「这拍没动」和「上一拍动过」。
 */
function makeGh(
  opts: { token?: string; login?: string; repoExists?: boolean; pushPermission?: boolean; bundle?: string | null } = {},
): GhStub {
  const token = opts.token ?? 'good-token'
  const login = opts.login ?? 'alice'
  const calls: Call[] = []
  let repoExists = opts.repoExists ?? true
  /** 仓库里的文件：路径 → 内容与 sha（sha 每次写 +1，乐观锁断言靠它） */
  const files = new Map<string, { text: string; sha: number }>()
  if (opts.bundle != null) files.set(BUNDLE_FILE, { text: opts.bundle, sha: 7 })

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
    if (content) {
      const key = decodeURIComponent(content[3])
      if (method === 'GET') {
        const hit = files.get(key)
        if (!repoExists || !hit) return reply(404, { message: 'Not Found' })
        return reply(200, { content: Buffer.from(hit.text, 'utf8').toString('base64'), encoding: 'base64', sha: String(hit.sha) })
      }
      if (method === 'PUT') {
        const prev = files.get(key)
        files.set(key, { text: Buffer.from(String(body?.content), 'base64').toString('utf8'), sha: (prev?.sha ?? 7) + 1 })
        return reply(200, { commit: { sha: 'c0ffee' } })
      }
    }
    return reply(404, { message: 'Not Found' })
  }

  return {
    fetch: fetchFn as GhStub['fetch'],
    calls,
    bundle: () => files.get(BUNDLE_FILE)?.text ?? null,
    secrets: (file = SECRETS_FILE) => files.get(file)?.text ?? null,
    seedSecrets: (text, file = SECRETS_FILE) => files.set(file, { text, sha: 11 }),
    reset: () => {
      calls.length = 0
    },
  }
}

/** 仓库里那个数据包叫什么、落在哪，两个文件都靠它推导，测试里统一从这一份拿 */
function target(over: Partial<BackupTarget> = {}): BackupTarget {
  return { owner: 'alice', repo: 'r', branch: 'main', file: BUNDLE_FILE, ...over }
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
  /** 测试里手动翻这个值来模拟「讨论正在跑」，服务每次问都读到最新的 */
  discussionActive: boolean
  /** 主进程日志收集起来：静默任务的失败只能靠这里断言 */
  logs: Array<{ detail: string; ok: boolean }>
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
      // 密钥袋要知道本机有哪几条引用；真实现（钥匙串）是列目录，这里列内存那份 Map
      listRefs: () => [...env.keys.keys()],
    } as never,
    readPreferences: async () => env.prefs,
    patchPreferences: async (patch) => Object.assign(env.prefs, patch),
    send: (ch) => env.sent.push(ch),
    reloadData: async () => void (reloads += 1),
    // 默认「没有讨论在跑」，让自动备份的测试能跑到底；要测让路的那条自己改这个开关
    discussionActive: () => env.discussionActive,
    log: (detail, ok) => env.logs.push({ detail, ok }),
  })
  env.reloads = () => reloads
  return svc
}

function emptyEnv(): ServiceEnv {
  return { prefs: {}, keys: new Map(), sent: [], reloads: () => 0, discussionActive: false, logs: [] }
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

  await it('不可再生的那几类都进包：存档 / 报告 / 适配器 / 插件数据 / 助手会话 / 偏好 / 模型清单', () => {
    for (const ok of [
      'sessions/abc.json',
      'sessions/reports/abc.json',
      'sessions/abc.digest.md',
      'adapters/x.json',
      'plugin-data/research/library.json',
      'assistant-sessions/as-1.json',
      'preferences.json',
      'models.json',
      'models.snapshot.json',
      'plugins-state.json',
    ]) {
      assert.ok(isBackupPath(ok), `${ok} 应该进备份包`)
    }
    for (const no of [
      'keys/openai-key.json',
      // pi/ 整棵树都不进：auth.json 是第三方 SDK 的明文凭据文件，skills 又是指向别人仓库的 junction
      'pi/auth.json',
      'pi/skills/anything.json',
      'chat-assets/a.png',
      'exports/report.md',
      'flags/x.json',
      'logs/app.log',
      'sessions/abc.events.jsonl',
      'sessions/abc.diag.jsonl',
      // 黑名单压白名单：即使哪天有人把 keys 顺手加进 INCLUDE_DIRS，这里也进不去
      'keys/../keys/a.bin',
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

  await it('统计口径：场次 / 报告 / 适配器 / 插件数据 / 助手会话 / 总文件数 / 字节数', () => {
    const stat = bundleStat(
      bundleOf({
        'sessions/a.json': '{}',
        'sessions/reports/a.json': '{}',
        'adapters/w.json': '{}',
        'plugin-data/research/library.json': '{}',
        'assistant-sessions/as-1.json': '{}',
        'preferences.json': '{}',
      }),
    )
    assert.equal(stat.sessions, 1)
    assert.equal(stat.reports, 1)
    assert.equal(stat.adapters, 1)
    // 「收了什么」要报得出总数：只报场次会漏掉整棵插件数据树
    assert.equal(stat.pluginData, 1)
    assert.equal(stat.assistantSessions, 1)
    assert.equal(stat.entries, 6)
    assert.ok(stat.bytes >= 12)
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
      await seed(dir, 'plugin-data/research/library.json', '{"rows":[]}')
      await seed(dir, 'assistant-sessions/as-1.json', '{"turns":[]}')
      await seed(dir, 'preferences.json', '{"theme":"dark"}')
      await seed(dir, 'models.json', '{"models":[]}')
      await seed(dir, 'models.snapshot.json', '{"snapshot":1}')
      await seed(dir, 'plugins-state.json', '{"plugins":[]}')
      await seed(dir, 'keys/openai.json', '{"secret":1}')
      await seed(dir, 'pi/auth.json', '{"api_key":"sk-leak"}')
      await seed(dir, 'logs/app.log', 'noise')
      await seed(dir, 'chat-assets/a.png', 'PNG')

      const collected = await collectBundle(dir, 'dev-a')
      assert.deepEqual(Object.keys(collected.files).sort(), [
        'adapters/w.json',
        'assistant-sessions/as-1.json',
        'models.json',
        'models.snapshot.json',
        'plugin-data/research/library.json',
        'plugins-state.json',
        'preferences.json',
        'sessions/1.json',
        'sessions/reports/1.json',
      ])
      assert.ok(collected.fileTimes['sessions/1.json'] !== undefined, '合并要靠修改时间，收集时必须一并带上')
      // 密钥本体与第三方 SDK 的明文凭据文件都不在包里：包里出现的只能是引用名
      assert.ok(!JSON.stringify(collected.files).includes('sk-leak'), 'pi/auth.json 的内容绝不能进包')
      assert.equal(collected.schemaVersion, BACKUP_SCHEMA_VERSION)

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
      const out = await pushBackup('good-token', target({ repo: 'torra-backup' }), dir, 'dev-a')
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
      const out = await pushBackup('good-token', target(), dir, 'dev-a')
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
      const out = await pushBackup('good-token', target(), dir, 'dev-a')
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
      const out = await pullBackup('good-token', target(), dir, 'dev-b')
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
      const out = await pullBackup('good-token', target(), dir, 'dev-b')
      assert.ok(!out.ok)
      assert.match(String(out.reason), /版本/)
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  console.log('\n== 密钥袋：口令、落点、信封形状 ==')

  /** 一句够长的口令：下限断言之外，所有真加解密都用它 */
  const PW = 'correct-horse-battery-staple'
  const KEY_A = 'sk-' + 'a'.repeat(26)
  const KEY_B = 'sk-' + 'b'.repeat(26)

  /** 信封的坏样子：形状不对、参数被换大、base64 字段带脏字符，一律按「本机读不了」处理 */
  function badEnvelope(over: Record<string, unknown>): unknown {
    const base = {
      app: 'torra',
      kind: 'secrets-bag',
      version: 1,
      kdf: { name: 'scrypt', N: SCRYPT_KDF.N, r: SCRYPT_KDF.r, p: SCRYPT_KDF.p, keyLen: SCRYPT_KDF.keyLen, salt: 'AAAA' },
      cipher: 'aes-256-gcm',
      iv: 'AAAA',
      tag: 'AAAA',
      data: 'AAAA',
      refs: 1,
      createdAt: 1000,
      device: 'dev-a',
    }
    return { ...base, ...over }
  }

  await it('口令太短 / 太长 / 同一个字符重复都不收', () => {
    assert.ok(!checkPassphrase('short').ok)
    assert.match(String(checkPassphrase('short').reason), /至少 \d+ 个字符/)
    assert.ok(!checkPassphrase('a'.repeat(PASSPHRASE_MIN)).ok, '同一个字符重复，凑到位数也一样不收')
    assert.ok(!checkPassphrase('x'.repeat(PASSPHRASE_MAX + 1)).ok, '太长的多半是把整段文本粘进来了')
    assert.ok(checkPassphrase(PW).ok)
  })

  await it('袋子跟着数据包走同一个目录，只换文件名', () => {
    assert.equal(secretsFileFor('torra-backup.json'), SECRETS_FILE)
    assert.equal(secretsFileFor('backups/site.json'), `backups/${SECRETS_FILE}`)
    assert.equal(bagPathUsable('backups/site.json').file, `backups/${SECRETS_FILE}`)
    // 存放路径被写成袋子自己的名字：两个文件同名会互相盖掉，必须在动手之前拒掉
    const clash = bagPathUsable(SECRETS_FILE)
    assert.ok(!clash.ok)
    assert.match(String(clash.reason), /同名/)
  })

  await it('信封只认本机那一组派生参数：远端改 cost 改不动我们给它的内存预算', () => {
    for (const bad of [
      null,
      badEnvelope({ version: 2 }),
      badEnvelope({ kind: 'other' }),
      badEnvelope({ app: 'someone-else' }),
      badEnvelope({ cipher: 'aes-128-cbc' }),
      badEnvelope({ kdf: { name: 'scrypt', N: SCRYPT_KDF.N * 4, r: SCRYPT_KDF.r, p: SCRYPT_KDF.p, keyLen: SCRYPT_KDF.keyLen, salt: 'AAAA' } }),
      // keyLen 也钉死：AES-256-GCM 只吃 32 字节，别的长度是另一把钥匙
      badEnvelope({ kdf: { name: 'scrypt', N: SCRYPT_KDF.N, r: SCRYPT_KDF.r, p: SCRYPT_KDF.p, keyLen: 16, salt: 'AAAA' } }),
      badEnvelope({ refs: 9999 }),
      badEnvelope({ data: 'has spaces and +' }),
    ]) {
      assert.ok(!isReadableSecretsEnvelope(bad), `${JSON.stringify(bad).slice(0, 80)} 不该被当成本机可读的信封`)
    }
    assert.ok(isReadableSecretsEnvelope(badEnvelope({})))
  })

  console.log('\n== 密钥袋：真加解密（node:crypto）==')

  await it('装袋→开袋原样回来；换一个字符的口令就解不开', async () => {
    const entries = [{ ref: 'openai:key', value: KEY_A }, { ref: 'deepseek:headers', value: KEY_B }]
    const made = await buildBag(PW, entries, 'dev-a')
    assert.ok(made.ok, (made as { reason?: string }).reason)
    const text = (made as { text: string }).text
    assert.ok(!text.includes(KEY_A) && !text.includes(KEY_B), 'Key 本体不能以明文出现在信封里')
    assert.ok(!text.includes('openai:key'), '连引用名都不该露：信封只有条数')
    assert.ok(isReadableSecretsEnvelope(JSON.parse(text)))

    const opened = await openBag(text, PW)
    assert.ok(opened.ok, (opened as { reason?: string }).reason)
    assert.deepEqual((opened as { entries: unknown[] }).entries, entries)

    // 口令错与袋子被改是同一条回答：分开说等于给离线试探的人一个「参数对了」的旁证
    const wrong = await openBag(text, PW.slice(0, -1) + 'x')
    assert.ok(!wrong.ok)
    assert.match(String((wrong as { reason: string }).reason), /口令不对/)
    assert.ok(!(await openBag(text, '')).ok, '空口令不该被当成一次普通的解密')
  })

  await it('改一个字节就整袋作废：密文与信封头都被认证标签绑住', async () => {
    const made = await buildBag(PW, [{ ref: 'k:1', value: KEY_A }], 'dev-a')
    assert.ok(made.ok)
    const env = JSON.parse((made as { text: string }).text) as SecretsEnvelope
    // 动**第一个**字符，不是最后一个：base64 末尾那组带填充时，改掉末位可能解出
    // 完全相同的字节 —— 断言就变成「碰巧过了 GCM」而不是「密文真的被改过」
    const flipped = (env.data[0] === 'A' ? 'B' : 'A') + env.data.slice(1)
    assert.notEqual(flipped[0], env.data[0], '至少要真的改到一个字符')
    assert.ok(!(await openBag(JSON.stringify({ ...env, data: flipped }), PW)).ok, '密文动一个字符必须解不开')
    // refs 在信封头里，不在密文里：这一条专门验 AAD 有没有真的绑上
    assert.ok(!(await openBag(JSON.stringify({ ...env, refs: env.refs + 1 }), PW)).ok, '把条数改大也必须解不开，不然恢复端会被牵着多写钥匙')
  })

  await it('空钥匙串照样成袋（那是「本机已清空」的同步语义），过大则拒收', async () => {
    const empty = await buildBag(PW, [], 'dev-a')
    assert.ok(empty.ok, (empty as { reason?: string }).reason)
    assert.equal((empty as { refs: number }).refs, 0)
    const openedEmpty = await openBag((empty as { text: string }).text, PW)
    assert.ok(openedEmpty.ok, (openedEmpty as { reason?: string }).reason)
    assert.deepEqual((openedEmpty as { entries: unknown[] }).entries, [], '空袋子解开就是空清单，不是「没解开」')

    const huge = await buildBag(PW, [{ ref: 'k:huge', value: 'x'.repeat(900 * 1024) }], 'dev-a')
    assert.ok(!huge.ok, '钥匙串里不该有这么大的值：宁可拒收也不写一个几十 MB 的袋子')
    assert.match(String((huge as { reason?: string }).reason), /上限/)
  })

  console.log('\n== 密钥袋跟着备份一起推拉（假 GitHub，两个文件）==')

  await it('开了袋就写两个文件，覆盖远端旧袋子要带上它的 sha', async () => {
    const dir = await tmpDataDir()
    const gh = makeGh()
    // 远端先有一袋旧的（另一台机器推的）：这次覆盖必须带它的 sha，
    // 否则「本机看不见别台刚换的 Key」就等于把人家回滚成一袋旧的
    const old = await buildBag(PW, [{ ref: 'old:key', value: KEY_A }], 'dev-b')
    assert.ok(old.ok)
    gh.seedSecrets((old as { text: string }).text)
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      await seed(dir, 'sessions/1.json', '{"id":"1"}')
      const out = await pushBackup('good-token', target(), dir, 'dev-a', {
        passphrase: PW,
        entries: [{ ref: 'openai:key', value: KEY_B }],
      })
      assert.ok(out.ok, out.reason)
      assert.equal(out.bag.wrote, true)
      assert.equal(out.bag.refs, 1)
      const puts = gh.calls.filter((c) => c.method === 'PUT')
      assert.equal(puts.length, 2, '一个数据包 PUT + 一个密钥袋 PUT')
      const bagPut = puts.find((c) => String(c.path).includes(SECRETS_FILE))
      assert.ok(bagPut, '袋子要写成另一个文件，不能盖在数据包上')
      assert.equal(bagPut?.body?.sha, '11', '覆盖远端已有的袋子要带它的 sha（乐观锁）')
      assert.match(String(bagPut?.body?.message), /密钥袋/)
      assert.ok((gh.secrets() ?? '').includes('"refs": 1'), '远端那袋已被这次的内容替换')
      assert.ok(!(gh.secrets() ?? '').includes(KEY_B), '远端不许出现明文 Key')
      assert.ok((gh.bundle() ?? '').includes('sessions/1.json'), '数据包照常推')
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await it('开着袋但这一轮没口令：数据照推，远端那份袋子一个字都不动', async () => {
    const dir = await tmpDataDir()
    const gh = makeGh()
    const old = await buildBag(PW, [{ ref: 'old:key', value: KEY_A }], 'dev-b')
    assert.ok(old.ok)
    gh.seedSecrets((old as { text: string }).text)
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      await seed(dir, 'sessions/1.json', '{"id":"1"}')
      const out = await pushBackup('good-token', target(), dir, 'dev-a', { passphrase: '', entries: [] })
      assert.ok(out.ok, out.reason)
      assert.equal(out.bag.wrote, false)
      assert.match(String(out.bag.note), /没输入口令/)
      assert.equal(gh.secrets(), (old as { text: string }).text, '远端那份袋子必须原样留着')
      assert.equal(gh.calls.filter((c) => c.method === 'PUT' && String(c.path).includes(SECRETS_FILE)).length, 0)
      assert.equal(gh.calls.filter((c) => c.method === 'PUT').length, 1, '数据包还是照推')
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await it('袋子落点与数据包同名时中止在动手之前：一个字节都不发', async () => {
    const dir = await tmpDataDir()
    const gh = makeGh()
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      await seed(dir, 'sessions/1.json', '{"id":"1"}')
      const out = await pushBackup('good-token', target({ file: SECRETS_FILE }), dir, 'dev-a', {
        passphrase: PW,
        entries: [{ ref: 'openai:key', value: KEY_B }],
      })
      assert.ok(!out.ok)
      assert.match(String(out.reason), /同名/)
      assert.equal(gh.calls.length, 0, '配置本身有毛病就不该先发数据包 —— 那是最难查的半完成状态')
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await it('恢复时解开袋子，值只交给上层；口令缺位或不对时只恢复数据', async () => {
    const dir = await tmpDataDir()
    const remote = bundleOf({ 'sessions/1.json': 'remote-1' }, { 'sessions/1.json': Date.now() + 60_000 })
    const made = await buildBag(PW, [{ ref: 'openai:key', value: KEY_A }], 'dev-a')
    assert.ok(made.ok)
    const gh = makeGh({ bundle: JSON.stringify(remote) })
    gh.seedSecrets((made as { text: string }).text)
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      const withPw = await pullBackup('good-token', target(), dir, 'dev-b', PW)
      assert.ok(withPw.ok, withPw.reason)
      assert.deepEqual(withPw.entries, [{ ref: 'openai:key', value: KEY_A }])
      assert.equal(withPw.bag.refs, 1)
      assert.equal(await fs.readFile(path.join(dir, 'sessions/1.json'), 'utf8'), 'remote-1')

      const noPw = await pullBackup('good-token', target(), dir, 'dev-b')
      assert.ok(noPw.ok, noPw.reason)
      assert.equal(noPw.entries, undefined, '没口令就不该把值带出去')
      assert.match(String(noPw.bag.note), /还没输入备份口令/)

      const wrongPw = await pullBackup('good-token', target(), dir, 'dev-b', 'wrong-passphrase-abc')
      assert.ok(wrongPw.ok, wrongPw.reason)
      assert.equal(wrongPw.entries, undefined)
      assert.match(String(wrongPw.bag.note), /解不开/)

      const trash = makeGh({ bundle: JSON.stringify(remote) })
      trash.seedSecrets('{"app":"other"}')
      globalThis.fetch = trash.fetch as typeof fetch
      const broken = await pullBackup('good-token', target(), dir, 'dev-b', PW)
      assert.ok(broken.ok, broken.reason)
      assert.match(String(broken.bag.note), /信封不认识/, '远端袋子坏掉不该把数据恢复一起拖死')
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await it('连接自检能看出远端有没有一袋钥匙', async () => {
    const made = await buildBag(PW, [{ ref: 'openai:key', value: KEY_A }], 'dev-a')
    assert.ok(made.ok)
    const env = JSON.parse((made as { text: string }).text) as SecretsEnvelope
    const gh = makeGh({ bundle: JSON.stringify(bundleOf({ 'sessions/1.json': '{}' })) })
    gh.seedSecrets(JSON.stringify({ ...env, createdAt: 555000 }))
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      const out = await testTarget('good-token', target(), false)
      assert.ok(out.ok, out.reason)
      assert.equal(out.hasBag, true)
      assert.equal(out.bagAt, 555000, '袋子的时间取自信封自己的 createdAt，界面上那一行才有得说')
    } finally {
      globalThis.fetch = real
    }
  })

  console.log('\n== 连接自检 ==')

  await it('令牌无效时给的是人话，不是 GitHub 的英文原文', async () => {
    const gh = makeGh({ token: 'right' })
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      const out = await testTarget('wrong', target(), false)
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
      const other = await testTarget('good-token', target({ owner: 'someone-else' }), true)
      assert.ok(!other.ok)
      assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 0, '别人名下的仓库不许代建')

      const mine = await testTarget('good-token', target(), true)
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
      const out = await testTarget('good-token', target(), false)
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

  console.log('\n== 密钥袋在服务层：口令的命、值的去向 ==')

  await it('口令不落盘也不进日志：偏好里只有开关那一个字', async () => {
    const env = emptyEnv()
    const svc = makeService('C:/tmp', env)
    await svc.init()
    assert.equal(svc.snapshot().bag.enabled, false, '没开过就是关：升级不该顺手开始往外推钥匙')
    assert.equal(svc.snapshot().bag.passphraseHeld, false)

    const r = await svc.setBagConfig({ enabled: true, passphrase: PW })
    assert.ok(r.ok, r.reason)
    assert.equal(svc.snapshot().bag.enabled, true)
    assert.equal(svc.snapshot().bag.passphraseHeld, true, '交上手了就得说「已在手里」，界面不自己猜')
    const stored = (env.prefs.backup ?? {}) as Record<string, unknown>
    assert.deepEqual(stored.bag, { enabled: true }, '落盘的只有开关这一格')
    assert.ok(!JSON.stringify(env.prefs).includes(PW), '偏好文件里绝不能出现口令')
    assert.equal(env.logs.length, 0, '设置口令不该产生日志：日志会留在磁盘上')
  })

  await it('口令三态：不传＝不动、空串＝忘掉、太短＝当场拒绝且不收下', async () => {
    const env = emptyEnv()
    const svc = makeService('C:/tmp', env)
    await svc.init()
    await svc.setBagConfig({ enabled: true })
    assert.equal(svc.snapshot().bag.passphraseHeld, false)

    const short = await svc.setBagConfig({ passphrase: 'abc' })
    assert.ok(!short.ok && /至少/.test(String(short.reason)))
    assert.equal(svc.snapshot().bag.passphraseHeld, false, '没收下的口令不该留在手里那一格')

    await svc.setBagConfig({ passphrase: PW })
    assert.equal(svc.snapshot().bag.passphraseHeld, true)
    // 只翻开关不能把手里那格擦掉：用户可能一边改设置一边准备备份
    await svc.setBagConfig({ enabled: true })
    assert.equal(svc.snapshot().bag.passphraseHeld, true, 'undefined 字段不许盖掉现值（和自动备份同一条规矩）')

    await svc.setBagConfig({ passphrase: '' })
    assert.equal(svc.snapshot().bag.passphraseHeld, false, '「忘掉口令」是显式的另一步')

    await svc.setBagConfig({ passphrase: PW })
    await svc.setBagConfig({ enabled: false })
    assert.equal(svc.snapshot().bag.passphraseHeld, false, '关掉开关就把手里那格也丢掉：留着一条没人会再用的口令只是多一处明文')
  })

  await it('本机条数只报数，备份令牌自己不进袋', async () => {
    const env = emptyEnv()
    env.keys.set('github:backup', 'tok')
    env.keys.set('openai:key', KEY_A)
    env.keys.set('deepseek:key', KEY_B)
    const svc = makeService('C:/tmp', env)
    await svc.init()
    assert.equal(svc.snapshot().bag.localRefs, 2, '三条里有一条是备份令牌自己，不该算进「可带上」')
    assert.ok(!JSON.stringify(svc.snapshot()).includes(KEY_A), '状态里绝不能出现 Key 本体')

    assert.deepEqual([...BAG_EXCLUDED_REFS], ['github:backup'])
    assert.equal(normalizeSecretsBagConfig({ enabled: 'yes' }).enabled, false, '非 true 一律算关')
    // 归一化只管落盘那格（开关）；passphraseHeld / localRefs / remoteAt 是运行时的事实，
    // 从 preferences 里读出来只会是假话 —— 重启后口令必然不在手里
    assert.deepEqual(normalizeSecretsBagConfig(undefined), { enabled: false })
    assert.deepEqual(initialSecretsBagState(), { enabled: false, passphraseHeld: false, localRefs: 0, remoteAt: null })
  })

  await it('推送带上袋子：状态更新远端袋子时间，返回值里没有 Key 本体', async () => {
    const dir = await tmpDataDir()
    const gh = makeGh()
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      await seed(dir, 'sessions/1.json', '{"id":"1"}')
      const env = emptyEnv()
      env.keys.set('openai:key', KEY_A)
      const svc = makeService(dir, env)
      await svc.init()
      await svc.saveConfig({ repo: 'alice/torra-backup', token: 'good-token' })
      await svc.setBagConfig({ enabled: true, passphrase: PW })

      const out = await svc.push()
      assert.ok(out.ok, out.reason)
      assert.equal(out.bag.wrote, true)
      assert.match(String(svc.snapshot().lastNote), /密钥袋已更新（1 条）/)
      assert.ok(svc.snapshot().bag.remoteAt && svc.snapshot().bag.remoteAt > 0, '袋子上过远端要留下时间')
      assert.ok(!JSON.stringify(out).includes(KEY_A), '这个返回值要过 IPC，出现明文 Key 就是打进渲染层消息里')
      assert.ok(!JSON.stringify(env.prefs).includes(KEY_A))
      assert.ok(!gh.secrets()!.includes(KEY_A), '远端那袋是密文')
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await it('恢复把钥匙写回钥匙串，解密出来的值就地丢掉（不过 IPC）', async () => {
    const dir = await tmpDataDir()
    const remote = bundleOf({ 'sessions/1.json': 'remote-1' }, { 'sessions/1.json': Date.now() + 60_000 })
    const made = await buildBag(PW, [{ ref: 'openai:key', value: KEY_A }, { ref: 'deepseek:key', value: KEY_B }], 'dev-a')
    assert.ok(made.ok)
    const gh = makeGh({ bundle: JSON.stringify(remote) })
    gh.seedSecrets((made as { text: string }).text)
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      const env = emptyEnv()
      const svc = makeService(dir, env)
      await svc.init()
      await svc.saveConfig({ repo: 'alice/torra-backup', token: 'good-token' })
      await svc.setBagConfig({ enabled: true, passphrase: PW })

      const out = await svc.pull()
      assert.ok(out.ok, out.reason)
      assert.equal('entries' in out, false, 'sync 层带出来的明文必须在这里删掉，不能跟着结果回渲染层')
      assert.equal(env.keys.get('openai:key'), KEY_A, '钥匙要真写回本机钥匙串')
      assert.equal(env.keys.get('deepseek:key'), KEY_B)
      assert.match(String(svc.snapshot().lastNote), /密钥写回本机钥匙串 2 条/)
      assert.ok(!JSON.stringify(out).includes(KEY_A))
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await it('开着袋但没口令时点备份：数据成功、袋子那句要说得出原因', async () => {
    const dir = await tmpDataDir()
    const gh = makeGh()
    const real = globalThis.fetch
    globalThis.fetch = gh.fetch as typeof fetch
    try {
      await seed(dir, 'sessions/1.json', '{"id":"1"}')
      const env = emptyEnv()
      env.keys.set('openai:key', KEY_A)
      const svc = makeService(dir, env)
      await svc.init()
      await svc.saveConfig({ repo: 'alice/torra-backup', token: 'good-token' })
      await svc.setBagConfig({ enabled: true })

      const out = await svc.push()
      assert.ok(out.ok, out.reason)
      assert.equal(out.bag.wrote, false)
      assert.match(String(svc.snapshot().lastNote), /没输入口令：远端那份保持原样/)
      assert.equal(gh.secrets(), null, '没口令就一个袋子字节都不该发')
      assert.equal(gh.calls.filter((c) => c.method === 'PUT' && String(c.path).includes(SECRETS_FILE)).length, 0)
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * 袋子的下落只有一份措辞（shared/backup.ts 的 bagWord）。
   * 主进程写 lastNote、界面写动作回执都从它出，两边各写一遍早晚一个说「已更新」
   * 一个说「没写上」，而用户只能挑一句信。
   */
  await it('三种「没带上」在措辞里分得开，没开时那句根本不该出现', () => {
    assert.equal(bagWord({ refs: 3, wrote: true }, 'push'), '，密钥袋已更新（3 条）')
    assert.equal(bagWord({ refs: 3, wrote: false }, 'push'), '，密钥袋没写上（3 条还留在本机）')
    assert.equal(bagWord({ refs: 0, wrote: false, note: '这一轮没口令' }, 'push'), '，这一轮没口令')
    assert.equal(bagWord({ ...NO_BAG_OUTCOME }, 'push'), '', '没开袋的人不该在任何结果里看到密钥袋')
    assert.equal(bagWord({ refs: 2, wrote: false }, 'pull'), '，密钥写回本机钥匙串 2 条')
    assert.equal(bagWord({ refs: 0, wrote: false, note: '远端有袋子但没输入口令' }, 'pull'), '，远端有袋子但没输入口令')
  })

  console.log('\n== 定时自动备份：什么时候该跑、什么时候让路 ==')

  const HOUR = 3_600_000
  const auto = (over?: Partial<ReturnType<typeof initialAutoBackupConfig>>) => ({ ...initialAutoBackupConfig(), ...over })

  await it('没开不跑；从没备份过视为到点；间隔没满不跑且说清还差多久', () => {
    assert.equal(dueForAutoBackup(auto({ enabled: false }), 10 * HOUR, 0, null).run, false, '没开就不该动')
    assert.equal(dueForAutoBackup(auto({ enabled: true }), 10 * HOUR, null, null).run, true, '一次都没备份过：第一次节拍就跑')

    // 间隔 6 小时，上次在 2 小时前：还差 4 小时 = 240 分钟
    const soon = dueForAutoBackup(auto({ enabled: true, intervalHours: 6 }), 10 * HOUR, 8 * HOUR, null)
    assert.equal(soon.run, false)
    assert.match(String(soon.reason), /还差 240 分钟/, '不跑要给出可核对的等待时长，不能只说「没到点」')

    // 基准取「备份 / 恢复里较近的那一次」：刚拉取过说明两边一致，不必立刻再推
    assert.equal(dueForAutoBackup(auto({ enabled: true, intervalHours: 6 }), 10 * HOUR, 2 * HOUR, 9 * HOUR).run, false)
    assert.equal(dueForAutoBackup(auto({ enabled: true, intervalHours: 6 }), 15 * HOUR, 8 * HOUR, null).run, true)
  })

  await it('讨论在跑或有动作没结束时让路，这一拍不重入', () => {
    assert.equal(autoBackupGateBlocked({ discussionActive: false, busy: false }), null, '没讨论没忙时不该拦')
    assert.match(String(autoBackupGateBlocked({ discussionActive: true, busy: false })), /讨论/)
    assert.match(String(autoBackupGateBlocked({ discussionActive: false, busy: true })), /还没结束/)
  })

  await it('偏好里的坏值回默认而不是整段作废', () => {
    assert.deepEqual(normalizeAutoBackupConfig(undefined), initialAutoBackupConfig())
    // 旧版本 preferences 里没有 auto 键：必须默认关，不能一升级就自动往外推
    assert.equal(normalizeAutoBackupConfig({}).enabled, false)
    assert.equal(normalizeAutoBackupConfig({ enabled: true, intervalHours: 999 }).intervalHours, initialAutoBackupConfig().intervalHours)
    assert.equal(normalizeAutoBackupConfig({ enabled: true, intervalHours: '6' }).intervalHours, 6, '数字字符串要认（JSON 里存成串很常见）')
    assert.equal(normalizeAutoBackupConfig({ enabled: 'yes', pullToo: 1 }).enabled, false, '非 true 一律算关：自动往外推数据必须是明确开过的')
    assert.deepEqual([...AUTO_BACKUP_INTERVALS], [1, 6, 24])
  })

  await it('改频率不该顺手把开关关掉（undefined 字段不许盖掉现值）', async () => {
    const env = emptyEnv()
    const svc = makeService('C:/tmp', env)
    await svc.init()
    await svc.setAutoConfig({ enabled: true, intervalHours: 6 })
    assert.equal(svc.snapshot().auto.enabled, true)
    assert.equal(svc.snapshot().auto.intervalHours, 6)

    // 只发 intervalHours：enabled 必须留着。对象展开把 undefined 盖上去就是这个 bug 的来源
    await svc.setAutoConfig({ intervalHours: 24 })
    assert.equal(svc.snapshot().auto.enabled, true, '只改频率不该把开关关掉')
    assert.equal(svc.snapshot().auto.intervalHours, 24)

    const stored = (env.prefs.backup as Record<string, unknown>).auto as Record<string, unknown>
    assert.deepEqual(stored, { enabled: true, intervalHours: 24, pullToo: false }, '配置要落 preferences，重启后还在')
    assert.ok(env.sent.includes('backup:state'), '改完要推状态，界面那两处开关才跟得上')
  })

  await it('到点就推一次；讨论在跑时一拍都不动网络', async () => {
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
      gh.reset()

      // 没开：一个请求都不该发
      const off = await svc.autoTick(Date.now() + 100 * HOUR)
      assert.equal(off.ran, false)
      assert.equal(gh.calls.length, 0, '没开自动备份时不该有任何网络动作')

      await svc.setAutoConfig({ enabled: true, intervalHours: 1 })

      // 讨论在跑：让路，同样不发请求
      env.discussionActive = true
      const yield_ = await svc.autoTick(Date.now() + 100 * HOUR)
      assert.equal(yield_.ran, false)
      assert.match(String(yield_.reason), /讨论/)
      assert.equal(gh.calls.length, 0, '讨论进行中不能打包：那一刻存档正在连续变化')
      env.discussionActive = false

      const ran = await svc.autoTick(Date.now() + 100 * HOUR)
      assert.equal(ran.ran, true, '开了、没讨论、到点：这一拍就该推')
      assert.ok(gh.calls.length > 0, '真的发了请求')
      assert.ok(svc.snapshot().lastPushAt, '推送成功要更新 lastPushAt')
      assert.match(String(svc.snapshot().lastNote), /已备份/)

      // 刚推过：下一拍不该再来一次
      const again = await svc.autoTick(Date.now() + 100 * HOUR + 60_000)
      assert.equal(again.ran, false, '一分钟后再问不该又推一次')
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await it('自动备份失败不弹窗、不轰炸：写日志，等满一个周期再试', async () => {
    const dir = await tmpDataDir()
    const real = globalThis.fetch
    try {
      await seed(dir, 'sessions/1.json', '{"id":"1"}')
      const env = emptyEnv()
      const svc = makeService(dir, env)
      await svc.init()
      await svc.saveConfig({ repo: 'alice/torra-backup', token: 'good-token' })
      await svc.setAutoConfig({ enabled: true, intervalHours: 6 })

      // 令牌被吊销：push 必失败（形状与 makeGh 的 reply 一致，github.ts 只读 ok/status/text）
      globalThis.fetch = (async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ message: 'Bad credentials' }),
      })) as unknown as typeof fetch
      const first = await svc.autoTick(Date.now())
      assert.equal(first.ran, true, '这一拍确实动手了')
      assert.ok(first.reason, '失败原因要带回去（进日志，不弹窗）')
      assert.equal(svc.snapshot().lastPushAt, null, '失败不该假装备份成功')
      assert.ok(env.logs.some((l) => !l.ok && /自动备份没跑成/.test(l.detail)), '失败要落一条日志，否则查不到为什么没备份上')

      // 下一拍（同一个间隔内）：不能因为 lastPushAt 没动就无限重试
      const second = await svc.autoTick(Date.now() + 5 * HOUR)
      assert.equal(second.ran, false, '刚失败过就按节拍重试会把日志和远端请求刷爆')
      assert.match(String(second.reason), /后再试/)

      const third = await svc.autoTick(Date.now() + 7 * HOUR)
      assert.equal(third.ran, true, '等满一个周期该再给一次机会')
    } finally {
      globalThis.fetch = real
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  await it('自动拉取是显式选项，默认只推不拉', async () => {
    const cfg = initialAutoBackupConfig()
    assert.equal(cfg.pullToo, false, '默认不自动覆盖本机文件')
    assert.equal(cfg.enabled, false, '自动备份默认关：往外推数据要用户主动开')
  })

  /**
   * 定时任务的接线：主进程按节拍问 autoTick，界面走 backupSetAutoConfig。
   * 这两处一旦改名对不上，症状是「开关点了没反应」和「开了却永远不跑」——
   * 后者尤其难发现，可能几周都不备份。渲染层没有 DOM 测试，只能扫源码钉住。
   */
  await it('定时备份的三层接线名字要对得上（preload / 主进程 / 界面）', async () => {
    const read = async (rel: string) => (await fs.readFile(path.resolve(__dirname, '..', rel), 'utf8')).replace(/\r?\n/g, '\n')
    const main = await read('src/main/index.ts')
    const preload = await read('src/preload/index.ts')
    const ui = await read('src/renderer/components/BackupSection.tsx')
    assert.match(main, /ipcMain\.handle\('backup:auto-config'/, '主进程要有这条 handler')
    assert.match(main, /backup\?\.autoTick\(\)/, '主进程要按节拍真的问 autoTick')
    assert.match(preload, /ipcRenderer\.invoke\('backup:auto-config'/, 'preload 要转到同一个频道名')
    assert.match(ui, /backupSetAutoConfig\(/, '界面要走这条 IPC，不能自己存一份配置')

    // 密钥袋同样是三层接线：这条对不上的症状是「开了开关但备份永远不带钥匙」，
    // 而界面上那句「已开启」看着是绿的 —— 几周后换机器才发现 Key 没跟上
    assert.match(main, /ipcMain\.handle\('backup:bag-config'/, '主进程要有密钥袋的 handler')
    assert.match(preload, /ipcRenderer\.invoke\('backup:bag-config'/, 'preload 要转到同一个频道名')
    assert.match(ui, /backupSetBagConfig\(/, '界面要走这条 IPC，不能自己存口令')
    assert.match(main, /passphrase\.slice\(0, PASSPHRASE_MAX\)/, '口令长度要在入口就设上限，别让主进程揣着一大段明文')
    assert.match(ui, /setBag\(\{ passphrase: bagPw \}\)/, '口令只在一次调用里过去，界面上不留副本')
    const all = main + preload + ui
    assert.ok(!/console\.\w+\([^)]*passphrase/i.test(all), '口令不许进任何一处 console 输出')
  })

  console.log(`\n通过 ${pass} · 失败 ${failed.length}`)
  if (failed.length > 0) {
    for (const f of failed) console.error(`! ${f}`)
    process.exit(1)
  }
}

void main()

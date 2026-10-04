/**
 * 运行时验证：按需预热是否真的减少了启动实例数。
 *
 * 读真实分区的 cookie，逐个判定「可能已登录」，对比
 * 「无条件预热全部」与「按需预热」的实例数差异。
 * 不加载任何站点页面，纯 cookie 层判定。
 */
const { app, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..')
app.setPath('userData', path.join(process.env.APPDATA || '', 'torra'))

const YAML = require(path.join(ROOT, 'node_modules', 'yaml'))

// 复刻 index.ts loadDefaultModels() 的 webview 型模型
const WEBVIEWS = [
  { id: 'chatgpt', adapter: 'chatgpt' },
  { id: 'claude', adapter: 'claude' },
  { id: 'gemini', adapter: 'gemini' },
  { id: 'deepseek-web', adapter: 'deepseek' },
  { id: 'qwen', adapter: 'qwen' },
  { id: 'doubao', adapter: 'doubao' },
  { id: 'kimi', adapter: 'kimi' },
]

// 复刻 pool.ts probeSessionCookies 的判定（含排除名单）
const AUTH_RE = /access_?token|id_?token|refresh_?token|session_?token|auth_?token|passport(?!_csrf)|sso|sid$|^sid|credential|bearer|jwt|oai-client-auth-info|next-auth|^ds_session_id$/i
const NOT_AUTH_RE = /__ssid|__cf_bm|cf_clearance|__cflb|passport_csrf|bd_sso|theme|locale|lang|width|order|entry|dark|smid|thumbcache|_ga|_gid|abtest|experiment|sidebar/i

async function probe(partition, host) {
  const hits = []
  try {
    const all = await session.fromPartition(partition).cookies.get({})
    for (const c of all) {
      const domain = String(c.domain ?? '').replace(/^\./, '')
      const name = String(c.name ?? '')
      if (!domain.endsWith(host.replace(/^www\./, ''))) continue
      if (NOT_AUTH_RE.test(name)) continue
      if (String(c.value ?? '').length > 8 && AUTH_RE.test(name)) hits.push(name)
    }
    return { likelyLoggedIn: hits.length > 0, hits: hits.slice(0, 4), total: all.length }
  } catch {
    return { likelyLoggedIn: false, hits: [], total: 0 }
  }
}

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const rows = []
  for (const m of WEBVIEWS) {
    const spec = YAML.parse(fs.readFileSync(path.join(ROOT, 'adapters', `${m.adapter}.yaml`), 'utf8'))
    const host = new URL(spec.entry).hostname
    const r = await probe(`persist:torra-${m.id}`, host)
    rows.push({ id: m.id, name: m.id, host, prewarm: spec.prewarm === true, ...r })
  }

  console.log('=== 按需预热判定（基于真实分区 cookie）===\n')
  for (const r of rows) {
    const verdict = r.likelyLoggedIn
      ? '预热（Cookie 已登录）'
      : r.prewarm
        ? '预热（启动页面复核）'
        : '按需启动（未登录）'
    console.log(
      `  ${r.id.padEnd(14)} cookie=${String(r.total).padStart(2)} 命中=${String(r.hits.length).padStart(2)}  ${verdict}` +
      (r.hits.length ? `  [${r.hits.slice(0, 2).join(',')}]` : ''),
    )
  }

  const warm = rows.filter((r) => r.likelyLoggedIn || r.prewarm)
  const lazy = rows.filter((r) => !r.likelyLoggedIn && !r.prewarm)
  console.log('')
  console.log(`无条件预热：${rows.length} 个实例 × 250MB = ${rows.length * 250}MB`)
  console.log(`按需预热：  ${warm.length} 个实例 × 250MB = ${warm.length * 250}MB` +
    (lazy.length ? `（省下 ${lazy.length * 250}MB）` : ''))
  console.log('')
  console.log(warm.length < rows.length
    ? `PASS 启动实例数从 ${rows.length} 降到 ${warm.length}，未登录模型按需启动`
    : `当前所有分区都有登录凭据，按需预热不减少实例（预期行为）`)

  const out = {
    total: rows.length,
    warmed: warm.map((r) => r.id),
    lazy: lazy.map((r) => r.id),
    savedMb: lazy.length * 250,
    rows,
  }
  fs.writeFileSync(path.join(ROOT, 'docs', 'verify-warm-on-demand.json'), JSON.stringify(out, null, 2), 'utf8')
  app.exit(0)
})

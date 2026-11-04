#!/usr/bin/env node
/**
 * 面板离线验收：把科研工作台的面板挂上一套桩 SDK，数据来自真实的一次 ssh 扫描。
 *
 * 为什么要有它：面板的合规那一行（「规范校验通过 / 没过（哪几条）/ 未扫描」）有两件事
 * 能出错——文案对不对（有单测盯着），以及放进面板里长什么样（单测看不出来）。后者得
 * 真在浏览器里看一眼。
 *
 * 数据不是编的：本脚本 require 插件自己的 main.js，用一套内存 storage 激活它，
 * 指向 gpu-master 的 /workspace 跑一次真的 server.history，把返回值原样喂给桩 SDK。
 * 于是页面里出现的运行、指标、合规结论，都跟应用里看到的是同一份。
 *
 * 用法：
 *    node scripts/preview-research-panel.cjs            # 产出 scripts/.panel-preview/index.html
 *    node scripts/preview-research-panel.cjs tkgr/cog   # 只抓某个前缀下的运行，文件更小
 *    PANEL_SKIP_HISTORY=1 node scripts/preview-research-panel.cjs --serve
 *                                                       # 起本地服务，文件树走真 ssh，不预扫历史
 *
 * 产出之后用浏览器打开那个文件，点「实验历史」再点一次运行，看规范结论那一行。
 * 这里不写断言：它只负责把真数据摆进去，判断交给眼睛。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SERVER_DIR = path.join(ROOT, 'plugins', 'research', 'modules', 'server')
const OUT_DIR = path.join(ROOT, 'scripts', '.panel-preview')
const ALIAS = process.env.PANEL_SSH_ALIAS || 'gpu-master'
const ROOT_PATH = process.env.PANEL_ROOT || '/workspace'

/** 插件不认 ssh 别名，它自己拼 host/user/port/key，所以要先把别名解析成实际值。 */
function resolveAlias(alias) {
  const out = require('node:child_process').execFileSync('ssh', ['-G', alias], { encoding: 'utf8' })
  const pick = (key) => {
    const line = out.split('\n').find((l) => l.toLowerCase().startsWith(key + ' '))
    return line ? line.slice(key.length + 1).trim() : ''
  }
  // 有的机器用别名指定了专用私钥（IdentityFile），插件不认别名就得把路径一起带过去；
  // 不展开 ~ 的话插件的 checkKey 会判它「不是绝对路径」直接丢掉
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const key = pick('identityfile').replace(/^~(?=$|[/\\])/, home)
  return {
    id: alias,
    label: alias,
    host: pick('hostname') || alias,
    user: pick('user') || 'root',
    port: Number(pick('port')) || 22,
    keyPath: key && fs.existsSync(key) ? key : '',
    createdAt: Date.now(),
    last: null,
  }
}

async function capture(filter) {
  const mod = require(path.join(SERVER_DIR, 'main.js'))
  const server = resolveAlias(ALIAS)
  const handlers = new Map()
  const store = new Map()
  store.set('servers', [server])
  store.set('roots', { [server.id]: { root: ROOT_PATH, at: Date.now() } })
  const context = {
    log: () => {},
    rpc: { handle: (name, fn) => handlers.set(name, fn) },
    tools: { handle: () => {} },
    storage: {
      async get(key) { return store.get(key) },
      async set(key, value) { store.set(key, value) },
    },
  }
  await mod.activate(context)
  const call = (name, params) => {
    const fn = handlers.get(name)
    if (!fn) return Promise.reject(new Error('插件没注册这一步：' + name))
    return fn(params || {})
  }

  const servers = await call('server.list')
  const roots = await call('server.roots.list')
  /*
   * PANEL_SKIP_HISTORY=1 不预扫历史：整台机器的历史扫描要好几分钟，而改文件树的人
   * 只想快点看到树。历史页还在，进去点「扫描历史」照样是真扫 —— 少的是等待，不是能力。
   */
  const history = process.env.PANEL_SKIP_HISTORY
    ? { runs: [] }
    : await call('server.history', { serverId: server.id, refresh: true })
  if (filter) {
    const runs = (history.runs || []).filter((run) => String(run.rel || '').indexOf(filter) > -1)
    history.runs = runs
  }
  // 修复预览是真跑一次：它只读日志、只在服务器上生成，不写任何文件。
  // 写回那一档不在这里跑——那会动真的 run 目录，离线的预览没有这个权力。
  // 只挑四层的运行：三层的存档目录没有族，生成器本来就不该接
  const target = (history.runs || []).find((run) => run.compliance && !run.compliance.ok && run.compliance.readme &&
    String(run.rel || '').replace(/^02_runs\//, '').split('/').length === 4)
  let preview = null
  if (target) {
    const rel = String(target.rel).replace(/^02_runs\//, '')
    preview = { rel, data: await call('server.readme.preview', { serverId: server.id, rel }) }
  }
  return { servers, roots, history, preview, call }
}

/**
 * 面板的配色不在面板里——`--p-*` 这些变量由宿主那个沙箱帧注入（src/main/plugins/panel.ts）。
 * 离线预览里不补上这一段，所有颜色会掉回继承色（黑字黑底），看出来的「视觉问题」全是假的。
 * 所以这里直接调宿主那个函数，不手抄一份。
 */
function hostBaseStyles() {
  const esbuild = require('esbuild')
  const source = fs.readFileSync(path.join(ROOT, 'src', 'main', 'plugins', 'panel.ts'), 'utf8')
  const code = esbuild.transformSync(source, { loader: 'ts', format: 'cjs' }).code
  const mod = { exports: {} }
  new Function('module', 'exports', code)(mod, mod.exports)
  return mod.exports.panelBaseStyles()
}

function build(captured, live) {
  const ui = fs.readFileSync(path.join(SERVER_DIR, 'ui.html'), 'utf8')
  const stub = {
    'server.list': captured.servers,
    'server.roots.list': captured.roots,
    'server.history': captured.history,
    'ssh.scan': { entries: [] },
    'server.observe': {},
    'server.experiments': { experiments: [] },
    'server.progress': { lines: [] },
    'server.dirs': { dirs: [] },
  }
  /*
   * 文件那几条走真 ssh：项目文件树现在能走到绑定目录外面（回 / 、去 /workspace 之外），
   * 桩里那份固定返回值验不了这个——面包屑点一层就该换一层，数据必须跟着路径变。
   * server.dirs 也在里面：挑根目录的那个下拉刚改成和浏览同一套路径规则，不真跑一次
   * 就不知道它还在不在；roots.set 只写本脚本那份内存 storage，落不到应用配置里。
   */
  const LIVE = ['server.files', 'server.browse_files', 'server.read_text', 'server.browse_read',
    'server.dirs', 'server.roots.set']
  if (captured.preview) {
    stub['server.readme.preview'] = captured.preview.data
  }
  stub['server.readme.write'] = {
    rel: captured.preview ? captured.preview.rel : '',
    family: '',
    backup: '_migration/readme_backup_<日期>/（预览夹具：没有真写）',
    written: [],
    check: { check_exit: 0, summary: ['运行总数 10', '完全合规 10', '问题条数 0'] },
  }
  const inject = [
    '<style data-torra-plugin="base">' + hostBaseStyles() + '</style>',
    live ? [
      '<script>',
      '/* --serve 桥：文件类 RPC 转给本机的插件进程，由它真的 ssh 到那台机器 */',
      'window.__panelLive = function (method, params) {',
      '  return fetch("/__rpc", { method: "POST", headers: { "content-type": "application/json" },',
      '    body: JSON.stringify({ method: method, params: params }) })',
      '    .then(function (r) { return r.json() })',
      '    .then(function (j) { if (j && j.ok) return j.data; throw new Error(j && j.message ? j.message : "桥调用失败") });',
      '};',
      '</script>',
    ].join('\n') : null,
    '<script>',
    '/* 离线验收桩：面板只跟这一段说话，数据由 preview-research-panel.cjs 抓自真实扫描 */',
    'window.torraPlugin = {',
    '  call: function (method, params) {',
    '    var data = ' + JSON.stringify(stub) + ';',
    '    var live = ' + JSON.stringify(LIVE) + ';',
    (live
      ? '    if (live.indexOf(method) >= 0) return window.__panelLive(method, params || {});'
      : '    if (live.indexOf(method) >= 0) return Promise.resolve({ root: params && params.path, path: params && params.path, entries: [], at: Date.now() });'),
    '    if (!Object.prototype.hasOwnProperty.call(data, method)) {',
    '      return Promise.reject(new Error("桩没有这一步：" + method));',
    '    }',
    '    return Promise.resolve(data[method]);',
    '  },',
    '  onTheme: function () {},',
    '};',
    '</script>',
  ].filter(Boolean).join('\n')
  const at = ui.indexOf('<style')
  if (at < 0) throw new Error('ui.html 里找不到样式开始标记')
  return ui.slice(0, at) + inject + '\n' + ui.slice(at)
}

async function main() {
  const args = process.argv.slice(2)
  const serve = args.includes('--serve')
  const filter = args.find((a) => a && a[0] !== '-') || ''
  const captured = await capture(filter)
  const runs = captured.history.runs || []
  const withCompliance = runs.filter((run) => run.compliance).length
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = path.join(OUT_DIR, 'index.html')
  fs.writeFileSync(file, build(captured, serve), 'utf8')
  console.log('运行 %d 条，其中 %d 条带合规结论', runs.length, withCompliance)
  console.log('修复预览：%s', captured.preview ? captured.preview.rel + '（真跑了一次生成，没写任何文件）' : '没有可预览的运行')
  console.log('产出：%s', file)
  if (!serve) {
    console.log('用浏览器打开它，点「实验历史」，再点一次运行，看规范结论那一行。')
    return
  }
  // --serve：文件那几条 RPC 现场转给插件，于是项目文件树能真的在机器上逛
  const http = require('node:http')
  const html = fs.readFileSync(file, 'utf8')
  const port = Number(process.env.PANEL_PREVIEW_PORT) || 4173
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/__rpc') {
      let body = ''
      req.on('data', (chunk) => { body += chunk; if (body.length > 4e6) req.destroy() })
      req.on('end', async () => {
        let sent = false
        const reply = (code, payload) => {
          if (sent) return
          sent = true
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        }
        try {
          const parsed = JSON.parse(body || '{}')
          const data = await captured.call(parsed.method, parsed.params || {})
          reply(200, { ok: true, data })
        } catch (error) {
          reply(200, { ok: false, message: error && error.message ? error.message : String(error) })
        }
      })
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  server.listen(port, '127.0.0.1', () => {
    console.log('验收服务：http://127.0.0.1:%s/ （项目文件树走真 ssh，Ctrl+C 结束）', port)
  })
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
})

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
  const history = await call('server.history', { serverId: server.id, refresh: true })
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
  return { servers, roots, history, preview }
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

function build(captured) {
  const ui = fs.readFileSync(path.join(SERVER_DIR, 'ui.html'), 'utf8')
  const stub = {
    'server.list': captured.servers,
    'server.roots.list': captured.roots,
    'server.history': captured.history,
    'ssh.scan': { entries: [] },
    'server.observe': {},
    'server.experiments': { experiments: [] },
    'server.progress': { lines: [] },
    'server.files': { entries: [] },
    'server.dirs': { dirs: [] },
  }
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
    '<script>',
    '/* 离线验收桩：面板只跟这一段说话，数据由 preview-research-panel.cjs 抓自真实扫描 */',
    'window.torraPlugin = {',
    '  call: function (method) {',
    '    var data = ' + JSON.stringify(stub) + ';',
    '    if (!Object.prototype.hasOwnProperty.call(data, method)) {',
    '      return Promise.reject(new Error("桩没有这一步：" + method));',
    '    }',
    '    return Promise.resolve(data[method]);',
    '  },',
    '  onTheme: function () {},',
    '};',
    '</script>',
  ].join('\n')
  const at = ui.indexOf('<style')
  if (at < 0) throw new Error('ui.html 里找不到样式开始标记')
  return ui.slice(0, at) + inject + '\n' + ui.slice(at)
}

async function main() {
  const filter = process.argv[2] || ''
  const captured = await capture(filter)
  const runs = captured.history.runs || []
  const withCompliance = runs.filter((run) => run.compliance).length
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = path.join(OUT_DIR, 'index.html')
  fs.writeFileSync(file, build(captured), 'utf8')
  console.log('运行 %d 条，其中 %d 条带合规结论', runs.length, withCompliance)
  console.log('修复预览：%s', captured.preview ? captured.preview.rel + '（真跑了一次生成，没写任何文件）' : '没有可预览的运行')
  console.log('产出：%s', file)
  console.log('用浏览器打开它，点「实验历史」，再点一次运行，看规范结论那一行。')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
})

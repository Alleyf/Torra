/**
 * 插件服务：发现、启停、安装、面板签发、工具与提示词出口。
 *
 * 状态文件只存「用户是否启用」和「启用时授予了哪些能力」。升级后插件清单多要一条能力
 * 时不会静默生效 —— 权限集合变了就自动停用并要求重新确认。这条规则是给「插件作者
 * 后来加了 net:evil.com」准备的，靠人记住每次升级改了什么不现实。
 */

import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  PluginInvokeResult,
  PluginListResult,
  PluginManifest,
  PluginPanelResult,
  PluginActionResult,
  PluginView,
  PluginPermission,
} from '../../shared/plugins'
import { loadManifest } from './manifest'
import { PluginRuntime } from './host'
import { extractZip, ZipError } from './zip'
import { torraUiFrameUrl, TORRA_UI_FRAME_MAX_BYTES } from '../../shared/ui-frame'
import type { PluginAi } from './ai'
import { PANEL_MAX_BYTES, injectPanel } from './panel'
import { getFavicon, sniffMime } from '../net/favicon-cache'

const STATE_FILE = 'plugins-state.json'
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000
const MAX_TOKENS = 200
const INSTALL_MAX_FILES = 1000
const INSTALL_MAX_BYTES = 50 * 1024 * 1024

export interface PluginServiceDeps {
  dataDir: string
  builtinDir: string
  /** has 只回答「配没配」，给设置页列状态用；不接也能跑，只是全部显示未配置 */
  secrets: {
    get(ref: string): Promise<string | null> | string | null
    has?(ref: string): boolean
  }
  log(event: { stage: string; subject: string; ok: boolean; detail: string }): void
  /** 插件的 AI 通道；没接线时声明的能力照样存在，调用会被宿主拒绝 */
  ai?: PluginAi
  /** 面板里点外链时交给主进程开系统浏览器；不接则面板只能复制链接 */
  openExternal?(url: string): void
}

interface Entry {
  manifest: PluginManifest
  dir: string
  origin: 'builtin' | 'user'
}

interface StateEntry {
  enabled: boolean
  /** 启用那一刻清单里的能力；清单变更后集合不一致就停用 */
  granted: string[]
}

interface StateFile {
  plugins: Record<string, StateEntry>
}

export interface PluginToolSpec {
  pluginId: string
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  invoke(params: Record<string, unknown>): Promise<unknown>
}

function dirSize(dir: string, budget = { files: 0, bytes: 0 }): { files: number; bytes: number } {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      dirSize(full, budget)
    } else if (item.isFile()) {
      budget.files += 1
      budget.bytes += statSync(full).size
    }
    if (budget.files > INSTALL_MAX_FILES) throw new Error(`目录文件数超过 ${INSTALL_MAX_FILES}`)
    if (budget.bytes > INSTALL_MAX_BYTES) throw new Error(`目录超过 ${INSTALL_MAX_BYTES / 1024 / 1024}MB`)
  }
  return budget
}

/** zip 解出来可能多一层同名目录，真正的插件根按清单位置判断 */
function findPluginRoot(dir: string): string | null {
  if (existsSync(path.join(dir, 'torra-plugin.json'))) return dir
  const children = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
  if (children.length === 1) {
    const only = path.join(dir, children[0]!.name)
    if (existsSync(path.join(only, 'torra-plugin.json'))) return only
  }
  return null
}

export class PluginService {
  private entries = new Map<string, Entry>()
  private runtimes = new Map<string, PluginRuntime>()
  private invalid: Array<{ dir: string; errors: string[] }> = []
  private state: StateFile = { plugins: {} }
  private tokens = new Map<string, { pluginId: string; expires: number }>()

  constructor(private readonly deps: PluginServiceDeps) {}

  get userDir(): string {
    return path.join(this.deps.dataDir, 'plugins')
  }

  private get stateFile(): string {
    return path.join(this.deps.dataDir, STATE_FILE)
  }

  async init(): Promise<void> {
    this.loadState()
    this.migrateResearchData()
    this.discover()
    for (const [id, entry] of this.entries) {
      const record = this.state.plugins[id]
      if (!record?.enabled) continue
      if (!this.sameGrants(record.granted, entry.manifest.permissions)) {
        this.state.plugins[id] = { enabled: false, granted: [] }
        this.deps.log({
          stage: 'plugin:perm-changed',
          subject: id,
          ok: false,
          detail: `能力清单从 [${record.granted.join(', ')}] 变成 [${entry.manifest.permissions.join(', ')}]，已自动停用，需重新确认`,
        })
        continue
      }
      void this.start(id)
    }
    this.saveState()
  }

  /**
   * 服务器看板 / 学者工作台 / 研究主线图并进了「科研工作台」。
   *
   * 三个旧插件的存储键在新插件里各加一个前缀（server: / scholar: / trajectory:），
   * 旧目录原样留着当备份：迁移错了还能手工捞回来。只在第一次做，写成标记文件；
   * 目标 already 有数据时也不覆盖 —— 那说明用户已经在新插件里干过活了。
   */
  private migrateResearchData(): void {
    const root = path.join(this.deps.dataDir, 'plugin-data')
    const targetDir = path.join(root, 'research')
    const marker = path.join(targetDir, '.migrated-from-legacy')
    if (existsSync(marker)) return
    const merged: Record<string, unknown> = {}
    let moved = 0
    for (const [id, prefix] of [
      ['server', 'server:'],
      ['scholar', 'scholar:'],
      ['trajectory', 'trajectory:'],
    ] as const) {
      const file = path.join(root, id, 'store.json')
      if (!existsSync(file)) continue
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          merged[`${prefix}${key}`] = value
          moved += 1
        }
      } catch (error) {
        this.deps.log({
          stage: 'plugin:migrate',
          subject: id,
          ok: false,
          detail: `旧存储读不出来，跳过：${(error as Error).message}`,
        })
      }
    }
    try {
      mkdirSync(targetDir, { recursive: true })
      const storeFile = path.join(targetDir, 'store.json')
      if (moved > 0 && !existsSync(storeFile)) {
        const tmp = `${storeFile}.tmp`
        writeFileSync(tmp, JSON.stringify(merged), 'utf8')
        renameSync(tmp, storeFile)
        this.deps.log({
          stage: 'plugin:migrate',
          subject: 'research',
          ok: true,
          detail: `已合并 ${moved} 个旧存储键（旧目录保留）`,
        })
      }
      writeFileSync(marker, JSON.stringify({ at: Date.now(), moved }), 'utf8')
    } catch (error) {
      this.deps.log({ stage: 'plugin:migrate', subject: 'research', ok: false, detail: (error as Error).message })
    }
  }

  private sameGrants(granted: string[], declared: PluginPermission[]): boolean {
    if (granted.length !== declared.length) return false
    const set = new Set(granted)
    return declared.every((p) => set.has(p))
  }

  private loadState(): void {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as StateFile
      this.state = raw && typeof raw === 'object' && raw.plugins ? raw : { plugins: {} }
    } catch {
      this.state = { plugins: {} }
    }
  }

  private saveState(): void {
    mkdirSync(this.deps.dataDir, { recursive: true })
    const tmp = `${this.stateFile}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.stateFile)
  }

  private discover(): void {
    this.entries.clear()
    this.invalid = []
    const scan = (dir: string, origin: 'builtin' | 'user'): void => {
      let children
      try {
        children = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())
      } catch {
        return
      }
      for (const child of children) {
        const full = path.join(dir, child.name)
        if (!existsSync(path.join(full, 'torra-plugin.json'))) continue
        const entry = loadManifest(full)
        if (!entry.ok) {
          this.invalid.push({ dir: full, errors: entry.errors })
          continue
        }
        // 用户目录覆盖内置：改一个随包插件不该逼人改安装目录里的文件
        const existing = this.entries.get(entry.manifest.id)
        if (existing && existing.origin === 'user' && origin === 'builtin') continue
        this.entries.set(entry.manifest.id, { manifest: entry.manifest, dir: full, origin })
      }
    }
    scan(this.deps.builtinDir, 'builtin')
    scan(this.userDir, 'user')
  }

  listView(): PluginListResult {
    const plugins: PluginView[] = [...this.entries.values()]
      .map((entry) => {
        const runtime = this.runtimes.get(entry.manifest.id)
        const record = this.state.plugins[entry.manifest.id]
        const enabled = record?.enabled === true
        const manifestsTools = entry.manifest.contributes?.tools ?? []
        return {
          id: entry.manifest.id,
          name: entry.manifest.name,
          version: entry.manifest.version,
          description: entry.manifest.description,
          origin: entry.origin,
          dir: entry.dir,
          enabled,
          status: enabled ? (runtime?.status ?? 'stopped') : 'stopped',
          ...(runtime?.error ? { error: runtime.error } : {}),
          ...(entry.manifest.contributes?.panel ? { panel: entry.manifest.contributes.panel } : {}),
          tools: manifestsTools.map((t) => ({ name: t.name, label: t.label, description: t.description })),
          prompts: (entry.manifest.contributes?.prompts ?? []).map((p) => ({ id: p.id, title: p.title })),
          permissions: entry.manifest.permissions,
          // 引用名由宿主拼：插件只能读到自己的命名空间，清单里写不了别人的 ref
          secrets: (entry.manifest.secrets ?? []).map((secret) => {
            const ref = `plugin:${entry.manifest.id}:${secret.name}`
            return { ...secret, ref, configured: this.deps.secrets.has?.(ref) === true }
          }),
          files: {
            main: !!entry.manifest.main && existsSync(path.join(entry.dir, entry.manifest.main)),
            ui: !!entry.manifest.ui && existsSync(path.join(entry.dir, entry.manifest.ui)),
          },
        } satisfies PluginView
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    return { plugins, invalid: this.invalid, userDir: this.userDir }
  }

  view(id: string): PluginView | undefined {
    return this.listView().plugins.find((p) => p.id === id)
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginActionResult> {
    const entry = this.entries.get(id)
    if (!entry) return { ok: false, reason: `插件「${id}」不存在` }
    if (!enabled) {
      this.state.plugins[id] = { enabled: false, granted: [] }
      this.saveState()
      this.runtimes.get(id)?.stop()
      this.runtimes.delete(id)
      this.deps.log({ stage: 'plugin:disable', subject: id, ok: true, detail: '已停用' })
      return { ok: true, plugin: this.view(id) }
    }
    this.state.plugins[id] = { enabled: true, granted: [...entry.manifest.permissions] }
    this.saveState()
    if (entry.manifest.main) {
      const error = await this.start(id)
      if (error) {
        this.deps.log({ stage: 'plugin:enable', subject: id, ok: false, detail: error })
        return { ok: false, reason: error, plugin: this.view(id) }
      }
    }
    this.deps.log({ stage: 'plugin:enable', subject: id, ok: true, detail: entry.manifest.version })
    return { ok: true, plugin: this.view(id) }
  }

  private async start(id: string): Promise<string | null> {
    const entry = this.entries.get(id)
    if (!entry || !entry.manifest.main) return null
    const existing = this.runtimes.get(id)
    if (existing && (existing.status === 'ready' || existing.status === 'starting')) return null
    existing?.stop()
    const runtime = new PluginRuntime(entry.manifest, entry.dir, {
      dataDir: this.deps.dataDir,
      entryPath: path.join(__dirname, 'runtime-entry.js'),
      secrets: this.deps.secrets,
      log: (event) => this.deps.log(event),
      ...(this.deps.ai ? { ai: this.deps.ai } : {}),
    })
    this.runtimes.set(id, runtime)
    try {
      await runtime.start()
      return null
    } catch (error) {
      return (error as Error).message
    }
  }

  async reload(id: string): Promise<PluginActionResult> {
    const entry = this.entries.get(id)
    if (!entry) return { ok: false, reason: `插件「${id}」不存在` }
    this.runtimes.get(id)?.stop()
    this.runtimes.delete(id)
    const enabled = this.state.plugins[id]?.enabled === true
    if (enabled && entry.manifest.main) {
      const error = await this.start(id)
      if (error) return { ok: false, reason: error, plugin: this.view(id) }
    }
    return { ok: true, plugin: this.view(id) }
  }

  async install(source: string): Promise<PluginActionResult> {
    const sourcePath = path.resolve(source)
    if (!existsSync(sourcePath)) return { ok: false, reason: `路径不存在：${sourcePath}` }
    mkdirSync(this.userDir, { recursive: true })
    const staging = path.join(this.userDir, `.install-${randomBytes(6).toString('hex')}`)
    try {
      const stats = statSync(sourcePath)
      if (stats.isDirectory()) {
        dirSize(sourcePath)
        cpSync(sourcePath, staging, { recursive: true })
      } else if (/\.zip$/i.test(sourcePath)) {
        mkdirSync(staging, { recursive: true })
        const { files } = extractZip(sourcePath, staging)
        if (files === 0) return { ok: false, reason: 'zip 里没有文件' }
      } else {
        return { ok: false, reason: '只支持插件目录或 .zip 包' }
      }
      const root = findPluginRoot(staging)
      if (!root) return { ok: false, reason: '包里找不到 torra-plugin.json' }
      const parsed = loadManifest(root)
      if (!parsed.ok) return { ok: false, reason: parsed.errors.join('；') }
      const target = path.join(this.userDir, parsed.manifest.id)
      if (existsSync(target)) return { ok: false, reason: `插件「${parsed.manifest.id}」已安装：先卸载再装` }
      renameSync(root, target)
      this.discover()
      this.deps.log({ stage: 'plugin:install', subject: parsed.manifest.id, ok: true, detail: target })
      return { ok: true, plugin: this.view(parsed.manifest.id) }
    } catch (error) {
      const reason = error instanceof ZipError ? error.message : (error as Error).message
      this.deps.log({ stage: 'plugin:install', subject: path.basename(sourcePath), ok: false, detail: reason })
      return { ok: false, reason }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  async uninstall(id: string): Promise<PluginActionResult> {
    const entry = this.entries.get(id)
    if (!entry) return { ok: false, reason: `插件「${id}」不存在` }
    if (entry.origin !== 'user') return { ok: false, reason: '内置插件不能卸载，只能停用' }
    this.runtimes.get(id)?.stop()
    this.runtimes.delete(id)
    const expected = path.resolve(this.userDir, id)
    if (path.resolve(entry.dir) !== expected) return { ok: false, reason: '插件目录不在用户目录里，拒绝删除' }
    rmSync(expected, { recursive: true, force: true })
    delete this.state.plugins[id]
    this.saveState()
    this.discover()
    this.deps.log({ stage: 'plugin:uninstall', subject: id, ok: true, detail: expected })
    return { ok: true }
  }

  async openPanel(id: string, theme: 'dark' | 'light'): Promise<PluginPanelResult> {
    const entry = this.entries.get(id)
    if (!entry) return { ok: false, reason: `插件「${id}」不存在` }
    if (!this.state.plugins[id]?.enabled) return { ok: false, reason: '插件还没启用' }
    const panel = entry.manifest.contributes?.panel
    if (!panel || !entry.manifest.ui) return { ok: false, reason: '这个插件没有面板' }
    const runtime = this.runtimes.get(id)
    if (entry.manifest.main && (!runtime || runtime.status !== 'ready')) {
      return { ok: false, reason: runtime?.error ?? '插件进程没起来，面板拿不到数据' }
    }
    const file = path.resolve(entry.dir, entry.manifest.ui)
    let html: string
    try {
      const raw = readFileSync(file)
      if (raw.length > PANEL_MAX_BYTES) return { ok: false, reason: `面板文档超过 ${PANEL_MAX_BYTES / 1024}KB` }
      html = raw.toString('utf8')
    } catch (error) {
      return { ok: false, reason: `面板文档读不出来：${(error as Error).message}` }
    }
    const token = randomBytes(24).toString('hex')
    const document = injectPanel(html, token, id, theme)
    // 源文件卡一次、拼完 SDK 之后再卡一次：底座样式和 SDK 也占字节，
    // 只卡源文件会让「刚好 512KB」的包在拼 URL 时才炸，报错还是一条英文内部信息
    const bytes = Buffer.byteLength(document, 'utf8')
    if (bytes > TORRA_UI_FRAME_MAX_BYTES) {
      return { ok: false, reason: `面板文档过大（${Math.ceil(bytes / 1024)}KB，上限 ${TORRA_UI_FRAME_MAX_BYTES / 1024}KB）` }
    }
    this.tokens.set(token, { pluginId: id, expires: Date.now() + TOKEN_TTL_MS })
    if (this.tokens.size > MAX_TOKENS) {
      const now = Date.now()
      for (const [key, value] of this.tokens) {
        if (value.expires < now || this.tokens.size > MAX_TOKENS) this.tokens.delete(key)
      }
    }
    try {
      return {
        ok: true,
        url: torraUiFrameUrl(document),
        token,
        title: panel.title,
        ...(panel.icon ? { icon: panel.icon } : {}),
      }
    } catch (error) {
      return { ok: false, reason: (error as Error).message }
    }
  }

  async invokePanel(token: string, method: string, params: unknown): Promise<PluginInvokeResult> {
    const record = this.tokens.get(token)
    if (!record || record.expires < Date.now()) {
      if (record) this.tokens.delete(token)
      return { ok: false, error: '面板会话已过期：重新打开面板' }
    }
    const entry = this.entries.get(record.pluginId)
    if (!entry) return { ok: false, error: '插件不在' }
    const args = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
    // 面板自己的静态资源（模块 html 等）由宿主代读：帧里没有 fs，也不该有
    if (method === 'host.asset') {
      return this.readPanelAsset(entry, args)
    }
    // 外链只能交给系统浏览器：沙箱帧里 window.open 会被拦，a 也不该有导航能力
    if (method === 'host.open_external') {
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { ok: false, error: '链接不合法' }
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: '只允许打开 http/https 链接' }
      }
      if (!this.deps.openExternal) return { ok: false, error: '宿主没有接外链出口' }
      this.deps.openExternal(parsed.toString())
      return { ok: true, value: null }
    }
    if (method === 'host.icon') {
      // 面板帧不允许连接网络，图标只能由宿主代取；这里复用渲染层已有的
      // favicon 磁盘缓存（固定的几个图标源 + 按域名落盘），只收域名，
      // 不接受路径或任意 URL —— 不给插件留一条能打任意地址的口子。
      const domain = typeof args.domain === 'string' ? args.domain.trim().toLowerCase() : ''
      if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.length > 253) {
        return { ok: false, error: '域名不合法' }
      }
      const buf = await getFavicon(domain)
      if (!buf) return { ok: false, error: '没有取到图标' }
      if (buf.length > 256 * 1024) return { ok: false, error: '图标过大' }
      const mime = sniffMime(buf)
      if (!mime) return { ok: false, error: '取到的不是图片' }
      return { ok: true, value: { domain, dataUrl: `data:${mime};base64,${buf.toString('base64')}` } }
    }
    const runtime = this.runtimes.get(record.pluginId)
    if (!runtime) return { ok: false, error: '插件进程不在' }
    try {
      const value = await runtime.invokeRpc(method, args)
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  /**
   * 面板读自己的静态文件。
   *
   * 只允许插件目录内的相对路径 —— 这是一条从沙箱帧回到文件系统的通道，
   * 一旦能拼出 `..` 就等于把整块磁盘给了面板。单个文件仍卡在帧上限内：
   * 大文件塞进 srcdoc 一样会在拼 URL 时炸。
   */
  private readPanelAsset(entry: Entry, args: Record<string, unknown>): PluginInvokeResult {
    const rel = typeof args.path === 'string' ? args.path.trim() : ''
    if (!rel || rel.includes('\0')) return { ok: false, error: '缺少文件路径' }
    const root = path.resolve(entry.dir)
    const abs = path.resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) return { ok: false, error: '路径越界' }
    try {
      const stats = statSync(abs)
      if (!stats.isFile()) return { ok: false, error: '不是文件' }
      if (stats.size > TORRA_UI_FRAME_MAX_BYTES) {
        return { ok: false, error: `文件超过 ${TORRA_UI_FRAME_MAX_BYTES / 1024}KB` }
      }
      return { ok: true, value: readFileSync(abs, 'utf8') }
    } catch {
      return { ok: false, error: `读不到文件：${rel}` }
    }
  }

  /** 工具出口：清单声明了、插件也实现了的才算数；只注册不实现等于给模型一个必炸的工具 */
  toolSpecs(): PluginToolSpec[] {
    const out: PluginToolSpec[] = []
    for (const [id, entry] of this.entries) {
      if (this.state.plugins[id]?.enabled !== true) continue
      const runtime = this.runtimes.get(id)
      if (!runtime || runtime.status !== 'ready') continue
      const registered = new Set(runtime.registeredTools)
      for (const tool of entry.manifest.contributes?.tools ?? []) {
        if (!registered.has(tool.name)) continue
        out.push({
          pluginId: id,
          name: tool.name,
          label: tool.label,
          description: tool.description,
          parameters: tool.parameters,
          invoke: (params) => runtime.invokeTool(tool.name, params),
        })
      }
    }
    return out
  }

  /** 提示词出口：插件启用后模型才能看到它声明的工作方式 */
  promptSections(): string {
    const lines: string[] = []
    for (const [id, entry] of this.entries) {
      if (this.state.plugins[id]?.enabled !== true) continue
      for (const prompt of entry.manifest.contributes?.prompts ?? []) {
        lines.push(`【${entry.manifest.name}·${prompt.title}】\n${prompt.text}`)
      }
      const tools = entry.manifest.contributes?.tools ?? []
      if (tools.length) {
        lines.push(`【${entry.manifest.name}·工具】${tools.map((t) => `${t.name}（${t.label}）`).join('、')}`)
      }
    }
    return lines.join('\n\n')
  }

  dispose(): void {
    for (const runtime of this.runtimes.values()) runtime.stop()
    this.runtimes.clear()
  }
}

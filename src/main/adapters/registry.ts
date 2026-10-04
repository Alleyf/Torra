/**
 * 适配器注册表 —— 声明式 YAML 的加载、校验、热更新与健康自检。
 * 对应 PRD 6.6 / 14。
 *
 * 双目录设计：
 * - builtinDir：随程序分发的适配器，用户不可删（升级时自动覆盖）
 * - userDir：用户自建适配器，位于 userData，重启保留
 * 两者以 id 合并，同 id 时 userDir 优先 —— 允许用户覆盖内置适配器
 * 以适配站点改版，而不必改程序代码。这是「不支持自己配置」的关键缺口。
 */

import { promises as fs, existsSync, watch as fsWatch } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import {
  ADAPTER_STALE_DAYS,
  type AdapterHealth,
  type AdapterRuntime,
  type AdapterSpec,
  type CompletionMode,
} from '../../shared/adapter'

/**
 * send / stop / generating 为可选 —— DeepSeek 这类站点没有独立停止按钮，
 * 强制必填会让用户无法保存一个实际可用的配置。
 */
const REQUIRED_SELECTORS = ['input', 'stream'] as const
const COMPLETION_MODES: CompletionMode[] = [
  'stop_button_hidden',
  'generating_absent',
  'dom_stable',
  'custom',
]

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isDelayPair(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    v[0] >= 0 &&
    v[1] >= v[0]
  )
}

/** 结构校验：拒绝不合规的适配器，避免坏 YAML 拖垮运行时 */
export function validateSpec(raw: unknown): { ok: true; spec: AdapterSpec } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const o = (raw ?? {}) as Record<string, unknown>

  if (!isNonEmptyString(o.id)) errors.push('id 缺失或非法')
  if (!/^[a-z0-9-]+$/.test(String(o.id ?? ''))) errors.push('id 只能包含小写字母、数字与连字符')
  if (!isNonEmptyString(o.name)) errors.push('name 缺失')
  if (o.transport !== 'webview') errors.push('transport 目前仅支持 webview')
  if (!isNonEmptyString(o.entry) || !/^https?:\/\//.test(String(o.entry))) {
    errors.push('entry 必须是 http(s) URL')
  }

  const sel = (o.selectors ?? {}) as Record<string, unknown>
  for (const key of REQUIRED_SELECTORS) {
    if (!isNonEmptyString(sel[key])) errors.push(`selectors.${key} 缺失或非法`)
  }
  for (const key of ['send', 'stop', 'generating'] as const) {
    if (sel[key] !== undefined && sel[key] !== '' && !isNonEmptyString(sel[key])) {
      errors.push(`selectors.${key} 若提供则必须是非空字符串`)
    }
  }

  const comp = (o.completion ?? {}) as Record<string, unknown>
  if (!COMPLETION_MODES.includes(String(comp.mode) as CompletionMode)) {
    errors.push(`completion.mode 非法（可选：${COMPLETION_MODES.join(' / ')}）`)
  }
  if (typeof comp.timeout_s !== 'number' || comp.timeout_s <= 0) {
    errors.push('completion.timeout_s 必须为正数')
  }
  if (comp.stable_ms !== undefined && (typeof comp.stable_ms !== 'number' || comp.stable_ms < 500)) {
    errors.push('completion.stable_ms 若提供则需 >= 500')
  }

  const auto = (o.automation ?? {}) as Record<string, unknown>
  if (!isDelayPair(auto.typing_delay_ms)) errors.push('automation.typing_delay_ms 必须为 [min, max] 且 min<=max')
  if (!isDelayPair(auto.pre_send_pause_ms)) errors.push('automation.pre_send_pause_ms 必须为 [min, max] 且 min<=max')
  if (typeof auto.max_wait_s !== 'number' || auto.max_wait_s <= 0) errors.push('automation.max_wait_s 必须为正数')
  if (typeof auto.jitter !== 'boolean') errors.push('automation.jitter 必须为布尔值')

  if (!isNonEmptyString(o.health_probe)) errors.push('health_probe 缺失或非法')
  if (!isNonEmptyString(o.verified_at)) errors.push('verified_at 缺失（用于新鲜度提示）')
  if (o.prewarm !== undefined && typeof o.prewarm !== 'boolean') {
    errors.push('prewarm 若提供则必须为布尔值')
  }

  if (o.input_kind !== undefined && !['textarea', 'contenteditable'].includes(String(o.input_kind))) {
    errors.push('input_kind 非法（可选：textarea / contenteditable）')
  }
  if (o.send_mode !== undefined && !['click', 'enter'].includes(String(o.send_mode))) {
    errors.push('send_mode 非法（可选：click / enter）')
  }
  if (o.stream_mode !== undefined && !['last', 'all'].includes(String(o.stream_mode))) {
    errors.push('stream_mode 非法（可选：last / all）')
  }

  /**
   * 交叉校验：声明的完成判定方式必须真的有对应选择器。
   * 否则运行时会静默降级到 dom_stable，而用户以为自己配的是 stop 判定 ——
   * 这种「配了但不生效」的静默失效比直接报错更难排查。
   */
  const mode = String(comp.mode)
  if (mode === 'stop_button_hidden' && !isNonEmptyString(sel.stop)) {
    errors.push('completion.mode=stop_button_hidden 但未提供 selectors.stop')
  }
  if (mode === 'generating_absent' && !isNonEmptyString(sel.generating)) {
    errors.push('completion.mode=generating_absent 但未提供 selectors.generating')
  }
  if (o.send_mode === 'click' && !isNonEmptyString(sel.send)) {
    errors.push('send_mode=click 但未提供 selectors.send（可改为 send_mode: enter）')
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, spec: raw as AdapterSpec }
}

export class AdapterRegistry {
  private runtimes = new Map<string, AdapterRuntime>()
  /** 文件名 → 适配器 id，用于把目录里的删除事件映射回注册项 */
  private idByFile = new Map<string, string>()
  private watchers: Array<() => void> = []
  private listeners = new Set<(adapterId: string) => void>()

  /**
   * @param builtinDir 随程序分发的适配器目录（只读语义，用户不可删）
   * @param userDir    用户自建适配器目录（userData 下）。同 id 时覆盖内置。
   */
  constructor(
    private readonly builtinDir: string,
    private readonly userDir?: string,
  ) {}

  private allDirs(): string[] {
    return [this.builtinDir, this.userDir].filter(Boolean) as string[]
  }

  async loadAll(): Promise<void> {
    this.runtimes.clear()
    this.idByFile.clear()
    await this.resync()
  }

  /**
   * 目录重扫。fs.watch 在 Windows 上常把 filename 报成目录自身的 \\?\ 长路径而不是子文件名，
   * 按扩展名过滤会整批漏掉事件（删除尤其明显），所以事件只当作「有变化」信号，统一走重扫。
   * 未变化的文件由 loadFile 的 spec 比对短路，不会触发多余回调。
   */
  private async resync(): Promise<void> {
    // 先内置后用户：同 id 时用户配置覆盖内置，允许用户适配站点改版
    for (const dir of this.allDirs()) {
      let files: string[] = []
      try {
        await fs.mkdir(dir, { recursive: true })
        files = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const f of files.sort()) {
        if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue
        await this.loadFile(path.join(dir, f))
      }
    }
    for (const key of [...this.idByFile.keys()]) {
      if (!existsSync(key)) this.unloadKey(key)
    }
  }

  private async loadFile(file: string): Promise<AdapterRuntime | null> {
    let raw: unknown
    try {
      raw = YAML.parse(await fs.readFile(file, 'utf8'))
    } catch (e) {
      console.error(`[adapter] 读取 ${path.basename(file)} 失败:`, (e as Error).message)
      return null
    }
    const result = validateSpec(raw)
    if (!result.ok) {
      console.error(`[adapter] ${path.basename(file)} 校验失败:`, result.errors.join('; '))
      return null
    }

    const isUser = !!this.userDir && path.resolve(path.dirname(file)) === path.resolve(this.userDir)
    const spec: AdapterSpec = { ...result.spec, origin: isUser ? 'user' : 'builtin' }
    this.idByFile.set(this.fileKey(file), spec.id)

    const prev = this.runtimes.get(spec.id)
    if (prev) {
      if (JSON.stringify({ ...prev.spec, origin: undefined }) === JSON.stringify({ ...spec, origin: undefined })) {
        return prev
      }
      // 原地替换而非换新对象：agent 与 pool 条目持有的是同一引用，
      // 换对象会让它们一直用旧 spec（改了选择器却不生效）
      prev.spec = spec
      prev.health = 'unknown'
      prev.lastCheckedAt = 0
      delete prev.lastError
      this.emitChanged(spec.id)
      return prev
    }

    const rt: AdapterRuntime = { spec, health: 'unknown', lastCheckedAt: 0 }
    this.runtimes.set(rt.spec.id, rt)
    this.emitChanged(rt.spec.id)
    return rt
  }

  /** 摘除磁盘上已不存在的适配器 */
  private unloadKey(key: string): void {
    const id = this.idByFile.get(key)
    if (!id) return
    this.idByFile.delete(key)
    if ([...this.idByFile.values()].includes(id)) return
    // 内置适配器被移除时不真正摘除：它是程序资源，用户误删不应导致能力消失
    if (this.runtimes.get(id)?.spec.origin === 'builtin') return
    if (this.runtimes.delete(id)) this.emitChanged(id)
  }

  /** 用完整路径做键：同名文件可能同时存在于内置与用户目录，只按 basename 会互相覆盖 */
  private fileKey(file: string): string {
    return path.resolve(file).toLowerCase()
  }

  /** 热更新：新增或覆盖单个适配器 */
  async reload(id: string): Promise<boolean> {
    // 用户目录优先，与 loadAll 的覆盖顺序一致
    for (const dir of [...this.allDirs()].reverse()) {
      const file = path.join(dir, `${id}.yaml`)
      if (existsSync(file)) return (await this.loadFile(file)) !== null
    }
    return false
  }

  // -------------------------------------------------------------------------
  // 用户自建适配器（对应「不支持自己配置可选网页 LLM」的修复）
  // -------------------------------------------------------------------------

  /** 新增或覆盖用户适配器。写入 userDir，不触碰内置文件 */
  async saveUser(input: AdapterSpec): Promise<{ ok: boolean; errors?: string[] }> {
    if (!this.userDir) return { ok: false, errors: ['未配置用户适配器目录'] }
    const result = validateSpec(input)
    if (!result.ok) return { ok: false, errors: result.errors }

    await fs.mkdir(this.userDir, { recursive: true })
    const file = path.join(this.userDir, `${result.spec.id}.yaml`)
    try {
      const header = '# 由 Torra「网页版模型」配置界面生成，可直接编辑本文件热更新。\n'
      await fs.writeFile(file, header + YAML.stringify(result.spec), 'utf8')
    } catch (e) {
      return { ok: false, errors: [(e as Error).message] }
    }
    await this.loadFile(file)
    return { ok: true }
  }

  /** 删除用户适配器；内置适配器受保护 */
  async removeUser(id: string): Promise<{ ok: boolean; reason?: string }> {
    const rt = this.runtimes.get(id)
    if (!rt) return { ok: false, reason: '适配器不存在' }
    if (rt.spec.origin !== 'user') {
      return { ok: false, reason: '内置适配器不可删除。如需修改请直接编辑 adapters/ 下的 YAML' }
    }
    if (!this.userDir) return { ok: false, reason: '未配置用户适配器目录' }
    try {
      await fs.unlink(path.join(this.userDir, `${id}.yaml`))
    } catch {
      /* 文件可能已不存在 */
    }
    // 重扫而不是只摘除：用户适配器可能遮蔽了同 id 的内置适配器，
    // 删除后要让内置的那份立刻回到注册表里
    await this.resync()
    return { ok: true }
  }

  /** 导出适配器 YAML 文本（供 UI 展示 / 用户备份） */
  getYaml(id: string): string | null {
    const rt = this.runtimes.get(id)
    return rt ? YAML.stringify(rt.spec) : null
  }

  /** 适配器新增/变更/移除时回调，返回取消订阅函数 */
  onChanged(cb: (adapterId: string) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emitChanged(id: string): void {
    for (const cb of this.listeners) {
      try {
        cb(id)
      } catch (e) {
        console.error('[adapter] 变更回调异常:', (e as Error).message)
      }
    }
  }

  /** 监听适配器目录变化，实现热更新（PRD 6.6） */
  watch(): void {
    for (const dir of this.allDirs()) {
      try {
        let timer: NodeJS.Timeout | null = null
        // 不解析 filename：见 resync 注释，Windows 上它可能是目录自身的长路径
        const w = fsWatch(dir, () => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => void this.resync(), 300)
        })
        this.watchers.push(() => w.close())
      } catch {
        /* 目录监听失败不影响主流程 */
      }
    }
  }

  dispose(): void {
    for (const off of this.watchers) off()
    this.watchers = []
    this.listeners.clear()
  }

  get(id: string): AdapterRuntime | undefined {
    return this.runtimes.get(id)
  }

  list(): AdapterRuntime[] {
    return [...this.runtimes.values()]
  }

  setHealth(id: string, health: AdapterHealth, error?: string): void {
    const rt = this.runtimes.get(id)
    if (!rt) return
    rt.health = health
    rt.lastCheckedAt = Date.now()
    if (error) rt.lastError = error
  }

  /** 距上次成功验证是否已超过阈值（PRD 6.6 新鲜度提示） */
  isStale(id: string): boolean {
    const rt = this.runtimes.get(id)
    if (!rt) return true
    const t = Date.parse(rt.spec.verified_at)
    if (Number.isNaN(t)) return true
    const days = (Date.now() - t) / 86_400_000
    return days > ADAPTER_STALE_DAYS
  }
}

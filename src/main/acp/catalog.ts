/**
 * 目录：可以接进来的外部编码智能体。
 *
 * 为什么要有目录，而不是让用户自己填 command 与 args：
 * 填错一个字符就接不上，填对了但没装还是接不上 —— 而这两种「接不上」各有一句
 * 人话，那句话得由知道这一家的人来写。于是写成代码，而不是每次现填。
 *
 * 两条来源：
 *   - 精选（本文件）：我们自己维护的十几家。启动方式、登录提示、已知的坑都写清，
 *     版本钉死 —— 与注册表里那四家同一套规矩：换了版本，兼容矩阵就要重测。
 *   - 官方目录：https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
 *     运行时拉。那边有四十来家，图标与启动规格都是各家自己交的。
 *
 * 一条铁律：Torra 不替用户装任何东西。
 * 目录只做两件事 —— 认出本机已经有的那一份（复用它），以及没装时给出一行确切命令。
 * 装不装、什么时候装，是用户的事；Torra 越俎代庖的那一步，用户就再也说不清
 * 「到底是谁装的」。
 *
 * 精选那十一条的每一行启动规格都有出处（厂商文档、官方 ACP 目录、或包自己的
 * README）；没核过的那家就不写进去 —— 宁可少一家，不给一家「照着做还是接不上」的。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AcpCatalogItem, AcpOfficialCatalog } from '../../shared/acp'

/** 官方目录的地址（Zed 与 JetBrains 共建的那份） */
export const OFFICIAL_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
/** 官方图标的地址前缀 */
export const OFFICIAL_ICON_BASE = 'https://cdn.agentclientprotocol.com/registry/v1/latest/'

/**
 * 精选目录。
 *
 * 每一条都照着厂商自己的文档写：启动命令、装它的那一行、怎么登录、有什么坑。
 * 写错的最坏后果是「接不上」，不会伤到用户的数据 —— 但也别把没核过的东西写进来，
 * 没核过的就留空，别猜。
 */
export interface CuratedSpec {
  id: string
  title: string
  vendor: string
  blurb: string
  /** 复用本机已有那一份时的启动命令 */
  command: string
  /**
   * 备选命令名。
   *
   * 有些包装完落下好几个入口（Qoder 落下 qoder 与 qodercli，CodeBuddy 落下
   * codebuddy 与 cbc），用户敲哪个都能用 —— 认的时候都得试。
   */
  altCommands?: string[]
  args: string[]
  /** npm 包（版本钉死） */
  package?: { name: string; version: string }
  /** 没装时给用户的那一行 */
  install: string
  /**
   * 换平台时给的那一行。
   *
   * 有些厂商的安装器按平台分家（Cursor 就是：Windows 走 irm，mac/linux 走 curl），
   * 把 Windows 的那行抄给 mac 用户，等于给了一行跑不通的东西。
   */
  installAlt?: string
  /** 备用：不装全局包，用 npx 临时跑 */
  npx?: { package: string; args: string[] }
  /**
   * 官方目录里的那个 id —— 图标按它取。
   *
   * 同一家在两边的叫法常常不一样（WorkBuddy 在官方目录里叫 codebuddy-code），
   * 记着这个，图标才是各家自己那一枚，而不是字母牌。
   */
  iconId?: string
  authHint?: string
  notes: string[]
}

export const CURATED_CATALOG: CuratedSpec[] = [
  {
    id: 'dsh',
    title: 'DeepSeek Harness',
    vendor: 'DeepSeek',
    blurb: 'DeepSeek 开源的智能体运行时，它那侧的 ACP 服务端',
    command: 'dsh-acp-demo',
    args: [],
    package: { name: '@deepseek-ai/dsh-acp-demo', version: '0.0.1-rc.1' },
    install: 'npm i -g @deepseek-ai/dsh-acp-demo@0.0.1-rc.1',
    npx: { package: '@deepseek-ai/dsh-acp-demo@0.0.1-rc.1', args: [] },
    authHint: 'provider 与 model 在 dsh 自己那份配置里给，没配过就起不来',
    notes: [
      '官方仓库里的 ACP 服务端是 @deepseek-ai/dsh-acp（仓库内用 pnpm dsh --profile acp 起）；npm 上能直接装的是这个 demo 包，命令是 dsh-acp-demo',
      '这一版还是 rc：协议通了不代表功能齐，接之前先预检',
    ],
  },
  {
    id: 'qodercn',
    title: 'Qoder CLI CN',
    vendor: 'Qoder',
    blurb: 'Qoder 的国内版命令行助手，自带 ACP 入口',
    command: 'qodercn',
    altCommands: ['qoderclicn'],
    args: ['--acp'],
    package: { name: '@qodercn-ai/qoderclicn', version: '1.1.81' },
    install: 'npm i -g @qodercn-ai/qoderclicn@1.1.81',
    npx: { package: '@qodercn-ai/qoderclicn@1.1.81', args: ['--acp'] },
    iconId: 'qoder',
    authHint: '先在终端里 /login 登录（国内站账号）',
    notes: [
      '与国际版 Qoder CLI 不是同一个账号体系，别混着登',
      '官方 ACP 目录登记的是国际版那一支（开关 --acp）；CN 包出自同一个仓库，Torra 按同一个开关起它，接之前先预检',
    ],
  },
  {
    id: 'qoder',
    title: 'Qoder CLI',
    vendor: 'Qoder',
    blurb: 'Qoder 国际版命令行助手，官方 ACP 目录登记的开关是 --acp',
    command: 'qodercli',
    altCommands: ['qoder'],
    args: ['--acp'],
    package: { name: '@qoder-ai/qodercli', version: '1.1.81' },
    install: 'npm i -g @qoder-ai/qodercli@1.1.81',
    npx: { package: '@qoder-ai/qodercli@1.1.81', args: ['--acp'] },
    iconId: 'qoder',
    authHint: '先在终端里完成登录',
    notes: ['这个包装完落下 qoder 与 qodercli 两个命令，敲哪个都行'],
  },
  {
    id: 'codebuddy',
    title: 'WorkBuddy CLI',
    vendor: '腾讯云',
    blurb: '腾讯云的命令行编码助手（CodeBuddy Code），原生支持 ACP',
    command: 'codebuddy',
    altCommands: ['cbc', 'codebuddy-code'],
    args: ['--acp'],
    package: { name: '@tencent-ai/codebuddy-code', version: '2.179.1' },
    install: 'npm i -g @tencent-ai/codebuddy-code@2.179.1',
    npx: { package: '@tencent-ai/codebuddy-code@2.179.1', args: ['--acp'] },
    iconId: 'codebuddy-code',
    authHint: '首次启动引导登录；国内站与国际站提供的模型不一样',
    notes: ['桌面那套 WorkBuddy 与它的 CLI 是同一套底座，CLI 的包名是 codebuddy-code'],
  },
  {
    id: 'kimi',
    title: 'Kimi Code CLI',
    vendor: '月之暗面',
    blurb: '月之暗面的命令行编码助手，ACP 入口是 kimi acp',
    command: 'kimi',
    args: ['acp'],
    package: { name: '@moonshot-ai/kimi-code', version: '2.4.1' },
    install: 'npm i -g @moonshot-ai/kimi-code@2.4.1',
    npx: { package: '@moonshot-ai/kimi-code@2.4.1', args: ['acp'] },
    iconId: 'kimi',
    authHint: '先在终端里跑一次 kimi，执行 /login 完成登录',
    notes: [
      '它自己那套 MCP 是另一条路（~/.kimi-code/mcp.json），与 Torra 交出去的工具包不是一回事',
      '官方 ACP 目录给的是二进制分发（kimi-cli），命令行一样是 kimi acp',
    ],
  },
  {
    id: 'gemini',
    title: 'Gemini CLI',
    vendor: 'Google',
    blurb: 'Google 官方的命令行 Gemini，--acp 起 ACP 服务端',
    command: 'gemini',
    args: ['--acp'],
    package: { name: '@google/gemini-cli', version: '0.66.0' },
    install: 'npm i -g @google/gemini-cli@0.66.0',
    npx: { package: '@google/gemini-cli@0.66.0', args: ['--acp'] },
    iconId: 'gemini',
    authHint: '跑一次 gemini 走 OAuth，或者配 GEMINI_API_KEY',
    notes: ['早期的 --experimental-acp 已经废弃，现在的开关是 --acp'],
  },
  {
    id: 'qwen',
    title: 'Qwen Code',
    vendor: '阿里',
    blurb: '通义千问的命令行编码助手，--acp 起 ACP 服务端',
    command: 'qwen',
    args: ['--acp', '--experimental-skills'],
    package: { name: '@qwen-code/qwen-code', version: '0.26.5' },
    install: 'npm i -g @qwen-code/qwen-code@0.26.5',
    npx: { package: '@qwen-code/qwen-code@0.26.5', args: ['--acp', '--experimental-skills'] },
    iconId: 'qwen-code',
    authHint: '先跑一次 qwen 完成登录或配 API Key',
    notes: [
      '官方 ACP 目录登记的参数里带着 --experimental-skills（开 skills）；不要这个能力就去掉它',
    ],
  },
  {
    id: 'trae',
    title: 'TraeCode CLI',
    vendor: '字节',
    blurb: 'Trae 的命令行版本，ACP 服务端的入口是 acp serve',
    command: 'traecli',
    args: ['acp', 'serve'],
    install: 'irm https://trae.cn/trae-cli/install_v2.ps1 | iex',
    authHint: '装好之后在终端里完成登录',
    notes: [
      '它没有 npm 包，只能用它自己的安装器（mac/linux 是 sh -c "$(curl -fsSL https://trae.cn/trae-cli/install_v2.sh)"）',
      '官方文档建议 Windows 上优先用 WSL2；用原生版第一次启动会先做沙箱初始化',
    ],
  },
  {
    id: 'copilot',
    title: 'Copilot CLI',
    vendor: 'GitHub',
    blurb: 'GitHub 的命令行编码助手，--acp 起 ACP 服务端',
    command: 'copilot',
    args: ['--acp'],
    package: { name: '@github/copilot', version: '1.0.105' },
    install: 'npm i -g @github/copilot@1.0.105',
    npx: { package: '@github/copilot@1.0.105', args: ['--acp'] },
    iconId: 'github-copilot-cli',
    authHint: '跑一次 copilot 走 GitHub 账号登录',
    notes: ['它能不能把 Torra 的工具包接过去，要预检才知道 —— 别先假定'],
  },
  {
    id: 'cursor',
    title: 'Cursor Agent',
    vendor: 'Cursor',
    blurb: 'Cursor 的命令行 agent，acp 子命令起 ACP 服务端',
    command: 'cursor-agent',
    args: ['acp'],
    iconId: 'cursor',
    install: "irm 'https://cursor.com/install?win32=true' | iex",
    installAlt: 'curl https://cursor.com/install -fsS | bash',
    authHint: '装好之后在终端里完成登录',
    notes: ['官方 ACP 目录里它是二进制分发，不走 npm'],
  },
  {
    id: 'kilo',
    title: 'Kilo Code',
    vendor: 'Kilo',
    blurb: '开源的编码助手，acp 子命令起 ACP 服务端',
    command: 'kilo',
    altCommands: ['kilocode'],
    args: ['acp'],
    package: { name: '@kilocode/cli', version: '7.8.18' },
    install: 'npm i -g @kilocode/cli@7.8.18',
    npx: { package: '@kilocode/cli@7.8.18', args: ['acp'] },
    iconId: 'kilo',
    authHint: '按它自己的配置登录或配模型',
    notes: [],
  },
]

/**
 * 官方目录的 id → Torra 注册表用的 id。
 *
 * 同一家的两种叫法：官方目录叫「claude-acp」，Torra 内置那一条叫「claude」。
 * 不映射的话，用户从官方目录接一次 Claude，工作台里会同时出现两条 Claude。
 */
export const OFFICIAL_ID_TO_TORRA_ID: Record<string, string> = {
  'claude-acp': 'claude',
  'codex-acp': 'codex',
  'pi-acp': 'pi',
  'opencode-v2': 'opencode',
  'codebuddy-code': 'codebuddy',
  'github-copilot-cli': 'copilot',
  'qwen-code': 'qwen',
  'gemini': 'gemini',
  kimi: 'kimi',
  qoder: 'qoder',
  cursor: 'cursor',
  kilo: 'kilo',
}

/**
 * 在 PATH 上找一个命令。
 *
 * 「装没装」这件事只按这一条判：命令在不在 PATH 上。
 * 因为启动规格就是按命令名拼的 —— 不在 PATH 上，Torra 起它也一样起不来；
 * 装在某个 PATH 之外的角落里，用户自己敲命令能用、Torra 却用不了，那不叫装了。
 */
export function findOnPath(cmd: string): string | undefined {
  if (!cmd || /[\\/]/.test(cmd)) return undefined
  const pathEnv = process.env.PATH ?? ''
  const dirs = pathEnv.split(path.delimiter).filter(Boolean)
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {
        // 目录读不了就当它没有：PATH 上偶尔会有指向网络盘的坏路径
      }
    }
    // Windows 上 npm 的全局命令是 cmd.cmd，PATHEXT 里已经有；但有些工具只落了无扩展名那个
    const bare = path.join(dir, cmd)
    try {
      if (fs.existsSync(bare) && fs.statSync(bare).isFile()) return bare
    } catch {
      // 同上
    }
  }
  return undefined
}

/**
 * 这一家在本机是哪个命令。
 *
 * 有些包装完落下好几个入口，用户敲哪个都行 —— 认的时候都得试，
 * 而且要用找到的那个去起，不能拿首选那个去撞。
 */
export function resolveCommand(spec: { command: string; altCommands?: string[] }): {
  command: string
  path?: string
} {
  const names = [spec.command, ...(spec.altCommands ?? [])]
  for (const name of names) {
    const found = findOnPath(name)
    if (found) return { command: name, path: found }
  }
  return { command: spec.command }
}

/** 把精选目录变成界面要的形状：每一条都说清本机有没有装 */
export function curatedView(): AcpCatalogItem[] {
  return CURATED_CATALOG.map((spec) => {
    const resolved = resolveCommand(spec)
    // 安装那行按平台挑：Windows 上给 irm，别的平台给 curl。
    // 抄错平台的那行，用户粘到终端里跑不通，比不给还坏。
    const install = process.platform === 'win32' ? spec.install : (spec.installAlt ?? spec.install)
    return {
      id: spec.id,
      title: spec.title,
      vendor: spec.vendor,
      blurb: spec.blurb,
      command: resolved.command,
      args: spec.args,
      mode: 'local' as const,
      install,
      package: spec.package,
      npx: spec.npx,
      authHint: spec.authHint,
      notes: spec.notes,
      origin: 'curated' as const,
      installed: !!resolved.path,
      iconId: spec.iconId,
      presence: resolved.path
        ? `本机已有：${resolved.path}`
        : `本机没装这一份（装它：${install}）`,
    }
  })
}

/**
 * 把「包名@版本」拆成包名与版本。
 *
 * 拆不出版本就只给包名 —— 注册表那层的校验要求版本号是规规矩矩的一串，
 * 硬塞一个不合规的进去会挡住整次添加，而版本本来就只是给人看的。
 */
export function splitPkgVersion(spec: string): { name: string; version?: string } {
  const trimmed = spec.trim()
  if (!trimmed) return { name: '' }
  const at = trimmed.lastIndexOf('@')
  if (at <= 0) return { name: trimmed }
  const name = trimmed.slice(0, at)
  const version = trimmed.slice(at + 1)
  if (!/^[0-9][0-9A-Za-z.\-+]{0,40}$/.test(version)) return { name: trimmed }
  return { name, version }
}

/**
 * 当前平台在官方目录里的键名。
 *
 * 官方目录用的是它自己的一套平台词：windows / darwin / linux。
 * Node 那边的 process.platform 在 Windows 上叫 win32 —— 直接拼出来
 * 的是 win32-x86_64，官方目录里没有这个键，于是 Windows 上每一家
 * 二进制分发的官方 agent 都会被误判成「这一版没有安装包」。
 *
 * 所以这里要翻译一次：认得的那几个键原样用，不认得的宁可给不出，
 * 也不能给一个官方目录里不存在的键。
 */
export function platformKey(): string {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
  const os = process.platform === 'win32' ? 'windows' : process.platform
  return `${os}-${arch}`
}

/** 二进制分发里那条命令的名字（去掉路径与可执行后缀） */
function binaryCmdName(cmd: string): string {
  const base = path.basename(cmd.replace(/\\/g, '/'))
  return base.replace(/\.(cmd|exe|bat|ps1)$/i, '')
}

/**
 * 把官方目录的一条翻译成目录项。
 *
 * 官方给的启动方式有两种：
 *   - npx：包 + 参数。Torra 走 npx 临时跑（第一次会把这个包下下来，不写全局环境）
 *   - binary：按平台给一个二进制 + 参数。Torra 只认命令名 —— 命令在 PATH 上才接得上
 *
 * 两种都有时先看本机：装了就复用装的那一份（那是用户自己的东西），
 * 没装才退回 npx 那条路。
 */
export function officialItem(raw: unknown): AcpCatalogItem | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const a = raw as Record<string, unknown>
  const id = String(a.id ?? '').trim()
  if (!id) return undefined
  const title = String(a.name ?? id).trim()
  const version = String(a.version ?? '').trim()
  const blurb = String(a.description ?? '').trim()
  const authors = Array.isArray(a.authors) ? a.authors.map((x) => String(x)) : []
  const vendor = authors[0]?.trim() ?? ''
  const dist = (a.distribution ?? {}) as Record<string, unknown>
  const npxRaw = dist.npx as { package?: string; args?: string[] } | undefined
  const binRaw = dist.binary as Record<string, { cmd?: string; args?: string[]; archive?: string }> | undefined

  const base = {
    id,
    title,
    vendor,
    blurb: blurb || `${title}（官方目录登记的一家）`,
    notes: [] as string[],
    origin: 'official' as const,
    iconUrl: typeof a.icon === 'string' ? a.icon : `${OFFICIAL_ICON_BASE}${id}.svg`,
    // 官方目录的图标按它自己的 id 存：<前缀>/<id>.svg
    iconId: id,
  }
  const versionNote = version ? [`官方目录登记的版本：${version}`] : []

  // 先看二进制那份：本机装了它，就该用它
  const key = platformKey()
  const hit = binRaw?.[key]
  if (hit?.cmd) {
    const cmdName = binaryCmdName(hit.cmd)
    const args = Array.isArray(hit.args) ? hit.args.map((x) => String(x)) : []
    const found = findOnPath(cmdName)
    if (found) {
      return {
        ...base,
        command: cmdName,
        args,
        mode: 'local',
        install: hit.archive ? `官方安装包：${hit.archive}` : '',
        presence: `本机已有：${found}`,
        installed: true,
        notes: versionNote,
      }
    }
    // 没装：若官方同时给了 npm 包，那条路更省事
    if (npxRaw?.package) {
      const pkg = npxRaw.package
      const npxArgs = Array.isArray(npxRaw.args) ? npxRaw.args.map((x) => String(x)) : []
      const split = splitPkgVersion(pkg)
      return {
        ...base,
        command: 'npx',
        args: ['-y', pkg, ...npxArgs],
        mode: 'npx',
        install: `npm i -g ${pkg}`,
        package: split.version ? { name: split.name, version: split.version } : undefined,
        npx: { package: pkg, args: npxArgs },
        presence: 'npx 方式：第一次用会把这个包装下来（不写进你的全局环境）',
        installed: true,
        notes: versionNote,
      }
    }
    return {
      ...base,
      command: cmdName,
      args,
      mode: 'local',
      install: hit.archive ? `官方安装包：${hit.archive}` : '',
      presence: '本机没装这一份',
      installed: false,
      notes: versionNote,
    }
  }

  if (npxRaw?.package) {
    const pkg = npxRaw.package
    const npxArgs = Array.isArray(npxRaw.args) ? npxRaw.args.map((x) => String(x)) : []
    const split = splitPkgVersion(pkg)
    return {
      ...base,
      command: 'npx',
      args: ['-y', pkg, ...npxArgs],
      mode: 'npx',
      install: `npm i -g ${pkg}`,
      package: split.version ? { name: split.name, version: split.version } : undefined,
      npx: { package: pkg, args: npxArgs },
      presence: 'npx 方式：第一次用会把这个包装下来（不写进你的全局环境）',
      installed: true,
      notes: versionNote,
    }
  }

  if (binRaw) {
    return {
      ...base,
      command: '',
      args: [],
      mode: 'local',
      install: '',
      presence: '',
      installed: false,
      unsupported: `官方目录没有给 ${key} 这一版的安装包`,
      notes: versionNote,
    }
  }

  return {
    ...base,
    command: '',
    args: [],
    mode: 'local',
    install: '',
    presence: '',
    installed: false,
    unsupported: '官方目录没给启动方式',
    notes: versionNote,
  }
}

/** 官方目录里那一串条目 → 目录项 */
export function parseOfficialRegistry(payload: unknown): AcpCatalogItem[] {
  const list =
    payload && typeof payload === 'object'
      ? ((payload as Record<string, unknown>).agents as unknown[])
      : Array.isArray(payload)
        ? payload
        : []
  if (!Array.isArray(list)) return []
  const out: AcpCatalogItem[] = []
  for (const raw of list) {
    const item = officialItem(raw)
    if (item) out.push(item)
  }
  return out
}

/** 目录缓存落在哪儿（断网时用上一次拉到的） */
export function officialCachePath(userDataDir: string): string {
  return path.join(userDataDir, 'torra', 'acp-registry.json')
}

/** 官方图标缓存落在哪儿 */
export function iconCacheDir(userDataDir: string): string {
  return path.join(userDataDir, 'torra', 'acp-icons')
}

/**
 * 拉官方目录。
 *
 * 拉到了就落盘一份，断网时还能看上一次的结果 —— 但界面上要写清「这是上次拉的」，
 * 拿旧目录当新的报给用户，比不报更坏。
 */
export async function fetchOfficialCatalog(
  userDataDir: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<AcpOfficialCatalog> {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 20000
  try {
    const res = await doFetch(OFFICIAL_REGISTRY_URL, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) {
      return { ...readCachedOfficial(userDataDir), fetched: false, error: `官方目录没拉下来（HTTP ${res.status}）` }
    }
    const payload = (await res.json()) as unknown
    const items = parseOfficialRegistry(payload)
    const view: AcpOfficialCatalog = {
      fetched: true,
      fetchedAt: Date.now(),
      source: OFFICIAL_REGISTRY_URL,
      items,
    }
    try {
      const file = officialCachePath(userDataDir)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(view, null, 2), 'utf8')
    } catch {
      // 缓存写不下去不影响这一轮：这一轮的数据已经在手里了
    }
    return view
  } catch (e) {
    const cached = readCachedOfficial(userDataDir)
    return {
      ...cached,
      fetched: false,
      error: `官方目录没拉下来：${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/** 读上一次拉到的官方目录（只读缓存，不联网） */
export function readCachedOfficial(userDataDir: string): AcpOfficialCatalog {
  try {
    const file = officialCachePath(userDataDir)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AcpOfficialCatalog
    if (!parsed || !Array.isArray(parsed.items)) return { fetched: false, items: [] }
    return { ...parsed, fetched: false }
  } catch {
    return { fetched: false, items: [] }
  }
}

/**
 * 取官方图标，取回后以 data URI 交给界面。
 *
 * 为什么不让界面直接引 CDN 的地址：渲染层的 CSP 只放行了几个固定的图床，
 * 加一条白名单就能放行官方 CDN —— 但那等于让任何页面都能从那儿取图。
 * 主进程取回来再给界面，图就只可能是官方目录里那一张。
 */
export async function fetchOfficialIcon(
  userDataDir: string,
  id: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ ok: true; dataUrl: string } | { ok: false; reason: string }> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return { ok: false, reason: '标识不合法' }
  const dir = iconCacheDir(userDataDir)
  const file = path.join(dir, `${id}.svg`)
  try {
    const cached = fs.readFileSync(file, 'utf8')
    if (cached.trim()) return { ok: true, dataUrl: svgToDataUrl(cached) }
  } catch {
    // 没缓存：往下走，去取
  }
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(`${OFFICIAL_ICON_BASE}${id}.svg`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) })
    if (!res.ok) return { ok: false, reason: `官方图标没取到（HTTP ${res.status}）` }
    const text = await res.text()
    if (!text.includes('<svg')) return { ok: false, reason: '官方图标不是一份 SVG' }
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, text, 'utf8')
    } catch {
      // 存不下就只这一次用完算
    }
    return { ok: true, dataUrl: svgToDataUrl(text) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** SVG → data URI（界面直接拿它当 img 的 src） */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

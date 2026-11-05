/**
 * 找一个**真的能跑**的 bash。
 *
 * pi SDK 自己在 win32 上按「两个固定 Git 路径 → where bash.exe 第一个命中」挑 shell
 * （`node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js` 的 getShellConfig）。
 * 那条路在本机踩到 `C:\Windows\System32\bash.exe` —— WSL 的转发 stub：文件在、能 spawn，
 * 但执行任何命令都吐一段 WSL 安装指引并 exit 1。于是助手每条终端命令都以那句提示失败，
 * 用户看到的就是「助手没法执行命令」，而批准卡片明明放行了。
 *
 * 这里自己挑：候选来自注册表（Git for Windows 安装器写的 InstallPath）、常见固定位置
 * 和 PATH，再逐个**真跑一次**，只认 exit 0 的那个。找不到就返回 null，让 SDK 走它自己
 * 的路径并在出错时给出它那份指引 —— 不猜、不硬填一个跑不动的路径。
 *
 * 为什么光看 PATH 不够：GUI 应用（Electron）继承的是注册表里的系统 PATH，而 Git for
 * Windows 只往 PATH 写 `\<root>\cmd`（里面只有 git.exe）—— bin\ 下的 bash.exe 不在
 * 系统 PATH 上，只有在 Git Bash 里启动的进程才会被它自己的 PATH 前置骗到。所以注册表
 * InstallPath 是主力（HKLM/HKCU 各一把，含 WOW6432Node），PATH 只做兜底。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 探针：跑得通就说明这个 shell 能用。用 -c 而不是 -s，Git Bash 与 MSYS2 都认 */
const PROBE_ARGS = ['-c', 'echo __torra_bash_ok']

/** 探针超时：一个坏 stub 可能挂在 WSL 初始化上，不能让它拖住装配 */
const PROBE_TIMEOUT_MS = 5_000

/** 注册表查询超时：reg.exe 是本地二进制，正常几十毫秒；挂了就当没这条来源 */
const REG_TIMEOUT_MS = 3_000

/** Git for Windows 安装器写 InstallPath 的位置：HKLM/HKCU 各一把，含 WOW6432Node */
const GIT_REG_KEYS = [
  'HKLM\\SOFTWARE\\GitForWindows',
  'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows',
  'HKCU\\SOFTWARE\\GitForWindows',
  'HKCU\\SOFTWARE\\WOW6432Node\\GitForWindows',
] as const

/** 从 `reg query` 输出里抠出 InstallPath 的值；格式不认识就返回 null */
export function parseRegInstallPath(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/\bInstallPath\b\s+REG_SZ\s+(.+?)\s*$/)
    if (m) return m[1] ?? null
  }
  return null
}

/** 查一条注册表键；查不到/超时都返回 null 不抛 —— 候选来源缺一条不算错误 */
function readGitInstallPath(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', key, '/v', 'InstallPath'],
      { windowsHide: true, timeout: REG_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : parseRegInstallPath(String(stdout ?? ''))),
    )
  })
}

/**
 * 不依赖注册表的候选：常见固定位置 + PATH。
 *
 * PATH 里 `\cmd` 结尾的目录还要补一个同根的 `\bin`：Git 安装器和 scoop 往 PATH 写的
 * 都是 `\<root>\cmd`（只有 git.exe），bash.exe 在同根的 `\<root>\bin` 里。
 */
export function collectCandidates(env: NodeJS.ProcessEnv, win = process.platform === 'win32'): string[] {
  if (!win) return []
  const out: string[] = []
  const push = (p: string | undefined) => {
    if (p) out.push(p)
  }
  const bases = [env.ProgramFiles, env['ProgramFiles(x86)']]
  if (env.LocalAppData) bases.push(join(env.LocalAppData, 'Programs'))
  for (const base of bases) {
    if (!base) continue
    push(join(base, 'Git', 'bin', 'bash.exe'))
    push(join(base, 'Git', 'usr', 'bin', 'bash.exe'))
  }
  for (const dir of (env.PATH ?? '').split(';')) {
    if (!dir) continue
    push(join(dir, 'bash.exe'))
    if (/\\cmd\\?$/i.test(dir)) push(join(dir, '..', 'bin', 'bash.exe'))
  }
  return [...new Set(out)]
}

/** 单个候选真跑一次：exit 0 才算能用 */
function probe(p: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      p,
      PROBE_ARGS,
      { windowsHide: true, timeout: PROBE_TIMEOUT_MS },
      (err) => resolve(!err),
    )
  })
}

/** 解析结果：路径（null 表示没找到可用的）+ 为什么没找到，供诊断如实记录 */
export interface BashShellResolution {
  path: string | null
  /** 试过的候选与各自的结局，写给诊断日志用 */
  tried: Array<{ path: string; ok: boolean }>
}

/** System32 下的 bash.exe 是 WSL 的转发 stub：文件在、能 spawn，但排在前面只会白等。
 *  纯函数，导出供测试钉住排序不变量 */
export function demoteSystemStub(list: string[], env: NodeJS.ProcessEnv): string[] {
  const system32 = join(env.SystemRoot ?? 'C:\\Windows', 'System32').toLowerCase()
  return [
    ...list.filter((p) => !p.toLowerCase().startsWith(system32)),
    ...list.filter((p) => p.toLowerCase().startsWith(system32)),
  ]
}

/**
 * 解析 bash 路径。`inject` 仅供测试：候选与探针都可替换，不碰真实磁盘与注册表。
 */
export async function resolveBashShell(
  inject?: { candidates?: readonly string[]; probe?: (p: string) => Promise<boolean> },
): Promise<BashShellResolution> {
  const run = inject?.probe ?? probe
  let list: readonly string[]
  if (inject?.candidates) {
    list = demoteSystemStub([...inject.candidates], process.env)
  } else {
    if (process.platform !== 'win32') return { path: null, tried: [] }
    const roots = (
      await Promise.all(GIT_REG_KEYS.map((key) => readGitInstallPath(key)))
    ).filter((r): r is string => !!r)
    const fromRegistry = roots.flatMap((root) => [
      join(root, 'bin', 'bash.exe'),
      join(root, 'usr', 'bin', 'bash.exe'),
    ])
    list = demoteSystemStub(
      [...new Set([...fromRegistry, ...collectCandidates(process.env)])].filter(existsSync),
      process.env,
    )
  }
  const tried: Array<{ path: string; ok: boolean }> = []
  for (const p of list) {
    // 候选可能重复（注册表与 PATH 指向同一份安装）：同一个路径只验一次
    if (tried.some((t) => t.path === p)) continue
    const ok = await run(p)
    tried.push({ path: p, ok })
    if (ok) return { path: p, tried }
  }
  return { path: null, tried }
}

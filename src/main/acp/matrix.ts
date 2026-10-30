/**
 * 兼容矩阵：把「接得上」从一句承诺换成一张能核对的表。
 *
 * 为什么要有这张表：ACP 是标准，但标准只管方法名与消息形状。它不管
 *   - agent 会不会回来要授权（有的直接自己干了）；
 *   - agent 收不收 http 形态的 MCP（实测 pi-acp 压根不读 mcpServers）；
 *   - agent 的「模式」是什么含义（claude 是权限、codex 是沙箱档、pi 是思考档）。
 * 这三件事只能一家一家试出来。而「兼容性能不能被测出来，而不是被承诺」，
 * 就是说这句话得有一张表顶着。
 *
 * 表的键是「id + 版本」：适配器包跟着上游走，用户本机随时可能 npm update 到别的版本，
 * 换了版本这一格就不再作数 —— 界面于是会说「这一版还没验过」，而不是拿旧结果糊弄。
 *
 * 数据从哪来：`npm run test:acp -- --live --write-matrix`。那一段对着真的
 * Claude Code / Codex / pi / OpenCode 跑完整往返，把结果写回 matrix-data.json。
 * 写回来的是机器读的结果，不是一段散文。
 *
 * 数据文件为什么叫 matrix-data.json 而不是 matrix.json：Node 解析无扩展名的
 * require 时，.json 排在 ts-node 注册的 .ts 前面 —— `require('./matrix')` 会
 * 拿 JSON 而不是这个模块，于是 matrixStatus 变成 undefined，报错还长得像
 * 「函数不存在」。名字错开一点，这个坑就绕开了。
 */
import matrixJson from './matrix-data.json'
import type { AcpAgentEntry, AcpMatrixCell, AcpMatrixStatus } from '../../shared/acp'

/** matrix-data.json 的形状 */
interface MatrixFile {
  generatedBy?: string
  note?: string
  cells?: unknown
}

const file = matrixJson as MatrixFile

/** 从 JSON 里读出格子；坏掉的格子丢掉，不让整个矩阵塌掉 */
function readCells(): AcpMatrixCell[] {
  const list = Array.isArray(file.cells) ? file.cells : []
  const out: AcpMatrixCell[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const c = raw as Record<string, unknown>
    const id = String(c.id ?? '')
    const version = String(c.version ?? '')
    if (!id || !version) continue
    const bool = (v: unknown): boolean => v === true
    const notes = Array.isArray(c.notes) ? c.notes.map((n) => String(n).slice(0, 300)) : []
    out.push({
      id,
      version,
      agentVersion: c.agentVersion ? String(c.agentVersion).slice(0, 60) : undefined,
      checkedAt: String(c.checkedAt ?? ''),
      handshake: bool(c.handshake),
      session: bool(c.session),
      prompt: bool(c.prompt),
      cancel: bool(c.cancel),
      permission: bool(c.permission),
      toolPack: bool(c.toolPack),
      full: c.full === true,
      notes,
    })
  }
  return out
}

/** 整张表 */
export function matrixCells(): AcpMatrixCell[] {
  return readCells()
}

/**
 * 一家对得上的那一格。
 *
 * 版本对不上就当没测过 —— 拿上一版的结论替这一版背书，比不测更坏。
 *
 * 自带入口的那一家（opencode）没有适配器包可钉，键写 'self'；
 * 它的真实版本由 agent 自报，记在格子的 agentVersion 里 ——
 * 离线时拿不到那个版本，所以版本漂了要靠用户自己发现，而不是靠 Torra 拦。
 */
export function matrixCell(entry: AcpAgentEntry): AcpMatrixCell | undefined {
  const want = entry.package?.version ?? 'self'
  return matrixCells().find((c) => c.id === entry.id && c.version === want)
}

/**
 * 这一家在界面上的验过状态。
 *
 * 用户自己加的条目永远没有格子：Torra 没测过它，也不该假装测过。
 * 这时候给一句「自家接入，未验」比给一个绿灯诚实。
 */
export function matrixStatus(entry: AcpAgentEntry): AcpMatrixStatus {
  if (entry.source === 'user') {
    return {
      tested: false,
      currentVersionTested: false,
      green: false,
      reason: '自家接入的条目，Torra 没测过',
    }
  }
  const cells = matrixCells()
  const anyVersion = cells.find((c) => c.id === entry.id)
  const cell = matrixCell(entry)
  if (!cell) {
    return {
      tested: false,
      currentVersionTested: false,
      green: false,
      reason: anyVersion
        ? `测过的是 ${anyVersion.version} 这一版，现在钉的是 ${entry.package?.version ?? '（自带入口）'}`
        : '还没测过这一家',
    }
  }
  const green = cell.handshake && cell.session && cell.prompt && cell.cancel
  const missing: string[] = []
  if (!cell.handshake) missing.push('握手')
  if (!cell.session) missing.push('建会话')
  if (!cell.prompt) missing.push('发一轮')
  if (!cell.cancel) missing.push('打断')
  return {
    tested: true,
    currentVersionTested: true,
    green,
    cell,
    // 「没测」和「没过」要分开说：这一轮没花钱去试，和这一家真的不行，
    // 是两回事。混起来就把「没量」写成了「不行」。
    reason: green
      ? undefined
      : cell.full
        ? `${missing.join('、')}这几步没过`
        : `只测到握手与建会话；${missing.join('、')}这几步没测`,
  }
}

/** 矩阵文件头里的话：这份数据是怎么来的 */
export function matrixProvenance(): { generatedBy?: string; note?: string } {
  return { generatedBy: file.generatedBy, note: file.note }
}

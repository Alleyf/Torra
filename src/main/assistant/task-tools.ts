/**
 * 定时任务那一轮的受限工具集。
 *
 * 为什么不是「把完整助手放进后台跑」：完整工具集里有改适配器、删模型、写插件这类动作，
 * 而定时任务到点时没有人在旁边点确认卡片 —— 一张没人看的确认卡不是闸门，是阻塞。
 * 所以后台这一轮只给三样东西：抓一个地址、往任务目录写文件、列任务目录。
 *
 * 这里的写工具**不过确认卡片**：任务的定义（做什么、写到哪个目录）在建任务时已经由用户
 * 在卡片上确认过，之后每一轮写的内容都限定在这个目录里。这不是绕过审批，是把审批
 * 挪到了「定义任务」那一步；目录外的路径一律拒绝。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createFetchTool } from './fetch-url'
import { loadPiSdk, loadTypeBox } from './pi-sdk'

/** 单次写入上限：一个日报/记录不该有 1MB，超了多半是模型把整页 HTML 抄进来了 */
const MAX_WRITE_BYTES = 1_000_000
const MAX_LIST = 200

export const TASK_TOOL_NAMES = ['torra_fetch_url', 'torra_task_write', 'torra_task_list'] as const

export interface TaskToolOptions {
  /** 产出目录（绝对路径）：所有写操作都被限在这里面 */
  outDir: string
  /** 每写成一个文件回传一次，调度器据此记录本次产出 */
  onWrite?: (rel: string) => void
  /** 测试用：替换 fetch */
  fetchImpl?: typeof fetch
}

/**
 * 把用户给的相对路径解析到任务目录里。
 *
 * 只认相对路径：绝对路径、盘符、`..` 越界都直接拒绝。软链接逃逸在 mkdir/写入时
 * 还会再被 realpath 检查一次 —— 这里挡的是「明显的越界」，不是全部。
 */
export function resolveTaskPath(outDir: string, raw: string): { ok: true; rel: string; abs: string } | { ok: false; reason: string } {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: false, reason: 'path 不能为空' }
  const norm = s.replace(/\\/g, '/')
  if (/^[a-z]:/i.test(norm) || norm.startsWith('/') || norm.startsWith('~')) {
    return { ok: false, reason: '只能写任务目录内的文件，请用相对路径（如 2026-10-29.md）' }
  }
  const parts = norm.split('/').filter((p) => p && p !== '.')
  if (parts.length === 0) return { ok: false, reason: 'path 不能是任务目录本身' }
  if (parts.some((p) => p === '..')) return { ok: false, reason: 'path 不能包含 ..' }
  const rel = parts.join('/')
  const root = path.resolve(outDir)
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { ok: false, reason: '只能写任务目录内的文件' }
  }
  return { ok: true, rel, abs }
}

function withinRoot(root: string, abs: string): boolean {
  const r = path.resolve(root)
  return abs === r || abs.startsWith(r + path.sep)
}

export async function buildTaskTools(opts: TaskToolOptions): Promise<ToolDefinition[]> {
  const { defineTool } = await loadPiSdk()
  const { Type } = await loadTypeBox()
  const outDir = path.resolve(opts.outDir)
  const fetchTool = createFetchTool(defineTool, Type, opts.fetchImpl ? { fetch: opts.fetchImpl } : {})

  return [
    fetchTool,
    defineTool({
      name: 'torra_task_write',
      label: '写入任务文件',
      description:
        '把成品写进任务目录（相对路径，父目录会自动创建）。文件名按任务指令来，例如 2026-10-29.md。' +
        '内容上限 1MB；只能写任务目录内部，绝对路径与 .. 会被拒绝。',
      parameters: Type.Object({
        path: Type.String({ description: '相对任务目录的路径，如 2026-10-29.md 或 archive/2026-10-29.md' }),
        content: Type.String({ description: '完整文件内容；一次写整篇，不要分片' }),
      }),
      async execute(_id: string, params: { path: string; content: string }) {
        const target = resolveTaskPath(outDir, params.path)
        if (!target.ok) {
          return { content: [{ type: 'text' as const, text: target.reason }], details: { ok: false, path: '', bytes: 0 } }
        }
        const content = String(params.content ?? '')
        const bytes = Buffer.byteLength(content, 'utf8')
        if (bytes > MAX_WRITE_BYTES) {
          return {
            content: [{ type: 'text' as const, text: `内容 ${bytes} 字节，超过 1MB 上限；请只写整理后的成品，不要原样抄整页响应。` }],
            details: { ok: false, path: '', bytes: 0 },
          }
        }
        try {
          await fs.promises.mkdir(path.dirname(target.abs), { recursive: true })
          // mkdir 之后再看一次 realpath：目录里若有软链接指向外部，这里会拦住
          const realRoot = await fs.promises.realpath(outDir)
          const realParent = await fs.promises.realpath(path.dirname(target.abs))
          if (!withinRoot(realRoot, realParent)) {
            return {
              content: [{ type: 'text' as const, text: '目标目录解析后落在任务目录之外（可能是软链接），已拒绝写入。' }],
              details: { ok: false, path: '', bytes: 0 },
            }
          }
          await fs.promises.writeFile(target.abs, content, 'utf8')
          opts.onWrite?.(target.rel)
          return {
            content: [{ type: 'text' as const, text: `已写入 ${target.rel}（${bytes} 字节）。` }],
            details: { ok: true, path: target.rel, bytes },
          }
        } catch (e) {
          return {
            content: [{ type: 'text' as const, text: `写入失败：${(e as Error).message}` }],
            details: { ok: false, path: '', bytes: 0 },
          }
        }
      },
    }),
    defineTool({
      name: 'torra_task_list',
      label: '列出任务目录',
      description:
        '列出任务目录里已有的文件（相对路径、大小、修改时间），用来避免覆盖或确认历史产出。' +
        '只列文件，不递归进软链接。',
      parameters: Type.Object({}),
      async execute() {
        try {
          const rows: string[] = []
          const walk = async (dir: string, depth: number): Promise<void> => {
            if (depth > 6 || rows.length >= MAX_LIST) return
            const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
            for (const ent of entries) {
              if (rows.length >= MAX_LIST) return
              const abs = path.join(dir, ent.name)
              if (ent.isDirectory()) {
                await walk(abs, depth + 1)
                continue
              }
              if (!ent.isFile()) continue
              const st = await fs.promises.stat(abs).catch(() => null)
              if (!st) continue
              const rel = path.relative(outDir, abs).replace(/\\/g, '/')
              rows.push(
                `- ${rel} · ${(st.size / 1024).toFixed(1)} KB · ${new Date(st.mtimeMs).toLocaleString('zh-CN', { hour12: false })}`,
              )
            }
          }
          await walk(outDir, 0)
          rows.sort()
          return {
            content: [{ type: 'text' as const, text: rows.length ? rows.join('\n') : '（任务目录里还没有文件）' }],
            details: { ok: true, count: rows.length },
          }
        } catch (e) {
          return {
            content: [{ type: 'text' as const, text: `列出目录失败：${(e as Error).message}` }],
            details: { ok: false, count: 0 },
          }
        }
      },
    }),
  ]
}

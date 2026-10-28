/**
 * GitHub REST 的最小封装（只够备份用）。
 *
 * 不引第三方 SDK：这里只用四个端点（/user、/repos、contents 的读与写），
 * 而备份是「坏了就整条链路不可用」的功能，多一个依赖就多一处要跟着升级的面。
 *
 * 失败一律翻译成人话再说出去：401/403/404/409 在界面上是四种完全不同的处置
 * （换令牌 / 补权限 / 换仓库 / 重试），只回一个 HTTP 码等于把判断扔给用户。
 */

import type { BackupTarget } from '../../shared/backup'

const API = 'https://api.github.com'
const UA = 'Torra-Backup'
/** 单次请求上限：备份是用户主动点的动作，卡住要能自己回来 */
const TIMEOUT_MS = 30_000

export type GhResult<T> = { ok: true; data: T } | { ok: false; status: number; reason: string }

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
    'Content-Type': 'application/json',
  }
}

async function call<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<GhResult<T>> {
  const url = path.startsWith('http') ? path : `${API}${path}`
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: headers(token),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      /* 非 JSON 响应（网关页等）：下面按状态码解释 */
    }
    if (res.ok) return { ok: true, data: parsed as T }
    return { ok: false, status: res.status, reason: explain(res.status, parsed) }
  } catch (err) {
    const name = (err as { name?: string })?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, status: 0, reason: '连接 GitHub 超时（30 秒），检查网络或代理后重试' }
    }
    return { ok: false, status: 0, reason: `连不上 GitHub：${(err as Error)?.message ?? String(err)}` }
  }
}

function explain(status: number, body: unknown): string {
  const message = (body as { message?: string } | null)?.message
  switch (status) {
    case 401:
      return '令牌无效或已过期，请重新生成一个并粘贴回来'
    case 403:
      return `令牌权限不足${message ? `（${message}）` : ''}：需要 repo 范围（细粒度令牌则需 Contents 读写）`
    case 404:
      return `仓库不存在或令牌看不到它${message ? `（${message}）` : ''}`
    case 409:
      return '远端刚被改过，本地手里的版本已过期，请重试一次'
    case 422:
      return `GitHub 拒绝了这次请求${message ? `：${message}` : ''}`
    default:
      return `GitHub 返回 ${status}${message ? `：${message}` : ''}`
  }
}

export interface GhUser {
  login: string
}

export function ghUser(token: string): Promise<GhResult<GhUser>> {
  return call<GhUser>(token, '/user')
}

export interface GhRepo {
  full_name: string
  private: boolean
  default_branch: string
  /** 细粒度令牌不一定给这个字段：给了才有权限结论，没给就别装作知道 */
  permissions?: { push?: boolean; admin?: boolean }
}

export function ghRepo(token: string, owner: string, repo: string): Promise<GhResult<GhRepo>> {
  return call<GhRepo>(token, `/repos/${owner}/${repo}`)
}

export function ghCreateRepo(token: string, name: string): Promise<GhResult<GhRepo>> {
  return call<GhRepo>(token, '/user/repos', {
    method: 'POST',
    body: { name, private: true, description: 'Torra 数据备份（会话存档 / 偏好 / 模型清单）' },
  })
}

interface GhContent {
  content?: string
  encoding?: string
  sha: string
}

export interface GhFile {
  text: string
  sha: string
}

export function ghGetFile(
  token: string,
  target: BackupTarget,
  file = target.file,
): Promise<GhResult<GhFile | null>> {
  return call<GhContent>(token, `/repos/${target.owner}/${target.repo}/contents/${file}?ref=${encodeURIComponent(target.branch)}`).then(
    (r) => {
      if (!r.ok) return r
      const data = r.data
      if (!data || typeof data.content !== 'string') return { ok: true as const, data: null }
      const text = Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8')
      return { ok: true as const, data: { text, sha: data.sha } }
    },
  )
}

export interface GhCommitInfo {
  commit: { sha: string; html_url?: string }
}

export function ghPutFile(
  token: string,
  target: BackupTarget,
  text: string,
  message: string,
  sha?: string,
  file = target.file,
): Promise<GhResult<GhCommitInfo>> {
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: target.branch,
  }
  // 带上 sha 是乐观锁：远端在这两步之间被人改过时，GitHub 会以 409 拒绝，
  // 而不是把对方的改动静默覆盖掉。
  if (sha) body.sha = sha
  return call<GhCommitInfo>(token, `/repos/${target.owner}/${target.repo}/contents/${file}`, {
    method: 'PUT',
    body,
  })
}

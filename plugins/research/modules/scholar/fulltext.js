/**
 * MinerU 全文解析：把「只有摘要」的精读补成「有实验细节」的精读。
 *
 * 走的是 mineru.net 的免 token flash 通道：
 *   1. POST /api/v1/agent/parse/url  { url }        → task_id
 *   2. GET  /api/v1/agent/parse/{id}                → state: pending / running / done / failed
 *   3. done 时 data.markdown_url 指向一份 full.md   → 文本，直接能存、能喂模型
 *
 * 为什么选它而不是 token + zip：
 *   - 插件的 net.fetch 只会把响应按 UTF-8 文本交回来，下载 zip 在插件里解不开；
 *   - flash 通道免密钥，用户不用先配 token 才能试；
 *   - 一次解析要一两分钟，所以提交与查询分开，面板轮询，不把 RPC 卡死。
 *
 * 红线：只提交公开可下载的 PDF 地址（arXiv / 开放获取的 .pdf 链接）。
 * 不绕过付费墙，不冒用学校或平台的登录态；付费墙论文就到摘要为止。
 */

const MINERU = {
  endpoint: 'https://mineru.net/api/v1/agent/parse',
  /** flash 通道的单篇限制，写进界面提示，别让用户对着 20 页论文等半小时 */
  maxPages: 20,
  maxMb: 10,
  /** 单篇全文在本机的上限；宿主单个存储值是 1MB，留出 JSON 转义余量 */
  maxBytes: 700 * 1024,
  /** 喂给精读模型的单篇节选上限（字符） */
  excerpt: 16000,
  /** 面板一次预览的字符数 */
  preview: 12000,
}

const STATES = ['idle', 'queued', 'running', 'done', 'failed']

function text(value) {
  return typeof value === 'string' ? value : ''
}

function oneLine(value, max) {
  return text(value).replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function byteLength(value) {
  const body = text(value)
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(body, 'utf8')
  return new TextEncoder().encode(body).length
}

/** 论文有没有一个 MinerU 拿得到的公开 PDF 地址；没有就老实说没有 */
function pdfUrlFor(paper) {
  const src = paper && typeof paper === 'object' ? paper : {}
  const arxivId = text(src.arxivId)
    .trim()
    .replace(/^arxiv:/i, '')
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '')
    .replace(/v\d+$/i, '')
  if (/^\d{4}\.\d{4,5}$/.test(arxivId)) return 'https://arxiv.org/pdf/' + arxivId
  const doi = text(src.doi)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
  const arxivDoi = /^10\.48550\/arxiv\.(.+)$/.exec(doi)
  if (arxivDoi) return 'https://arxiv.org/pdf/' + arxivDoi[1].replace(/v\d+$/i, '')
  let url = null
  try {
    url = new URL(text(src.url).trim())
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  if (/\.pdf$/i.test(url.pathname)) return url.toString()
  if (/(^|\.)arxiv\.org$/i.test(url.hostname) && /^\/pdf\//i.test(url.pathname)) return url.toString()
  return ''
}

function normalizeFull(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const state = STATES.includes(src.state) ? src.state : 'idle'
  return {
    state,
    taskId: oneLine(src.taskId, 120),
    url: oneLine(src.url, 600),
    at: Number(src.at) || 0,
    chars: Math.max(0, Number(src.chars) || 0),
    /** 连续查询失败次数：任务可能已经过期，攒够几次就别再让界面一直转 */
    tries: Math.max(0, Number(src.tries) || 0),
    trimmed: src.trimmed === true,
    note: oneLine(src.note, 300),
  }
}

/** 面板与接口共用的一句话状态：失败时把原因带上，不让人对着「failed」猜 */
function describeFull(full) {
  const f = normalizeFull(full)
  if (f.state === 'queued') return '已提交，MinerU 排队中'
  if (f.state === 'running') return 'MinerU 正在解析，通常 1–3 分钟'
  if (f.state === 'done') return '已解析 ' + f.chars.toLocaleString('zh-CN') + ' 字'
  if (f.state === 'failed') return f.note || '解析失败'
  return '还没有全文'
}

/**
 * MinerU 的 markdown 里图片是相对路径，插件不落图片，留着只会显示破图；
 * 参考文献整段对精读与提问没有用，还会把节选的尾巴挤满。
 */
function cleanMarkdown(raw) {
  return text(raw)
    .replace(/\r\n/g, '\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function bodyOnly(raw) {
  const body = text(raw)
  const hit = /^[ \t]*(?:#{1,6}[ \t]*)?(?:references|bibliography|参考文献)[ \t]*$/im.exec(body)
  // 正文开头也可能出现「References」这个词；只有出现在足够靠后再当章节标题切
  if (hit && hit.index > 1200) return body.slice(0, hit.index).trim()
  return body.trim()
}

/** 全文节选：头多尾也多，方法是实验通常在两头，中间大段推导先略过 */
function excerpt(raw, max) {
  const limit = Math.max(1000, Number(max) || MINERU.excerpt)
  const body = bodyOnly(raw)
  if (body.length <= limit) return body
  const head = Math.floor(limit * 0.68)
  const tail = Math.max(200, limit - head - 12)
  return body.slice(0, head).trim() + '\n\n…（中略）…\n\n' + body.slice(-tail).trim()
}

/** 按 UTF-8 字节截断：存储上限是字节数，中文一个字符占三个字节 */
function trimToBytes(raw, maxBytes) {
  const body = text(raw)
  const limit = Number(maxBytes) || MINERU.maxBytes
  if (byteLength(body) <= limit) return { text: body, trimmed: false }
  const note = '\n\n（全文超过本机单篇上限，后面已截断）'
  const room = Math.max(0, limit - byteLength(note))
  let lo = 0
  let hi = body.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (byteLength(body.slice(0, mid)) <= room) lo = mid
    else hi = mid - 1
  }
  return { text: body.slice(0, lo).trimEnd() + note, trimmed: true }
}

function mapState(raw) {
  const value = text(raw).trim().toLowerCase()
  if (['pending', 'queued', 'waiting'].includes(value)) return 'queued'
  if (['running', 'parsing', 'processing'].includes(value)) return 'running'
  if (['done', 'success', 'succeeded', 'finished'].includes(value)) return 'done'
  if (['failed', 'error'].includes(value)) return 'failed'
  return 'running'
}

function messageOf(payload) {
  if (!payload || typeof payload !== 'object') return ''
  return oneLine(payload.msg || payload.message || payload.error || payload.detail, 160)
}

function createMineru(deps) {
  const postJson = deps && deps.postJson
  const getJson = deps && deps.getJson
  const getText = deps && deps.getText

  async function submit(url) {
    const res = await postJson(MINERU.endpoint + '/url', { url })
    if (!res || (res.code !== undefined && Number(res.code) !== 0)) {
      throw new Error('MinerU 拒绝了这次提交：' + (messageOf(res) || '未知原因'))
    }
    const taskId = String((res.data && res.data.task_id) || '').trim()
    if (!taskId) throw new Error('MinerU 没有返回任务号')
    return taskId
  }

  async function status(taskId) {
    const res = await getJson(MINERU.endpoint + '/' + encodeURIComponent(taskId))
    // getJson 交回的是 HTTP 信封（status/headers/body），不是解析过的 JSON
    let payload = res && typeof res === 'object' ? res : {}
    if (typeof payload.body === 'string') {
      try {
        payload = JSON.parse(payload.body || '{}')
      } catch {
        throw new Error('MinerU 返回的不是 JSON')
      }
    }
    if (!payload || (payload.code !== undefined && Number(payload.code) !== 0)) {
      throw new Error('MinerU 查询失败：' + (messageOf(payload) || '未知原因'))
    }
    const data = (payload && payload.data) || {}
    return {
      state: mapState(data.state),
      note: oneLine(data.err_msg || data.error || messageOf(data), 200),
      markdownUrl: String(data.markdown_url || '').trim(),
    }
  }

  async function download(markdownUrl) {
    let url = null
    try {
      url = new URL(markdownUrl)
    } catch {
      throw new Error('MinerU 没有给出可用的全文地址')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('全文地址不是 http(s)')
    if (!/(^|\.)openxlab\.org\.cn$/i.test(url.hostname)) {
      throw new Error('全文地址不在 MinerU 的下载域名里：' + url.hostname)
    }
    const body = await getText(url.toString())
    if (!body.trim()) throw new Error('全文下载回来是空的')
    return body
  }

  return { submit, status, download }
}

module.exports = {
  MINERU,
  createMineru,
  pdfUrlFor,
  normalizeFull,
  describeFull,
  cleanMarkdown,
  bodyOnly,
  excerpt,
  trimToBytes,
  mapState,
}

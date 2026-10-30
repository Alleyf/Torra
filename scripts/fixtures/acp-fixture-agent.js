#!/usr/bin/env node
/**
 * 测试用的假 ACP agent —— 一个只会说协议的最小对端。
 *
 * 为什么要有它：ACP 客户端的难处不在「发一句话」，而在那些只有真发一轮才出现的分支 ——
 * agent 反过来问你要授权、要读文件、要改设置、要被取消。真 agent 要登录、要花钱、
 * 还会随上游版本漂；这里要的是**每次都一样**的对端，把这些分支一条条钉死。
 *
 * 它只做协议，一点智能都没有：
 *   - initialize：报一份假的协商结果（带 modes 与 configOptions，用来验「按来源分派」）
 *   - session/new：给一个固定的 sessionId，并把报来的 MCP 声明记下来
 *   - session/prompt：看提示词里的标记决定演哪一段
 *       #text        回一句文字（验 agent_message_chunk）
 *       #tool        报一次工具调用与结果（验 tool_call / tool_call_update）
 *       #permission 反过来向客户端要一次授权（验授权往返）
 *       #read        向客户端要一次读文件（验 fs 通道）
 *       #write       向客户端要一次写文件（验 fs 通道与目录边界）
 *       #mcp        真的去连报来的那个 MCP 服务，列工具、调工具（验工具包交接）
 *   - session/cancel：认下取消
 *   - session/set_mode 与 session/set_config_option：收下并回一条 update
 *
 * #mcp 这一段是重点：它让这个假 agent 当一次**真的 MCP 客户端**，
 * 于是「Torra 的工具挂上去 agent 真的能用」这件事有了可验证的落点，
 * 而不是只验「声明发出去了」。
 *
 * 环境变量：
 *   FIXTURE_NO_HTTP_MCP=1  握手时不报 http 形态的 MCP 能力（用来验挂不上的路径）
 *   FIXTURE_REJECT_MCP=1   建会话时拒掉带 MCP 声明的请求（codex 的脾气）
 *
 * 纪律：**stdout 只准写协议消息**。协议是按行切的 JSON，日志混进去就把流切坏了，
 * 所以日志一律走 stderr。
 */

let nextId = 1
/** 我发给客户端的请求：id → 等它的答复 */
const pending = new Map()
let sessionId = 'fixture-session-1'
let cancelled = false
/** session/new 里报来的 MCP 声明：http 形态的那种 */
let mcpServer = null

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function update(payload) {
  notify('session/update', { sessionId, update: payload })
}

/** 从提示词里取「标记后面跟的那个路径」：#write:C:\dir\a.txt */
function pathAfter(text, marker) {
  const at = text.indexOf(marker)
  if (at < 0) return ''
  const rest = text.slice(at + marker.length)
  const m = rest.match(/^\s*([^\s]+)/)
  return m ? m[1] : ''
}

/** 向客户端发一个请求，等它的答复 */
function callClient(method, params) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function text(delta) {
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } })
}

// ---------------------------------------------------------------------------
// 当一次真的 MCP 客户端
// ---------------------------------------------------------------------------

/** 新方言的版本号：claude 现在先试这一版，失败才退回老方言 */
const MCP_MODERN = '2026-07-28'

/** 从报来的清单里挑出 http 形态的那个 */
function pickHttpMcp(list) {
  if (!Array.isArray(list)) return null
  for (const item of list) {
    if (item && item.type === 'http' && typeof item.url === 'string') return item
  }
  return null
}

/** 声明里带的头 → 真正发出去的头 */
function declaredHeaders(decl) {
  const out = {}
  for (const h of decl.headers || []) {
    if (h && typeof h.name === 'string') out[h.name.toLowerCase()] = String(h.value ?? '')
  }
  return out
}

/**
 * MCP 的答复有两种形态：纯 JSON，或者 SSE（event: message / data: {...}）。
 * 两种都要认，否则在老方言那条路上会拿到一个空答复。
 */
function parseReply(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('data:')) continue
    try {
      return JSON.parse(lines[i].slice(5).trim())
    } catch {
      /* 这一条不是 JSON，继续往上找 */
    }
  }
  return null
}

async function mcpPost(decl, payload, extra) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...declaredHeaders(decl),
    ...(extra || {}),
  }
  const res = await fetch(decl.url, { method: 'POST', headers, body: JSON.stringify(payload) })
  const raw = await res.text()
  return { status: res.status, headers: res.headers, json: parseReply(raw), raw }
}

/** 工具清单在哪一层：老方言在 result.tools，新方言在 result.tools 或 result.server.tools */
function pickTools(json) {
  const r = json && json.result ? json.result : null
  if (!r) return []
  if (Array.isArray(r.tools)) return r.tools
  if (r.server && Array.isArray(r.server.tools)) return r.server.tools
  return []
}

/** 工具调用的结果正文 */
function replyText(json) {
  const r = json && json.result ? json.result : null
  if (!r) return JSON.stringify(json ?? null)
  if (Array.isArray(r.content)) {
    return r.content.map((c) => (c && typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\n')
  }
  if (typeof r.text === 'string') return r.text
  return JSON.stringify(r)
}

function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': MCP_MODERN,
    'io.modelcontextprotocol/clientInfo': { name: 'torra-acp-fixture', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  }
}

/**
 * 连上那个 MCP 服务，列工具，调一个。
 *
 * 先试新方言（claude 的做法），不通再退回老方言（codex / opencode 的做法）。
 * 两条路走通任意一条都算数 —— 要验的是「agent 真的能用上工具」，
 * 不是「这个假 agent 恰好会某一版协议」。
 */
async function runMcp() {
  if (!mcpServer) {
    text('MCP：没拿到声明')
    return
  }
  const decl = mcpServer
  let dialect = ''
  let tools = []
  let callJson = null
  let callError = ''
  /** 老方言要带会话头（initialize 之后才有） */
  let classicHeaders = {}

  // 新方言
  try {
    const disc = await mcpPost(
      decl,
      { jsonrpc: '2.0', id: 'd1', method: 'server/discover', params: { _meta: modernMeta() } },
      { 'mcp-protocol-version': MCP_MODERN, 'mcp-method': 'server/discover' },
    )
    if (disc.status === 200) {
      tools = pickTools(disc.json)
      if (tools.length) dialect = '新方言'
    }
  } catch (e) {
    callError = callError || `新方言失败：${e.message}`
  }

  // 老方言
  if (!dialect) {
    try {
      const init = await mcpPost(decl, {
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'torra-acp-fixture', version: '1.0.0' },
        },
      })
      const sid = init.headers.get('mcp-session-id')
      classicHeaders = sid ? { 'mcp-session-id': sid } : {}
      await mcpPost(decl, { jsonrpc: '2.0', method: 'notifications/initialized' }, classicHeaders)
      const list = await mcpPost(decl, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, classicHeaders)
      tools = pickTools(list.json)
      dialect = '老方言'
    } catch (e) {
      callError = callError || `老方言失败：${e.message}`
    }
  }

  text(`MCP 方言：${dialect || '没连上'}`)
  text(`MCP 工具：${tools.map((t) => t && t.name).filter(Boolean).join(', ') || '（空）'}`)

  const target = tools.find((t) => t && t.name === 'torra_list_models') || tools[0]
  if (!target) {
    text(`MCP 调用：没有工具可调${callError ? `（${callError}）` : ''}`)
    return
  }
  try {
    const args = {}
    if (dialect === '新方言') {
      callJson = (
        await mcpPost(
          decl,
          {
            jsonrpc: '2.0',
            id: 'c1',
            method: 'tools/call',
            params: { name: target.name, arguments: args, _meta: modernMeta() },
          },
          {
            'mcp-protocol-version': MCP_MODERN,
            'mcp-method': 'tools/call',
            'mcp-name': target.name,
          },
        )
      ).json
    } else {
      callJson = (
        await mcpPost(
          decl,
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: target.name, arguments: args } },
          classicHeaders,
        )
      ).json
    }
    text(`MCP 调用 ${target.name}：${replyText(callJson)}`)
  } catch (e) {
    text(`MCP 调用失败：${e.message}`)
  }
}

async function handlePrompt(params) {
  const prompt = Array.isArray(params.prompt) ? params.prompt : []
  const joined = prompt
    .map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
    .join('\n')

  if (joined.includes('#text')) {
    text('这是一句来自假 agent 的话。')
  }

  if (joined.includes('#tool')) {
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'fixture-tool-1',
      title: '假装在跑一个工具',
      kind: 'execute',
      status: 'pending',
    })
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'fixture-tool-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '工具跑完了' } }],
    })
  }

  if (joined.includes('#permission')) {
    const res = await callClient('session/request_permission', {
      sessionId,
      toolCall: {
        toolCallId: 'fixture-tool-perm',
        title: '要写一个文件',
        kind: 'edit',
        status: 'pending',
      },
      options: [
        { optionId: 'allow-once', name: '这一次允许', kind: 'allow_once' },
        { optionId: 'reject-once', name: '这一次拒绝', kind: 'reject_once' },
      ],
    })
    const outcome = res && res.outcome ? res.outcome : {}
    text(`授权结果是：${outcome.outcome === 'selected' ? `选了 ${outcome.optionId}` : '被取消'}`)
  }

  if (joined.includes('#read')) {
    // 路径可以跟在标记后面：#read:某个文件
    const target = pathAfter(joined, '#read') || process.env.FIXTURE_READ_PATH || 'fixture-read.txt'
    // sessionId 是协议要求的必填项：客户端那边按 schema 校验，少了整条请求会被判无效
    const res = await callClient('fs/read_text_file', { sessionId, path: target, line: 1, limit: 10 })
    if (res && typeof res.content === 'string') {
      text(`读到了：${res.content.trim()}`)
    } else {
      text('读不到：客户端没给内容')
    }
  }

  if (joined.includes('#write')) {
    const target = pathAfter(joined, '#write') || process.env.FIXTURE_WRITE_PATH || 'fixture-write.txt'
    const res = await callClient('fs/write_text_file', { sessionId, path: target, content: '假 agent 写的\n' })
    if (res && res.error) {
      text(`写不了：${JSON.stringify(res.error)}`)
    } else {
      text('写好了')
    }
  }

  if (joined.includes('#mcp')) {
    await runMcp()
  }

  if (cancelled) {
    respond(params.__id, { stopReason: 'cancelled' })
    return
  }
  respond(params.__id, { stopReason: 'end_turn' })
}

async function dispatch(msg) {
  const method = msg.method
  const params = msg.params || {}

  switch (method) {
    case 'initialize':
      respond(msg.id, {
        protocolVersion: 1,
        agentInfo: { name: 'torra-acp-fixture', title: 'Torra 测试用假 agent', version: '1.0.0' },
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: {
            http: process.env.FIXTURE_NO_HTTP_MCP === '1' ? false : true,
            sse: false,
          },
          sessionCapabilities: { list: true, load: true },
          promptCapabilities: { image: false, audio: false },
        },
        authMethods: [{ id: 'none', name: '无需登录' }],
      })
      return
    case 'session/new': {
      const wanted = params.sessionId
      if (typeof wanted === 'string' && wanted) sessionId = wanted
      // codex 的脾气：遇到不认识的形态就 invalidParams。客户端要能退回不带声明再试一次。
      if (process.env.FIXTURE_REJECT_MCP === '1' && Array.isArray(params.mcpServers) && params.mcpServers.length) {
        respondError(msg.id, -32602, '不认识这个 MCP 服务的形态')
        return
      }
      // 工具包就是靠这里交接的：报来的那一条声明决定了这个假 agent 能不能拿到工具
      mcpServer = pickHttpMcp(params.mcpServers)
      respond(msg.id, {
        sessionId,
        modes: {
          currentModeId: 'ask',
          availableModes: [
            { id: 'ask', name: '每次问我' },
            { id: 'auto', name: '自己决定' },
          ],
        },
        configOptions: [
          {
            id: 'effort',
            name: '思考档',
            category: 'fixture',
            type: 'select',
            currentValue: 'mid',
            options: [
              { value: 'low', name: '低' },
              { value: 'mid', name: '中' },
            ],
          },
        ],
      })
      return
    }
    case 'session/prompt':
      await handlePrompt({ ...params, __id: msg.id })
      return
    case 'session/cancel':
      cancelled = true
      respond(msg.id, {})
      return
    case 'session/set_mode':
      update({ sessionUpdate: 'current_mode_update', currentModeId: params.modeId })
      respond(msg.id, {})
      return
    case 'session/set_config_option':
      // 协议给的是「一份选项清单」：每项带自己的 id 与当前值
      update({
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: params.configId,
            name: '思考档',
            category: 'fixture',
            currentValue: String(params.value),
          },
        ],
      })
      respond(msg.id, {})
      return
    case 'authenticate':
    case 'logout':
      respond(msg.id, {})
      return
    default:
      respondError(msg.id, -32601, `假 agent 不认识这个方法：${method}`)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx = buffer.indexOf('\n')
  while (idx >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (line) {
      let msg
      try {
        msg = JSON.parse(line)
      } catch (e) {
        process.stderr.write(`假 agent 收到坏行：${e.message}\n`)
        idx = buffer.indexOf('\n')
        continue
      }
      if (msg && typeof msg === 'object') {
        if (msg.method && msg.id === undefined) {
          // 客户端发来的通知：目前没有要处理的
          void msg
        } else if (msg.method) {
          void dispatch(msg).catch((e) => {
            process.stderr.write(`假 agent 处理失败：${e.message}\n`)
          })
        } else if (typeof msg.id === 'number' && pending.has(msg.id)) {
          const resolve = pending.get(msg.id)
          pending.delete(msg.id)
          resolve(msg.result !== undefined ? msg.result : { error: msg.error })
        }
      }
    }
    idx = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => {
  process.exit(0)
})

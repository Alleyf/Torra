/**
 * 适配器 YAML 校验回归（开发期自检）
 *
 * 为什么要单独守住：适配器 YAML 是纯数据，tsc 不会检查它。
 * 一个选择器写错或字段缺失，运行时只表现为「该模型打开失败」，
 * 排查成本极高。故在此对全部内置适配器做静态校验。
 *
 * 运行：npm run test:adapters
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { validateSpec } from '../src/main/adapters/registry'
import { ADAPTER_STALE_DAYS } from '../src/shared/adapter'
import { INJECT_SCRIPT } from '../src/main/webview/inject'
import { PICKER_SCRIPT } from '../src/main/webview/picker'

let pass = 0
let fail = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
    console.log(`       ${(e as Error).message.split('\n')[0]}`)
  }
}

const ADAPTER_DIR = path.resolve(__dirname, '..', 'adapters')

async function main(): Promise<void> {
  const files = (await fs.readdir(ADAPTER_DIR)).filter((f) => f.endsWith('.yaml'))
  const specs = new Map<string, unknown>()

  for (const f of files) {
    const raw = YAML.parse(await fs.readFile(path.join(ADAPTER_DIR, f), 'utf8'))
    specs.set(f.replace(/\.ya?ml$/, ''), raw)
  }

  console.log(`\n=== 内置适配器校验（${files.length} 份）===`)

  it('全部内置适配器通过结构校验', () => {
    const bad: string[] = []
    for (const [name, raw] of specs) {
      const r = validateSpec(raw)
      if (!r.ok) bad.push(`${name}: ${r.errors.join('; ')}`)
    }
    assert.equal(bad.length, 0, bad.join('\n'))
  })

  it('DeepSeek 可用（此前该站无适配器，网页通道完全打不开）', () => {
    assert.ok(specs.has('deepseek'), '缺少 deepseek.yaml')
    const r = validateSpec(specs.get('deepseek'))
    assert.ok(r.ok, r.ok ? '' : r.errors.join('; '))
  })

  it('DeepSeek 用文本稳定判定而非停止按钮', () => {
    // 逆向确证：DeepSeek 发送与停止复用同一 button，
    // 「按钮消失」永远不成立，用 stop_button_hidden 会永远判定已完成。
    const s = specs.get('deepseek') as { completion: { mode: string } }
    assert.equal(s.completion.mode, 'dom_stable')
  })

  it('DeepSeek 启动时做页面预检以识别 localStorage 登录态', () => {
    const s = specs.get('deepseek') as { prewarm?: boolean }
    assert.equal(s.prewarm, true)
  })

  it('DeepSeek 输入框候选全部指向聊天输入框', () => {
    /*
     * 2026-10-04 抓线上 main.6fca03582d.js（meta commit-id=44809ea4）逐个核对：
     * - name:"user query" 出现在 DSL Textarea 的 textareaDomProps 里，同处带 Enter 提交分支；
     * - name:"search" 是自适应 textarea 组件硬编码的 name，该组件有 ArrowUp 取历史
     *   + Enter 调 submit('enter')，是输入框而不是搜索框；
     * - 占位符来自 i18n chatInputPlaceholderChat「给 DeepSeek 发送消息 」。
     * 三档都是输入框特征，任何一档在场都能用。
     */
    const s = specs.get('deepseek') as { selectors: Record<string, string> }
    for (const cand of ['user query', 'search', '给 DeepSeek 发送消息']) {
      assert.ok(s.selectors.input.includes(cand), `输入候选缺少 ${cand}`)
    }
    assert.doesNotMatch(s.selectors.input, /\[class\*="_|:r\d+:/, '输入候选含易漂 token')
  })

  it('DeepSeek 回复容器用全局语义类并以 Enter 发送', () => {
    // bundle 里是 cx("ds-markdown", variant) 字面量，不是 CSS Module 哈希名
    const s = specs.get('deepseek') as { selectors: Record<string, string>; send_mode?: string }
    assert.equal(s.selectors.stream, 'div.ds-markdown')
    assert.equal(s.send_mode, 'enter')
    assert.ok(!s.selectors.send, 'send_mode=enter 后不应再保留发送按钮选择器')
  })

  it('Kimi 声明为 contenteditable 且拼接全部 segment', () => {
    // Kimi 是 Lexical 富文本：逐字改 textContent 会被其状态机覆盖，
    // 且单条 segment 只含片段内容，故必须 all。
    const s = specs.get('kimi') as { input_kind?: string; stream_mode?: string }
    assert.equal(s.input_kind, 'contenteditable')
    assert.equal(s.stream_mode, 'all')
  })

  it('豆包用 data-testid 而非哈希类名', () => {
    const s = specs.get('doubao') as { selectors: Record<string, string> }
    assert.match(s.selectors.input, /data-testid/, '哈希类名会随发版失效')
    assert.match(s.selectors.stop, /data-testid/)
  })

  it('qwen 的停止按钮与发送按钮可区分', () => {
    const s = specs.get('qwen') as { selectors: Record<string, string>; completion: { mode: string } }
    assert.notEqual(s.selectors.send, s.selectors.stop)
    assert.equal(s.completion.mode, 'stop_button_hidden')
  })

  it('全部适配器新鲜度在阈值内', () => {
    const stale: string[] = []
    for (const [name, raw] of specs) {
      const s = raw as { verified_at: string }
      const days = (Date.now() - Date.parse(s.verified_at)) / 86_400_000
      if (!(days >= 0) || days > ADAPTER_STALE_DAYS) stale.push(`${name} (${s.verified_at})`)
    }
    assert.equal(stale.length, 0, `以下适配器已「长期未验证」：${stale.join(', ')}`)
  })

  it('全部适配器均带服务条款提示', () => {
    // PRD 11.3：首次接入须向用户提示自动化访问风险
    const missing: string[] = []
    for (const [name, raw] of specs) {
      const s = raw as { tos_notice?: string }
      if (!s.tos_notice || s.tos_notice.trim().length < 5) missing.push(name)
    }
    assert.equal(missing.length, 0, `缺少 tos_notice：${missing.join(', ')}`)
  })

  it('ChatGPT 兼容当前 ProseMirror 编辑器与本地化按钮', () => {
    const s = specs.get('chatgpt') as { selectors: Record<string, string>; health_probe: string }
    assert.match(s.selectors.input, /contenteditable="true"\]\[role="textbox"/)
    assert.match(s.selectors.input, /aria-label\*="ChatGPT"/)
    assert.match(s.selectors.input, /#prompt-textarea/, '应保留旧版 textarea 作为回退')
    assert.match(s.selectors.send, /发送消息/)
    assert.match(s.selectors.stop, /停止/)
    assert.equal(s.health_probe, s.selectors.input)
  })

  console.log('\n=== 注入脚本可执行性 ===')

  it('INJECT_SCRIPT 语法合法', () => {
    assert.doesNotThrow(() => {
      // eslint-disable-next-line no-new-func
      new Function(`return (${INJECT_SCRIPT.trim().replace(/;$/, '')})`)
    }, 'INJECT_SCRIPT 存在语法错误')
  })

  it('PICKER_SCRIPT 语法合法', () => {
    assert.doesNotThrow(() => {
      // eslint-disable-next-line no-new-func
      new Function(`return (${PICKER_SCRIPT.trim().replace(/;$/, '')})`)
    }, 'PICKER_SCRIPT 存在语法错误')
  })

  it('登录墙判定早于选择器判定', () => {
    const loginIdx = INJECT_SCRIPT.indexOf('isLoginWall()')
    const inputIdx = INJECT_SCRIPT.indexOf('spec.selectors.input')
    assert.ok(loginIdx > 0 && inputIdx > 0)
    assert.ok(loginIdx < inputIdx, '未登录时会被误报为适配器失效')
  })

  it('React 受控输入走原生 setter（否则键入无效）', () => {
    // 直接 el.value += x 会被 React 的 value tracker 忽略，表现为「打了字但框里空着」
    assert.match(INJECT_SCRIPT, /getOwnPropertyDescriptor/)
    assert.match(INJECT_SCRIPT, /HTMLTextAreaElement/)
  })

  it('contenteditable 走 execCommand（富文本编辑器唯一可用通道）', () => {
    assert.match(INJECT_SCRIPT, /execCommand\('insertText'/)
  })

  it('完成判定支持降级而非单点失败', () => {
    assert.match(INJECT_SCRIPT, /dom_stable/)
    assert.match(INJECT_SCRIPT, /generating_absent/)
  })

  it('ChatGPT 复用既有回复节点时仍能捕获本轮内容', () => {
    // ChatGPT 有时填充发送前已经存在的 assistant 节点，不能只按节点数量截断。
    assert.match(INJECT_SCRIPT, /baselineTail/)
    assert.match(INJECT_SCRIPT, /tail !== baselineTail/)
    assert.match(INJECT_SCRIPT, /tail\.slice\(baselineTail\.length\)/)
    assert.match(INJECT_SCRIPT, /streamBaselineText/)
  })

  it('输入框多命中时按可见优先选取', () => {
    // input 写成候选并集时（DeepSeek 三档），querySelectorAll 按文档顺序返回，
    // 一旦混进镜像节点或侧栏输入框，提示词就会打进错的框 ——
    // 表现为「发送了，但永远等不到回复」。
    assert.match(INJECT_SCRIPT, /function pickVisible/)
    const w = INJECT_SCRIPT.slice(INJECT_SCRIPT.indexOf('function waitFor'), INJECT_SCRIPT.indexOf('setNativeValue'))
    assert.match(w, /pickVisible\(selector\)/, 'waitFor 又退回裸 querySelector')
    // 体检必须复用同一条通道，否则会出现「体检测 A 框全绿、讨论里写进 B 框」
    assert.match(INJECT_SCRIPT, /pickInput: function/)
  })

  it('发送与完成控件也按可见优先选取', () => {
    assert.match(INJECT_SCRIPT, /sendBtn = sendMode === 'click' && sel\.send \? pickVisible\(sel\.send\)/)
    assert.match(INJECT_SCRIPT, /isVisible\(pickVisible\(sel\.stop\)\)/)
  })

  console.log('\n=== 选择器拾取器 ===')

  it('剔除 React 动态 id', () => {
    // 形如 :r3: 的 id 每次渲染都变，用它生成的选择器必然失效
    assert.match(PICKER_SCRIPT, /REACT_ID/)
  })

  it('剔除哈希类名', () => {
    assert.match(PICKER_SCRIPT, /HASHY/)
  })

  it('优先采用 data-testid', () => {
    // candidatesFor 内 testid 必须排在 id / aria-label / class 之前，
    // 否则生成的会是不稳定的哈希类名选择器
    const body = PICKER_SCRIPT.slice(
      PICKER_SCRIPT.indexOf('function candidatesFor'),
      PICKER_SCRIPT.indexOf('function evaluate'),
    )
    const firstPush = body.indexOf('out.push')
    const testidAt = body.indexOf('data-testid')
    const idAt = body.indexOf("el.id &&")
    assert.ok(testidAt > 0, '未找到 data-testid 分支')
    assert.ok(testidAt < idAt, 'data-testid 应排在 id 之前')
    assert.ok(testidAt > 0 && testidAt < body.indexOf('out.push', firstPush + 1) + 1)
  })

  console.log(`\n${'='.repeat(46)}`)
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46) + '\n')

  process.exit(fail > 0 ? 1 : 0)
}

void main()

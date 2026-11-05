import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pickTurnFrames, readFrameContent, type FrameLike, type FrameScan } from '../src/main/webview/frames'

const ROOT = path.resolve(__dirname, '..')

let pass = 0
let fail = 0

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log('  [PASS] ' + name)
  } catch (e) {
    fail++
    console.log('  [FAIL] ' + name)
    console.log('         ' + (e as Error).message.split('\n').slice(0, 6).join('\n         '))
  }
}

function readSrc(rel: string): string {
  return require('node:fs').readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

async function main(): Promise<void> {
  console.log('==============================================')
  console.log('  cross-origin answer frames (webview)')
  console.log('==============================================')

  const frames = readSrc('src/main/webview/frames.ts')
  const agent = readSrc('src/main/agents/webview-agent.ts')
  const inject = readSrc('src/main/webview/inject.ts')
  const adapter = readSrc('src/shared/adapter.ts')
  const registry = readSrc('src/main/adapters/registry.ts')

  await it('页面侧只报帧结构，不做跨源读取', () => {
    // 灵光实测：帧是跨源的（*.lingguang.uniocontent.com），contentDocument 抛
    // SecurityError。注入脚本里只要出现 contentDocument，就说明又走回那条死路。
    assert.match(inject, /frameScan: function \(streamSel\)/, '页面侧要报帧结构')
    // 注释里可以提 contentDocument（说明为什么走不通），但代码里不许真去读 ——
    // 跨源帧上那一句必抛 SecurityError，写了就是死路。
    const frameScanBody = inject.slice(
      inject.indexOf('frameScan: function (streamSel)'),
      inject.indexOf('frameScan: function (streamSel)') + 900,
    )
    assert.doesNotMatch(frameScanBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /contentDocument/,
      'frameScan 里不许读 contentDocument（跨源必抛）')
    assert.match(inject, /return \{ nodes: nodes\.length, last: out \};/, '帧扫描只报节点数与帧列表')
    // 只扫最后一个 stream 节点：帧里挂着整段历史，全读会把上几轮拼进本轮
    assert.match(inject, /var last = nodes\[nodes\.length - 1\];/, '只扫最后一个 stream 节点')
  })

  await it('正文由主进程进子帧读，且复用同一份注入脚本', () => {
    assert.match(frames, /executeJavaScript/, '主进程要用 executeJavaScript 进帧')
    assert.match(frames, /window\.__torra\.read\(/, '帧里走同一套 read（Markdown 保真与主文档一致）')
    assert.match(frames, /__build === /, '进帧前要认身份，和主文档 ensureInjected 同一口径')
    // 单帧失败不能拖垮整轮
    assert.match(frames, /catch \{/, '逐帧 try：一帧读不到不该让整轮失败')
  })

  await it('按 src 挑本轮那一帧，而不是猜第几个', () => {
    assert.match(frames, /f\.url === w\.src/, '先按 src 精确匹配')
    assert.match(frames, /new URL\(w\.src\)\.host/, '对不上再按 host 兜底')
    assert.match(frames, /return frames\.slice\(-n\)/, '最后才退回取末尾 N 个')
  })

  await it('三处读取口径统一走 readTurnBody，不分叉', () => {
    // 轮询、收敛确认、澄清续接各写一遍 read 调用，早晚会有一处忘了认帧 ——
    // 表现是「帧里明明有正文，收敛确认却永远数不满稳定读数」。
    assert.match(agent, /const readTurnBody = async \(\): Promise<string> => \{/, '要有唯一的读正文入口')
    assert.match(agent, /if \(frameSel\) turnText = frameBody/, '轮询用探针那一次读到的正文，不重复读')
    assert.match(agent, /const s = await readTurnBody\(\)/, '收敛确认走它')
    assert.match(agent, /let cur = await readTurnBody\(\)/, '澄清续接走它')
    // 帧内正文增长，页面侧 growth 看不到 —— 不快照就永远「没变」，慢档全量读被永久跳过
    assert.match(agent, /frameChanged = frameBody\.length !== probeFrameChars/, '帧模式要有自己的增量哨兵')
    assert.match(agent, /!changed && !frameChanged && !due/, '两路变化都要能唤醒慢档')
    // 帧还没渲染出来时不许退回页面侧：页面侧那 11 个字是页脚，不是答案。
    assert.match(agent, /if \(!frames\.length\) return ''/, '没有帧时返回空串，等下一拍')
    assert.match(agent, /return got\.text\.trim\(\) \? got\.text : ''/, '帧里没字也不退回页脚')
  })

  await it('适配器声明语义写的是跨源事实，不是同源', () => {
    assert.match(adapter, /跨源/, '字段注释要写明跨源这一前提')
    assert.match(adapter, /SecurityError/, '要写明 contentDocument 为什么读不到')
    assert.match(registry, /selectors\.stream_frame 需要配在 selectors\.stream 之上/, '配错要当场拦下')
  })

  await it('pickTurnFrames 只取本轮那一帧，不把历史帧拼进来', () => {
    // 灵光实测：20 个气泡 ↔ 10 个 shim 帧，帧里挂的是整段会话历史。
    // 全读等于把上几轮的回答拼进本轮 —— 这是这套机制最容易犯的错。
    const SHIM = 'https://742cf7b5d9fdf28e9a5c4e2f59d17768.lingguang.uniocontent.com/v1/shim.html?origin=https%3A%2F%2Fwww.lingguang.com'
    const mk = (url: string): FrameLike => ({
      url,
      executeJavaScript: async () => null,
    })
    const frames = [
      mk('https://www.lingguang.com/chat'),
      mk('https://tracert.alipay.com/cross.html'),
      mk(SHIM),
      mk(SHIM),
      mk(SHIM),
    ]
    const scan: FrameScan = { nodes: 20, last: [{ src: SHIM, id: 'q=1' }] }
    const picked = pickTurnFrames(frames, scan)
    assert.equal(picked.length, 1, '最后一个 stream 节点只挂一个帧时只读一个')
    assert.equal(picked[0]!.url, SHIM, '读的必须是 shim 帧')
    // 帧还没渲染出来：不猜，交回空数组让调用方继续等
    assert.equal(pickTurnFrames(frames, { nodes: 20, last: [] }).length, 0, '没有帧时不猜')
    assert.equal(pickTurnFrames(frames, null).length, 0, '没扫描结果时不猜')
  })

  await it('readFrameContent 单帧失败不拖垮整轮', async () => {
    const okFrame: FrameLike = {
      url: 'https://x/shim.html',
      executeJavaScript: async (code: string) => {
        if (code.includes('__build')) return true
        if (code.includes('readImages')) return []
        return '# 日报\n\n正文。'
      },
    }
    const brokenFrame: FrameLike = {
      url: 'https://x/broken.html',
      executeJavaScript: async () => {
        throw new Error('SecurityError')
      },
    }
    const got = await readFrameContent([brokenFrame, okFrame], 'INJECT', 'torra-inject-22', '#render-finalAnswer', false)
    assert.equal(got.text, '# 日报\n\n正文。', '坏帧跳过，好帧照样读出')
    assert.equal(got.images.length, 0)
  })

  await it('readFrameContent 帧里没注入过才注入', async () => {
    let injects = 0
    const frame: FrameLike = {
      url: 'https://x/shim.html',
      executeJavaScript: async (code: string) => {
        if (code.includes('__build')) return false // 还没注入
        if (code === 'INJECT') { injects++; return null }
        return 'BODY'
      },
    }
    await readFrameContent([frame], 'INJECT', 'torra-inject-22', '#r', false)
    assert.equal(injects, 1, '身份对不上时要注入一次')
  })

  await it('帧读到的正文进产出判定，不会被判成空回复', () => {
    // 灵光这类站点页面侧永远是「已思考 Ns」几个字；若只看页面侧，
    // no-content 止损会在 90s 把一整轮真实回答判成缺席。
    assert.match(agent, /turnText\.length > 0/, '正文要用帧读到的 turnText')
    assert.match(agent, /lastText\.length > 0 \|\| thinkingAcc\.length > 0/, '产出判定照旧包含正文')
  })

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + ' · ' + pass + '/' + (pass + fail))
  if (fail > 0) process.exit(1)
}

void main()

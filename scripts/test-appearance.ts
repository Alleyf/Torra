/**
 * 外观媒体（src/shared/appearance.ts）自测。
 *
 * 只钉住会真的出事的那几条：
 * - 手改过的 preferences.json（半截 ref、路径穿越、kind 与扩展名对不上）必须整条作废，
 *   否则渲染层会拿到一条打不开的地址，用户看到的是黑屏；
 * - 文件名只认纯文件名：`../x.png` 与 `a/b.mp4` 在协议层就该被拒；
 * - 遮罩浓度落在三档之内（越界值会把正文压到看不清）；
 * - Range 解析的三态：读不懂给整份 200，越界给 416，正常给 206 的区间 ——
 *   视频播放靠这条，返回错状态码的表现是「片子放不出来」。
 *
 * 运行：npm run test:appearance
 */

import assert from 'node:assert/strict'
import {
  APPEARANCE_EMPTY,
  clampMediaDim,
  isMediaFileName,
  MEDIA_DIM_DEFAULT,
  MEDIA_DIM_MAX,
  MEDIA_DIM_MIN,
  mediaKindFor,
  normalizeAppearance,
  parseByteRange,
  sniffMediaKind,
} from '../src/shared/appearance'
import { findPreset, isPresetFile, MEDIA_PRESETS, presetsFor } from '../src/shared/media-presets'

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

console.log('\n外观媒体（启动动画 / 主背景）自测')
console.log('='.repeat(46))

it('按扩展名认出动图与视频，其余一律不认', () => {
  assert.equal(mediaKindFor('startup-abc.gif'), 'image')
  assert.equal(mediaKindFor('startup-abc.webp'), 'image')
  assert.equal(mediaKindFor('startup-abc.PNG'), 'image')
  assert.equal(mediaKindFor('startup-abc.mp4'), 'video')
  assert.equal(mediaKindFor('startup-abc.webm'), 'video')
  assert.equal(mediaKindFor('startup-abc.mkv'), null, 'mkv 不在白名单：Chromium 不保证解')
  assert.equal(mediaKindFor('startup-abc'), null)
  assert.equal(mediaKindFor(''), null)
  assert.equal(mediaKindFor(undefined), null)
})

it('文件名只认纯文件名：路径与穿越在协议层就被拒', () => {
  assert.equal(isMediaFileName('background-1a2b.gif'), true)
  assert.equal(isMediaFileName('../secret.png'), false)
  assert.equal(isMediaFileName('a/b.mp4'), false)
  assert.equal(isMediaFileName('C:\\x\\y.png'), false)
  assert.equal(isMediaFileName('x.txt'), false)
  assert.equal(isMediaFileName(''), false)
  assert.equal(isMediaFileName('a'.repeat(120) + '.png'), false, '过长的名字不该被当成合法文件名')
})

it('偏好里的半截条目整条作废，不返回一条打不开的地址', () => {
  // 只有 file、没有 kind：旧版本或手改过的文件长这样
  assert.deepEqual(normalizeAppearance({ startup: { file: 'startup-1.gif' } }), APPEARANCE_EMPTY)
  // kind 与扩展名对不上：写成 video 的 gif 会让渲染层挂 <video> 去解一张动图
  assert.deepEqual(normalizeAppearance({ startup: { file: 'startup-1.gif', kind: 'video' } }), APPEARANCE_EMPTY)
  // 路径穿越
  assert.deepEqual(normalizeAppearance({ startup: { file: '../../x.gif', kind: 'image' } }), APPEARANCE_EMPTY)
  assert.deepEqual(normalizeAppearance(null), APPEARANCE_EMPTY)
  assert.deepEqual(normalizeAppearance('nonsense'), APPEARANCE_EMPTY)
})

it('合法条目原样通过，背景补上默认浓度', () => {
  const s = normalizeAppearance({
    startup: { file: 'startup-abc.mp4', kind: 'video' },
    background: { file: 'background-def.webp', kind: 'image' },
  })
  assert.deepEqual(s.startup, { file: 'startup-abc.mp4', kind: 'video' })
  assert.deepEqual(s.background, { file: 'background-def.webp', kind: 'image', dim: MEDIA_DIM_DEFAULT })
})

it('遮罩浓度夹在上下限内，坏值回默认', () => {
  assert.equal(clampMediaDim(0), MEDIA_DIM_MIN)
  assert.equal(clampMediaDim(5), MEDIA_DIM_MAX)
  assert.equal(clampMediaDim('0.5'), 0.5)
  assert.equal(clampMediaDim('abc'), MEDIA_DIM_DEFAULT)
  assert.equal(clampMediaDim(undefined), MEDIA_DIM_DEFAULT)
  const s = normalizeAppearance({ background: { file: 'background-a.png', kind: 'image', dim: 9 } })
  assert.equal(s.background?.dim, MEDIA_DIM_MAX)
})

it('Range：整份 / 前缀 / 后缀 / 越界四种读法', () => {
  // 没有 Range：整份 200
  assert.equal(parseByteRange(null, 1000), undefined)
  // 读不懂的头也回整份，不能把文件判成不可播放
  assert.equal(parseByteRange('bytes=oops', 1000), undefined)
  assert.equal(parseByteRange('items=0-1', 1000), undefined)
  // bytes=0-：从头到末尾
  assert.deepEqual(parseByteRange('bytes=0-', 1000), { start: 0, end: 999 })
  // bytes=100-199
  assert.deepEqual(parseByteRange('bytes=100-199', 1000), { start: 100, end: 199 })
  // 末尾超出文件：夹到最后一个字节
  assert.deepEqual(parseByteRange('bytes=900-5000', 1000), { start: 900, end: 999 })
  // bytes=-100：最后 100 字节
  assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 })
  // 起点越界：416
  assert.equal(parseByteRange('bytes=1000-', 1000), null)
  assert.equal(parseByteRange('bytes=-0', 1000), null)
  assert.equal(parseByteRange('bytes=200-100', 1000), null)
})

it('按文件头认格式：改了扩展名的文件在选择时就被拒', () => {
  const bytes = (...parts: Array<number[] | string>): Uint8Array => {
    const out: number[] = []
    for (const p of parts) {
      if (typeof p === 'string') for (const ch of p) out.push(ch.charCodeAt(0))
      else out.push(...p)
    }
    // 补齐到 12 字节：头部判据只读前 12 字节，短了会被当成「认不出」
    while (out.length < 12) out.push(0)
    return new Uint8Array(out)
  }
  assert.equal(sniffMediaKind(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a])), 'image')
  assert.equal(sniffMediaKind(bytes([0xff, 0xd8, 0xff, 0xe0])), 'image')
  assert.equal(sniffMediaKind(bytes('GIF89a')), 'image')
  assert.equal(sniffMediaKind(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8')), 'image')
  assert.equal(sniffMediaKind(bytes([0, 0, 0, 0x20], 'ftypisom', [0, 0, 2, 0])), 'video')
  assert.equal(sniffMediaKind(bytes([0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0])), 'image')
  assert.equal(sniffMediaKind(bytes([0x1a, 0x45, 0xdf, 0xa3], [0x9f, 0x42, 0x86, 0x81])), 'video')
  // 认不出的一律 null：主进程据此拒掉「扩展名写着 mp4、内容是别的东西」
  assert.equal(sniffMediaKind(bytes('not a media')), null)
  assert.equal(sniffMediaKind(new Uint8Array(4)), null, '短到读不出头就认不出')
})

it('预设清单里每个槽位都至少有一份，且 id 与文件名不重复', () => {
  assert.ok(presetsFor('startup').length >= 1, '启动动画至少要有一份内置预设')
  assert.ok(presetsFor('background').length >= 1, '主背景至少要有一份内置预设')
  const ids = new Set(MEDIA_PRESETS.map((p) => p.id))
  const files = new Set(MEDIA_PRESETS.map((p) => p.file))
  assert.equal(ids.size, MEDIA_PRESETS.length, '预设 id 不能重复：界面按 id 点亮选中态')
  assert.equal(files.size, MEDIA_PRESETS.length, '预设文件名不能重复：协议层按文件名分派')
})

it('偏好里的 preset 必须在清单里，kind 还要对得上', () => {
  // 清单里真实存在的那一份原样通过，落盘的就是 preset id
  const s = normalizeAppearance({ startup: { preset: 'startup-default', kind: 'video' } })
  assert.deepEqual(s.startup, { preset: 'startup-default', kind: 'video' })
  // 不存在的 id：整条作废（手改 preferences.json 指到一个没打包的文件）
  assert.deepEqual(normalizeAppearance({ startup: { preset: 'nope', kind: 'video' } }), APPEARANCE_EMPTY)
  // kind 与预设声明的不一致：当 video 用的图片预设会让渲染层挂错元素
  assert.deepEqual(
    normalizeAppearance({ background: { preset: 'background-default', kind: 'video' } }),
    APPEARANCE_EMPTY,
  )
  // 预设占位的那一格，背景仍要补上默认浓度
  const bg = normalizeAppearance({ background: { preset: 'background-default', kind: 'image' } })
  assert.equal(bg.background?.preset, 'background-default')
  assert.equal(bg.background?.dim, MEDIA_DIM_DEFAULT)
})

it('预设文件名白名单只放行清单里那几份', () => {
  for (const p of MEDIA_PRESETS) assert.equal(isPresetFile(p.file), true)
  assert.equal(isPresetFile('secret.png'), false)
  assert.equal(isPresetFile('../x.mp4'), false)
  assert.equal(isPresetFile(undefined), false)
})

it('findPreset 认 id 不认文件名，槽位错配由调用方拦', () => {
  assert.equal(findPreset('startup-default')?.slot, 'startup')
  assert.equal(findPreset('background-default')?.slot, 'background')
  assert.equal(findPreset('startup-default.mp4'), undefined, '按文件名查不该命中')
  assert.equal(findPreset(undefined), undefined)
})

console.log('-'.repeat(46))
console.log(`  通过 ${pass} · 失败 ${fail}`)
console.log('='.repeat(46))
if (fail > 0) process.exit(1)

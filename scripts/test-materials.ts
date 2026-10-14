/**
 * 研讨材料（用户附上的文件）的离线回归
 *
 * 这一条链路此前是断的：`Topic.attachments` 在四处构造点恒为 `[]`，
 * 用户选了文件、模型只看得到一个文件名 ——「可溯源」的地基缺的就是这一块。
 * 现在它分成三段，每段都能单独静默退化：
 *
 * 1. **读**：只在主进程开场那一次读，六种读不进来的原因必须各有出口；
 * 2. **排**：API 通道发全文、网页通道逐字敲进站点输入框只能发节选，
 *    预算用尽时剩下的那份要**按名字说出来**，不能悄悄消失；
 * 3. **接**：材料得进参会者、基线、质询、主持四类 prompt，还要从界面真的传上来。
 *
 * 第 3 段最容易退化成「函数都在、就是没人调」，所以那里钉的是源码切片。
 *
 * 运行：npm run test:materials
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MATERIAL_COUNT_MAX,
  MATERIAL_FILE_BYTES_MAX,
  MATERIAL_FILE_CHARS_MAX,
  MATERIAL_WEB_CHARS_MAX,
  MATERIAL_WEB_PER_FILE_CHARS_MAX,
  extOf,
  looksBinary,
  materialNotices,
  renderMaterialBlock,
  renderMaterialExcerpt,
} from '../src/shared/materials'
import { readTopicMaterials } from '../src/main/agents/materials'
import type { Attachment, MaterialItem } from '../src/shared/types'

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

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
    console.log(`       ${(e as Error).message.split('\n').slice(0, 5).join('\n       ')}`)
  }
}

function count(hay: string, re: RegExp): number {
  const m = hay.match(new RegExp(re.source, 'g'))
  return m ? m.length : 0
}

function att(ref: string, over: Partial<Attachment> = {}): Attachment {
  return { id: `att_${path.basename(ref)}`, kind: 'file', name: path.basename(ref), ref, ...over }
}

/** 造一条已经读好的材料，用于只测排版而不碰盘 */
function item(name: string, text: string, over: Partial<MaterialItem> = {}): MaterialItem {
  return {
    id: name,
    name,
    ref: `/tmp/${name}`,
    status: 'read',
    text,
    bytes: Buffer.byteLength(text),
    truncated: false,
    ...over,
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-materials-'))

function write(name: string, content: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content, 'utf8')
  return p
}

function main(): void {
  console.log('\n── 材料：读取')

  it('普通文本读全，状态 read、字节数如实', () => {
    const p = write('spec.md', '# 标题\n正文两行\n第三行')
    const [m] = readTopicMaterials([att(p)])
    assert.equal(m.status, 'read')
    assert.equal(m.text, '# 标题\n正文两行\n第三行')
    assert.equal(m.bytes, Buffer.byteLength('# 标题\n正文两行\n第三行'))
    assert.equal(m.truncated, false)
    assert.equal(m.name, 'spec.md')
  })

  it('超过单份体积上限：一个字都不读，理由是 too-large', () => {
    const p = write('big.txt', 'a'.repeat(MATERIAL_FILE_BYTES_MAX + 1))
    const [m] = readTopicMaterials([att(p)])
    assert.equal(m.status, 'too-large')
    assert.equal(m.text, '')
    assert.ok(m.bytes !== null && m.bytes > MATERIAL_FILE_BYTES_MAX, '得把真实大小带回去，好让用户知道超了多少')
  })

  it('二进制后缀不按文字读：png/pdf/docx 一律 binary', () => {
    for (const name of ['shot.png', 'paper.pdf', 'deck.docx']) {
      const p = write(name, 'whatever')
      const [m] = readTopicMaterials([att(p)])
      assert.equal(m.status, 'binary', `${name} 应该判成二进制，而不是把乱码发给模型`)
      assert.equal(m.text, '')
    }
    assert.ok(looksBinary('a/b/x.PDF'), '后缀大小写要认')
    assert.ok(!looksBinary('a/b/x.txt'))
    assert.equal(extOf('a/b/x.Tar'), '.tar')
    assert.equal(extOf('noext'), '')
  })

  it('盘上没有：missing，不是崩', () => {
    const [m] = readTopicMaterials([att(path.join(dir, 'gone.txt'))])
    assert.equal(m.status, 'missing')
    assert.equal(m.bytes, null)
  })

  it('非绝对路径直接拒：这条 ref 来自渲染端，不能当成相对路径去猜', () => {
    const [m] = readTopicMaterials([att('notes/spec.md')])
    assert.equal(m.status, 'missing')
    assert.equal(m.text, '')
  })

  it('空文件与只含空白：empty', () => {
    const a = write('a.txt', '')
    const b = write('b.txt', '   \n\t  \n')
    const [x, y] = readTopicMaterials([att(a), att(b)])
    assert.equal(x.status, 'empty')
    assert.equal(y.status, 'empty', '只有空白的文件也算空 —— 发给模型只会让它对着空气论证')
  })

  it('目录与 link 类附件：unreadable（这里只管本地文档）', () => {
    const sub = path.join(dir, 'subdir')
    fs.mkdirSync(sub, { recursive: true })
    const [d] = readTopicMaterials([att(sub)])
    assert.equal(d.status, 'unreadable')
    const [l] = readTopicMaterials([att('https://example.com/a', { kind: 'link', name: 'a' })])
    assert.equal(l.status, 'unreadable')
  })

  it('单份排版上限：读全的字节里只截前一段，并标 truncated', () => {
    const p = write('long.txt', 'x'.repeat(MATERIAL_FILE_CHARS_MAX + 500))
    const [m] = readTopicMaterials([att(p)])
    assert.equal(m.status, 'read')
    assert.equal(m.text.length, MATERIAL_FILE_CHARS_MAX)
    assert.equal(m.truncated, true)
  })

  it('数量超上限：只取前 MATERIAL_COUNT_MAX 份', () => {
    const list = Array.from({ length: MATERIAL_COUNT_MAX + 3 }, (_, i) => att(write(`m${i}.txt`, `内容 ${i}`)))
    assert.equal(readTopicMaterials(list).length, MATERIAL_COUNT_MAX)
  })

  console.log('\n── 材料：排版（API 全文 / 网页节选 是两种交付）')

  it('没读到东西就是一段空：不许凭文件名编内容', () => {
    assert.equal(renderMaterialBlock([item('a.txt', '', { status: 'missing' })], 24_000), '')
    assert.equal(renderMaterialExcerpt([]), '')
  })

  it('API 块：带标题行、按选的顺序、名字和大小都在', () => {
    const block = renderMaterialBlock([item('spec.md', '第一段'), item('plan.md', '第二段')], 24_000)
    assert.match(block, /【材料 1 · spec\.md，\d+KB】/)
    assert.ok(block.indexOf('spec.md') < block.indexOf('plan.md'), '顺序要和人挑的顺序一致')
    assert.match(block, /【材料 2 · plan\.md/)
  })

  it('预算用尽：剩下的那份按名字列进【未送达的材料】，不静默消失', () => {
    const big = item('big.md', 'A'.repeat(4_000))
    const tail = item('tail.md', 'B'.repeat(2_000))
    const block = renderMaterialBlock([big, tail], 5_000)
    assert.ok(block.includes('A'.repeat(100)), '第一份应当进去了')
    assert.ok(!block.includes('B'.repeat(100)), '第二份超预算，不该出现在正文里')
    assert.match(block, /【未送达的材料】[\s\S]*tail\.md/, '但它必须被点名')
    assert.match(block, /不要凭文件名推测/)
  })

  it('截断过的材料在标题里说得出来', () => {
    const block = renderMaterialBlock([item('cut.md', 'A'.repeat(10), { truncated: true })], 24_000)
    assert.match(block, /已截断/)
  })

  it('网页节选：明写「全文没有送达」，每份不超过单份预算', () => {
    const text = 'A'.repeat(5_000)
    const block = renderMaterialExcerpt([item('a.md', text), item('b.md', 'B'.repeat(5_000))])
    assert.match(block, /全文没有送达/)
    assert.match(block, /（节选）/)
    const bodies = [...block.matchAll(/【材料 \d+ · [^】]*】\n([^\n]*)/g)].map((m) => m[1])
    assert.equal(bodies.length, 2)
    for (const b of bodies) {
      assert.ok(b.length <= MATERIAL_WEB_PER_FILE_CHARS_MAX, `节选 ${b.length} 字，超过每份上限`)
    }
    assert.ok(block.length <= MATERIAL_WEB_CHARS_MAX + 400, '整段要能敲进输入框')
  })

  it('网页节选：装不下的那份也要说明，不能说没列就不列', () => {
    const many = Array.from({ length: 8 }, (_, i) => item(`f${i}.md`, 'A'.repeat(MATERIAL_WEB_PER_FILE_CHARS_MAX)))
    const block = renderMaterialExcerpt(many)
    assert.match(block, /另有 \d+ 份材料因篇幅没有列出/)
  })

  console.log('\n── 材料：体检结果要说给人听')

  it('五种读不进来 + 截断，各出一句且带上文件名', () => {
    const cases: Array<[MaterialItem['status'], RegExp]> = [
      ['too-large', /超过单份上限/],
      ['binary', /乱码/],
      ['missing', /找不到了/],
      ['empty', /是空的/],
      ['unreadable', /读不出来/],
    ]
    for (const [status, re] of cases) {
      const notes = materialNotices([item('x.txt', '', { status, bytes: 300_000 })])
      assert.equal(notes.length, 1, `${status} 应该正好一句话`)
      assert.match(notes[0], /x\.txt/)
      assert.match(notes[0], re)
    }
    const tr = materialNotices([item('y.md', 'z'.repeat(10), { truncated: true })])
    assert.equal(tr.length, 1)
    assert.match(tr[0], /只取了前 \d+ 字/)
  })

  it('读全且没截断的，不产生任何提示：别把正常说成有问题', () => {
    assert.deepEqual(materialNotices([item('ok.md', '内容')]), [])
  })

  console.log('\n── 接线：三段都得有人调用，否则等于没做')

  const orc = read('src/main/orchestrator/orchestrator.ts')
  const api = read('src/main/agents/api-agent.ts')
  const web = read('src/main/agents/webview-agent.ts')
  const mainIdx = read('src/main/index.ts')
  const newsession = read('src/renderer/components/NewSession.tsx')
  const store = read('src/renderer/store.ts')
  const preload = read('src/preload/index.ts')

  it('编排器收下材料，四类 prompt 站点各一处不少', () => {
    assert.match(orc, /setMaterials\(items: MaterialItem\[\]\): void/, '编排器没有收下材料的入口')
    // 参会者发言、对辩、基线、核验质询 = 四处 TurnContext
    assert.equal(count(orc, /material: this\.materials/g), 4, 'TurnContext 上的 material 站点数变了')
    // 主持侧走内部文本装配：轮间小结、纪要、差异比对三处（按 emitted 那段标题数）
    assert.equal(count(orc, /材料：\\n\$\{this\.materialText\}/g), 3, '主持侧材料装配点数变了')
    assert.match(orc, /renderMaterialBlock\(this\.materials, MATERIAL_TURN_CHARS_MAX\)/)
  })

  it('API 通道发全文，网页通道只发节选：反过来就是把一轮拖成十几分钟', () => {
    assert.match(api, /renderMaterialBlock\(ctx\.material, MATERIAL_TURN_CHARS_MAX\)/)
    assert.match(web, /renderMaterialExcerpt\(ctx\.material\)/)
    assert.ok(!/renderMaterialBlock/.test(web), '网页通道不许发全文：prompt 是逐字敲进站点输入框的')
    assert.ok(!/renderMaterialExcerpt/.test(api), 'API 通道不该只拿节选：它是发出去的，给得起全文')
  })

  it('开场读一次盘，并把读不进来的原因带回给界面', () => {
    assert.match(mainIdx, /const materials = readTopicMaterials\(topic\.attachments\)/)
    assert.match(mainIdx, /orchestrator\.setMaterials\(materials\)/)
    assert.match(mainIdx, /return materialNotices\(materials\)/)
    assert.match(mainIdx, /const notices = await startSession/, 'session:start 要把材料体检透出去')
    // 重试路径也不能丢：它同样带着上一场的附件
    assert.match(mainIdx, /\.\.\.v\.notices, \.\.\.materialNotes/)
  })

  it('选择框只在主进程开：渲染层拿不到绝对路径，合并规则也只有一份', () => {
    assert.match(mainIdx, /ipcMain\.handle\('topic:pickFiles'/)
    assert.match(mainIdx, /properties: \['openFile', 'multiSelections'\]/)
    assert.match(preload, /pickTopicFiles/)
    // 已选清单交回主进程合并：界面自己 slice 一遍就会出现「两套上限」
    assert.match(newsession, /window\.torra\.pickTopicFiles\(s\.topicAttachments\)/)
    assert.ok(!/\.slice\(0, MATERIAL_COUNT_MAX\)/.test(newsession), '界面不许重做上限裁剪')
    assert.match(mainIdx, /if \(prior\.length >= MATERIAL_COUNT_MAX\) break/)
  })

  it('议题真的带上清单：attachments: [] 这一句就是整条链断掉的地方', () => {
    assert.match(newsession, /attachments: s\.topicAttachments/)
    assert.ok(!/attachments: \[\]/.test(newsession), 'NewSession 里还剩一句写死的空附件')
    assert.match(store, /topicAttachments: Attachment\[\]/)
    assert.match(store, /topicAttachments: \[\] as Attachment\[\]/)
  })

  it('入口校验认这份清单：ref 会被当成盘上路径去读，越界要退回', () => {
    const gate = mainIdx.slice(mainIdx.indexOf('function validateSessionInput'))
    const body = gate.slice(0, gate.indexOf('\n}\n'))
    assert.match(body, /atts\.length > MATERIAL_COUNT_MAX/)
    assert.match(body, /typeof x\.ref !== 'string'/)
    assert.match(body, /x\.kind !== 'file' && x\.kind !== 'link'/)
  })

  it('界面有话可说：胶囊、移除、体检提示三类节点都有样式', () => {
    const css = read('src/renderer/newsession.css')
    for (const cls of ['ns-mats', 'ns-mat-add', 'ns-mat-chips', 'ns-mat-chip', 'ns-mat-notes']) {
      assert.match(css, new RegExp(`\\.${cls} \\{`), `newsession.css 缺 .${cls}`)
      assert.match(newsession, new RegExp(`className="${cls}"`), `NewSession 里没用到 .${cls}`)
    }
    assert.match(newsession, /className="ns-mat-chip"/)
  })

  it('套件已挂进 npm test 链', () => {
    const pkg = JSON.parse(read('package.json'))
    assert.match(String(pkg.scripts['test:materials']), /scripts\/test-materials\.ts/, '缺独立脚本项')
    assert.match(String(pkg.scripts.test), /run-tests/, 'npm test 必须走 scripts/run-tests.js 汇总跑法')
  })

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`)
  if (fail > 0) process.exit(1)
}

main()

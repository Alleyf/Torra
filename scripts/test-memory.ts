/**
 * 记忆库层的离线回归（不联网、不下载、不启动 memvid）。
 *
 * 这一层有两类承诺，测试就按这两类分：
 *
 * 1. **纯函数的口径**：分块别把一条事实切成两半、元数据尾巴必须剥掉、
 *    维度不一致要报出「实际几维」而不是一句「检索失败」。这些是模型和用户
 *    唯一能看见的那几行字，错了不会崩，只会让人往错误的方向改配置。
 * 2. **清单与解释器**：kind=memory 的清单不接受 parameters（参数由 Torra 生成）、
 *    文件名不许带目录、确认默认放行但可收紧；runPlugin 在缺 query / 缺记忆服务时
 *    必须明确报错，不能静默返回空串假装查过了。
 *
 * 运行：npm run test:memory
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MEMORY_DIMS,
  MEMORY_FILE_RE,
  clampMemoryTopK,
  embeddingsEndpoint,
  isMemoryDims,
  isMemoryMode,
  memoryModelIdentity,
} from '../src/shared/memory'
import {
  buildPutManyRequests,
  chunkText,
  embedTexts,
  formatSearchText,
  frameSnippet,
  hitTitle,
  parseEmbeddingResponse,
  parseLexHits,
  parsePutResult,
  parseStats,
  parseVecHits,
  stripFrameMeta,
} from '../src/main/memory/store'
import {
  exeNameFor,
  extractTar,
  locateMemvid,
  managedDirFor,
  parseTar,
  platformPackage,
  safeEntryPath,
  tarballUrl,
} from '../src/main/memory/runtime'
import {
  MEMORY_TOOL_PARAMETERS,
  runPlugin,
  validateManifest,
  type PluginManifest,
} from '../src/main/assistant/plugins'

let pass = 0
let fail = 0

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
    console.log(`       ${(e as Error).message.split('\n')[0]}`)
  }
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'torra-memory-test-'))
}

function memoryManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'notes',
    label: '笔记库',
    description: '检索本地笔记',
    kind: 'memory',
    memory: { file: 'notes.mv2' },
    ...over,
  }
}

function manifestOf(raw: Record<string, unknown>, file = 'notes.plugin.json'): PluginManifest {
  const r = validateManifest(raw, file)
  assert.equal(r.ok, true, `清单应合法：${r.ok ? '' : r.errors.join('；')}`)
  return (r as { manifest: PluginManifest }).manifest
}

function errorsOf(raw: Record<string, unknown>, file = 'notes.plugin.json'): string[] {
  const r = validateManifest(raw, file)
  assert.equal(r.ok, false, '清单应判无效')
  return (r as { errors: string[] }).errors
}

/** 搭一个最小 ustar 头：parseTar 只读 size / typeflag / name / prefix，不校验 checksum */
function tarHeader(name: string, size: number, typeflag: string, prefix = ''): Buffer {
  const buf = Buffer.alloc(512)
  buf.write(name, 0, 100, 'utf8')
  buf.write('0000644\0', 100, 'ascii')
  buf.write('0000000\0', 108, 'ascii')
  buf.write('0000000\0', 116, 'ascii')
  buf.write(size.toString(8).padStart(11, '0'), 124, 11, 'ascii')
  buf.write('\0', 135, 1, 'ascii')
  buf.write('00000000000\0', 136, 12, 'ascii')
  buf.write(typeflag, 156, 1, 'ascii')
  buf.write('ustar\0', 257, 6, 'ascii')
  buf.write('00', 263, 2, 'ascii')
  if (prefix) buf.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const b of buf) sum += b
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return buf
}

function tarEntry(name: string, data: string, typeflag = '0', prefix = ''): Buffer {
  const body = Buffer.from(data, 'utf8')
  const pad = (512 - (body.length % 512)) % 512
  return Buffer.concat([tarHeader(name, body.length, typeflag, prefix), body, Buffer.alloc(pad)])
}

function paxRecord(target: string): string {
  const rest = ` path=${target}\n`
  // pax 记录前缀是「整条记录的长度」，解析器只用它锚定行首，取的是 path=
  const len = rest.length + 2
  return `${len}${rest}`
}

function runPluginMemory(params: Record<string, unknown>, ctx?: Parameters<typeof runPlugin>[2]) {
  const m = manifestOf(memoryManifest({ memory: { file: 'notes.mv2', topK: 3 } }))
  return runPlugin(m, params, ctx ?? { cwd: os.tmpdir(), secrets: () => null })
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n记忆库：契约与纯函数')

  await it('库文件名只认裸名 .mv2', () => {
    assert.equal(MEMORY_FILE_RE.test('notes.mv2'), true)
    assert.equal(MEMORY_FILE_RE.test('a.mv2'), true)
    assert.equal(MEMORY_FILE_RE.test('my-notes-2.mv2'), true)
    assert.equal(MEMORY_FILE_RE.test('../notes.mv2'), false)
    assert.equal(MEMORY_FILE_RE.test('a/notes.mv2'), false)
    assert.equal(MEMORY_FILE_RE.test('Notes.mv2'), false)
    assert.equal(MEMORY_FILE_RE.test('.mv2'), false)
    assert.equal(MEMORY_FILE_RE.test('notes.txt'), false)
    assert.equal(MEMORY_FILE_RE.test(`${'a'.repeat(64)}.mv2`), false)
  })

  await it('维度 → 模型身份覆盖全部五项，未知维度回落到 1536 那档', () => {
    assert.equal(memoryModelIdentity(384), 'bge-small')
    assert.equal(memoryModelIdentity(768), 'bge-base')
    assert.equal(memoryModelIdentity(1024), 'gte-large')
    assert.equal(memoryModelIdentity(1536), 'openai-small')
    assert.equal(memoryModelIdentity(3072), 'openai')
    assert.equal(memoryModelIdentity(999), 'openai-small')
    assert.deepEqual([...MEMORY_DIMS], [384, 768, 1024, 1536, 3072])
    assert.equal(isMemoryDims(768), true)
    assert.equal(isMemoryDims(512), false)
    assert.equal(isMemoryDims('768'), false)
  })

  await it('嵌入地址归一：拼 /embeddings、去尾斜杠、不重复叠加', () => {
    assert.equal(embeddingsEndpoint(''), '')
    assert.equal(embeddingsEndpoint('   '), '')
    assert.equal(embeddingsEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/embeddings')
    assert.equal(embeddingsEndpoint('https://api.openai.com/v1/'), 'https://api.openai.com/v1/embeddings')
    assert.equal(embeddingsEndpoint('https://x.dev/v1/embeddings'), 'https://x.dev/v1/embeddings')
    assert.equal(embeddingsEndpoint('https://x.dev/v1/EMBEDDINGS/'), 'https://x.dev/v1/EMBEDDINGS')
  })

  await it('topK 夹在 1..20，非数字回落到默认值', () => {
    assert.equal(clampMemoryTopK(0), 1)
    assert.equal(clampMemoryTopK(-3), 1)
    assert.equal(clampMemoryTopK(21), 20)
    assert.equal(clampMemoryTopK(3.4), 3)
    assert.equal(clampMemoryTopK(undefined), 5)
    assert.equal(clampMemoryTopK('7'), 5)
    assert.equal(clampMemoryTopK(Number.NaN, 9), 9)
    assert.equal(clampMemoryTopK(undefined, 3), 3)
  })

  await it('模式判定只认 auto / lex / sem', () => {
    assert.equal(isMemoryMode('auto'), true)
    assert.equal(isMemoryMode('lex'), true)
    assert.equal(isMemoryMode('sem'), true)
    assert.equal(isMemoryMode('keyword'), false)
    assert.equal(isMemoryMode(undefined), false)
  })

  console.log('\n记忆库：分块与文本清洗')

  await it('空文本、纯空白返回空数组；CRLF 归一', () => {
    assert.deepEqual(chunkText(''), [])
    assert.deepEqual(chunkText('   \n\n  '), [])
    assert.deepEqual(chunkText('a\r\n\r\nb'), ['a\n\nb'])
  })

  await it('短段落合并到一块，保留段落分隔', () => {
    const chunks = chunkText('第一段。\n\n第二段。')
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0], '第一段。\n\n第二段。')
  })

  await it('长内容按上限切块，且相邻块有重叠', () => {
    const text = Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 段：${'内容'.repeat(60)}`).join('\n\n')
    const chunks = chunkText(text, { maxChars: 200, overlap: 40 })
    assert.ok(chunks.length > 1, '应该切成多块')
    for (const c of chunks) {
      assert.ok(c.length <= 200 + 40 + 2, `单块超长（${c.length}）`)
    }
    const tail = chunks[0]!.slice(-40)
    assert.ok(chunks[1]!.startsWith(tail), '第二块应以上一块的尾部重叠开头')
  })

  await it('overlap 被限制在 max/4 以内，max 有 200 下限', () => {
    const text = `${'甲'.repeat(900)}`
    const chunks = chunkText(text, { maxChars: 100, overlap: 9999 })
    assert.ok(chunks.length >= 4, `应切成多块，实际 ${chunks.length}`)
    for (const c of chunks) assert.ok(c.length <= 200 + 50 + 2, `单块超长（${c.length}）`)
  })

  await it('超长且无句末标点的段落被硬切，不产生无限大的块', () => {
    const chunks = chunkText('x'.repeat(1000), { maxChars: 300, overlap: 0 })
    assert.ok(chunks.every((c) => c.length <= 300), `硬切后仍超长：${Math.max(...chunks.map((c) => c.length))}`)
    assert.ok(chunks.length >= 4)
  })

  await it('剥掉 extractous 元数据尾巴，正文里同样的词不受影响', () => {
    const frame = '正文第一句。\n\n正文第二句。\nextractous_metadata: {"a":1}\nfoo'
    assert.equal(stripFrameMeta(frame), '正文第一句。\n\n正文第二句。')
    const onlyTitle = '内容在这里。\ntitle: 我的标题'
    assert.equal(stripFrameMeta(onlyTitle), '内容在这里。')
    const memvidKey = '内容。\nmemvid.frame_id: 3'
    assert.equal(stripFrameMeta(memvidKey), '内容。')
    assert.equal(stripFrameMeta('正文里提到 extractous_metadata: 这个词'), '正文里提到 extractous_metadata: 这个词')
  })

  await it('片段折叠空白并按上限截断加省略号', () => {
    assert.equal(frameSnippet('  a\n\nb   c  '), 'a b c')
    const long = 'x'.repeat(600)
    const s = frameSnippet(long, 100)
    assert.equal(s.length, 101)
    assert.ok(s.endsWith('…'))
    assert.equal(frameSnippet('短', 100), '短')
  })

  await it('命中标题优先取元数据里的 title 行', () => {
    assert.equal(hitTitle('正文内容。\ntitle: 发布计划'), '发布计划')
    assert.equal(hitTitle('第一句标题。 后面还有别的。'), '第一句标题。')
    assert.equal(hitTitle('没有句号的一行文字'), '没有句号的一行文字')
    assert.equal(hitTitle(''), '（无标题）')
    const longFirst = `${'头'.repeat(80)}。`
    assert.equal(hitTitle(longFirst).length, 60, '没有句读时按 60 字截断')
  })

  console.log('\n记忆库：解析与排版')

  await it('stats 的 summary 原样保留，读不出就留空', () => {
    assert.deepEqual(parseStats({ summary: { frames: '2 total (2 active)', usage: '54KB' } }), {
      frames: '2 total (2 active)',
      usage: '54KB',
    })
    assert.deepEqual(parseStats(null), { frames: undefined, usage: undefined })
    assert.deepEqual(parseStats({ summary: { frames: 2 } }), { frames: undefined, usage: undefined })
  })

  await it('put-many 请求：多块带序号、标签沿用、有向量才带 embedding', () => {
    const withVec = buildPutManyRequests({
      title: '周报',
      tags: ['工作'],
      chunks: ['甲', '乙'],
      vectors: [
        [1, 2],
        [3, 4],
      ],
      dims: 1536,
    })
    assert.equal(withVec.length, 2)
    assert.equal(withVec[0]!.title, '周报 · 1/2')
    assert.equal(withVec[1]!.title, '周报 · 2/2')
    assert.deepEqual(withVec[0]!.tags, ['工作'])
    assert.deepEqual(withVec[0]!.embedding, [1, 2])

    const noVec = buildPutManyRequests({ title: '单块', tags: [], chunks: ['只有一块'], vectors: null, dims: 1536 })
    assert.equal(noVec[0]!.title, '单块')
    assert.equal('embedding' in noVec[0]!, false, '没有向量时不能声明 embedding')
  })

  await it('put 结果计数：非 JSON 形状按 0', () => {
    assert.deepEqual(parsePutResult({ count: 3 }), { count: 3 })
    assert.deepEqual(parsePutResult({}), { count: 0 })
    assert.deepEqual(parsePutResult(null), { count: 0 })
  })

  await it('vec-search 裸数组解析：跳过缺 frame_id / 空 preview 的行', () => {
    const hits = parseVecHits([
      { frame_id: 0, distance: 0.25, preview: '甲' },
      { frame_id: -1, distance: 0.1, preview: '坏' },
      { frame_id: 2, distance: 0.5, preview: '' },
      { distance: 0.5, preview: '缺 id' },
      { frame_id: 3, distance: 'x', preview: '乙' },
    ])
    assert.equal(hits.length, 2)
    assert.deepEqual(hits[0], { frameId: 0, distance: 0.25, preview: '甲' })
    assert.deepEqual(hits[1], { frameId: 3, distance: 1, preview: '乙' })
    assert.deepEqual(parseVecHits({ hits: [] }), [])
  })

  await it('find 信封解析：跳过空 text，score 缺失按 0', () => {
    const hits = parseLexHits({
      metadata: { total_hits: 2 },
      hits: [
        { title: 'A', text: '内容甲', score: 0.75 },
        { title: 'B', text: '' },
        { text: '内容乙' },
      ],
    })
    assert.equal(hits.length, 2)
    assert.deepEqual(hits[0], { title: 'A', text: '内容甲', score: 0.75 })
    assert.deepEqual(hits[1], { title: '', text: '内容乙', score: 0 })
    assert.deepEqual(parseLexHits(null), [])
    assert.deepEqual(parseLexHits({ hits: 'nope' }), [])
  })

  await it('零命中时区分两种原因：中文关键字 vs 语义距离', () => {
    const lex = formatSearchText('notes.mv2', '缓存', 'lex', [])
    assert.ok(lex.includes('没有查到'), lex)
    assert.ok(lex.includes('中文'), '关键词零命中要说明中文分词问题')
    assert.ok(lex.includes('语义检索'), '并给出下一步')
    const vec = formatSearchText('notes.mv2', '缓存', 'vec', [])
    assert.ok(vec.includes('没有足够接近的片段'), vec)
    assert.equal(vec.includes('中文查询基本命不中'), false, '语义检索不该背这口锅')
  })

  await it('结果排版区分相似度与关键词分，并按上限截断', () => {
    const hits = [
      { title: '发布计划', snippet: '九月上线', score: 0.9123, via: 'vec' as const },
      { title: '备忘', snippet: '买咖啡', score: 0.5, via: 'vec' as const },
    ]
    const text = formatSearchText('notes.mv2', '上线', 'vec', hits)
    assert.ok(text.startsWith('记忆库 notes.mv2 命中 2 条（语义检索）：'), text)
    assert.ok(text.includes('[1] 发布计划（相似度 0.912）'), text)
    assert.ok(text.includes('    九月上线'), text)

    const lex = formatSearchText('notes.mv2', 'deploy', 'lex', [{ title: 'A', snippet: 's', score: 2, via: 'lex' }])
    assert.ok(lex.includes('关键词分 2'), lex)
    assert.equal(lex.includes('相似度'), false)

    const clipped = formatSearchText('notes.mv2', 'q', 'vec', hits, 20)
    assert.equal(clipped.length, 21)
    assert.ok(clipped.endsWith('…'))
  })

  console.log('\n记忆库：嵌入端点')

  await it('嵌入响应两种形态：data[] 与裸 embedding', () => {
    assert.deepEqual(parseEmbeddingResponse({ data: [{ embedding: [1, 2] }] }), [[1, 2]])
    assert.deepEqual(parseEmbeddingResponse({ embedding: [3, 4] }), [[3, 4]])
    assert.throws(() => parseEmbeddingResponse(null), /不是 JSON 对象/)
    assert.throws(() => parseEmbeddingResponse({ data: [] }), /没有 data/)
    assert.throws(() => parseEmbeddingResponse({ data: [{ embedding: [] }] }), /第 1 条没有向量/)
    assert.throws(() => parseEmbeddingResponse({ data: [{ embedding: [1, 'x'] }] }), /非数字分量/)
    assert.throws(() => parseEmbeddingResponse({ data: [{ embedding: [1, Number.NaN] }] }), /非数字分量/)
  })

  await it('embedTexts 打到 /embeddings：带 model/input 与 Bearer', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 })
    }) as unknown as typeof fetch
    const vecs = await embedTexts(
      { baseUrl: 'https://api.test/v1/', model: 'embed-3', dims: 3, apiKey: 'sk-test' },
      ['hello'],
      { fetchImpl },
    )
    assert.deepEqual(vecs, [[0.1, 0.2, 0.3]])
    assert.equal(calls[0]!.url, 'https://api.test/v1/embeddings')
    assert.equal(calls[0]!.init.method, 'POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    assert.equal(headers.authorization, 'Bearer sk-test')
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { model: 'embed-3', input: ['hello'] })
  })

  await it('没有 Key 就不发 Authorization，空文本一次请求都不发', async () => {
    let seen: RequestInit | null = null
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = init
      return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 })
    }) as unknown as typeof fetch
    await embedTexts({ baseUrl: 'https://api.test/v1', model: 'm', dims: 1, apiKey: null }, ['x'], { fetchImpl })
    assert.equal((seen!.headers as Record<string, string>).authorization, undefined)

    let called = 0
    const spy = (async () => {
      called++
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    assert.deepEqual(await embedTexts({ baseUrl: 'https://api.test/v1', model: 'm', dims: 1, apiKey: null }, [], { fetchImpl: spy }), [])
    assert.equal(called, 0)
  })

  await it('端点缺失、HTTP 失败、条数不符、维度不符都说清原因', async () => {
    await assert.rejects(
      embedTexts({ baseUrl: '', model: 'm', dims: 3, apiKey: null }, ['x'], {}),
      /还没有配置嵌入端点/,
    )

    const http500 = (async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof fetch
    await assert.rejects(
      embedTexts({ baseUrl: 'https://api.test/v1', model: 'm', dims: 3, apiKey: null }, ['x'], { fetchImpl: http500 }),
      /HTTP 500/,
    )

    const notJson = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    await assert.rejects(
      embedTexts({ baseUrl: 'https://api.test/v1', model: 'm', dims: 3, apiKey: null }, ['x'], { fetchImpl: notJson }),
      /不是 JSON/,
    )

    const wrongCount = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 })) as unknown as typeof fetch
    await assert.rejects(
      embedTexts({ baseUrl: 'https://api.test/v1', model: 'm', dims: 3, apiKey: null }, ['a', 'b'], { fetchImpl: wrongCount }),
      /返回 1 条向量，期望 2 条/,
    )

    const wrongDims = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3, 4] }] }), { status: 200 })) as unknown as typeof fetch
    await assert.rejects(
      embedTexts({ baseUrl: 'https://api.test/v1', model: 'm', dims: 3, apiKey: null }, ['a'], { fetchImpl: wrongDims }),
      (e: Error) => {
        assert.ok(e.message.includes('嵌入维度不匹配'), e.message)
        assert.ok(e.message.includes('返回 4 维'), e.message)
        assert.ok(e.message.includes('配置里写的是 3 维'), e.message)
        return true
      },
    )
  })

  console.log('\n记忆库：运行时定位与解包')

  await it('可执行文件名与平台包名', () => {
    assert.equal(exeNameFor('win32'), 'memvid.exe')
    assert.equal(exeNameFor('linux'), 'memvid')
    assert.equal(platformPackage('win32', 'x64'), '@memvid/cli-win32-x64')
    assert.equal(platformPackage('linux', 'x64'), '@memvid/cli-linux-x64')
    assert.equal(platformPackage('darwin', 'arm64'), '@memvid/cli-darwin-arm64')
    assert.equal(platformPackage('darwin', 'x64'), '@memvid/cli-darwin-x64')
    assert.equal(platformPackage('win32', 'arm64'), null)
    assert.equal(platformPackage('freebsd', 'x64'), null)
    assert.equal(
      tarballUrl('@memvid/cli-win32-x64', '2.0.160'),
      'https://registry.npmjs.org/@memvid/cli-win32-x64/-/cli-win32-x64-2.0.160.tgz',
    )
    assert.ok(managedDirFor('/data/memory/bin', '@memvid/cli-win32-x64', '2.0.160').endsWith(path.join('cli-win32-x64-2.0.160')))
  })

  await it('手填的运行时：存在就用，不存在要说出来', async () => {
    const dir = tmpDir()
    try {
      const exe = path.join(dir, 'memvid.exe')
      writeFileSync(exe, 'fake')
      const hit = await locateMemvid({ configured: exe, managedDir: path.join(dir, 'managed'), platform: 'win32' })
      assert.deepEqual(hit, { path: exe, source: 'configured' })

      const missing = path.join(dir, 'nope.exe')
      const bad = await locateMemvid({ configured: missing, managedDir: path.join(dir, 'managed'), platform: 'win32' })
      assert.equal(bad?.configuredMissing, missing, '填错的路径必须回传，不能悄悄回落')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('tar 解析：ustar prefix、pax 覆盖路径、目录与链接分类', () => {
    const tar = Buffer.concat([
      tarEntry('PaxHeaders/x', paxRecord('package/memvid.exe'), 'x'),
      tarEntry('truncated', 'BIN', '0'),
      tarEntry('a.txt', 'hello', '0', 'package'),
      tarEntry('package/', '', '5'),
      tarEntry('link', 'target', '2'),
      Buffer.alloc(1024),
    ])
    const entries = parseTar(tar)
    const files = entries.filter((e) => e.type === 'file')
    assert.equal(files.length, 2)
    assert.equal(files[0]!.name, 'package/memvid.exe', 'pax 的 path= 应覆盖头里的截断名')
    assert.equal(files[0]!.data.toString('utf8'), 'BIN')
    assert.equal(files[1]!.name, 'package/a.txt')
    assert.ok(entries.some((e) => e.type === 'dir' && e.name === 'package/'))
    assert.ok(entries.some((e) => e.type === 'other' && e.name === 'link'), '链接不能被当成普通文件还原')
  })

  await it('解包路径不许越界', () => {
    const dir = path.resolve(os.tmpdir(), 'dest')
    assert.equal(safeEntryPath(dir, 'package/a.txt'), path.join(dir, 'package', 'a.txt'))
    assert.equal(safeEntryPath(dir, './package/./a.txt'), path.join(dir, 'package', 'a.txt'))
    assert.equal(safeEntryPath(dir, '../evil.txt'), null)
    assert.equal(safeEntryPath(dir, 'a/../../evil.txt'), null)
    assert.equal(safeEntryPath(dir, '/abs/evil.txt'), null)
    assert.equal(safeEntryPath(dir, 'C:/evil.txt'), null)
    assert.equal(safeEntryPath(dir, ''), null)
  })

  await it('extractTar 写文件、统计字节；越界条目整包拒绝', async () => {
    const dir = tmpDir()
    try {
      const dest = path.join(dir, 'out')
      const tar = Buffer.concat([tarEntry('package/', '', '5'), tarEntry('package/memvid.exe', 'MZ', '0')])
      const r = await extractTar(tar, dest)
      assert.equal(r.files, 1)
      assert.equal(r.bytes, 2)

      await assert.rejects(
        extractTar(Buffer.concat([tarEntry('../evil.txt', 'x', '0')]), path.join(dir, 'bad')),
        /越界路径/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log('\n记忆库：插件清单与解释器')

  await it('kind=memory 合法清单：参数由 Torra 生成，确认默认放行', () => {
    const m = manifestOf(memoryManifest())
    assert.equal(m.kind, 'memory')
    assert.deepEqual(m.memory, { file: 'notes.mv2', mode: 'auto', topK: 5 })
    assert.deepEqual(m.parameters, MEMORY_TOOL_PARAMETERS)
    assert.equal(m.confirm, 'never')
    assert.equal(m.enabled, true)
    assert.equal(m.label, '笔记库')
  })

  await it('kind=memory 的 mode / topK / confirm 可写，越界就报错', () => {
    const m = manifestOf(memoryManifest({ memory: { file: 'notes.mv2', mode: 'sem', topK: 20 }, confirm: 'always' }))
    assert.deepEqual(m.memory, { file: 'notes.mv2', mode: 'sem', topK: 20 })
    assert.equal(m.confirm, 'always')

    assert.ok(errorsOf(memoryManifest({ memory: { file: 'notes.mv2', mode: 'fuzzy' } })).some((e) => e.includes('memory.mode')))
    assert.ok(errorsOf(memoryManifest({ memory: { file: 'notes.mv2', topK: 0 } })).some((e) => e.includes('memory.topK')))
    assert.ok(errorsOf(memoryManifest({ memory: { file: 'notes.mv2', topK: 21 } })).some((e) => e.includes('memory.topK')))
    assert.ok(errorsOf(memoryManifest({ memory: { file: 'notes.mv2', topK: 2.5 } })).some((e) => e.includes('memory.topK')))
  })

  await it('kind=memory 拒绝自填 parameters 与带目录的库名', () => {
    const withParams = errorsOf(memoryManifest({ parameters: { type: 'object', properties: { q: { type: 'string' } } } }))
    assert.ok(withParams.some((e) => e.includes('不接受 parameters')), withParams.join('；'))

    for (const file of ['../notes.mv2', 'sub/notes.mv2', 'notes.db', 'Notes.mv2', '']) {
      const errs = errorsOf(memoryManifest({ memory: { file } }))
      assert.ok(errs.some((e) => e.includes('memory.file')), `${file || '(空)'} 应被拒：${errs.join('；')}`)
    }

    assert.ok(errorsOf(memoryManifest({ kind: 'memory', memory: undefined })).some((e) => e.includes('需要 memory 段')))
  })

  await it('runPlugin(kind=memory)：缺 query / 缺记忆服务都明确报错', async () => {
    await assert.rejects(runPluginMemory({}), /缺少 query 参数/)
    await assert.rejects(runPluginMemory({ query: '   ' }), /缺少 query 参数/)
    await assert.rejects(
      runPluginMemory({ query: '缓存' }, { cwd: os.tmpdir(), secrets: () => null }),
      /需要记忆服务/,
    )
  })

  await it('runPlugin(kind=memory)：透传 file/mode/topK，裁剪过长结果', async () => {
    const seen: { file?: string; query?: string; topK?: number; mode?: string } = {}
    const longText = 'x'.repeat(9000)
    const r = await runPluginMemory({ query: '  缓存  ', topK: 99 }, {
      cwd: os.tmpdir(),
      secrets: () => null,
      memory: {
        search: async (input) => {
          seen.file = input.file
          seen.query = input.query
          seen.topK = input.topK
          seen.mode = input.mode
          return { ok: true, hits: [], mode: 'lex', text: longText }
        },
      },
    })
    assert.equal(seen.file, 'notes.mv2')
    assert.equal(seen.query, '缓存', 'query 两端的空白要被去掉')
    assert.equal(seen.topK, 20, '模型传的 topK 上限 20')
    assert.equal(seen.mode, 'auto', '清单声明的 auto 要透传')
    assert.equal(r.text.length, 8001)
    assert.ok(r.text.endsWith('…'))
    assert.equal(r.details.kind, 'memory')
    assert.equal(r.details.bytes, 9000)

    const dflt: { topK?: number } = {}
    await runPluginMemory({ query: 'x' }, {
      cwd: os.tmpdir(),
      secrets: () => null,
      memory: {
        search: async (input) => {
          dflt.topK = input.topK
          return { ok: true, hits: [], mode: 'lex', text: 'ok' }
        },
      },
    })
    assert.equal(dflt.topK, 3, '没传 topK 时用清单里的默认值')
  })

  await it('runPlugin(kind=memory)：检索失败把原因带回异常', async () => {
    await assert.rejects(
      runPluginMemory({ query: 'x' }, {
        cwd: os.tmpdir(),
        secrets: () => null,
        memory: {
          search: async () => ({ ok: false, reason: '没有叫 notes.mv2 的记忆库。现在有：other.mv2', hits: [], mode: 'lex', text: '' }),
        },
      }),
      /没有叫 notes\.mv2 的记忆库。现在有：other\.mv2/,
    )
  })

  await it('清单落盘后能被 load 回来（kind=memory 的往返）', async () => {
    const { loadPluginManifests, writePluginManifest } = await import('../src/main/assistant/plugins')
    const dir = tmpDir()
    try {
      const w = writePluginManifest(dir, memoryManifest())
      assert.equal(w.ok, true, w.reason)
      const loaded = loadPluginManifests(dir)
      assert.equal(loaded.invalid.length, 0, loaded.invalid.map((i) => i.errors.join('；')).join(' | '))
      assert.equal(loaded.manifests.length, 1)
      assert.equal(loaded.manifests[0]!.kind, 'memory')
      assert.deepEqual(loaded.manifests[0]!.memory, { file: 'notes.mv2', mode: 'auto', topK: 5 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log(`${'-'.repeat(46)}\n${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

/**
 * 技能资源库的离线验证：tar 解析、路径安全、来源识别、技能发现。
 * 不真拉 GitHub —— 失败路径用不存在的仓库名验证错误口径。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addSkillSource,
  importRepoSkill,
  makeSourceId,
  parseTar,
  queryRepoSkills,
  removeSkillSource,
  viewSkillRepo,
} from '../src/main/assistant/skill-repo'

let pass = 0
const failed: string[] = []
async function it(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    pass++
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    failed.push(`${name}: ${(e as Error).message}`)
    console.log(`  [FAIL] ${name}\n         ${(e as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// tar 解析：手工构造 ustar 流
// ---------------------------------------------------------------------------

function tarHeader(name: string, size: number, typeflag: string): Buffer {
  const h = Buffer.alloc(512)
  h.write(name.slice(0, 100), 0, 'utf-8')
  h.write('000644\0', 100, 'utf-8')
  h.write('000000\0', 108, 'utf-8')
  h.write('000000\0', 116, 'utf-8')
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf-8')
  h.write('00000000000', 136, 'utf-8')
  h.write(typeflag, 156, 'utf-8')
  h.write('ustar\0', 257, 'utf-8')
  h.write('00', 263, 'utf-8')
  return h
}

function tarEntry(name: string, content: string, typeflag = '0'): Buffer {
  const parts: Buffer[] = [tarHeader(name, Buffer.byteLength(content), typeflag)]
  if (typeflag !== '5') {
    const data = Buffer.from(content, 'utf-8')
    parts.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  return Buffer.concat(parts)
}

async function main() {
  await it('tar 解析：普通文件与目录条目', () => {
    const buf = Buffer.concat([
      tarEntry('repo-abc1234/SKILL.md', '---\nname: a\n---'),
      tarEntry('repo-abc1234/skills/x/', '', '5'),
      tarEntry('repo-abc1234/skills/x/SKILL.md', '---\nname: x\ndescription: hi\n---'),
      Buffer.alloc(1024),
    ])
    const entries = parseTar(buf)
    assert.equal(entries.length, 3)
    assert.equal(entries[0].kind, 'file')
    assert.equal(entries[0].size, 15)
    assert.equal(entries[2].name, 'repo-abc1234/skills/x/SKILL.md')
  })

  await it('tar 解析：prefix 字段拼进长名', () => {
    const h = tarHeader('very-long-name.md', 5, '0')
    h.write('long-prefix-dir', 345, 'utf-8')
    const buf = Buffer.concat([h, Buffer.from('hello'), Buffer.alloc(507), Buffer.alloc(1024)])
    const entries = parseTar(buf)
    assert.equal(entries[0].name, 'long-prefix-dir/very-long-name.md')
  })

  await it('tar 解析：GNU 长名（typeflag L）跟随真实条目', () => {
    const longName = 'a'.repeat(150) + '.md'
    const buf = Buffer.concat([
      tarEntry('././@LongLink', longName + '\0', 'L'),
      (() => {
        const h = tarHeader('truncated-name', longName.length, '0')
        return Buffer.concat([h, Buffer.from('world'), Buffer.alloc(505)])
      })(),
      Buffer.alloc(1024),
    ])
    const entries = parseTar(buf)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, longName)
  })

  await it('makeSourceId：github 与 local 前缀', () => {
    assert.equal(makeSourceId('github', 'vercel-labs/agent-browser'), 'github:vercel-labs/agent-browser')
    assert.equal(makeSourceId('local', 'C:\\x\\y'), 'local:C:\\x\\y')
  })

  // -----------------------------------------------------------------------
  // 本地来源端到端：登记 → 缓存 → 发现 → 导入 → 移除
  // -----------------------------------------------------------------------

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'torra-repo-test-'))
  try {
    const srcDir = path.join(tmp, 'source')
    const skillA = path.join(srcDir, 'alpha', 'SKILL.md')
    fs.mkdirSync(path.dirname(skillA), { recursive: true })
    fs.writeFileSync(skillA, '---\nname: alpha\ndescription: 测试技能 A 的说明\n---\n# body\n')
    const skillB = path.join(srcDir, 'docs', 'beta.md')
    fs.mkdirSync(path.dirname(skillB), { recursive: true })
    fs.writeFileSync(skillB, '---\nname: beta\ndescription: 单文件技能 B\n---\n')
    fs.writeFileSync(path.join(srcDir, 'README.md'), '没有 frontmatter 的普通文档，不该被收进资源库')

    const repoDir = path.join(tmp, 'repo')
    const skillsDir = path.join(tmp, 'torra-skills')

    await it('本地来源：登记 + 缓存 + 发现 2 条', async () => {
      const r = await addSkillSource({ repoDir, skillsDir, input: srcDir })
      assert.equal(r.ok, true, r.reason)
      assert.equal(r.addedSkills, 2)
    })

    await it('view：来源与技能都带 name/description，README 不收', async () => {
      const v = await viewSkillRepo({ repoDir, skillsDir })
      assert.equal(v.ok, true)
      assert.equal(v.sources.length, 1)
      assert.equal(v.total, 2)
      const page = await queryRepoSkills({ repoDir, skillsDir, query: { offset: 0, limit: 100 } })
      assert.equal(page.rows.length, 2)
      const alpha = page.rows.find((s) => s.name === 'alpha')
      assert.ok(alpha, '目录型技能在列')
      assert.equal(alpha!.description, '测试技能 A 的说明')
      assert.ok(!page.rows.some((s) => s.name.includes('README')), 'README 不当技能')
      assert.equal(v.updates[0].upToDate, true, '刚缓存的来源应当是最新')
    })

    await it('导入：目录型 junction 指向缓存，单文件复制出 SKILL.md', async () => {
      const page = await queryRepoSkills({ repoDir, skillsDir, query: { offset: 0, limit: 100 } })
      const alpha = page.rows.find((s) => s.name === 'alpha')!
      const beta = page.rows.find((s) => s.name === 'beta')!
      const r1 = await importRepoSkill({ repoDir, skillsDir, key: alpha.key })
      assert.equal(r1.ok, true, r1.reason)
      const linked = fs.realpathSync(path.join(skillsDir, r1.linkName!))
      assert.ok(fs.existsSync(path.join(linked, 'SKILL.md')))
      const r2 = await importRepoSkill({ repoDir, skillsDir, key: beta.key })
      assert.equal(r2.ok, true, r2.reason)
      assert.ok(fs.existsSync(path.join(skillsDir, r2.linkName!, 'SKILL.md')), '单文件复制出 SKILL.md')
    })

    await it('view 导入后：imported 与 linkName 都标上', async () => {
      const v = await viewSkillRepo({ repoDir, skillsDir })
      assert.equal(v.ok, true)
      const page = await queryRepoSkills({ repoDir, skillsDir, query: { offset: 0, limit: 100 } })
      const importedOnes = page.rows.filter((s) => s.imported)
      assert.equal(importedOnes.length, 2)
      assert.ok(importedOnes.every((s) => s.linkName))
    })

    await it('key 穿越：带 .. 的 key 拒绝', async () => {
      const r = await importRepoSkill({ repoDir, skillsDir, key: 'local:x::../../etc/passwd' })
      assert.equal(r.ok, false)
    })

    await it('移除来源：缓存与登记清掉', async () => {
      const v = await viewSkillRepo({ repoDir, skillsDir })
      const r = await removeSkillSource({ repoDir, skillsDir, sourceId: v.sources[0].id })
      assert.equal(r.ok, true)
      const v2 = await viewSkillRepo({ repoDir, skillsDir })
      assert.equal(v2.sources.length, 0)
      assert.equal(v2.total, 0)
      const page = await queryRepoSkills({ repoDir, skillsDir, query: { offset: 0, limit: 100 } })
      assert.equal(page.rows.length, 0)
    })

    await it('无效输入：识别不了的来源拒绝', async () => {
      const r = await addSkillSource({ repoDir, skillsDir, input: 'not a source' })
      assert.equal(r.ok, false)
      assert.match(r.reason ?? '', /识别不了|不存在/)
    })

    await it('GitHub 失败路径：不存在的仓库返回明确原因', async () => {
      const r = await addSkillSource({ repoDir, skillsDir, input: 'nobody/no-such-repo-xyz-404' })
      assert.equal(r.ok, false)
      assert.ok((r.reason ?? '').length > 0)
    })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  console.log(`\n通过 ${pass} · 失败 ${failed.length}`)
  if (failed.length > 0) {
    for (const f of failed) console.error(`! ${f}`)
    process.exit(1)
  }
}

void main()

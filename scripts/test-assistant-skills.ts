/**
 * 技能扫描与软链接导入的离线回归（不联网、不需要 Electron）
 *
 * 这里验的是「点一下按钮会发生什么」里最容易出事的三件事：
 *
 * 1. 发现规则要和 pi 一致 —— 界面上列出来了、导入成功了、助手却没加载，是最难查的错位；
 * 2. 导入只在 Torra 的技能目录里写链接，源目录一个字节都不动；
 * 3. 移除只能移除链接。误把 rm -rf 打在指向 ~/.agents/skills 的 junction 上，
 *    丢的是用户给所有 agent 应用共用的技能库。
 *
 * 运行：npm run test:assistant-skills
 */

import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'

import os from 'node:os'
import path from 'node:path'
import { parseFrontmatter, removeSkill, safeLinkName, scanSkills, importSkill } from '../src/main/assistant/skills'

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

/** Windows 上用 junction（免特权），其它平台用目录符号链接 */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

/** 这台机器允不允许建目录链接：不允许时那几条依赖链接的断言就跳过，别报成假失败 */
const LINKS_WORK = (() => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'torra-link-probe-'))
  try {
    mkdirSync(path.join(d, 'src'), { recursive: true })
    symlinkSync(path.join(d, 'src'), path.join(d, 'link'), LINK_TYPE as 'junction')
    return lstatSync(path.join(d, 'link')).isSymbolicLink()
  } catch {
    return false
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})()

function linkDir(from: string, to: string): void {
  mkdirSync(path.dirname(from), { recursive: true })
  if (!LINKS_WORK) return
  symlinkSync(to, from, LINK_TYPE as 'junction')
}

/** 造一个技能目录；desc 给 null 就是缺 description（pi 会直接不加载） */
function mkSkill(dir: string, opts: { desc?: string | null; fmName?: string } = {}): string {
  const name = path.basename(dir)
  mkdirSync(dir, { recursive: true })
  const desc = opts.desc === null ? '' : (opts.desc ?? `做 ${name} 用的技能`)
  const lines = ['---', ...(opts.fmName ? [`name: ${opts.fmName}`] : []), ...(desc ? [`description: ${desc}`] : []), '---', `# ${name}`]
  writeFileSync(path.join(dir, 'SKILL.md'), lines.join('\n'), 'utf-8')
  return dir
}

interface Tree {
  home: string
  skillsDir: string
  cleanup(): void
}

/**
 * 一棵假的 home 树，覆盖扫描器要面对的每种情形：
 * 规范技能、块标量说明、不合规范的名字、根下散落的单文件技能、点目录与 node_modules（都该跳过）、
 * 指向别处的 junction（要去重）、指向虚空 的 junction（要报失效）、带版本的插件缓存（要展开通配）。
 */
function makeTree(): Tree {
  const base = mkdtempSync(path.join(os.tmpdir(), 'torra-skills-'))
  const home = path.join(base, 'home')
  const skillsDir = path.join(base, 'torra', 'pi', 'skills')

  mkSkill(path.join(home, '.agents', 'skills', 'alpha'))
  // 块标量写法（>-）在真实技能里最常见，说明跨行必须拼回一句
  mkdirSync(path.join(home, '.claude', 'skills', 'beta'), { recursive: true })
  writeFileSync(
    path.join(home, '.claude', 'skills', 'beta', 'SKILL.md'),
    ['---', 'name: beta', 'description: >-', '  从块标量里读出来的说明，', '  跨两行也要拼成一句。', '---', '# beta'].join('\n'),
    'utf-8',
  )
  mkSkill(path.join(home, '.claude', 'skills', 'Bad Name (x)'), { fmName: 'Bad Name (x)' })
  writeFileSync(path.join(home, '.claude', 'skills', 'gamma.md'), ['---', 'description: 散在根目录里的单文件技能', '---', '# gamma'].join('\n'), 'utf-8')
  mkSkill(path.join(home, '.claude', 'skills', '.hidden', 'inner'))
  mkSkill(path.join(home, '.claude', 'skills', 'node_modules', 'dep'))
  linkDir(path.join(home, '.claude', 'skills', 'alpha-alias'), path.join(home, '.agents', 'skills', 'alpha'))
  mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true })
  if (LINKS_WORK) symlinkSync(path.join(home, 'nowhere'), path.join(home, '.claude', 'skills', 'broken'), LINK_TYPE as 'junction')
  mkSkill(path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'plug', '1.0.0', 'skills', 'delta'))
  mkSkill(path.join(home, '.codex', 'skills', 'epsilon'), { desc: null, fmName: 'epsilon' })
  linkDir(path.join(home, '.trae', 'skills', 'alpha'), path.join(home, '.agents', 'skills', 'alpha'))

  return {
    home,
    skillsDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

const find = (view: Awaited<ReturnType<typeof scanSkills>>, name: string) =>
  view.apps.flatMap((a) => a.skills).find((s) => s.name === name)

async function main(): Promise<void> {
  console.log('\n\x1b[1m技能扫描与导入\x1b[0m')

  // ---- frontmatter ----
  await it('块标量说明拼成一句，普通键值照收', () => {
    const fm = parseFrontmatter('---\nname: demo\ndescription: >-\n  第一行，\n  第二行。\n---\n正文')
    assert.equal(fm.name, 'demo')
    assert.equal(fm.description, '第一行， 第二行。')
  })
  await it('没有栅栏时不抛错，返回空', () => {
    assert.deepEqual(parseFrontmatter('# 只是标题'), {})
  })
  await it('链接名里的非法字符换成连字符', () => {
    const s = safeLinkName('a<b>:c"/d\\e|f?g*h')
    assert.ok(!/[<>:"/\\|?*]/.test(s), s)
    assert.ok(s.includes('c') && s.includes('h'), s)
    const rel = safeLinkName('../etc/passwd')
    assert.ok(!rel.includes('/') && !rel.includes('.') && rel.includes('etc'), rel)
    assert.equal(safeLinkName(''), 'skill')
  })

  // ---- 扫描 ----
  const t1 = makeTree()
  try {
    const view = await scanSkills({ home: t1.home, skillsDir: t1.skillsDir })
    assert.equal(view.ok, true)

    await it('SKILL.md 目录被当成技能根，不再下钻（点目录与 node_modules 都不算）', () => {
      const names = view.apps.flatMap((a) => a.skills).map((s) => s.name)
      assert.ok(names.includes('alpha'))
      assert.ok(!names.includes('inner'), '点目录下的技能不该被扫到')
      assert.ok(!names.includes('dep'), 'node_modules 不该被扫到')
    })
    await it('块标量说明被读进 description', () => {
      const beta = find(view, 'beta')
      assert.ok(beta)
      assert.equal(beta?.description, '从块标量里读出来的说明， 跨两行也要拼成一句。')
      assert.equal(beta?.loadable, true)
    })
    await it('名字不合规范只警告，照样可导入', () => {
      const bad = find(view, 'Bad Name (x)')
      assert.ok(bad, '不该被丢弃')
      assert.equal(bad?.loadable, true)
      assert.ok(bad?.warnings.some((w) => w.includes('规范')))
    })
    await it('缺 description 的标成不可加载', () => {
      const eps = find(view, 'epsilon')
      assert.equal(eps?.loadable, false)
      assert.ok(eps?.warnings.some((w) => w.includes('description')))
    })
    await it('根目录散落的 .md 收成单文件技能，名字取文件名', () => {
      const gamma = find(view, 'gamma')
      assert.ok(gamma)
      assert.equal(gamma?.kind, 'file')
      assert.equal(gamma?.loadable, true)
    })
    await it('同一份文件被 junction 指到多次，只在先扫到的应用里出现一次', () => {
      if (!LINKS_WORK) return
      const inAgents = view.apps.find((a) => a.id === 'agents')?.skills.filter((s) => s.name === 'alpha').length
      assert.equal(inAgents, 1)
      const claude = view.apps.find((a) => a.id === 'claude')
      assert.ok(!claude?.skills.some((s) => s.name === 'alpha'), 'claude 里的 alpha-alias 该被合并掉')
      assert.ok((claude?.skipped ?? 0) >= 1, '合并掉的条数要能交代')
      assert.ok(!view.apps.find((a) => a.id === 'trae')?.skills.length, 'trae 全是指向通用库的链接')
    })
    await it('指向虚空的链接报成不可加载，而不是悄悄少一条', async () => {
      const broken = view.apps.flatMap((a) => a.skills).find((s) => s.path.includes('broken'))
      if (!broken) return // 这台机器建不了符号链接，没有该样本
      assert.equal(broken.loadable, false)
      assert.ok(broken.warnings[0]?.includes('不存在'))
    })
    await it('插件缓存的通配根展开成功', () => {
      const d = find(view, 'delta')
      assert.ok(d, 'plugins/cache/*/*/*/skills 里的技能该被扫到')
      assert.equal(d?.appId, 'claude')
      assert.ok(!view.apps.find((a) => a.id === 'qoder')?.roots.length, '不存在的根目录列不出来')
    })

    // ---- 导入 ----
    await it('目录型技能导入为链接，源目录不动', async () => {
      const alpha = find(view, 'alpha')!
      const r = await importSkill({ home: t1.home, skillsDir: t1.skillsDir, key: alpha.key })
      assert.equal(r.ok, true)
      assert.equal(r.name, 'alpha')
      const p = path.join(t1.skillsDir, 'alpha')
      assert.equal(lstatSync(p).isSymbolicLink(), true, '应该是个链接')
      assert.ok(existsSync(path.join(p, 'SKILL.md')), '透过链接能读到 SKILL.md')
      assert.equal(readdirSync(path.join(t1.home, '.agents', 'skills', 'alpha')).length, 1, '源目录不该多东西')
    })
    await it('重复导入不产生第二个链接，直接告诉你已经在了', async () => {
      const alpha = find(view, 'alpha')!
      const r = await importSkill({ home: t1.home, skillsDir: t1.skillsDir, key: alpha.key })
      assert.equal(r.ok, true)
      assert.ok(r.reason?.includes('已经导入'))
      assert.deepEqual(readdirSync(t1.skillsDir).filter((n) => n.startsWith('alpha')), ['alpha'])
    })
    await it('重名的另一份技能退让到带后缀的名字', async () => {
      const other = mkSkill(path.join(t1.home, '.codex', 'skills', 'alpha'), { desc: '另一个 alpha' })
      const r = await importSkill({ home: t1.home, skillsDir: t1.skillsDir, key: path.join(other, 'SKILL.md') })
      assert.equal(r.ok, true)
      assert.equal(r.name, 'alpha-2')
    })
    await it('单文件技能复制成 <名字>/SKILL.md，并留下标记', async () => {
      const gamma = find(view, 'gamma')!
      const r = await importSkill({ home: t1.home, skillsDir: t1.skillsDir, key: gamma.key })
      assert.equal(r.ok, true)
      assert.equal(r.linkKind, 'copy')
      const dir = path.join(t1.skillsDir, 'gamma')
      assert.ok(existsSync(path.join(dir, 'SKILL.md')))
      assert.equal(JSON.parse(readFileSync(path.join(dir, '.torra-skill-copy.json'), 'utf-8')).sourceFile.includes('gamma.md'), true)
    })
    await it('扫描结果能认出「已导入」', async () => {
      const again = await scanSkills({ home: t1.home, skillsDir: t1.skillsDir })
      const alpha = find(again, 'alpha')
      assert.equal(alpha?.imported, true)
      assert.equal(alpha?.linkName, 'alpha')
      assert.equal(find(again, 'gamma')?.imported, true, '复制导入的也要认得出来')
      assert.ok(again.imported >= 2)
    })
    await it('拒绝把技能目录自己里面的东西再导入一次', async () => {
      const inside = mkSkill(path.join(t1.skillsDir, 'selftest'))
      const r = await importSkill({ home: t1.home, skillsDir: t1.skillsDir, key: path.join(inside, 'SKILL.md') })
      assert.equal(r.ok, false)
      assert.ok(r.reason?.includes('已经在'))
    })
    await it('路径不存在的技能导入失败，不留下半个链接', async () => {
      const r = await importSkill({ home: t1.home, skillsDir: t1.skillsDir, key: path.join(t1.home, '.claude', 'skills', 'gone', 'SKILL.md') })
      assert.equal(r.ok, false)
      assert.equal(existsSync(path.join(t1.skillsDir, 'gone')), false)
    })

    // ---- 移除 ----
    await it('移除只断开链接，源技能还在原地', async () => {
      const r = await removeSkill({ skillsDir: t1.skillsDir, name: 'alpha' })
      assert.equal(r.ok, true)
      assert.equal(existsSync(path.join(t1.skillsDir, 'alpha')), false)
      assert.ok(existsSync(path.join(t1.home, '.agents', 'skills', 'alpha', 'SKILL.md')), '源目录必须完好')
    })
    await it('带标记的复制目录可以整目录删除', async () => {
      const r = await removeSkill({ skillsDir: t1.skillsDir, name: 'gamma' })
      assert.equal(r.ok, true)
      assert.equal(existsSync(path.join(t1.skillsDir, 'gamma')), false)
      assert.ok(existsSync(path.join(t1.home, '.claude', 'skills', 'gamma.md')), '复制的原件不能被动')
    })
    await it('用户自己放进去的真实目录绝不动手', async () => {
      mkdirSync(path.join(t1.skillsDir, 'mine'), { recursive: true })
      writeFileSync(path.join(t1.skillsDir, 'mine', 'SKILL.md'), '---\ndescription: 手放的\n---\n', 'utf-8')
      const r = await removeSkill({ skillsDir: t1.skillsDir, name: 'mine' })
      assert.equal(r.ok, false)
      assert.ok(r.reason?.includes('没有删除'))
      assert.ok(existsSync(path.join(t1.skillsDir, 'mine', 'SKILL.md')))
    })
    await it('带路径分隔符的名字直接拒', async () => {
      const r = await removeSkill({ skillsDir: t1.skillsDir, name: '../../etc' })
      assert.equal(r.ok, false)
    })

    // ---- 失效链接 ----
    await it('指向虚空 的链接出现在 dangling 清单里，可以一键清掉', async () => {
      try {
        symlinkSync(path.join(t1.home, 'nowhere-2'), path.join(t1.skillsDir, 'ghost'), LINK_TYPE as 'junction')
      } catch {
        return
      }
      const again = await scanSkills({ home: t1.home, skillsDir: t1.skillsDir })
      assert.ok(again.dangling.some((d) => d.name === 'ghost'))
      assert.equal((await removeSkill({ skillsDir: t1.skillsDir, name: 'ghost' })).ok, true)
    })
  } finally {
    t1.cleanup()
  }

  // ---- 没有技能目录时也要能给出可读的结果 ----
  const t2 = makeTree()
  try {
    rmSync(path.join(t2.home, '.claude'), { recursive: true, force: true })
    const view = await scanSkills({ home: t2.home, skillsDir: t2.skillsDir, appIds: ['claude', 'agents'] })
    await it('应用没装时标成 missing，而不是报错', () => {
      assert.equal(view.apps.find((a) => a.id === 'claude')?.missing, true)
      assert.equal(view.apps.find((a) => a.id === 'agents')?.missing, false)
      assert.equal(view.apps.length, 2, 'appIds 过滤要生效')
    })
    await it('Torra 技能目录还不存在时扫描不炸', () => {
      assert.equal(existsSync(t2.skillsDir), false)
      assert.equal(view.dangling.length, 0)
    })
  } finally {
    t2.cleanup()
  }

  console.log(`\n${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

void main()

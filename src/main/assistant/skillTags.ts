/**
 * 技能分类标签：Torra 本地的一份记录，按「技能目录里的名字」存。
 *
 * 为什么单独存一份，而不是写进技能的 SKILL.md：技能目录里过半条目是指向
 * `~/.agents/skills`、`.claude/skills` 这些**别人家目录**的链接（理由见 skills.ts
 * 开头那三条实测约束）。往链接目标的 frontmatter 里加字段，等于替用户改别的应用
 * 的文件：对方一更新就冲掉，严格的校验器还可能把未知字段报成错误。
 * 「这条技能算科研还是研发」是 Torra 怎么看它，不是它自己的属性 —— 就该落在 Torra 这一侧。
 *
 * 三个决定，代码按这个走：
 *
 * 1. **键用 linkName**（技能目录里的条目名）。技能名会撞（不同应用可以同名），
 *    绝对路径会随导入方式变（junction 和复制的 path 不一样），只有目录里那个名字
 *    在「断开 → 重新导入」之后还是同一个。
 * 2. **断开导入不删标签**。移除多半是「暂时不用」，过两周重新导入时标签还在，
 *    别写清理逻辑去剪它 —— 剪掉的那部分用户只会觉得「我打过啊，怎么没了」。
 * 3. **读不出来就当作没有**。这是一份让卡片墙好找的辅助记录，一次手滑把 JSON
 *    改坏，不该让整个技能目录读不出来。写的时候照旧原子替换。
 *
 * 上限（8 个 / 每个 32 字）沿用记忆库那套口径，常量放在 shared/assistant.ts：
 * 界面上的「已用 3 / 8」要在写盘之前就报得准。主进程和渲染层各写一份数字，
 * 迟早会变成「还能加」和「第七个偷偷丢了」同时成立。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SKILL_TAG_LEN, SKILL_TAG_MAX, type SkillTagResult } from '../../shared/assistant'

/** 标签记录：技能目录里的名字 → 标签列表 */
export type SkillTagMap = Record<string, string[]>

/** 标签文件放在 Torra 的数据目录里，和技能目录做邻居但不混在一起 */
export function skillTagsFileOf(dataDir: string): string {
  return path.join(dataDir, 'skill-tags.json')
}

/**
 * 清洗：去控制字符、压空白、截长度、去空、去重（英文按大小写无关），最后限条数。
 *
 * 溢出的那部分单独交回来，而不是默默丢掉：用户一次贴进来十个标签，
 * 界面说「存了 8 个、还有 2 个没放下」才是诚实的；只说「已保存」就是在骗人。
 */
export function sanitizeTags(raw: unknown): { tags: string[]; dropped: string[] } {
  const list = Array.isArray(raw) ? raw : []
  const tags: string[] = []
  const dropped: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const text = String(item ?? '')
      .replace(/[\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SKILL_TAG_LEN)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (tags.length >= SKILL_TAG_MAX) {
      dropped.push(text)
      continue
    }
    tags.push(text)
  }
  return { tags, dropped }
}

/** 盘上读到的每条都要过一遍清洗：手改过的文件里可能全是怪东西 */
function parseStore(text: string): SkillTagMap {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: SkillTagMap = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isTagName(name)) continue
    const { tags } = sanitizeTags(value)
    if (tags.length) out[name] = tags
  }
  return out
}

/** 键必须就是目录里的那个名字：带路径分隔符的键既对不上任何技能，也留不住 */
function isTagName(name: string): boolean {
  if (!name) return false
  if (name.includes('/') || name.includes('\\')) return false
  return name === path.basename(name)
}

/** 读整个标签文件；不存在、读不动、形状不对都当作「还没打过标签」 */
export async function readSkillTags(file: string): Promise<SkillTagMap> {
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  if (text === null) return {}
  return parseStore(text)
}

/** 串行写：两处同时打标时，后一个不该把前一个的记录整个覆盖掉 */
const writeChains = new Map<string, Promise<unknown>>()

function serialize<T>(file: string, task: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(file) ?? Promise.resolve()
  const next = prev.then(task, task)
  writeChains.set(
    file,
    next.catch(() => undefined),
  )
  return next
}

async function writeStore(file: string, map: SkillTagMap): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export interface SetSkillTagsOptions {
  /** 标签文件（userData/torra/skill-tags.json） */
  file: string
  /**
   * 技能加载目录。给了就顺手确认这条技能真在盘上 ——
   * 卡片墙是上一次扫描的快照，技能在这期间被移走的话，
   * 不检查就会写进一条谁也认不出的记录，等某天有人占用了同一个名字。
   */
  skillsDir?: string
  linkName: string
  tags: unknown
}

/**
 * 给一条技能写标签。传空列表等于「清掉」：记录直接从文件里删掉，
 * 不留 `[]` —— 留着它，下次扫描时「有键但没标签」和「压根没键」两种状态
 * 在界面上长得一样，却要多处理一路。
 */
export async function setSkillTags(opts: SetSkillTagsOptions): Promise<SkillTagResult> {
  const linkName = String(opts.linkName ?? '')
  if (!isTagName(linkName)) {
    return { ok: false, reason: '技能名不合法，重新读取技能目录后再试', linkName, tags: [], dropped: [] }
  }
  const { tags, dropped } = sanitizeTags(opts.tags)

  if (opts.skillsDir) {
    const p = path.join(path.resolve(opts.skillsDir), linkName)
    const st = await fs.lstat(p).catch(() => null)
    if (!st) {
      return { ok: false, reason: `「${linkName}」已不在技能目录里`, linkName, tags: [], dropped: [] }
    }
  }

  try {
    const saved = await serialize(opts.file, async () => {
      const map = await readSkillTags(opts.file)
      if (tags.length) map[linkName] = tags
      else delete map[linkName]
      await writeStore(opts.file, map)
      return tags
    })
    return {
      ok: true,
      linkName,
      tags: saved,
      dropped,
      ...(dropped.length ? { reason: `最多 ${SKILL_TAG_MAX} 个标签，没放下：${dropped.join('、')}` } : {}),
    }
  } catch (e) {
    return { ok: false, reason: `标签没存下：${(e as Error).message}`, linkName, tags: [], dropped: [] }
  }
}

/**
 * 内置技能来源：开箱就能看到的几个主流 GitHub 技能仓库。
 *
 * 这里只是「入口」，不是「内容」：列出来不会联网，用户点「添加」才走
 * skill-repo 的 tarball 链路缓存到本机。能进清单的前提是 owner/repo 真实存在
 * 且还在维护 —— 名字写错一条，点下去就是一条红色报错，体验比空白还差。
 */

export interface SkillCatalogEntry {
  /** GitHub owner/repo；与 skill-repo 的 source id（github:<ref>）对齐 */
  ref: string
  /** 展示名：仓库可能改简介，这里的名字要稳定、短 */
  name: string
  /** 一句话说清这批技能管什么 */
  blurb: string
  /** 归类徽标 */
  tag: string
}

export const SKILL_CATALOG: SkillCatalogEntry[] = [
  {
    ref: 'anthropics/skills',
    name: 'Anthropic 官方技能',
    blurb: '官方发布的 Agent Skills 示例与写法规范，适合当模板对照自己写的技能。',
    tag: '官方',
  },
  {
    ref: 'obra/superpowers',
    name: 'Superpowers',
    blurb: '一套技能框架与软件开发方法论：计划、评审、调试各有固定流程。',
    tag: '方法论',
  },
  {
    ref: 'vercel-labs/agent-skills',
    name: 'Vercel 技能集',
    blurb: 'Vercel 官方维护，前端与全栈工程为主（React、Next.js 等）。',
    tag: '前端',
  },
  {
    ref: 'google/skills',
    name: 'Google 技能集',
    blurb: 'Google 产品与 Gemini 相关的官方技能。',
    tag: '官方',
  },
  {
    ref: 'mattpocock/skills',
    name: 'Matt Pocock 技能',
    blurb: '工程师日常工程流程技能，偏 TypeScript 与代码质量。',
    tag: '工程',
  },
]

/**
 * 技能市场的检索入口。
 *
 * 只做外链：这些站点的搜索接口没有稳定性承诺，接进应用反而是把别人的改版
 * 风险变成自己的故障。要看新技能就跳出去看，找到 owner/repo 再回来添加。
 */
export const SKILL_MARKETS: Array<{ name: string; url: string; note: string }> = [
  { name: 'skills.sh', url: 'https://skills.sh/', note: 'npx skills 的索引' },
  { name: 'ClawHub', url: 'https://clawhub.ai/', note: 'OpenClaw 技能市场' },
  { name: 'SkillHub', url: 'https://skillhub.tencent.com/', note: 'ClawHub 国内镜像' },
]

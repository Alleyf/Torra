/**
 * 来源判定（纯函数，不依赖 Electron）
 *
 * 网页通道的一切自动化都假定「当前文档就是适配器声明的站点」。这道判定要能在
 * 离线回归里被逐条钉死：判错的代价不是报错，是把研讨内容键进别人的页面。
 * 单独成模块正是因为 webview-agent 本身 import electron，ts-node 取不到它。
 */

/**
 * 取 URL 的 origin；拿不到就归空串。
 *
 * 空串是「不知道在哪」，与「在站点上」必须区分开：about:blank、chrome-error://、
 * 非法地址在这里都落到空串，调用方据此判不同源。`new URL('about:blank').origin`
 * 返回字符串 'null' 而不是抛错，那一串也得归空 —— 否则它会和某个怪 origin 相等。
 */
export function originOf(url: string): string {
  try {
    const o = new URL(url).origin
    return o === 'null' ? '' : o
  } catch {
    return ''
  }
}

/** 当前文档是否停在适配器声明的入口上 */
export function isEntryOrigin(entry: string, current: string): boolean {
  const want = originOf(entry)
  return want !== '' && originOf(current) === want
}

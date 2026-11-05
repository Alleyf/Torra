/**
 * 跨源子帧正文读取（灵光实测）
 *
 * 有的站点把每条助手消息的正文渲染在一个**跨源** iframe 里 —— 灵光实测是
 * `*.lingguang.uniocontent.com/v1/shim.html` 的 shim 帧，主文档只剩一个
 * 「已思考 Ns」状态条和一句「来自灵光移动端 App」页脚。页面侧的
 * `iframe.contentDocument` 对跨源帧抛 SecurityError，所以注入脚本无论怎么写
 * 都读不到正文：那是同源策略本身，不是选择器问题。
 *
 * 唯一可行的是主进程：`WebFrameMain.executeJavaScript` 能进任意子帧执行脚本。
 * 实测从 10 个 shim 帧各读出 1900–4400 字符的干净 Markdown（标题、列表、粗体都在）。
 *
 * 所以读取路径是「页面侧认帧 → 主进程进帧读」：页面侧继续负责它擅长的部分
 * （数 stream 节点、完成判定、页面活跃度），正文交给主进程按帧读，并复用同一份
 * INJECT_SCRIPT，于是 Markdown 保真与主文档那条通道完全一致。
 *
 * 帧与消息的对应靠**顺序**：每条助手气泡里各挂一个帧，DOM 顺序与消息顺序一致
 * （实测 20 个气泡 ↔ 10 个 shim 帧，最后一个是本期）。因此只读最后一个 stream
 * 节点里的帧 —— 灵光的帧里挂的是整段会话历史，全读等于把上几轮拼进本轮。
 */

/** 页面侧报回来的帧结构（只报最后一个 stream 节点，够了） */
export interface FrameScan {
  /** 主文档里 stream 命中的节点数 */
  nodes: number
  /** 最后一个 stream 节点里各 iframe 的 src（顺序即 DOM 顺序） */
  last: { src: string; id: string }[]
}

/** 主进程侧的帧接口（只取用到的两个成员，便于测试替身） */
export interface FrameLike {
  url: string
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>
}

/**
 * 从 webContents 的全部子帧里挑出「本轮那一帧」。
 *
 * 匹配按 src 精确相等（同一站点的 shim 帧 src 完全相同，含 origin 查询参数），
 * 再用「最后一个」兜住顺序；src 对不上时退回按 host 匹配，最后退回取末尾 N 个 ——
 * 三种都比「猜第几个」稳，且都不依赖帧内 id。
 */
export function pickTurnFrames(frames: FrameLike[], scan: FrameScan | null): FrameLike[] {
  const want = (scan && scan.last) || []
  if (!want.length) return []
  const n = want.length
  const exact = frames.filter((f) => want.some((w) => w.src && f.url === w.src))
  if (exact.length >= n) return exact.slice(-n)
  const hosts = new Set(
    want
      .map((w) => {
        try {
          return new URL(w.src).host
        } catch {
          return ''
        }
      })
      .filter(Boolean),
  )
  const byHost = frames.filter((f) => {
    try {
      return hosts.has(new URL(f.url).host)
    } catch {
      return false
    }
  })
  if (byHost.length >= n) return byHost.slice(-n)
  return frames.slice(-n)
}

/**
 * 在帧里读正文与图片。
 *
 * 先认身份（`__build` 与我们这一版一致）再注入 —— 与主文档的 ensureInjected
 * 同一口径：帧可能是站点自己重建的，中途换实现比留旧版更容易出错。
 * 单个帧失败不影响其它帧：逐帧 try，拿到的拼接返回。
 */
export async function readFrameContent(
  frames: FrameLike[],
  injectScript: string,
  build: string,
  sel: string,
  withImages: boolean,
): Promise<{ text: string; images: { src: string; alt?: string }[] }> {
  const parts: string[] = []
  const images: { src: string; alt?: string }[] = []
  const check = `!!(window.__torra && window.__torra.__build === ${JSON.stringify(build)})`
  for (const f of frames) {
    try {
      const already = await f.executeJavaScript<boolean>(check, false)
      if (already !== true) await f.executeJavaScript(injectScript, false)
      const text = await f.executeJavaScript<string>(
        `window.__torra.read(${JSON.stringify(sel)}, 'last', 0, '', '')`,
        false,
      )
      if (typeof text === 'string' && text.trim()) parts.push(text)
      if (withImages) {
        const imgs = await f.executeJavaScript<{ src?: string; alt?: string }[] | null>(
          `window.__torra.readImages(${JSON.stringify(sel)}, 0, '')`,
          false,
        )
        if (Array.isArray(imgs)) {
          for (const im of imgs) {
            const src = typeof im?.src === 'string' ? im.src : ''
            if (src) images.push({ src, alt: im.alt })
          }
        }
      }
    } catch {
      // 跨源策略在极少数配置下仍可能拒；单帧失败就当这一帧没正文
      continue
    }
  }
  return { text: parts.join('\n\n'), images }
}

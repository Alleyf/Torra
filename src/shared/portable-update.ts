/**
 * 便携版自更新的纯逻辑部分
 *
 * 为什么单独一个文件：这里全是「解析 + 比对」，不碰网络也不碰文件系统，
 * 所以能像 shared/update 那样被单测直接覆盖。真正联网和替换文件的活儿在
 * main/setup/portable-updater.ts。
 *
 * 为什么便携版要自己一套：electron-builder 的 portable 目标**不写** latest.yml
 * （源码 NsisTarget.js: isWriteUpdateInfo: !this.isPortable），
 * 也就是说 latest.yml 里只有 Torra-Setup-*.exe，没有便携版自己的产物地址。
 * 想让便携版能自更新，只能自己按 release 去取清单。
 */

import { isNewerVersion } from './update'

/** CI 给每个 release 发布的校验和清单，里面有便携版 exe 的 sha256 */
export const PORTABLE_SUMS_FILE = 'SHA256SUMS.txt'

/**
 * 解析 `sha256sum` 格式的清单，返回 文件名 → 小写十六进制 sha256
 *
 * 格式是 `<64位十六进制>  <文件名>`（两个空格，sha256sum 的默认输出）。
 * 解析不了就当没有这一行 —— 清单是外部来的，坏了不该让整个更新流程崩掉。
 */
export function parseSumsFile(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // 兼容 sha256sum 的两种分隔：空格，或二进制模式前缀的 "*"
    const m = /^([0-9a-fA-F]{64})\s+[* ]?(.+)$/.exec(line)
    if (!m) continue
    out.set(m[2]!.trim(), m[1]!.toLowerCase())
  }
  return out
}

/** 从 tag 里取出裸版本号：v0.6.0 → 0.6.0 */
export function tagToVersion(tag: string): string {
  return (tag ?? '').trim().replace(/^v/i, '')
}

/** 便携版产物在 release 里的文件名 */
export function portableAssetName(version: string): string {
  return `Torra-Portable-${version}.exe`
}

/**
 * 一次「便携版更新机会」的完整描述
 */
export interface PortableOffer {
  /** 目标版本（裸版本号，不带 v） */
  version: string
  /** 便携版 exe 的下载直链 */
  url: string
  /** 期望的 sha256（小写十六进制） */
  sha256: string
  /** 文件名 */
  fileName: string
}

export type PortableAssessment =
  | { ok: true; offer: PortableOffer }
  | {
      ok: false
      reason: string
      /** true 只表示「确实没有更新的版本」，不是发布清单坏了 */
      notAvailable?: boolean
    }

/**
 * 从 release 拉到的信息里判断「有没有可装的便携版更新」
 *
 * 判据和安装版一样严：版本必须严格更新，且必须能拿到 sha256 ——
 * 几十 MB 的可执行文件落到用户机器上，不能只靠「URL 看起来对」。
 */
export function assessPortableOffer(input: {
  /** release 的 tag，比如 v0.6.0 */
  tag: string
  /** SHA256SUMS.txt 的正文 */
  sums: string
  /** 当前版本 */
  current: string
  /** 拼下载直链用 */
  downloadUrl: (fileName: string) => string
}): PortableAssessment {
  const version = tagToVersion(input.tag)
  if (!version) {
    return { ok: false, reason: `发布页的版本号读不出来（tag=${input.tag}），已放弃这次更新。` }
  }
  if (!isNewerVersion(version, input.current)) {
    return {
      ok: false,
      reason: `发布页上的最新版本 v${version}，本机已经是 v${input.current}，没有可安装的新版本。`,
      notAvailable: true,
    }
  }
  const fileName = portableAssetName(version)
  const sha256 = parseSumsFile(input.sums).get(fileName)
  if (!sha256) {
    return {
      ok: false,
      reason: `发布清单里没有 ${fileName} 的校验和，无法验证下载到的文件，已放弃这次更新。`,
    }
  }
  return {
    ok: true,
    offer: {
      version,
      url: input.downloadUrl(fileName),
      sha256,
      fileName,
    },
  }
}

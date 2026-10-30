/**
 * 预检结论：把「接不上」拆成几种能指路的失败。
 *
 * 「接不上」这三个字没法行动。用户看到「接不上」只能干瞪眼；
 * 看到「命令没找到：npx 不在 PATH 上」他立刻知道去装什么。
 * 所以这里按失败的样子归类，归完给一句结论加一句怎么办。
 *
 * 归类靠的是失败文本里的特征词，不是某一家的私有格式 ——
 * 适配器包的报错措辞会变，特征词（ENOENT、not logged in、401）相对稳定。
 * 归不出类别就落到「接不上（细节未知）」，把原文带上，不硬套一个类别。
 */

/** 预检结论的类别 */
export type AcpVerdictKind =
  | 'ok'
  /** 命令都找不到：agent 没装，或者不在 PATH 上 */
  | 'not-installed'
  /** agent 在跑，但没登录 / 没有凭据 */
  | 'not-logged-in'
  /** 起来了，但协议对不上 */
  | 'incompatible'
  /** 起不来，原因不明 */
  | 'unknown'

export interface AcpVerdict {
  kind: AcpVerdictKind
  /** 一句话结论 */
  text: string
  /** 该怎么办 */
  hint?: string
}

/**
 * 抹掉看起来像凭据的东西。
 *
 * agent 的适配器爱把环境变量整包打出来给人看，其中可能混着 token。
 * 预检的原文是要贴到界面上的，所以贴之前先抹一遍 ——
 * 宁可少几个字符，也不能把用户的凭据摆到屏幕上或者写进日志。
 */
export function redactSecrets(text: string): string {
  if (!text) return ''
  let out = text
  // 常见的「键=值」形态：API_KEY=... / TOKEN: "..."
  out = out.replace(/([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*\s*[=:]\s*)("?)[^\s"',;]{6,}\2/gi, '$1$2……$2')
  // Bearer 头
  out = out.replace(/(bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1……')
  // 常见前缀的密钥（sk- / sk-ant- / ghp_ / gsk_ / xoxb-）
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gsk_[A-Za-z0-9]{8,}|xoxb-[A-Za-z0-9-]{8,})\b/g, '……')
  return out
}

/** 这些特征词出现时，多半是「没装」 */
const NOT_INSTALLED = [
  'enoent',
  'not recognized as an internal',
  'is not recognized',
  'command not found',
  'no such file or directory',
  'not found in path',
  'cannot find module',
  'npm error code e404',
  '404 not found',
]

/** 这些特征词出现时，多半是「起来了但没凭据」 */
const NOT_LOGGED_IN = [
  'not logged in',
  'no logged-in',
  'please log in',
  'please login',
  'login required',
  'authentication required',
  'unauthorized',
  'unauthenticated',
  'invalid api key',
  'missing api key',
  'api key not found',
  'no api key',
  'credential',
  '401',
]

/** 这些特征词出现时，多半是「协议对不上」 */
const INCOMPATIBLE = [
  'unsupported protocol',
  'protocol version',
  'invalid params',
  'invalidparams',
  'method not found',
  'not implemented',
  'unsupported method',
]

/**
 * 归类一次预检失败。
 *
 * @param error    客户端抛出来的那句话
 * @param stderr   agent 适配器自己打的日志尾巴
 * @param entryTitle 这一家的名字（结论里要提到它）
 */
export function classifyProbeFailure(error: string, stderr: string, entryTitle: string): AcpVerdict {
  const hay = `${error}\n${stderr}`.toLowerCase()
  const has = (words: string[]): boolean => words.some((w) => hay.includes(w))

  if (has(NOT_INSTALLED)) {
    return {
      kind: 'not-installed',
      text: `${entryTitle} 没装上，或者不在 PATH 上`,
      hint: '先在终端里装好这一家（或让它自带的适配器包），再回来接',
    }
  }
  if (has(NOT_LOGGED_IN)) {
    return {
      kind: 'not-logged-in',
      text: `${entryTitle} 起来了，但还没登录`,
      hint: '在终端里登录一次（或配好凭据），Torra 会直接读你本机已有的登录态',
    }
  }
  if (has(INCOMPATIBLE)) {
    return {
      kind: 'incompatible',
      text: `${entryTitle} 起来了，但协议对不上`,
      hint: '多半是适配器版本变了：矩阵里钉的版本要重测，或者换回钉死的那个版本',
    }
  }
  return {
    kind: 'unknown',
    text: `${entryTitle} 接不上`,
    hint: '细节在下面这段原文里',
  }
}

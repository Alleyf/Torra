/**
 * 把运行时与模型侧的原始报错翻译成人话。
 *
 * 为什么需要这一层：助手的使用者是「用这个应用的人」，不是写这个应用的人。
 * `TypeError: webidl.util.markAsUncloneable is not a function` 这种原文既没说清
 * 出了什么，也没给出下一步，用户只能截图来问。
 *
 * 两条规矩：
 * - 认得出的：给结论 + 下一步动作（去哪儿、点什么）。
 * - 认不出的：原样保留（只截断），绝不把线索翻译成猜测 —— 一条看起来笃定的
 *   错误解释比原文更难排查。
 */

type Rule = { test: RegExp; say: string }

/** 顺序即优先级：越具体的症状排得越前 */
const RULES: Rule[] = [
  {
    test: /markAsUncloneable|webidl\.util/i,
    say: '助手依赖的运行时能力在当前 Electron 内置的 Node 里缺失，推理引擎起不来。重启应用通常就会自动补上；若反复出现，请把这条反馈给开发者。',
  },
  {
    test: /ERR_REQUIRE_ESM|ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find module ['"]?@earendil/i,
    say: '助手的推理引擎没能装载成功（依赖缺失或版本不匹配）。重新安装依赖并构建后再启动应用。',
  },
  {
    // 状态码一律带词边界：报错串里常混着 token 数、耗时、端口，
    // 裸 /5\d\d/ 会把「5000 tokens」翻成「模型服务侧出错」，比原文更误导。
    test: /\b401\b|unauthorized|invalid[_ ]?api[_ ]?key|incorrect api key|authentication/i,
    say: '模型侧拒绝了这次请求：API Key 无效或已过期。请在设置页「模型与密钥」里重填该模型的 Key。',
  },
  {
    test: /\b403\b|forbidden|no access|permission/i,
    say: '模型侧不允许这次访问（权限或套餐限制）。请核对该 Key 的可用模型范围。',
  },
  {
    test: /\b429\b|rate.?limit|too many requests|overloaded/i,
    say: '模型侧限流或繁忙（请求太密）。稍等片刻再发一次，或在助手右上角换一个模型。',
  },
  {
    test: /insufficient|quota|balance|billing|payment/i,
    say: '该模型的账户额度不足。请到服务商后台充值，或在设置页换一个模型。',
  },
  {
    test: /context.{0,24}(length|window|limit)|too many tokens|maximum context|prompt is too long/i,
    say: '对话已经超出模型的上下文窗口。点助手右上角「开始新会话」清掉历史再继续。',
  },
  {
    test: /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network(?:error| exception)?|socket hang up|timeout/i,
    say: '连不上模型端点。请检查网络，或在设置页核对该模型的 Base URL。',
  },
  {
    test: /\b404\b|not found|model.{0,16}(does not exist|not exist|unknown|invalid)/i,
    say: '模型端点上找不到要用的模型名。请在设置页核对该模型的「模型标识」。',
  },
  {
    test: /\b5\d\d\b|bad gateway|service unavailable|internal server error/i,
    say: '模型服务侧出错（不是 Torra 的问题）。稍后重试，或换一个模型。',
  },
]

/** 原文兜底时的截断长度：够贴出关键栈头，又不至于刷屏 */
const MAX_RAW = 320

export function friendlyError(raw: string | undefined): string {
  const text = String(raw ?? '').trim()
  if (!text) return '助手这一轮没跑起来，但没有拿到具体原因。可以重试一次，或看链路体检里的运行时段。'
  const oneLine = text.replace(/\s*\n\s*/g, ' ')
  for (const r of RULES) {
    if (r.test.test(oneLine)) return r.say
  }
  return oneLine.length > MAX_RAW ? `${oneLine.slice(0, MAX_RAW)}…（原文已截断）` : oneLine
}

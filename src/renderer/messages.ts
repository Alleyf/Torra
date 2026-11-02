/*
 * 「这里还空着」与「这里坏了」两类话术的公共出处。
 *
 * 为什么收在一处：同一句话散在七八个组件里，改一次漏三处，界面就开始自相矛盾 ——
 * 同一个附件，聊天页写「保存失败」，助手抽屉写「未知错误」，用户得自己猜是不是两件事。
 *
 * 两条硬规矩（别的组件照着做）：
 * 1. 空状态要回答两件事：这里会出现什么、怎么让它出现。只写「暂无」等于把活推回给用户。
 * 2. 错误状态要回答两件事：什么坏了、用户能做什么。原始异常（英文堆栈、内部 id）不删，
 *    但要挪到次要位置（灰色小字或 title 属性），让人话占住主位 —— 报障的人还得靠它定位。
 *
 * 这里只放真的被多处复用的句子。不要把它变成一张「状态码 → 文案」的对照表：
 * 那种表一旦长起来，每加一个状态就要改一处表、一处调用点，界面反而更容易走样。
 */

/** 一条失败提示：text 是给用户看的主句，detail 是给报障的人看的原始信息 */
export type Failure = {
  /** 主句：先说什么坏了，再说用户能做什么 */
  text: string
  /** 原始信息（英文异常、内部 id、主进程给的原始原因）；没有就 undefined */
  detail?: string
}

/** 取一段原始信息；空串 / undefined / null 一律当作没有 */
export function rawDetail(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const s = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : String(raw)
  const t = s.trim()
  return t.length > 0 ? t : undefined
}

/** 组装失败提示：人话在前，原始信息另附 */
export function fail(text: string, raw?: unknown): Failure {
  const detail = rawDetail(raw)
  return detail ? { text, detail } : { text }
}

/**
 * 一段话是不是给人看的。
 *
 * 判据不是「含不含中文」——「Error: 附件参数非法」也含中文，可它是异常，不是提示；
 * 能接在主句后面的是「附件参数非法」这种本来就写给人看的话。所以这里查两件事：
 * 有没有中文，以及它长得像不像一段异常（英文错误签名、堆栈帧）。
 *
 * 为什么要多这一层：主进程给的 reason 多数是自己写的中文，但偶尔会透出底层异常。
 * 那种东西接在主句后面，用户读到的是半句中文半句英文，比只放主句还糟。
 */
const EXCEPTION_SIGNATURE =
  /\b(?:Error|Exception|TypeError|RangeError|ReferenceError|SyntaxError|EvalError|URIError|AssertionError)\b\s*:|^\s*at\s+\S+/m

export function isHumanText(s: string): boolean {
  const t = s.trim()
  if (!t) return false
  if (!/[\u4e00-\u9fff]/.test(t)) return false
  if (EXCEPTION_SIGNATURE.test(t)) return false
  // 只带一两个汉字的，多半是英文异常里夹带的碎片（"Key 无效" 这种整句另算）
  const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length
  return cjk >= 2
}

/** 去掉句尾的标点：拼句时我们自己补，别让两处标点叠在一起 */
function trimTail(s: string): string {
  return s.replace(/[。．.，,；;：:！!？?、\s]+$/u, '')
}

/**
 * 主进程给了失败原因时的标准组装法。
 *
 * what  说「什么坏了」，next 说「用户能做什么」，
 * reason 是主进程给的原因：中文就接在主句后面（它是信息），不是中文就挪去 detail（它是噪音）。
 */
export function failFromReason(what: string, reason: string | undefined, next: string): Failure {
  const why = reason?.trim()
  if (!why) return { text: `${trimTail(what)}。${next}` }
  if (isHumanText(why)) return { text: `${trimTail(what)}：${trimTail(why)}。${next}` }
  return { text: `${trimTail(what)}。${next}`, detail: why }
}

/**
 * 「这里没读出来」：说清哪一块没读出来，再说用户能做什么。
 * 拿不准「怎么弄」的时候不要硬编 —— 传一句实话进去就行（「重启应用再试」也算）。
 */
export function loadFailed(what: string, next: string, reason?: string): Failure {
  return failFromReason(`${what}没读出来`, reason, next)
}

/** 「导出没成功」：哪一份没导出去 + 接下来能改用什么方式 */
export function exportFailed(what: string, next: string, reason?: string): Failure {
  return failFromReason(`${what}没导出成功`, reason, next)
}

/** 「复制没成功」：系统拒绝了剪贴板时，这一句比「复制失败」有用得多 */
export function copyFailed(what: string, next: string, reason?: string): Failure {
  return failFromReason(`${what}没复制成功`, reason, next)
}

/**
 * 附件没存下来 —— 聊天页与助手抽屉是同一件事，抄两份以后两边一定会走样。
 * 主进程给的原因通常已经是中文，直接接在后面；没有原因就只说发生了什么。
 */
export function attachSaveFailed(name: string, reason?: string): Failure {
  return failFromReason(
    `附件「${name}」没存下来`,
    reason,
    '换个更小的文件，或把内容贴进输入框再发一次。',
  )
}

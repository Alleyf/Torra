/**
 * 被输出上限截断的 JSON 抢救（纯函数，无运行时依赖）。
 *
 * 主持小结是一整份结构化输出，而端点按 max_tokens 硬切。现场实测一次 4 模型的第 1 轮：
 * 两次尝试分别吐了 553 字与 2969 字就停在半个键名上（`"continues":` / callout 指令中间），
 * 流里连 stop_reason 都没有。整份 JSON.parse 必然失败，而这份失败过去直接等价于
 * 「本轮小结不存在」—— 重打一次仍被同样截断后整场以 no-moderator 收场：
 * 发言还在，共识/分歧/台账全空，用户跑完一场却什么都没拿到。
 *
 * 做法：**把截断点回退到最后一个「顶层键值对写完」的位置**，补上外层右花括号再解析。
 *
 * 为什么不需要理解 JSON 的内部结构：切出来的片段本身就是判据。
 * 「`{` + 若干个完整的 `"键": 值` 对」拼起来必然是可解析的 JSON —— 值可以是任意合法 JSON，
 * 嵌套多少层都一样。所以只要数清「顶层冒号分隔的成员」，剩下交给 JSON.parse 验证。
 *
 * 两条纪律：
 * - 不猜内容。半个字符串、半个数字都进不了「完整成员」，天然被丢掉。
 * - 不放宽判据。取回的部分照常过机械校验：support 指向不存在的模型、
 *   evidence_ref 指向不存在的发言，仍然会被驳回。抢救只恢复「本来就已经写好且合法」的内容。
 *
 * 单测：scripts/test-json-salvage.ts
 */

const WS = new Set([' ', '\t', '\n', '\r'])

/** 跳过空白 */
function skipWs(s: string, i: number): number {
  let j = i
  while (j < s.length && WS.has(s[j]!)) j++
  return j
}

/** 跳过 JSON 字符串字面量（含转义）；未闭合返回 -1 */
function skipString(s: string, i: number): number {
  let j = i + 1
  while (j < s.length) {
    const ch = s[j]!
    if (ch === '\\') {
      j += 2
      continue
    }
    if (ch === '"') return j + 1
    j++
  }
  return -1
}

/** 原子值（数字 / true / false / null）的合法结尾：读到分隔符或空白为止 */
function skipAtom(s: string, i: number): number {
  let j = i
  while (j < s.length && !WS.has(s[j]!) && !',}]'.includes(s[j]!)) j++
  return j
}

/** 修好的片段 + 原文里被吃掉的字符数（闭合是补的，所以两者长度不等） */
interface Repaired {
  text: string
  consumed: number
  /**
   * 这个值**自身**（只它这一层）在原文里是不是被切开了。
   *
   * 区别很要紧：被切开的复合值我们会补一个闭合把它救回来，但补出来的闭合是凭空来的。
   * 拿它当「模型完整写出来的结论」就越界了 —— 半个 callout（只有 target_agent、
   * 没有 instruction）会被当成一次真的点名。
   *
   * 只看自己这一层在原文里有没有闭合过，**不追问更深**：
   * `consensus_points` 的第三个元素没写完，那是元素的事；前两个元素写完了就该保住。
   * 顶层若自己在原文里没闭合（就是被输出上限切了），它会以 null 落空 —— 那是正确结果。
   */
  cutSelf: boolean
  /**
   * 被切开时，最后一个成员的**键名后面还有值**（即原文停在 `"键": 半句话` 上）。
   * 这类成员是「正在写的散文」，收下来就等于替模型把它说完。
   */
  tailIsAtom?: boolean
  /** 这个值本身是对象（false = 数组或原子值） */
  isObject?: boolean
}

/**
 * 从 `s[i]` 开始修复一个被截断的 JSON 值。
 *
 * 逐成员递归：读到写不完整的那一刻就停，把已经完整的成员收尾、补上闭合返回。
 * 于是「consensus_points 第三个元素只写了一半」这类**嵌套**截断也能救回前两个 ——
 * 只按顶层逗号切做不到：截断发生在数组内部时，那个顶层成员永远等不到闭合。
 *
 * 返回 null 表示连第一个成员都不完整，那一刀没有可救的东西。
 */
function repair(s: string, i: number): Repaired | null {
  const open = s[i]

  if (open === '{' || open === '[') {
    const isObj = open === '{'
    const closer = isObj ? '}' : ']'
    const parts: string[] = []
    /** 最后收进来的成员自身是否完整：对象靠它判断自己该不该被整个丢掉 */
    let tailIntact = false
    let j = i + 1
    /** 刚读完一个成员、正等着分隔符 */
    let expectSep = false
    /** 原文有没有自己闭合；没闭合就说明这层是被切开的 */
    let closed = false
    for (;;) {
      j = skipWs(s, j)
      /** 到串尾：截断，收工 */
      if (j >= s.length) break
      /**
       * 结构自己闭合了：**越过去再收工**。
       * 这一步决定上层能不能接对位置 —— 少了它 consumed 会停在闭合括号**之前**，
       * 上层接着读到的就是 `]` 而不是 `}`，整份立刻判不出东西。
       */
      if (s[j] === closer) {
        j++
        closed = true
        break
      }

      if (expectSep) {
        /** 上一轮读到的分隔符不是逗号（多半是 } / ]）—— 结构到此为止 */
        if (s[j] !== ',') {
          closed = s[j] === closer
          if (closed) j++
          break
        }
        j++
        expectSep = false
        continue
      }

      /** 对象成员前缀是 `"key":`，数组成员没有前缀 —— 漏了这个初值就成了字面量 undefined */
      let head = ''
      if (isObj) {
        if (s[j] !== '"') break
        const keyEnd = skipString(s, j)
        if (keyEnd < 0) break
        const colon = skipWs(s, keyEnd)
        /**
         * 键名后面没有冒号 = 这个键的值还没开始写。
         * 它不是「一个值为 null 的完整成员」，而是写到一半的痕迹 —— 丢掉这个键，
         * 收尾交给上一层。反过来若把它补成空值，等于凭空造出一个 `"score_dimensions": null`。
         */
        if (s[colon] !== ':') break
        head = s.slice(j, keyEnd) + ':'
        const vStart = skipWs(s, colon + 1)
        /**
         * 键后面没有值（原文停在 `"continues":` 上）：这个键没写完。
         * 它不是「值为 null」，是一段写到一半的痕迹 —— 补 null 就是编内容。
         *
         * 只丢这个键，前面已经读完的成员照收 —— 所以是 continue 而不是 break：
         * 整份判空会把那条**完整**的共识点一起赔进去（第一次尝试的现场原文就停在这）。
         * 数组同样继续：后面还有元素没读。
         */
        if (vStart >= s.length) {
          break
        }
        j = vStart
      }

      const value = repair(s, j)
      if (value === null) {
        /**
         * 这个成员没写完。前面的成员已经收好了，这里直接收工：
         * 数组保住已完成的元素（consensus_points 第三个没写完不影响前两个）；
         * 对象则把这个键连同它的半截内容一起丢掉（半个 callout 会被校验当成一次合法点名）。
         *
         * tailIntact 置 false 是关键：它让本层以「末尾不是完整原子」上报，
         * 于是上一层不会把一个被切开的对象（含半句散文）当成完整数据收下。
         */
        tailIntact = false
        break
      }
      /**
       * 数组被切开不丢：里面已写完的元素正是要救的东西（consensus_points 第三个
       * 没写完，前两个照样是有效结论）。
       *
       * 被切开但内部成员都写完了（score_dimensions 只写出 agreement）：保住。
       * 丢它等于「这一轮没有任何分数」，而那半句 agreement 是模型真的写了出来的；
       * 缺的那一维由校验层照常驳回，判据不动。
       *
       * 被切开且**没写完的那个成员是个真在说话的字段**：丢掉整个值。
       * callout 就是这一类 —— target_agent 写完了、instruction 只写了一半。
       * 半个 callout 会被校验判为一次合法点名（它只查人名在不在名单里，
       * 查不出那句话其实是空的），于是主持没说的话变成了报告里的一条指令。
       * 这类字段留半截比留空更危险，所以整个值都不收。
       *
       * 判据因此是「自己被切开，且末尾没写完的那个成员不是一个已完成的原子值」。
       */
      /**
       * 半个**对象**不收：callout 只写了 target_agent、instruction 写一半，
       * 校验层只查人名在不在名单里，查不出那句话其实是空的 ——
       * 于是主持没说的话变成了报告里的一条指令。
       *
       * 被切开的**数组**要收：里面已写完的元素正是要救的东西。
       * consensus_points 第三个元素没写完，不该连累前两个；
       * score_dimensions 只写出 agreement，那一维也是模型真的写了出来的。
       *
       * 被切开的**纯数据对象**要收：score_dimensions 写出 agreement 后被切，
       * 那半句是模型真的写出来的分数。丢它等于「这一轮没有任何分数」，
       * 而缺的那一维由校验层照常驳回 —— 判据不动。
       *
       * 两者的分别只在**成员是不是散文**：嵌套对象被切有两种落法，
       * 差别是最后写了一半的那个成员是什么形状。这里交给调用方判断
       * （见 salvageTruncatedJson 下方注释），本层只负责识别「这是个被切开的对象」。
       */
      if (isObj && value.isObject && value.cutSelf && !value.tailIsAtom) break
      parts.push(`${head}${value.text}`)
      tailIntact = !value.cutSelf
      j += value.consumed
      expectSep = true
    }

    /**
     * 没有成员可救时，只在**原文本来就是个空的复合值**时放过：
     * `[]` / `{}` 是完整值（空数组在主持小结里就是「本轮没有未决分歧」这种正当取值）。
     * 其余情况是「截断得连一个成员都没写完」，那条内容没有价值，返回 null 让上层照实驳回。
     */
    if (parts.length === 0) {
      const first = skipWs(s, i + 1)
      if (first < s.length && s[first] === closer) return { text: isObj ? '{}' : '[]', consumed: first + 1 - i, cutSelf: false }
      /**
       * 键后面直接到串尾（`"open_disputes":` 后面什么都没有）：
       * 这个键没写完，但它**不是**一段被截断的散文 —— 丢掉整个对象没有意义，
       * 而上一层会把这个键自己丢掉（见对象分支里「键后面没有冒号/值」的处理）。
       * 所以这里返回 null 是对的：上一层把 break 掉，留下前面完整的成员。
       */
      return null
    }
    const text = isObj
      ? `{${parts.join(',')}}`
      : `[${parts.join(',')}]`
    /**
     * 原文被吃掉的字符数：从本值起点 i 算起，停在「最后一个读完的成员之后」。
     * j 此时正指向那个成员读完之后的位置（可能是串尾），补上的闭合不计入 ——
     * 闭合是凭空加的，不该让上层以为原文里有那么多字。
     */
    return {
      text,
      consumed: Math.max(0, Math.min(j, s.length) - i),
      cutSelf: !closed,
      tailIsAtom: tailIntact,
      isObject: isObj,
    }
  }

  if (open === '"') {
    const e = skipString(s, i)
    if (e < 0) return null
    const lit = s.slice(i, e)
    /**
     * 数组成员的字符串是个完整值；对象里孤零零一个键名不是 ——
     * 它后面本该跟 `:` 与值，截断在这里就把这个键丢掉（上层会补闭合）。
     * 所以裸键交给调用方判断，这里照常返回，让对象分支看到「值没写完」。
     */
    return { text: lit, consumed: e - i, cutSelf: false }
  }

  const end = skipAtom(s, i)
  const atom = s.slice(i, end)
  if (atom.length === 0) return null
  try {
    JSON.parse(atom)
    return { text: atom, consumed: atom.length, cutSelf: false }
  } catch {
    /**
     * 截在数字中间（`"score": 5` 写成 `"score": 5.`）也算没写完。
     * 残片当数字会得到 5，凭空补精度是编内容 —— 这里老实地当作「不可用」。
     */
    return null
  }
}

/**
 * 抢救被截断的 JSON 对象：修好已经完整写出来的那部分，其余丢弃。
 *
 * 返回 null 表示截断得太早（连一个完整成员都没有），那种情况没什么可救。
 */
export function salvageTruncatedJson(raw: string): unknown | null {
  const text = raw.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim()
  const start = text.indexOf('{')
  if (start < 0) return null
  const repaired = repair(text, start)
  if (repaired === null) return null
  /**
   * 顶层被切开正是这里要处理的情况（端点就是切在最外层对象里的），
   * 所以顶层那个 cut 不作废结果 —— 它由本函数负责补闭合。
   * 真正作废的是里面某个成员切开后被留下的半截，那已经在 repair 里 break 掉了。
   */
  try {
    return JSON.parse(repaired.text)
  } catch {
    return null
  }
}

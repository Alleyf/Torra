/**
 * 运行模式状态机：目标模式的自动推进、计划模式的只读闸门，都收在这层。
 *
 * 为什么单独一层而不是 bridge 里的几个 if：目标模式要读**上一轮的回复**才能决定
 * 要不要再跑一轮，而 bridge 拿到那份文本的唯一途径是碰 pi 会话 —— 两件事写进同一个
 * 函数，结果是「循环的纪律」和「会话的组装」都测不了。这层只认两个注入：跑一轮、报状态。
 *
 * 三条边界：
 *
 * 1. **自动推进的停止条件必须是看得见的**：写了完成标记、没写标记、到轮数上限、
 *    这一轮失败 —— 四种各出一句话，而且都要进对话流。一个没有上限、判定含糊的
 *    自主循环，出事时没人知道它已经跑了多久、花了多少钱。
 * 2. **计划模式的只读是闸门，不是请求**：状态里的 planLocked 由确认卡片那层读，
 *    拒绝写操作。只在提示词里说「这一轮别动手」，模型换个说法就绕过去了。
 * 3. **状态只有主进程这一份**，渲染层是镜像（靠 onState 推出去）。两边各算各的，
 *    就会出现「界面上像目标模式，实际每轮都要人按一下回车」。
 */

import {
  GOAL_MAX_ROUNDS,
  GOAL_TEXT_MAX,
  PLAN_TEXT_MAX,
  RUN_MODES,
  defaultModeState,
  executionPrompt,
  goalRoundPrompt,
  isRunMode,
  parseGoalVerdict,
  planRoundPrompt,
  type AssistantModeState,
  type AssistantResult,
  type AssistantRunMode,
} from '../../shared/assistant'
import type { ChatAttachmentMeta } from '../../shared/types'

/** 跑完一轮的结果：除了成功与否，模式层还要看这一轮的助手原文 */
export interface TurnOutcome extends AssistantResult {
  text: string
}

export interface ModeEngineDeps {
  /**
   * 执行一轮对话并带回这一轮的助手文本。inFlight、组会话、附件解析都在调用方。
   *
   * refs = 这一轮要一起贴上的 @ 引用内容。它和附件同一条规矩：只跟着人说的那第一轮，
   * 续跑的轮次由模型自己接管上下文 —— 否则八轮里每轮都重贴一遍同一个文件。
   */
  runTurn: (prompt: string, opts: { attachments?: ChatAttachmentMeta[]; refs?: string }) => Promise<TurnOutcome>
  /** 状态快照出口：进流事件，界面上的徽标与忙碌态都以它为准 */
  onState: (state: AssistantModeState) => void
  /** 一行进度进对话流：自动推进的每一步都不能是静默动作 */
  onNote: (text: string) => void
  /** 请正在跑的这一轮尽快停下（不 await：中止和收尾谁先到都行） */
  abortTurn: () => void
}

export interface ModeEngine {
  /** 当前状态快照，渲染层每次打开浮层都要读它 */
  state(): AssistantModeState
  /** 切模式。goal 可带目标原文；不带就等下一条消息自己当目标 */
  setMode(input: { mode?: unknown; goal?: unknown }): AssistantResult
  /** 一条待发送的消息按当前模式走：普通一轮、目标循环、或只出计划。refs 只跟第一轮 */
  submit(text: string, attachments?: ChatAttachmentMeta[], refs?: string): Promise<AssistantResult>
  /** 人按停止：正在跑的这轮中止，循环不再续跑 */
  stop(): AssistantResult
  /** 执行上一轮那份已确认的计划 */
  execute(): Promise<AssistantResult>
  /** 已授权的读取目录变了，镜像到状态里（校验与落地在调用方） */
  setReadDirs(dirs: string[], note?: string): void
  /** 换会话或关掉助手：模式、计划、授权全部清零 */
  reset(): void
}

export function createModeEngine(deps: ModeEngineDeps): ModeEngine {
  let cur: AssistantModeState = defaultModeState()
  /** 停止标志：要跨过一次 await 才生效，所以不能只靠界面上的按钮状态 */
  let stopped = false

  const push = (): void => deps.onState({ ...cur, readDirs: [...cur.readDirs] })

  /**
   * 结束一次自动推进：落 note、清 running、把同一句话推进对话流。
   *
   * 状态里的 note 只对以后打开面板的人可见，而正在等的用户必须当场知道
   * 「循环为什么停了」—— 少了 onNote，界面上就是「说了两句然后没动静」。
   */
  function settle(note: string): void {
    cur = { ...cur, running: false, note }
    push()
    deps.onNote(note)
  }

  async function goalLoop(firstText: string, attachments: ChatAttachmentMeta[], refs: string): Promise<AssistantResult> {
    const goal = String(cur.goal ?? firstText ?? '').trim().slice(0, GOAL_TEXT_MAX)
    if (!goal) return { ok: false, reason: '目标模式要先有目标：把要达成的那件事写进这条消息' }
    stopped = false
    cur = { ...cur, mode: 'goal', goal, round: 0, running: true, planLocked: false, note: undefined }
    push()
    const max = cur.maxRounds || GOAL_MAX_ROUNDS
    let round = 0
    while (round < max) {
      round++
      cur = { ...cur, round }
      push()
      const turn = await deps.runTurn(
        goalRoundPrompt(goal, round, max, { first: round === 1, request: firstText }),
        // 附件和 @ 引用都只跟着第一轮：那是人说的那一句；续跑的轮次由模型自己接管上下文
        { attachments: round === 1 ? attachments : [], refs: round === 1 ? refs : '' },
      )
      if (!turn.ok) {
        const reason = turn.reason ?? '这一轮没有跑成'
        settle(`自动推进在第 ${round} 轮停下：${reason}`)
        return { ok: false, reason: `第 ${round} 轮失败，自动推进已停止`, ...(turn.detail ? { detail: turn.detail } : {}) }
      }
      if (stopped) {
        const note = `已停止自动推进（停在第 ${round} 轮）`
        settle(note)
        return { ok: true, reason: note }
      }
      const verdict = parseGoalVerdict(turn.text)
      if (verdict === 'done') {
        const note = `目标标记为已完成，自动推进停在第 ${round} 轮`
        settle(note)
        return { ok: true, reason: note }
      }
      if (verdict === 'none') {
        // 认不到标记就停：猜「它其实是做完了」的代价是剩下几轮全白跑
        const note = `第 ${round} 轮末尾没写自评标记，自动推进到此为止 —— 不确定是已完成还是没说完，要继续请再说一声`
        settle(note)
        return { ok: true, reason: note }
      }
    }
    const note = `已到自动推进上限（${max} 轮），剩下的请再吩咐一次`
    settle(note)
    return { ok: true, reason: note }
  }

  async function planRound(text: string, attachments: ChatAttachmentMeta[], refs: string): Promise<AssistantResult> {
    stopped = false
    cur = { ...cur, mode: 'plan', planLocked: true, running: true, round: 0, plan: undefined, note: undefined }
    push()
    const turn = await deps.runTurn(planRoundPrompt(text), { attachments, refs })
    if (!turn.ok) {
      // 计划没生成也保持锁定：模式还停在「只出计划」，这时候放开写闸门没有依据
      settle('这一轮没跑成，计划没有生成（写操作仍然锁着，切回普通对话才会放行）')
      return turn
    }
    if (stopped) {
      settle('已停止，这一轮的计划作废（写操作仍然锁着）')
      return { ok: true, reason: '已停止，这一轮的计划作废' }
    }
    const plan = String(turn.text ?? '').trim().slice(0, PLAN_TEXT_MAX)
    if (!plan) {
      settle('这一轮没出文字，计划为空 —— 执行项不可用（写操作仍然锁着）')
      return { ok: true, reason: '这一轮没出文字，计划为空' }
    }
    cur = { ...cur, running: false, planLocked: true, plan }
    push()
    const note = '计划已成形。确认无误后在 / 浮层里选「执行计划」，那时才会放开写操作'
    deps.onNote(note)
    return { ok: true, reason: note }
  }

  return {
    state: () => ({ ...cur, readDirs: [...cur.readDirs] }),

    setMode(input) {
      const mode: AssistantRunMode | undefined = isRunMode(input?.mode) ? input.mode : undefined
      if (!mode) return { ok: false, reason: `模式只能是「${RUN_MODES.join(' / ')}」之一` }
      if (cur.running && mode !== cur.mode) {
        return { ok: false, reason: '自动推进正在跑，先按停止再切模式' }
      }
      const rawGoal = typeof input?.goal === 'string' ? input.goal.trim() : ''
      const goal = rawGoal ? rawGoal.slice(0, GOAL_TEXT_MAX) : undefined
      if (mode === 'chat') {
        // 回普通对话要把两道闸门一起收掉：留着「只读」的锁，下一条消息就会莫名被拒
        cur = { ...cur, mode, running: false, round: 0, planLocked: false, plan: undefined, goal: undefined, note: undefined }
        push()
        return { ok: true, reason: '已切回普通对话，写操作按审批设置放行' }
      }
      cur = {
        ...cur,
        mode,
        running: false,
        round: 0,
        plan: undefined,
        planLocked: mode === 'plan',
        // 目标只在真要进目标模式时才留下。带着上一句的目标切到计划模式，
        // 等再切回目标模式时它会顶掉人当下写的消息 —— 自动推进照着一个没人说过目标跑八轮
        goal: mode === 'goal' ? goal : undefined,
        note: undefined,
      }
      push()
      if (mode === 'goal') {
        return {
          ok: true,
          reason: goal
            ? `目标模式已就绪：${goal}`
            : '目标模式已就绪 —— 下一条消息的内容就是目标，发出去后会自动推进（上限 ' + (cur.maxRounds || GOAL_MAX_ROUNDS) + ' 轮）',
        }
      }
      return { ok: true, reason: '计划模式已就绪：只出计划不动手，写操作会被拒绝' }
    },

    async submit(text, attachments, refs) {
      const atts = Array.isArray(attachments) ? attachments : []
      const refBlock = String(refs ?? '')
      if (cur.running) return { ok: false, reason: '自动推进正在跑，先按停止' }
      if (cur.mode === 'goal') return goalLoop(text, atts, refBlock)
      if (cur.mode === 'plan') return planRound(text, atts, refBlock)
      const turn = await deps.runTurn(text, { attachments: atts, refs: refBlock })
      return turn
    },

    stop() {
      if (!cur.running) return { ok: true, reason: '当前没有正在推进的自动循环' }
      stopped = true
      deps.abortTurn()
      cur = { ...cur, running: false, note: '已请求停止，正在跑的这一轮会尽快停下' }
      push()
      return { ok: true, reason: '已请求停止自动推进' }
    },

    async execute() {
      if (cur.running) return { ok: false, reason: '自动推进正在跑，先按停止' }
      const plan = String(cur.plan ?? '').trim()
      if (!plan) return { ok: false, reason: '还没有可执行的计划：先在计划模式下发一条需求' }
      cur = { ...cur, mode: 'chat', planLocked: false, plan: undefined, running: true, round: 0, note: undefined }
      push()
      const turn = await deps.runTurn(executionPrompt(plan), {})
      if (!turn.ok) {
        settle(`计划执行的那一轮没跑成：${turn.reason ?? '未知原因'}`)
        return turn
      }
      cur = { ...cur, running: false }
      push()
      return { ok: true, reason: '已按确认的计划开始执行（写操作按审批设置放行）' }
    },

    setReadDirs(dirs, note) {
      cur = { ...cur, readDirs: dirs.map((d) => String(d)).filter(Boolean), ...(note ? { note } : {}) }
      push()
    },

    reset() {
      stopped = false
      cur = defaultModeState()
      push()
    },
  }
}

import { useEffect, useRef, useState } from 'react'
import { useStore, type ModelSummary } from '../store'
import type { VerifyPassMode } from '@shared/types'
import { channelMix, usableModels } from '@shared/participants'
import { getFaviconUrls } from './ModelRail'
import {
  MessageSquare,
  MessageCircle,
  Users,
  Crown,
  Settings2,
  Play,
  AlertTriangle,
  Zap,
  Target,
  EyeOff,
  Stethoscope,
  Globe,
  KeyRound,
  Sparkles,
  Compass,
  ShieldCheck,
  GitCompare,
  SlidersHorizontal,
  Minus,
  Plus,
} from 'lucide-react'
import '../newsession.css'

const STRATEGY_LABEL: Record<string, string> = {
  roundtable: '圆桌',
  debate: '辩论',
  review: '评审',
}

const STRATEGY_DESC: Record<string, string> = {
  roundtable: '并行发言，互相补充',
  debate: '逐条反驳，逼出立场',
  review: '审阅打分，挑毛病',
}

const STRATEGY_ICONS: Record<string, React.ReactNode> = {
  roundtable: <Users size={12} />,
  debate: <Zap size={12} />,
  review: <Target size={12} />,
}

const VERIFY_DESC: Record<VerifyPassMode, string> = {
  off: '只测量不矫正',
  auto: '风险达标才质询',
  always: '被代答的共识逐条质询',
}

/** 参与模型：一颗胶囊就是一个人，点一下即选；被挡住的那颗直接把人领去登录 */
function ModelChip({ m, faviconUrls }: { m: ModelSummary; faviconUrls: string[] }) {
  const [index, setIndex] = useState(0)
  if (faviconUrls.length > 0 && index < faviconUrls.length) {
    return (
      <img
        src={faviconUrls[index]}
        alt=""
        crossOrigin="anonymous"
        onError={() => setIndex((prev) => prev + 1)}
      />
    )
  }
  return <span style={{ background: m.color }}>{m.displayName.slice(0, 1)}</span>
}

export function NewSession({
  models,
  onStart,
  onPickWebModel,
  onGotoSettings,
  showIntro,
  onDismissIntro,
  onOpenChat,
  onOpenAssistant,
}: {
  models: ModelSummary[]; onStart: () => void
  /** 点一个还没登录的网页模型：把它的内嵌视图开出来，人在里面登录 */
  onPickWebModel: (id: string) => void
  onGotoSettings: () => void
  /** 一次性引导：只在第一次打开时出现，看过就由主进程记住 */
  showIntro: boolean
  onDismissIntro: () => void
  onOpenChat: () => void
  onOpenAssistant: () => void
}) {
  const s = useStore()
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  /*
   * 「能不能开一场」用的是 store 自动勾选参与名单的同一条口径（API 要有 Key、网页要已登录）。
   * 两套判断会自相矛盾：这里说缺，下面的名单却已经给人选上了。
   */
  const usable = usableModels(models)
  const webCandidates = models.filter((m) => m.enabled && m.transport === 'webview' && m.status !== 'ready')

  /**
   * 主持候选：只有 API 模型能担任。
   * 网页通道无法产出结构化小结；缺 Key 的 API 模型一调用就抛错。
   * 二者都保留在列表里但置灰，否则用户会以为「没有这个选项」而不是「这个选项不能用」。
   */
  const moderatorOptions = models.filter(
    (m) => m.transport === 'api' && m.supportsStructuredOutput,
  )

  const picked = s.participantIds
    .map((id) => models.find((m) => m.id === id))
    .filter((m): m is ModelSummary => !!m)

  /** 通道构成：网页模型是这场讨论的时间大头，选完就当场说清，不等跑完才后悔 */
  const mix = channelMix(s.participantIds, models)

  const missing: string[] = []
  if (s.topicTitle.trim().length === 0) missing.push('议题标题')
  if (picked.length === 0) missing.push('至少一个参与模型')
  const canStart = missing.length === 0 && !starting

  const handleStart = async () => {
    if (!canStart) return
    setStarting(true)
    setStartError(null)
    const result = await window.torra.startSession(
      {
        id: `topic_${Date.now()}`,
        title: s.topicTitle.trim(),
        background: s.topicBackground.trim(),
        strategy: s.strategy,
        attachments: [],
        createdAt: Date.now(),
      },
      {
        maxRounds: s.maxRounds,
        participantIds: s.participantIds,
        moderatorId: s.moderatorId,
        budgetLimitUsd: s.budgetLimitUsd,
        anonymousReview: s.anonymousReview,
        baseline: s.baseline,
        baselineCompare: s.baselineCompare,
        verifyPass: s.verifyPass,
        timeBudgetMs: Math.max(1, s.timeBudgetMin) * 60_000,
      },
    )
    setStarting(false)
    if (!result.ok) {
      /* 失败必须留在页面上：一闪而过的 toast 只会让人以为「点了没反应」 */
      setStartError(result.reason ?? '开场失败，请检查上面的配置')
      return
    }
    onStart()
  }

  return (
    <div className="ns-scroll">
      <div className="ns-col">
        <header className="ns-head">
          <div className="ns-eyebrow">TORRA / 多模型议事厅</div>
          <h1 className="ns-h1">把一个问题，变成一场有结论的讨论</h1>
          <p className="ns-lede">
            让多个模型分别分析、互相质疑，再由主持模型整理出共识与保留分歧。轮内并行发言，轮间串行小结。
          </p>
        </header>

        {/*
         * 第一次打开的人卡住的地方从来不是「界面在哪儿」，是「点了开始没反应」。
         * 引导和下面的体检刻意不同时出现：两块一起摆会把议题表单挤出这一屏，
         * 而「先讲清楚有什么」和「再告诉你缺什么」本来就该有个先后。
         */}
        {showIntro && (
          <div className="start-intro">
            <div className="start-intro-head">
              <Compass size={13} />
              <b>第一次用？三条路各管一件事</b>
              <i>看完随手收掉，它不会再挡在这里</i>
            </div>
            <div className="start-intro-row">
              <span className="start-intro-name">
                <Users size={12} />
                研讨
              </span>
              <span className="start-intro-desc">
                一个议题交给几个模型，让它们互相质疑，最后由主持模型出纪要：结论、分歧、各自原话都在。
              </span>
              <button type="button" className="go" onClick={onDismissIntro}>
                就在这儿写议题
              </button>
            </div>
            <div className="start-intro-row">
              <span className="start-intro-name">
                <MessageCircle size={12} />
                聊天
              </span>
              <span className="start-intro-desc">只想问一个模型：单独对话，能发图片、能带文件，也能在它回答中途插话。</span>
              <button
                type="button"
                onClick={() => {
                  onDismissIntro()
                  onOpenChat()
                }}
              >
                去聊天
              </button>
            </div>
            <div className="start-intro-row">
              <span className="start-intro-name">
                <Sparkles size={12} />
                助手
              </span>
              <span className="start-intro-desc">
                出问题让它去查：读日志、跑体检、改配置、接新模型。动手前会先把要改的东西摊给你确认。
              </span>
              <button
                type="button"
                onClick={() => {
                  onDismissIntro()
                  onOpenAssistant()
                }}
              >
                打开助手
              </button>
            </div>
            <div className="start-intro-foot">
              <span>三条路共用同一份模型清单 —— 先登录一个网页模型，或在设置页配一个带 Key 的 API 模型。</span>
              <button type="button" onClick={onDismissIntro}>
                知道了，不再显示
              </button>
            </div>
          </div>
        )}

        {!showIntro && models.length > 0 && usable.length === 0 && (
          <div className="start-check">
            <div className="start-check-head">
              <Stethoscope size={13} />
              <b>现在还没有能发言的模型</b>
              <i>下面任选一条做完，这场讨论就能开</i>
            </div>
            {webCandidates.length > 0 && (
              <div className="start-check-row">
                <span className="start-check-icon">
                  <Globe size={13} />
                </span>
                <span className="start-check-main">
                  <b>登录一个网页模型</b>
                  <i>点下面的名字会打开它的页面，登录成功会自动转绿；网页模型只能发言，当不了主持</i>
                  <span className="start-check-chips">
                    {webCandidates.slice(0, 6).map((m) => (
                      <button key={m.id} type="button" onClick={() => onPickWebModel(m.id)}>
                        {m.displayName}
                      </button>
                    ))}
                  </span>
                </span>
              </div>
            )}
            <div className="start-check-row">
              <span className="start-check-icon">
                <KeyRound size={13} />
              </span>
              <span className="start-check-main">
                <b>配一个 API 模型</b>
                <i>有 Key 就能用，也能担任主持模型出小结；设置页里贴一段接口说明就能自动识别</i>
                <span className="start-check-chips">
                  <button type="button" className="go" onClick={onGotoSettings}>
                    去设置页添加
                  </button>
                </span>
              </span>
            </div>
            {/*
             * 这里刻意不给「让助手替你查」这一条：助手自己也要一个已填 Key 的 API 模型才能跑，
             * 而这块只在「一个能发言的模型都没有」时出现 —— 摆上去等于把人领进另一个死路。
             */}
          </div>
        )}

        <section className="ns-sec">
          <div className="ns-sec-head">
            <h2 className="ns-sec-title">
              <MessageSquare size={12} />
              议题
            </h2>
            <span className="ns-sec-note">标题决定讨论范围，背景材料决定它们引用得到什么</span>
          </div>
          <input
            className="ns-topic"
            type="text"
            aria-label="议题标题"
            value={s.topicTitle}
            placeholder="评估为报表系统引入实时计算层的必要性"
            onChange={(e) => s.patchConfig({ topicTitle: e.target.value })}
          />
          <textarea
            className="ns-bg"
            aria-label="背景材料"
            value={s.topicBackground}
            placeholder="可选。当前系统日均查询 2 万次，报表生成延迟 P95 约 8 秒…"
            onChange={(e) => s.patchConfig({ topicBackground: e.target.value })}
          />
        </section>

        <section className="ns-sec">
          <div className="ns-sec-head">
            <h2 className="ns-sec-title">
              <Users size={12} />
              参与模型
            </h2>
            <span className="ns-sec-note">
              已选 {picked.length} 个（API {mix.api} · 网页 {mix.webview}）· 点名字切换，虚线那颗还没登录
              {mix.webview > 0
                ? ` · 网页模型逐条等页面出答案，每多一个，一轮慢几十秒到一分多钟`
                : picked.length > 0
                  ? ' · 全 API 通道，一轮通常几十秒内'
                  : ''}
            </span>
          </div>
          <div className="ns-chips">
            {models.map((m) => {
              const on = s.participantIds.includes(m.id)
              const isModerator = s.moderatorId === m.id
              const blocked =
                m.transport === 'webview' && (m.status === 'expired' || m.status === 'adapter-broken')
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`ns-chip${on ? ' on' : ''}${blocked ? ' blocked' : ''}`}
                  aria-pressed={on}
                  title={
                    blocked
                      ? '会话过期或适配器失效：点这里打开它的页面重新登录'
                      : m.adapterStale
                        ? '适配器长期未验证，可能已失效'
                        : undefined
                  }
                  onClick={() => {
                    /* 已失效的模型不该只给一句「不能选」：点这里就是把人领去登录 */
                    if (blocked) onPickWebModel(m.id)
                    else s.toggleParticipant(m.id)
                  }}
                >
                  <span className="ns-chip-face">
                    <ModelChip m={m} faviconUrls={getFaviconUrls(m.domain)} />
                  </span>
                  {m.displayName}
                  {/* 兼岗要说在名字上：勾上它的参会胶囊时，用户得知道自己正在让主持下场发言 */}
                  {isModerator && (
                    <span
                      className={`ns-chip-mod${on ? ' on' : ''}`}
                      title={on ? '本场主持 · 已兼参会发言' : '本场主持（未勾选则只出小结）'}
                    >
                      <Crown size={9} />
                      主持
                    </span>
                  )}
                  <span className="ns-chip-tag">
                    {blocked ? '未登录' : m.transport === 'webview' ? '网页' : m.hasKey ? 'API' : '无Key'}
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        <section className="ns-sec">
          <div className="ns-sec-head">
            <h2 className="ns-sec-title">
              <Crown size={12} />
              主持模型
            </h2>
            <span className="ns-sec-note">
              {s.moderatorId && s.participantIds.includes(s.moderatorId)
                ? '本场兼参会：轮内一起发言，轮间照样出小结'
                : '不参与发言，只在轮间出小结、最后出纪要'}
            </span>
          </div>
          <div className="ns-select-wrap">
            <select
              className="ns-select"
              aria-label="主持模型"
              value={s.moderatorId ?? ''}
              onChange={(e) => s.patchConfig({ moderatorId: e.target.value || null })}
            >
              <option value="">无主持（跑满轮次直接出报告）</option>
              {moderatorOptions.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.hasKey}>
                  {m.displayName}
                  {m.hasKey ? '' : '（未填 API Key）'}
                  {m.hasKey && s.participantIds.includes(m.id) ? '（已在参会名单 · 兼发言）' : ''}
                </option>
              ))}
            </select>
          </div>
          {/* 网页通道不进列表：它无法产出结构化小结，选中后讨论会在结尾静默降级成无主持 */}
          {moderatorOptions.length === 0 && (
            <p className="ns-note">
              <AlertTriangle size={12} />
              主持只能由 API 模型担任。在设置页「API 模型」中自建并填好 Key，这里才会出现可用项。
            </p>
          )}
          {/*
           * 兼岗不是免费的功能：多等它一轮发言是小事，它随后要评判自己说过的话才是代价。
           * 所以这里说清程序替用户兜住了哪一条（基线仍由别的模型答），别让人以为全场自问自答。
           */}
          {s.moderatorId && s.participantIds.includes(s.moderatorId) && (
            <p className="ns-note">
              <AlertTriangle size={12} />
              主持同时参会可能高估共识：每轮多等它一次发言，小结时它要判自己说过的话 —— 提示词已要求把它当普通观点、不得自我背书，单模型基线仍交给名单里的其他模型独立作答。想要最干净的对照就分开指定。
            </p>
          )}
        </section>

        <section className="ns-sec">
          <div className="ns-sec-head">
            <h2 className="ns-sec-title">
              <Settings2 size={12} />
              讨论策略
            </h2>
            <span className="ns-sec-note">决定模型之间怎么说话</span>
          </div>
          <div className="ns-seg">
            {(['roundtable', 'debate', 'review'] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={`ns-seg-item${s.strategy === k ? ' on' : ''}`}
                aria-pressed={s.strategy === k}
                onClick={() => s.patchConfig({ strategy: k })}
              >
                <span className="ns-seg-name">
                  {STRATEGY_ICONS[k]}
                  {STRATEGY_LABEL[k]}
                </span>
                <span className="ns-seg-desc">{STRATEGY_DESC[k]}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="ns-sec">
          <div className="ns-sec-head">
            <h2 className="ns-sec-title">
              <ShieldCheck size={12} />
              互评、对照与核验
            </h2>
            <span className="ns-sec-note">越严格多花的时间越多，但结论更可证伪</span>
          </div>
          <div className="ns-rows">
            <SwitchRow
              on={s.anonymousReview}
              name="匿名互评"
              desc="参会模型与主持模型都只看到「参会者A/B…」，论据按内容而非厂商评判。想验证「抱团」影响，就同一议题跑两场并切换这里。"
              onToggle={() => s.patchConfig({ anonymousReview: !s.anonymousReview })}
            />
            <SwitchRow
              on={s.baseline}
              icon={<GitCompare size={11} />}
              name="单模型基线"
              desc="讨论开始前，先让一个模型就同一议题独立作答。没有它，报告只能说明大家说了什么，不能说明比直接问一个强模型多出了什么。基线不进入任何轮次、不写进纪要。"
              onToggle={() => s.patchConfig({ baseline: !s.baseline })}
            />
            <SwitchRow
              on={s.baselineCompare}
              icon={<GitCompare size={11} />}
              name="基线对照"
              desc="出报告前让主持比对：研讨多出什么、基线有什么而研讨反而丢了什么。多一次主持调用，换一条可证伪的结论。"
              onToggle={() => s.patchConfig({ baselineCompare: !s.baselineCompare })}
            />
            <div className="ns-row">
              <span className="ns-row-main">
                <span className="ns-row-name">
                  <Stethoscope size={11} />
                  幻觉核验轮
                </span>
                <span className="ns-row-desc">
                  程序只统计本场内部可判死的问题：凭空引用、主持替模型表态（代答）。核验轮会直接质询当事模型，否认即从支持方移出。无人否认不等于确认 —— 无应答的条目保持「未核验」。
                </span>
              </span>
              <div className="ns-seg tight" role="radiogroup" aria-label="核验档位">
                {(['off', 'auto', 'always'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={s.verifyPass === k}
                    className={`ns-seg-item${s.verifyPass === k ? ' on' : ''}`}
                    title={VERIFY_DESC[k]}
                    onClick={() => s.patchConfig({ verifyPass: k as VerifyPassMode })}
                  >
                    <span className="ns-seg-name">{k === 'off' ? '关闭' : k === 'auto' ? '自动' : '逐条'}</span>
                    <span className="ns-seg-desc">{VERIFY_DESC[k]}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="ns-sec">
          <div className="ns-sec-head">
            <h2 className="ns-sec-title">
              <SlidersHorizontal size={12} />
              轮次与代价上限
            </h2>
            <span className="ns-sec-note">
              网页通道按不到金额，墙钟是唯一兜得住代价的闸门：到点即收束出报告，不静默截断
            </span>
          </div>
          <div className="ns-limits">
            <div className="ns-limit">
              <span className="ns-num-label">最大轮次</span>
              <div className="ns-seg ns-valchips" role="radiogroup" aria-label="最大轮次">
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={s.maxRounds === n}
                    className={`ns-valchip${s.maxRounds === n ? ' on' : ''}`}
                    onClick={() => s.patchConfig({ maxRounds: n })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="ns-limit">
              <span className="ns-num-label">预算上限</span>
              <div className="ns-seg ns-valchips" role="radiogroup" aria-label="预算上限常用档">
                {[1, 2, 5, 10, 20].map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={s.budgetLimitUsd === n}
                    className={`ns-valchip${s.budgetLimitUsd === n ? ' on' : ''}`}
                    onClick={() => s.patchConfig({ budgetLimitUsd: n })}
                  >
                    ${n}
                  </button>
                ))}
              </div>
              <div className="ns-num-field">
                <input
                  type="number"
                  aria-label="预算上限（美元）"
                  value={s.budgetLimitUsd}
                  min={0.1}
                  max={1000}
                  step={0.1}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (Number.isFinite(n) && n > 0) s.patchConfig({ budgetLimitUsd: Math.min(1000, Math.max(0.1, n)) })
                  }}
                  onBlur={(e) => {
                    /* 清空或越界都立刻回到可用值：留一个非法数字在这里，开场会被主进程拒掉 */
                    const n = Number(e.target.value)
                    s.patchConfig({
                      budgetLimitUsd:
                        !Number.isFinite(n) || n <= 0
                          ? s.discussionDefaults.budgetLimitUsd
                          : Math.min(1000, Math.max(0.1, n)),
                    })
                  }}
                />
                <span className="ns-num-unit">美元</span>
              </div>
            </div>
            <div className="ns-limit">
              <span className="ns-num-label">时长上限</span>
              <StepperField
                value={s.timeBudgetMin}
                min={1}
                max={60}
                step={1}
                unit="分钟"
                fallback={s.discussionDefaults.timeBudgetMin}
                onChange={(v) => s.patchConfig({ timeBudgetMin: v })}
              />
            </div>
          </div>
        </section>
      </div>

      <footer className="ns-foot">
        <div className="ns-foot-bar">
          <div className="ns-foot-main">
            <div className="ns-foot-sum">
              {picked.length > 0
                ? `${picked.map((m) => m.displayName).join('、')}${s.moderatorId ? ` · 主持：${moderatorOptions.find((m) => m.id === s.moderatorId)?.displayName ?? ''}` : ''}`
                : '默认配置下约 2~4 分钟出报告'}
            </div>
            <div className={`ns-foot-hint${startError || missing.length > 0 ? ' missing' : ''}`}>
              {startError
                ? startError
                : missing.length > 0
                  ? `还差：${missing.join('、')}`
                  : `${STRATEGY_LABEL[s.strategy]} · ${s.maxRounds} 轮 · 上限 ${s.budgetLimitUsd} 美元 / ${s.timeBudgetMin} 分钟`}
            </div>
          </div>
          <button type="button" className="ns-go" onClick={() => void handleStart()} disabled={!canStart}>
            <Play size={13} />
            {starting ? '正在开场…' : '开始讨论'}
          </button>
        </div>
      </footer>
    </div>
  )
}

function SwitchRow({
  on,
  name,
  desc,
  icon,
  onToggle,
}: {
  on: boolean
  name: string
  desc: string
  icon?: React.ReactNode
  onToggle: () => void
}) {
  return (
    <button type="button" className={`ns-row${on ? ' on' : ''}`} aria-pressed={on} onClick={onToggle}>
      <span className="ns-row-main">
        <span className="ns-row-name">
          {icon ?? <EyeOff size={11} />}
          {name}
        </span>
        <span className="ns-row-desc">{desc}</span>
      </span>
      <span className={`ns-switch${on ? ' on' : ''}`} aria-hidden="true" />
    </button>
  )
}

function StepperField({
  value,
  min,
  max,
  step,
  unit,
  fallback,
  onChange,
}: {
  value: number
  min: number
  max: number
  step: number
  unit: string
  fallback: number
  onChange: (v: number) => void
}) {
  // 长按连发：先单发一步，400ms 后每 90ms 一步；步进取最新值，不能闭包捕获旧 value
  const valueRef = useRef(value)
  valueRef.current = value
  const timers = useRef<{ delay?: number; tick?: number }>({})
  const stop = () => {
    if (timers.current.delay) window.clearTimeout(timers.current.delay)
    if (timers.current.tick) window.clearInterval(timers.current.tick)
    timers.current = {}
  }
  useEffect(() => stop, [])
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  const start = (dir: 1 | -1) => {
    stop()
    onChange(clamp(valueRef.current + dir * step))
    timers.current.delay = window.setTimeout(() => {
      timers.current.tick = window.setInterval(() => onChange(clamp(valueRef.current + dir * step)), 90)
    }, 400)
  }
  return (
    <div className="ns-stepper">
      <button
        type="button"
        className="ns-step-btn"
        aria-label={`减少${unit}`}
        onPointerDown={() => start(-1)}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
      >
        <Minus size={12} />
      </button>
      <div className="ns-num-field">
        <input
          type="number"
          aria-label={`时长上限（${unit}）`}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n) && n > 0) onChange(clamp(n))
          }}
          onBlur={(e) => {
            const n = Number(e.target.value)
            onChange(!Number.isFinite(n) || n <= 0 ? fallback : clamp(n))
          }}
        />
        <span className="ns-num-unit">{unit}</span>
      </div>
      <button
        type="button"
        className="ns-step-btn"
        aria-label={`增加${unit}`}
        onPointerDown={() => start(1)}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
      >
        <Plus size={12} />
      </button>
    </div>
  )
}

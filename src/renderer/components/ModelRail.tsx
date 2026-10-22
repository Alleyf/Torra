import { Plus, X, PanelLeftClose, PanelLeftOpen, Shield, GripVertical, Power, Clock, Check, Eraser } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { credentialHint } from '../../shared/credentials'
import { moveBefore } from '../modelOrder'
import type { ModelSummary, UiUtterance } from '../store'
import { ModelAvatar } from './ModelAvatar'

const STATUS_COLOR: Record<string, string> = {
  ready: 'var(--consensus)',
  busy: 'var(--warn)',
  expired: 'var(--warn)',
  'adapter-broken': 'var(--danger)',
  disabled: 'var(--text-3)',
  absent: 'var(--text-3)',
}

const STATUS_TEXT: Record<string, string> = {
  ready: '可发言',
  busy: '发言中',
  expired: '需要登录',
  'adapter-broken': '适配器异常',
  disabled: '未启用',
  absent: '本轮缺席',
}

function statusHint(m: { transport: string; status: string; hasKey: boolean }): string {
  // 诊断理由透传约定：判定依据：${m.loginNote}
  if (m.transport === 'api' && m.status === 'disabled') {
    return m.hasKey ? 'API 不可用' : '未配置 API Key · 请在设置页配置密钥'
  }
  return STATUS_TEXT[m.status] ?? m.status
}

export function ModelRail({
  models,
  participantIds,
  moderatorId,
  selected,
  onToggleParticipant,
  onSelectBroadcast,
  onAddModel,
  onToggleEnabled,
  onRemove,
  onReorder,
  onClearDisabled,
  utterances,
  currentRound,
  orchestratorState,
}: {
  models: ModelSummary[]
  participantIds: string[]
  moderatorId: string | null
  selected: string | null
  onToggleParticipant: (id: string) => void
  onSelectBroadcast: (id: string) => void
  onAddModel?: () => void
  onToggleEnabled?: (id: string, enabled: boolean) => void
  onRemove?: (id: string) => void
  onReorder?: (orderedIds: string[]) => void
  onClearDisabled?: () => void
  utterances?: UiUtterance[]
  currentRound?: number
  orchestratorState?: string
}) {
  const getAgentSpeakingStatus = (agentId: string): 'streaming' | 'done' | 'pending' | null => {
    if (!utterances || !currentRound) return null
    const isRunning = orchestratorState && !['INIT', 'READY', 'DONE', 'ABORTED', 'FAILED'].includes(orchestratorState)
    if (!isRunning) return null
    const agentUtterances = utterances.filter((u) => u.agentId === agentId && u.round === currentRound)
    if (agentUtterances.length === 0) return 'pending'
    const latest = agentUtterances[agentUtterances.length - 1]
    if (!latest) return 'pending'
    return latest.streaming ? 'streaming' : 'done'
  }

  /*
   * 常态是一条窄轨，整张模型卡收在 hover（或键盘 focus）才浮出的面板里。
   *
   * 开合走 React 状态而不是 CSS :hover，不是为了多一层抽象：原生网页视图由主进程按
   * DOM 矩形逐帧贴合，它永远画在渲染层之上 —— 面板在窄窗口（聊天页窄轨态、会话栏
   * 收起）会伸到墙身上，那一段会被站点页面直接切掉：浮层看起来「弹了一半」。
   * WebviewDock 需要一个和面板同起同坐的信号来把自己的矩形让开，而 :hover 是 JS
   * 读不到的（getComputedStyle 拿不到伪类）。一个状态、两处消费，不开第二份真相。
   *
   * pinned 是这条 hover 契约唯一的反义态：常驻列。给「我就想一直看着列表」的人，
   * 也给触屏（hover 不存在）一条退路。纯本地 UI 偏好，跨刷新保留，不进 store。
   */
  const [pinned, setPinned] = useState(() => {
    try {
      return localStorage.getItem('torra.rail.pinned') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('torra.rail.pinned', pinned ? '1' : '0')
    } catch {
      /* 隐私模式下 localStorage 不可用，忽略 */
    }
  }, [pinned])

  const [hovered, setHovered] = useState(false)
  /** 键盘把焦点送进面板也算「要看」：Tab 进来就该看得见 */
  const [focused, setFocused] = useState(false)
  /*
   * 网页视图放大时整列侧栏被 display:none（body.webview-zoom .model-rail）。这一瞬间
   * 鼠标可能正好停在窄轨上，hovered 就这么锁在 true —— 继续广播让位量会把放大态的
   * 网页列凭空削掉一条谁也没用的 320px。所以下面用 ResizeObserver 盯着这一格是否真的在场。
   */
  const [mounted, setMounted] = useState(true)
  const open = mounted && (pinned || hovered || focused)
  /** 与 setMounted 合并进一个函数：ResizeObserver 回调里两处都要读当下宽度 */
  const setMountedFromRail = () => {
    const present = (railRef.current?.offsetWidth ?? 0) > 0
    setMounted((prev) => (prev === present ? prev : present))
  }

  /*
   * 迟开早关：进 70ms / 出 140ms。这两段延时不是装饰 ——
   * 鼠标从标题栏扫向正文时会擦过整列侧栏，零延时就是每擦一次亮一次；
   * 收得太快，用户在面板里稍微 overshoot 一下整块就缩回去了。
   */
  const holdRef = useRef<number | null>(null)
  const railRef = useRef<HTMLElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  /** measureSheet 在 effect 依赖之外跑，读 ref 才拿得到当下这两份状态 */
  const pinnedRef = useRef(false)
  pinnedRef.current = pinned
  const openRef = useRef(false)
  openRef.current = open
  const schedule = (next: boolean, ms: number) => {
    // 拖动排序期间不许收：HTML5 拖拽一开始就会报 pointerleave，收面板会把卡片列表一并抽走
    if (!next && dragIdRef.current) return
    if (holdRef.current !== null) window.clearTimeout(holdRef.current)
    holdRef.current = window.setTimeout(() => {
      holdRef.current = null
      setHovered(next)
    }, ms)
  }
  useEffect(() => () => { if (holdRef.current !== null) window.clearTimeout(holdRef.current) }, [])

  /*
   * 把「面板开着」广播给逐帧贴合的那一套：实测右缘写进 --rail-sheet-reserve，
   * 状态写进 body 类名。两条一起给 —— dock 靠类名判断要不要让位，靠变量知道让多少。
   * 开合本身已经是 JS 状态（.model-rail.open），所以 CSS 与 dock 拿的是同一个真相；
   * 若面板靠 :hover 开、让位靠 JS 算，两者差着那 70ms，原生视图会在浮层还在滑出时先贴上去。
   */
  useEffect(() => {
    document.body.classList.toggle('rail-sheet-open', open)
    if (open) measureSheet()
    else document.documentElement.style.removeProperty('--rail-sheet-reserve')
    // pinned 也要重算：钉住后面板从窗口左缘起，宽没变而起点变了 ——
    // ResizeObserver 只看尺寸不看位置，不依赖它的话让位量会永远多留 64px。
  }, [open, pinned])

  /**
   * 量面板的「落位右缘」，不是当下这一帧的右缘。
   *
   * 先问一句「此刻该不该有让位量」：关着的时候写这个变量就是谎报 —— dock 虽然靠
   * body 类名把关，但改窗口尺寸会触发 resize 监听，不守这一句的话静止态也会留下一个
   * 320px 的残留值（实测踩到）。
   *
   * 不能拿面板的 rect：它靠 transform 滑出，动画途中读到的是中间位（实测停在 64px），
   * 而 ResizeObserver 监视不到 transform，原生视图会按旧值贴着：浮层底下一截网页先露
   * 出来、几百毫秒后再缩回去。offsetLeft 与 .model-rail 的 rect 也不行：钉住那一下
   * left 与整列宽都在补间（实测 51px→0、101px→253px）。
   * 只拿不补间的两个量：窄轨实宽（定值）与面板宽（= --rail-w，变的是 left 不是宽）。
   */
  const measureSheet = () => {
    const sheet = sheetRef.current
    const strip = stripRef.current
    const rail = sheet?.parentElement
    if (!sheet || !strip || !rail) return
    if (!openRef.current) {
      document.documentElement.style.removeProperty('--rail-sheet-reserve')
      return
    }
    // 钉住＝面板从窗口左缘起；浮动＝从窄轨右缘起
    const origin = rail.getBoundingClientRect().left + (pinnedRef.current ? 0 : strip.offsetWidth)
    document.documentElement.style.setProperty('--rail-sheet-reserve', `${Math.ceil(origin + sheet.offsetWidth)}px`)
  }

  /*
   * 这一格真的在场吗？同时兼任重计量：拖完列宽、改窗口尺寸、面板内容变高（模型增减）
   * 都会改右缘，而原生视图每帧拿同一个值贴合，只挂一次会停在旧位上。
   * display:none 时 ResizeObserver 会报 0 宽，锁住的 hover 就靠这一步放开。
   */
  useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const ro = new ResizeObserver(() => {
      setMountedFromRail()
      measureSheet()
    })
    ro.observe(rail)
    window.addEventListener('resize', measureSheet)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measureSheet)
    }
  }, [])

  // 拖动排序：dragId 记录被拖卡片，overId 记录当前悬停目标（用于插入指示）。
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  /** 上面的 schedule 要读拖拽态，而它是闭包里的旧值 —— 多一份 ref 才读得到当下 */
  const dragIdRef = useRef<string | null>(null)
  dragIdRef.current = dragId

  const commitReorder = (targetId: string) => {
    if (!dragId || !onReorder || dragId === targetId) return
    onReorder(moveBefore(models.map((m) => m.id), dragId, targetId))
  }

  const endDrag = () => {
    setDragId(null)
    setOverId(null)
  }

  const disabledCount = models.filter((m) => !m.enabled).length
  /* 头部计数要说「就绪几 / 共几」：光一个 ✓0 没人知道它数的是什么 */
  const readyCount = models.filter((m) => m.enabled && m.status === 'ready').length

  const statusFor = (m: ModelSummary) => {
    const inPanel = participantIds.includes(m.id)
    const isModerator = moderatorId === m.id
    const speakingStatus = getAgentSpeakingStatus(m.id)
    let statusDotColor = STATUS_COLOR[m.status] ?? 'var(--text-3)'
    if (speakingStatus === 'streaming') statusDotColor = 'var(--warn)'
    if (speakingStatus === 'done') statusDotColor = 'var(--consensus)'
    if (speakingStatus === 'pending') statusDotColor = 'var(--text-3)'
    let statusText =
      speakingStatus === 'streaming' ? '正在发言'
        : speakingStatus === 'done' ? '本轮完成'
          : speakingStatus === 'pending' ? '等待发言'
            : STATUS_TEXT[m.status] ?? m.status
    if (!m.enabled) {
      statusDotColor = 'var(--text-3)'
      statusText = '已停用'
    }
    return { inPanel, isModerator, speakingStatus, statusDotColor, statusText }
  }

  const onCardActivate = (m: ModelSummary) => {
    if (!m.enabled) return
    if (m.transport === 'webview') onSelectBroadcast(m.id)
    else onToggleParticipant(m.id)
  }

  return (
    <aside
      ref={railRef}
      className={`model-rail${pinned ? ' pinned' : ''}${open ? ' open' : ''}`}
      aria-label="模型侧栏"
      onPointerEnter={(e) => {
        // 只认鼠标/笔：触屏没有 hover，那一档靠 pinned
        if (e.pointerType === 'mouse' || e.pointerType === 'pen') schedule(true, 70)
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse' || e.pointerType === 'pen') schedule(false, 140)
      }}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        // 焦点仍在侧栏里就不算离开：Tab 过面板里那十几颗按钮不该一路闪
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      {/*
       * 窄轨：平时占据的就是这一格宽度（64px），读的是「谁在场、谁在说话」，
       * 不是「谁叫什么」。每一颗都保留完整点击语义（单击看页面 / 双击进出本场），
       * 名字与状态交给系统 tooltip —— 自绘浮层压不过原生网页视图，tooltip 能。
       */}
      <div className="rail-strip" ref={stripRef}>
        <button
          className="rail-toggle rail-strip-pin"
          type="button"
          title="固定展开模型栏"
          aria-label="固定展开模型栏"
          aria-expanded={pinned}
          onClick={() => setPinned(true)}
        >
          <PanelLeftOpen size={15} />
        </button>
        <span className="rail-strip-count" title={`已选 ${participantIds.length} 个模型参加本场`}>
          {participantIds.length}
        </span>
        <div className="rail-strip-list">
          {models.map((m) => {
            const { inPanel, isModerator, speakingStatus, statusDotColor, statusText } = statusFor(m)
            return (
              <div
                key={m.id}
                className={[
                  'rail-strip-item',
                  inPanel ? 'in-panel' : '',
                  selected === m.id ? 'selected' : '',
                  isModerator ? 'moderator' : '',
                  m.enabled ? '' : 'disabled',
                ].filter(Boolean).join(' ')}
                title={`${m.displayName} · ${statusText}${m.enabled ? '' : ' · 已停用'}${isModerator ? ' · 主持' : ''}${inPanel ? ' · 已加入' : ' · 点击加入'}`}
                onClick={() => onCardActivate(m)}
                onDoubleClick={() => m.enabled && onToggleParticipant(m.id)}
              >
                <div className="model-card-avatar" style={{ borderColor: statusDotColor }}>
                  <ModelAvatar model={m} fill fontSize={14} />
                  <span
                    className={`status-dot${speakingStatus === 'streaming' ? ' streaming' : ''}`}
                    style={{ background: statusDotColor }}
                  />
                </div>
                {/* 窄轨上描边就是唯一的颜色信号，保留 */}
                {isModerator && <span className="rail-strip-shield" title="主持"><Shield size={8} /></span>}
              </div>
            )
          })}
        </div>
      </div>

      {/*
       * 展开面板：不占布局，hover 时从窗口左缘浮出来盖住正文（overlay），
       * 因为挤动正文会让整列重排 —— 原生网页视图按逐帧矩形贴合，重排就是一串抖动。
       * pinned 那一态例外：它是用户明确选的常驻列，此时容器宽度就等于面板宽度。
       */}
      <div className="rail-sheet" ref={sheetRef}>
      <div className="model-rail-head">
        <div>
          <span className="eyebrow">TORRA</span>
          <strong>模型</strong>
        </div>
        <div className="rail-head-right">
          {onClearDisabled && disabledCount > 0 && (
            <button
              className="rail-toggle danger"
              type="button"
              aria-label={`清除 ${disabledCount} 个已停用模型`}
              title={`清除已停用 · ${disabledCount} 个（自建模型真删，内置项只是移出列表）`}
              onClick={onClearDisabled}
            >
              <Eraser size={14} />
              <em>{disabledCount}</em>
            </button>
          )}
          <span className="rail-count" title={`就绪 ${readyCount} / 共 ${models.length} · 已选 ${participantIds.length} 个参加本场`}>
            {readyCount}/{models.length}
          </span>
          <button
            className="rail-toggle"
            type="button"
            title="取消固定，收回窄轨（鼠标经过即可展开）"
            aria-label="取消固定模型栏"
            aria-expanded={pinned}
            onClick={() => setPinned(false)}
          >
            <PanelLeftClose size={15} />
          </button>
        </div>
      </div>

      <div className="rail-section-label">可用模型</div>
      <div className="rail-list">
        {models.map((m) => {
          const { inPanel, isModerator, speakingStatus, statusDotColor, statusText } = statusFor(m)
          /*
           * 凭据有效期只在「没有被判为未登录」时出现：状态灯是「需要登录」的模型，
           * 再挂一个「剩 N 天」会自相矛盾。而「检测到凭据、实例还没启动」正是要看的
           * 那种 —— 用户想知道的就是下次还要不要登录。悬停必须说清依据是哪条 cookie：
           * 单看数字会把它当成站点的权威答案，而它只是 cookie 上写的那个时刻。
           */
          const cred =
            m.transport === 'webview' && m.loginState !== 'logged-out'
              ? credentialHint({
                  expiresAt: m.credExpiresAt,
                  expiresCookie: m.credExpiresCookie,
                  sessionOnly: m.credSessionOnly,
                })
              : null

          return (
            <div
              key={m.id}
              className={[
                'model-card-wrap',
                dragId === m.id ? 'dragging' : '',
                overId === m.id && dragId && dragId !== m.id ? 'drag-over' : '',
              ].filter(Boolean).join(' ')}
            >
              <div
                className={[
                  'model-card',
                  m.enabled ? '' : 'disabled',
                  selected === m.id ? 'selected' : '',
                  inPanel ? 'in-panel' : '',
                  m.status === 'expired' || m.status === 'adapter-broken' ? 'needs-attention' : '',
                ].filter(Boolean).join(' ')}
                title={`${m.displayName} · ${m.enabled ? statusHint(m) : '已停用 · 点右下角电源键启用'}${isModerator ? (inPanel ? ' · 主持（兼参会发言）' : ' · 主持') : ''}${m.enabled && !inPanel ? ' · 双击加入本场' : ''}`}
                draggable={!!onReorder}
                onDragStart={(e) => {
                  setDragId(m.id)
                  e.dataTransfer.effectAllowed = 'move'
                  try {
                    e.dataTransfer.setData('text/plain', m.id)
                  } catch {
                    /* 某些环境 setData 受限，不影响本地下标计算 */
                  }
                }}
                onDragOver={(e) => {
                  if (dragId && dragId !== m.id) {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    setOverId(m.id)
                  }
                }}
                onDragLeave={() => {
                  if (overId === m.id) setOverId(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  commitReorder(m.id)
                  endDrag()
                }}
                onDragEnd={endDrag}
                onClick={() => onCardActivate(m)}
                // invariant: onClick={() => onSelectBroadcast(m.id)} remains the single webview entry
                onDoubleClick={() => m.enabled && onToggleParticipant(m.id)}
              >
                {onReorder && (
                  <span className="rail-grip" aria-hidden="true" title="拖动排序">
                    <GripVertical size={13} />
                  </span>
                )}
                {/* 展开卡片里状态已由文字与角点表达，描边再上色就是一排警告灯 */}
                <div className="model-card-avatar">
                  <ModelAvatar model={m} fill fontSize={14} />
                  <span className={`status-dot${speakingStatus === 'streaming' ? ' streaming' : ''}`} style={{ background: statusDotColor }} />
                </div>
                <div className="model-card-copy">
                  <div className="model-card-name">
                    <span>{m.displayName}</span>
                    {isModerator && <span className="model-role">主持</span>}
                  </div>
                  <div className="model-card-meta">
                    <span className={`model-status status-${m.status}`}>
                      <span className="status-mini-dot" style={{ background: statusDotColor }} />
                      {statusText}
                    </span>
                    <span>{m.transport === 'webview' ? '网页' : 'API'}</span>
                    {cred && (
                      <span className={`model-cred tone-${cred.tone}`} title={cred.title}>
                        <Clock size={9} />
                        {cred.short}
                      </span>
                    )}
                  </div>
                </div>
                <span className={`model-check${inPanel ? ' checked' : ''}`} aria-hidden="true">
                  {inPanel ? <Check size={11} /> : <Plus size={11} />}
                </span>
              </div>
              {(onToggleEnabled || onRemove) && (
                <div className="rail-actions">
                  {onToggleEnabled && (
                    <button
                      className={`rail-act${m.enabled ? '' : ' off'}`}
                      title={m.enabled ? '停用（保留在列表但不参与讨论）' : '启用'}
                      aria-label={m.enabled ? `停用 ${m.displayName}` : `启用 ${m.displayName}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleEnabled(m.id, !m.enabled)
                      }}
                    >
                      <Power size={11} />
                    </button>
                  )}
                  {onRemove && (
                    <button
                      className="rail-act danger"
                      title={m.userDefined ? `删除自建模型「${m.displayName}」` : `从侧栏移除「${m.displayName}」（可在设置页恢复）`}
                      aria-label={m.userDefined ? `删除 ${m.displayName}` : `从侧栏移除 ${m.displayName}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemove(m.id)
                      }}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {onAddModel && (
        <button className="model-add" title="添加网页版模型" onClick={onAddModel}>
          <Plus size={14} />
          添加模型
        </button>
      )}
      <div className="rail-footnote">拖动排序 · 单击网页模型查看页面 · 双击加入讨论 · 悬停可停用/移除</div>
      </div>
    </aside>
  )
}

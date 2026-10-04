import { useEffect, useRef, useState } from 'react'
import type { ModelSummary } from '../store'
import {
  WEB_ROLES,
  type ApiMeta,
  type ApiProbe,
  type QuestionTarget,
  type SmartStage,
  type WebPlan,
  type WebRole,
} from '@shared/smart-add'
import {
  AlertTriangle,
  CheckCircle,
  Globe,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  ScanSearch,
  Send,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from 'lucide-react'

const ROLE_LABEL: Record<WebRole, string> = {
  input: '输入框',
  send: '发送按钮',
  stop: '停止按钮',
  stream: '回复容器',
  generating: '生成中标志',
}

const KINDS = [
  { id: 'auto', label: '自动判断', icon: Sparkles },
  { id: 'web', label: '网页版', icon: Globe },
  { id: 'api', label: 'API 接入', icon: Zap },
] as const

type Kind = (typeof KINDS)[number]['id']

const mono = { fontFamily: 'var(--font-mono)', fontSize: 11.5 } as const

/** 枚举字段只能点选；名称/地址/选择器允许直接输入 */
const isFreeForm = (target: QuestionTarget) =>
  target === 'name' || target === 'entry' || target.startsWith('selectors.')

/**
 * 智能添加模型。
 *
 * 与手动弹窗的分工：这里负责「给个地址就能用」，手动弹窗负责精确微调。
 * 因此本界面的核心不是表单，而是**方案评审** —— 每一项都带着
 * 「助手的依据」和「页面实测命中数」，用户是在核对证据，不是在填字段。
 */
export function SmartAddDialog({
  models,
  onClose,
  onCreated,
}: {
  models: ModelSummary[]
  onClose: () => void
  onCreated: () => Promise<void> | void
}) {
  const apiModels = models.filter((m) => m.transport === 'api')
  const [kind, setKind] = useState<Kind>('auto')
  const [address, setAddress] = useState('')
  const [assistantId, setAssistantId] = useState(apiModels[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [err, setErr] = useState('')
  const [plan, setPlan] = useState<WebPlan | null>(null)
  const [probe, setProbe] = useState<ApiProbe | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [created, setCreated] = useState<{ id: string; name: string; transport: 'web' | 'api' } | null>(null)

  const stageRef = useRef('')

  useEffect(() => {
    const off = window.torra.on('smartadd:stage', (p) => {
      const s = p as SmartStage
      stageRef.current = s.text
      setStage(s.text)
    })
    return () => {
      off()
      // 识别用的临时窗口归本弹窗管，关掉弹窗就该收走
      void window.torra.smartAddClose()
    }
  }, [])

  const close = () => {
    void window.torra.smartAddClose()
    onClose()
  }

  const runWeb = async (entry: string, aid: string) => {
    const res = await window.torra.smartAddWebPlan({ entry, assistantModelId: aid || undefined })
    if (!res.ok || !res.plan) {
      setErr(res.reason ?? '识别失败')
      return
    }
    setPlan(res.plan)
    setProbe(null)
  }

  const runApi = async (entry: string) => {
    const res = await window.torra.smartAddApiProbe({ address: entry, apiKey: apiKey.trim() || undefined })
    setProbe(res)
    setPlan(null)
    if (!res.ok) setErr(res.reason ?? '嗅探失败')
  }

  const start = async () => {
    const entry = address.trim()
    if (!entry) return
    setBusy(true)
    setErr('')
    setStage('正在识别…')
    setPlan(null)
    setProbe(null)
    try {
      if (kind === 'web') {
        await runWeb(entry, assistantId)
      } else if (kind === 'api') {
        await runApi(entry)
      } else {
        // 自动：先花一次只读嗅探判断这是不是 API 端点，不像再走网页识别。
        // 顺序不能反 —— 开一次真实页面的代价（数秒 + 可能弹登录）远高于一次 GET。
        const p = await window.torra.smartAddApiProbe({ address: entry, apiKey: apiKey.trim() || undefined })
        if (p.ok) {
          setProbe(p)
          setStage('')
        } else {
          await runWeb(entry, assistantId)
        }
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
      setStage('')
    }
  }

  const createWeb = async (p: WebPlan) => {
    setBusy(true)
    setErr('')
    try {
      const res = await window.torra.createWebModel({
        displayName: p.name,
        entry: p.entry,
        selectors: {
          input: p.selectors.input,
          ...(p.selectors.send ? { send: p.selectors.send } : {}),
          ...(p.selectors.stop ? { stop: p.selectors.stop } : {}),
          ...(p.selectors.generating ? { generating: p.selectors.generating } : {}),
          stream: p.selectors.stream,
        },
        input_kind: p.input_kind,
        send_mode: p.send_mode,
        stream_mode: p.stream_mode,
        // 自定义完成策略目前统一落到最稳妥的 DOM 稳定兜底，避免把
        // 仅供智能推断阶段使用的 custom 值传入创建模型 IPC。
        completion_mode: p.completion_mode === 'custom' ? 'dom_stable' : p.completion_mode,
        stable_ms: p.stable_ms,
      })
      if (!res.ok || !res.id) {
        setErr(res.errors?.join('；') ?? '创建失败')
        return
      }
      setCreated({ id: res.id, name: p.name, transport: 'web' })
      await onCreated()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const answered = async (answers: Record<string, string>) => {
    if (!plan) return
    setBusy(true)
    try {
      const res = await window.torra.smartAddWebRefine(plan.planId, answers)
      if (res.ok && res.plan) setPlan(res.plan)
      else setErr(res.reason ?? '套用回答失败')
    } finally {
      setBusy(false)
    }
  }

  const reverify = async (p: WebPlan) => {
    setBusy(true)
    setErr('')
    try {
      const res = await window.torra.smartAddWebVerify(p.planId, p.selectors)
      if (res.ok && res.plan) setPlan({ ...res.plan })
      else setErr(res.reason ?? '校验失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask">
      <div className="modal" style={{ maxWidth: 780, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>
            <Sparkles size={18} />
            智能添加模型
          </h2>
          <button className="btn icon" onClick={close}>
            <X size={14} />
          </button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-2)' }}>
          只填地址：Torra 打开页面读取结构，交给配置助手推断，再逐条回到页面上验证命中数。
          助手拿不准的地方会来问你 —— 它只有建议权，最终配置由你确认。
        </p>

        <div className="field">
          <label>接入方式</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {KINDS.map((k) => {
              const Icon = k.icon
              return (
                <button
                  key={k.id}
                  className={`btn sm${kind === k.id ? ' primary' : ''}`}
                  onClick={() => setKind(k.id)}
                >
                  <Icon size={12} />
                  {k.label}
                </button>
              )
            })}
          </div>
          {kind === 'auto' && <p className="field-hint">先只读嗅探一次 /models：像 API 端点就走 API，否则按网页版处理。</p>}
        </div>

        <div className="field">
          <label>地址</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={address}
              placeholder={kind === 'api' ? 'https://api.deepseek.com/v1' : 'https://yuanbao.tencent.com/'}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && address.trim() && !busy) void start()
              }}
            />
            <button className="btn primary" disabled={!address.trim() || busy} onClick={() => void start()}>
              {busy ? <Loader2 size={12} className="spin" /> : <ScanSearch size={12} />}
              {busy ? '识别中…' : '智能识别'}
            </button>
          </div>
        </div>

        {kind !== 'api' && (
          <div className="field">
            <label>配置助手</label>
            {apiModels.length === 0 ? (
              <p className="field-hint" style={{ marginTop: 0 }}>
                还没有 API 模型可用 —— 网页识别会降级为纯规则推断（只保证选择器存在，不判断语义）。
                先在「添加 API 模型」里配一个，识别质量会有本质差别。
              </p>
            ) : (
              <>
                <select value={assistantId} onChange={(e) => setAssistantId(e.target.value)}>
                  {apiModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                      {m.hasKey ? '' : '（未填 Key）'}
                    </option>
                  ))}
                </select>
                <p className="field-hint">页面结构会发给这个模型阅读（约 4-6k tokens），不包含你的对话内容。</p>
              </>
            )}
          </div>
        )}

        {kind !== 'web' && (
          <div className="field">
            <label>API Key（可选）</label>
            <input
              type="password"
              value={apiKey}
              placeholder="sk-...；留空则复用同域名已有模型的密钥"
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        )}

        {busy && stage && (
          <div className="banner" style={{ borderRadius: 'var(--radius-sm)', marginBottom: 10 }}>
            <Loader2 size={14} className="spin" />
            {stage}
          </div>
        )}
        {err && !busy && (
          <div className="banner danger" style={{ borderRadius: 'var(--radius-sm)', marginBottom: 10 }}>
            <AlertTriangle size={14} />
            {err}
          </div>
        )}

        {created && (
          <CreatedCard
            created={created}
            onClose={close}
            onRetryWeb={created.transport === 'web' ? () => setCreated(null) : undefined}
          />
        )}

        {!created && plan && (
          <>
            <WebPlanCard
              plan={plan}
              busy={busy}
              onChange={(p) => setPlan(p)}
              onAnswered={(a) => void answered(a)}
              onVerify={() => void reverify(plan)}
              onCreate={() => void createWeb(plan)}
            />
            <div className="modal-actions">
              <button className="btn" onClick={close}>
                取消
              </button>
              <button className="btn" disabled={busy} onClick={() => void start()}>
                <RefreshCw size={12} />
                重新识别
              </button>
              <button
                className="btn primary"
                disabled={busy || !plan.selectors.input || !plan.selectors.stream}
                onClick={() => void createWeb(plan)}
              >
                <Plus size={13} />
                创建模型
              </button>
            </div>
          </>
        )}

        {!created && probe && (
          <ApiProbeCard
            probe={probe}
            address={address}
            apiKey={apiKey.trim()}
            assistantId={assistantId}
            onCreated={async (id, name) => {
              setCreated({ id, name, transport: 'api' })
              await onCreated()
            }}
            onError={setErr}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 网页版方案
// ---------------------------------------------------------------------------

function confidenceTag(v?: number) {
  if (v === undefined) return null
  const pct = Math.round(v * 100)
  const color = pct >= 80 ? 'var(--consensus)' : pct >= 55 ? 'var(--warn)' : 'var(--danger)'
  return (
    <span style={{ fontSize: 10.5, color, marginLeft: 6 }} title="配置助手自评的把握程度">
      置信 {pct}%
    </span>
  )
}

function checkTag(level?: 'ok' | 'warn' | 'fail', matches?: number, note?: string) {
  if (!level) return <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>未校验</span>
  const map = {
    ok: { icon: <CheckCircle size={10} />, color: 'var(--consensus)', text: `命中 ${matches ?? 0}` },
    warn: { icon: <AlertTriangle size={10} />, color: 'var(--warn)', text: note ?? `命中 ${matches ?? 0}` },
    fail: { icon: <AlertTriangle size={10} />, color: 'var(--danger)', text: note ?? '未命中' },
  } as const
  const v = map[level]
  return (
    <span style={{ fontSize: 10.5, color: v.color, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      {v.icon}
      {v.text}
    </span>
  )
}

function WebPlanCard({
  plan,
  busy,
  onChange,
  onAnswered,
  onVerify,
  onCreate,
}: {
  plan: WebPlan
  busy: boolean
  onChange: (p: WebPlan) => void
  onAnswered: (answers: Record<string, string>) => void
  onVerify: () => void
  onCreate: () => void
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const setSel = (role: WebRole, value: string) =>
    onChange({ ...plan, selectors: { ...plan.selectors, [role]: value }, checks: {} })

  const loginWarn = plan.login.state === 'logged-out' ? plan.login.reason : plan.login.state === 'unknown' ? plan.login.reason : ''
  const unanswered = plan.questions.filter((q) => answers[q.id])

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 14, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span className="state-tag" style={{ fontSize: 11 }}>
          {plan.source === 'assistant' ? `配置助手「${plan.assistant?.displayName ?? ''}」推断 · 第 ${plan.rounds} 轮` : '规则推断（未用助手）'}
        </span>
        {confidenceTag(plan.confidence.overall)}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)' }}>{plan.name}</span>
      </div>

      {loginWarn && (
        <div className="banner warn" style={{ borderRadius: 'var(--radius-sm)', marginBottom: 10, fontSize: 12, padding: '8px 12px' }}>
          <Info size={13} />
          登录态未确认：{loginWarn}。若实际未登录，识别结果不可用 —— 请在已打开的窗口里登录后重新识别。
        </div>
      )}

      <div className="field">
        <label>模型名称</label>
        <input type="text" value={plan.name} onChange={(e) => onChange({ ...plan, name: e.target.value })} />
      </div>

      {plan.questions.length > 0 && (
        <div style={{ border: '1px dashed var(--accent)', borderRadius: 'var(--radius-sm)', padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--accent)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Info size={12} />
            助手拿不准这 {plan.questions.length} 项，需要你确认
          </div>
          {plan.questions.map((q) => (
            <div key={q.id} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12.5, marginBottom: 6 }}>{q.prompt}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {q.options.map((o) => (
                  <button
                    key={o.value}
                    className={`btn sm${answers[q.id] === o.value ? ' primary' : ''}`}
                    title={o.hint ?? o.value}
                    style={q.target.startsWith('selectors.') ? mono : undefined}
                    onClick={() => setAnswers({ ...answers, [q.id]: o.value })}
                  >
                    {o.label.length > 46 ? `${o.label.slice(0, 46)}…` : o.label}
                  </button>
                ))}
              </div>
              {isFreeForm(q.target) && (
                <input
                  type="text"
                  value={answers[q.id] ?? ''}
                  placeholder={q.target.startsWith('selectors.') ? '或直接粘贴选择器' : '或直接填写'}
                  style={{ ...mono, marginTop: 6 }}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                />
              )}
            </div>
          ))}
          <button
            className="btn sm"
            disabled={busy || unanswered.length === 0}
            onClick={() => onAnswered(answers)}
          >
            用这些回答更新方案
          </button>
        </div>
      )}

      <div className="field-row">
        <div className="field">
          <label>输入框类型</label>
          <select
            value={plan.input_kind}
            onChange={(e) => onChange({ ...plan, input_kind: e.target.value as WebPlan['input_kind'] })}
          >
            <option value="textarea">原生 textarea / input</option>
            <option value="contenteditable">富文本（Lexical / Slate）</option>
          </select>
        </div>
        <div className="field">
          <label>发送方式</label>
          <select
            value={plan.send_mode}
            onChange={(e) => onChange({ ...plan, send_mode: e.target.value as WebPlan['send_mode'] })}
          >
            <option value="enter">Enter 键</option>
            <option value="click">点击发送按钮</option>
          </select>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label>回复读取</label>
          <select
            value={plan.stream_mode}
            onChange={(e) => onChange({ ...plan, stream_mode: e.target.value as WebPlan['stream_mode'] })}
          >
            <option value="last">最后一条消息</option>
            <option value="all">全部拼接（分段模型）</option>
          </select>
        </div>
        <div className="field">
          <label>完成判定</label>
          <select
            value={plan.completion_mode}
            onChange={(e) => onChange({ ...plan, completion_mode: e.target.value as WebPlan['completion_mode'] })}
          >
            <option value="dom_stable">文本稳定（最鲁棒，推荐）</option>
            <option value="stop_button_hidden">停止按钮消失</option>
            <option value="generating_absent">生成标志消失</option>
          </select>
        </div>
      </div>

      {WEB_ROLES.map((role) => (
        <div className="field" key={role}>
          <label>
            {ROLE_LABEL[role]}
            {role !== 'input' && role !== 'stream' && (
              <span style={{ color: 'var(--text-3)', marginLeft: 6 }}>（可留空）</span>
            )}
            {confidenceTag(plan.confidence[role])}
          </label>
          <input
            type="text"
            value={plan.selectors[role]}
            placeholder="留空表示不使用该角色"
            style={mono}
            onChange={(e) => setSel(role, e.target.value)}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            {checkTag(plan.checks[role]?.level, plan.checks[role]?.matches, plan.checks[role]?.note)}
            {plan.why[role] && (
              <span style={{ fontSize: 10.5, color: 'var(--text-3)' }} title={plan.why[role]}>
                依据：{plan.why[role]}
              </span>
            )}
          </div>
        </div>
      ))}

      {plan.why.overall && (
        <p className="field-hint">总体判断：{plan.why.overall}</p>
      )}
      {plan.risks.length > 0 && (
        <ul style={{ margin: '8px 0', paddingLeft: 18, fontSize: 11.5, color: 'var(--warn)', lineHeight: 1.7 }}>
          {plan.risks.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        <button className="btn sm" disabled={busy} onClick={onVerify} title="把选择器拿回真实页面上数一遍命中数">
          <ShieldCheck size={12} />
          校验选择器
        </button>
        <button
          className="btn sm primary"
          disabled={
            busy ||
            !plan.selectors.input.trim() ||
            !plan.selectors.stream.trim() ||
            plan.checks.input?.level === 'fail' ||
            plan.checks.stream?.level === 'fail'
          }
          title={
            plan.checks.input?.level === 'fail' || plan.checks.stream?.level === 'fail'
              ? '必需的选择器在页面上命中 0，先改正或重新校验'
              : undefined
          }
          onClick={onCreate}
        >
          <Plus size={12} />
          创建模型
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// API 端点嗅探结果
// ---------------------------------------------------------------------------

function ApiProbeCard({
  probe,
  address,
  apiKey,
  assistantId,
  onCreated,
  onError,
}: {
  probe: ApiProbe
  address: string
  /** 嗅探用的 Key。创建时必须由用户重新确认一次：Key 要落进钥匙串，不能悄悄复用 */
  apiKey: string
  assistantId: string
  onCreated: (id: string, name: string) => Promise<void>
  onError: (msg: string) => void
}) {
  const [model, setModel] = useState('')
  const [name, setName] = useState('')
  const [meta, setMeta] = useState<ApiMeta | null>(null)
  const [metaBusy, setMetaBusy] = useState(false)
  const [creating, setCreating] = useState(false)

  if (!probe.ok) {
    return (
      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12 }}>
        <div style={{ fontSize: 12.5, marginBottom: 8 }}>嗅探尝试（GET /models，只读不计费）：</div>
        <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
          <tbody>
            {probe.attempts.map((a, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <td style={{ ...mono, padding: '4px 6px' }}>{a.base}</td>
                <td style={{ padding: '4px 6px' }}>{a.protocol}</td>
                <td style={{ padding: '4px 6px', color: a.ok ? 'var(--consensus)' : 'var(--text-3)' }}>
                  {a.status ?? '—'} {a.ok ? `· ${a.modelCount} 个模型` : a.error ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="field-hint">如果这是网页版站点，把上方「接入方式」改成「网页版」再识别。</p>
      </div>
    )
  }

  const models = probe.models ?? []
  const picked = model || models[0] || ''

  const fillMeta = async () => {
    setMetaBusy(true)
    onError('')
    try {
      const res = await window.torra.smartAddApiMeta({
        assistantModelId: assistantId || undefined,
        host: safeHost(address),
        baseUrl: probe.baseUrl ?? address,
        model: picked,
        protocol: probe.protocol ?? 'openai',
      })
      if (res.ok && res.meta) {
        setMeta(res.meta)
        if (!name) setName(res.meta.displayName)
      } else {
        onError(res.reason ?? '补全失败')
      }
    } finally {
      setMetaBusy(false)
    }
  }

  const create = async () => {
    setCreating(true)
    onError('')
    try {
      const res = await window.torra.createApiModel({
        displayName: (name || picked).trim(),
        baseUrl: probe.baseUrl ?? address,
        apiKey,
        model: picked,
        protocol: probe.protocol ?? 'openai',
        ...(meta
          ? {
              pricePerMTokIn: meta.pricePerMTokIn,
              pricePerMTokOut: meta.pricePerMTokOut,
              maxContextTokens: meta.maxContextTokens,
              supportsStructuredOutput: meta.supportsStructuredOutput,
            }
          : {}),
      })
      if (!res.ok || !res.id) {
        onError(res.errors?.join('；') ?? '创建失败')
        return
      }
      await onCreated(res.id, (name || picked).trim())
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 14, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span className="state-tag" style={{ fontSize: 11 }}>
          {probe.protocol === 'anthropic' ? 'Anthropic 协议' : 'OpenAI 兼容'} · {probe.baseUrl}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{models.length} 个模型</span>
      </div>
      {probe.reason && <p className="field-hint" style={{ marginTop: 0 }}>{probe.reason}</p>}

      <div className="field">
        <label>模型</label>
        <select value={picked} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>显示名</label>
        <input type="text" value={name} placeholder={picked} onChange={(e) => setName(e.target.value)} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 10px' }}>
        <button className="btn sm" disabled={metaBusy || !picked} onClick={() => void fillMeta()}>
          {metaBusy ? <Loader2 size={11} className="spin" /> : <Sparkles size={11} />}
          补全价格与上下文
        </button>
        {meta && (
          <span style={{ fontSize: 11, color: 'var(--text-3)' }} title={meta.note}>
            in ${meta.pricePerMTokIn}/M · out ${meta.pricePerMTokOut}/M · ctx {meta.maxContextTokens} ·{' '}
            {meta.supportsStructuredOutput ? '可当主持' : '不建议当主持'} · 置信 {Math.round(meta.confidence * 100)}%
          </span>
        )}
      </div>
      {meta && (
        <p className="field-hint" style={{ marginTop: 0 }}>
          助手估计值：{meta.note}（不确定处会在费用统计里偏低，不会虚高）
        </p>
      )}

      <div className="modal-actions" style={{ marginTop: 12 }}>
        <button
          className="btn primary"
          disabled={creating || !picked || !apiKey}
          title={apiKey ? '' : '需要先填入 API Key'}
          onClick={() => void create()}
        >
          <Plus size={13} />
          创建模型
        </button>
      </div>
      <p className="field-hint">
        {apiKey
          ? 'Key 直接写入本机钥匙串（操作系统级加密），Torra 不上传、不代管。'
          : '上方填入 API Key 后即可创建 —— 端点已验证，缺的只是这把 Key 的落盘。'}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 创建成功：网页版可选试跑
// ---------------------------------------------------------------------------

function CreatedCard({
  created,
  onClose,
  onRetryWeb,
}: {
  created: { id: string; name: string; transport: 'web' | 'api' }
  onClose: () => void
  onRetryWeb?: () => void
}) {
  const [consent, setConsent] = useState(false)
  const [state, setState] = useState<'idle' | 'sending' | 'ok' | 'fail'>('idle')
  const [text, setText] = useState('')
  const chatId = `smartadd-${created.id}`

  useEffect(() => {
    if (created.transport !== 'web') return
    const offs = [
      window.torra.on('chat:delta', (p) => {
        const e = p as { chatId: string; modelId: string; chunk: string }
        if (e.chatId === chatId && e.modelId === created.id) setText((t) => t + e.chunk)
      }),
      window.torra.on('chat:done', (p) => {
        const e = p as { chatId: string; modelId: string; content: string }
        if (e.chatId === chatId && e.modelId === created.id) {
          setState('ok')
          if (e.content) setText(e.content)
        }
      }),
      window.torra.on('chat:error', (p) => {
        const e = p as { chatId: string; modelId: string; reason: string }
        if (e.chatId === chatId && e.modelId === created.id) {
          setState('fail')
          setText(e.reason ?? '失败')
        }
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [chatId, created.id, created.transport])

  const trial = async () => {
    setState('sending')
    setText('')
    const res = await window.torra.chatSend({
      chatId,
      message: '请用不超过 10 个字回复：收到',
      items: [{ modelId: created.id, history: [] }],
    })
    if (!res.ok) {
      setState('fail')
      setText(res.reason ?? '发送失败')
      return
    }
    if (res.rejected?.some((r) => r.modelId === created.id)) {
      setState('fail')
      setText(res.rejected.find((r) => r.modelId === created.id)!.reason)
    }
  }

  return (
    <div
      className="banner"
      style={{
        display: 'block',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border)',
        marginTop: 12,
        padding: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <CheckCircle size={16} style={{ color: 'var(--consensus)' }} />
        <strong style={{ fontSize: 14 }}>已添加「{created.name}」</strong>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 10px' }}>
        {created.transport === 'web'
          ? '适配器与模型条目已写入本机 userData，重启后保留。'
          : '配置已保存。在「模型与密钥」里填入 API Key 后即可使用。'}
      </p>

      {created.transport === 'web' && (
        <>
          <p style={{ fontSize: 12, color: 'var(--warn)', margin: '0 0 10px' }}>
            下一步：关闭本窗口，点击左栏该模型头像打开页面并完成登录。登录态不会从扫描窗口带过去。
          </p>
          <label className="check-item" style={{ marginBottom: 8 }} onClick={() => setConsent(!consent)}>
            <span className="check-dot" style={{ background: consent ? 'var(--accent)' : 'var(--border-strong)' }} />
            <span style={{ fontSize: 12 }}>试跑一轮：用你的账号向该站点真实发送一条测试消息（会产生一条真实对话）</span>
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn sm" disabled={!consent || state === 'sending'} onClick={() => void trial()}>
              {state === 'sending' ? <Loader2 size={11} className="spin" /> : <Send size={11} />}
              {state === 'sending' ? '等待回复…' : '试跑'}
            </button>
            {state === 'ok' && (
              <span style={{ fontSize: 11.5, color: 'var(--consensus)' }}>
                <CheckCircle size={10} style={{ verticalAlign: -1 }} /> 链路通了
              </span>
            )}
            {state === 'fail' && (
              <span style={{ fontSize: 11.5, color: 'var(--danger)' }}>
                <AlertTriangle size={10} style={{ verticalAlign: -1 }} /> 未通过，见下方原因
              </span>
            )}
          </div>
          {text && (
            <div style={{ ...mono, marginTop: 8, padding: 8, background: 'var(--bg-hover)', borderRadius: 'var(--radius-xs)', maxHeight: 120, overflowY: 'auto' }}>
              {text}
            </div>
          )}
          {state === 'fail' && onRetryWeb && (
            <p className="field-hint">
              多半是未登录或选择器取错元素。可回到方案卡片改正后重建，或在设置页对该模型跑一次链路体检。
            </p>
          )}
        </>
      )}

      <div className="modal-actions">
        <button className="btn primary" onClick={onClose}>
          知道了
        </button>
      </div>
    </div>
  )
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).host
  } catch {
    return raw
  }
}

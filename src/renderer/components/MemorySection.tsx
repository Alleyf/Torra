/**
 * 性能面板：网页实例的内存实况与手动释放
 *
 * 与「备份」那套同一分工：数字全部以主进程为准（只有主进程读得到每枚渲染进程的
 * 真实工作集），这里只负责画出来、把「释放」这个动作交上去。
 * 界面不自己算「占了多少」—— 那正是「枚数 × 250MB」估值当初说不清 1.5GB 的同一个坑。
 *
 * 释放只是把渲染进程还给系统；登录态在 session 分区里，与实例生命周期无关，
 * 下次用到时自动重建（代价是那一路首字晚几秒）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle, Gauge, Info, Loader, RefreshCw, Trash2 } from 'lucide-react'
import type { ModelSummary } from '../store'

interface MemModel {
  modelId: string
  mb: number | null
}

/** 页面自己刷新的节拍：主进程每 60 秒才扫一次，5 秒足够让用户看到自己的操作结果 */
const POLL_MS = 5000

function mbText(mb: number | null): string {
  return mb === null ? '量不到' : `${mb} MB`
}

export function MemorySection() {
  const [total, setTotal] = useState(0)
  const [count, setCount] = useState(0)
  const [measured, setMeasured] = useState(false)
  const [models, setModels] = useState<MemModel[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const r = await window.torra.webviewMemory()
      if (!alive.current) return
      setTotal(r.estimatedMb)
      setCount(r.count)
      setMeasured(r.measured ?? false)
      setModels(r.models ?? [])
    } catch {
      /* 主进程未就绪时静默重试，下一次轮询会补上 */
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [refresh])

  // 实例只有 modelId，界面要显示模型名才有意义（隐藏的模型不在 listModels 里，退回 id）
  useEffect(() => {
    void window.torra
      .listModels()
      .then((list: ModelSummary[]) => {
        const map: Record<string, string> = {}
        for (const m of list) map[m.id] = m.displayName
        setNames(map)
      })
      .catch(() => {})
  }, [])

  const releaseOne = async (modelId: string) => {
    setMsg(null)
    setBusy(modelId)
    try {
      const r = await window.torra.releaseWebview(modelId)
      setMsg(
        r.ok
          ? { tone: 'ok', text: `已释放 ${names[modelId] ?? modelId} 的实例，内存已还给系统。` }
          : {
              tone: 'warn',
              text: `${names[modelId] ?? modelId} 正在使用中（被查看或正在生成），没有释放。`,
            },
      )
      await refresh()
    } catch {
      setMsg({ tone: 'warn', text: '释放没走通，可能是应用正在重启，稍后再试。' })
    } finally {
      setBusy(null)
    }
  }

  const releaseAll = async () => {
    setMsg(null)
    setBusy('*')
    try {
      const r = await window.torra.releaseIdleWebviews()
      setMsg(
        r.released.length > 0
          ? { tone: 'ok', text: `已释放 ${r.released.length} 枚后台实例，内存已还给系统。` }
          : { tone: 'warn', text: '没有可释放的后台实例（正在查看或正在生成的不会释放）。' },
      )
      await refresh()
    } catch {
      setMsg({ tone: 'warn', text: '释放没走通，可能是应用正在重启，稍后再试。' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="st-section">
      <h3 className="st-sec-title">
        <Gauge size={14} />
        网页实例内存
      </h3>
      <p className="st-desc">
        每个网页模型都是一个<strong>独立的 Chromium 渲染进程</strong>（实测单枚 120~500MB），
        Torra 占用的内存主要就来自它们。Torra 会按下面的规矩把它们控制住：
        同时最多保留 3 枚后台实例、一场讨论散场后立刻回收、空闲 10 分钟回收，
        以及系统内存吃紧时释放全部后台实例。
        <strong>回收的只是渲染进程，登录态存在分区里，不会掉登录</strong>，下次用到自动启动。
      </p>

      <div className="mem-total">
        <div className="mem-total-num">{total} MB</div>
        <div className="mem-total-sub">
          <span>{count} 枚常驻实例</span>
          <span>{measured ? '全部为实测占用' : '含量不到时的保守估值'}</span>
        </div>
      </div>

      {count === 0 ? (
        <p className="st-note">
          <Info size={12} />
          当前没有常驻的网页实例，内存都还给了系统。点开某个网页模型或开始一场讨论时才会重建。
        </p>
      ) : (
        <div className="st-list">
          {models.map((m) => (
            <div className="st-row" key={m.modelId}>
              <div className="st-grow">
                <div className="st-name">{names[m.modelId] ?? m.modelId}</div>
                <div className="st-meta">
                  <span>{mbText(m.mb)}</span>
                </div>
              </div>
              <button
                className="st-btn"
                disabled={busy !== null}
                title="把这个模型的渲染进程还给系统（登录态不受影响，下次用到自动重建）"
                onClick={() => void releaseOne(m.modelId)}
              >
                {busy === m.modelId ? <RefreshCw size={11} className="spin" /> : <Trash2 size={11} />}
                释放
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="st-btns">
        <button className="st-btn" disabled={busy !== null} onClick={() => void refresh()}>
          <RefreshCw size={11} />
          刷新
        </button>
        <button className="st-btn primary" disabled={busy !== null || count === 0} onClick={() => void releaseAll()}>
          {busy === '*' ? <Loader size={11} className="spin" /> : <Trash2 size={11} />}
          释放全部后台实例
        </button>
      </div>

      {msg && (
        <p className={`st-note ${msg.tone}`}>
          {msg.tone === 'ok' ? <CheckCircle size={12} /> : <Info size={12} />}
          {msg.text}
        </p>
      )}
    </section>
  )
}

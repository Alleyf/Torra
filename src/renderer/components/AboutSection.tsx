/**
 * 「关于」这一格：版本与更新、数据落在哪。
 *
 * 只画用户用得上的事实：运行时版本号、本机绝对路径、依赖与许可证清单这些
 * 属于排查现场，归「诊断」那一格 —— 这里露出去只会让人不知道该看哪一句。
 *
 * 更新的状态机在主进程（shared/update 那份 reducer），这里只画收到的那一格，
 * 一个判断都不自己下 —— 界面猜出来的「已是最新」比不显示更糟。
 *
 * 挂载时先取一次快照再接推送：事件流不会因为这一格没挂着就重放，
 * 只订阅的话「下载完 → 切走 → 切回来」会把「待安装」这个事实丢掉。
 */

import { useCallback, useEffect, useState } from 'react'
import { explainUpdateError, formatBytes, type AboutInfo, type UpdateState } from '@shared/update'
import {
  AlertTriangle,
  CheckCircle,
  Download,
  ExternalLink,
  FolderOpen,
  Info,
  RefreshCw,
  Rocket,
} from 'lucide-react'

const PHASE_WORD: Record<UpdateState['phase'], { word: string; tone: '' | 'ok' | 'warn' | 'accent' }> = {
  idle: { word: '未检查', tone: '' },
  checking: { word: '检查中', tone: 'accent' },
  available: { word: '发现新版本', tone: 'accent' },
  downloading: { word: '下载中', tone: 'accent' },
  ready: { word: '待安装', tone: 'ok' },
  latest: { word: '已是最新', tone: 'ok' },
  error: { word: '更新失败', tone: 'warn' },
}

/** 能重新发起检查的阶段。下载中和待安装时不给，免得把已经到手的包冲掉 */
const CHECKABLE: UpdateState['phase'][] = ['idle', 'latest', 'error', 'available']

export function AboutSection() {
  const [st, setSt] = useState<UpdateState | null>(null)
  const [about, setAbout] = useState<AboutInfo | null>(null)
  const [busy, setBusy] = useState<'check' | 'install' | null>(null)
  // IPC 本身挂了（没有 handler、preload 没跟上）时主进程不会再推任何状态，
  // 这一句是那种情况下唯一的可见反馈 —— 给用户的是下一步做什么，不是异常原文
  const [ipcError, setIpcError] = useState<string | null>(null)

  /** 原文只进控制台：把 `Error invoking remote method 'about:info'` 画到界面上，用户只能复制粘贴 */
  const failSoft = useCallback((e: unknown, sentence: string) => {
    console.warn('[about] 本机信息读取失败', e)
    setIpcError(sentence)
  }, [])

  useEffect(() => {
    let alive = true
    void window.torra
      .getUpdateState()
      .then((s) => alive && setSt(s))
      .catch((e) => alive && failSoft(e, '没能读到更新状态，稍后再试。'))
    void window.torra
      .getAboutInfo()
      .then((a) => alive && setAbout(a))
      .catch((e) => alive && failSoft(e, '没能读到本机版本信息，稍后再试。'))
    const off = window.torra.on('update:state', (p) => setSt(p as UpdateState))
    return () => {
      alive = false
      off()
    }
  }, [failSoft])

  /**
   * 检查与下载共用一条动作通道，但只有检查需要 busy 闸门。
   *
   * 下载那个 promise 要到包下完才 resolve，拿它当闸门就等于把「重启并安装」
   * 锁到永远 —— 下载中的可见反馈本来就是那一格阶段加进度条，不缺这一个按钮态。
   */
  const run = useCallback(async (kind: 'check' | 'download') => {
    setIpcError(null)
    if (kind === 'download') {
      void window.torra.downloadUpdate().catch((e) => failSoft(e, '这次下载没发起，重新点一下「下载」。'))
      return
    }
    setBusy('check')
    try {
      const start = Date.now()
      await window.torra.checkUpdate()
      // 检查常常几百毫秒就回来，不闪一下用户会以为按钮没点上
      const left = 700 - (Date.now() - start)
      if (left > 0) await new Promise((r) => setTimeout(r, left))
    } catch (e) {
      failSoft(e, '这次检查没走通，可以再试一次。')
    } finally {
      setBusy(null)
    }
  }, [failSoft])

  const install = useCallback(async () => {
    setIpcError(null)
    setBusy('install')
    const res = await window.torra.installUpdate().catch((e) => {
      console.warn('[about] 重启安装调用失败', e)
      return { ok: false, reason: '' }
    })
    // 装成了进程就退了，代码走不到这里；能走到说明没退成，把按钮还回去
    if (!res.ok) {
      // 理由出自唯一那份翻译：认得出的说下一步，认不出的照登，绝不编一个
      setIpcError(explainUpdateError(res.reason ?? '', 'download'))
      setBusy(null)
    }
  }, [])

  /**
   * 安装那条 promise 拿不到结论：quitAndInstall 是同步的 void，装不成只会发 'error'
   * 事件，主进程要把这个事实翻译成 return 里的 ok:false 才算说清。所以这里再兜一层 ——
   * 阶段离开了「待安装」就说明这一轮已经有了结论（要么在退出，要么失败），
   * busy 必须还回去，否则「检查更新」会被永久禁用，用户看到的是整页点不动。
   */
  useEffect(() => {
    if (busy === 'install' && st && st.phase !== 'ready') setBusy(null)
  }, [busy, st])

  const phase = st?.phase ?? 'idle'
  const checking = phase === 'checking' || busy === 'check'
  const percent = st?.percent ?? 0
  const canCheck = !!st?.canAutoUpdate && CHECKABLE.includes(phase) && busy === null
  const word = PHASE_WORD[phase]
  const edition = about?.packaged ? (about.portable ? '便携版' : '安装版') : null

  return (
    <>
      <section className="st-section">
        <div className="st-sec-head">
          <h3 className="st-sec-title">
            <Info size={13} />
            版本与更新
          </h3>
          <div className="st-sec-actions">
            <button
              className="st-icon"
              onClick={() => void window.torra.openReleasePage()}
              title="在浏览器里打开 GitHub Releases"
              aria-label="打开发布页"
            >
              <ExternalLink size={13} />
            </button>
          </div>
        </div>

        <div className="st-list">
          <div className="st-row">
            <div className="st-grow">
              <div className="st-name">Torra</div>
              <div className="st-meta">
                <code>v{st?.current ?? about?.version ?? '?'}</code>
                {st?.latest && <code className="st-accent">→ v{st.latest}</code>}
                <span className={word.tone}>{word.word}</span>
                {edition && <span>{edition}</span>}
                {st?.checkedAt && <span>检查于 {clockOf(st.checkedAt)}</span>}
              </div>
            </div>
            <div className="st-actions">
              <button className="st-btn" onClick={() => void run('check')} disabled={!canCheck} title={st?.blockedReason ?? undefined}>
                <RefreshCw size={12} className={checking ? 'spin' : ''} />
                {checking ? '检查中…' : '检查更新'}
              </button>
              {phase === 'available' && (
                <button className="st-btn primary" onClick={() => void run('download')}>
                  <Download size={12} />
                  下载 v{st?.latest}
                </button>
              )}
              {phase === 'ready' && (
                <button className="st-btn primary" onClick={() => void install()} disabled={busy !== null}>
                  <Rocket size={12} />
                  {busy === 'install' ? '正在退出…' : '重启并安装'}
                </button>
              )}
            </div>
          </div>
        </div>

        {(phase === 'downloading' || phase === 'ready') && (
          <div className="st-meter-wrap">
            <div
              className="st-meter"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label="升级包下载进度"
            >
              <div className="st-meter-fill" style={{ width: `${percent}%` }} />
            </div>
            <span className="st-meter-num">
              {percent}%{sizeText(st?.transferred ?? null, st?.total ?? null)}
            </span>
          </div>
        )}

        <p className={`st-note${phase === 'error' || ipcError ? ' warn' : phase === 'ready' ? ' ok' : ''}`}>
          {phase === 'error' || ipcError ? <AlertTriangle size={12} /> : phase === 'ready' ? <CheckCircle size={12} /> : null}
          {ipcError ?? st?.note ?? '正在读取本机版本信息…'}
        </p>

        <p className="st-desc">
          升级只做三件事：查发布记录、下载安装包、重启时装上。发现新版本不会自己开始下载（升级包几十
          MB，走的是你的流量），装之前也不会自己关应用。
        </p>
        <p className="st-desc">
          安装包没有做发布者认证，所以更新只核对文件是否完整，核对不了「这个包是谁做的」。
          另外，只有发布时带了更新信息的版本才能在应用内查到；如果这里一直查不到，先去发布页手动装一次新版，
          之后就能自动检查了。
        </p>
      </section>

      <section className="st-section">
        <h3 className="st-sec-title">
          <FolderOpen size={13} />
          数据位置
        </h3>
        <div className="st-list">
          <div className="st-row">
            <div className="st-grow">
              <div className="st-name">本机数据目录</div>
              <div className="st-meta">
                <span>会话记录、导出的报告、偏好与登录态都在这里</span>
              </div>
            </div>
            <div className="st-actions">
              <button
                className="st-icon"
                onClick={() => void window.torra.openDataDir()}
                disabled={!about?.dataDir}
                title="在文件管理器里打开"
                aria-label="打开数据目录"
              >
                <FolderOpen size={13} />
              </button>
            </div>
          </div>
        </div>
        <p className="st-desc">
          想看具体位置：点上面的按钮，文件管理器会直接打开那个文件夹。卸载安装版不会清掉这些内容，
          换机器时把这个目录整个拷过去即可。登录凭据不以明文存在这里。
        </p>
      </section>
    </>
  )
}

function clockOf(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 已知一端就不报半句：只有 transferred 没有 total 的进度条数字没有意义 */
function sizeText(transferred: number | null, total: number | null): string {
  const a = formatBytes(transferred)
  const b = formatBytes(total)
  if (!a || !b) return ''
  return ` · ${a} / ${b}`
}

/**
 * 数据备份与同步（GitHub 仓库）
 *
 * 与「关于」页同一套分工：状态和动作都在主进程（backup/service.ts），
 * 这里只做两件事 —— 把用户填的东西原样交上去、把主进程推回来的那一格画出来。
 * 界面不许自己推断「算不算备份成功」：令牌有没有、远端那份是谁推的，
 * 全部以主进程为准（和更新那套同一条规矩）。
 *
 * 收纳范围只说到「会话存档 / 报告 / 适配器 / 偏好 / 模型清单」这一层，
 * 不逐条列文件名：清单在 shared/backup.ts 是唯一口径，写死在界面上
 * 早晚会和那份清单对不上，到时候用户按界面的说法去找文件会找不到。
 */

import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle,
  CloudUpload,
  Clock,
  ExternalLink,
  FolderOpen,
  HardDriveDownload,
  Info,
  Loader,
  RefreshCw,
} from 'lucide-react'
import {
  BUNDLE_FILE,
  AUTO_BACKUP_INTERVALS,
  defaultBackupRepoName,
  type BackupState,
  type BackupSyncResult,
  type BackupTestResult,
} from '@shared/backup'

type Action = 'save' | 'test' | 'push' | 'pull'

const ACTION_WORD: Record<Action, string> = {
  save: '保存',
  test: '测试连接',
  push: '立即备份',
  pull: '从远端恢复',
}

/** 频率的中文说法。「24 小时」没人这么说，直接写「每天」 */
const INTERVAL_WORD: Record<number, string> = { 1: '每小时', 6: '每 6 小时', 24: '每天' }
/**
 * 结果贴在哪一排按钮底下。
 *
 * 四个动作原本共用一条反馈、只能挂在整页末尾，而页尾离按钮整整一屏 ——
 * 点完「保存」看到的就是「没反应」。所以反馈必须跟着触发它的那排按钮走：
 * 配置类（保存 / 测试连接）贴第一排，同步类（备份 / 恢复 / 打开仓库）贴第二排。
 */
type Slot = 'config' | 'sync' | 'auto'

const ACTION_SLOT: Record<Action, Slot> = { save: 'config', test: 'config', push: 'sync', pull: 'sync' }

/**
 * 动作结果，紧贴那排按钮渲染，并在冒出来时把自己滚进视野。
 *
 * 只放在按钮下面还不够：这排按钮本身就常在视口下沿，结果行会差几十像素露不出来。
 * block: 'nearest' 只在需要时滚动最小距离，已经看得见时一动不动。
 */
function FeedbackNote({
  msg,
  ipcError,
}: {
  msg: { tone: 'ok' | 'err'; text: string } | null
  ipcError: string | null
}) {
  const ref = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (!msg && !ipcError) return
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [msg, ipcError])

  if (msg) {
    return (
      <p ref={ref} className={`st-note ${msg.tone}`}>
        {msg.tone === 'ok' ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
        {msg.text}
      </p>
    )
  }
  if (!ipcError) return null
  return (
    <p ref={ref} className="st-note warn">
      <Info size={12} />
      {ipcError}
    </p>
  )
}

/** 时间戳一律按本机时区显示成年-月-日 时:分，够用且不会被数字位宽搞乱 */
function when(ts: number | null | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '还没有'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function size(bytes: number): string {
  if (!bytes) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 动作结果翻成一句人话。
 *
 * 失败一律原样带出主进程写好的原因 —— 那里已经区分了「没填仓库」「没填令牌」
 * 「令牌过期」「没写权限」，在界面上重写一遍只会两边说法不一致。
 */
function describe(
  kind: Action,
  r: BackupSyncResult | BackupTestResult | { ok: boolean; reason?: string },
): { tone: 'ok' | 'err'; text: string } {
  if (!r.ok) return { tone: 'err', text: r.reason ?? `${ACTION_WORD[kind]}失败` }
  if (kind === 'save') {
    return { tone: 'ok', text: '已保存。令牌只写进系统钥匙串，之后这里只显示「已保存」。' }
  }
  if (kind === 'test') {
    const t = r as BackupTestResult
    if (t.created) return { tone: 'ok', text: `已建好私有仓库 ${t.repo}，下一步点「立即备份」。` }
    if (t.hasBundle) {
      return { tone: 'ok', text: `连接成功（${t.login}），远端已有备份包，最近一次 ${when(t.remoteAt ?? null)}。` }
    }
    return { tone: 'ok', text: `连接成功（${t.login}），远端还没有备份包，点「立即备份」推一份上去。` }
  }
  const s = r as BackupSyncResult
  // 被剔掉的密钥字段要单独说一句：它意味着某处曾经把密钥写进普通文件了
  const scrub = s.scrubbed > 0 ? `（另有 ${s.scrubbed} 处疑似密钥字段已剔除）` : ''
  if (kind === 'push') {
    return {
      tone: 'ok',
      text: `已备份 ${s.sessions} 场、${size(s.bytes)}：本机上传/更新 ${s.pushed} 份，远端较新的 ${s.pulled} 份沿用远端，两边一致 ${s.same} 份${scrub}。`,
    }
  }
  return {
    tone: 'ok',
    text: `已恢复：落盘 ${s.added + s.pulled} 份（其中 ${s.pulled} 份是远端覆盖本机），本机较新的 ${s.pushed} 份保留，一致 ${s.same} 份${scrub}。`,
  }
}

/**
 * 主进程只认已经落盘的配置。
 *
 * 输入框里刚改、还没点「保存」时，测试连接 / 备份会回一句「先在设置里填一个备份仓库」——
 * 对着一个填满的输入框读这句话，最自然的理解就是「按钮坏了」。
 * 所以只在这种情况下补一句：它等的是「保存」那一步，不是你手上的输入。
 */
function withSaveHint(
  r: { ok: boolean; reason?: string },
  unsaved: boolean,
): { ok: boolean; reason?: string } {
  if (r.ok || !unsaved) return r
  return { ...r, reason: `${r.reason ?? '这一步没走通'}（上面输入框里的改动要先点「保存」才会生效）` }
}

export function BackupSection() {
  const [st, setSt] = useState<BackupState | null>(null)
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [path, setPath] = useState('')
  const [token, setToken] = useState('')
  const [createIfMissing, setCreateIfMissing] = useState(true)
  // 结果带上它属于哪一排按钮：只有贴着那排渲染，点完才立刻看得见
  const [msg, setMsg] = useState<{ slot: Slot; tone: 'ok' | 'err'; text: string } | null>(null)
  /**
   * 点了按钮到主进程第一次推送状态之间还有一小段空窗，这段时间按钮得自己锁住 ——
   * busy 是主进程的口径，它还没开始跑的时候只能是这里说了算。
   */
  const [pending, setPending] = useState<Action | null>(null)
  // IPC 没接上时（handler 缺失 / preload 没挂）主进程不会推任何状态，界面会一直空着
  const [ipcError, setIpcError] = useState<{ slot: Slot; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    void window.torra
      .backupState()
      .then((s) => {
        if (!alive || !s) return
        setSt(s)
        setRepo(s.target)
        setBranch(s.branch)
        setPath(s.path)
      })
      .catch(() => alive && setIpcError({ slot: 'config', text: '没读到备份状态，重启一下应用再试。' }))
    return () => {
      alive = false
    }
  }, [])

  // 推送来的状态只覆盖「那一格」，不动输入框：用户可能正在改仓库名，
  // 被一次推送把他手上的输入吃掉，比状态晚一两秒更要命
  useEffect(() => window.torra.on('backup:state', (p) => setSt(p as BackupState)), [])

  const busy = st?.busy ?? null
  const working = pending ?? busy
  // 输入框里改过、还没落盘的仓库：主进程用的是存下来的那一份，两者不一致才叫「没保存」
  const unsaved = repo.trim() !== (st?.target ?? '')

  const run = async (kind: Action) => {
    const slot = ACTION_SLOT[kind]
    setMsg(null)
    setIpcError(null)
    setPending(kind)
    try {
      if (kind === 'save') {
        // 令牌框留空 = 「不改动现有令牌」，所以要把字段整个省掉。
        // 照直把空串传下去，主进程读成「清掉令牌」：用户只想保存仓库名，
        // 结果点一次「保存」就把刚存进去的令牌删了，之后怎么测都是「没有令牌」。
        // 删除令牌有它自己的按钮（清除令牌），那一条才是显式传空串。
        const r = await window.torra.backupSave({ repo, branch, path, token: token.trim() || undefined })
        // 存下来了才清空令牌框；失败时留着让用户能改一个字再来，不用重新粘一遍
        if (r.ok) setToken('')
        setMsg({ slot, ...describe(kind, r) })
        return
      }
      if (kind === 'test') {
        const r = await window.torra.backupTest(createIfMissing)
        setMsg({ slot, ...describe(kind, withSaveHint(r, unsaved)) })
        return
      }
      if (kind === 'push') {
        const r = await window.torra.backupPush()
        setMsg({ slot, ...describe(kind, withSaveHint(r, unsaved)) })
        return
      }
      const r = await window.torra.backupPull()
      setMsg({ slot, ...describe(kind, withSaveHint(r, unsaved)) })
    } catch (e) {
      console.warn('[backup] 备份动作没走通', e)
      setIpcError({ slot, text: '这一步没走通，可能是应用正在重启，稍后再试。' })
    } finally {
      setPending(null)
    }
  }

  const openRepo = () => {
    void window.torra.backupOpenRepo().then((r) => {
      if (!r.ok) setMsg({ slot: 'sync', tone: 'err', text: r.reason ?? '没能打开仓库' })
    })
  }

  /**
   * 改自动备份配置。成功不弹「已保存」—— 开关和分段本身就是回执，
   * 新值由主进程随 backup:state 推回来；只有没走通才要说一句。
   */
  const setAuto = (patch: { enabled?: boolean; intervalHours?: number; pullToo?: boolean }) => {
    setMsg(null)
    setIpcError(null)
    void window.torra
      .backupSetAutoConfig(patch)
      .then((r) => {
        if (!r.ok) setMsg({ slot: 'auto', tone: 'err', text: r.reason ?? '这一步没保存成' })
      })
      .catch(() => setIpcError({ slot: 'auto', text: '这一步没走通，可能是应用正在重启，稍后再试。' }))
  }

  const running = (kind: Action) => working === kind

  /** 取属于这一排的那条反馈；另一排的那条不在这里重复出现 */
  const note = (slot: Slot) => (
    <FeedbackNote
      msg={msg && msg.slot === slot ? msg : null}
      ipcError={ipcError && ipcError.slot === slot ? ipcError.text : null}
    />
  )

  return (
    <>
      <section className="st-section">
        <h3 className="st-sec-title">
          <CloudUpload size={14} />
          备份仓库
        </h3>
        <p className="st-desc">
          备份是<strong>把本机数据整包写进你自己的一个 GitHub 仓库</strong>（一个 JSON 文件，走仓库的提交记录留痕）。
          Torra 不代管、不中转，令牌只从本机直连 GitHub。
          要读写权限的细粒度令牌即可（Contents 读写 + 首次建仓时的 Administration 或 <code>repo</code> 范围）。
        </p>

        <div className="st-row">
          <div className="st-grow">
            <div className="st-name">仓库</div>
            <div className="st-meta">
              <span>写 <code>owner/repo</code>，或直接粘仓库地址；只认 github.com</span>
            </div>
          </div>
          <input
            className="st-input st-long"
            value={repo}
            spellCheck={false}
            placeholder={`例如 你的用户名/${defaultBackupRepoName()}`}
            onChange={(e) => setRepo(e.target.value)}
          />
        </div>

        <div className="st-row">
          <div className="st-grow">
            <div className="st-name">分支</div>
            <div className="st-meta">备份包写在这个分支里</div>
          </div>
          <input
            className="st-input st-long"
            value={branch}
            spellCheck={false}
            placeholder="main"
            onChange={(e) => setBranch(e.target.value)}
          />
        </div>

        <div className="st-row">
          <div className="st-grow">
            <div className="st-name">存放路径</div>
            <div className="st-meta">
              <span>
                仓库里的相对路径。填目录（<code>backups/</code>）就用默认文件名 <code>{BUNDLE_FILE}</code>，
                也可以写完整文件名（<code>notes/site-b.json</code>）
              </span>
            </div>
          </div>
          <input
            className="st-input st-long"
            value={path}
            spellCheck={false}
            placeholder={`${BUNDLE_FILE}（仓库根）`}
            onChange={(e) => setPath(e.target.value)}
          />
        </div>

        <div className="st-row">
          <div className="st-grow">
            <div className="st-name">访问令牌</div>
            <div className="st-meta">
              {st?.hasToken ? (
                <span className="ok">
                  <CheckCircle size={11} />
                  已保存，留空表示不改动
                </span>
              ) : (
                <span className="warn">
                  <AlertTriangle size={11} />
                  还没填，没有令牌不能备份
                </span>
              )}
              <span>粘贴后点「保存」才写进系统钥匙串</span>
            </div>
          </div>
          <input
            className="st-input st-long"
            type="password"
            value={token}
            spellCheck={false}
            autoComplete="off"
            placeholder={st?.hasToken ? '留空不改动' : 'github_pat_...'}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>

        <div className="st-row">
          <div className="st-grow">
            <div className="st-name">不存在就建一个私有仓库</div>
            <div className="st-meta">只在仓库名归属你自己（owner 就是登录账号）时会建，默认私有</div>
          </div>
          <button
            className={`st-switch${createIfMissing ? ' on' : ''}`}
            role="switch"
            aria-checked={createIfMissing}
            aria-label="仓库不存在时自动创建私有仓库"
            onClick={() => setCreateIfMissing((v) => !v)}
          />
        </div>

        <div className="st-btns">
          <button className="st-btn primary" disabled={working !== null} onClick={() => void run('save')}>
            {running('save') ? <RefreshCw size={11} className="spin" /> : <CheckCircle size={11} />}
            保存
          </button>
          <button className="st-btn" disabled={working !== null} onClick={() => void run('test')}>
            {running('test') ? <RefreshCw size={11} className="spin" /> : <CloudUpload size={11} />}
            测试连接
          </button>
          {st?.hasToken && (
            <button
              className="st-btn"
              title="清除本机保存的令牌（远端仓库本身不受影响）"
              disabled={working !== null}
              onClick={() => void window.torra.backupSave({ token: '' }).then((r) => {
                setMsg({
                  slot: 'config',
                  tone: r.ok ? 'ok' : 'err',
                  text: r.ok ? '令牌已清除。' : r.reason ?? '清除失败',
                })
              })}
            >
              清除令牌
            </button>
          )}
        </div>

        {note('config')}
      </section>

      <section className="st-section">
        <h3 className="st-sec-title">
          <HardDriveDownload size={14} />
          备份与恢复
        </h3>
        <p className="st-desc">
          两边都改过同一场会话时，<strong>各文件取修改时间较新的那一份</strong>，不是整包覆盖 ——
          另一台机器上刚跑的那几场不会因为这边点了一次备份就没了。
        </p>

        <div className="st-row">
          <div className="st-grow">
            <div className="st-name">上次备份</div>
            <div className="st-meta">
              {when(st?.lastPushAt)}
              {st?.remoteAt ? <span>，远端那份生成于 {when(st.remoteAt)}</span> : null}
              {st?.remoteDevice ? <span>（来自 {st.remoteDevice}）</span> : null}
            </div>
          </div>
        </div>

        <div className="st-row">
          <div className="st-grow">
            <div className="st-name">上次恢复</div>
            <div className="st-meta">{when(st?.lastPullAt)}</div>
          </div>
        </div>

        {st?.lastNote && st.lastOk !== null && (
          <p className={`st-note ${st.lastOk ? 'ok' : 'warn'}`}>
            {st.lastOk ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
            {st.lastNote}
          </p>
        )}

        <div className="st-btns">
          <button className="st-btn primary" disabled={working !== null} onClick={() => void run('push')}>
            {running('push') ? <RefreshCw size={11} className="spin" /> : <CloudUpload size={11} />}
            立即备份
          </button>
          <button className="st-btn" disabled={working !== null} onClick={() => void run('pull')}>
            {running('pull') ? <RefreshCw size={11} className="spin" /> : <FolderOpen size={11} />}
            从远端恢复
          </button>
          <button
            className="st-btn"
            title={st?.configured ? '在浏览器里打开这个仓库' : '先保存仓库和令牌，才有仓库可打开'}
            disabled={working !== null || !st?.configured}
            onClick={openRepo}
          >
            <ExternalLink size={11} />
            打开仓库
          </button>
          {working === 'push' || working === 'pull' ? (
            <span className="st-inline-msg">
              <Loader size={11} />
              {ACTION_WORD[working]}中…
            </span>
          ) : null}
        </div>

        {note('sync')}

        <p className="st-desc">
          <strong>收纳范围</strong>：各场会话存档与报告、适配器配置、偏好、模型清单（含它们的密钥引用名）。
          <strong>不含</strong>：API Key 本体（只在系统钥匙串）、会话里的图片二进制、导出文件、日志。
          推送前还会再扫一遍，发现疑似密钥字段一律剔除并中止。
        </p>
      </section>

      <section className="st-section">
        <h3 className="st-sec-title">
          <Clock size={14} />
          定时自动备份
        </h3>
        <p className="st-desc">
          开了之后，应用<strong>在后台自己按点推一次</strong>，不用记着手动点。
          只在没有讨论在跑、也没有别的备份动作在进行时才动手；
          跑失败不打扰你，原因写进上面的「上次备份」那几行与日志里，下一拍再试。
        </p>

        <div className="st-row">
          <div className="st-grow">
            <div className="st-name">自动备份</div>
            <div className="st-meta">
              {st?.auto?.enabled ? (
                <span className="ok">
                  <CheckCircle size={11} />
                  已开启，{INTERVAL_WORD[st.auto.intervalHours] ?? `每 ${st.auto.intervalHours} 小时`}一次
                </span>
              ) : (
                <span>已关闭（只有手动点「立即备份」才会推）</span>
              )}
              {!st?.configured && <span className="warn"> 需要先保存仓库与令牌</span>}
            </div>
          </div>
          <button
            className={`st-switch${st?.auto?.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={!!st?.auto?.enabled}
            aria-label="定时自动备份"
            onClick={() => setAuto({ enabled: !st?.auto?.enabled })}
          />
        </div>

        {st?.auto?.enabled && (
          <>
            <div className="st-row">
              <div className="st-grow">
                <div className="st-name">多久一次</div>
                <div className="st-meta">
                  <span>从上一次同步（备份或恢复）算起；刚手动备份过，会自动往后顺延</span>
                </div>
              </div>
              <div className="st-seg" role="group" aria-label="自动备份频率">
                {AUTO_BACKUP_INTERVALS.map((h) => (
                  <button
                    key={h}
                    className={`st-seg-item${st.auto.intervalHours === h ? ' on' : ''}`}
                    aria-pressed={st.auto.intervalHours === h}
                    onClick={() => setAuto({ intervalHours: h })}
                  >
                    {INTERVAL_WORD[h] ?? `每 ${h} 小时`}
                  </button>
                ))}
              </div>
            </div>

            <div className="st-row">
              <div className="st-grow">
                <div className="st-name">顺带从远端拉一次</div>
                <div className="st-meta">
                  <span>
                    开了就是双向同步：另一台机器的新场次会自动进来。默认关 ——
                    定时任务悄悄覆盖本机文件的风险，比「晚一点到手」大
                  </span>
                </div>
              </div>
              <button
                className={`st-switch${st.auto.pullToo ? ' on' : ''}`}
                role="switch"
                aria-checked={st.auto.pullToo}
                aria-label="自动备份时顺带拉取远端"
                onClick={() => setAuto({ pullToo: !st.auto.pullToo })}
              />
            </div>
          </>
        )}

        {note('auto')}
      </section>
    </>
  )
}

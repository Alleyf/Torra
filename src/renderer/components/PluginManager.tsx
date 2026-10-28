/**
 * 设置页 ·「应用插件」。
 *
 * 和「自建工具」不是一回事：那一页是助手自己写的清单（数据或单文件脚本），这一页是带
 * 面板与私有存储的应用插件。这里必须把三件事说清楚，否则用户点的是一次
 * 盲批：
 * 1. 声明了哪些能力；
 * 2. 启用后代码会跑起来，崩溃隔离不等于权限隔离；
 * 3. 升级后能力变多会自动停用，需要重新确认。
 *
 * 卡片只放「一眼认出」：名称、版本、来路、状态、能力标签和开关。完整说明、目录、
 * 工具与提示词清单、重启与卸载都在详情弹窗里 —— 危险动作不该躺在列表里等误触。
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle,
  Download,
  FolderOpen,
  Package,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type { PluginActionResult, PluginListResult, PluginView } from '@shared/plugins'
import { LibCard, LibDetail, LibGrid, LibPill } from './LibraryCards'

const PERMISSION_LABEL: Record<string, string> = {
  storage: '本地存储',
  panel: '侧栏面板',
  tools: '助手工具',
  secrets: '插件私有密钥',
  ai: '调用已配置的模型（会计费）',
}

function permLabel(perm: string): string {
  if (perm.startsWith('net:')) return `联网 ${perm.slice(4)}`
  return PERMISSION_LABEL[perm] ?? perm
}

const STATUS_LABEL: Record<PluginView['status'], string> = {
  ready: '运行中',
  starting: '启动中',
  failed: '启动失败',
  stopped: '未运行',
}

export function AppPluginsSection({ onChanged }: { onChanged?: () => void }) {
  const [view, setView] = useState<PluginListResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [open, setOpen] = useState<PluginView | null>(null)
  const [openInvalid, setOpenInvalid] = useState<PluginListResult['invalid'][number] | null>(null)

  const reload = useCallback(async () => {
    setView(await window.torra.pluginsList())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /** 一次只跑一个动作：并发启停两个插件，失败原因就分不清是谁的 */
  const act = async (key: string, label: string, run: () => Promise<PluginActionResult>) => {
    setBusy(key)
    setMsg(null)
    const start = Date.now()
    let result: PluginActionResult
    try {
      result = await run()
    } catch (error) {
      result = { ok: false, reason: (error as Error).message }
    }
    const elapsed = Date.now() - start
    if (elapsed < 600) await new Promise((res) => setTimeout(res, 600 - elapsed))
    setBusy(null)
    setMsg({ ok: result.ok, text: `${label}：${result.ok ? '完成' : result.reason ?? '失败'}` })
    await reload()
    // 顶部导航与插件屏不在这一屏，收不到这里的 state：用一个窗口事件通知它们重读
    window.dispatchEvent(new Event('torra:plugins-changed'))
    onChanged?.()
    setTimeout(() => setMsg(null), 6000)
  }

  const install = async (kind: 'dir' | 'zip') => {
    setBusy(`install:${kind}`)
    setMsg(null)
    try {
      const picked = await window.torra.pluginsPickSource(kind)
      if (!picked.ok || !picked.path) {
        setBusy(null)
        if (picked.reason && picked.reason !== '已取消') setMsg({ ok: false, text: picked.reason })
        return
      }
      await act(`install:${kind}`, '安装插件', () => window.torra.pluginsInstall(picked.path!))
    } finally {
      setBusy(null)
    }
  }

  const uninstall = (p: PluginView) => {
    if (!window.confirm(`卸载「${p.name}」会删除它的安装目录，插件数据保留。继续？`)) return
    setOpen(null)
    void act(`p:${p.id}`, `卸载 ${p.name}`, () => window.torra.pluginsUninstall(p.id))
  }

  const plugins = view?.plugins ?? []
  const invalid = view?.invalid ?? []
  const disabled = (key: string) => busy !== null && busy !== key

  return (
    <>
      <div className="lib-bar">
        <span className="lib-bar-n">
          {plugins.length} 个插件 · {plugins.filter((p) => p.enabled).length} 个已启用
        </span>
        {view && (
          <span className="lib-card-path" title={view.userDir}>
            {view.userDir}
          </span>
        )}
      </div>

      <div className="lib-bar">
        <button className="st-btn" disabled={busy !== null} onClick={() => void install('dir')}>
          {busy === 'install:dir' ? <RefreshCw size={12} className="spin" /> : <FolderOpen size={12} />}
          从文件夹安装
        </button>
        <button className="st-btn" disabled={busy !== null} onClick={() => void install('zip')}>
          {busy === 'install:zip' ? <RefreshCw size={12} className="spin" /> : <Download size={12} />}
          从 zip 安装
        </button>
      </div>
      <p className="st-meta">
        代码在独立进程里跑（崩溃不会带崩应用），但崩溃隔离不等于权限隔离 —— 能力清单约束的是它通过宿主接口能做的事。
        面板立刻可用，工具要等下一场对话重新装配。
      </p>
      {msg && (
        <p className={`st-note${msg.ok ? '' : ' warn'}`}>
          {msg.ok ? <CheckCircle size={10} /> : <AlertTriangle size={10} />} {msg.text}
        </p>
      )}

      {plugins.length === 0 && invalid.length === 0 && (
        <div className="st-empty">
          还没有应用插件。内置插件随应用发布（研究主线图在 <code>plugins/</code> 目录），也可以从文件夹或
          zip 安装第三方插件。
        </div>
      )}

      {(plugins.length > 0 || invalid.length > 0) && (
        <LibGrid>
          {plugins.map((p) => {
            const key = `p:${p.id}`
            return (
              <LibCard
                key={p.id}
                icon={Package}
                title={p.name}
                tone={p.error ? 'warn' : undefined}
                meta={
                  <>
                    <span className="st-chip">{p.version}</span>
                    <span className="st-chip">{p.origin === 'builtin' ? '内置' : '本地'}</span>
                    {p.enabled && <span className="st-chip">{STATUS_LABEL[p.status]}</span>}
                    {p.panel && <span className="st-chip">侧栏面板</span>}
                    {p.tools.length > 0 && <span className="st-chip">工具 {p.tools.length} 个</span>}
                  </>
                }
                action={
                  <button
                    className={`st-switch${p.enabled ? ' on' : ''}`}
                    role="switch"
                    aria-checked={p.enabled}
                    aria-label={`${p.enabled ? '停用' : '启用'} ${p.name}`}
                    disabled={disabled(key)}
                    onClick={() => void act(key, `${p.enabled ? '停用' : '启用'} ${p.name}`, () => window.torra.pluginsSetEnabled(p.id, !p.enabled))}
                  />
                }
                desc={p.description}
                footer={
                  <span className="lib-card-path" title={p.dir}>
                    {p.dir}
                  </span>
                }
                onOpen={() => setOpen(p)}
              >
                {p.error && (
                  <p className="lib-card-warn">
                    <AlertTriangle size={11} /> {p.error}
                  </p>
                )}
                <div className="lib-card-meta">
                  {p.permissions.length === 0 ? (
                    <span>不申请任何能力</span>
                  ) : (
                    p.permissions.map((perm) => (
                      <span key={perm} className="st-chip">
                        {permLabel(perm)}
                      </span>
                    ))
                  )}
                </div>
              </LibCard>
            )
          })}
          {invalid.map((item) => (
            <LibCard
              key={item.dir}
              tone="warn"
              icon={AlertTriangle}
              title="清单无效"
              meta={<span className="st-chip">读不出来</span>}
              action={<LibPill tone="warn">格式不合法</LibPill>}
              footer={
                <span className="lib-card-path" title={item.dir}>
                  {item.dir}
                </span>
              }
              onOpen={() => setOpenInvalid(item)}
            >
              <p className="lib-card-warn">{item.errors.join('；')}</p>
            </LibCard>
          ))}
        </LibGrid>
      )}

      {open && (
        <LibDetail
          icon={Package}
          title={open.name}
          tone={open.error ? 'warn' : undefined}
          meta={
            <>
              <span className="st-chip">{open.version}</span>
              <span className="st-chip">{open.origin === 'builtin' ? '内置' : '本地'}</span>
              <span className="st-chip">{open.enabled ? STATUS_LABEL[open.status] : '已停用'}</span>
            </>
          }
          desc={open.description}
          onClose={() => setOpen(null)}
          actions={
            <>
              <button className="st-btn" onClick={() => setOpen(null)}>
                关闭
              </button>
              {open.enabled && open.files.main && (
                <button
                  className="st-btn"
                  disabled={disabled(`p:${open.id}`)}
                  onClick={() => void act(`p:${open.id}`, `重启 ${open.name}`, () => window.torra.pluginsReload(open.id))}
                >
                  {busy === `p:${open.id}` ? <RefreshCw size={12} className="spin" /> : <Play size={12} />}
                  重启进程
                </button>
              )}
              {open.origin === 'user' && (
                <button className="st-btn danger" disabled={disabled(`p:${open.id}`)} onClick={() => uninstall(open)}>
                  <Trash2 size={12} />
                  卸载
                </button>
              )}
              <button
                className={`st-btn${open.enabled ? ' danger' : ' primary'}`}
                disabled={disabled(`p:${open.id}`)}
                onClick={() =>
                  void act(`p:${open.id}`, `${open.enabled ? '停用' : '启用'} ${open.name}`, () =>
                    window.torra.pluginsSetEnabled(open.id, !open.enabled)
                  )
                }
              >
                {open.enabled ? '停用' : '启用'}
              </button>
            </>
          }
        >
          <dl className="lib-detail-row">
            <dt>安装目录</dt>
            <dd>{open.dir}</dd>
          </dl>
          <dl className="lib-detail-row plain">
            <dt>主入口</dt>
            <dd>{open.files.main ? 'main.js 已就位' : '缺 main.js，起不来'}</dd>
          </dl>
          <dl className="lib-detail-row plain">
            <dt>面板</dt>
            <dd>{open.files.ui ? 'ui.html 已就位' : '没有面板'}</dd>
          </dl>
          <dl className="lib-detail-row plain">
            <dt>能力清单</dt>
            <dd>
              {open.permissions.length === 0
                ? '不申请任何能力'
                : open.permissions.map((perm) => permLabel(perm)).join(' · ')}
            </dd>
          </dl>
          {open.tools.length > 0 && (
            <>
              <div className="lib-detail-sec">交给助手的工具</div>
              <ul className="lib-detail-list">
                {open.tools.map((t) => (
                  <li key={t.name}>
                    <b>{t.label}</b>
                    <span>
                      {t.name} · {t.description}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {open.prompts.length > 0 && (
            <>
              <div className="lib-detail-sec">自带的提示词</div>
              <ul className="lib-detail-list">
                {open.prompts.map((p) => (
                  <li key={p.id}>
                    <b>{p.title}</b>
                    <span>{p.id}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {open.error && (
            <p className="lib-card-warn">
              <AlertTriangle size={11} /> {open.error}
            </p>
          )}
          <p className="st-meta">
            升级后如果能力清单变了，插件会自动停用，需要在这里重新启用 —— 那是重新确认，不是多按一下。
          </p>
        </LibDetail>
      )}

      {openInvalid && (
        <LibDetail
          icon={AlertTriangle}
          title="清单无效"
          tone="warn"
          meta={<span className="st-chip">格式不合法</span>}
          desc="这个目录里的插件没通过校验，整条都不会加载。修好问题后重启应用再试。"
          onClose={() => setOpenInvalid(null)}
          actions={
            <button className="st-btn" onClick={() => setOpenInvalid(null)}>
              关闭
            </button>
          }
        >
          <ul className="lib-detail-list">
            {openInvalid.errors.map((e, i) => (
              <li key={`${i}-${e}`}>
                <span>{e}</span>
              </li>
            ))}
          </ul>
          <dl className="lib-detail-row">
            <dt>目录</dt>
            <dd>{openInvalid.dir}</dd>
          </dl>
        </LibDetail>
      )}
    </>
  )
}

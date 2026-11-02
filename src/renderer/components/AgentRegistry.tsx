/**
 * 「接一家 Torra 没收录的」：写进 <userData>/torra/acp.json 的那张表单。
 *
 * 为什么要有这个表单，而不只是「读一个配置文件」：
 * 注册表里的 command 与 args 会被拼进一条命令行，参数里带 & 或 | 就能在用户机器上
 * 多跑一条命令。主进程会挡（校验在那儿），但表单里先把话说清楚 ——
 * 「这两个字段会被拼成一条命令行」，用户自己填的时候才知道自己在填什么。
 *
 * 它不是唯一入口：同一个文件用户自己拿编辑器改也认。
 *
 * 能加也得能删：加进来的条目要是删不掉，这条路就是个死胡同。
 * 删除不用系统那个「你确定吗」弹窗 —— 在这儿换个就地两步确认：
 * 按一下变成「确认删除」，过几秒自己退回去。
 */
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Loader2, Trash2 } from 'lucide-react'
import type { AcpAgentEntry } from '@shared/acp'
import { FailureNote } from './StateNotice'
import { failFromReason, type Failure } from '../messages'

/** 目录名：整条路径太长时只显示最后一段 */
export function dirLeaf(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

/** 一条用户自己加的条目：能看见它是谁，也能把它删掉 */
function UserEntryRow({ entry, onRemoved }: { entry: AcpAgentEntry; onRemoved: () => void | Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<Failure | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    [],
  )

  /** 第一下只是「亮一下」：真删要再点一下那枚「确认删除」 */
  const arm = () => {
    setErr(null)
    setConfirming(true)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setConfirming(false), 5000)
  }

  const disarm = () => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    setConfirming(false)
  }

  const remove = async () => {
    setBusy(true)
    setErr(null)
    let r: { ok: boolean; reason?: string }
    try {
      r = await window.torra.acpRegistryRemove(entry.id)
    } catch (e) {
      r = { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
    setBusy(false)
    if (!r.ok) {
      // 没删掉就把原因摊在这一行上，别抛给用户一个没有出处的红字
      setErr(
        failFromReason(
          '这条没能删掉',
          r.reason,
          '确认这个程序还开着 —— 关掉它再删一次；文件被占用时先关掉那个窗口。',
        ),
      )
      disarm()
      return
    }
    disarm()
    await onRemoved()
  }

  const cmd = `${entry.command} ${entry.args.join(' ')}`.trim()

  return (
    <div className="acp-own-row">
      <div className="acp-own-main">
        <b title={entry.title}>{entry.title}</b>
        <code className="acp-own-id" title="落盘用的标识">
          {entry.id}
        </code>
        <code className="acp-own-cmd" title={cmd}>
          {cmd}
        </code>
      </div>
      {confirming ? (
        <button
          type="button"
          className="acp-own-confirm"
          onClick={() => void remove()}
          disabled={busy}
          title={`删掉 ${entry.id}`}
        >
          {busy ? <Loader2 size={11} className="spin" /> : <Trash2 size={11} />}
          确认删除 {entry.id}
        </button>
      ) : (
        <button
          type="button"
          className="acp-own-del"
          onClick={arm}
          title={`删掉 ${entry.id}`}
          aria-label={`删掉 ${entry.id}`}
        >
          <Trash2 size={12} />
        </button>
      )}
      {err && (
        <p className="acp-own-err">
          <FailureNote text={err.text} detail={err.detail} />
        </p>
      )}
    </div>
  )
}

export function RegistryEditor({ onSaved }: { onSaved: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [pkgName, setPkgName] = useState('')
  const [pkgVersion, setPkgVersion] = useState('')
  const [path, setPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void window.torra.acpRegistryPath().then((r) => setPath(r.path))
  }, [open])

  const save = async () => {
    setBusy(true)
    setNote(null)
    const r = await window.torra.acpRegistrySave({
      id: id.trim(),
      title: title.trim() || undefined,
      command: command.trim(),
      // 参数按空格拆，但引号里的空格要留住 —— 命令行上引号是有意义的
      args: args.trim() ? args.trim().match(/"[^"]*"|\S+/g) ?? [] : [],
      package: pkgName.trim() && pkgVersion.trim() ? { name: pkgName.trim(), version: pkgVersion.trim() } : undefined,
    })
    setBusy(false)
    if (!r.ok) {
      setNote(
        failFromReason(
          '这条没能存上',
          r.reason,
          '检查一下标识和命令是不是都填了 —— 标识只能用字母、数字、下划线和短横线。',
        ).text,
      )
      return
    }
    setId('')
    setTitle('')
    setCommand('')
    setArgs('')
    setPkgName('')
    setPkgVersion('')
    setOpen(false)
    await onSaved()
  }

  return (
    <div className="acp-registry">
      <button type="button" className="acp-registry-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronDown size={12} className={`acp-chev${open ? ' open' : ''}`} />
        <span>接一家 Torra 没收录的</span>
      </button>
      {open && (
        <div className="acp-registry-form">
          <label className="acp-field">
            <span>标识</span>
            <input
              value={id}
              placeholder="例如 my-agent"
              onChange={(e) => setId(e.target.value)}
              title="小写字母、数字、连字符；落盘用它"
            />
          </label>
          <label className="acp-field">
            <span>显示名</span>
            <input value={title} placeholder="留空就用标识" onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="acp-field wide">
            <span>启动命令</span>
            <input value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />
          </label>
          <label className="acp-field wide">
            <span>参数</span>
            <input
              value={args}
              placeholder="-y @scope/adapter@1.2.3"
              onChange={(e) => setArgs(e.target.value)}
              title="会被拼进一条命令行：不能带 & | < > ^ % ! 这些 shell 连接符"
            />
          </label>
          <label className="acp-field">
            <span>适配器包</span>
            <input value={pkgName} placeholder="可留空" onChange={(e) => setPkgName(e.target.value)} />
          </label>
          <label className="acp-field">
            <span>版本</span>
            <input
              value={pkgVersion}
              placeholder="1.2.3"
              onChange={(e) => setPkgVersion(e.target.value)}
              title="钉死版本：换了版本兼容矩阵就要重测"
            />
          </label>
          <div className="acp-registry-foot">
            <button type="button" className="btn sm primary" disabled={busy || !id.trim() || !command.trim()} onClick={() => void save()}>
              {busy ? <Loader2 size={11} className="spin" /> : <Check size={11} />}
              存下这一条
            </button>
            {path && (
              <span className="acp-registry-path" title={path}>
                落盘在 {dirLeaf(path)}
              </span>
            )}
          </div>
          {note && <p className="acp-registry-note">{note}</p>}
        </div>
      )}
    </div>
  )
}

/**
 * 已经接进来的那几条：能加也得能删。
 *
 * 删除不用系统那个「你确定吗」弹窗 —— 在这儿换个就地两步确认：
 * 按一下变成「确认删除」，过几秒自己退回去。
 *
 * 它单独成一个组件，是因为它得一直摆在明面上：从目录里一键加进来的那些，
 * 用户得能顺手就把它撤掉，而不是先滚到别的面板里找。
 */
export function UserEntries({
  userEntries = [],
  onChanged,
}: {
  userEntries: AcpAgentEntry[]
  onChanged: () => void | Promise<void>
}) {
  if (userEntries.length === 0) return null
  return (
    <div className="acp-registry-own">
      <div className="acp-registry-own-head">你接入的条目（{userEntries.length}）</div>
      {userEntries.map((e) => (
        <UserEntryRow key={e.id} entry={e} onRemoved={onChanged} />
      ))}
    </div>
  )
}

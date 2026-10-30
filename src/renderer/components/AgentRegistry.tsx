/**
 * 「接一家 Torra 没收录的」：写进 <userData>/torra/acp.json 的那张表单。
 *
 * 为什么要有这个表单，而不只是「读一个配置文件」：
 * 注册表里的 command 与 args 会被拼进一条命令行，参数里带 & 或 | 就能在用户机器上
 * 多跑一条命令。主进程会挡（校验在那儿），但表单里先把话说清楚 ——
 * 「这两个字段会被拼成一条命令行」，用户自己填的时候才知道自己在填什么。
 *
 * 它不是唯一入口：同一个文件用户自己拿编辑器改也认。
 */
import { useEffect, useState } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'

/** 目录名：整条路径太长时只显示最后一段 */
export function dirLeaf(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? dir
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
      setNote(`没存上：${r.reason ?? '原因不明'}`)
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

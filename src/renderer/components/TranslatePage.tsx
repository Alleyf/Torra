import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_TRANSLATE_MODEL,
  TARGET_LANGS,
  TRANSLATE_MODELS,
  TRANSLATE_TEXT_MAX_CHARS,
  TRANSLATE_IMAGE_MAX_BYTES,
  TRANSLATE_PROMPT_FIELD_MAX_CHARS,
  TRANSLATE_REQUEST_MAX_CHARS,
  type TranslateImageInput,
} from '@shared/translate'
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  Copy,
  Eraser,
  Languages,
  Loader2,
  Settings2,
  Sparkles,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'
import { Markdown, preloadMarkdown } from './Markdown'
import '../translate.css'

/** 源语言：自动判断 + 与目标语言表相同的语言（够用，不必更全） */
const SOURCE_LANGS = [{ code: 'auto', name: '自动判断' }, ...TARGET_LANGS]

/** 拖放区声明支持的扩展名：图片走视觉直译，文本类文件直接读进原文框 */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'])
const TEXT_EXT = /\.(txt|md|markdown|csv|json|log|yaml|yml|ts|tsx|js|jsx|py|html?|xml)$/i

const FILE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,.txt,.md,.csv,.json,.log,.yaml,.yml,.ts,.tsx,.js,.jsx,.py,.html,.htm,.xml'

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function LangSelect({
  ariaLabel,
  className,
  label,
  langs,
  name,
  onChange,
  title,
  value,
}: {
  ariaLabel: string
  className: string
  label: React.ReactNode
  langs: typeof TARGET_LANGS
  name: string
  onChange: (code: string) => void
  title: string
  value: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(() => Math.max(0, langs.findIndex((l) => l.code === value)))
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onClose = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClose)
    return () => document.removeEventListener('mousedown', onClose)
  }, [open])

  useEffect(() => {
    if (!open) return
    const option = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[active]
    option?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const move = (dir: -1 | 1) => {
    setActive((v) => Math.min(langs.length - 1, Math.max(0, v + dir)))
  }

  const openList = () => {
    setActive(Math.max(0, langs.findIndex((l) => l.code === value)))
    setOpen(true)
  }

  const pick = (code: string) => {
    onChange(code)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const currentName = langs.find((l) => l.code === value)?.name ?? value
  const activeCode = langs[active]?.code

  return (
    <div className={`tr-select ${className}`} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={`${name}-list`}
        aria-activedescendant={open && activeCode ? `${name}-${activeCode}` : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="tr-select-trigger"
        title={title}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => {
          if (!open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              openList()
            }
            return
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            move(e.key === 'ArrowDown' ? 1 : -1)
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (activeCode) pick(activeCode)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
          }
        }}
      >
        {label}
        <span className="tr-select-value">{currentName}</span>
        <ChevronDown size={13} />
      </button>
      {/* 列表常驻 DOM：收起时用 hidden 隐藏，aria-controls 才不会指向已卸载的元素 */}
      <div
        className="tr-select-list"
        id={`${name}-list`}
        role="listbox"
        ref={listRef}
        aria-label={title}
        hidden={!open}
      >
        {langs.map((l, i) => (
          <button
            type="button"
            key={l.code}
            tabIndex={-1}
            id={`${name}-${l.code}`}
            role="option"
            aria-selected={l.code === value}
            className={`tr-select-option${l.code === value ? ' selected' : ''}${
              i === active ? ' active' : ''
            }`}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(l.code)}
          >
            <span>{l.name}</span>
            {l.code === value && <Check size={13} />}
          </button>
        ))}
      </div>
    </div>
  )
}

/*
 * 发给端点前先把像素量超标的图缩小。
 *
 * 实测：4000×3000 要 8 秒以上，文字再密一点就撞上网关 60s 读超时（504）。
 * 缩到长边 1600 之后回到 1~2s，代价几乎为零 —— 图里要被识别的是文字，
 * 不是要欣赏的画质，所以这是这里最划算的一刀。
 */
const IMAGE_MAX_EDGE = 1600

/** 只有像素量真的超标才重绘，省掉给小图白付的一次 canvas 开销 */
async function shrinkImageIfNeeded(
  dataUrl: string,
): Promise<{ dataUrl: string; scaledFrom?: { w: number; h: number } }> {
  const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
  if (!dims) return { dataUrl }
  if (Math.max(dims.w, dims.h) <= IMAGE_MAX_EDGE) return { dataUrl }

  const scale = IMAGE_MAX_EDGE / Math.max(dims.w, dims.h)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(dims.w * scale)
  canvas.height = Math.round(dims.h * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return { dataUrl }
  const img = new Image()
  await new Promise<void>((resolve) => {
    img.onload = () => resolve()
    img.onerror = () => resolve()
    img.src = dataUrl
  })
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return { dataUrl: canvas.toDataURL('image/png'), scaledFrom: { w: dims.w, h: dims.h } }
}

export function TranslatePage() {
  // 译文是要按 Markdown 渲染的，进这一屏就把渲染器取好，别等译文到了才现取
  useEffect(() => {
    void preloadMarkdown()
  }, [])
  const [text, setText] = useState('')
  const [target, setTarget] = useState('zh')
  const [source, setSource] = useState('auto')
  const [model, setModel] = useState(DEFAULT_TRANSLATE_MODEL)
  const [instruction, setInstruction] = useState('')
  const [glossary, setGlossary] = useState('')
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<'source' | 'result' | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [image, setImage] = useState<TranslateImageInput | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [dropping, setDropping] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const overLimit = text.length > TRANSLATE_TEXT_MAX_CHARS
  const hardLimit = text.length > TRANSLATE_REQUEST_MAX_CHARS
  const hasInput = (!!text.trim() || !!image) && !hardLimit
  const targetName = useMemo(
    () => TARGET_LANGS.find((l) => l.code === target)?.name ?? target,
    [target],
  )
  const sourceName = useMemo(
    () => SOURCE_LANGS.find((l) => l.code === source)?.name ?? source,
    [source],
  )
  const modelNote = useMemo(
    () => TRANSLATE_MODELS.find((m) => m.id === model)?.note ?? '',
    [model],
  )

  const swap = () => {
    // 源语言是「自动判断」时没有具体语言可换；退回到与当前目标相反的一档
    const from = source === 'auto' ? (target === 'en' ? 'zh' : 'en') : source
    setSource(target)
    setTarget(from)
    if (result) {
      setText(result)
      setResult(text)
    }
    setImage(null)
    setError(null)
  }

  // 灯箱开着的时侯 Esc 关掉；图片被移除时也一起关，别留一个空的浮层
  useEffect(() => {
    if (!previewing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewing(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [previewing])

  useEffect(() => {
    if (!image) setPreviewing(false)
  }, [image])

  const run = async () => {
    if (!hasInput || busy) return
    setBusy(true)
    setError(null)
    setDetail(null)
    setResult('')
    try {
      const r = await window.torra.translateText({
        text: text.trim(),
        target,
        source,
        model,
        instruction: instruction.trim(),
        glossary: glossary.trim(),
        image: image ?? undefined,
      })
      if (!r.ok) {
        setError(r.reason ?? '翻译失败')
        setDetail(r.detail ?? null)
        return
      }
      setResult(r.text)
    } catch (e) {
      setError((e as Error).message || '翻译失败')
    } finally {
      setBusy(false)
    }
  }

  const copy = async (value: string, which: 'source' | 'result') => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(which)
      setTimeout(() => setCopied(null), 1600)
    } catch {
      setError('复制失败：系统拒绝了剪贴板访问')
    }
  }

  const clear = () => {
    setText('')
    setResult('')
    setImage(null)
    setError(null)
    setDetail(null)
  }

  /*
   * 图片走视觉直译；文本类文件读进原文框继续按普通文本翻。
   * 端点没有文档解析能力，所以 PDF / Word 这类不硬塞 —— 提示用户先把文本取出来。
   */
  const acceptFile = async (file: File) => {
    setError(null)
    setDetail(null)
    if (IMAGE_EXT.test(file.name) || IMAGE_MIME.has(file.type)) {
      if (file.size > TRANSLATE_IMAGE_MAX_BYTES) {
        setError(`图片 ${bytesLabel(file.size)} 超过 ${bytesLabel(TRANSLATE_IMAGE_MAX_BYTES)} 上限`)
        return
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result ?? ''))
        fr.onerror = () => reject(new Error('读取图片失败'))
        fr.readAsDataURL(file)
      })
      const shrunk = await shrinkImageIfNeeded(dataUrl)
      setImage({
        name: file.name,
        mime: file.type || 'image/png',
        dataUrl: shrunk.dataUrl,
        originalBytes: file.size,
        scaledFrom: shrunk.scaledFrom,
      })
      return
    }
    if (TEXT_EXT.test(file.name) || file.type.startsWith('text/')) {
      const raw = await file.text()
      const next = text ? `${text}\n\n${raw}` : raw
      if (next.length > TRANSLATE_REQUEST_MAX_CHARS) {
        setError(`文本超过 ${TRANSLATE_REQUEST_MAX_CHARS.toLocaleString()} 字上限，请拆成更小的文件`)
        return
      }
      setText(next)
      return
    }
    setError('只支持图片或纯文本文件；PDF / Word 请先复制其中的文字再贴进来')
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDropping(false)
    const file = e.dataTransfer.files[0]
    if (file) void acceptFile(file)
  }

  /*
   * 直接粘贴截图：剪切板里的图片没有文件名，操作系统给的是 image/png 这种类型。
   * 拼一个名字出来只是为了 chip 上好显示，不参与任何校验。
   */
  const acceptClipboardImage = (e: ClipboardEvent | React.ClipboardEvent<HTMLTextAreaElement>) => {
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
    if (!file) return false
    e.preventDefault()
    const ext = file.type === 'image/jpeg' ? 'jpg' : (file.type.split('/')[1] || 'png')
    const stamped = new File([file], file.name || `粘贴的图片-${new Date().toISOString().slice(11, 19)}.${ext}`, {
      type: file.type,
    })
    void acceptFile(stamped)
    return true
  }

  /*
   * 焦点不在输入框时（刚进这一屏、或刚点完别的按钮）也要能直接粘截图。
   * textarea 自己会先处理，那里已经 preventDefault 了，到这里不会重复。
   */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return
      acceptClipboardImage(e)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  })

  return (
    <div className={`tr-page${dropping ? ' dropping' : ''}`}>
      <div className="tr-bar">
        <div className="tr-bar-langs">
          <LangSelect
            className="tr-chip tr-select-source"
            ariaLabel="选择源语言"
            title="源语言"
            label={<Languages size={13} />}
            langs={SOURCE_LANGS}
            name="translate-source"
            value={source}
            onChange={setSource}
          />
          <button className="tr-swap" onClick={swap} title="交换源语言与目标语言" aria-label="交换语言">
            <ArrowLeftRight size={13} />
          </button>
          <LangSelect
            className="tr-chip tr-select-target"
            ariaLabel="选择目标语言"
            title="目标语言"
            label={<span className="tr-dot" />}
            langs={TARGET_LANGS}
            name="translate-target"
            value={target}
            onChange={setTarget}
          />
        </div>

        <button className="btn primary tr-run" onClick={() => void run()} disabled={busy || !hasInput}>
          {busy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
          {busy ? '翻译中…' : `翻译成${targetName}`}
        </button>

        <div className="tr-bar-tools">
          <span className="tr-model-pill" title={modelNote}>
            {model.replace(/^Index-Translate-/, '')}
          </span>
          <button
            className={`tr-icon${panelOpen ? ' active' : ''}`}
            onClick={() => setPanelOpen((v) => !v)}
            title="模型与进阶约束"
            aria-label="模型与进阶约束"
          >
            <Settings2 size={15} />
          </button>
        </div>
      </div>

      {panelOpen && (
        <div className="tr-panel">
          <div className="tr-models">
            {TRANSLATE_MODELS.map((m) => (
              <button
                key={m.id}
                className={`tr-model${model === m.id ? ' active' : ''}`}
                onClick={() => setModel(m.id)}
                aria-pressed={model === m.id}
              >
                <span className="tr-model-name">{m.id.replace(/^Index-Translate-/, '')}</span>
                <span className="tr-model-note">{m.note}</span>
              </button>
            ))}
          </div>
          <label className="tr-field">
            <span>自由指令</span>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              maxLength={TRANSLATE_PROMPT_FIELD_MAX_CHARS}
              placeholder="例如：保留原有换行结构；语气正式一些；只翻译 value 不动 key"
              spellCheck={false}
            />
          </label>
          <label className="tr-field">
            <span>术语对照</span>
            <input
              type="text"
              value={glossary}
              onChange={(e) => setGlossary(e.target.value)}
              maxLength={TRANSLATE_PROMPT_FIELD_MAX_CHARS}
              placeholder="例如：碳纤维→carbon fiber，抗裂缝→crack resistance"
            />
          </label>
          <p className="tr-hint">
            术语对照用逗号分隔，每组写「源词→目标词」；写错的那组会被忽略，不会让整次翻译失败。
          </p>
        </div>
      )}

      <div className="tr-split-body">
        <section className="tr-pane">
          <div className="tr-pane-bar">
            <span className="tr-pane-label">{sourceName}</span>
            <div className="tr-pane-tools">
              <span className={`tr-count${overLimit ? ' over' : ''}`}>
                {text.length.toLocaleString()} / {TRANSLATE_TEXT_MAX_CHARS.toLocaleString()}
              </span>
              <button
                className="tr-icon"
                onClick={() => void copy(text, 'source')}
                disabled={!text}
                title="复制原文"
                aria-label="复制原文"
              >
                {copied === 'source' ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <button
                className="tr-icon"
                onClick={clear}
                disabled={!text && !result && !image}
                title="清空"
                aria-label="清空"
              >
                <Eraser size={14} />
              </button>
            </div>
          </div>

          <textarea
            className="tr-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => acceptClipboardImage(e)}
            maxLength={TRANSLATE_REQUEST_MAX_CHARS}
            placeholder="请输入文本…"
            spellCheck={false}
          />

          {image && (
            <div className="tr-chip-file">
              <button
                className="tr-thumb"
                onClick={() => setPreviewing(true)}
                title="点击查看原图"
                aria-label="查看图片"
              >
                <img src={image.dataUrl} alt={image.name} />
              </button>
              <span className="tr-chip-name">{image.name}</span>
              <span className="tr-chip-size">
                {image.scaledFrom
                  ? `${image.scaledFrom.w}×${image.scaledFrom.h} → 1600×${Math.round(
                      (image.scaledFrom.h * IMAGE_MAX_EDGE) / Math.max(image.scaledFrom.w, image.scaledFrom.h),
                    )}（防超时已缩放）`
                  : bytesLabel(Math.round((image.dataUrl.length * 3) / 4))}
              </span>
              <button className="tr-icon" onClick={() => setImage(null)} title="移除图片" aria-label="移除图片">
                <X size={13} />
              </button>
            </div>
          )}

          <div
            className="tr-drop"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDropping(true)
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click()
            }}
          >
            <Upload size={14} />
            <span>拖入、点击上传或直接粘贴图片 / 文本文件</span>
            <span className="tr-drop-hint">图片直译 · PDF/Word 请先取出文字</span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept={FILE_ACCEPT}
            className="tr-file"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void acceptFile(f)
              e.target.value = ''
            }}
          />
        </section>

        <div className="tr-divider" />

        <section className="tr-pane">
          <div className="tr-pane-bar">
            <span className="tr-pane-label">{targetName}</span>
            <div className="tr-pane-tools">
              <button
                className="tr-icon"
                onClick={() => void copy(result, 'result')}
                disabled={!result}
                title="复制译文"
                aria-label="复制译文"
              >
                {copied === 'result' ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>
          {result ? (
            <div className="tr-out">
              <Markdown text={result} />
            </div>
          ) : (
            <div className="tr-out tr-out-empty">{busy ? '翻译中…' : '译文会出现在这里'}</div>
          )}
        </section>
      </div>

      {overLimit && <p className="tr-hint warn">超过单次上限，提交时会按自然段分批翻译，译文按批次顺序拼接。</p>}

      {previewing && image && (
        <div className="modal-mask tr-lightbox" onClick={() => setPreviewing(false)}>
          <img src={image.dataUrl} alt={image.name} onClick={(e) => e.stopPropagation()} />
          <button
            className="btn icon tr-lightbox-close"
            onClick={() => setPreviewing(false)}
            title="关闭预览"
            aria-label="关闭预览"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {error && (
        <div className="tr-error">
          <TriangleAlert size={14} />
          <div>
            <div className="tr-error-title">{error}</div>
            {detail && <div className="tr-error-detail">{detail}</div>}
          </div>
        </div>
      )}

      <p className="tr-foot">
        走哔哩哔哩 Index-Translate 免费公开接口，无需 API Key、不经过账号登录。内容会直接发到该端点，请勿粘贴不宜外发的材料。
      </p>
    </div>
  )
}

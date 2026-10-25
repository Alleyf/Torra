import { useEffect, useMemo, useRef, useState } from 'react'
import flagBg from 'flag-icons/flags/4x3/bg.svg'
import flagCn from 'flag-icons/flags/4x3/cn.svg'
import flagCz from 'flag-icons/flags/4x3/cz.svg'
import flagDe from 'flag-icons/flags/4x3/de.svg'
import flagDk from 'flag-icons/flags/4x3/dk.svg'
import flagEs from 'flag-icons/flags/4x3/es.svg'
import flagFi from 'flag-icons/flags/4x3/fi.svg'
import flagFr from 'flag-icons/flags/4x3/fr.svg'
import flagGr from 'flag-icons/flags/4x3/gr.svg'
import flagHu from 'flag-icons/flags/4x3/hu.svg'
import flagId from 'flag-icons/flags/4x3/id.svg'
import flagIn from 'flag-icons/flags/4x3/in.svg'
import flagIr from 'flag-icons/flags/4x3/ir.svg'
import flagIt from 'flag-icons/flags/4x3/it.svg'
import flagJp from 'flag-icons/flags/4x3/jp.svg'
import flagKr from 'flag-icons/flags/4x3/kr.svg'
import flagMs from 'flag-icons/flags/4x3/my.svg'
import flagNl from 'flag-icons/flags/4x3/nl.svg'
import flagNo from 'flag-icons/flags/4x3/no.svg'
import flagPh from 'flag-icons/flags/4x3/ph.svg'
import flagPl from 'flag-icons/flags/4x3/pl.svg'
import flagPt from 'flag-icons/flags/4x3/pt.svg'
import flagRo from 'flag-icons/flags/4x3/ro.svg'
import flagRu from 'flag-icons/flags/4x3/ru.svg'
import flagSa from 'flag-icons/flags/4x3/sa.svg'
import flagSe from 'flag-icons/flags/4x3/se.svg'
import flagSk from 'flag-icons/flags/4x3/sk.svg'
import flagTh from 'flag-icons/flags/4x3/th.svg'
import flagTr from 'flag-icons/flags/4x3/tr.svg'
import flagUa from 'flag-icons/flags/4x3/ua.svg'
import flagUs from 'flag-icons/flags/4x3/us.svg'
import flagVn from 'flag-icons/flags/4x3/vn.svg'
import {
  DEFAULT_TRANSLATE_MODEL,
  TARGET_LANGS,
  LANG_NAMES,
  TRANSLATE_MODELS,
  TRANSLATE_IMAGE_MAX_BYTES,
  TRANSLATE_PROMPT_FIELD_MAX_CHARS,
  TRANSLATE_REQUEST_MAX_CHARS,
  TRANSLATE_TEXT_MAX_CHARS,
  type TranslateImageInput,
  type TranslateLang,
} from '@shared/translate'
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  Copy,
  Eraser,
  History,
  Loader2,
  Pin,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Star,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'
import { Markdown, preloadMarkdown } from './Markdown'
import {
  DEFAULT_TRANSLATE_PROMPT,
  DEFAULT_TRANSLATE_SETTINGS,
  DETECT_METHOD_LABEL,
  detectLangByScript,
  formatHistoryTs,
  type DetectMethod,
  type TranslateHistoryEntry,
  type TranslateSettings,
} from '@shared/translate-history'
import '../translate.css'

const LANG_FLAGS: Record<string, string> = {
  bg: flagBg,
  cn: flagCn,
  cz: flagCz,
  de: flagDe,
  dk: flagDk,
  es: flagEs,
  fi: flagFi,
  fr: flagFr,
  gr: flagGr,
  hu: flagHu,
  id: flagId,
  in: flagIn,
  ir: flagIr,
  it: flagIt,
  jp: flagJp,
  kr: flagKr,
  my: flagMs,
  nl: flagNl,
  no: flagNo,
  ph: flagPh,
  pl: flagPl,
  pt: flagPt,
  ro: flagRo,
  ru: flagRu,
  sa: flagSa,
  se: flagSe,
  sk: flagSk,
  th: flagTh,
  tr: flagTr,
  ua: flagUa,
  us: flagUs,
  vn: flagVn,
}

const LANG_COUNTRY: Record<string, string> = {
  zh: 'cn',
  en: 'us',
  ja: 'jp',
  ko: 'kr',
  fr: 'fr',
  de: 'de',
  es: 'es',
  pt: 'pt',
  ru: 'ru',
  ar: 'sa',
  it: 'it',
  nl: 'nl',
  pl: 'pl',
  ro: 'ro',
  sv: 'se',
  tr: 'tr',
  hi: 'in',
  vi: 'vn',
  th: 'th',
  id: 'id',
  ms: 'my',
  fil: 'ph',
  ukr_cyrl: 'ua',
  fas_arab: 'ir',
  ces_latn: 'cz',
  ell_grek: 'gr',
  dan_latn: 'dk',
  hun_latn: 'hu',
  fin_latn: 'fi',
  nob_latn: 'no',
  slk_latn: 'sk',
  bul_cyrl: 'bg',
}

function Flag({ code, title }: { code: string | null | undefined; title?: string }) {
  const key = (code ?? '').trim().toLowerCase()
  const country = LANG_COUNTRY[key] ?? key
  const src = LANG_FLAGS[country]
  const fallback = key === 'auto' ? '🌐' : (country || '?').slice(0, 2).toUpperCase()
  return (
    <span className={`tr-flag lang-${key || 'auto'}`} title={title ?? key}>
      {src ? <img src={src} alt='' draggable={false} /> : <span aria-hidden='true'>{fallback}</span>}
    </span>
  )
}

const SOURCE_AUTO: TranslateLang = { code: 'auto', name: '自动判断' }
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'])
const TEXT_EXT = /\.(txt|md|markdown|csv|json|log|yaml|yml|ts|tsx|js|jsx|py|html?|xml)$/i
const FILE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,.txt,.md,.csv,.json,.log,.yaml,.yml,.ts,.tsx,.js,.jsx,.py,.html,.htm,.xml'
const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '\u2318' : 'Ctrl'
const IMAGE_MAX_EDGE = 1600

type SettingsStatus = 'idle' | 'saving' | 'saved' | 'error'

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function shortModel(id: string): string {
  return id.replace(/^Index-Translate-/, '')
}

function ToggleRow({
  checked,
  hint,
  label,
  onChange,
}: {
  checked: boolean
  hint?: string
  label: string
  onChange: (next: boolean) => void
}) {
  return (
    <div className='tr-toggle-row'>
      <div className='tr-toggle-copy'>
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <button
        type='button'
        role='switch'
        aria-checked={checked}
        aria-label={label}
        className={`tr-switch${checked ? ' on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  )
}

function LangSelect({ ariaLabel, className, name, langs, onChange, title, value }: {
  ariaLabel: string
  className: string
  langs: TranslateLang[]
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
        type='button'
        ref={triggerRef}
        role='combobox'
        aria-label={ariaLabel}
        aria-controls={`${name}-list`}
        aria-activedescendant={open && activeCode ? `${name}-${activeCode}` : undefined}
        aria-expanded={open}
        aria-haspopup='listbox'
        className='tr-select-trigger'
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
        <Flag code={value} />
        <span className='tr-select-value'>{currentName}</span>
        <ChevronDown size={13} />
      </button>
      <div
        className='tr-select-list'
        id={`${name}-list`}
        role='listbox'
        ref={listRef}
        aria-label={title}
        hidden={!open}
      >
        {langs.map((l, i) => (
          <button
            type='button'
            key={l.code}
            tabIndex={-1}
            id={`${name}-${l.code}`}
            role='option'
            aria-selected={l.code === value}
            className={`tr-select-option${l.code === value ? ' selected' : ''}${i === active ? ' active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(l.code)}
          >
            <span className='tr-select-opt-main'>
              <Flag code={l.code} />
              {l.name}
            </span>
            {l.code === value && <Check size={13} />}
          </button>
        ))}
      </div>
    </div>
  )
}

async function shrinkImageIfNeeded(dataUrl: string) {
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
  useEffect(() => {
    void preloadMarkdown()
  }, [])

  const [text, setText] = useState('')
  const [target, setTarget] = useState('zh')
  const [source, setSource] = useState('auto')
  const [model, setModel] = useState(DEFAULT_TRANSLATE_MODEL)
  const [instruction, setInstruction] = useState('')
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<'source' | 'result' | null>(null)
  const [image, setImage] = useState<TranslateImageInput | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [settings, setSettings] = useState<TranslateSettings>(DEFAULT_TRANSLATE_SETTINGS)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus>('idle')
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [modelOpen, setModelOpen] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<TranslateHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyPinnedOnly, setHistoryPinnedOnly] = useState(false)
  const [customCode, setCustomCode] = useState('')
  const [customName, setCustomName] = useState('')

  const fileRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const outRef = useRef<HTMLDivElement>(null)
  const modelAnchorRef = useRef<HTMLDivElement>(null)
  const modelPopRef = useRef<HTMLDivElement>(null)
  const modelTriggerRef = useRef<HTMLButtonElement>(null)
  const settingsHydrated = useRef(false)
  const settingsSaveSeq = useRef(0)
  const scrollSyncing = useRef(false)
  const runSeq = useRef(0)

  const targetLangs = useMemo(() => {
    const seen = new Set(TARGET_LANGS.map((l) => l.code))
    const out = [...TARGET_LANGS]
    for (const lang of settings.customLangs) {
      if (!seen.has(lang.code)) {
        seen.add(lang.code)
        out.push(lang)
      }
    }
    return out
  }, [settings.customLangs])

  const sourceLangs = useMemo(() => [SOURCE_AUTO, ...targetLangs], [targetLangs])
  const langMap = useMemo(
    () => new Map(targetLangs.map((l) => [l.code, l.name])),
    [targetLangs],
  )

  const langName = (code: string): string => {
    if (code === 'auto') return '自动判断'
    return langMap.get(code) ?? LANG_NAMES[code] ?? code
  }

  const overLimit = text.length > TRANSLATE_TEXT_MAX_CHARS
  const hardLimit = text.length > TRANSLATE_REQUEST_MAX_CHARS
  const hasInput = (!!text.trim() || !!image) && !hardLimit
  const targetName = langName(target)
  const sourceName = source === 'auto' ? '自动判断' : langName(source)
  const modelNote = TRANSLATE_MODELS.find((m) => m.id === model)?.note ?? ''
  const modelBadge = shortModel(model).split('-')[0] || 'T'

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase()
    if (!q) return TRANSLATE_MODELS
    return TRANSLATE_MODELS.filter(
      (m) => m.id.toLowerCase().includes(q) || m.note.toLowerCase().includes(q),
    )
  }, [modelSearch])
  const pinnedModels = filteredModels.filter((m) => settings.pinnedModels.includes(m.id))
  const otherModels = filteredModels.filter((m) => !settings.pinnedModels.includes(m.id))

  const visibleHistory = useMemo(() => {
    const list = historyPinnedOnly ? history.filter((h) => h.pinned) : [...history]
    return list.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.ts - a.ts)
  }, [history, historyPinnedOnly])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const loaded = await window.torra.translateSettingsLoad()
        if (!alive) return
        const codes = new Set([...TARGET_LANGS.map((l) => l.code), ...loaded.customLangs.map((l) => l.code)])
        setSettings(loaded)
        setSource(loaded.source === 'auto' || codes.has(loaded.source) ? loaded.source : 'en')
        setTarget(codes.has(loaded.target) ? loaded.target : 'zh')
        setModel(loaded.model)
        setInstruction(loaded.instruction)
      } catch {
        if (!alive) return
        setSettings(DEFAULT_TRANSLATE_SETTINGS)
      } finally {
        if (alive) settingsHydrated.current = true
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!settingsHydrated.current) return
    setSettings((s) =>
      s.model === model && s.instruction === instruction
        ? s
        : { ...s, model, instruction },
    )
  }, [model, instruction])

  useEffect(() => {
    if (!settingsHydrated.current) return
    const seq = ++settingsSaveSeq.current
    setSettingsStatus('saving')
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await window.torra.translateSettingsSave(settings)
          if (settingsSaveSeq.current === seq) setSettingsStatus('saved')
        } catch {
          if (settingsSaveSeq.current === seq) {
            setSettingsStatus('error')
            setSettingsError('设置保存失败，请稍后重试')
          }
        }
      })()
    }, 450)
    return () => window.clearTimeout(timer)
  }, [settings])

  useEffect(() => {
    if (!modelOpen) return
    const onDown = (e: MouseEvent) => {
      if (
        !modelAnchorRef.current?.contains(e.target as Node) &&
        !modelPopRef.current?.contains(e.target as Node)
      ) {
        setModelOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setModelOpen(false)
        modelTriggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [modelOpen])

  useEffect(() => {
    if (!historyOpen && !settingsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setHistoryOpen(false)
      setSettingsOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [historyOpen, settingsOpen])

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

  const loadHistory = async () => {
    setHistoryLoading(true)
    try {
      const list = await window.torra.translateHistoryLoad()
      setHistory(list ?? [])
    } catch {
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }

  useEffect(() => {
    if (historyOpen) void loadHistory()
  }, [historyOpen])

  const chooseSource = (code: string) => {
    runSeq.current += 1
    setBusy(false)
    setSource(code)
    setResult('')
    setError(null)
    setDetail(null)
    setSettings((s) => ({ ...s, source: code }))
  }

  const chooseTarget = (code: string) => {
    runSeq.current += 1
    setBusy(false)
    setTarget(code)
    setResult('')
    setError(null)
    setDetail(null)
    setSettings((s) => ({ ...s, target: code }))
  }

  const swap = () => {
    runSeq.current += 1
    setBusy(false)
    const from = source === 'auto' ? (target === 'en' ? 'zh' : 'en') : source
    setSource(target)
    setTarget(from)
    setSettings((s) => ({ ...s, source: target, target: from }))
    if (result) {
      setText(result)
      setResult(text)
    }
    setImage(null)
    setError(null)
  }

  const effectivePair = () => {
    const detected = text.trim() && settings.detectMethod !== 'llm'
      ? detectLangByScript(text)
      : 'auto'
    let effectiveSource = source
    let effectiveTarget = target

    if (source === 'auto' && detected !== 'auto') {
      effectiveSource = detected
      if (settings.bidirectional) {
        const pairSource = settings.source === 'auto' ? '' : settings.source
        const pairTarget = settings.target
        if (detected === pairTarget && pairSource && pairSource !== detected) {
          effectiveTarget = pairSource
        } else if (detected === pairSource && pairTarget && pairTarget !== detected) {
          effectiveTarget = pairTarget
        }
      }
    }

    return { detected, effectiveSource, effectiveTarget }
  }

  const run = async () => {
    if (!hasInput || busy) return
    const seq = ++runSeq.current
    setBusy(true)
    setError(null)
    setDetail(null)
    setResult('')

    const { detected, effectiveSource, effectiveTarget } = effectivePair()
    if (effectiveTarget !== target) {
      setTarget(effectiveTarget)
      setSettings((s) => ({ ...s, target: effectiveTarget }))
    }
    const effectiveTargetName = langName(effectiveTarget)
    const effectiveSourceName = effectiveSource === 'auto' ? undefined : langName(effectiveSource)
    const requestSource =
      source === 'auto'
        ? settings.detectMethod === 'algo'
          ? effectiveSource
          : 'auto'
        : source
    const customPrompt =
      settings.prompt.trim() && settings.prompt.trim() !== DEFAULT_TRANSLATE_PROMPT.trim()
        ? settings.prompt.trim()
        : undefined

    try {
      const r = await window.torra.translateText({
        text: text.trim(),
        target: effectiveTarget,
        targetName: effectiveTargetName,
        source: requestSource,
        sourceName: effectiveSourceName,
        model,
        instruction: instruction.trim(),
        glossary: settings.glossary.trim(),
        customPrompt,
        temperature: settings.temperature ?? undefined,
        topP: settings.topP ?? undefined,
        image: image ?? undefined,
      })
      if (runSeq.current !== seq) return
      if (!r.ok) {
        setError(r.reason ?? '翻译失败')
        setDetail(r.detail ?? null)
        return
      }

      setResult(r.text)
      if (settings.autoCopy && r.text) {
        try {
          await navigator.clipboard.writeText(r.text)
          setCopied('result')
          setTimeout(() => setCopied(null), 1600)
        } catch {
          // 复制失败不影响已经拿到的译文。
        }
      }

      const entry: TranslateHistoryEntry = {
        id: `th_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        source: effectiveSource === 'auto' ? 'auto' : effectiveSource,
        target: effectiveTarget,
        sourceText: text.trim() || (image ? `[图片] ${image.name}` : ''),
        resultText: r.text,
        model: r.model ?? model,
        pinned: false,
      }
      const saved = await window.torra.translateHistoryAdd(entry)
      if (saved.ok && saved.history) setHistory(saved.history)
      else if (detected !== 'auto') setHistory((prev) => [entry, ...prev])
    } catch (e) {
      if (runSeq.current === seq) setError((e as Error).message || '翻译失败')
    } finally {
      if (runSeq.current === seq) setBusy(false)
    }
  }

  const runRef = useRef<() => void>(() => {})
  runRef.current = () => void run()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || (!e.ctrlKey && !e.metaKey)) return
      if (e.altKey || e.shiftKey || e.isComposing || e.defaultPrevented || e.repeat) return
      const target = e.target instanceof Element ? e.target : null
      const textInput = target?.closest('input, textarea, [contenteditable="true"]')
      if (textInput && !textInput.classList.contains('tr-textarea')) return
      if (document.querySelector('.tr-drawer, .tr-pop, .tr-lightbox')) return
      e.preventDefault()
      runRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

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
    runSeq.current += 1
    setBusy(false)
    setText('')
    setResult('')
    setImage(null)
    setError(null)
    setDetail(null)
  }

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
        setError(`文本超过 ${TRANSLATE_REQUEST_MAX_CHARS.toLocaleString()} 字符上限`)
        return
      }
      setText(next)
      return
    }
    setError('只支持图片或文本文件；PDF / Word 请先取出其中的文字')
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDropping(false)
    const file = e.dataTransfer.files[0]
    if (file) void acceptFile(file)
  }

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

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return
      acceptClipboardImage(e)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  })

  const syncScroll = (from: HTMLElement | null, to: HTMLElement | null) => {
    if (!settings.scrollSync || !from || !to || scrollSyncing.current) return
    const sourceMax = from.scrollHeight - from.clientHeight
    const targetMax = to.scrollHeight - to.clientHeight
    if (sourceMax <= 0 || targetMax <= 0) return
    scrollSyncing.current = true
    to.scrollTop = (from.scrollTop / sourceMax) * targetMax
    window.requestAnimationFrame(() => {
      scrollSyncing.current = false
    })
  }

  const toggleModelPin = (id: string) => {
    setSettings((s) => {
      const pinned = s.pinnedModels.includes(id)
      const next = pinned
        ? s.pinnedModels.filter((x) => x !== id)
        : [id, ...s.pinnedModels.filter((x) => x !== id)].slice(0, 8)
      return { ...s, pinnedModels: next }
    })
  }

  const addCustomLang = () => {
    const code = customCode.trim().toLowerCase()
    const name = customName.trim()
    setSettingsError(null)
    if (!/^[a-z0-9_-]{1,24}$/.test(code)) {
      setSettingsError('语言代码只能使用小写字母、数字、下划线或短横线')
      return
    }
    if (!name) {
      setSettingsError('请填写语言名称')
      return
    }
    if (code === 'auto') {
      setSettingsError('auto 是自动判断的保留代码，请换一个')
      return
    }
    if (targetLangs.some((l) => l.code === code)) {
      setSettingsError('这个语言代码已经存在')
      return
    }
    if (settings.customLangs.some((l) => l.name === name)) {
      setSettingsError('这个语言名称已经存在')
      return
    }
    setSettings((s) => ({ ...s, customLangs: [...s.customLangs, { code, name }].slice(0, 30) }))
    setCustomCode('')
    setCustomName('')
  }

  const removeCustomLang = (code: string) => {
    if (source === code || target === code) {
      setSettingsError('正在使用的语言不能删除，请先切换到其他语言')
      return
    }
    setSettingsError(null)
    setSettings((s) => ({ ...s, customLangs: s.customLangs.filter((l) => l.code !== code) }))
  }

  const restoreHistory = (item: TranslateHistoryEntry) => {
    runSeq.current += 1
    setBusy(false)
    setText(item.sourceText)
    setResult(item.resultText)
    setSource(item.source || 'auto')
    setTarget(item.target || 'zh')
    setSettings((s) => ({ ...s, source: item.source || 'auto', target: item.target || 'zh' }))
    setImage(null)
    setError(null)
    setDetail(null)
    setHistoryOpen(false)
  }

  const toggleHistoryPin = async (item: TranslateHistoryEntry) => {
    const nextPinned = !item.pinned
    try {
      const r = await window.torra.translateHistoryUpdate({ id: item.id, pinned: nextPinned })
      if (r.ok && r.history) setHistory(r.history)
    } catch {
      setError('更新收藏失败')
    }
  }

  const clearHistory = async () => {
    if (!window.confirm('清空未收藏的翻译历史？收藏条目会保留。')) return
    try {
      const r = await window.torra.translateHistoryClear()
      if (r.ok) setHistory(r.history)
    } catch {
      setError('清空历史失败')
    }
  }

  const showHistory = () => {
    setModelOpen(false)
    setSettingsOpen(false)
    setHistoryOpen((v) => !v)
  }

  const showSettings = () => {
    setModelOpen(false)
    setHistoryOpen(false)
    setSettingsOpen(true)
  }

  const renderModelRow = (m: (typeof TRANSLATE_MODELS)[number]) => {
    const pinned = settings.pinnedModels.includes(m.id)
    return (
      <div key={m.id} className={`tr-model-row${model === m.id ? ' active' : ''}`}>
        <button
          type='button'
          className='tr-model-row-main'
          onClick={() => {
            setModel(m.id)
            setModelOpen(false)
          }}
          aria-pressed={model === m.id}
        >
          <span className='tr-model-logo'>{shortModel(m.id).split('-')[0]}</span>
          <span className='tr-model-row-copy'>
            <strong>{m.id}</strong>
            <small>{m.note}</small>
          </span>
          {model === m.id && <Check size={13} />}
        </button>
        <button
          type='button'
          className={`tr-icon tr-model-pin${pinned ? ' active' : ''}`}
          title={pinned ? '取消固定' : '固定到最前'}
          aria-label={pinned ? '取消固定' : '固定到最前'}
          aria-pressed={pinned}
          onClick={(e) => {
            e.stopPropagation()
            toggleModelPin(m.id)
          }}
        >
          <Pin size={13} />
        </button>
      </div>
    )
  }

  return (
    <div className={`tr-page${dropping ? ' dropping' : ''}`}>
      <div className='tr-head'>
        <div className='tr-pair'>
          <LangSelect
            className='tr-pair-select tr-select-source'
            ariaLabel='选择源语言'
            title='源语言'
            langs={sourceLangs}
            name='translate-source'
            value={source}
            onChange={chooseSource}
          />
          <button className='tr-swap' onClick={swap} title='交换源语言与目标语言' aria-label='交换语言'>
            <ArrowLeftRight size={13} />
          </button>
          <LangSelect
            className='tr-pair-select tr-select-target'
            ariaLabel='选择目标语言'
            title='目标语言'
            langs={targetLangs}
            name='translate-target'
            value={target}
            onChange={chooseTarget}
          />
        </div>

        <button
          className='tr-run'
          onClick={() => void run()}
          disabled={busy || !hasInput}
          aria-keyshortcuts='Control+Enter Meta+Enter'
          title={`翻译快捷键：${MOD_KEY}+Enter`}
        >
          {busy ? <Loader2 size={13} className='spin' /> : <Sparkles size={13} />}
          {busy ? '翻译中' : `翻译${targetName}`}
          <kbd>{MOD_KEY}+Enter</kbd>
        </button>

        <div className='tr-head-tools'>
          <div className='tr-model-anchor' ref={modelAnchorRef}>
            <button
              type='button'
              ref={modelTriggerRef}
              className={`tr-model-trigger${modelOpen ? ' active' : ''}`}
              onClick={() => {
                setModelOpen((v) => !v)
                setModelSearch('')
              }}
              aria-haspopup='dialog'
              aria-expanded={modelOpen}
              aria-label='选择翻译模型'
              title={modelNote}
            >
              <span className='tr-model-logo'>{modelBadge}</span>
              <span className='tr-model-trigger-name'>{shortModel(model)}</span>
              <ChevronDown size={12} />
            </button>
            {modelOpen && (
              <div
                className='tr-pop'
                ref={modelPopRef}
                role='dialog'
                aria-label='选择翻译模型'
              >
                <label className='tr-search'>
                  <Search size={13} />
                  <input
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder='搜索模型...'
                    aria-label='搜索模型'
                    autoFocus
                  />
                </label>
                <div className='tr-pop-body' role='group' aria-label='翻译模型'>
                  {pinnedModels.length > 0 && (
                    <>
                      <div className='tr-pop-group'>已固定</div>
                      {pinnedModels.map(renderModelRow)}
                    </>
                  )}
                  {otherModels.length > 0 && (
                    <>
                      <div className='tr-pop-group'>{pinnedModels.length > 0 ? '其他模型' : '可用模型'}</div>
                      {otherModels.map(renderModelRow)}
                    </>
                  )}
                  {filteredModels.length === 0 && <p className='tr-pop-empty'>没有匹配的模型</p>}
                </div>
                <button type='button' className='tr-pop-foot' onClick={showSettings}>
                  <Settings2 size={13} />
                  打开翻译设置
                </button>
              </div>
            )}
          </div>
          <button
            className={`tr-icon${historyOpen ? ' active' : ''}`}
            onClick={showHistory}
            title='翻译历史'
            aria-label='翻译历史'
          >
            <History size={15} />
          </button>
          <button
            className={`tr-icon${settingsOpen ? ' active' : ''}`}
            onClick={() => {
              if (settingsOpen) setSettingsOpen(false)
              else showSettings()
            }}
            title='翻译设置'
            aria-label='翻译设置'
          >
            <Settings2 size={15} />
          </button>
        </div>
      </div>

      <div className='tr-body'>
        <section className='tr-pane'>
          <div className='tr-pane-bar'>
            <span className='tr-pane-label'>
              <Flag code={source} />
              {sourceName}
            </span>
            <div className='tr-pane-tools'>
              <span className={`tr-count${overLimit ? ' over' : ''}`}>
                {text.length.toLocaleString()} / {TRANSLATE_TEXT_MAX_CHARS.toLocaleString()}
              </span>
              <button className='tr-icon' onClick={() => void copy(text, 'source')} disabled={!text} title='复制原文' aria-label='复制原文'>
                {copied === 'source' ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <button className='tr-icon' onClick={clear} disabled={!text && !result && !image} title='清空' aria-label='清空'>
                <Eraser size={14} />
              </button>
            </div>
          </div>

          <textarea
            ref={textareaRef}
            className='tr-textarea'
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => acceptClipboardImage(e)}
            onScroll={() => syncScroll(textareaRef.current, outRef.current)}
            maxLength={TRANSLATE_REQUEST_MAX_CHARS}
            placeholder='输入原文或粘贴图片...'
            spellCheck={false}
          />

          {image && (
            <div className='tr-chip-file'>
              <button className='tr-thumb' onClick={() => setPreviewing(true)} title='查看图片' aria-label='查看图片'>
                <img src={image.dataUrl} alt={image.name} />
              </button>
              <span className='tr-chip-name'>{image.name}</span>
              <span className='tr-chip-size'>
                {image.scaledFrom
                  ? `${image.scaledFrom.w}x${image.scaledFrom.h} -> ${IMAGE_MAX_EDGE}`
                  : bytesLabel(Math.round((image.dataUrl.length * 3) / 4))}
              </span>
              <button className='tr-icon' onClick={() => setImage(null)} title='移除图片' aria-label='移除图片'>
                <X size={13} />
              </button>
            </div>
          )}

          <div
            className='tr-drop'
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDropping(true)
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={onDrop}
            role='button'
            tabIndex={0}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !e.ctrlKey && !e.metaKey) {
                fileRef.current?.click()
              }
            }}
          >
            <Upload size={14} />
            <span>拖放、上传或粘贴图片 / 文本文件</span>
            <span className='tr-drop-hint'>图片直译 · PDF / Word 请先取出文字</span>
          </div>
          <input
            ref={fileRef}
            type='file'
            accept={FILE_ACCEPT}
            className='tr-file'
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void acceptFile(f)
              e.target.value = ''
            }}
          />
        </section>

        <div className='tr-divider' />

        <section className='tr-pane'>
          <div className='tr-pane-bar'>
            <span className='tr-pane-label'>
              <Flag code={target} />
              {targetName}
            </span>
            <div className='tr-pane-tools'>
              <button className='tr-icon' onClick={() => void copy(result, 'result')} disabled={!result} title='复制译文' aria-label='复制译文'>
                {copied === 'result' ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>
          {result ? (
            <div
              className='tr-out'
              ref={outRef}
              onScroll={() => syncScroll(outRef.current, textareaRef.current)}
            >
              {settings.markdownPreview ? (
                <Markdown text={result} />
              ) : (
                <pre className='tr-plain'>{result}</pre>
              )}
            </div>
          ) : (
            <div className='tr-out tr-out-empty' ref={outRef}>
              {busy ? '翻译中' : '等待翻译'}
            </div>
          )}
        </section>
      </div>

      {overLimit && (
        <p className='tr-hint warn'>
          超过单次 {TRANSLATE_TEXT_MAX_CHARS.toLocaleString()} 字上限，提交后会按自然段分批翻译并顺序拼接。
        </p>
      )}

      {previewing && image && (
        <div className='tr-lightbox' onClick={() => setPreviewing(false)}>
          <img src={image.dataUrl} alt={image.name} onClick={(e) => e.stopPropagation()} />
          <button className='tr-icon tr-lightbox-close' onClick={() => setPreviewing(false)} title='关闭预览' aria-label='关闭预览'>
            <X size={14} />
          </button>
        </div>
      )}

      {error && (
        <div className='tr-error'>
          <TriangleAlert size={14} />
          <div>
            <div className='tr-error-title'>{error}</div>
            {detail && <div className='tr-error-detail'>{detail}</div>}
          </div>
        </div>
      )}

      <p className='tr-foot'>
        走哔哩哔哩 Index-Translate 免费公开接口，无需 API Key。内容会直接发到该端点，请勿粘贴不宜外发的材料。
      </p>

      {historyOpen && (
        <div
          className='tr-drawer'
          role='dialog'
          aria-modal='true'
          aria-label='翻译历史'
          onClick={(e) => e.stopPropagation()}
        >
          <div className='tr-drawer-head'>
            <span className='tr-drawer-title'>
              <History size={16} />
              翻译历史 <span>({history.length})</span>
            </span>
            <div className='tr-drawer-tools'>
              <button
                type='button'
                className={`tr-icon${historyPinnedOnly ? ' active' : ''}`}
                onClick={() => setHistoryPinnedOnly((v) => !v)}
                title='只看收藏'
                aria-label='只看收藏'
                aria-pressed={historyPinnedOnly}
              >
                <Star size={14} />
              </button>
              <button
                type='button'
                className='tr-icon'
                onClick={() => void clearHistory()}
                disabled={history.length === 0 || history.every((h) => h.pinned)}
                title='清空未收藏的历史'
                aria-label='清空未收藏的历史'
              >
                <Trash2 size={14} />
              </button>
              <button type='button' className='tr-icon' onClick={() => setHistoryOpen(false)} title='关闭' aria-label='关闭历史'>
                <X size={14} />
              </button>
            </div>
          </div>
          <div className='tr-hist-list'>
            {historyLoading ? (
              <p className='tr-drawer-empty'><Loader2 size={14} className='spin' /> 加载中...</p>
            ) : visibleHistory.length === 0 ? (
              <p className='tr-drawer-empty'>
                {historyPinnedOnly ? '还没有收藏的翻译' : '暂无翻译记录'}
              </p>
            ) : (
              visibleHistory.map((item) => (
                <div
                  key={item.id}
                  className={`tr-hist-item${item.pinned ? ' pinned' : ''}`}
                  role='button'
                  tabIndex={0}
                  onClick={() => restoreHistory(item)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      restoreHistory(item)
                    }
                  }}
                >
                  <div className='tr-hist-meta'>
                    <span className='tr-hist-langs'>
                      <Flag code={item.source || 'auto'} />
                      <span>{item.source === 'auto' ? '未知' : langName(item.source)}</span>
                      <span>→</span>
                      <Flag code={item.target} />
                      <span>{langName(item.target)}</span>
                    </span>
                    <time>{formatHistoryTs(item.ts)}</time>
                    <button
                      type='button'
                      className={`tr-icon tr-hist-star${item.pinned ? ' active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        void toggleHistoryPin(item)
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                      title={item.pinned ? '取消收藏' : '收藏'}
                      aria-label={item.pinned ? '取消收藏' : '收藏'}
                    >
                      <Star size={13} />
                    </button>
                  </div>
                  <div className='tr-hist-src'>{item.sourceText || '（图片翻译）'}</div>
                  <div className='tr-hist-dst'>{item.resultText}</div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {settingsOpen && (
        <div
          className='tr-drawer'
          role='dialog'
          aria-modal='true'
          aria-label='翻译设置'
          onClick={(e) => e.stopPropagation()}
        >
          <div className='tr-drawer-head'>
            <span className='tr-drawer-title'>
              <Settings2 size={16} />
              翻译设置
            </span>
            <div className='tr-drawer-tools'>
              <span className='tr-saved'>
                {settingsStatus === 'saving' ? '保存中...' : settingsStatus === 'saved' ? '已保存' : settingsStatus === 'error' ? '保存失败' : ''}
              </span>
              <button type='button' className='tr-icon' onClick={() => setSettingsOpen(false)} title='关闭' aria-label='关闭设置'>
                <X size={14} />
              </button>
            </div>
          </div>
          <div className='tr-set-body'>
            <section className='tr-set-sec'>
              <div className='tr-set-title'>基础设置</div>
              <ToggleRow
                label='Markdown 预览'
                hint='关闭后译文按纯文本显示'
                checked={settings.markdownPreview}
                onChange={(v) => setSettings((s) => ({ ...s, markdownPreview: v }))}
              />
              <ToggleRow
                label='翻译完成后自动复制'
                checked={settings.autoCopy}
                onChange={(v) => setSettings((s) => ({ ...s, autoCopy: v }))}
              />
              <ToggleRow
                label='滚动同步设置'
                hint='原文和译文按滚动比例同步'
                checked={settings.scrollSync}
                onChange={(v) => setSettings((s) => ({ ...s, scrollSync: v }))}
              />
              <div className='tr-toggle-row'>
                <div className='tr-toggle-copy'>
                  <span>自动检测方法</span>
                  <small>自动和算法会在本地快速判断，LLM 交给模型判断</small>
                </div>
                <div className='tr-seg' role='group' aria-label='自动检测方法'>
                  {(Object.keys(DETECT_METHOD_LABEL) as DetectMethod[]).map((method) => (
                    <button
                      type='button'
                      key={method}
                      className={settings.detectMethod === method ? 'on' : ''}
                      onClick={() => setSettings((s) => ({ ...s, detectMethod: method }))}
                      aria-pressed={settings.detectMethod === method}
                    >
                      {DETECT_METHOD_LABEL[method]}
                    </button>
                  ))}
                </div>
              </div>
              <ToggleRow
                label='双向翻译设置'
                hint='原文自动识别为目标语言时，反向翻译回源语言'
                checked={settings.bidirectional}
                onChange={(v) => setSettings((s) => ({ ...s, bidirectional: v }))}
              />
              {settings.bidirectional && (
                <div className='tr-bi-row'>
                  <LangSelect
                    className='tr-select-bi-source'
                    ariaLabel='双向翻译源语言'
                    title='双向翻译源语言'
                    langs={sourceLangs}
                    name='translate-bi-source'
                    value={settings.source}
                    onChange={(code) => setSettings((s) => ({ ...s, source: code }))}
                  />
                  <ArrowLeftRight size={13} />
                  <LangSelect
                    className='tr-select-bi-target'
                    ariaLabel='双向翻译目标语言'
                    title='双向翻译目标语言'
                    langs={targetLangs}
                    name='translate-bi-target'
                    value={settings.target}
                    onChange={(code) => setSettings((s) => ({ ...s, target: code }))}
                  />
                </div>
              )}
            </section>

            <section className='tr-set-sec'>
              <div className='tr-set-title'>模型参数</div>
              <div className='tr-param'>
                <div className='tr-param-head'>
                  <span>模型温度</span>
                  <span className='tr-default'>模型默认</span>
                  <button
                    type='button'
                    role='switch'
                    aria-label='启用模型温度'
                    aria-checked={settings.temperature !== null}
                    className={`tr-switch${settings.temperature !== null ? ' on' : ''}`}
                    onClick={() => setSettings((s) => ({
                      ...s,
                      temperature: s.temperature === null ? 0.7 : null,
                    }))}
                  >
                    <span />
                  </button>
                </div>
                {settings.temperature !== null && (
                  <div className='tr-param-row'>
                    <input
                      type='range'
                      min={0}
                      max={2}
                      step={0.1}
                      value={settings.temperature}
                      onChange={(e) => setSettings((s) => ({ ...s, temperature: Number(e.target.value) }))}
                      aria-label='模型温度数值'
                    />
                    <output>{settings.temperature.toFixed(1)}</output>
                  </div>
                )}
              </div>
              <div className='tr-param'>
                <div className='tr-param-head'>
                  <span>Top-P</span>
                  <span className='tr-default'>模型默认</span>
                  <button
                    type='button'
                    role='switch'
                    aria-label='启用 Top-P'
                    aria-checked={settings.topP !== null}
                    className={`tr-switch${settings.topP !== null ? ' on' : ''}`}
                    onClick={() => setSettings((s) => ({
                      ...s,
                      topP: s.topP === null ? 0.9 : null,
                    }))}
                  >
                    <span />
                  </button>
                </div>
                {settings.topP !== null && (
                  <div className='tr-param-row'>
                    <input
                      type='range'
                      min={0}
                      max={1}
                      step={0.05}
                      value={settings.topP}
                      onChange={(e) => setSettings((s) => ({ ...s, topP: Number(e.target.value) }))}
                      aria-label='Top-P 数值'
                    />
                    <output>{settings.topP.toFixed(2)}</output>
                  </div>
                )}
              </div>
              <p className='tr-set-hint'>关闭参数开关时使用模型默认值；开启后本次翻译会显式传入温度与 Top-P。</p>
            </section>

            <section className='tr-set-sec'>
              <div className='tr-set-title'>
                <span>翻译提示词</span>
                <button
                  type='button'
                  className='tr-link'
                  onClick={() => setSettings((s) => ({ ...s, prompt: DEFAULT_TRANSLATE_PROMPT }))}
                >
                  恢复默认
                </button>
              </div>
              <textarea
                className='tr-set-textarea'
                value={settings.prompt}
                onChange={(e) => setSettings((s) => ({ ...s, prompt: e.target.value }))}
                maxLength={TRANSLATE_PROMPT_FIELD_MAX_CHARS}
                spellCheck={false}
                aria-label='翻译提示词'
              />
              <p className='tr-set-hint'>
                支持 <code>{'{{target_language}}'}</code>、<code>{'{{source_language}}'}</code> 和{' '}
                <code>{'<<translate_input>>'}</code> 占位符。
              </p>
              <div className='tr-set-field'>
                <span>术语对照</span>
                <input
                  className='tr-set-input'
                  type='text'
                  value={settings.glossary}
                  onChange={(e) => setSettings((s) => ({ ...s, glossary: e.target.value }))}
                  maxLength={TRANSLATE_PROMPT_FIELD_MAX_CHARS}
                  placeholder='例如：碳纤维→carbon fiber，抗裂缝→crack resistance'
                />
              </div>
              <div className='tr-set-field'>
                <span>额外指令</span>
                <textarea
                  className='tr-set-textarea'
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  maxLength={TRANSLATE_PROMPT_FIELD_MAX_CHARS}
                  placeholder='例如：保留原有换行结构；语气正式一些'
                  spellCheck={false}
                />
              </div>
            </section>

            <section className='tr-set-sec'>
              <div className='tr-set-title'>
                <span>自定义语言</span>
                <span className='tr-saved'>{settings.customLangs.length} 个</span>
              </div>
              {settings.customLangs.length === 0 ? (
                <div className='tr-lang-empty'>暂无自定义语言</div>
              ) : (
                <div className='tr-lang-list'>
                  {settings.customLangs.map((lang) => (
                    <span className='tr-lang-chip' key={lang.code}>
                      <Flag code={lang.code} />
                      <span>{lang.name}</span>
                      <button
                        type='button'
                        onClick={() => removeCustomLang(lang.code)}
                        title={`删除 ${lang.name}`}
                        aria-label={`删除 ${lang.name}`}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <form
                className='tr-lang-form'
                onSubmit={(e) => {
                  e.preventDefault()
                  addCustomLang()
                }}
              >
                <input
                  value={customCode}
                  onChange={(e) => setCustomCode(e.target.value)}
                  placeholder='代码，如 fr'
                  maxLength={24}
                  aria-label='自定义语言代码'
                />
                <input
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder='显示名称'
                  maxLength={40}
                  aria-label='自定义语言名称'
                />
                <button type='submit' className='tr-lang-add-btn'>
                  <Plus size={11} />
                  添加
                </button>
              </form>
              {settingsError && <p className='tr-set-error'>{settingsError}</p>}
            </section>
          </div>
        </div>
      )}

      {(historyOpen || settingsOpen) && (
        <div
          className='tr-scrim'
          onClick={() => {
            setHistoryOpen(false)
            setSettingsOpen(false)
          }}
        />
      )}
    </div>
  )
}

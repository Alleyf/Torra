import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DISCUSSION_TRANSLATION_INSTRUCTION,
  shouldTranslateDiscussionSpeech,
} from '@shared/translate'

/**
 * 研讨发言的译文缓存。
 *
 * 正文卡和右栏会同时显示同一条发言；缓存与 in-flight 表让两边共用一次请求，
 * 而不是一次点击翻译两遍。缓存只活到本次启动，原文始终是唯一落账的数据。
 */
const CACHE_MAX = 120
const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()

function keyOf(id: string, text: string): string {
  return `${id}\u0000${text}`
}

function remember(key: string, text: string): void {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, text)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function translationOf(key: string, text: string): Promise<string> {
  const hit = cache.get(key)
  if (hit !== undefined) {
    // LRU：命中后挪到队尾，长会话里反复读的旧发言不会被新卡挤掉。
    remember(key, hit)
    return Promise.resolve(hit)
  }

  const running = inflight.get(key)
  if (running) return running

  const job = (async () => {
    const r = await window.torra.translateText({
      text,
      target: 'zh',
      instruction: DISCUSSION_TRANSLATION_INSTRUCTION,
    })
    if (!r.ok) throw new Error(r.reason || '翻译失败')
    const out = r.text.trim()
    if (!out) throw new Error('翻译结果为空')
    remember(key, out)
    return out
  })().finally(() => inflight.delete(key))

  inflight.set(key, job)
  return job
}

export interface UtteranceTranslation {
  /** 这条发言是否属于「非中文正文」，需要提供译文入口 */
  eligible: boolean
  /** 正在请求译文 */
  busy: boolean
  /** 自动请求失败；保留原文，可手动重试 */
  failed: boolean
  translated: string
  showTranslated: boolean
  toggle: () => void
  retry: () => void
}

/**
 * 研讨发言的内嵌翻译状态。
 *
 * 流式期间不翻：半句话既判断不准，也会把同一请求打很多次。发言收尾后仅对
 * 非中文正文自动翻译一次；中文、人工发言和缺席占位一律不碰。
 */
export function useUtteranceTranslation(input: {
  id: string
  text: string
  streaming?: boolean
  absent?: boolean
  human?: boolean
}): UtteranceTranslation {
  const { id, text, streaming, absent, human } = input
  const key = keyOf(id, text)
  /**
   * 判定要 memo：逐字流期间每 60ms 一次重渲染，而一次判定要扫整条发言的正则。
   * 文本没变就不重算。
   */
  const eligible = useMemo(
    () =>
      !human && !absent && !streaming && shouldTranslateDiscussionSpeech(text),
    [human, absent, streaming, text],
  )

  const [translated, setTranslated] = useState(() => cache.get(key) ?? '')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [showTranslated, setShowTranslated] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(
    async (alive: () => boolean) => {
      setBusy(true)
      setFailed(false)
      try {
        const out = await translationOf(key, text)
        if (!alive()) return
        setTranslated(out)
        setShowTranslated(true)
      } catch {
        if (!alive()) return
        setFailed(true)
        setShowTranslated(false)
      } finally {
        if (alive()) setBusy(false)
      }
    },
    [key, text],
  )

  useEffect(() => {
    const hit = cache.get(key)
    setTranslated(hit ?? '')
    setBusy(false)
    setFailed(false)
    setShowTranslated(!!hit && eligible)
    if (!eligible || hit !== undefined) return

    let active = true
    void load(() => active)
    return () => {
      active = false
    }
  }, [eligible, key, load])

  const toggle = useCallback(() => {
    setShowTranslated((v) => !v)
  }, [])

  const retry = useCallback(() => {
    if (!eligible) return
    void load(() => mounted.current)
  }, [eligible, load])

  return {
    eligible,
    busy,
    failed,
    translated,
    showTranslated,
    toggle,
    retry,
  }
}

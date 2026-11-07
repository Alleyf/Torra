/**
 * 回放时「第 r 轮为止」的那一份台账。
 *
 * 中央三视图与右栏都从这里取数：只要它们各截各的，就会出现「图回到 R1、右栏还列着 R3 的结论」
 * 这种对不上的画面。截断规则本身在 `labReplay.ts`（纯函数、离线可测），这里只做接线。
 *
 * 一条纪律：`replay` 为 null 时所有数组**保持原引用**（`asOfRound` 直接返回入参），
 * 于是回放结束不会让整张图白重排一次。
 */
import { useMemo } from 'react'
import { useStore } from '../store'
import { buildArgumentMap } from '@shared/argmap'
import { asOfBorn, asOfRound, replayMaxOf } from '../labReplay'
import { useLabView } from './labView'

export function useLabAsOf() {
  const replay = useLabView().replay
  const allUtterances = useStore((s) => s.utterances)
  const allConsensus = useStore((s) => s.consensus)
  const allDisputes = useStore((s) => s.disputes)

  const utterances = useMemo(() => asOfRound(allUtterances, replay), [allUtterances, replay])
  const consensus = useMemo(
    () => asOfBorn(allConsensus, replay, (c) => c.confirmedRound ?? null),
    [allConsensus, replay],
  )
  const disputes = useMemo(
    () => asOfBorn(allDisputes, replay, (d) => d.openedRound ?? null),
    [allDisputes, replay],
  )

  const argmap = useMemo(
    () => buildArgumentMap({ consensus, disputes, utterances }),
    [consensus, disputes, utterances],
  )

  /**
   * 回放的上限取「全量」里最远的一轮：截断后的数组在游标停在第 1 轮时只到 1，
   * 拿它当上限，走针第一格就把自己停掉了。
   */
  const maxRound = useMemo(
    () =>
      replayMaxOf([
        ...allUtterances.map((u) => u.round),
        ...allConsensus.map((c) => c.confirmedRound ?? 0),
        ...allDisputes.map((d) => d.openedRound ?? 0),
      ]),
    [allUtterances, allConsensus, allDisputes],
  )

  return { replay, utterances, consensus, disputes, argmap, maxRound }
}

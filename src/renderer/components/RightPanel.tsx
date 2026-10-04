import { useState } from 'react'
import { useStore, type ModelSummary } from '../store'
import { ConsensusPanel } from './ConsensusPanel'
import { TopicEvolution } from './TopicEvolution'

/**
 * 右栏外壳：演化视图与共识视图共用一条栏，
 * 演化视图需要更宽的画布，所以切到它时整栏加宽。
 */
export function RightPanel({ models }: { models: ModelSummary[] }) {
  const [tab, setTab] = useState<'evolve' | 'consensus'>('evolve')
  const consensus = useStore((s) => s.consensus)
  const disputes = useStore((s) => s.disputes)
  const n = consensus.length + disputes.filter((d) => d.status === 'open').length

  return (
    <div className={`consensus-panel right-panel${tab === 'evolve' ? ' wide' : ''}`}>
      <div className="rp-tabs">
        <button
          className={`rp-tab${tab === 'evolve' ? ' active' : ''}`}
          onClick={() => setTab('evolve')}
        >
          论题演化
        </button>
        <button
          className={`rp-tab${tab === 'consensus' ? ' active' : ''}`}
          onClick={() => setTab('consensus')}
        >
          共识结果
          {n > 0 && <span className="rp-count">{n}</span>}
        </button>
      </div>
      <div className="rp-body">
        {tab === 'evolve' ? <TopicEvolution models={models} /> : <ConsensusPanel models={models} />}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useStore, type ModelSummary } from '../store'
import { ConsensusPanel } from './ConsensusPanel'
import { TopicEvolution } from './TopicEvolution'

/**
 * 右栏外壳：演化视图与共识视图共用一条栏，
 * 演化视图需要更宽的画布，所以切到它时整栏加宽。
 *
 * 锁定项（pinned）挂在这里而不是演化视图内部：共识卡上点「定位」要跨到另一页
 * 把图上那条线亮出来，而切页会把子组件卸掉 —— 状态放子组件里，一跳就没了。
 */
export function RightPanel({ models }: { models: ModelSummary[] }) {
  const [tab, setTab] = useState<'evolve' | 'consensus'>('evolve')
  const [pinned, setPinned] = useState<string | null>(null)
  const consensus = useStore((s) => s.consensus)
  const disputes = useStore((s) => s.disputes)
  const n = consensus.length + disputes.filter((d) => d.status === 'open').length

  /** 从结论跳到过程：亮图上的发言/落点，必然要切到演化页 */
  const locate = (id: string) => {
    setPinned(id)
    setTab('evolve')
  }

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
        {tab === 'evolve' ? (
          <TopicEvolution models={models} pinned={pinned} onPin={setPinned} />
        ) : (
          <ConsensusPanel models={models} onLocate={locate} />
        )}
      </div>
    </div>
  )
}

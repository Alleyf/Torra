import { useState } from 'react'
import { useStore, type ModelSummary } from '../store'
import { ArgumentMap } from './ArgumentMap'
import { ConsensusPanel } from './ConsensusPanel'
import { TopicEvolution } from './TopicEvolution'

/**
 * 右栏外壳：过程、结论结构、结论账本各一屏，共用一条栏。
 *
 * 「论题演化」和「论证地图」要加宽 —— 前者是画布，后者的轮次轴按整场轮数分格，
 * 窄栏里一格放不下一个字；结论台账是纯文档流，窄栏反而读得下去。
 *
 * 地图与台账不重复：台账逐条记账，看的是「每条留下了什么」；地图把同一批判断
 * 按状态摆到轮次轴上，看的是「这条横跨了几轮、这一档总共几条」—— 这个差别
 * 只有位置能一眼说清，写进台账的轮次行就只是又一串数字。
 * 两屏共用 @shared/argmap 的投影，界面口径不会分叉。
 *
 * 锁定项（pinned）挂在这里而不是演化视图内部：结论卡上点「定位」要跨到另一页
 * 把图上那条线亮出来，而切页会把子组件卸掉 —— 状态放子组件里，一跳就没了。
 */
export function RightPanel({ models }: { models: ModelSummary[] }) {
  const [tab, setTab] = useState<'evolve' | 'map' | 'ledger'>('evolve')
  const [pinned, setPinned] = useState<string | null>(null)
  const consensus = useStore((s) => s.consensus)
  const disputes = useStore((s) => s.disputes)
  const n = consensus.length + disputes.length

  /** 从结论跳到过程：亮图上的发言/落点，必然要切到演化页 */
  const locate = (id: string) => {
    setPinned(id)
    setTab('evolve')
  }

  return (
    <div className={`consensus-panel right-panel${tab === 'ledger' ? '' : ' wide'}`}>
      <div className="rp-tabs">
        <button
          className={`rp-tab${tab === 'evolve' ? ' active' : ''}`}
          onClick={() => setTab('evolve')}
        >
          论题演化
        </button>
        <button
          className={`rp-tab${tab === 'map' ? ' active' : ''}`}
          onClick={() => setTab('map')}
        >
          论证地图
          {n > 0 && <span className="rp-count">{n}</span>}
        </button>
        <button
          className={`rp-tab${tab === 'ledger' ? ' active' : ''}`}
          onClick={() => setTab('ledger')}
        >
          结论台账
          {n > 0 && <span className="rp-count">{n}</span>}
        </button>
      </div>
      <div className="rp-body">
        {tab === 'evolve' ? (
          <TopicEvolution models={models} pinned={pinned} onPin={setPinned} />
        ) : tab === 'map' ? (
          <ArgumentMap models={models} onLocate={locate} />
        ) : (
          <ConsensusPanel models={models} onLocate={locate} />
        )}
      </div>
    </div>
  )
}


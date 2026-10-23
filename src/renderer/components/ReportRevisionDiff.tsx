import { Layers } from 'lucide-react'
import type { ReportRevisionDiff } from '@shared/report-model'
import { plainMd } from '../textFormat'

/**
 * 版本变化面板：把"重新生成后到底改了什么"说清楚。
 *
 * 只看增删不够 —— 同名行动改了负责人、决策被改写但条数不变，
 * 都会被误报成"与上一版一致"，所以这里同时比较字段级内容。
 */
export function RevisionDiffPanel({ diff, n }: { diff: ReportRevisionDiff; n?: string }) {
  const groups = [
    { title: '新增的结论', items: diff.addedClaims, tone: 'ok' as const },
    { title: '消失的结论', items: diff.removedClaims, tone: 'bad' as const },
    { title: '新增的分歧', items: diff.addedDisputes, tone: 'warn' as const },
    { title: '消解的分歧', items: diff.removedDisputes, tone: 'ok' as const },
    { title: '新增的行动', items: diff.addedActions, tone: 'ok' as const },
    { title: '移除的行动', items: diff.removedActions, tone: 'bad' as const },
    { title: '新增的决策', items: diff.addedDecisions, tone: 'ok' as const },
    { title: '消失的决策', items: diff.removedDecisions, tone: 'bad' as const },
  ].filter((g) => g.items.length > 0)

  const changed =
    diff.verdictChanged ||
    diff.headlineChanged ||
    diff.decisionChanged ||
    diff.actionFieldsChanged ||
    groups.length > 0

  const when = (ms: number) => new Date(ms).toLocaleString('zh-CN')

  return (
    <div className="rw-block">
      <header className="rw-block-head">
        <span className="rw-block-n">{n ?? ""}</span>
        <div>
          <h3>本次重生成的变化</h3>
          <p>同一份讨论记录重新生成后，与上一版的差异</p>
        </div>
      </header>

      <div className="rw-diff-head">
        <span className="rw-chip">
          <Layers size={11} /> 上一版 {when(diff.previous.generatedAt)}
        </span>
        <span className="rw-chip on">当前版 {when(diff.current.generatedAt)}</span>
        {diff.verdictChanged && (
          <span className="rw-chip warn">
            结论强度：{LEVEL_LABEL[diff.previous.verdictLevel]} → {LEVEL_LABEL[diff.current.verdictLevel]}
          </span>
        )}
        {diff.headlineChanged && <span className="rw-chip warn">结论标题已改写</span>}
        {diff.decisionChanged && (
          <span className="rw-chip warn">
            决策变化 {diff.previousDecisions.length} 条 → {diff.currentDecisions.length} 条
          </span>
        )}
        {diff.actionFieldsChanged && <span className="rw-chip warn">行动字段被改写</span>}
        {!changed && <span className="rw-chip on">与上一版完全一致</span>}
      </div>

      {diff.headlineChanged && (
        <div className="rw-diff-rewrite">
          <div className="rw-diff-col tone-bad">
            <b>上一版结论</b>
            <p>{plainMd(diff.previous.headline) || '未记录'}</p>
          </div>
          <div className="rw-diff-col tone-ok">
            <b>当前结论</b>
            <p>{plainMd(diff.current.headline) || '未记录'}</p>
          </div>
        </div>
      )}

      {diff.actionChanges.length > 0 && (
        <div className="rw-blind">
          <span className="rw-risks-title">同一行动的字段改写</span>
          <ul>
            {diff.actionChanges.map((x, i) => (
              <li key={i}>{plainMd(x)}</li>
            ))}
          </ul>
        </div>
      )}

      {groups.length > 0 && (
        <div className="rw-diff-grid">
          {groups.map((g) => (
            <div key={g.title} className={`rw-diff-col tone-${g.tone}`}>
              <b>
                {g.title} <span>{g.items.length}</span>
              </b>
              <ul>
                {g.items.map((x, i) => (
                  <li key={i}>{plainMd(x)}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {!changed && (
        <p className="rw-muted">
          内容没有变化。想看到不同结论，需要改动原始发言、共识台账或分歧处置后重生成。
        </p>
      )}
    </div>
  )
}

const LEVEL_LABEL: Record<string, string> = {
  strong: '强度较高',
  qualified: '有条件成立',
  weak: '仅供参考',
  none: '未形成结论',
}

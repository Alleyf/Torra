/**
 * 研讨报告的成稿渲染（自包含单文件 HTML）。
 *
 * 为什么另写一份，而不是继续把屏幕上的报告 DOM 抄下来（renderer/reportExport.ts）：
 * 屏幕上的报告是**工作台**——它带着应用的主题、折叠交互、重新生成按钮，
 * 一长串附录和证据链全都铺在一条竖向流里。把它原样装进文件，读者拿到的是一份
 * 深色界面的截图，而不是一份能读、能打印、能转发的报告。
 *
 * 这份渲染器只做一件事：把同一个 Report 对象按**读的顺序**重排成一份纸。
 *   - 第一屏只给结论、置信度与关键数字；
 *   - 第二屏给决定与依据最强的几条判断；
 *   - 分歧、盲点紧随其后；
 *   - 问题台账、逐轮进程、参与度、核验、账目进末尾附录。
 * 同一个事实只印一次，正文不再复述附录里的表格。
 *
 * 约束（与 reportToMarkdown 同一套口径）：
 *   - 纯函数、不联网、不读磁盘；字体全部用系统栈，离线打开不缺字；
 *   - 不含 <script>、外链样式与图片，导出的文件在任何机器上都是同一份；
 *   - 模型写的文字一律转义后再进标记，报告的正文不是可信 HTML。
 */

import type { Report, ReportDecision, ReportEvidence, Topic } from '../../shared/types'
import { TIER_META, answerDigest, judgmentTier, runFigures } from '../../shared/report-shape'
import { actionItemsFor, buildClaims, buildDecisions, rankClaims, type ReportClaimView } from '../../shared/report-model'
import { clip, stripReportNoise } from '../../shared/report-text'

const LEVEL_LABEL: Record<Report['verdict']['level'], { label: string; tone: string }> = {
  strong: { label: '强', tone: 'strong' },
  qualified: { label: '有条件', tone: 'qualified' },
  weak: { label: '弱', tone: 'weak' },
  none: { label: '无结论', tone: 'none' },
}

/** 正文里最多展开几条判断：其余进附录的判断清单，避免首页被一堵墙盖住 */
const LEAD_CLAIMS = 6
/** 每条判断最多引几段原文：再多就变成发言记录，不是报告 */
const EVIDENCE_PER_CLAIM = 2
/** 单段摘录的字数上限：模型爱写整段，报告只需要能对上原话的那一句 */
const QUOTE_LIMIT = 110

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 模型正文 → 可读段落。保留换行结构，但把每一段都当纯文本转义。 */
function paras(text: string | null | undefined): string {
  const body = stripReportNoise(text)
  if (!body) return ''
  return body
    .split(/\n{2,}|(?<=。)\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap(chunkParagraph)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('')
}

/**
 * 一大坨却只有一个换行的摘要读起来最难受 —— 按句读切到 ~160 字一段。
 * 只切全角句末标点,不碰英文句点,免得切碎 DOI、小数与缩写。
 */
function chunkParagraph(p: string): string[] {
  if (p.length <= 200) return [p]
  const sentences = p.split(/(?<=[。！？；])/).filter((s) => s.trim().length > 0)
  const out: string[] = []
  let buf = ''
  for (const s of sentences) {
    if (buf && buf.length + s.length > 160) {
      out.push(buf)
      buf = s
    } else {
      buf += s
    }
  }
  if (buf) out.push(buf)
  return out
}
/**
 * 摘要与终局答案的第一句常常是「围绕「整道题」的……」—— 题目已经印在封面，
 * 正文里再印一遍，第一屏就等于全是复读。这里只在引号段**开头**时动手
 * （前面最多一个「围绕」），把它连同它后面那个「的」一起去掉。
 * 只按字面匹配整题：题目被改写过就一行都不动，宁可重复也不去猜原文。
 */
function stripLeadQuestion(text: string, title: string): string {
  if (!text || !title) return text
  const quoted = `「${title}」`
  if (!text.startsWith(quoted) && !text.startsWith(`围绕${quoted}`)) return text
  const re = new RegExp(`^(围绕)?「${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}」的?`)
  return text.replace(re, '').replace(/\s{2,}/g, ' ').trim()
}


/* 摘录只在这一处进文档：clip 对齐到标点边界，再整体转义 */

function list(items: Array<string | null | undefined>, cls = ''): string {
  const rows = items.map((x) => stripReportNoise(x ?? '')).filter(Boolean)
  if (rows.length === 0) return ''
  return `<ul${cls ? ` class="${cls}"` : ''}>${rows.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
}

function fmtDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未记录时间'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const left = s % 60
  return left ? `${m} 分 ${left} 秒` : `${m} 分`
}

function meter(value: number, max = 100): string {
  const pct = Math.max(0, Math.min(100, Math.round((value / Math.max(1, max)) * 100)))
  return `<span class="meter" aria-hidden="true"><i style="width:${pct}%"></i></span>`
}

function chips(items: Array<{ text: string; cls?: string }>): string {
  const rows = items.filter((x) => x.text)
  if (rows.length === 0) return ''
  return `<div class="chips">${rows
    .map((x) => `<span class="chip${x.cls ? ` ${x.cls}` : ''}">${esc(x.text)}</span>`)
    .join('')}</div>`
}

function evidenceLines(ev: ReportEvidence[], own = false): string {
  const rows = ev.slice(0, EVIDENCE_PER_CLAIM)
  if (rows.length === 0) {
    return `<p class="muted small">${own ? '这一条没有登记原文依据（只有主持写下的判断本身）。' : '没有登记原文依据。'}</p>`
  }
  const more = ev.length - rows.length
  return `<ul class="quotes">${rows
    .map(
      (e) =>
        `<li><span class="who">R${esc(e.round)} · ${esc(e.displayName)}</span>${esc(clip(stripReportNoise(e.quote), QUOTE_LIMIT))}</li>`,
    )
    .join('')}${more > 0 ? `<li class="muted">此外还有 ${more} 段原文，见会话存档。</li>` : ''}</ul>`
}

function sectionHead(no: number | string, title: string, note?: string): string {
  return `<header class="sec-head"><span class="sec-no">${esc(no)}</span><h2>${esc(title)}</h2>${
    note ? `<p class="sec-note">${esc(note)}</p>` : ''
  }</header>`
}

/** 往返失败的轮次：这些轮没有小结，报告要自己承认，而不是让读者对着空章节猜 */
function moderatorGapRounds(r: Report): number[] {
  const gaps = new Set<number>()
  for (const stage of r.stageTimings ?? []) {
    if (stage.stage !== 'moderator') continue
    if (/通过/.test(stage.summary)) continue
    gaps.add(stage.round)
  }
  return [...gaps].sort((a, b) => a - b)
}

function claimCard(c: ReportClaimView, index: number): string {
  const tier = judgmentTier(c.raw)
  const meta = TIER_META[tier]
  const supporters = c.supporters.slice(0, 6)
  const hard =
    typeof c.hardness === 'number' ? `证据硬度 ${c.hardness.toFixed(2)}` : '证据硬度未记录'
  return `<article class="claim tier-${tier}">
  <div class="claim-top">
    <span class="tier">${esc(meta.label)}</span>
    <span class="claim-no">${index}</span>
    <h3>${esc(clip(stripReportNoise(c.claim), 120))}</h3>
  </div>
  <div class="claim-meta">
    ${meter(c.confidence, 1)}
    <span>${c.supporters.length} 家认同</span>
    <span>${esc(hard)}</span>
    ${c.crossExamined ? '<span>经对手质询</span>' : ''}
    ${c.verifiedSupportRate < 100 ? `<span>可核对支持 ${esc(c.verifiedSupportRate)}%</span>` : ''}
  </div>
  <p class="claim-body">${esc(clip(stripReportNoise(c.note), 220))}</p>
  ${supporters.length ? `<p class="small muted">支持：${supporters.map(esc).join('、')}</p>` : ''}
  ${evidenceLines(c.evidence, true)}
</article>`
}

function decisionCard(d: ReportDecision, index: number): string {
  const rows: string[] = []
  if (d.premises.length) rows.push(`<div><dt>前提</dt><dd>${list(d.premises)}</dd></div>`)
  if (d.costs.length) rows.push(`<div><dt>代价</dt><dd>${list(d.costs)}</dd></div>`)
  if (d.actions.length) rows.push(`<div><dt>动作</dt><dd>${list(d.actions)}</dd></div>`)
  return `<article class="decision">
  <div class="decision-top"><span class="claim-no">${index}</span><h3>${esc(stripReportNoise(d.decision))}</h3></div>
  ${rows.length ? `<dl class="decision-rows">${rows.join('')}</dl>` : ''}
</article>`
}

function claimInventory(claims: ReportClaimView[]): string {
  if (claims.length === 0) return ''
  return `<table class="table">
  <thead><tr><th>#</th><th>判断</th><th>档位</th><th>认同</th><th>硬度</th><th>轮次</th></tr></thead>
  <tbody>${claims
    .map(
      (c, i) => `<tr>
    <td class="num">${i + 1}</td>
    <td>${esc(clip(stripReportNoise(c.claim), 90))}</td>
    <td>${esc(TIER_META[judgmentTier(c.raw)].label)}</td>
    <td class="num">${c.supporters.length}</td>
    <td class="num">${c.hardness === null ? '—' : c.hardness.toFixed(2)}</td>
    <td class="num">${esc((c.sourceRounds ?? []).join('、') || '—')}</td>
  </tr>`,
    )
    .join('')}</tbody>
</table>`
}


export function reportToHtml(report: Report, topic: Topic): string {
  const r = report
  const consensus = r.consensus ?? []
  const disputes = r.disputes ?? []
  const timeline = r.timeline ?? []
  const participation = r.participation ?? []
  const questions = r.questions ?? []
  const blindSpots = r.blindSpots ?? []
  const meta = r.meta
  const verdict = r.verdict ?? {
    level: 'none' as const,
    headline: r.executiveSummary ?? '',
    reasons: [],
    coverage: 0,
  }
  const level = LEVEL_LABEL[verdict.level] ?? LEVEL_LABEL.none
  const digest = answerDigest(r)
  const figures = runFigures(r)
  const claims = rankClaims(buildClaims(r))
  const leadClaims = claims.slice(0, LEAD_CLAIMS)
  const restClaims = claims.filter((c) => !leadClaims.includes(c))
  const decisionViews = buildDecisions(r)
  const actions = actionItemsFor(r)
  const gaps = moderatorGapRounds(r)
  const answer = r.finalAnswer ?? null
  const answerText = stripLeadQuestion(answer?.conclusion || r.executiveSummary || verdict.headline || '', topic.title)
  const conclusionSeen = Boolean(answer || r.executiveSummary || verdict.headline)
  const models = meta?.models ?? []
  const moderator = meta?.moderatorName
  const generatedAt = r.generatedAt
  const finished = meta?.finishedReason

  const headerChips = chips([
    { text: fmtDate(generatedAt) },
    { text: meta ? `${meta.rounds}/${meta.maxRounds} 轮` : '' },
    { text: models.length ? `${models.length} 个模型` : '' },
    { text: moderator ? `主持 ${moderator}` : '无主持' },
    { text: meta?.anonymousReview ? '匿名互评' : '署名互评' },
    { text: `结论强度 ${level.label}`, cls: `level-${level.tone}` },
  ])

  const gapNote =
    gaps.length > 0
      ? `<p class="notice">第 ${esc(gaps.join('、'))} 轮没有主持小结：这几轮不登记共识、不判收敛，研讨照常继续。结论以其余轮次为准。</p>`
      : ''

  const answerBlock = conclusionSeen
    ? `<section class="answer-card" id="answer">
  <div class="answer-head">
    <h2>结论</h2>
    ${answer ? `<span class="conf">置信度 ${esc(answer.confidence.level)} · ${esc(answer.confidence.score)}/100</span>` : ''}
  </div>
  <div class="answer-text">${paras(answerText)}</div>
  ${
    answer
      ? `<div class="answer-cols">
    <div><h4>成立条件</h4>${list(answer.holds) || '<p class="muted small">没有登记成立条件。</p>'}</div>
    <div><h4>失效条件</h4>${list(answer.breaks) || '<p class="muted small">没有登记失效条件。</p>'}</div>
  </div>
  ${answer.gap ? `<p class="notice">未答上的部分：${esc(stripReportNoise(answer.gap))}</p>` : ''}
  ${answer.confidence.caps.length ? `<p class="small muted">压级理由：${answer.confidence.caps.map(esc).join('；')}</p>` : ''}
  ${answer.struckBaseCount > 0 ? `<p class="notice">这份结论引用了 ${esc(answer.struckBaseCount)} 条已被核验否定的判断，引用需复核。</p>` : ''}`
      : '<p class="muted small">本场没有产出终局答案（终局审校未运行或未给出结论），上面这句来自执行摘要。</p>'
  }
</section>`
    : `<section class="answer-card" id="answer"><div class="answer-head"><h2>结论</h2></div><p class="muted">这一场没有产出可读的结论正文。</p></section>`

  const figureHtml = figures
    .slice(0, 8)
    .map(
      (f) => `<div class="kpi"><div class="kpi-k">${esc(f.k)}</div>
      <div class="kpi-v">${esc(f.v)}</div>
      ${f.note ? `<div class="kpi-note${f.warn ? ' warn' : ''}">${esc(f.note)}</div>` : ''}</div>`,
    )
    .join('')

  const decisionHtml =
    decisionViews.length > 0
      ? `<section class="sec" id="decisions">
  ${sectionHead(2, '决定与代价', '来自终局审校：每条决定写清站得住的依据与要付的代价。')}
  <div class="decisions">${decisionViews.map((d, i) => decisionCard(d.decision, i + 1)).join('')}</div>
</section>`
      : `<section class="sec" id="decisions">
  ${sectionHead(2, '决定与代价', '来自终局审校：每条决定写清站得住的依据与要付的代价。')}
  <p class="muted">本场没有终局审校：这份报告由旧版本生成，或本场中止／无主持降级，没跑到收尾那一次审校调用。</p>
</section>`

  const claimHtml =
    leadClaims.length > 0
      ? `<section class="sec" id="claims">
  ${sectionHead(decisionViews.length > 0 ? 3 : 2, '关键判断', '按「能不能拿去用」排序：印证家数、证据硬度、是否被质询、核验结果。')}
  <div class="claims">${leadClaims.map((c, i) => claimCard(c, i + 1)).join('')}</div>
  ${restClaims.length ? `<p class="small muted">另有 ${restClaims.length} 条判断（多为单一来源或依据偏薄），列在附录的判断清单里。</p>` : ''}
</section>`
      : ''

  const disputeHtml =
    disputes.length > 0
      ? `<section class="sec" id="disputes">
  ${sectionHead(
    (decisionViews.length > 0 ? 3 : 2) + (leadClaims.length > 0 ? 1 : 0) + 1,
    '尚未消解的分歧',
    '这些不是「两边都有道理」，是这场没有谈出结论的地方。',
  )}
  <div class="disputes">${disputes
    .map(
      (d) => `<article class="dispute">
    <h3>${esc(stripReportNoise(d.claim))}</h3>
    ${d.shelved ? `<p class="notice">当场搁置：${esc(stripReportNoise(d.shelved.reason))}${d.shelved.missing ? `（缺：${esc(stripReportNoise(d.shelved.missing))}）` : ''}</p>` : ''}
    <div class="sides">${d.sides
      .map(
        (s) =>
          `<div class="side"><span class="who">${esc(s.agentId)}</span><p>${esc(clip(stripReportNoise(s.argument), 160))}</p></div>`,
      )
      .join('')}</div>
    ${d.whyUnresolved ? `<p class="small muted">未消解的原因：${esc(stripReportNoise(d.whyUnresolved))}</p>` : ''}
    ${d.roundsEngaged > 1 ? `<p class="small muted">交锋 ${esc(d.roundsEngaged)} 轮${d.dueled ? ' · 做过专项对辩' : ''}</p>` : ''}
  </article>`,
    )
    .join('')}</div>
</section>`
      : ''

  const blindHtml =
    blindSpots.length > 0
      ? `<section class="sec" id="blind">
  ${sectionHead(
    (decisionViews.length > 0 ? 3 : 2) + (leadClaims.length > 0 ? 1 : 0) + (disputes.length > 0 ? 1 : 0) + 1,
    '没人提到的地方',
    '整场讨论没有触到、但会影响结论成立与否的问题。',
  )}
  ${list(blindSpots, 'blind-list')}
</section>`
      : ''

  const actionsHtml =
    actions.length > 0
      ? `<section class="sec" id="actions">
  ${sectionHead(
    (decisionViews.length > 0 ? 3 : 2) +
      (leadClaims.length > 0 ? 1 : 0) +
      (disputes.length > 0 ? 1 : 0) +
      (blindSpots.length > 0 ? 1 : 0) +
      1,
    '下一步',
    '不做也不会让结论作废，但做了才能把它变成行动。',
  )}
  <ol class="actions">${actions
    .slice(0, 10)
    .map(
      (a) =>
        `<li><b>${esc(stripReportNoise(a.action))}</b>${
          a.owner || a.due || a.doneWhen
            ? `<span class="small muted">${[a.owner ? `负责人 ${a.owner}` : '', a.due ? `期限 ${a.due}` : '', a.doneWhen ? `完成标准 ${a.doneWhen}` : '']
                .filter(Boolean)
                .map(esc)
                .join(' · ')}</span>`
            : ''
        }</li>`,
    )
    .join('')}</ol>
</section>`
      : ''

  const questionsHtml =
    questions.length > 0
      ? `<section class="appendix-sec">
  <h3>问题台账</h3>
  <table class="table">
    <thead><tr><th>#</th><th>子问题</th><th>状态</th><th>依据</th></tr></thead>
    <tbody>${questions
      .map(
        (q, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td>${esc(clip(stripReportNoise(q.text), 100))}</td>
      <td>${esc(q.status === 'answered' ? '答上' : q.status === 'shelved' ? '当场答不了' : '未答')}</td>
      <td>${q.evidence.length ? esc(`${q.evidence.length} 段原文`) : '—'}</td>
    </tr>`,
      )
      .join('')}</tbody>
  </table>
</section>`
      : ''

  const roundsHtml =
    timeline.length > 0
      ? `<section class="appendix-sec">
  <h3>逐轮进程</h3>
  <table class="table">
    <thead><tr><th>轮</th><th>发言</th><th>缺席</th><th>介入</th><th>共识度</th><th>新增共识</th><th>新增分歧</th></tr></thead>
    <tbody>${timeline
      .map(
        (t) => `<tr>
      <td class="num">R${esc(t.round)}</td>
      <td class="num">${esc(t.utterances)}</td>
      <td class="num${t.absent > 0 ? ' warn' : ''}">${esc(t.absent)}</td>
      <td class="num">${esc(t.interventions)}</td>
      <td class="num">${t.score === null ? '—' : esc(t.score)}</td>
      <td class="num">${esc(t.newConsensus)}</td>
      <td class="num">${esc(t.newDisputes)}</td>
    </tr>`,
      )
      .join('')}</tbody>
  </table>
</section>`
      : ''

  const participationHtml =
    participation.length > 0
      ? `<section class="appendix-sec">
  <h3>参与度</h3>
  <table class="table">
    <thead><tr><th>模型</th><th>通道</th><th>有效发言</th><th>回应他人</th><th>被引用</th><th>缺席轮</th></tr></thead>
    <tbody>${participation
      .map((p) => {
        const absentIn = p.absentRoundList ?? []
        const absentDetail = absentIn.length > 0 ? `（R${absentIn.join('、R')}）` : ''
        return `<tr>
      <td>${esc(p.displayName)}</td>
      <td class="muted">${esc(p.transport === 'api' ? 'API' : '网页')}</td>
      <td class="num">${esc(p.utterances)}</td>
      <td class="num">${esc(p.replies)}</td>
      <td class="num">${esc(p.citedBy)}</td>
      <td class="num${p.absentRounds > 0 ? ' warn' : ''}">${esc(p.absentRounds)}${absentDetail}</td>
    </tr>`
      })
      .join('')}</tbody>
  </table>
</section>`
      : ''

  const auditHtml = r.hallucination
    ? `<section class="appendix-sec">
  <h3>引用与核验</h3>
  <dl class="facts">
    <div><dt>凭空引用率</dt><dd>${esc(r.hallucination.citationBogusRate)}%</dd></div>
    <div><dt>主持代答率</dt><dd>${esc(r.hallucination.attributedRate)}%</dd></div>
    <div><dt>风险分</dt><dd>${esc(r.hallucination.riskScore)}/100</dd></div>
    <div><dt>核验</dt><dd>发起 ${esc(r.hallucination.verification.asked)} · 确认 ${esc(r.hallucination.verification.confirmed)} · 否认 ${esc(r.hallucination.verification.denied)} · 无回应 ${esc(r.hallucination.verification.noResponse)}</dd></div>
  </dl>
  <p class="small muted">${esc(r.hallucination.trajectoryNote)}</p>
  ${list(r.hallucination.flags, 'flags')}
</section>`
    : ''

  const baselineHtml = r.baselineCompare
    ? `<section class="appendix-sec">
  <h3>单模型基线对照</h3>
  <p class="small">${esc(r.baselineCompare.note || '')}</p>
  <dl class="facts">
    <div><dt>研讨多出</dt><dd>${list(r.baselineCompare.councilAdds)}</dd></div>
    <div><dt>研讨丢掉</dt><dd>${list(r.baselineCompare.councilDrops)}</dd></div>
    <div><dt>相对退步</dt><dd>${list(r.baselineCompare.regressions)}</dd></div>
  </dl>
</section>`
    : ''

  const channels = meta?.channels
  const ledgerHtml = `<section class="appendix-sec">
  <h3>运行账目</h3>
  <dl class="facts">
    <div><dt>墙钟耗时</dt><dd>${esc(fmtDuration(meta?.durationMs ?? 0))}</dd></div>
    <div><dt>费用</dt><dd>$${esc((meta?.totalCostUsd ?? 0).toFixed(4))}${meta?.budgetLimited ? ' · 预算触顶' : ''}</dd></div>
    ${
      channels
        ? `<div><dt>调用</dt><dd>API ${esc(channels.apiCalls)} 次 · 网页 ${esc(channels.webCalls)} 次 · 主持 ${esc(channels.moderatorCalls)} 次</dd></div>`
        : ''
    }
    <div><dt>参与模型</dt><dd>${models.map((m) => esc(m.displayName)).join('、') || '未记录'}</dd></div>
    <div><dt>结束原因</dt><dd>${esc(FINISH_LABEL[finished ?? ''] ?? finished ?? '未记录')}</dd></div>
  </dl>
  ${channels?.costNote ? `<p class="small muted">${esc(channels.costNote)}</p>` : ''}
  ${meta?.absentAgents?.length ? `<p class="small muted">有缺席记录的模型：${meta.absentAgents.map(esc).join('、')}</p>` : ''}
</section>`

  const inventoryHtml =
    claims.length > 0
      ? `<section class="appendix-sec">
  <h3>判断清单（${claims.length} 条）</h3>
  <p class="small muted">「多家印证」≥2 家认同且证据硬度≥0.5；「依据偏薄」家数够但硬度不足；「仅一家提出」不构成共识。</p>
  ${claimInventory(restClaims)}
</section>`
      : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>研讨报告 · ${esc(topic.title)}</title>
<style>${CSS}</style>
</head>
<body>
<article class="sheet">
  <header class="cover">
    <div class="eyebrow">Torra · 多模型研讨报告</div>
    <h1>${esc(topic.title)}</h1>
    ${headerChips}
    ${gapNote}
  </header>

  <section class="verdict verdict-${level.tone}">
    <div class="verdict-badge">结论强度 · ${esc(level.label)}</div>
    <p class="headline">${esc(stripReportNoise(verdict.headline) || '这场讨论没有得出可复核的结论。')}</p>
    ${list(verdict.reasons.slice(0, 4), 'reasons')}
    <p class="coverage">结论覆盖率 ${esc(verdict.coverage)}%（已确认共识 / 共识 + 未决分歧）</p>
  </section>

  ${answerBlock}

  <section class="kpis">${figureHtml}</section>

  ${decisionHtml}
  ${claimHtml}
  ${disputeHtml}
  ${blindHtml}
  ${actionsHtml}

  <details class="appendix" open>
    <summary>附录 · 台账、过程与账目（屏幕上可收起；打印时整份都在，不会因为折叠被裁掉）</summary>
    ${questionsHtml}
    ${roundsHtml}
    ${participationHtml}
    ${auditHtml}
    ${baselineHtml}
    ${ledgerHtml}
    ${inventoryHtml}
  </details>

  <footer class="foot">
    <p>${esc(fmtDate(generatedAt))} · Torra 生成 · 结论强度由程序按印证家数、证据硬度、核验结果与缺席情况核算，不由模型自评。</p>
    <p class="muted">讨论记录：${esc(r.sessionId)}${moderator ? ` · 主持：${esc(moderator)}` : ''}</p>
  </footer>
</article>
</body>
</html>
`
}

const FINISH_LABEL: Record<string, string> = {
  converged: '达成收敛',
  'max-rounds': '跑满轮次',
  aborted: '用户终止',
  'no-moderator': '无主持降级',
  failed: '异常结束',
}

const CSS = `
:root{
  --paper:#fbfaf7; --ink:#1b1f24; --body:#33383f; --muted:#71787f;
  --line:#e4e1d9; --card:#ffffff; --accent:#1f6f5c; --warn:#a8542f;
  --mono:ui-monospace,SFMono-Regular,"Cascadia Code",Menlo,monospace;
  --sans:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --serif:"Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,"Times New Roman",serif;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--body);font:16px/1.72 var(--sans);
  font-feature-settings:"palt" 1}
.sheet{max-width:860px;margin:0 auto;padding:64px 32px 96px}
h1,h2,h3,h4{color:var(--ink);margin:0;font-weight:600;line-height:1.35}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.small{font-size:13.5px;line-height:1.65}
.cover{border-bottom:2px solid var(--ink);padding-bottom:24px;margin-bottom:32px}
.eyebrow{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);margin-bottom:10px}
.cover h1{font-family:var(--serif);font-size:clamp(22px,2.2vw,28px);line-height:1.4;font-weight:700;letter-spacing:-.005em;text-wrap:balance;max-width:46em}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.chip{font-size:12.5px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:3px 11px;background:#fff}
.chip.level-strong{color:#155e46;border-color:#bcdccd;background:#f0f8f3}
.chip.level-qualified{color:#7a5514;border-color:#eadcb8;background:#fbf6e9}
.chip.level-weak{color:#8a3a25;border-color:#ecd2c7;background:#fdf2ee}
.chip.level-none{color:#5b6167}
.notice{margin:14px 0 0;padding:10px 14px;border-left:3px solid var(--warn);background:#fdf4ef;font-size:14px;color:#7a3a22}
.verdict{margin:0 0 28px;padding:20px 24px;background:var(--card);border:1px solid var(--line);border-radius:10px}
.verdict-badge{display:inline-block;font-size:12px;letter-spacing:.06em;padding:2px 10px;border-radius:4px;margin-bottom:12px}
.verdict-strong .verdict-badge{background:#eaf5ef;color:#155e46}
.verdict-qualified .verdict-badge{background:#fbf3e2;color:#7a5514}
.verdict-weak .verdict-badge{background:#fdeee8;color:#8a3a25}
.verdict-none .verdict-badge{background:#eef0f1;color:#5b6167}
.headline{font-family:var(--serif);font-size:22px;line-height:1.5;color:var(--ink);margin:0 0 10px}
.reasons{margin:0;padding-left:18px;font-size:14px;color:var(--muted)}
.reasons li{margin:2px 0}
.coverage{margin:12px 0 0;font-size:12.5px;color:var(--muted);font-family:var(--mono)}
.answer-card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px;margin:0 0 28px}
.answer-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:14px}
.answer-head h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
.conf{font-family:var(--mono);font-size:12.5px;color:var(--muted)}
.answer-text{font-size:17px;line-height:1.8;color:var(--ink)}
.answer-text p:last-child{margin-bottom:0}
.answer-cols{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:20px;padding-top:18px;border-top:1px dashed var(--line)}
.answer-cols h4{font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
.answer-cols ul{margin:0;padding-left:18px;font-size:14px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:0 0 36px}
.kpi{background:var(--card);padding:14px 16px}
.kpi-k{font-size:12px;color:var(--muted)}
.kpi-v{font-family:var(--mono);font-size:22px;color:var(--ink);margin:2px 0 2px}
.kpi-note{font-size:11.5px;color:var(--muted);line-height:1.4}
.kpi-note.warn{color:var(--warn)}
.sec{margin:0 0 40px}
.sec-head{display:flex;align-items:baseline;gap:12px;padding-bottom:10px;border-bottom:1px solid var(--line);margin-bottom:20px;flex-wrap:wrap}
.sec-no{font-family:var(--mono);font-size:12px;color:var(--accent);border:1px solid var(--line);border-radius:3px;padding:0 6px}
.sec-head h2{font-size:24px;font-family:var(--serif);font-weight:600}
.sec-note{flex-basis:100%;margin:2px 0 0;font-size:13.5px;color:var(--muted)}
.decisions{display:grid;gap:14px}
.decision{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:18px 20px;background:var(--card)}
.decision-top{display:flex;gap:12px;align-items:baseline}
.decision h3{font-size:17px;line-height:1.55}
.claim-no{font-family:var(--mono);font-size:12px;color:var(--muted);min-width:18px}
.decision-rows{display:grid;gap:10px;margin:12px 0 0}
.decision-rows div{display:grid;grid-template-columns:56px 1fr;gap:12px}
.decision-rows dt{font-size:12px;color:var(--muted);letter-spacing:.04em;padding-top:3px}
.decision-rows dd{margin:0;font-size:14px}
.decision-rows ul{margin:0;padding-left:16px}
.claims{display:grid;gap:14px}
.claim{border:1px solid var(--line);border-radius:8px;padding:18px 20px;background:var(--card)}
.claim-top{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.claim-top h3{font-size:16.5px;line-height:1.5;flex:1 1 320px}
.tier{font-size:11.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.tier-shared{color:#155e46;border-color:#bcdccd;background:#f0f8f3}
.tier-thin{color:#7a5514;border-color:#eadcb8;background:#fbf6e9}
.tier-solo{color:#5b6167;background:#f4f5f6}
.tier-struck{color:#8a3a25;border-color:#ecd2c7;background:#fdf2ee}
.claim-meta{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:10px 0 8px;font-size:12.5px;color:var(--muted);font-family:var(--mono)}
.meter{display:inline-block;width:64px;height:4px;border-radius:2px;background:#eceae3;overflow:hidden}
.meter i{display:block;height:100%;background:var(--accent)}
.claim-body{margin:0 0 8px;font-size:14.5px}
.quotes{margin:8px 0 0;padding:10px 0 0;border-top:1px dashed var(--line);list-style:none;font-size:13.5px}
.quotes li{margin:0 0 6px;color:#454b52}
.quotes li.muted{color:var(--muted);font-size:12.5px}
.who{font-family:var(--mono);font-size:11.5px;color:var(--accent);margin-right:8px;white-space:nowrap}
.disputes{display:grid;gap:14px}
.dispute{border:1px solid var(--line);border-radius:8px;padding:18px 20px;background:#fffdfa}
.dispute h3{font-size:16.5px;line-height:1.5;margin-bottom:10px}
.sides{display:grid;gap:10px;margin:10px 0}
.side{display:grid;grid-template-columns:72px 1fr;gap:10px;font-size:14px}
.side p{margin:0}
.blind-list{margin:0;padding-left:20px;font-size:15px}
.blind-list li{margin:6px 0}
.actions{margin:0;padding-left:22px;font-size:15px}
.actions li{margin:0 0 10px}
.actions li span{display:block;font-family:var(--mono);font-size:12px;color:var(--muted);margin-top:2px}
.appendix{margin:8px 0 0;border-top:2px solid var(--ink);padding-top:14px}
.appendix summary{cursor:pointer;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);list-style:none}
.appendix summary::-webkit-details-marker{display:none}
.appendix summary::after{content:" ＋"}
.appendix[open] summary::after{content:" －"}
.appendix[open] summary{margin-bottom:20px}
.appendix-sec{margin:0 0 30px}
.appendix-sec h3{font-size:15px;letter-spacing:.04em;margin-bottom:10px;color:var(--ink)}
.table{width:100%;border-collapse:collapse;font-size:13.5px;background:var(--card)}
.table th,.table td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.table th{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;background:#f6f4ee}
.table td.num{font-family:var(--mono);white-space:nowrap;text-align:right}
.table td.warn{color:var(--warn)}
.facts{display:grid;grid-template-columns:repeat(2,1fr);gap:10px 24px;margin:0 0 8px}
.facts div{display:grid;grid-template-columns:96px 1fr;gap:10px}
.facts dt{font-size:12px;color:var(--muted);padding-top:2px}
.facts dd{margin:0;font-size:14px}
.facts ul{margin:0;padding-left:16px}
.flags{margin:8px 0 0;padding-left:18px;font-size:13.5px;color:#7a3a22}
.foot{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
.foot p{margin:0 0 4px}
a{color:var(--accent)}
@media (max-width:720px){
  .sheet{padding:36px 18px 64px}
  .cover h1{font-size:28px}
  .kpis{grid-template-columns:repeat(2,1fr)}
  .answer-cols{grid-template-columns:1fr}
  .facts{grid-template-columns:1fr}
}
@media print{
  :root{--paper:#fff}
  body{background:#fff;font-size:11.5pt}
  .sheet{max-width:none;padding:0}
  .appendix{break-before:page}
  .appendix summary{display:none}
  details.appendix>*{display:block}
  .claim,.decision,.dispute,.kpi,.answer-card{break-inside:avoid}
  .sec-head h2{font-size:16pt}
  .cover h1{font-size:22pt}
  a{color:inherit;text-decoration:none}
}
`

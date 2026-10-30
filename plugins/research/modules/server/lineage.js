/**
 * 实验族谱：谁复现了什么，谁又站在谁的肩膀上。
 *
 * 为什么要把这层关系写进插件，而不是每次去远端读 FAMILIES.md：
 * 目录名只说明「跑的是什么」，说明不了「为什么跑」。`cog_e1_c1_seed43_icews14`
 * 和 `cog_e1_c0_seed42_icews14` 看上去只差一个字母，实际一个是基线、一个是变体；
 * 隔半年再看，光靠名字推不出先后。族谱是读实验的人脑子里的那张图，得先把它写下来。
 *
 * 这份表对齐 `/workspace/_migration/FAMILIES.md` 的四条判据：
 *   1. 同一条启动脚本 + 同一数据集 + 只差 seed → 同族（成员的 seed 单独标）；
 *   2. 名字带 ablation / `*_only` / A1 / A2 → 挂在被消融的那个基线下面；
 *   3. smoke → pilot → full → converged 是同一族的阶段，不是四次实验；
 *   4. 只差一个开关（全量/短历史/换数据集口径）→ 变体，不是新族。
 *
 * 匹配顺序有讲究：`match` 从上往下试，先命中先归族，所以特化的写法必须排在
 * 一般写法前面（`m18f_c6` 要在 `m18f_c` 之前，`residual_noop_rngfix` 要在
 * `residual` 之前）。改表的时候别只加不挪。
 *
 * 只在台账里、没有运行目录的（e2f 代码工作树、m18e 只有 src）标 codeOnly：
 * 面板会把它们画成虚线框，提示「台账有、目录没有」，而不是假装它们跑过。
 *
 * 2026-10-30 收进来的三条线（transfir / adatkg / case）不能靠名字认：
 * 它们按「一次运行一个目录」摆，叶子名是 `full`、`mini`、`s42` 这种，单看
 * 什么都不说明，只有加上父目录才知道是哪一族。所以这几族一律拿相对路径匹配，
 * 正则锚在 `^tkgr/...` 上，只写叶子名的写法会同时命中 echr/full 和 collab/mini。
 *
 * 台账是全局的，图是按机器画的：这张表对所有服务器是同一份，但族谱只画被扫的
 * 那台机器上真实存在的族。台账里有、这台机器上还没有的族单独报个数，不摊成节点
 * ——不然在空机器上看族谱，会以为那些实验已经在这儿跑过了。
 */

'use strict'

/** 一条实验线的分区。图谱按 lane 分道，同一族的父子永远在一条道上 */
const LANES = [
  { id: 'tkgr', label: 'tkgr · 复现基线', note: '先把原论文的数字复现出来，后面所有改动都拿它当分母。' },
  { id: 'cog', label: 'cog · 主实验线', note: '组件、时间尺度、关系语义，一条一条往上加。' },
  { id: 'm18', label: 'm18 · 因果证据', note: '从冒烟到对齐对照的一次长阶梯，f 是主力。' },
  { id: 'm20', label: 'm20 · 双角色', note: '实体在事实里同时当主语和宾语，看能不能分开建模。' },
  { id: 'm31', label: 'm31-32 · 路径与反事实', note: '前向路径、时间臂与反事实分支，最近的一批。' },
  { id: 'mvp', label: 'mvp · 修正链', note: '同一条链的五代，只留最后一版当结论。' },
  { id: 'case', label: 'case · 法律案例', note: 'ECtHR 判决与合著网络：换到真实小数据上，方法还成不成立。两个数据集的 MRR 与 ICEWS 不可比。' },
  { id: 'other', label: '未归族', note: '名字对不上任何一族：新跑的实验、或日志存档。' }
]

/**
 * 关系类型 → 图谱上的说法。
 * 这些词会被直接画在连线上，所以用「谁对谁做了什么」，而不是数据库里的外键名。
 */
const RELATIONS = {
  baseline: { label: '复现基线', tone: 'base' },
  derived: { label: '在基线之上改进', tone: 'up' },
  variant: { label: '换口径的变体', tone: 'variant' },
  ablation: { label: '消融', tone: 'ablate' },
  mechanism: { label: '新机制尝试', tone: 'mech' },
  fix: { label: '下一代修正', tone: 'fix' }
}

/**
 * 家族表。parent 为 null 的是这条线的起点（复现基线或最早的一次试跑）。
 * match 里的正则对「去掉 02_runs/ 的相对路径」和「目录名」各试一次。
 */
const FAMILIES = [
  /* ---------- mvp：一条修正链，五代 ---------- */
  {
    id: 'mvp.noop_rngfix',
    lane: 'mvp',
    parent: 'mvp.noop',
    relation: 'fix',
    title: 'residual + noop + rngfix',
    note: '最终版本。noop 分支的随机数也固定住了，前后两次跑可以逐位对上。',
    match: [/^mvp_evidence_residual_noop_rngfix_/]
  },
  {
    id: 'mvp.noop',
    lane: 'mvp',
    parent: 'mvp.residual',
    relation: 'fix',
    title: 'residual + noop',
    note: '把残差接回去，同时留一条不做证据聚合的空操作分支。',
    match: [/^mvp_evidence_residual_noop_/]
  },
  {
    id: 'mvp.rngfix',
    lane: 'mvp',
    parent: 'mvp.noop_rngfix',
    relation: 'fix',
    title: 'residual + rngfix',
    note: '在 noop 之后单独修随机数的一代；最终结论仍以 noop_rngfix 为准。',
    match: [/^mvp_evidence_residual_rngfix_/]
  },
  {
    id: 'mvp.residual',
    lane: 'mvp',
    parent: 'mvp.evidence',
    relation: 'fix',
    title: 'residual',
    note: '残差连接进来，先确认它能跑通、不把指标打崩。',
    match: [/^mvp_evidence_residual_/]
  },
  {
    id: 'mvp.evidence',
    lane: 'mvp',
    parent: null,
    relation: 'baseline',
    title: 'evidencewrite',
    note: '整条链的起点：把证据写回状态的最朴素版本。',
    match: [/^mvp_evidencewrite_/]
  },

  /* ---------- tkgr/c0：复现基线的三代口径 ---------- */
  {
    id: 'tkgr.history9',
    lane: 'tkgr',
    parent: null,
    relation: 'baseline',
    title: 'C0 · history9（最终口径）',
    note: 'ICEWS14 上三 seed 复现，历史长度 9。引用基线数字请用这一代。',
    match: [/^c0_icews14_(?:seed\d+_)?history9_converged$/]
  },
  {
    id: 'tkgr.seeded',
    lane: 'tkgr',
    parent: 'tkgr.history9',
    relation: 'variant',
    title: 'C0 · seeded',
    note: '早期按 seeded 流程跑的两份；口径与 history9 不同，不能混着引用。',
    match: [/^c0_icews14_seed\d+_seeded$/]
  },
  {
    id: 'tkgr.current',
    lane: 'tkgr',
    parent: 'tkgr.history9',
    relation: 'variant',
    title: 'C0 · 0515 current',
    note: 'ICEWS0515 口径的 current。ICEWS14 的 current 因为主程序不认 --seed 根本没起来，已删。',
    match: [/^c0_0515_seed\d+_current$/]
  },

  /* ---------- tkgr/transfir：复现之后再往上加状态（10-25 至 10-30） ---------- */
  {
    id: 'tkgr.transfir.state.200ep',
    lane: 'tkgr',
    parent: 'tkgr.transfir.state',
    relation: 'variant',
    title: '状态化 · 200 轮（原 p3_confidence）',
    note: '配置与 gamma1 相同，只把 epochs 从 60 加到 200。原前缀 p3_confidence 容易读成「置信度」实验，目录按实际配置改名，原前缀留在 launch.sh 注释里。两个 seed 的分数差得远，单引一个会误导。',
    match: [/^tkgr\/transfir\/icews14_state\/gamma1_200ep\//]
  },
  {
    id: 'tkgr.transfir.state.killtrain',
    lane: 'tkgr',
    parent: 'tkgr.transfir.state',
    relation: 'variant',
    title: '状态化 · kill-train（γ=0.5）',
    note: '中途掐掉训练，看状态还能不能撑住；分数与 killtest/ 里的报告配套，γ 取 0.5，不是主线那个 1.0。',
    match: [/^tkgr\/transfir\/icews14_state\/killtrain_s42$/]
  },
  {
    id: 'tkgr.transfir.state.random',
    lane: 'tkgr',
    parent: 'tkgr.transfir.state',
    relation: 'ablation',
    title: '状态化 · 随机初始化（消融）',
    note: '把语义先验换成随机初始化，两 seed；和主线对读才能说清先验本身值多少。',
    match: [/^tkgr\/transfir\/icews14_state\/stateinit_random\//]
  },
  {
    id: 'tkgr.transfir.state',
    lane: 'tkgr',
    parent: 'tkgr.transfir.pilot',
    relation: 'derived',
    title: '状态化归纳 · γ=1',
    note: '在复现好的 TransFIR 上加可学习状态（λ0.2、γ1.0、60 轮）。这条线后面所有变体都拿它当分母。',
    match: [/^tkgr\/transfir\/icews14_state\/gamma1_s42$/]
  },
  {
    id: 'tkgr.transfir.dualstate',
    lane: 'tkgr',
    parent: 'tkgr.transfir.state',
    relation: 'mechanism',
    title: '状态化 · 快慢双 EMA（C4）',
    note: '两套衰减率的状态臂加可学融合，两 seed。分数明显低于主线，别把 0.15 当成这条机制的上限——先查是不是没调起来。',
    match: [/^tkgr\/transfir\/icews14_dualstate\//]
  },
  {
    id: 'tkgr.transfir.prior_gate_0515',
    lane: 'tkgr',
    parent: 'tkgr.transfir.prior_gate',
    relation: 'variant',
    title: '语义先验 · ICEWS0515',
    note: '同一套先验加门控换到 0515，单 seed；14 与 0515 的数不能直接比。',
    match: [/^tkgr\/transfir\/icews0515_prior_gate_/]
  },
  {
    id: 'tkgr.transfir.prior_gate',
    lane: 'tkgr',
    parent: 'tkgr.transfir.state',
    relation: 'mechanism',
    title: '语义先验 + 门控（原 v2）',
    note: '语义先验初始化 + 可学 α + 门控 + zero-mask，单 seed。v2 只是命令行开关 --use_v2 的名字，目录按机制改叫 prior_gate。',
    match: [/^tkgr\/transfir\/icews14_prior_gate_/]
  },
  {
    id: 'tkgr.transfir.pilot',
    lane: 'tkgr',
    parent: null,
    relation: 'baseline',
    title: 'TransFIR · 复现起点',
    note: '原仓库直接跑的一次 ICEWS14 pilot，与 0515 的预处理放在一起：这条线从这里开始，后面的状态化都以它为底。prep 那次没有成绩，只说明 0515 是从哪来的。',
    match: [/^tkgr\/transfir\/icews14_pilot_s42$/, /^tkgr\/transfir\/icews0515_prep$/]
  },
  {
    id: 'tkgr.adatkg',
    lane: 'tkgr',
    parent: null,
    relation: 'baseline',
    title: 'AdaTKG-EMA · 对照基线',
    note: '上游 AdaTKG 的 EMA 版本，两个数据集各一次。看 prior_gate 有没有用，比的是它，不是 TransFIR 自己。',
    match: [/^tkgr\/adatkg\//]
  },
  {
    id: 'tkgr.baseline.fitcarl',
    lane: 'tkgr',
    parent: null,
    relation: 'baseline',
    title: 'FITCARL · few-shot 基线',
    note: '别的仓库的 few-shot 口径，只回收了结果没有成绩行；当初的 save_path 指向 /root/fitcarl_logs，那个位置已不存在。',
    match: [/^tkgr\/baselines\/fitcarl_/]
  },
  {
    id: 'tkgr.baseline.fitter',
    lane: 'tkgr',
    parent: null,
    relation: 'baseline',
    title: 'FITTER · 基线',
    note: '结果从 /root/git/output 回收，启动命令没留下，只当数值参考，不假装能复现。',
    match: [/^tkgr\/baselines\/fitter_/]
  },

  /* ---------- tkgr/case：ECtHR 判决与合著网络（10-27 至 10-28） ---------- */
  {
    id: 'case.echr.ingram',
    lane: 'case',
    parent: null,
    relation: 'baseline',
    title: 'ECtHR · InGram 基线',
    note: '同一个仓库的三次重跑：第二、三次是在改评测打印（H@3、Hits@1 的格式），不是换 seed。数值以最后一次为准。',
    match: [/^tkgr\/case\/echr\/baselines\/ingram\d+$/]
  },
  {
    id: 'case.echr.regcn',
    lane: 'case',
    parent: null,
    relation: 'baseline',
    title: 'ECtHR · RE-GCN mini',
    note: '只跑 3 轮看通不通；之前还有 8 次失败的 mini 尝试，脚本没留下。没有成绩行，别当基线数字用。',
    match: [/^tkgr\/case\/echr\/baselines\/regcn_mini$/]
  },
  {
    id: 'case.echr.eval',
    lane: 'case',
    parent: 'case.echr.legal',
    relation: 'variant',
    title: 'ECtHR · 在 legal checkpoint 上重评',
    note: '不训练，只加载 legal 的权重：一次扫 γ=0…1，一次是 10 分钟限时的调试评测。两次读的是同一份 checkpoint。',
    match: [/^tkgr\/case\/echr\/gamma_eval$/, /^tkgr\/case\/echr\/baselines\/dbg$/]
  },
  {
    id: 'case.echr.gcn',
    lane: 'case',
    parent: null,
    relation: 'baseline',
    title: 'ECtHR · GCN 基线',
    note: 'baseline_gcn.py 的一次运行，MRR 0.0003 低到不像跑对，引用前先看日志。',
    match: [/^tkgr\/case\/echr\/gcn$/]
  },
  {
    id: 'case.echr.ipw',
    lane: 'case',
    parent: 'case.echr.base',
    relation: 'variant',
    title: 'ECtHR · 逆概率加权（G2）',
    note: '主模型加 --ipw_alpha 0.3，对抗判例分布随年份漂移；单次。',
    match: [/^tkgr\/case\/echr\/g2$/]
  },
  {
    id: 'case.echr.time',
    lane: 'case',
    parent: 'case.echr.base',
    relation: 'variant',
    title: 'ECtHR · 时滞多尺度（G4）',
    note: '主模型打开 --time_feat，按时间尺度分档；目录里三份启动脚本，是两次重跑留下的。',
    match: [/^tkgr\/case\/echr\/g4$/]
  },
  {
    id: 'case.echr.legal',
    lane: 'case',
    parent: 'case.echr.base',
    relation: 'variant',
    title: 'ECtHR · LegalBERT 词向量',
    note: '把词向量换成法律语料预训练的 LegalBERT；词嵌入日志 59M，单独存成 word_embedding.log。',
    match: [/^tkgr\/case\/echr\/legal$/]
  },
  {
    id: 'case.echr.rootcause',
    lane: 'case',
    parent: 'case.echr.base',
    relation: 'variant',
    title: 'ECtHR · 分错归因',
    note: '不是训练：统计脚本按关系、时间、实体频段拆开看错在哪，结果在 results/ 的 json 里。',
    match: [/^tkgr\/case\/echr\/rootcause$/]
  },
  {
    id: 'case.echr.base',
    lane: 'case',
    parent: 'case.prep',
    relation: 'baseline',
    title: 'ECtHR · 主模型（mini → full）',
    note: '先 mini 跑通再 full；这条线的分母，后面 G2、G4、LegalBERT 都对它读。',
    match: [/^tkgr\/case\/echr\/(?:mini|full)$/]
  },
  {
    id: 'case.collab',
    lane: 'case',
    parent: 'case.prep',
    relation: 'baseline',
    title: '合著网络 · mini → sub',
    note: '换数据集看方法能不能迁移：mini 只跑 1 轮，sub 30 轮。规模与 ECtHR 不同，两边不能混着引用。',
    match: [/^tkgr\/case\/collab\/(?:mini|sub)$/]
  },
  {
    id: 'case.prep',
    lane: 'case',
    parent: null,
    relation: 'baseline',
    title: '案例数据与词向量准备',
    note: 'ECtHR 与合著网络的数据处理与 BERT 词向量；只有日志，没有训练成绩。',
    match: [/^tkgr\/case\/_prep_logs$/]
  },

  /* ---------- cog：e1 历史编码三支 ---------- */
  {
    id: 'cog.e1.history9',
    lane: 'cog',
    parent: 'cog.e1.c0',
    relation: 'variant',
    title: 'E1 · history9',
    note: '把历史长度拉到 9 的变体，只跑过冒烟与试点，没有全量三 seed。',
    match: [/^cog_e1_c0_history9_/]
  },
  {
    id: 'cog.e1.short',
    lane: 'cog',
    parent: 'cog.e1.c0',
    relation: 'variant',
    title: 'E1 · short',
    note: '短历史版：拿掉长程依赖，看指标掉多少。',
    match: [/^cog_e1_c0_short_/]
  },
  {
    id: 'cog.e1.c0',
    lane: 'cog',
    parent: 'cog.c0',
    relation: 'derived',
    title: 'E1 · C0（三种子）',
    note: 'e1 的基线：ICEWS14 上唯一跑满 seed42/43/44 的一支。',
    match: [/^cog_e1_c0_/]
  },
  {
    id: 'cog.e1.c1',
    lane: 'cog',
    parent: 'cog.e1.c0',
    relation: 'variant',
    title: 'E1 · C1（c0 的变体）',
    note: '在 c0 上改一个开关的变体，不是新机制；对照 c0 读。',
    match: [/^cog_e1_c1_/]
  },
  {
    id: 'cog.e1.m1',
    lane: 'cog',
    parent: 'cog.e1.c0',
    relation: 'variant',
    title: 'E1 · M1（短历史版）',
    note: 'm1 是 c0 的短历史版，冒烟/试点/只训都跑过，没跑全量三 seed。',
    match: [/^cog_e1_m1_/]
  },
  {
    id: 'cog.e1.pilot',
    lane: 'cog',
    parent: 'cog.c0',
    relation: 'variant',
    title: 'E1 · 早期试跑',
    note: 'e1 最早的一次 pilot，早于按 seed 分队，只当时间线证据。',
    match: [/^cog_e1_pilot$/]
  },

  /* ---------- cog：e2 七支 ---------- */
  {
    id: 'cog.e2.gate',
    lane: 'cog',
    parent: 'cog.c0',
    relation: 'derived',
    title: 'E2 · 时间尺度 gate',
    note: '10-03 的主跑与 10-06 的快/慢两代重跑；6.8G evidence 就在这一族里。',
    match: [/^cog_e2_(?:05_15|0515_fast_|0515_slow_)/]
  },
  {
    id: 'cog.e2.relation',
    lane: 'cog',
    parent: 'cog.e2.gate',
    relation: 'derived',
    title: 'E2 · relation 主干',
    note: '主实验线：ICEWS14 与 0515 各三 seed。relation_new 里的 0 字节日志是重跑副本，结论以 icews14_seed42 为准。',
    match: [/^cog_e2_relation_/]
  },
  {
    id: 'cog.e2.semantic',
    lane: 'cog',
    parent: 'cog.e2.relation',
    relation: 'variant',
    title: 'E2 · semantic_tied',
    note: 'relation 的语义绑定变体。ICEWS14 只有 seed42，是单 seed 缺口，引用时别当三 seed。',
    match: [/^cog_e2_semantic_/]
  },
  {
    id: 'cog.e2.fixed',
    lane: 'cog',
    parent: 'cog.e2.gate',
    relation: 'variant',
    title: 'E2 · 固定时间尺度',
    note: '把时间尺度钉死的对照基线；fixed_seed43_05_15 是最早的单 seed 预跑。',
    match: [/^cog_e2_fixed/]
  },
  {
    id: 'cog.e2.ablation',
    lane: 'cog',
    parent: 'cog.e2.fixed',
    relation: 'ablation',
    title: 'E2 · 时间尺度消融',
    note: '只有 0515 的 fast/slow/fixed 三个是正式消融；ablation_work 是冒烟舞台。',
    match: [/^cog_e2_ablation_/]
  },
  {
    id: 'cog.e2.c0',
    lane: 'cog',
    parent: 'cog.e2.gate',
    relation: 'variant',
    title: 'E2 · 自建对照组',
    note: 'e2 自己的 control6 与 full：没有改机制，只换了对照口径。',
    match: [/^cog_e2_c0_/]
  },

  /* ---------- cog：c0 与 rmh 底座 ---------- */
  {
    id: 'cog.c0',
    lane: 'cog',
    parent: 'tkgr.history9',
    relation: 'derived',
    title: 'C0 · 0515 匹配口径',
    note: 'cog 里的复现基线：同配置三 seed，按 0515 matched 口径评。',
    match: [/^cog_c0_/]
  },
  {
    id: 'cog.rmh.train',
    lane: 'cog',
    parent: 'tkgr.history9',
    relation: 'derived',
    title: 'RMH · 训练底座',
    note: '把 rmh 组件搭起来的两份训练（ICEWS14 与 0515），后面 timescale 都从这里长出来。',
    match: [/^cog_rmh_train_/]
  },
  {
    id: 'cog.rmh.timescale',
    lane: 'cog',
    parent: 'cog.rmh.train',
    relation: 'derived',
    title: 'RMH · timescale',
    note: '时间尺度单跑的四个阶段：mvp / seeded / fast / slow，是「组件搭起来」那段历史的主干。',
    match: [/^cog_rmh_timescale_/]
  },
  {
    id: 'cog.rmh.dual',
    lane: 'cog',
    parent: 'cog.rmh.timescale',
    relation: 'derived',
    title: 'RMH · ts_dual',
    note: '双时间尺度三 seed（另有 0515 单跑），是 timescale 往下走的第一支。',
    match: [/^cog_rmh_ts_dual/]
  },
  {
    id: 'cog.rmh.slow',
    lane: 'cog',
    parent: 'cog.rmh.timescale',
    relation: 'variant',
    title: 'RMH · ts_slow',
    note: '只放开慢臂的对照三 seed。',
    match: [/^cog_rmh_ts_slow/]
  },
  {
    id: 'cog.rmh.c0',
    lane: 'cog',
    parent: 'cog.rmh.train',
    relation: 'variant',
    title: 'RMH · c0 对照',
    note: 'rmh 自己的基线四份（14 三 seed + 0515 单跑）。',
    match: [/^cog_rmh_c0_/]
  },
  {
    id: 'cog.rmh.eval',
    lane: 'cog',
    parent: 'cog.rmh.timescale',
    relation: 'variant',
    title: 'RMH · 评测口径',
    note: '只动评测：eval14_current 与 unified_eval，用来看分数是不是口径差异。',
    match: [/^cog_rmh_(?:eval14_|unified_)/]
  },

  /* ---------- cog：m2x 机制扫描 ---------- */
  {
    id: 'cog.m21',
    lane: 'cog',
    parent: 'cog.rmh.timescale',
    relation: 'mechanism',
    title: 'M21 · 第一版机制',
    note: '单 seed，先看方向对不对。',
    match: [/^cog_m21_/]
  },
  {
    id: 'cog.m22',
    lane: 'cog',
    parent: 'cog.m21',
    relation: 'mechanism',
    title: 'M22 · 三 seed',
    note: 'm21 之后的第一支跑满三 seed 的机制。',
    match: [/^cog_m22_/]
  },
  {
    id: 'cog.m23',
    lane: 'cog',
    parent: 'cog.m22',
    relation: 'mechanism',
    title: 'M23 · 关系转移',
    note: '把关系转移显式建进来，三 seed。',
    match: [/^cog_m23_/]
  },
  {
    id: 'cog.m24',
    lane: 'cog',
    parent: 'cog.m23',
    relation: 'mechanism',
    title: 'M24 · 实体局部上下文',
    note: '单 seed：只看实体周围的局部状态。',
    match: [/^cog_m24_/]
  },
  {
    id: 'cog.m25.control',
    lane: 'cog',
    parent: 'cog.m24',
    relation: 'mechanism',
    title: 'M25 · 固定尺度对照',
    note: 'm25 唯一的完整对照三 seed，用来证明后面的改进不是 seed 噪声。',
    match: [/^cog_m25_fixed_timescale_control/]
  },
  {
    id: 'cog.m25',
    lane: 'cog',
    parent: 'cog.m25.control',
    relation: 'mechanism',
    title: 'M25 · 关系条件化尺度',
    note: '让时间尺度跟着关系走，三 seed，对上面那组对照读。',
    match: [/^cog_m25_/]
  },
  {
    id: 'cog.m26',
    lane: 'cog',
    parent: 'cog.m25',
    relation: 'mechanism',
    title: 'M26 · 角色对齐短状态',
    note: '三 seed。',
    match: [/^cog_m26_/]
  },
  {
    id: 'cog.m27',
    lane: 'cog',
    parent: 'cog.m26',
    relation: 'mechanism',
    title: 'M27 · 前缀重复门控',
    note: '单 seed。',
    match: [/^cog_m27_/]
  },
  {
    id: 'cog.m28',
    lane: 'cog',
    parent: 'cog.m27',
    relation: 'mechanism',
    title: 'M28 · 时间顺序状态',
    note: '单 seed。',
    match: [/^cog_m28_/]
  },
  {
    id: 'cog.m29',
    lane: 'cog',
    parent: 'cog.m28',
    relation: 'mechanism',
    title: 'M29 · 前缀一致性',
    note: '名义三 seed，实际三份的 config 里都写着 42，10-30 已删掉两份副本。引用前先核 config。',
    match: [/^cog_m29_/]
  },
  {
    id: 'cog.e2f',
    lane: 'cog',
    parent: 'cog.e2.gate',
    relation: 'variant',
    title: 'E2F · 独立代码工作树',
    note: '三份独立的代码工作树，带 .git 与 results_isolated，不是结果目录。',
    codeOnly: true,
    match: [/^cog_e2f_/]
  },

  /* ---------- m18 ---------- */
  // 消融与变体排在主力前面：`m18f_icews14_ablation_A1_seed43` 也以 `m18f_icews14` 开头，
  // 主力那条正则放前面就会把六个消融 run 全吞进去。
  {
    id: 'm18.f.a1',
    lane: 'm18',
    parent: 'm18.f.main',
    relation: 'ablation',
    title: 'M18F · A1 只留候选',
    note: '把反事实分支关掉、只留候选集的消融，三 seed。',
    match: [/^m18f_icews14_ablation_A1/]
  },
  {
    id: 'm18.f.a2',
    lane: 'm18',
    parent: 'm18.f.main',
    relation: 'ablation',
    title: 'M18F · A2 只留反事实',
    note: '只留反事实分支的消融，三 seed。',
    match: [/^m18f_icews14_ablation_A2/]
  },
  {
    id: 'm18.f.c6',
    lane: 'm18',
    parent: 'm18.f.main',
    relation: 'variant',
    title: 'M18F · C6',
    note: '在主力的基础上换一档配置，三 seed。',
    match: [/^m18f_c6_/]
  },
  {
    id: 'm18.f.c',
    lane: 'm18',
    parent: 'm18.f.main',
    relation: 'variant',
    title: 'M18F · C',
    note: '更早的一档配置变体，三 seed。',
    match: [/^m18f_c_/]
  },
  {
    id: 'm18.f.diag',
    lane: 'm18',
    parent: 'm18.f.main',
    relation: 'ablation',
    title: 'M18F · 单通道诊断',
    note: '分别只看 c0、只看 cf、只看 evidence 的三次诊断跑。',
    match: [/^m18f_diag_/]
  },
  {
    id: 'm18.f.main',
    lane: 'm18',
    parent: 'm18.a',
    relation: 'derived',
    title: 'M18F · 主力',
    note: '两条数据集各有 base 与 converged；结论取 converged。',
    match: [/^m18f_(?:icews0515|icews14)/]
  },
  {
    id: 'm18.a',
    lane: 'm18',
    parent: null,
    relation: 'baseline',
    title: 'M18A · 对齐阶梯',
    note: '10-04 一上午的阶梯：smoke → match → seq → full → 0515。从左到右就是当时的调参顺序。',
    match: [/^m18a_/]
  },
  {
    id: 'm18.c',
    lane: 'm18',
    parent: 'm18.a',
    relation: 'variant',
    title: 'M18C',
    note: '各自单跑，两个数据集各一份。',
    match: [/^m18c_/]
  },
  {
    id: 'm18.d',
    lane: 'm18',
    parent: 'm18.a',
    relation: 'variant',
    title: 'M18D',
    note: '单跑一份。',
    match: [/^m18d_/]
  },

  /* ---------- m20 ---------- */
  {
    id: 'm20.ablation',
    lane: 'm20',
    parent: 'm20.dualrole',
    relation: 'ablation',
    title: 'M20 · 消融三阶',
    note: 'smoke → formal → multiseed，同一件事的三个阶段；formal 里 full / novel-only / repeat-only / shared-gru 是四种配置。',
    match: [/m20_ablation/]
  },
  {
    id: 'm20.dualrole',
    lane: 'm20',
    parent: 'm20.base',
    relation: 'derived',
    title: 'M20 · dualrole',
    note: '实体同时当主语和宾语，ICEWS14 与 0515 各三 seed converged。',
    match: [/m20_dualrole/]
  },
  {
    id: 'm20.base',
    lane: 'm20',
    parent: null,
    relation: 'baseline',
    title: 'M20 · base',
    note: '只剩 m20_icews14 一个（_src 副本与它逐字节相同，已删），单 seed。',
    match: [/^m20_icews14$/]
  },
  {
    id: 'm20.m19',
    lane: 'm20',
    parent: null,
    relation: 'variant',
    title: 'M19 · 隔壁实验',
    note: '当时顺手建在 m20 里，应该跟 m18 一起看；179M evidence 在这个目录。',
    match: [/^m19_icews14$/]
  },
  {
    id: 'm20.m21',
    lane: 'm20',
    parent: 'm20.m19',
    relation: 'variant',
    title: 'M21 · 隔壁实验',
    note: '同样顺手建在 m20 里，与 cog 的 m21 不是同一份。',
    match: [/^m21_icews14$/]
  },

  /* ---------- m31-32 ---------- */
  {
    id: 'm31.path_time',
    lane: 'm31',
    parent: null,
    relation: 'baseline',
    title: 'M31 · 路径 + 时间',
    note: '三 seed 的主跑，m31-32 这一批的起点。',
    match: [/^m31_path_time_/]
  },
  {
    id: 'm31.ablate.path',
    lane: 'm31',
    parent: 'm31.path_time',
    relation: 'ablation',
    title: 'M31 · 去路径',
    note: '单臂消融：把路径关掉，三 seed。',
    match: [/^m31_ablate_path_/]
  },
  {
    id: 'm31.ablate.time',
    lane: 'm31',
    parent: 'm31.path_time',
    relation: 'ablation',
    title: 'M31 · 去时间',
    note: '单臂消融：把时间臂关掉，三 seed。',
    match: [/^m31_ablate_time_/]
  },
  {
    id: 'm32.counterfactual',
    lane: 'm31',
    parent: 'm31.path_time',
    relation: 'derived',
    title: 'M32 · 反事实路径',
    note: '四个 run：seed42 与其 full 版、seed43、seed44。',
    match: [/^m32_counterfactual_/]
  },
  {
    id: 'm32.novel',
    lane: 'm31',
    parent: 'm31.path_time',
    relation: 'derived',
    title: 'M32 · 新颖性约束',
    note: 'cons002 六 run（两数据集 × 三 seed）+ cons005 单跑。',
    match: [/^m32_novel_/]
  },
  {
    id: 'm32.ablation',
    lane: 'm31',
    parent: 'm32.novel',
    relation: 'ablation',
    title: 'M32 · 单约束消融',
    note: 'consistency_only 与 novel_only，都只有 seed42。',
    match: [/^m32_ablate_/]
  }
]

/** 阶段的先后顺序：冒烟 < 只训 < 试点 < 对齐 < 顺序 < 正式 < 完整 < 收敛 */
const STAGES = [
  [/smoke/, 'smoke（冒烟）', 0],
  [/trainonly/, 'trainonly（只训）', 1],
  [/pilot/, 'pilot（试点）', 2],
  [/match/, 'match（对齐）', 2],
  [/seq/, 'seq（顺序）', 3],
  [/formal/, 'formal（正式）', 3],
  [/multiseed/, 'multiseed（多种子）', 5],
  [/converged/, 'converged（收敛）', 5],
  [/current/, 'current（当前口径）', 5],
  [/seeded/, 'seeded（播种流程）', 5],
  [/[_-]full(?:$|_)/, 'full（完整）', 4],
  [/_full$/, 'full（完整）', 4]
]

function str(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

function stripPrefix(rel) {
  return str(rel).replace(/^02_runs\//, '')
}

/** 名字 / 相对路径里的阶段；两条都试，取靠前的那个 */
function stageOf(rel, name) {
  for (const [re, label, rank] of STAGES) {
    if (re.test(rel) || re.test(name)) return { label, rank }
  }
  return { label: '', rank: -1 }
}

/** 显式写出来的 seed；没写就是 null，不替人假设成 42 */
function seedOf(rel, name) {
  // 两种写法都收：老目录是 `..._seed42`，10-30 收进来的几条线用 `s42` / `s123`
  const hit = str(name).match(/(?:^|_)seed(\d+)/) ||
    str(rel).match(/(?:^|_)seed(\d+)/) ||
    str(name).match(/(?:^|_)s(\d+)(?:$|_)/) ||
    str(rel).match(/(?:^|_)s(\d+)(?:$|_)/)
  if (!hit) return null
  const value = Number(hit[1])
  return Number.isFinite(value) ? value : null
}

function median(values) {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (!list.length) return null
  const mid = Math.floor(list.length / 2)
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2
}

function round(value, digits) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const scale = Math.pow(10, digits)
  return Math.round(value * scale) / scale
}

/**
 * 新目录锚点：<项目>/<线>/<族>/<运行>/ 落地之后，族靠目录前缀认，
 * 运行名里只留数据集、臂、阶段、seed；旧的平铺目录继续走各族的正则，
 * 所以搬迁前后看板都能读。
 */
const FAMILY_DIRS = {
  'mvp.noop_rngfix': 'mvp/chain/residual_noop_rngfix',
  'mvp.noop': 'mvp/chain/residual_noop',
  'mvp.rngfix': 'mvp/chain/residual_rngfix',
  'mvp.residual': 'mvp/chain/residual',
  'mvp.evidence': 'mvp/chain/evidencewrite',
  'tkgr.history9': 'tkgr/c0/history9',
  'tkgr.seeded': 'tkgr/c0/seeded',
  'tkgr.current': 'tkgr/c0/current',
  'tkgr.transfir.state.200ep': 'tkgr/transfir/state_200ep',
  'tkgr.transfir.state.killtrain': 'tkgr/transfir/state_killtrain',
  'tkgr.transfir.state.random': 'tkgr/transfir/state_random',
  'tkgr.transfir.state': 'tkgr/transfir/state',
  'tkgr.transfir.dualstate': 'tkgr/transfir/dualstate',
  'tkgr.transfir.prior_gate_0515': 'tkgr/transfir/prior_gate_0515',
  'tkgr.transfir.prior_gate': 'tkgr/transfir/prior_gate',
  'tkgr.transfir.pilot': 'tkgr/transfir/pilot',
  'tkgr.adatkg': 'tkgr/adatkg/ema',
  'tkgr.baseline.fitcarl': 'tkgr/repro/fitcarl',
  'tkgr.baseline.fitter': 'tkgr/repro/fitter',
  'case.echr.ingram': 'tkgr/case/echr_ingram',
  'case.echr.regcn': 'tkgr/case/echr_regcn',
  'case.echr.eval': 'tkgr/case/echr_eval',
  'case.echr.gcn': 'tkgr/case/echr_gcn',
  'case.echr.ipw': 'tkgr/case/echr_ipw',
  'case.echr.time': 'tkgr/case/echr_time',
  'case.echr.legal': 'tkgr/case/echr_legal',
  'case.echr.rootcause': 'tkgr/case/echr_rootcause',
  'case.echr.base': 'tkgr/case/echr_base',
  'case.collab': 'tkgr/case/collab',
  'cog.e1.history9': 'tkgr/cog/e1_history9',
  'cog.e1.short': 'tkgr/cog/e1_short',
  'cog.e1.c0': 'tkgr/cog/e1_c0',
  'cog.e1.c1': 'tkgr/cog/e1_c1',
  'cog.e1.m1': 'tkgr/cog/e1_m1',
  'cog.e1.pilot': 'tkgr/cog/e1_pilot',
  'cog.e2.gate': 'tkgr/cog/e2_gate',
  'cog.e2.relation': 'tkgr/cog/e2_relation',
  'cog.e2.semantic': 'tkgr/cog/e2_semantic',
  'cog.e2.fixed': 'tkgr/cog/e2_fixed',
  'cog.e2.ablation': 'tkgr/cog/e2_ablation',
  'cog.e2.c0': 'tkgr/cog/e2_c0',
  'cog.c0': 'tkgr/cog/c0',
  'cog.rmh.train': 'tkgr/cog/rmh_train',
  'cog.rmh.timescale': 'tkgr/cog/rmh_timescale',
  'cog.rmh.dual': 'tkgr/cog/rmh_ts_dual',
  'cog.rmh.slow': 'tkgr/cog/rmh_ts_slow',
  'cog.rmh.c0': 'tkgr/cog/rmh_c0',
  'cog.rmh.eval': 'tkgr/cog/rmh_eval',
  'cog.m21': 'tkgr/cog/m21',
  'cog.m22': 'tkgr/cog/m22',
  'cog.m23': 'tkgr/cog/m23',
  'cog.m24': 'tkgr/cog/m24',
  'cog.m25.control': 'tkgr/cog/m25_control',
  'cog.m25': 'tkgr/cog/m25',
  'cog.m26': 'tkgr/cog/m26',
  'cog.m27': 'tkgr/cog/m27',
  'cog.m28': 'tkgr/cog/m28',
  'cog.m29': 'tkgr/cog/m29',
  'cog.e2f': 'tkgr/cog/e2f',
  'm18.f.a1': 'tkgr/m18/f_ablate_a1',
  'm18.f.a2': 'tkgr/m18/f_ablate_a2',
  'm18.f.c6': 'tkgr/m18/f_c6',
  'm18.f.c': 'tkgr/m18/f_c',
  'm18.f.diag': 'tkgr/m18/f_diag',
  'm18.f.main': 'tkgr/m18/f_main',
  'm18.a': 'tkgr/m18/align',
  'm18.c': 'tkgr/m18/c',
  'm18.d': 'tkgr/m18/d',
  'm20.ablation': 'tkgr/m20/ablation',
  'm20.dualrole': 'tkgr/m20/dualrole',
  'm20.base': 'tkgr/m20/base',
  'm20.m19': 'tkgr/m20/m19',
  'm20.m21': 'tkgr/m20/m21',
  'm31.path_time': 'tkgr/m31-32/path_time',
  'm31.ablate.path': 'tkgr/m31-32/ablate_path',
  'm31.ablate.time': 'tkgr/m31-32/ablate_time',
  'm32.counterfactual': 'tkgr/m31-32/counterfactual',
  'm32.novel': 'tkgr/m31-32/novel',
  'm32.ablation': 'tkgr/m31-32/ablate_constraint'
}

function matchFamily(rel, name) {
  const path = stripPrefix(rel)
  // 目录锚点先于正则：新路径在哪一族只看它在哪个族目录下，
  // 免得运行名里的 dataset / arm 词被别的族正则抢先吃掉
  for (const family of FAMILIES) {
    const dir = FAMILY_DIRS[family.id]
    if (!dir) continue
    if (path === dir || path.startsWith(dir + '/')) return family
  }
  for (const family of FAMILIES) {
    for (const re of family.match) {
      if (re.test(rel) || re.test(name)) return family
    }
  }
  return null
}

/** 成员排序：阶段靠前、seed 小靠前、没标 seed 的排最后 */
function compareMembers(a, b) {
  if (a.stageRank !== b.stageRank) return a.stageRank - b.stageRank
  const left = a.seed === null ? Number.MAX_SAFE_INTEGER : a.seed
  const right = b.seed === null ? Number.MAX_SAFE_INTEGER : b.seed
  if (left !== right) return left - right
  return str(a.name).localeCompare(str(b.name))
}

/**
 * 把扫到的 runs 归进族里。
 *
 * 纯函数：只读传入的 runs，不碰网络、不写存储，测试可以直接喂假数据。
 * 返回的结构就是面板要画的东西：族（含父子与成员）、未归族的 run、只在台账里
 * 有记录的族，以及每个族的 MRR 中位数与相对上游的 Δ。
 */
function buildLineage(runs) {
  const list = Array.isArray(runs) ? runs : []
  const families = new Map()
  for (const family of FAMILIES) {
    families.set(family.id, {
      id: family.id,
      lane: family.lane,
      parent: family.parent || '',
      relation: family.relation,
      relationLabel: (RELATIONS[family.relation] || RELATIONS.derived).label,
      title: family.title,
      note: family.note || '',
      codeOnly: !!family.codeOnly,
      depth: 0,
      count: 0,
      withMetrics: 0,
      seeds: [],
      stages: [],
      mrr: null,
      best: null,
      delta: null,
      members: []
    })
  }

  const ungrouped = []
  for (const run of list) {
    const rel = stripPrefix(run.rel || run.id)
    const name = str(run.name || rel.split('/').pop())
    const family = matchFamily(rel, name)
    if (!family) {
      ungrouped.push({
        id: run.id,
        name,
        rel,
        path: run.path,
        mrr: run.metrics && typeof run.metrics.mrr === 'number' ? run.metrics.mrr : null,
        modified: run.modified || 0,
        project: run.project || ''
      })
      continue
    }
    const stage = stageOf(rel, name)
    const metrics = run.metrics || {}
    families.get(family.id).members.push({
      id: run.id,
      name,
      // m20 的消融分了 formal / multiseed 两层，叶子只叫 full、seed43：
      // 这样的名字单看不知道是哪一组，补上前一级目录再显示
      label: name.indexOf('_') === -1 ? rel.split('/').slice(-2).join('/') : name,
      rel,
      path: run.path,
      seed: seedOf(rel, name),
      stage: stage.label,
      stageRank: stage.rank,
      mrr: typeof metrics.mrr === 'number' ? metrics.mrr : null,
      h1: typeof metrics.h1 === 'number' ? metrics.h1 : null,
      h3: typeof metrics.h3 === 'number' ? metrics.h3 : null,
      h10: typeof metrics.h10 === 'number' ? metrics.h10 : null,
      resultCount: run.resultCount || 0,
      modified: run.modified || 0,
      metricLine: run.metricLine || ''
    })
  }

  // 族内：排序、挑对照组、算每个成员相对对照组的 Δ
  for (const family of families.values()) {
    family.members.sort(compareMembers)
    family.count = family.members.length
    const scored = family.members.filter((member) => member.mrr !== null)
    family.withMetrics = scored.length
    family.mrr = round(median(scored.map((member) => member.mrr)), 4)
    family.best = scored.length ? round(Math.max(...scored.map((member) => member.mrr)), 4) : null
    const seeds = []
    for (const member of family.members) {
      if (member.seed !== null && !seeds.includes(member.seed)) seeds.push(member.seed)
    }
    family.seeds = seeds.sort((a, b) => a - b)
    const stages = []
    for (const member of family.members) {
      if (member.stage && !stages.includes(member.stage)) stages.push(member.stage)
    }
    family.stages = stages
    // 对照组：阶段最靠前、seed 最小的那条；族里全是同一阶段的，它就是「第一个跑出来的」
    const ref = family.members[0] || null
    family.refId = ref ? ref.id : ''
    family.refName = ref ? ref.name : ''
    const refMrr = ref && ref.mrr !== null ? ref.mrr : null
    for (const member of family.members) {
      member.delta = refMrr !== null && member.mrr !== null ? round(member.mrr - refMrr, 4) : null
      member.isRef = !!ref && member.id === ref.id
    }
  }

  // 深度：只数这台机器上真实存在的祖先。上游没在这儿就不给它留空列，
  // 否则半台机器会让整张图横着拉出一堆没人的位置。
  // seen 只记「这一条链上走过的」，起点不能预先塞进去，
  // 否则第一次判断就是「见过自己」，所有族的深度都会是 0，图谱全挤在左列。
  function depthOf(id, seen) {
    const family = families.get(id)
    if (!family) return 0
    if (!family.parent || seen.has(id)) return 0
    seen.add(id)
    const parent = families.get(family.parent)
    if (!parent || !parent.count) return 0
    return 1 + depthOf(parent.id, seen)
  }
  for (const family of families.values()) {
    family.depth = depthOf(family.id, new Set())
    const parent = family.parent ? families.get(family.parent) : null
    // 上游是谁要一直说得清：即使它不在这台机器上，名字也得留着
    family.parentPresent = !!(parent && parent.count > 0)
    family.parentTitle = parent ? parent.title : ''
  }

  // 相对上游：拿族的中位数去减父族的中位数。没有分数就没有 Δ，不拿 0 冒充
  for (const family of families.values()) {
    const parent = family.parent ? families.get(family.parent) : null
    if (!parent || family.mrr === null || parent.mrr === null) {
      family.parentMrr = parent ? parent.mrr : null
      continue
    }
    family.parentMrr = parent.mrr
    family.delta = round(family.mrr - parent.mrr, 4)
  }

  // 台账里有、这台机器上没有的族：不画成节点，只报个数。
  // 台账是全局的，机器是一台一台的：换一台机器看，图就该换一幅，
  // 而不是把整本台账原样摊在空机器上。
  const missing = []
  const output = []
  for (const family of families.values()) {
    if (family.count > 0) {
      output.push(family)
      continue
    }
    missing.push({
      id: family.id,
      lane: family.lane,
      title: family.title,
      note: family.note || '',
      codeOnly: !!family.codeOnly,
      parent: family.parent || '',
      relation: family.relation,
      relationLabel: (RELATIONS[family.relation] || RELATIONS.derived).label,
      count: 0,
      mrr: null,
      members: []
    })
  }

  // 族按画图的顺序排：先 lane 的顺序，再深度，再标题，保证每次扫完都一样
  const laneOrder = new Map(LANES.map((lane, index) => [lane.id, index]))
  const byLane = (left, right) => {
    const a = laneOrder.has(left.lane) ? laneOrder.get(left.lane) : LANES.length
    const b = laneOrder.has(right.lane) ? laneOrder.get(right.lane) : LANES.length
    if (a !== b) return a - b
    return left.title.localeCompare(right.title)
  }
  output.sort((a, b) => {
    const left = laneOrder.has(a.lane) ? laneOrder.get(a.lane) : LANES.length
    const right = laneOrder.has(b.lane) ? laneOrder.get(b.lane) : LANES.length
    if (left !== right) return left - right
    if (a.depth !== b.depth) return a.depth - b.depth
    return a.title.localeCompare(b.title)
  })
  missing.sort(byLane)

  const grouped = output.reduce((sum, family) => sum + family.count, 0)
  return {
    at: Date.now(),
    lanes: LANES,
    relations: RELATIONS,
    families: output,
    ungrouped,
    missing,
    stats: {
      runs: list.length,
      grouped,
      ungrouped: ungrouped.length,
      families: output.length,
      withMetrics: list.filter((run) => run.metrics && typeof run.metrics.mrr === 'number').length,
      // 台账一共有多少族：这台机器上有几个、还差几个
      ledger: FAMILIES.length,
      drift: missing.length
    }
  }
}

module.exports = {
  LANES,
  RELATIONS,
  FAMILIES,
  buildLineage,
  stageOf,
  seedOf,
  matchFamily
}

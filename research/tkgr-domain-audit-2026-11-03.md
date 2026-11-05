# TKGR 领域数据集核验：司法、法规、科研三类共 30 余个候选的可用性结论

> 时间：2026-11-03｜执行环境：gpu-master｜产物根目录：`/workspace/03_data/`

## 一、这份文档回答的问题

论文需要给时序知识图谱推理（TKGR）找一个真实领域案例，要求同时满足四条：同一主体有多条带时间戳的事件、主体之间存在可用关系、对应真实痛点、能按时间或未见实体切分并有可靠基线。为此核验了司法、法规、科研三个方向共 30 余个公开数据集。

结论与最初的预期相反：**没有任何一个公开数据集能在"未见实体 + 时间外推"的设定下提供超过简单结构基线的信号。** 唯一真实且可复现的可学信号是 DataJud 的程序事件顺序（0.305 → 0.621），但它的载体是序列而非关系，属于过程挖掘而非 TKGR。

因此本文档的用途是作为论文的"动机与负结果"章节底稿：用对照实验说明通用 TKGR 方法在这些领域失效的具体原因，而不是罗列数据集。

## 二、核验方法：为什么不能直接采信"LEARNABLE"

早期用静态 DistMult 判出 9 个"可学"，后来发现几乎全是伪影。伪影指模型分数来自尾实体的全局频次或嵌入范数偏置，与"头实体和尾实体是否真实配对"无关。识别方法是同关系内随机置换尾实体：若置换后 MRR 几乎不变，说明模型没有用到配对信息。

核验中逐步加严到三道对照，后一道能抓到前一道漏掉的问题：

1. 同关系洗牌（shuffled tail）——抓 hub 范数伪影；
2. 频次基线（popularity，按训练集尾实体入度排序）——抓"高分其实来自先验"；
3. 随机主体（random subject，把 subject 换成随机实体）——抓"模型根本没用 subject"。

判定规则固定为：raw 必须显著高于三道对照中的每一个，才算可学；只高过其中一道不作数。这条规则在 ReCaRe 上直接推翻了 aggregate 看似可学的结论（见 4.1）。

## 三、司法域：14 个候选

核验规模：最大的是 CourtListener（66.4 万实体、442 万引用边）与 DataJud（2.4 万案件、124 万事件）。14 个候选中，只有 4 个真正跑过 GPU，其余因数据不可得或结构不成立未进入实验。

| 数据集 | 规模（实测） | 静态直推 MRR | 归纳 / 序列结果 | 判定 |
|---|---|---|---|---|
| CourtListener（美国联邦） | 663,966 实体 / 4,420,088 引用边 / 31 年 | 0.4035（valid）/ 0.3612（test），洗牌后逐位相同 | 纯引用 InGram 0.010；多关系 InGram 四轮 0.015/0.005/0.003/0.019 非单调；cites 单关系 raw 0.0008（popularity 0.0081 更高） | 不可用 |
| DataJud（巴西 CNJ） | 24,000 案件 / 1,239,761 事件 / 378 种事件 | 0.2473 / 0.2007 | 重建事件流后集合补全 0.1923 < popularity 0.2105 < popularity+类别 0.2133；序列 unigram 0.305 → bigram 0.550 → trigram 0.621（严格时序子集 0.6248） | 部分可学，但信号在序列不在关系 |
| JITS（印度判决） | 9,420 实体 / 13,238 训练三元组 | 0.0757 / 0.0688，洗牌相同 | InGram 0.016（H@1 0.002） | 弱阳性 |
| HUDOC（欧洲人权） | 7,716 实体 / 15,239 三元组 | 0.3973 / 0.3295 | 未跑 | 边缘先验 0.520 > 模型分，频率偏置假象 |
| OHADA-CCJA（非洲商法） | 10,614 / 21,840 / 27 时间步 | 0.1780 / 0.1867 | 未跑 | 关系级分解：判例引用 0.0021、当事人 0.0002 ≈ 随机 |
| ECtHR（单关系引用） | — | — | InGram 验证集 0.000–0.005（README 标注不进结论）；文献先例 0.0259 | 极弱，仅作法律域锚点 |
| LeCNet | — | 未跑 | 未跑 | 无公开数据文件 |
| EUR-LexRD | 102,244 引用边 | 未跑 | 未跑 | 无时间戳列，不可作 TKGR，可作检索案例 |
| Judilibre（法国） | — | 未跑 | 未跑 | 需 Piste key |
| 法国行政法院 | — | 未跑 | 未跑 | 单关系、无 GPU 价值 |
| AWS 印度最高/高等法院 | — | 未跑 | 未跑 | 无显式引用边 |
| CAP（美国） | — | 未跑 | 未跑 | API 已退役 |
| Curia（欧盟） | — | 未跑 | 未跑 | CELLAR 被 WAF 拦截 |
| ECHR Context-Aware | — | 未跑 | 未跑 | 仅 DataCite 元数据 |

两个关键实测：CourtListener 的未来案件在训练图中 **99.5% 完全孤立**（0% 出现在训练 subject、仅 0.5% 作为被引 object），这是纯引用图无法做归纳的结构原因；DataJud 时间感知嵌入模型（TTransE 式）test MRR 0.1953，删除时间槽的静态版 0.1784，差值 +0.017，且两者都低于频次基线 0.2166。

## 四、法规与时序 QA 域

### 4.1 ReCaRe（EU + 日本法规修订）

原始 91,361 行中只有 6,091 行是"前后版本都在"的真实修订事件；1.04 万部法、9.7 万条条文、340 部修订法、跨法关系（修订法→目标法）仅 504 条边。注意每条文最多被修订一次——这是一一配对，预测新版本等于预测一个全新 ID。

建图后 train 14,787 / valid 4,858 / test 3,789，12,438 实体，四关系。探针结果直接推翻"聚合可学"：

| 指标 | valid | test |
|---|---|---|
| raw | 0.0047 | 0.0040 |
| 洗牌 | 0.0144（高于 raw） | 0.0151 |
| popularity | 0.2537 | 0.2949 |
| random subject | 0.0477 | 0.0453 |

聚合的 0.25–0.29 全部来自 `has_change_type` 这一关系的 edge prior（`mod_--t` 占 66%，popularity 达 0.9277）；剥掉后 `amends_article` 0.0001、`part_of` 0.005，均为随机。

### 4.2 luatdo-graph（越南法规）

README 标称 10M–100M 规模，拆开后：文本快照 `has_version` 3,680,378 条、`contains` 4,360,083 条、`cites` 758,912 条；但真正的时序层只有 `temporal_versions` 2,031 个版本节点（带 from/to 有效期）与 `temporal_edges` 7,002 条（且边本身无时间列）。另有 9 张关系表为空（conflicts、act_participants、differs_from、involves、mentions、relations、about_concept、instance_of 等）。

### 4.3 CH-PiT（瑞士 Point-in-Time QA）

三语各 500 题，gold 与 distractor 均带 `date_applicability` / `date_end_applicability`。用"as_of 落在哪个版本有效期"的确定性规则评估，**de / fr / it 三语均为 1.000**（500/500）。官方报告分数面：closed ≈ 0、current（总用现行版）0.38–0.49、pit（按日期检索）0.94–0.96、agentic 0.94–0.98。

这意味着该基准测的是"日期区间过滤是否执行正确"，上限就是 1.0 且可由两条 `if` 达到，不存在留给学习方法的增益空间。

### 4.4 ChronoLex-TW

501 道四选一（随机基线 25%），答案分布 A 114 / B 120 / C 139 / D 128；Stable 343 / Shifted 158；字段含 `legal_date`、`gold_law`、`gold_article`、`gold_version_date`、`tau`。

两个硬障碍：**不含法条原文语料**（18 列中无条文文本），且 README 明确警示绝对准确率受公开真题污染影响，建议只报"答案准确率 + 条文命中率"分开。

### 4.5 其余

Version-Aware RAG（英国成文法，530 对问答、355 份历史快照，OGL v3.0）为 RAG 对照用；Legal Judgments KG（印度）只有 589 案件、34 法官、1,102 当事人、2,291 主题、446 法，`cites` 2,749 条，年份仅 2016–2017 两年，规模不足以做归纳切分；LexTime 512 样本、TempCourt 30 判决过小；TIDE 仓库查不到有效条目；SUPA 给定 DOI 返回 404；Lex API 是接口非数据集；LexKairos 需申请，按约定排除。

## 五、科研管理与学术活动域

| 数据集 | 规模（实测） | 建图结果 | 可学性 |
|---|---|---|---|
| coauth-DBLP | 1,930,378 作者 / 3,700,067 论文 / 10,304,422 作者位 / 1936–2018 | train 5,108,446 / valid 4,359,343 / test 1,818,947 边；训练图 1,058,404 作者；test 未见主体 53.6% | raw 0.0005（valid）/ 0.0002（test），popularity 0.0001 / 0，随机 5.46e-7 → 弱正、绝对值近零 |
| OGBL-COLLAB | 235,868 节点 / 1,179,052 边 / 1963–2017 | train 578,457 / valid 289,361 / test 311,234；test 未见主体 75.6% | raw 0.0024 / 0.0005，popularity 0.0019 / 0.0004 → 与先验持平 |
| SciSciNet-v2 | 结构最全（论文/作者/机构/基金/引用） | 未建 | **gated，HTTP 401**，无 token 无法下载 |
| PreScience | 373,716 行 / 44,990 target 论文 / 中位 4 作者、3 关键引用 | 见 5.1 | LLM 预测基准，非 KG |
| CORDIS org_cooperates | 37,923 实体 / 1,017,613 训练边 | — | 静态 0.0345，InGram 0.001 ≈ 随机 |
| OpenAlex 子图 | 7,994 / 6,417 / 3 时间步 | — | 0.0006 NOT_LEARNABLE（样本不足） |

其余：EUPRO 需申请；AMiner Dynamic Coauthor 无开放直链；coauth-MAG-History/Geology 与 DBLP 同源同构未重复跑；OpenAIRE API 早前无响应。

### 5.1 PreScience 的引用数预测

唯一不需要 LLM 就能测的任务是 12 个月引用数预测。44,990 篇 target 论文，引用数均值 5.53、中位 2、p90 12、最大 1132（重尾）。用作者 h-index、论文数、被引数、类别数、参考文献数等简单特征做线性回归：留出集 MAE 5.431，全局均值基线 5.505，**仅改善 1.3%**；秩相关 Spearman 0.34。

## 六、下游任务：合作者推荐（这是本文档最关键的对照）

按"TKGR 作为中间推理模块、下游任务做最终验证"的思路设计：图只用 2010 年之前的合作边，正样本取 2016–2018 新合作；候选只取训练图 2 跳邻域并排除已有合作者，因此每条推荐都是**从未合作过的对**（新颖对）。所有方法共用同一个排序器，只替换打分函数。

coauth-DBLP，2000 个测试作者，平均 378 个候选、1.7 个正样本：

| 方法 | Recall@10 | Recall@50 | NDCG@10 | MRR |
|---|---|---|---|---|
| random | 0.1043 | 0.3322 | 0.0552 | 0.0631 |
| popularity | 0.1415 | 0.4080 | 0.0783 | 0.0852 |
| common_neighbors | 0.2392 | 0.4938 | 0.1364 | 0.1422 |
| adamic_adar | 0.2454 | 0.5392 | 0.1420 | 0.1491 |
| 静态嵌入（DistMult） | 0.1114 | 0.3404 | 0.0584 | 0.0645 |

嵌入只比随机高 0.007；Adamic-Adar 是它的 2.2 倍。

按作者度数分层（Recall@10）：冷启动桶 deg≤5（n=440）中 popularity 0.3575、common_neighbors 0.4233、adamic_adar 0.4106、嵌入 0.2942——**冷启动下结构启发式依然领先嵌入**。

删掉 50% 训练边（模拟噪声/缺失历史）后，各方法绝对值因候选集变小而普遍上升，但看相对随机的增量：adamic_adar +0.215、common_neighbors +0.167、popularity +0.037、嵌入 +0.012。**嵌入在退化条件下仍是随机水平**，没有表现出鲁棒性优势。

### 6.1 PreScience 多关系对照

为回答"多关系是否值得"，用 PreScience 的三条关系建图：合作边（R1）、作者—类别（R2）、作者—被引论文共引（R3）。时间切分在图内：≤2024-03-31 建图，2024-04-01 至 2024-09-30 的新合作为正样本。

规模：306,045 篇有作者的论文、训练对 1,780,508、测试对 379,460、279,879 节点、26,476 个评估作者、平均候选 521.7（已对每篇论文作者数设 ≤15 的上限，否则大作者列表会让边数爆炸到 6,236 万）。

| 方法 | Recall@10 | Recall@50 | NDCG@10 | MRR |
|---|---|---|---|---|
| popularity | 0.0756 | 0.2533 | 0.0410 | 0.0523 |
| common_neighbors | 0.2427 | 0.5157 | 0.1529 | 0.1717 |
| adamic_adar（R1） | 0.2588 | 0.5496 | 0.1624 | 0.1791 |
| cat_jaccard（R2） | 0.0891 | 0.2948 | 0.0499 | 0.0633 |
| cocite（R3） | 0.1009 | 0.2945 | 0.0586 | 0.0731 |
| 等权组合（R1+R2+R3） | 0.2061 | 0.4777 | 0.1261 | 0.1444 |

新增两条关系单独使用时都不到 AA 的一半；等权组合反而比 AA 低 0.053。这说明主效应来自合作结构，主题与共引提供的信息与共同邻居高度重合，平均融合只会稀释。

必须注明这是"等权归一化融合"，不是训练好的权重。一个学得好的模型可以把 R2/R3 权重压到接近零，但那样它就退化为 AA，不会超过 AA；要让多关系有价值，需要 R2/R3 在某个切片上强于 AA（例如无共同邻居的跨领域合作），本次整体统计中没有出现。

## 七、失败模式归纳

四轮实验的结论可以压缩成五条可复用的判定：关系稀疏（ReCaRe 跨法边 504 条、Legal Judgments KG 589 案两年）；时间确定性（CH-PiT 区间规则 1.0）；尾空间封闭导致先验通吃（DataJud 333 类事件、ReCaRe `mod_--t` 占 66%）；单关系图无子图结构可用（CORDIS、coauth、OGB 均学不过频次或共同邻居）；基准依赖 LLM 栈（PreScience、CH-PiT 的 agentic 评测）。

这五条正好构成方法设计的反面清单：一个 TKGR 方法要显示出价值，必须落在关系非稀疏、时间非确定、尾空间开放、且信号不可被频次或共同邻居替代的场景。

## 八、产物与复现

数据与结果均在 gpu-master `/workspace/03_data/`：

- `case_valid_prep/`：14 个司法数据集的静态/归纳结果、`runs/diag_verdict_2026-11-01.json`、`runs/verdict_summary.json`；
- `legal_tkgr/`：`recae/`（metadata + corpus en/ja）、`recae_cites/`（建好的四元组）、`luatdo/`、`chpit/`、`chronolex/`、`ljkg/`，以及 `recae_probe.json`；
- `research_tkgr/`：`coauth/`、`coauth_cites/`、`ogbl/`、`ogb_cites/`、`prescience/`，日志 `coauth_probe.log`、`ogb_probe.log`、`downstream.log`、`downstream_drop50.log`、`prescience_multi.log`，结果 `prescience_multi_downstream.json`；
- 脚本在 `03_data/*/` 与 `03_data/case_valid_prep/scripts/`：`build_datajud_events.py`、`build_coauth_tkg.py`、`build_recae_tkg.py`、`probe_cites.py`、`downstream_collab_rec.py`、`prescience_multi_downstream.py`。

关键复现命令：

```bash
# 通用探针（三道对照 + 关系级分解）
python3 probe_cites.py --data <DIR> --name <NAME> --epochs 30 --eval-sample 3000 --gpu 0

# 合作者推荐下游（含分层）；EDGE_DROP=0.5 为噪声条件
python3 downstream_collab_rec.py            # 全图
EDGE_DROP=0.5 python3 downstream_collab_rec.py

# PreScience 多关系对照
python3 prescience_multi_downstream.py
```

## 附录：边界与未完成项

- SciSciNet-v2 为 gated（401），未取得；其结构最全，若日后拿到 token，值得重做一次多关系对照。
- EUPRO 需申请，未获授权；AMiner Dynamic Coauthor 未找到开放直链。
- PreScience 官方 baseline 依赖前沿 LLM，本环境无 LLM 栈，未复现其 LARCER/agentic 数字；本文档只用它做了不需要生成的引用数预测与多关系结构对照。
- ChronoLex-TW 缺法条原文语料，且受公开真题污染，未做端到端问答评测。
- 所有嵌入类基线都是无特征、单次训练的 DistMult，未做超参搜索；但更早的 15–30 轮探针与时间消融（+0.017）表明这不是训练不足造成的假象。

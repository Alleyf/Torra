# icews14_RAW_full_seed{SEED}

**目标**：在 fcs 上跑 **MEM-RAW（E3 把写内容换成不加投影的 chain 表示）** 的正式臂，判定 E3 的记忆内容里那个冻结的随机投影到底带不带信息。
**假设/预期**：L51 实测写算子全程 `grad=None`、`raw_decay` 恒 2.0，E3 的记忆是「冻结随机投影 ○ chain/relation 表示」。若投影只是换个基底，去掉它应与 E3 等价（|ΔAll| < .005）；若投影携带可用信息，去掉会掉 ≥ .009。依据：档案 §14.16 预注册。

## 模型与出处
模型：AdaTKG-EMA + E3 候选侧记忆读；写内容 `avg` 直接取 chain 表示（`--mem_content raw`），不经过 `interaction_encoder`；读门、候选侧读、decay 全部与 E3 相同。
代码：`/workspace/01_code/tkgr/adatkg_p1_raw`（E3 树副本 + `--mem_content {proj,raw}`，零新增参数）。协议 `icews14_p1_fcs_raw` v1（hash=3f3c16492bf9b36a），variant `mem_raw`（n_keys 166）。
论文：无直接对应文献；这条是自查实验，检验本报告 §14.15 的发现对 E3 机制解释的影响。

## 来路
族：`tkgr/adatkg/raw_clean`，父臂为 `e3_clean`（E3，三 seed PASS：All .4205 / Emg .2070 / Unk .2475）。
关系：variant（E3 的写内容变体）。
这次生效的关键开关：epochs=60 · patience=10 · history_len=14 · split_ratio=30 · seed={SEED} · cand_mem_read=on · mem_content=raw（依据：gate 最终 argv）。

## 怎么跑
环境：conda `transfir`；主机 fcs-gpu-pod-t4；单卡（严格空闲判定后自动分配）。
数据：`/workspace/03_data/ICEWS14`，re_split 0.5/0.2/0.3。
耗时：约 2.5–3 h，与 E3 同量级（少一个写侧前向）。
原样命令见 `launch.sh`。

## 配置
与 E3 完全同配置（dataset ICEWS14 · enhancement ema · update_timing before · y_mode off · z_mode off · chain_dropout 0.15 · cand_mem_read on），只把写内容换成不加投影的 chain 表示（mem_content raw），零新增参数。

## 结果
未跑（开跑前）。计划三 seed（42/43/44）做方差；先 42 试点。判据（vs E3 同 seed 配对）：
- `|ΔAll| < .005` 且 3/3 同号 → 投影不带信息增量，E3 的机制叙述改为「暴露历史」；
- `ΔAll ≤ −.009` → 投影携带可用信息；
- `ΔAll ≥ +.009` → 投影是噪声，直接替换 E3 的默认写内容。

## 结论与遗留
- `mem_content=proj` 与 E3 逐位等价（CPU 单测 `max|diff|=0`），本臂只改一个数据流。
- 若结果落在「等价」分支，LMW（可学习写）的预期收益也应下调——内容本身可能根本不重要。
# icews14_LMW_full_seed{SEED}

**目标**：在 fcs 上跑 **LMW（E3 + 有界可学习记忆写算子）** 的正式臂，与 E3 同 seed 配对裁决。
**假设/预期**：在线记忆的写侧从来没训练过（`interaction_encoder`/`raw_decay` 梯度恒为 None，`raw_decay` 恒 2.0），记忆内容是固定的随机投影；把写算子变成可学习应能让记忆内容对齐读侧用途。预期 ΔAll ≥ +.009、ΔEmg ≥ −.005，3/3 同号；`update_count==0` 的行必须逐位不变。依据：档案 §14.15 预注册；TGN（arXiv:2006.10637）与 JODIE 的 message/update 函数都是学出来的。

## 模型与出处
模型：AdaTKG-EMA + E3 候选侧记忆读 + 写侧有界残差算子 `content = avg + tanh(MLP([m_old, avg]))·RMS(avg)`，`m_new = d·m + (1−d)·content`；MLP 末层零初始化，初始化时与 E3 逐位相同。
代码：`/workspace/01_code/tkgr/adatkg_p1_lmw`（E3 树副本 + `--learned_write {off,on}`）。协议 `icews14_p1_fcs_lmw` v1，variant `lmw_write`（n_keys 172 = 166 + write_mlp 5）。
论文：TGN arXiv:2006.10637；JODIE arXiv:1706.04578。

## 来路
族：`tkgr/adatkg/lmw_clean`，父臂为 `e3_clean`（E3，三 seed PASS：All .4205 / Emg .2070 / Unk .2475）。
关系：variant（E3 的写算子变体）。
这次生效的关键开关：epochs=60 · patience=10 · history_len=14 · split_ratio=30 · seed={SEED} · cand_mem_read=on · learned_write=on（依据：gate 最终 argv）。

## 怎么跑
环境：conda `transfir`；主机 fcs-gpu-pod-t4；单卡（严格空闲判定后自动分配）。
数据：`/workspace/03_data/ICEWS14`，re_split 0.5/0.2/0.3。
耗时：约 2.5–3 h（与 E3 同量级，写侧 MLP 只有 1.77M 参数）。
原样命令见 `launch.sh`。

## 配置
dataset ICEWS14 · enhancement ema（update_timing before）· y_mode off · z_mode off · chain_dropout 0.15 · cand_mem_read on · learned_write on。

## 结果
未跑（开跑前）。预期 ΔAll ≥ +.009、ΔEmg ≥ −.005（vs E3 同 seed 配对）。**先 42 试点，桶/曲线正常再补 43/44**。
收口时从 `full.log` 的 `[Test]` / `[Test Emerging]` / `[Test Unknown]` 取最佳验证 epoch 快照。

## 结论与遗留
- v1（无界残差加在 `m_new` 上）已证伪：39 步内记忆 0.13→8e2、44 步 NaN；v2 有界式同配置 190 步稳定（`mem_absmax≈0.85 / norm≈2.0`）。
- 若 ΔAll < 0：固定随机投影已是足够好的写内容，写侧路线整体降级为背景。

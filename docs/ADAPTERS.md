# 站点适配器与通道排查

> 从 README 迁入。适配器是 Torra 复用网页版 LLM 订阅的核心机制。

## 新增站点：只加一个 YAML

新增站点只需往 `adapters/` 放一个 YAML，**不改主程序任何代码**：

```yaml
id: chatgpt
name: ChatGPT
transport: webview
entry: https://chatgpt.com/
selectors:
  input: 'div[contenteditable="true"][role="textbox"][aria-label*="ChatGPT" i], textarea[placeholder*="ChatGPT" i], textarea#mobile-composer-prompt, #prompt-textarea'
  send: 'button[aria-label*="Send message" i], button[aria-label*="发送消息"], button[data-testid="send-button"]'
  stream: 'div[data-message-author-role="assistant"]'
  stop: 'button[aria-label*="Stop" i], button[aria-label*="停止"], button[data-testid="stop-button"]'
completion:
  mode: stop_button_hidden
  timeout_s: 120
automation:
  typing_delay_ms: [80, 220]
  pre_send_pause_ms: [500, 1500]
  max_wait_s: 120
  jitter: true
health_probe: 'div[contenteditable="true"][role="textbox"][aria-label*="ChatGPT" i], textarea[placeholder*="ChatGPT" i], textarea#mobile-composer-prompt, #prompt-textarea'
verified_at: '2026-10-01'
```

适配器目录被监听，改动后自动热更新，无需重启客户端：spec 在注册表内**原地替换**，
`WebviewAgent` 与后台 WebView 持有同一对象，下一次发言即用新选择器；`entry` 变了则重新导航，
站点同源时不打断当前页面；YAML 删除即摘除该适配器，左栏健康标记同步刷新。
校验不通过的 YAML 会被拒绝并保留旧 spec，不会把运行时带坏。

## 哪些字段是必填的

聊天模式的「原生」视图只**投递**，回答留在站点自己的页面上，因此它只用到
`entry` + `selectors.input`（`send` / `stop` 有则更好，用于点发送与判停）。
「提取」和研讨模式要多读一步正文，才需要 `selectors.stream`（回复容器）与 `completion`（判完口径）。

于是适配器有两种合法形态：

| 形态 | 必填 | 能跑什么 |
| --- | --- | --- |
| 只配投递 | `input` | 聊天模式·原生 |
| 投递 + 读回 | `input` + `stream` + `completion` | 原生、提取、研讨模式 |

`stream` 与 `completion` 必须成对出现：只给 `stream` 等于没定「什么时候算写完」，
只给 `completion` 则没有可读的容器 —— 两种都会被校验拦下，报错里点名缺哪一个。
只配投递的适配器在提取/研讨下会直接给出「该适配器只支持原生模式」，
而不是跑完一轮再回一句「未捕获到内容」（那是最难查的一种假故障）。

## 点左侧的问题，让右边那一格滚到那一问

聊天模式的原生视图里，网页模型没有本地卡片，正文留在站点页面上。于是「回到第 N 问」这件事
必须有两条路，因为它们各自的失败原因完全不同。

第一条是页内定位：把这一问的原文在当前页面上找出来，滚到视野中间。难点不是找不到节点，
而是**找错节点** —— DeepSeek 实测会把问题原文加粗复述在回答第一行，侧栏的历史条目也写着同一句
（但那格宽 0），输入框里可能还残留着上一句。注入脚本 `__torra.locateTurn` 因此把落在
`selectors.stream` 与 `selectors.input` 子树里的命中一律排除，零尺寸的节点同样不算。

第二条是会话指针。ChatGPT / DeepSeek 的消息列表是虚拟化的，DOM 只挂最近一两个回合
（见 `adapters/chatgpt.yaml` 的注释），更早那轮根本不在页面上 —— 这时定位失败不是选择器写错，
重试和体检都修不好。所以原生投递完成后主进程顺手记下站点自己的会话 URL（路由是发送之后才换的，
URL 还停在入口就等一小会儿，拿不到就照实当「没有指针」），存在这一格上。点旧问题时先在当前页面找，
找不到就把这格导航回那一场会话再找一次：那轮在那个城市里正是最新一轮，必然挂着。
这一步只认与适配器入口同源的地址 —— 指针存在可改写的会话存档里，不能当任意跳转的授权。

`selectors.user_turn` 就是为第一条路准备的可选精确档：站点给「用户自己说的话」留了稳定特征时，
配上它，定位只在这批气泡里找，不再启发式扫全文本节点。元宝实测 `[data-conv-speaker="human"]`
稳定（还带 `data-conv-idx` / `data-conv-id`）。DeepSeek 的用户气泡只有 CSS Module 哈希类名，
换一次构建就变，因此**不配** —— 让它走排除式启发，结论里 `mode` 会写明走的是哪一档，
站点改版时才知道该去补哪个字段。没核验过的站点不要凭猜配这一档。

站点改版时才知道该去补哪个字段。没核验过的站点不要凭猜配这一档。

## 点「另起一场」时，网页那几格发生了什么

同一屏的原因：原生模式下上下文住在站点那一页，只把本地这场换掉，DeepSeek 和元宝照旧带着
上一场全部内容回答这一题。所以输入坞那颗按钮（和折叠会话栏里的「新对话」）是同一个动作的两个入口：
本地新建一场，同时把在场的每一枚网页面板导航回适配器声明的 `entry`。旧的会话不删、不弹确认，
原样留在列表里点得回去；输入框里的草稿也不清 —— 按这颗按钮的人，下一个问题多半已经打在框里了。

三条克制写在 `openFreshConversation` 里，和 `webview:reload` 是同一条规矩：实例不在场就空操作
（不为用户根本没在看的那一页拉起一枚 WebView）；只换地址不 recreate（换掉整份 WebContents 太重，
分区里的登录态不该为换个地址陪葬）；这一格正在发言时不动它（半途换页等于把正在跑的轮次抽走，
宁可回一句「等这轮结束」）。判定用的是「同一个页面」而不是「同一个站」—— 上一场的会话页和入口
同源却不是同一页，按同源短路会让这颗按钮在最常见的情形下一件事也不做。

要说清这颗按钮承诺了什么：它承诺回到 `entry` 那页，不承诺站点必然开一场新的。
`claude.ai/new` 这类路径名已经写明了是新建，其余各家要逐家实测才算数。
已核验的两家（2026-10-20，Torra 内真机）：DeepSeek 从上一场的会话页回到 `https://chat.deepseek.com/`
之后是「你好，让我们开始聊天吧」的空场；元宝声明的入口是站点根 `https://yuanbao.tencent.com/`，
导航过去之后 SPA 自己落到 `/chat/naQivTmsDa`，页面上是「今天能帮你做什么？」加推荐卡片，
上一场的消息没挂回来。也就是说这两家的入口页就是新场。
元宝这一家顺带核验了「回到入口」到底做了什么：点之前 CDP 里那枚页面 target 的 id 是
`64CD7823…`，点之后还是同一枚 —— 实例没有被 recreate，换掉的只是地址；而它自己的
`performance` 里多出一条 `navigate` 记录（文档传输量从 0 变成 300 字节），说明这确实是一次真的
文档导航，不是路由假切。落地地址仍是 `/chat/naQivTmsDa`：站点把根路径重定向到自己的新场页。
ChatGPT / 豆包 / Kimi / 千问 / Gemini / Claude **尚未在真机逐家核验**，不要当既有结论用。
真要「必然新场」，得给适配器补一枚实测过的「新建会话」按钮选择器再点它 —— 本仓库现在没有这个字段，
凭猜点错元素比不点更糟。

## 排查「适配器失效 / 选择器丢失」

`input selector missing` 有三种截然不同的成因，**不要一上来就改选择器**：

| 真实成因 | 判别依据 | 正确处置 |
| --- | --- | --- |
| 该分区未登录 | 页面存在 `<form action=".../auth/login_with">` | 在 Torra 内重新登录 |
| 站点改版 | 已登录但输入框选择器不存在 | 更新 YAML 选择器 + `verified_at` |
| 页面还没渲染完 | SPA 延迟挂载输入框 | 等待，已由 `waitFor` 处理 |

键入与发送阶段还有四条各自独立的结论，混成「适配器失效」就没人能修：

| 回执 | 含义 | 处置 |
| --- | --- | --- |
| `input not visible` | 选择器命中的节点都在页面上，但一个都没画出来（引导态与会话态常是两套 DOM） | 把这一格切到前台确认 |
| `composer holds previous text` | 上一轮的话清不掉 —— Lexical / Slate 只认浏览器级删除，DOM 侧怎么抹都渲染回来 | 主进程会先按一次 Ctrl+A + Delete 再重试；仍失败就在网页里手动清空输入框 |
| `input did not keep the prompt` | 站点拒收了这次写入（自己清空、或只吃下前半截） | 在网页里手动发送，或改用 API 模型 |
| `login-required` | 键入前就已经是登录 / 人机验证那一屏 | 在 Torra 内重新登录该站点 |

`generation did not start` 与 `composer holds previous text` 都不把适配器标成失效：
前者多半是上传期间 Enter 被吞，下一轮往往就好；后者是编辑器不让 DOM 删，选择器并没有指错。

用只读诊断确认属于哪一种：

```bash
npm run diagnose:webview chatgpt
# 输出 docs/diagnose-chatgpt.json：
#   samples[].bodyText        页面正文（含「登录」即未登录）
#   samples[].loginWallEls    登录墙命中的具体元素
#   samples[].candidates      各类候选选择器命中数
#   samples[].editables       页面全部可编辑区域 —— 站点改版时据此更新 YAML
#   cookies                   仅统计数量与认证类 cookie 名，不导出凭据
```

诊断使用与主进程相同的 partition，读到的是同一套登录态，结论可信。

## 登录态持久化与自动检查

登录态存在 `persist:torra-<modelId>` 分区，**重启后自动恢复，无需重复登录**。
启动流程：

1. 预热各分区的后台 WebView（按分区恢复会话）
2. 等各实例 `did-finish-load` + SPA 挂载延迟后探测真实登录态
3. 已登录的分区**强制 flushStorageData** 一次（修复历史遗留的未落盘凭据）
4. 一次性汇报盘点结果：`已恢复 N/M` + 需重登的站点清单

两个关键机制（缺一个就会出现「重启又要重登」）：

| 时机 | 动作 | 原因 |
| --- | --- | --- |
| 登录判定为成功时 | `flushStorageData()` | Chromium cookie 走延迟写缓冲，不主动刷会随进程退出丢失 |
| 应用退出前 | `before-quit` 里 `flushStorageData()` | 同上；必须在 `window-all-closed` 之后拦住，否则缓冲随进程消失 |

自检与排查命令：

```bash
npm run list:cookies              # 列出各分区 cookie（仅名称/域/过期，不输出值）
npm run domcheck chatgpt          # 加载页面直接读 DOM 判断登录态（最可靠）
npm run snapshot:partition deepseek-web
npm run verify:flush              # 验证刷盘链路（写入探针 cookie → flush → 重读）
```

> **诊断脚本必须显式设置 userData**：`app.setPath('userData', .../Roaming/torra)`。
> 否则 `electron scripts/xxx.js` 会落到 `Roaming/Electron`（Electron 默认名），
> 读到的是另一套空分区，结论完全无效 —— 这个坑曾导致误判「登录态已丢失」。

## 状态灯颜色含义

左栏头像右下角的圆点反映该通道的**真实可用性**，启动后与登录完成后各探测一次：

| 颜色 | 状态 | 含义与处置 |
| --- | --- | --- |
| 绿 | 就绪 | 页面已加载且输入框存在，可以发言 |
| 橙 | 发言中 | 正在生成 |
| 红 | 会话过期 | **该分区未登录**，点头像在 Torra 内重新登录 |
| 红 | 适配器失效 | 已登录但选择器失效 —— 站点改版了，需更新 YAML |
| 灰 | 已禁用 / 未配置 | api 型表示**没配 API Key**（不是登录问题）|

红点统一表示「不可用」，两种成因靠悬停提示区分 —— 都先别用它，
但一个要重新登录、一个要改选择器。

> **状态灯必须在登录窗口关闭后才更新。** 登录窗口与后台实例是两个独立
> WebContents：后台实例在登录前就加载完了页面，不会因另一个实例写入 cookie
> 而自行重渲染。Torra 在登录窗口关闭时会自动 reload 后台实例并复核状态；
> 若状态仍不对，点提示条上的「刷新状态」手动复核。
>
> 登录态保存在 `persist:torra-<modelId>` 独立分区，与日常浏览器完全隔离。
> 在 Chrome 登录 DeepSeek 对 Torra 无效 —— 必须点左栏头像，在 Torra 内登录。

> ⚠️ **合规前提**：驱动网页版 LLM 可能触发平台风控甚至封号。Torra 不提供任何规避验证码
> 或风控的手段，检测到人机验证时立即停下并引导用户手动接管。首次启动会展示风险确认墙。
> 接入新站点前请确认其服务条款对自动化访问的态度。

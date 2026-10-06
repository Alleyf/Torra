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

## 排查「适配器失效 / 选择器丢失」

`input selector missing` 有三种截然不同的成因，**不要一上来就改选择器**：

| 真实成因 | 判别依据 | 正确处置 |
| --- | --- | --- |
| 该分区未登录 | 页面存在 `<form action=".../auth/login_with">` | 在 Torra 内重新登录 |
| 站点改版 | 已登录但输入框选择器不存在 | 更新 YAML 选择器 + `verified_at` |
| 页面还没渲染完 | SPA 延迟挂载输入框 | 等待，已由 `waitFor` 处理 |

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

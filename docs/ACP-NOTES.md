# ACP 接入细节

> 从 AGENTS.md 下沉的工程细节。产品层面的推理与取舍见 [FEATURES.md](FEATURES.md) 的
> 「外部编码智能体：插拔接入」「一份真源：词、身份、续聊」「会话工作树」三节。

## 协议边界

Torra 是外部编码智能体的**客户端**，不是某一家 agent 的实现者。`src/main/acp/` 只说
ACP（JSON-RPC 2.0 over stdio NDJSON），除此之外什么都不说。没有 per-agent shim ——
adapter 来自生态：`@agentclientprotocol/claude-agent-acp`、`@agentclientprotocol/codex-acp`、
`pi-acp`、opencode 自带的 `acp` 入口。

`registry.ts` 存内置四家，**锁 adapter 版本**（它们跟着上游走，所以矩阵按 id + version 认格子）。
用户自己加的条目落在 `<userData>/torra/acp.json`，按 id 覆盖内置。

`matrix.ts` + `matrix-data.json` 是实测出来的兼容矩阵。一个版本没有格子就写「未验证」，
绝不借用别的版本的结论。刷新：`npm run test:acp -- --live --write-matrix`。

`mcp.ts` 把 Torra 自己的工具经 MCP 交给 agent（127.0.0.1，每会话一个 token）。
工具定义只在 `src/main/assistant/tools.ts` 写一次，变的是出口。

## 目录（catalog）

`catalog.ts` 记的是「能接什么」：十一条精选项，加上官方 ACP registry
（`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`，43 个 agent），
再加上 PATH 探测。

压过其他一切的一条：**Torra 从不安装任何东西**。「装了」只有唯一含义 —— 启动命令在 PATH 上。
不在 PATH，卡片就显示那条确切的安装命令，由用户自己跑。

官方 registry 说的是**它自己的平台词**（`windows-x86_64` / `darwin-aarch64` / `linux-x86_64`），
不是 Node 的 `process.platform`（`win32`）。`platformKey()` 负责翻译；漏了这一步，
所有按平台分发二进制的 agent 都会读成「这个平台没有构建」。

官方图标在**主进程**抓取，以 `data:` URI 交出去 —— 渲染层 CSP 不放这个 CDN，
白名单加上去等于允许任何页面从这个 CDN 拉图。

`OFFICIAL_ID_TO_TORRA_ID` 把 registry 的 id 对到 Torra 的 id
（`claude-acp`→`claude`、`codebuddy-code`→`codebuddy`、`opencode-v2`→`opencode`）。
没有这张表，工作台里会出现两个 Claude。

## 工作台的改动从哪来

工作台是导航区（`编码`），不是抽屉：左轨智能体与会话、中间正文带折叠步骤、右侧改动对照。
改动只从 ACP 的 `diff` content block 来 —— `toolOutputParts` 抬出 `{path, oldText, newText}`，
`acpLines.ts` 折到步骤上（同一路径后写覆盖前写），`sessionEdits` 喂审阅面板。
行数用多重集比较，所以等长改写读成 +1 −1。

## 宿主词表与身份闸

`src/shared/host.ts` 是任何 harness 协议与 UI 之间唯一的一套词：`HostEvent`
（turn / message / item / plan / usage）、唯一一份归约 `applyHostEvent`、续聊结论 `judgeResume`。
主进程与渲染层共用那一份归约，渲染层永远看不到裸 ACP payload。

`src/main/acp/host.ts`（`AcpHostProjector`）把 ACP 投成 Host 事件，**实时与回放走同一条代码路**
（`{ replay: true }`）。回放里 agent 回显的用户那轮变成 `user.delta`；实时时丢弃，
因为用户那一行已经由 Torra 自己的 `turn.started` 出过了。

**身份闸**：一轮能持久，前提是 harness 交出它自己的原生 key。`readNativeTurnRef` 从 `_meta`
尾部键读；`looksUnstableTurnRef` 拒位置型 key（纯数字、`replay-1`、`turn-2`），
因为那种值每次读都在变。UUID 不按形状拒 —— 要靠跨进程比对才定得下来。
`judgeResume` 的结论是 `durable` / `history` / `none`，来自实测矩阵格子，不来自运行时猜测。

**单一真源**：回放读回非空正文时，本地正文删掉，会话记录降级成**只有索引**（`harnessOwned: true`）
—— 正文归那一家保管，Torra 只留谁/哪家/何时/session-id。防抖保存必须查这个 flag，
否则会把正文写回去，第二个真源就悄悄回来了。

守着这件事的回归测试：关掉客户端，开**新的**一个，续聊，读快照 ——
续上来的 `nativeTurnRef` 必须和实时那个相等（`npm run test:acp`，用例名「关掉进程再接着聊」）。

## 为什么这条路不装第三方 ESM

ACP 这条路不装载任何第三方 ESM：传输层是手写的（`jsonrpc.ts`），工具参数就是普通 JSON Schema
（`src/shared/tool.ts`）。一个测试扫 ACP 的 import 闭包来强制守住这件事。

原因在主进程那一侧：主进程构建是 CommonJS，启动路径上碰一个 ESM-only 依赖就在启动时
ERR_REQUIRE_ESM 死掉 —— pi 的 SDK 干过这件事（Node 20.18 上一个 undici `markAsUncloneable` 补丁）。
其他真需要 ESM 包的东西属于 `utilityProcess`。

内置助手目前仍然**在进程内**跑 pi（`src/main/assistant/pi-sdk.ts`，一个 ESM loader）。
它还没有退役：ACP 至今没有「插话」，而 `pi-acp` 会丢掉 MCP 声明，
换成 pi 托管的助手会失去 Torra 自己的工具。

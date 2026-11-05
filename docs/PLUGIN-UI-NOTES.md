# 插件与面板界面细节

> 从 AGENTS.md 下沉的工程细节。产品行为叙述见 [FEATURES.md](FEATURES.md)。

## 插件内核

面板/工具/提示词以 `torra-plugin.json` + `main.js` + `ui.html` 三件套发布。
内置插件在 `plugins/<id>/`（`research` = 科研工作台，四区外壳盖住
`modules/{scholar,trajectory,server}`；`tech` = 技术工作台，带 AIHOT 热点）；
用户安装（目录或 zip）落在 `<userData>/plugins`，并在 设置 → 应用 里列出。
打包需要 `asarUnpack: plugins/**` —— ESM 插件的 main 没法从 asar 归档里 import。

`main.js` 跑在 `utilityProcess` 里，给的是崩溃隔离，不是安全沙箱。宿主调用按权限逐个闸：
`storage`、`panel`、`tools`、`secrets`、`ai`、`net:<host>`。

`ai` 只走带 Key 的 API 模型：模型只做判断与起草，检索和落库都在插件进程；
结果先预览，用户确认后才写入。

面板是顶层导航页：入口在标题栏里挨着内置区，面板占满内容区，是一个沙箱化的
`torra-ui://frame` iframe，里面注入 `window.torraPlugin` SDK（`call`、`onTheme`）桥到主进程；
URL 上带一个绑到插件 id 的短命 token。面板里 `target=_blank` 是死的（沙箱帧），
外链要走 `host.open_external`，它在系统浏览器里打开 http/https。

插件工具追加在助手工具白名单之后，名字前缀 `${pluginId}_`；同一份工具集也是 ACP 的 MCP
服务器交给外部 agent 的那一份（一处定义，两个出口）。manifest 权限漂移会自动停用该插件。

合并型插件给自己的模块加 namespace：存储键 `module:key`、RPC 名 `module.rpc`、
工具名 `${pluginId}_${尾部}`。模块 UI 超过面板上限时经 `host.asset` 流进来，
挂在嵌套的 `srcdoc` 帧里，把 `torra:call` 往上传。

## 科研工作台的样式约定

外壳 `plugins/research/ui.html` 出一份 `:root`，装载模块时把 `style#rw-tokens` 注入
scholar / trajectory / server 三个嵌套文档，**改色板与字号只改外壳一处**。
模块里出现 `--x: #色值` 就是第二块屏幕 —— `npm run test:contrast` 每次跑都查，不靠记得加参数。
技术工作台（日历）是另一件产品，保留自己的青绿 register，但过同一道门槛：核对器量两套色板，
而不是禁止它有色板。

墨色四档（ink / ink-2 / ink-3 / ink-4）要在纸面、卡片、次级面、凸起、左轨**五块底**上都过 4.5:1，
浅底徽标上的字按 soft 混色后的真底量。语义只有四个色相，各占一个：accent 冷蓝、hot 红、
amber 黄、ok 绿，两两相差 ≥20° —— 从前 accent 与 amber 只差 2°，主色和警告是同一个颜色，
整屏看过去就是一片黄。压在色块上的字（`*-contrast`）同门槛，别让它自己挑一个 `#fff`。

描边按角色分档，从上往下逐档变轻：控件边界 3:1（`--p-border`，只给空着的输入框、下拉、
文本域——它们没有别的线索说明自己是个控件）、主分隔与浮层的边 2:1（`--p-line`，顶栏底线、
toast / 模态 / 命令面板的边、带字标签的按钮轮廓）、卡片面片的整圈边与行、格的重复细分
1.33:1（`--p-line-soft`，模块里叫 `--s-card-line` / `--tj-card-line`）。
卡片面片的边从 2:1 降到卡片档是这一版的要害：一圈 2:1 的硬边，再叠上每行一条发丝线，
整屏读起来是方格纸而不是面板——层次交给底色台阶与那层很淡的 `--rw-sh-1`，不靠描边喊。
模块可以起本地别名（`--s-control` / `--tj-card-line`），但别名必须指回对应来源，
指错就等于满屏重新长出一圈硬边 —— 这三条（别名来源、卡片档、输入控件落在控件档）都钉在核对器里。

字号只有五档：14 / 13 / 12 / 11 / 标题 21（`--rw-t-title`，配 `--rw-track-title: -.01em`，
标题靠字号与字距立住，不靠加粗到 700）。圆角三档 + 胶囊，内层永远小于外层：容器
`--rw-r-card` 10 / 控件 `--rw-r-ctl` 8 / 内层 `--rw-r-sm` 6，徽标与胶囊一律 `--rw-r-pill` 999。
旧值 4 / 3 / 2 让所有面片近乎直角，正是「太方正」的第一层来源。
行列表不再每行一条发丝线：行与行靠 6px 间距说话，行本身给 `--rw-r-sm` 圆角与 hover 底色。
行列表如果用了 grid，**栏数必须等于行里的件数** —— 删掉「逐行编号」时忘了改
`grid-template-columns`，正文就落进那条 20px 的缝，整列标题一个字一行往下掉；
样式表完全合法，颜色、残留、指空 var 三条都查不出来，只有真看一眼才发现，
所以这条也在核对器里钉着（栏数从赢的那条声明数，件数从渲染函数的行模板数）。
卡片那一层给很淡的 `--rw-sh-1`，再往上的阴影只给真的浮起来的那一层（抽屉、浮窗、日志面板）。

科研工作台的这套语汇有一份外部参考：研究主线与文献资料的阶段条（圆点 + 连线，跑完绿 /
当前 accent）、状态描边胶囊、以及「视图切换是文字 + 下划线、不是一整块实心色」，
都对着 [dsh-scholar](https://github.com/lzszq/dsh-scholar)（MIT）的界面收的 ——
只借观感与交互，不搬代码；实验机器那一屏不在这次参考的范围内。

数字一律 `tabular-nums`；实验表的数字列右对齐，判定看单元格不看表头（`mdNumCols`），
作者显式写了 `:---:` 时按作者的来。四份界面的字体栈只有一套：`--rw-sans`（Inter）
与 `--rw-mono`（JetBrains Mono），兜底链也一起走，不留各写各的 Helvetica / IBM Plex。

一个面板的 `<style>` 里是两个 register：深色基础规则在前，后面的 `:root` 浅色靠源码序胜出。
往一处加的任何规则（布局、颜色、浮层的底）都要在另一处镜像或显式覆盖 ——
`npm run test:css-dead-rules` 只能捞到 leftovers，捞不到漏写的那一半。

## 会话工作树

`src/renderer/workTree.ts` 是纯函数：由 HostItem 投影出节点（`session:` / `turn:` / `step:` / `deliver:`）、
缩进式竖排布局、节点差与光线计划，`scripts/test-work-tree.ts` 直接加载它，不依赖 DOM。

工作树是**投影，不是第二个存储**：节点全部从台账（HostItem）推导，所以没有任何东西只活在动画里。
边和光线按语义 id 解析（`session:` / `turn:` / `step:` / `deliver:`），
不靠坐标、也不靠「最近的节点」—— 猜parent这件事恰好只在并行分支上出错，而且错得无声。
变绿不等于「已合并」：只有真实完成才写 `mergeInto`。
光线由**节点表的差**触发，另有一个 flag 标记整体替换（切会话 / 读历史），
这正是让重渲染和历史加载不再重放光线的东西。

`src/renderer/components/WorkTreePanel.tsx` 是右栏那棵树（聚焦/全部、跟随、演示开关、交付文件卡）。

## 光线

全项目只有 `src/renderer/lancerLight.ts` 这一套光线：`createLightLayer(svg)` + `layer.emit(...)`。
单 rAF、空闲停帧、页面隐藏冻结、卸载清理、`prefers-reduced-motion` 降级成一条静止的线
（不是更快的一条）。每帧只改 SVG 属性，不经 React —— 一次 1.2 秒的飞线会重渲染那棵树约 70 次。
路径由事件 id 播种（同一事件同一弧线，每帧的随机只是抖动）。

## 研讨屏的右栏

右栏从上到下三块，顺序是「此刻 → 台账 → 跑动」：

- **此刻**（`src/renderer/components/NowCard.tsx`）讲中间区正在讲的那一条。
  读法优先级 `focus`（点一下锁住）→ `hover`（指针压着）→ 最新一条发言。
  锁定与悬停在视觉上是两种状态：悬停是虚轨、不扫光，锁定是实轨、换人扫一道铜线 ——
  不分开的话，用户分不清「我点过了」和「我只是路过」，而这是右栏所有动作的来源。
- **结论台账**（`ConsensusPanel.tsx`）是这批判断唯一的可读全文。
- **这场怎么跑的**收进一个 `<details>` 抽屉：参数摊在最上面时，用户第一眼读到的是花费和分数，
  正是把研讨读成考试的那种错位。

### 与正文的联动只有一条通道：store 里的 FocusRef

中间区（`TopicEvolution.tsx`）与右栏是两个组件树，指针事件只能往 store 送：

- `focus`：点一下锁住的那一条，`{kind:'utt',id} | {kind:'claim',id} | null`。
- `hover`：指针此刻压着的那一格，与 focus 同形。中间区在节点的 `onMouseEnter`/`onBlur`
  上镜像它（`setHoverKind`），右栏的「此刻」先读 focus 再读 hover。
- 中间区节点上那枚 `--k` 是说话模型的配色；右栏「此刻」的左轨取同一个值 ——
  两处说的是同一条注意力，不用文字再解释一遍「这俩是一回事」。

`src/renderer/lancerLight.ts` 那套飞线**不在研讨屏里**：它只服务编码工作台
（`AgentsPage.tsx`）。研讨屏的中间区用自己的 CSS 动画（`te-col-breathe`、`te-ico-pulse`、
流式光环），右栏只做同色与同节律的呼应，不另画一条光。

### 样式归属

`rb-` 层在 `src/renderer/roundband.css`，自带明暗两份 `--rb-*` token（深色 register 在前，
浅色 `:root` 在后）。`cs-` 层（台账）在 `styles.css`，只引用主题 token，所以两处都自动换皮。
跨文件覆盖不成立 —— `styles.css` 的 `:root[data-theme='dark']` 兜底层权重更高。

## 智能体的外观

`src/renderer/agentMarks.tsx` 管每家长什么样：用厂商自己的 mark（Anthropic 的放射、OpenAI 的花、
pi 的三色字形、OpenCode 的方块），再加一个家族色相。mark 是商标 —— 它只用来识别这是谁的产品，
不做别的暗示。用户自己加的 agent 没有 mark，于是退化成字母牌。

## 技能分类标签

`src/main/assistant/skillTags.ts` 记的是 Torra 这一侧的看法，不是文件的属性：
导入的技能是指向别的应用目录的 junction，所以 `SKILL.md` 永不编辑。
读写走 sanitize → read → 原子写这一条路。
标签存在 `<dataDir>/skill-tags.json`，键是 `linkName`（技能目录里的入口名），
上限 8 个、每个 32 字符，导入被删除时**不剪**（删通常只是「暂不用」）。
IPC 通道：`assistant:skill-tags-set` → `window.torra.assistantSkillTagsSet`；
`scanSkills()` 把它们并回 `LocalSkillView.tags`（缺失就是「未分类」，绝不是空数组）。

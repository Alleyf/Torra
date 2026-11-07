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

## 研讨屏：Consensus Lab

研讨页是三层，自上而下：页头（品牌 + 参会模型 chip + 回放/设置）、
当前问题与五步进度、三视图（观点 / 协作 / 时间）。
视图切换与右栏切面共用 `src/renderer/components/labView.ts` 的一份状态 ——
中央与右栏是两个组件树，而「进协作视图就要看到台账」这条联动只能由共享状态表达。

### 中央：观点演化视图（`EvolutionStage.tsx`）

左侧车道是「谁在说」，中间四段流水线（观点提取 → 观点聚类 → 共识发现 → 结论生成），
下方时间轴。**每个数字都取自 store 的同一份数据**：有效发言来自 `utterances`，
论点数来自 `buildArgumentMap`，共识数来自 `consensus`，纪要来是 `reportReady`。
没有「观点簇」这类好看的估算值 —— 画面上出现过的数，台账里查得到同一个。

页头那五步与下方时间轴共用 `useStageSteps()` 一份口径（阶段表 `TIMELINE`）：
两处各写一套，就会出现「上面说已完成、下面说没跑过」。

### 右栏：共识洞察（`InsightRail.tsx`）

顶部一格是共识度环 + 最硬的一条判断 + 三格计数（共同支持 / 部分支持 / 存在分歧，
按「认账的人够不够过半」分组，是计数不是重新判定）。
往下逐条列判断，**点开就地展开证据溯源**：这条引了哪几句原话、谁说的、第几轮、
查不到原文的有几条、跨轮归并掉的措辞是什么。证据只画真实外键
（`evidenceRef` → utterance），没有原文就显式写「查不到」，不补一句看起来像证据的话。

底部四个切面：观点聚类 / 交叉质询 / 运行记录 / 成本统计。
「完整台账」是旧右栏原样保留（此刻 + 台账 + 这场怎么跑的）——
它是这批判断唯一的可读全文，不能因为新页好看就把它删掉。

### 与正文的联动只有一条通道：store 里的 FocusRef

中央（`TopicEvolution.tsx` 的图、`EvolutionStage.tsx` 的车道）与右栏是两个组件树，
指针事件只能往 store 送：

- `focus`：点一下锁住的那一条，`{kind:'utt',id} | {kind:'claim',id} | null`。
- `hover`：指针此刻压着的那一格，与 focus 同形。中间区在节点的 `onMouseEnter`/`onBlur`
  上镜像它（`setHoverKind`），右栏的「此刻」先读 focus 再读 hover。
- 中间区节点上那枚 `--k` 是说话模型的配色；右栏「此刻」的左轨取同一个值 ——
  两处说的是同一条注意力，不用文字再解释一遍「这俩是一回事」。

`src/renderer/lancerLight.ts` 那套飞线**研讨屏也在用**（起点与落点见下节），
不另起第二套动效。差别只有两处：起点是车道 / 阶段卡 / 模型头像，落点补光的类名
是 `cl-hit`。曲线、弯度种子、停帧、页面藏起来就冻结、reduced-motion 降级
全部同一份实现。

### 判断成形：从模型飞到右栏那一张判断卡

一条判断新落进右栏时，**支持它的那几家各自从自己的车道头像起飞**（取 `.cl-chip-av`
的右缘，颜色就是那家的品牌色），一起落到那张判断卡上（取卡左缘），落地时卡片自己
先亮描边、再泛一层柔光（`cl-hit` + `cl-form`）。一帧最多四束、一条判断最多三家 ——
并行作答时一帧冒出八条结论是常事，全放出去就糊成一片。

起点为什么不是「共识发现」那张卡：从阶段卡起飞只说明「这一段跑完了」，
而一条判断是「哪几家把它顶上来」的，这个信息只有车道头像说得出来。
车道不在眼前（协作视图 / 台账 / 被滚出视野）时**退回阶段卡** —— 那一段确实跑完了，
光仍说得通；两者都不在就不发，不发一条没有起点的光。

### 回放：一份游标，四处同看

页头那颗「回放」倒回第 r 轮，**观点视图 / 协作视图 / 右栏 / 页头五步看的是同一个
`replay`**（`labView.ts`）。四处各存一份就会出现「上面说回到 R1、右边还列着 R3 的结论」。
走针只有 `DiscussionLab` 开一根 —— 三处各开一根就是三倍速，而且各自先停一处。

截断口径是纯函数，在 `labReplay.ts`（`npm run test:lab-replay` 24 条）：
发言按 `round`，共识/分歧按出生轮次（`confirmedRound` / `openedRound`）；
**缺轮次字段的旧条目不因为回放而消失** —— 那等于凭空删掉一条真结论。
回放里没有「正在跑」：实时条、`streaming` 的现场感、阶段卡的 `on` 一律关掉，
因为倒回去看的是过去。走到最后一格**停住不清空游标**，否则最后那一轮的飞光
永远不发（`diffRailPoints` 会把「退出回放」当成换基准）。

**每格停多久按这一格真的发生了什么算**（`replayDwellMs`）：2400ms 收尾
（光飞 1000ms + 落点成形 900ms 之后还得留一点读完的时间）+ 每件 140ms
（发言 / 新结论 / 新争议），封顶 1200ms；reduced-motion 下 1100ms。
固定周期是错的 —— 短于那一格自己的动画，下一格就会切在半路上，每一格都像被掐断；
长于内容则空轮白等。页头那根 `cl-pace` 用**同一个数**当动画时长，
把「这一格还剩多久」画出来：节奏变慢而用户不知道为什么，看起来就只是卡住了。

**入场动画只跑在新出现的那几张上**。判断卡 / 争议卡的 key 是业务 id，回放推进时
老卡不重挂，所以挂在 `.cl-point` 上的 `cl-emerge` 天然只跑新增的那几张。
它只动 opacity、不动 transform：右栏飞光的落点是在挂载当帧量的
`getBoundingClientRect`，带位移入场会把落点量偏几像素。

**落点补光的动画列表里必须保留入场那条**（`.cl-node.cl-hit` / `.cl-point.cl-hit`）。
只写补光那几条时，摘掉 class 会让 `animation-name` 变回入场那条，浏览器把它当成
新动画从 0 重开 —— 实测摘掉那一刻 opacity 掉回 0.19，整张卡又淡入一遍。
同名同序地留在列表里就不会重开。阶段卡的入场错峰走 `--cl-rise-delay` 而不是内联
`animation-delay`，否则补光会跟着一起被推后。

右栏那一束光的触发有三种：实时刚确认下一条结论、游标恰好前进一格、
**走进回放的第一格（null → 1）**。最后这一条必须算真事件而不是换基准：
回放是从「还没有任何一轮」开始演的，R1 带回的结论就是第 1 轮形成的 ——
多数会话的结论集中在 R1，入口若静默，整场回放右栏一束光都不会有。
中央那条同理（`diffStage` 的 `StageSnap` 带着 `replay`，走进 R1 时上一帧按
「第 0 轮」算：没有发言、四段全 pending）。
第一次拿快照、换场次、退出回放、手动跳轮（含从「现在」直接跳到第 N 轮）
一律当换基准不发 —— 否则一进研讨屏就是满屏光。

待发的光单独排队（`pendingRef` / `frameRef`）：effect 因别的依赖重跑会取消帧，
若那几束只活在这一帧的闭包里就一声不响地没了 —— 表现正好是「回放没有动画」。

### 样式归属

`cl-` 层在 `src/renderer/consensusLab.css`，自带明暗两份 `--cl-*` token
（深色 register 在前，浅色 `:root` 在后）。`rb-` 层在 `roundband.css`，
`cs-` 层（台账）在 `styles.css`，两者只引用主题 token，所以两处都自动换皮。
跨文件覆盖不成立 —— `styles.css` 的 `:root[data-theme='dark']` 兜底层权重更高。

一条布局约束：`.cl-page` 会滚动，所以子项必须 `flex: 0 0 auto`
（否则主卡片被压到视口高度内、自己 `overflow: hidden` 把内容裁掉，
看上去像「渲染坏了」）。协作视图例外：那一层 `.te` 自己滚，
收尾那一刻由 `TopicEvolution` 的 `finishRef` 把它滚进视野。

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

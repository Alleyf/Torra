# 开发指南

> 从 README 迁入。面向改代码的人;使用者看根 README 即可。

## 常用命令

```bash
npm run dev                 # 开发模式：vite + tsc watch + Electron，一条命令全起
npm run build               # 构建主进程 + preload + 渲染层
npm start                   # 构建并启动
npm run typecheck           # 两段 TypeScript 类型检查
npm test                    # 全量自测链（64 套件 / 2100+ 断言，CI 同口径）
npm run test:invariants     # 核心不变量自测（36 项）
npm run test:webview-clocks # 网页通道的两条时钟：停滞预算 vs 3× 绝对上限
npm run smoke               # 运行时界面冒烟测试 + 截图
npm run shots               # 只重拍 README「界面」那三张：跑同一条冒烟流程，断言照跑
npm run doctor              # 八层体检 + 流水线日志
npm run dist                # electron-builder 打 Windows 安装包
npm run diagnose:webview chatgpt   # 只读诊断某站点分区实际加载了什么
npm run verify:inject             # 在真实分区回归验证注入脚本判定

### 只看一屏的视觉验收(不起 Electron)

`smoke` 只能证明 DOM 结构对,看不出阶段链、汇流总线、字阶这些视觉对不对。
研讨屏的「观点演化视图」可以单独离线出图:esbuild 把**真组件 + 真 store**
打成单文件,夹具一次性写进 store,浏览器直接打开就能看:

```bash
node scripts/preview-lab-flow.mjs                # 深色 · 容器 1400px
node scripts/preview-lab-flow.mjs --light        # 浅色
node scripts/preview-lab-flow.mjs --width=1100   # 窄容器(验断点)
```

产出 `scripts/.lab-flow/index-<theme>-<width>.html`,三份互不覆盖。页面把
store 挂在 `window.__labStore` 上,要验「值变了动画会不会重跑」直接 `setState`。

**这张卡的断点按容器宽度算,不按视口。** 它住在中间栏,视口 1400px 时自己
只有 870px;按视口判定会让窄栏走宽屏布局,四张阶段卡挤成 131px,名字全截成
「观点提…」。所以 `.cl-card-body` 是 `container-type: inline-size`,断点写成
`@container`(820 / 740 / 520 三档,门槛是量出来的,不是估的)。

右栏那两处几何(判断卡被挤成空胶囊 / 台账只占上半屏)只有**条目多到溢出**时才露头,
冒烟夹具撑不满它。用真实历史会话回放来量(不调模型、不花钱):

```bash
node scripts/verify-rail-geometry.mjs            # 默认 sess_mw4nbaym_1(10 条共识点)
node scripts/verify-rail-geometry.mjs <会话id>
```

它把那份会话的伴生文件复制进一枚临时 userData,走「历史 → 回放」这条真路径,
再量判断卡的 `clientHeight/scrollHeight`、右栏可滚性与台账滚动区高度,留两张截图。
基线:10 张卡最矮 100px、无裁剪、内容 1725px 可滚;台账 663px / 右栏 709px。

### 飞光只有一套实现

研讨屏的「谁说的 → 落到哪一步」用的就是编码工作台那套 `src/renderer/lancerLight.ts`:
曲线、弯度种子、停帧、页面藏起来就冻结、`prefers-reduced-motion` 降级全在里面,
研讨屏只提供两样东西 —— **哪两件事有因果**(`src/renderer/stageFlights.ts` 算出来的
飞行计划)和**量哪两个矩形**(组件的 `useEffect`)。别在 CSS 里攒第二套动效:
两套的差别不在长相,在于「什么时候该停」各答一次,然后总有一处答错。

落点补光按屏分:`hitClass` 默认 `wtx-hit`(工作台),研讨屏传 `cl-hit`。
`.lg-trail / .lg-head / .lg-dot / .lg-halo` 的基础样式在 `styles.css`(两份屏都加载),
不在 `agents.css` —— 写在那里研讨屏拿不到 `fill: none`,描边路径会填成一块黑。

**光线层是 SVG,必须显式给宽高。** 只写 `position: absolute; inset: 0` 时它仍按
固有尺寸 300×150 渲染(替换元素不吃 inset),光会从卡片中间起飞。
冒烟里钉了这条:`scripts/smoke.js` 量 `.cl-glow` 与 `.cl-card-body` 的宽是否一致。

飞行计划本身是纯函数,离线可验:`npm run test:stage-flights`。它钉的是
「光只跟着真事件走」—— 三种来源之外不出光、同一事件重渲只飞一次、换场次不出光、
一帧最多四束。右栏那一束(支持这条判断的模型头像 → 刚出现的判断卡)走同一个层,
计划在 `src/renderer/labReplay.ts` 的 `diffRailPoints`:`npm run test:lab-replay`
钉住「实时新确认 / 游标前进一格 / 走进回放第一格(null→1)」三种触发,其余(首次快照、
换场次、退出回放、手动跳轮)一律当换基准不发。冒烟里量的是起点——`fromId` 必须是 `model:<支持者>`,
且落点坐标与那个头像的右缘、判断卡的左缘各差不超过 2px:光从栏边飞和从模型飞,
截图里都是一条线,只有坐标分得开。

回放游标与截断口径也在 `labReplay.ts`:`replayMaxOf` 取数据里最远的一轮,
`asOfRound` / `asOfBorn` 按轮次截断。`replay` 为 `null` 时 `asOfRound` **返回同一个引用** ——
调用方拿它当 memo 依赖,回放结束时换新数组会让整张图白重排一次。
真 Electron 里量的是「倒回 R1 后判断卡少了一条、观点提取的数跟着少、走到 R3 时
那一束光的 `toId` 正好是新结论」(`scripts/smoke.js`)。

## 热更新的两层结构

`npm run dev` 的热更新分两层：改**渲染层**（`src/renderer`）由 vite HMR 即时生效；
改**主进程 / preload**（`src/main`、`src/preload`）由 `tsc --watch` 增量编译，编译通过后自动重启 Electron
窗口——网页版登录态存在 `persist:` 分区里，重启不丢。dev server 端口从 5273 起自动顺延找空闲口，
再经 `TORRA_DEV_PORT` 交给主进程，两端不会串（同机开多个会话时各用各的端口）。

## 用 CDP 驱动界面实测的坑

给原生墙做「真的按住鼠标拖一条缝」这类实测时，探针要认三件事：

**指针事件必须走 `Input.dispatchMouseEvent`，不能用 `dispatchEvent` 造。** 拖拽那里调
`setPointerCapture(pointerId)`，合成 PointerEvent 的 pointerId 在主进程之外不存在，直接抛
NotFoundError，于是拖拽在第一步就断，测出来的「拖不动」是测试自己的假阳性。

**窗口被最小化或整面遮挡时，`visibilityState` 是 hidden，Chromium 会把派发的鼠标事件攒起来不投递。**
症状最难认：`Runtime.evaluate` 全绿、DOM 探针答得头头是道，界却一句话都不动，看起来像把手坏了。
发事件前先补一句 `Page.setWebLifecycleState {state:'active'}`，再用 `document.visibilityState`
确认已经是 visible —— 这一步只影响测试车，不是产品行为。

**量几何与截图之前要把 OS 窗口抬起来。** 页面级 CDP session 没有 `Browser.*` 域，
`Page.bringToFront` 只切标签页、不抬窗口，于是窗口在后台或被最小化时每个 `getBoundingClientRect`
都读成 0、截图是一片黑，看上去像改版做坏了。做法：主进程里
`BrowserWindow.getAllWindows()` → `setAlwaysOnTop(true, 'screen-saver')` + `show()` + `focus()`，
量完再撤掉 alwaysOnTop。

**`show: false` 的窗口一帧都不出,而 `visibilityState` 仍然报 `visible`。** 这是最会浪费
几小时的一条:探针全绿、DOM 全对,只有 rAF 驱动的行为(飞光、入场动画、虚拟化列表的挂载)
静默不发生。实测(载入真渲染层):400ms 内 `requestAnimationFrame` 计数恒为 0,事后
`show()` 也翻不回来。`scripts/smoke.js` 因此改成创建时就 `show: true`、默认摆到
`-32000` 屏幕外(`skipTaskbar` + `focusable:false`)—— 与 `webview/pool.ts` 的
`ensureHost` 同一条做法;实测这一组 400ms 出 24 帧、CDP 截图正常回包。
判别口径:要验「有没有出帧」,别读 `visibilityState`,直接数 rAF。

**抓「动画正在进行」的图要等它走起来。** 飞光用 `stroke-dashoffset` 从全长走到 0,
发射那一刻画面上**一根线都没有**;立刻 `captureScreenshot` 会得到一张「事件已经发生、
但什么也看不见」的图,而坐标断言照样全绿 —— 实测 `p≈0` 时截到的那张就是这样。
按行程等一段(`scripts/smoke.js` 里 1000ms 的光等 420ms),`lg-flight` 组的 opacity
与 `pathLen` 可以在同一帧里读出来交叉验证:opacity=1 且 pathLen>0 才算真的画上了。

## 安装陷阱

**npmmirror 镜像下 optionalDependencies 的平台包不会自动安装**，需手动补：

```bash
npm install --save-dev @esbuild/win32-x64 @rollup/rollup-win32-x64
```

Electron 二进制未下载时：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

**启动报 `Cannot read properties of undefined (reading 'isPackaged')`**：
环境里存在 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 退化成纯 Node 运行时。
启动前 `unset ELECTRON_RUN_AS_NODE`。

## 发布

推 `v*` tag 即触发 CI：typecheck → 全量测试 → electron-builder 打包 →
自动创建 GitHub Release 并上传安装包与 SHA256SUMS（见 `.github/workflows/build.yml`）。
tag 从它指向的 commit 构建——先确认要发布的代码都已提交，再打 tag。

同一个 commit 只要既在 main 上又被打上 tag，就会起两条并发流水线，于是「tag 那条红了、main 那条全绿」
是能同时出现的两行事实。这时先怀疑机器而不是代码：两次跑的是同一份工作树、同一个 workflow，
差异只可能来自 runner 的速度与抢占（本地 `npm test` 全绿而 CI 单条红，就是这个形状）。
分辨它只要一次 Re-run failed jobs —— 注意重跑读的还是 tag 那个 commit 里的 `build.yml`，
之后推上 main 的诊断改动不会参与这一跑。

红的时候先看 Annotations，别看日志：job 原始日志与 step summary 对未登录访客是 403 和空白
（`actions/jobs/{id}/logs` 匿名访问实测 403，公开 check-runs 里的 `output.summary` 是空字符串），
而 Annotations 匿名页面就能读。所以 `Surface test failure tail` 那一步会把红在哪一套件、
那套件里红了哪条断言，逐条以 `::error::` 发出来；测试本身没红时它发 `::notice::`，
免得「套件 43/43 通过」挂成一条假 error 把人引去翻测试日志。

## M1 状态

| 出口标准 | 状态 |
| --- | --- |
| 核心不变量自测 20 项 | ✅ 通过 |
| TypeScript 类型检查（主进程 + 渲染层） | ✅ 通过 |
| 构建产物完整 | ✅ 通过 |
| 界面三区渲染 + 零控制台错误 | ✅ 通过 |
| ChatGPT 单站点连续 20 轮成功率 ≥ 95% | ⬜ 待人工验证（需真实登录） |
| 单轮端到端 ≤ 60s | ⬜ 待人工验证 |
| 会话重启后登录态保持 | ⬜ 待人工验证 |

> 后三项需要真实登录各站点后手工验证，未在无凭据环境下自动执行。
> 这三项是 M1 的形态假设闸门——若 ChatGPT 单站点成功率无法达到 95%，
> 应触发形态复审（API-first 降级方案），而非继续推进 M2。
>
> **补测规程（PRD 13 章 V1.1）**：登录各站点后，对 7 个内置适配器逐一执行 20 轮
> 自动键入 + 抓取（可用 `npm run smoke` 的固定装置口径），记录每站成功率与失败原因分类
> （登录失效 / 选择器丢失 / 流式抓取失败 / 超时），结果回填上表。这是产品最核心的赌注，
> 必须用数字而非体感结算。

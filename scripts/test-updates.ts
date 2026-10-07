/**
 * 「检查更新 / 关于」的离线守卫（纯函数 + 静态扫描，不需要 Electron）
 *
 * 这条链路的真实验证要一个带 latest.yml 的打包版，本机造不出来；但把话说全之前，
 * 能钉的四层必须先钉死，否则第一次真跑就会以最难看的方式失败：
 * - 判断层：阶段与文案出自同一份 reducer，界面不许自己猜「算不算有新版本」；
 * - 接线层：preload 的推送白名单漏一条 = 下载完了界面永远停在「下载中」；
 * - 元数据层：latest.yml 没生成或没进 Release，应用内只能报 404 —— v0.1.0/v0.2.0
 *   就是这么过去的，所以这一条要有断言，不能只写在注释里；
 * - 诚实层：开发构建与便携版不能自动升级，那两句理由要真的显示出来，
 *   而不是让按钮亮着等用户点下去。
 *
 * 运行：npm run test:updates
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  explainUpdateError,
  formatBytes,
  initialUpdateState,
  reduceUpdate,
  updateBlockReason,
  type UpdateState,
} from '../src/shared/update'

const ROOT = path.resolve(__dirname, '..')

let pass = 0
let fail = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    fail++
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${(e as Error).message.split('\n').slice(0, 4).join('\n         ')}`)
  }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 打包安装版：唯一能自动升级的形态 */
const PACKAGED = { packaged: true, portable: false, version: '0.2.0' }
const installed = (): UpdateState => initialUpdateState(PACKAGED)
const T0 = 1_700_000_000_000

function main(): void {
  console.log('\n== 更新状态机：判断只写一份 ==')

  it('纯函数层：shared/update 不 import electron，否则脱机测不了', () => {
    const src = read('src/shared/update.ts')
    assert.doesNotMatch(src, /from 'electron'/, '状态层一旦引 electron，就只能开着应用验证它了')
    assert.doesNotMatch(src, /require\('electron'\)/, '同上')
  })

  it('正常链路：检查 → 发现 → 下载 → 待安装，每步都有可见结论', () => {
    let s = installed()
    assert.equal(s.phase, 'idle')
    assert.equal(s.canAutoUpdate, true)
    assert.equal(s.blockedReason, null)
    assert.ok(s.note.length > 0, 'idle 也要有一句话，不能空着')

    s = reduceUpdate(s, { type: 'checking' }, T0)
    assert.equal(s.phase, 'checking')
    assert.equal(s.checkedAt, T0, '检查动作要留下时间戳')

    s = reduceUpdate(s, { type: 'available', version: '0.3.0' }, T0 + 1)
    assert.equal(s.phase, 'available')
    assert.equal(s.latest, '0.3.0')
    assert.match(s.note, /v0\.3\.0/, '结论里要报得出目标版本')
    assert.match(s.note, /v0\.2\.0/, '以及当前版本，用户才知道跳的是哪一级')

    s = reduceUpdate(s, { type: 'progress', percent: 42, transferred: 1e7, total: 2.4e7 }, T0 + 2)
    assert.equal(s.phase, 'downloading')
    assert.equal(s.percent, 42)
    assert.equal(s.checkedAt, T0 + 1, '进度不是「检查」，不许刷新检查时间')

    s = reduceUpdate(s, { type: 'downloaded' }, T0 + 3)
    assert.equal(s.phase, 'ready')
    assert.equal(s.percent, 100)
    assert.match(s.note, /重启/, '待安装这句要预告代价')
  })

  it('没有更新：latest 归零，不许留着上一轮的版本号', () => {
    let s = reduceUpdate(installed(), { type: 'checking' }, T0)
    s = reduceUpdate(s, { type: 'available', version: '0.3.0' }, T0 + 1)
    s = reduceUpdate(s, { type: 'checking' }, T0 + 2)
    s = reduceUpdate(s, { type: 'not-available', version: '0.2.0' }, T0 + 3)
    assert.equal(s.phase, 'latest')
    assert.equal(s.latest, null, '查过没有更新还留着旧目标，界面就会显示「→ v0.3.0」')
    assert.match(s.note, /最新/)
  })

  it('进度夹在 0–100，NaN 不进界面', () => {
    const base = reduceUpdate(installed(), { type: 'available', version: '0.3.0' }, T0)
    assert.equal(reduceUpdate(base, { type: 'progress', percent: 137, transferred: null, total: null }, T0).percent, 100)
    assert.equal(reduceUpdate(base, { type: 'progress', percent: -8, transferred: null, total: null }, T0).percent, 0)
    assert.equal(reduceUpdate(base, { type: 'progress', percent: NaN, transferred: null, total: null }, T0).percent, 0)
  })

  it('失败不留旧阶段：note 和按钮必须指向同一个结论', () => {
    const midDownload = reduceUpdate(
      reduceUpdate(installed(), { type: 'available', version: '0.3.0' }, T0),
      { type: 'progress', percent: 61, transferred: null, total: null },
      T0 + 1,
    )
    const fromDownload = reduceUpdate(midDownload, { type: 'error', stage: 'download', message: 'net::ERR_CONNECTION_RESET' }, T0 + 2)
    assert.equal(fromDownload.phase, 'error', '下载中断若还停在 downloading，按钮就永远是禁用的')
    assert.equal(fromDownload.percent, 61, '已经下过的部分是真的，进度不该假装归零')
    assert.match(fromDownload.note, /下载中断/)

    const fromCheck = reduceUpdate(
      reduceUpdate(installed(), { type: 'checking' }, T0),
      { type: 'error', stage: 'check', message: '404' },
      T0 + 1,
    )
    assert.equal(fromCheck.phase, 'error')
    assert.equal(fromCheck.percent, 0, '检查阶段失败却留着进度条，等于凭空多一根条')
  })

  console.log('\n== 错误解释：认不出就照登，不猜 ==')

  const cases: Array<[string, string, RegExp]> = [
    // 本应用当前真实存在的状态：早于 latest.yml 的那些发布查不到更新
    // 断言只看翻译后的那句人话 —— 界面不许出现 latest.yml / 404 这类 feed 侧的话
    ['Cannot find latest.yml of type .file', 'check', /更新信息/],
    ['No published assets found', 'check', /更新信息/],
    ['Unknown: 404 Not Found', 'check', /发布记录/],
    ['Error: getaddrinfo ENOTFOUND github.com', 'check', /连不上更新源/],
    ['net::ERR_CONNECTION_REFUSED', 'download', /下载中断/],
    ['unable to verify the first certificate', 'check', /证书/],
    ['EBUSY: resource busy or locked', 'download', /占用/],
  ]
  for (const [raw, stage, expect] of cases) {
    it(`「${raw}」翻成人话（${stage}）`, () => {
      assert.match(explainUpdateError(raw, stage as 'check' | 'download'), expect)
    })
  }

  it('认不出的原文照登，绝不套一个「网络问题」', () => {
    const weird = explainUpdateError('CannotComputeSomething: internal weirdness 7', 'check')
    assert.match(weird, /internal weirdness 7/, '编一个原因比不编更糟：用户会照着那个原因去查')
    assert.doesNotMatch(weird, /网络/)
  })

  it('空消息也有结论', () => {
    assert.match(explainUpdateError('   ', 'check'), /原因未知/)
    assert.match(explainUpdateError('', 'download'), /再试一次/)
  })

  it('下载失败的措辞不同于检查失败', () => {
    const msg = 'ECONNRESET'
    assert.match(explainUpdateError(msg, 'download'), /重新下载/)
    assert.doesNotMatch(explainUpdateError(msg, 'check'), /重新下载/)
  })

  console.log('\n== 三种安装形态：能不能升级，理由要说得出 ==')

  it('开发构建：不能查，理由说清是「没有可替换的安装包」', () => {
    const reason = updateBlockReason({ packaged: false, portable: false, version: '0.2.0' })
    assert.ok(reason)
    assert.match(reason, /开发构建/)
    const s = initialUpdateState({ packaged: false, portable: false, version: '0.2.0' })
    assert.equal(s.canAutoUpdate, false)
    assert.equal(s.note, reason, '按钮的可用态和抬头这句必须同源，否则一边说能一边说不能')
  })

  it('便携版：不能原地升级，要给出手动路径', () => {
    const s = initialUpdateState({ packaged: true, portable: true, version: '0.2.0' })
    assert.equal(s.canAutoUpdate, false)
    assert.match(s.note, /便携版/)
    assert.match(s.note, /Torra-Portable/, '得说清要覆盖的是哪个文件')
  })

  it('安装版：可升级，且没有多摆一句限制', () => {
    const s = installed()
    assert.equal(s.canAutoUpdate, true)
    assert.doesNotMatch(s.note, /不能|便携版|开发构建/)
  })

  it('字节数：未知就不报半句', () => {
    assert.equal(formatBytes(null), null)
    assert.equal(formatBytes(Number.NaN), null)
    assert.equal(formatBytes(-1), null)
    assert.equal(formatBytes(999), '999 B')
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
    assert.equal(formatBytes(64 * 1024 * 1024), '64 MB')
  })

  console.log('\n== 主进程：那些「看着像生效」的写法 ==')

  const up = read('src/main/setup/updater.ts')

  it('签名校验用恒通过的函数关掉，而不是写 false', () => {
    // v6.8.9 的 setter 是 `if (value) { … }`：赋 false 静默无效，
    // 而未签名包一定会卡在这一关 —— 表现是每次下载都失败，且没人知道为什么。
    assert.match(up, /verifyUpdateCodeSignature = async \(\) => null/, '这一项改成布尔值就是假关闭')
    assert.doesNotMatch(up, /verifyUpdateCodeSignature = false/)
  })

  it('不自动下载、不静默安装', () => {
    assert.match(up, /autoUpdater\.autoDownload = false/, '几十 MB 的流量要用户自己点')
    assert.match(up, /autoUpdater\.autoInstallOnAppQuit = false/, '退出时偷偷装等于没告诉过用户')
    assert.match(up, /autoUpdater\.checkForUpdates\(\)/, 'checkForUpdatesAndNotify 会自己开始下载')
    assert.doesNotMatch(up, /checkForUpdatesAndNotify\(/, '同上')
  })

  it('feed 指向 GitHub Releases，且 owner/repo 只写一处', () => {
    assert.match(up, /provider: 'github'/)
    assert.match(up, /export const RELEASE_REPO = \{ owner: 'Alleyf', repo: 'Torra' \}/)
    assert.equal((up.match(/owner: 'Alleyf'/g) ?? []).length, 1, '仓库身份写两处就会有一天只改了一处')
    assert.match(up, /export const RELEASE_PAGE = `https:\/\/github\.com\/\$\{RELEASE_REPO\.owner\}\/\$\{RELEASE_REPO\.repo\}\/releases`/)
  })

  it('待下载与待安装各有各的闸门，不靠界面挡', () => {
    assert.match(up, /if \(now\(\)\.phase !== 'available'\) return/, '没查到版本就调下载，要让主进程拒掉')
    assert.match(up, /if \(now\(\)\.phase !== 'ready'\) return/, '包还没下完就重启，装的是半个文件')
  })

  it('状态只有一个生产者：跨调用读阶段必须走 now()', () => {
    // 事件回调会整个换掉 state 对象，TS 的属性窄化看不见这件事
    assert.doesNotMatch(up, /if \(state\.phase !==/, '直接读 state.phase 会让编译器替「它还是刚才那一格」背书')
    assert.doesNotMatch(up, /state = \{ \.\.\.state,/, '绕过 reducer 写 note 等于第二个生产者，两边早晚对不上')
    assert.match(up, /const blocked = \(\): string \| null => updateBlockReason\(env\)/, '挡不挡由 env 现场算，note 里那一句已经由 initialUpdateState 写好')
  })

  it('quitAndInstall 返回 void：结论要从状态里读，不能当「没抛就是装上了」', () => {
    assert.match(up, /autoUpdater\.quitAndInstall\(false, true\)/)
    assert.match(up, /if \(now\(\)\.phase === 'error'\) return \{ ok: false, reason: now\(\)\.note \}/, '装不成只会发一个同步的 error 事件，promise 这边永远拿到 ok')
  })

  const mi = read('src/main/index.ts')

  it('IPC 与推送通道齐了（漏一条就是界面接不到状态）', () => {
    for (const ch of ['update:state', 'update:check', 'update:download', 'update:install', 'update:open-release', 'about:info', 'about:open-data-dir']) {
      assert.ok(mi.includes(`'${ch}'`), `主进程少了 ${ch}`)
    }
    // 广播这一格在 updater 里做：send 由入口注入，状态与推送同源
    assert.match(up, /deps\.send\('update:state', state\)/, '状态变了却没人推，界面就停在上一格')
  })

  it('依赖与许可证清单不进「关于」：这一格不给用户摆那面墙', () => {
    // 组件名/版本/许可证属于分发与排查信息，用户看得懂的那部分早就在版本行里了
    const ab = read('src/renderer/components/AboutSection.tsx')
    assert.doesNotMatch(ab, /开源许可|Scale|dependencies/, '关于页不许再渲染第三方组件清单')
    assert.doesNotMatch(mi, /readDependencyLicenses|licenseField/, '主进程不再为这一格读 node_modules')
    assert.doesNotMatch(read('src/shared/update.ts'), /dependencies|DependencyLicense/, 'about:info 的载荷里没有依赖清单')
  })

  console.log('\n== preload 白名单与渲染层接线 ==')

  const pre = read('src/preload/index.ts')

  it('update:state 在推送白名单里', () => {
    const block = pre.slice(pre.indexOf('const PUSH_CHANNELS'), pre.indexOf('export type PushChannel'))
    assert.match(block, /'update:state'/, '不在名单里的通道，on() 会直接抛 —— 表现为这一格永远不动')
  })

  it('渲染层拿得到的方法齐，且都经 invoke', () => {
    for (const m of ['getUpdateState', 'checkUpdate', 'downloadUpdate', 'installUpdate', 'openReleasePage', 'getAboutInfo', 'openDataDir']) {
      assert.ok(pre.includes(`${m}:`), `preload 少了 ${m}`)
    }
    assert.match(pre, /ipcRenderer\.invoke\('update:check'\)|ipcRenderer\.invoke\('update:check',/)
  })

  const sp = read('src/renderer/components/SettingsPage.tsx')
  const ab = read('src/renderer/components/AboutSection.tsx')

  it('「关于」是第 6 个页签，且真的挂上了', () => {
    assert.match(sp, /type Tab = [^\n]*\| 'about'/)
    assert.match(sp, /\{ id: 'about', label: '关于', icon: Info \}/)
    assert.match(sp, /\{tab === 'about' && <AboutSection \/>\}/)
  })

  it('挂载先取快照再接推送（事件流不重放）', () => {
    assert.match(ab, /window\.torra\s*\n?\s*\.getUpdateState\(\)/, '只看推送会丢阶段：下载完切走再回来就不知道了')
    assert.match(ab, /window\.torra\.on\('update:state'/)
    assert.match(ab, /alive = false/, '卸载后要停止写状态')
  })

  it('失败与限制都不静默', () => {
    assert.match(ab, /failSoft\(e, '[^']*'\)/, 'IPC 本身挂了，主进程不会再推任何东西，这一格必须有一句人话')
    assert.ok((ab.match(/failSoft\(e, '/g) ?? []).length >= 3, '取状态/取信息/下载三条 catch 都要有可见结论')
    assert.match(ab, /console\.warn\('\[about\]/, '界面不抄原文，但痕迹要留在控制台')
    assert.match(ab, /phase === 'error' \|\| ipcError \? <AlertTriangle/, '失败要有对应的图标与 warn 配色')
    assert.match(ab, /st-note\$\{phase === 'error' \|\| ipcError \? ' warn'/, '同一句结论走同一格')
    assert.match(ab, /title=\{st\?\.blockedReason \?\? undefined\}/, '不能升级时按钮的 title 要说为什么')
  })

  it('「关于」只说用户用得上的事实，技术细节留在「诊断」', () => {
    // 运行时版本、本机绝对路径、这些文件名都属于排查现场：
    // 摆在这一格里，用户既看不懂也复制不走，反而不知道该行看哪一句
    assert.doesNotMatch(ab, /about[?.]+\.(electron|chrome|node|platform)/, '运行时版本号不许画在关于页')
    assert.doesNotMatch(ab, /Electron|latest\.yml|sha512|package\.json|node_modules/, '同上：这一格不出现实现名词')
    assert.doesNotMatch(ab, /<code>\{about/, '路径不作为文字展示')
    assert.match(ab, /disabled=\{!about\?\.dataDir\}/, 'dataDir 只留作「能不能打开」的闸门')
    assert.doesNotMatch(ab, /setIpcError\(String\(/, '异常原文不进界面')
    // 通道层面也别传：渲染层拿不到的东西，早晚不会被画出来
    const shared = read('src/shared/update.ts')
    const iface = shared.slice(shared.indexOf('export interface AboutInfo'))
    assert.doesNotMatch(iface, /electron|chrome|node|platform/, 'about:info 的载荷里就没有运行时版本')
    const handler = mi.slice(mi.indexOf("ipcMain.handle('about:info'"), mi.indexOf("ipcMain.handle('about:open-data-dir'"))
    assert.doesNotMatch(handler, /process\.versions/, '主进程也不许再把运行时版本塞过去')
    // 解释层同理：认得出的错误说下一步，不要把 feed 侧的名词回显给用户
    assert.doesNotMatch(explainUpdateError('Cannot find latest.yml of type .file', 'check'), /latest\.yml/)
    assert.doesNotMatch(updateBlockReason({ packaged: false, portable: false, version: '0.2.0' }) ?? '', /Electron/)
  })

  it('下载不占按钮闸门：那个 promise 要等包下完才回来', () => {
    assert.match(ab, /void window\.torra\.downloadUpdate\(\)/, '发出去就行，进度由状态机推')
    assert.doesNotMatch(ab, /setBusy\('download'\)/, '拿下载当 busy 闸门，「重启并安装」会被永久禁用')
  })

  it('安装失败也要把按钮还回来', () => {
    // 主进程 install 失败时只发事件；渲染层不能只信那个 promise
    assert.match(ab, /if \(busy === 'install' && st && st\.phase !== 'ready'\) setBusy\(null\)/, 'busy 卡在 install 上，「检查更新」会一直禁用')
  })

  it('进度条可访问，且不写死颜色', () => {
    assert.match(ab, /role="progressbar"/)
    assert.match(ab, /aria-valuenow=\{percent\}/)
    assert.match(ab, /style=\{\{ width: `\$\{percent\}%` \}\}/, '只有宽度该走内联，颜色必须走 token')
    assert.doesNotMatch(ab, /style=\{\{[^}]*(color|background)/, '内联颜色在另一套主题里一定不对')
  })

  const css = read('src/renderer/settings.css')

  it('计量条的四个类都在，且尊重降级动画', () => {
    for (const c of ['.st-meter-wrap', '.st-meter ', '.st-meter-fill', '.st-meter-num']) {
      assert.ok(css.includes(c), `settings.css 少了 ${c.trim()}`)
    }
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,120}\.st-meter-fill/)
    assert.match(css, /\.st-meter-num \{[\s\S]*?tabular-nums/, '百分比位数变化不该把条挤得左右跳')
  })

  console.log('\n== 元数据层：latest.yml 必须真的产出来、传上去 ==')

  const yml = read('electron-builder.yml')
  const wf = read('.github/workflows/build.yml')

  it('publish 不再是 null（null 就没有 latest.yml，应用内只能报 404）', () => {
    assert.doesNotMatch(yml, /^publish: null$/m, '这一项回到 null，自动升级就整条失效')
    assert.match(yml, /^publish:\r?\n\s+provider: github\r?\n\s+owner: Alleyf\r?\n\s+repo: Torra/m)
  })

  it('CI 仍显式 --publish never：生成元数据不等于上传', () => {
    assert.match(wf, /--win --publish never/, '缺 GH_TOKEN 时隐式发布必红')
  })

  it('release bundle 收 latest.yml，缺了就终止发布', () => {
    assert.match(wf, /Extension -in '\.exe', '\.blockmap', '\.yml'/, '不收 .yml，Release 又是没有元数据的那副样子')
    assert.match(wf, /Test-Path \(Join-Path release 'latest\.yml'\)/)
    assert.ok(
      wf.indexOf('release/latest.yml 不存在') < wf.indexOf("Extension -in '.exe', '.blockmap', '.yml'"),
      '缺元数据的检查要排在拷贝之前',
    )
    assert.match(wf, /release\/latest\.yml/, '构件 artifact 也要带上它')
    assert.match(wf, /\| `latest\.yml` \|/, 'Release 说明里要写清这一份是干什么的')
  })

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`)
  if (fail > 0) process.exit(1)
}

main()

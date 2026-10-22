/**
 * 便携版自更新的纯逻辑测试
 *
 * 这一层不联网也不碰文件：解析发布清单、比对版本号、判断「有没有可装的更新」。
 * 真正下载和替换 exe 的部分要真跑一遍便携版才能验，不在单测范围里。
 *
 * 为什么值得单测：便携版的更新清单是 SHA256SUMS.txt（不是 latest.yml），
 * 解析口径一旦错了，表现是「下载完校验不过」或者「永远查不到更新」，
 * 两者都要真下载 90MB 才能复现。
 *
 * 运行：npm run test:portable-update
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  PORTABLE_SUMS_FILE,
  assessPortableOffer,
  parseSumsFile,
  portableAssetName,
  tagToVersion,
} from '../src/shared/portable-update'

const ROOT = path.resolve(__dirname, '..')

let pass = 0
let fail = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log('  [PASS] ' + name)
  } catch (e) {
    fail++
    console.log('  [FAIL] ' + name)
    console.log('         ' + (e as Error).message)
  }
}

console.log('\n== 便携版：发布清单解析 ==')

it('能读出 sha256sum 格式的清单', () => {
  const sums = parseSumsFile(
    '415d071f7bb8b45b060ed044629a29f4b5de1e26b3f65794c25cdee05da458f3  Torra-Portable-0.4.1.exe\n' +
      'dd9c1435b44579ce6d291ee4ea2bc555c2565d9e23c787074f02d9778e24f2d8  Torra-Setup-0.4.1.exe',
  )
  assert.equal(
    sums.get('Torra-Portable-0.4.1.exe'),
    '415d071f7bb8b45b060ed044629a29f4b5de1e26b3f65794c25cdee05da458f3',
  )
  assert.equal(
    sums.get('Torra-Setup-0.4.1.exe'),
    'dd9c1435b44579ce6d291ee4ea2bc555c2565d9e23c787074f02d9778e24f2d8',
  )
  assert.equal(sums.size, 2)
})

it('大小写和二进制模式标记都不影响解析', () => {
  const sums = parseSumsFile(
    'AAAA' +
      'A'.repeat(60) +
      '  Torra-Portable-0.5.0.exe\n' +
      'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  *Torra-Setup-0.5.0.exe',
  )
  assert.equal(sums.get('Torra-Portable-0.5.0.exe'), 'a'.repeat(64))
  assert.equal(
    sums.get('Torra-Setup-0.5.0.exe'),
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  )
})

it('坏行被跳过，不影响好行', () => {
  const sums = parseSumsFile(
    'not a checksum line\n' +
      '\n' +
      '# a comment\n' +
      '415d071f7bb8b45b060ed044629a29f4b5de1e26b3f65794c25cdee05da458f3  Torra-Portable-0.4.1.exe',
  )
  assert.equal(sums.size, 1)
  assert.ok(sums.has('Torra-Portable-0.4.1.exe'))
})

it('tag 和产物文件名对得上', () => {
  assert.equal(tagToVersion('v0.6.0'), '0.6.0')
  assert.equal(tagToVersion('0.6.0'), '0.6.0')
  assert.equal(portableAssetName('0.6.0'), 'Torra-Portable-0.6.0.exe')
  assert.equal(PORTABLE_SUMS_FILE, 'SHA256SUMS.txt', 'CI 发布的清单文件名就是这个，不能改')
})

console.log('\n== 便携版：能不能判出「有更新」 ==')

const SUMS =
  '415d071f7bb8b45b060ed044629a29f4b5de1e26b3f65794c25cdee05da458f3  Torra-Portable-0.6.0.exe\n' +
  'dd9c1435b44579ce6d291ee4ea2bc555c2565d9e23c787074f02d9778e24f2d8  Torra-Setup-0.6.0.exe'
const DL = (f: string) => 'https://github.com/o/r/releases/download/v0.6.0/' + f

it('版本更新且清单里有校验和 → 给出一条可下载的更新', () => {
  const r = assessPortableOffer({ tag: 'v0.6.0', sums: SUMS, current: '0.5.0', downloadUrl: DL })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.offer.version, '0.6.0')
  assert.equal(r.offer.fileName, 'Torra-Portable-0.6.0.exe')
  assert.equal(r.offer.sha256, '415d071f7bb8b45b060ed044629a29f4b5de1e26b3f65794c25cdee05da458f3')
  assert.equal(r.offer.url, 'https://github.com/o/r/releases/download/v0.6.0/Torra-Portable-0.6.0.exe')
})

it('已经是最新 → 明确说没有新版本', () => {
  const r = assessPortableOffer({ tag: 'v0.5.0', sums: SUMS, current: '0.5.0', downloadUrl: DL })
  assert.equal(r.ok, false)
  assert.match(r.ok ? '' : r.reason, /没有可安装的新版本/)
  assert.equal(r.ok ? false : r.notAvailable, true, '「本来就没更新」要和发布清单损坏分开')
})

it('发布的是更旧的版本 → 也不能当成更新', () => {
  const r = assessPortableOffer({ tag: 'v0.4.0', sums: SUMS, current: '0.5.0', downloadUrl: DL })
  assert.equal(r.ok, false, '回退版本不是「有更新」')
})

it('清单里没有这个版本的校验和 → 拒绝，不给下载', () => {
  const r = assessPortableOffer({
    tag: 'v0.6.0',
    sums: 'deadbeef  Torra-Setup-0.6.0.exe',
    current: '0.5.0',
    downloadUrl: DL,
  })
  assert.equal(r.ok, false, '没有校验和就没法验证下载到的文件，不能放行')
  assert.equal(r.ok ? true : r.notAvailable, undefined, '清单坏了不能被当成「已经最新」')
})

it('tag 读不出来 → 拒绝', () => {
  const r = assessPortableOffer({ tag: '', sums: SUMS, current: '0.5.0', downloadUrl: DL })
  assert.equal(r.ok, false)
})

console.log('\n== 便携版：主进程那边真的接上了 ==')

const up = fs.readFileSync(path.join(ROOT, 'src/main/setup/updater.ts'), 'utf8')
const pu = fs.readFileSync(path.join(ROOT, 'src/main/setup/portable-updater.ts'), 'utf8')

it('check / download / install 三个动作都会先走便携版分支', () => {
  assert.match(up, /if \(portableUpdater\) return portableUpdater\.check\(\)/)
  assert.match(up, /if \(portableUpdater\) return portableUpdater\.download\(\)/)
  assert.match(up, /if \(portableUpdater\) return portableUpdater\.install\(\)/)
})

it('发布清单损坏时发布 error，不能伪装成「已经最新」', () => {
  assert.match(pu, /if \(assessed\.notAvailable\)/)
  assert.match(pu, /publish\(\{ type: 'error', stage: 'check', message: assessed\.reason \}\)/)
})

it('便携版的 exe 路径来自宿主注入的环境变量，不是猜的', () => {
  assert.match(pu, /PORTABLE_EXECUTABLE_FILE/)
})

it('下载完必须校验 sha256，对不上就丢弃', () => {
  assert.match(pu, /digest !== activeOffer\.sha256/)
  assert.match(pu, /sha256File\(dest\)/, '要校验最终落盘文件，不能只校验网络流')
  assert.match(pu, /createReadStream\(file\)/)
})

it('下载和安装都有重复点击闸门', () => {
  assert.match(pu, /if \(downloading\) return/)
  assert.match(pu, /if \(installScheduled\) return/)
  assert.match(pu, /const activeOffer = offer/, '下载开始时快照 offer，后续检查不能把这一轮的目标改掉')
  assert.match(pu, /downloadFile\(activeOffer\.url/)
})

it('替换动作交给独立进程，且会重试到文件不再被占用', () => {
  assert.match(pu, /spawnSync\(/)
  assert.match(pu, /for \(\$i = 0; \$i -lt 60; \$i\+\+\)/, '运行中的 exe 被宿主占着，必须重试')
})

it('替换脚本必须用 cmd /c start 拉起，不能直接 spawn powershell', () => {
  /*
   * 实测（本机 Windows）：detached + 直接 spawn powershell.exe 时，
   * 脚本**根本没执行** —— 进程秒退、没有任何输出，看起来像成功了。
   * 走 cmd 的 start 才会另起独立进程组，既避开这个毛病，
   * 也保证本进程退出后替换脚本还在跑。
   */
  assert.match(pu, /'cmd\.exe'/, '要用 cmd /c start 拉起替换脚本')
  assert.match(pu, /'start'/, '缺了 start 就不是独立进程组')
  assert.doesNotMatch(
    pu,
    /spawn\(\s*'powershell\.exe'/,
    '直接 spawn powershell.exe 在 detached 下不执行脚本',
  )
})

it('替换脚本会留一份日志，出问题时能查', () => {
  assert.match(pu, /apply-update\.log/)
  assert.match(pu, /Say "replaced"/)
})

it('复制新文件失败时必须把旧 exe 回滚并重新拉起', () => {
  assert.match(pu, /copy failed:/)
  assert.match(pu, /Say "rolled back"/)
  assert.match(pu, /Say "relaunched old"/)
  assert.match(pu, /relaunched old after move timeout/, '连改名都失败时也要把仍留在原位的旧版本拉起来')
})

it('替换脚本带 UTF-8 BOM，中文用户名路径不会被 PowerShell 5.1 解坏', () => {
  assert.match(pu, /writeFileSync\(scriptPath, '\\ufeff' \+ ps, 'utf8'\)/)
})

it('下载用 pipe 接上写盘背压', () => {
  assert.match(pu, /\.pipe\(out\)/)
})

console.log('\n' + '='.repeat(46))
console.log('  通过 ' + pass + ' · 失败 ' + fail)
console.log('='.repeat(46) + '\n')
process.exit(fail > 0 ? 1 : 0)

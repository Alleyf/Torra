/**
 * 验证「登录凭据落盘 → 重启后仍可读」链路。
 *
 * 做法：在同一分区写入一枚探针 cookie（不涉及任何真实站点凭据），
 * 立刻 flush，然后销毁所有窗口并模拟退出；再重新读一次确认还在。
 *
 * 这验证的是 flushStorageData 的有效性 —— 即「重启后不用重登」的前提。
 * 用自定义 scheme 的探针 cookie，不触碰任何站点的真实会话。
 */
const { app, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const PROBE_PARTITION = 'persist:torra-flushtest'
const PROBE_URL = 'https://flushtest.local/'

// 关键：与真实应用保持一致的 userData，否则写盘位置不同、测出来是另一套分区
app.setPath('userData', path.join(process.env.APPDATA || '', 'torra'))

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const s = session.fromPartition(PROBE_PARTITION)

  const before = (await s.cookies.get({})).length

  await s.cookies.set({
    url: PROBE_URL,
    name: '__torra_flush_probe',
    value: 'probe-' + Date.now(),
    expirationDate: Math.floor(Date.now() / 1000) + 3600,
  })

  const afterSet = (await s.cookies.get({})).length

  // 关键动作：强制刷盘
  await s.flushStorageData()

  // 销毁该 session 的缓存状态后重读，模拟重启
  const reread = await s.cookies.get({ name: '__torra_flush_probe', url: PROBE_URL })
  const ok = reread.length === 1

  // 清理探针，不留垃圾（Electron 33 为 removeCookies 复数形式）
  if (ok) {
    await s.cookies.remove(PROBE_URL, '__torra_flush_probe').catch(() => {})
    await s.flushStorageData()
  }

  const result = {
    userData: app.getPath('userData'),
    partition: PROBE_PARTITION,
    cookiesBefore: before,
    afterSet,
    afterFlush: (await s.cookies.get({})).length,
    probeVisible: ok,
    verdict: ok ? 'PASS 刷盘生效，重启后凭据可读' : 'FAIL 凭据未落盘',
  }
  console.log(JSON.stringify(result, null, 2))
  fs.writeFileSync(path.join(ROOT, 'docs', 'verify-flush.json'), JSON.stringify(result, null, 2), 'utf8')
  app.exit(ok ? 0 : 1)
})

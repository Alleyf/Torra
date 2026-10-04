/**
 * 诊断：cookie 明明在磁盘上，Electron API 却读不到。
 *
 * 关键怀疑点：
 * 1. 读取时未加 domain/url 过滤 —— 但 get({}) 应返回全部
 * 2. 加密 cookie 需要 app ready 后由 Chromium 解密，读太早可能失败
 * 3. cookie 是 session cookie（无 expires），退出即丢
 * 4. 分区名不一致：磁盘目录 vs session.fromPartition 的名字
 */
const { app, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const UA = 'C:/Users/30355/AppData/Roaming/torra'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 关键：显式对齐真实应用的 userData。
// `electron scripts/xxx.js` 没有 productName，Electron 会退回默认目录
// Roaming/Electron，导致读到另一套空分区 —— 结论完全无效。
app.setPath('userData', path.join(process.env.APPDATA || process.env.HOME || '', 'torra'))

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const parts = ['torra-chatgpt', 'torra-deepseek-web', 'torra-qwen']

  for (const p of parts) {
    const partition = `persist:${p}`
    const s = session.fromPartition(partition)

    // 磁盘上的分区目录名（Electron 会把 ':' 换成 '-'）
    const diskDir = path.join(UA, 'Partitions', p.replace('persist:', ''))
    const cookiesDb = path.join(diskDir, 'Network', 'Cookies')

    const all = await s.cookies.get({})
    const byDomain = {}
    for (const c of all) byDomain[c.domain] = (byDomain[c.domain] || 0) + 1

    // 带过滤的查询，验证是否只是调用姿势问题
    const chatgpt = await s.cookies.get({ domain: '.chatgpt.com' }).catch((e) => [{ err: e.message }])
    const deepseek = await s.cookies.get({ domain: '.deepseek.com' }).catch((e) => [{ err: e.message }])

    const persistCount = all.filter((c) => c.session === false || (c.expirationDate && c.expirationDate > 0)).length
    const sessionOnly = all.filter((c) => c.session === true).length

    console.log('===', p, '===')
    console.log('  partition 名     :', partition)
    console.log('  磁盘目录存在     :', fs.existsSync(cookiesDb), cookiesDb)
    console.log('  磁盘 Cookies 大小:', fs.existsSync(cookiesDb) ? fs.statSync(cookiesDb).size : '-')
    console.log('  API 读到总数     :', all.length, '（持久', persistCount, '/ 会话级', sessionOnly, '）')
    console.log('  域名分布         :', JSON.stringify(byDomain))
    console.log('  .chatgpt.com 命中:', chatgpt.length, Array.isArray(chatgpt) && chatgpt[0] && chatgpt[0].err ? chatgpt[0].err : '')
    console.log('  .deepseek.com 命中:', deepseek.length, Array.isArray(deepseek) && deepseek[0] && deepseek[0].err ? deepseek[0].err : '')
    console.log('')
  }

  app.exit(0)
})

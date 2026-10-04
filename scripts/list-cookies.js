/**
 * 列出各分区 cookie 明细（只列名称/域/过期时间，不输出值 —— 值是凭据）。
 * 用途：判断「是否已登录」该看哪些 cookie 名，以及哪些是持久 cookie。
 */
const { app, session } = require('electron')
const path = require('node:path')

// 关键：显式对齐真实应用的 userData。
// `electron scripts/xxx.js` 没有 productName，Electron 会退回默认目录
// Roaming/Electron，导致读到另一套空分区 —— 结论完全无效。
app.setPath('userData', path.join(process.env.APPDATA || process.env.HOME || '', 'torra'))

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  for (const p of ['torra-chatgpt', 'torra-deepseek-web', 'torra-qwen', 'torra-claude', 'torra-doubao', 'torra-kimi']) {
    const all = await session.fromPartition(`persist:${p}`).cookies.get({})
    console.log('===', p, `(${all.length})`, '===')
    for (const c of all) {
      const exp = c.expirationDate ? new Date(c.expirationDate * 1000).toISOString().slice(0, 10) : 'session'
      const valLen = String(c.value || '').length
      console.log(`  ${c.domain.padEnd(22)} ${c.name.padEnd(34)} ${c.session ? 'session' : 'persist'} until=${exp} len=${valLen}`)
    }
    console.log('')
  }
  app.exit(0)
})

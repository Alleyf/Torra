/**
 * 验证用的凭据种子：往隔离 userData 的登录分区里写几条「名字像认证、域也对」的 cookie，
 * 好让真实应用算出可预期的有效期。用完由 verify-credential-expiry.mjs 连目录一起删。
 *
 * 只写隔离目录（--user-data-dir 由调用方传），绝不碰真实登录态。
 * 值全是假串，只为通过「非空壳」判定。
 *
 * 关于会话级：没有 expirationDate 的 cookie 不随进程退出落盘，
 * 所以「会话级」那条分支只能由离线单测覆盖（test-credential-expiry.ts），
 * 这里刻意不种 —— 种了另一个进程也读不到，只会让人误判成漏识别。
 *
 * 各站点分别管一件事：
 *   chatgpt   30 天 → 模型栏该出现绿色「剩 30 天」（它长期判不出登录态，正走 unknown 分支）
 *   deepseek  30 天 + 90 天 → 面板要标出「最早那条」就是界面依据
 *   qwen      5 小时、且写在父域 .qwen.ai → 黄档 + 父域也要算
 *   kimi      写在 www.kimi.com 上、入口也是 www. → 两侧剥 www 的对照
 */
const { app, session } = require('electron')

app.disableHardwareAcceleration()

const nowS = Math.floor(Date.now() / 1000)
const FAKE = 'seeded-fake-value-not-a-real-credential'

const SEEDS = [
  {
    model: 'chatgpt',
    url: 'https://chatgpt.com/',
    set: [{ name: 'access_token', domain: '.chatgpt.com', expirationDate: nowS + 30 * 86400 }],
  },
  {
    model: 'deepseek-web',
    url: 'https://chat.deepseek.com/',
    set: [
      { name: 'ds_session_id', domain: '.deepseek.com', expirationDate: nowS + 30 * 86400 },
      { name: 'access_token', domain: 'chat.deepseek.com', expirationDate: nowS + 90 * 86400 },
    ],
  },
  {
    model: 'qwen',
    url: 'https://chat.qwen.ai/',
    set: [{ name: 'refresh_token', domain: '.qwen.ai', expirationDate: nowS + 5 * 3600 }],
  },
  {
    model: 'kimi',
    url: 'https://www.kimi.com/',
    set: [{ name: 'session_token', domain: 'www.kimi.com', expirationDate: nowS + 2 * 86400 }],
  },
]

app
  .whenReady()
  .then(async () => {
    for (const s of SEEDS) {
      const ses = session.fromPartition(`persist:torra-${s.model}`)
      for (const c of s.set) {
        await ses.cookies.set({
          url: s.url,
          name: c.name,
          value: FAKE,
          domain: c.domain,
          path: '/',
          expirationDate: c.expirationDate,
          secure: true,
          httpOnly: false,
          sameSite: 'no_restriction',
        })
      }
      const back = await ses.cookies.get({})
      console.log(
        `SEED ${s.model} total=${back.length} detail=${back.map((x) => `${x.name}@${x.domain}:${x.expirationDate ?? 'session'}`).join(' ')}`,
      )
    }
    app.exit(0)
  })
  .catch((e) => {
    console.error('SEED FAILED', e && e.message ? e.message : e)
    app.exit(1)
  })

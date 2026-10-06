/**
 * 凭据有效期的离线回归（不联网、不需要 Electron）。
 *
 * 这块的全部风险都在「同一个数字被三处说出三种话」：模型栏、网页模型行、体检
 * 回答的是同一个问题（这份登录还能用多久），一旦各算各的，用户就没法判断该信谁。
 * 所以钉死的都是口径本身：
 *
 * 1. 「最早到期」取的确实是**最早**那条，且只算真凭据（CSRF/主题/Analytics 之类不算）；
 * 2. 空值壳 cookie 不算证据 —— 站点未登录时也会写一个同名空 cookie；
 * 3. 全都没有到期时间要说成「会话级」，而不是假装还剩很久；
 * 4. 域匹配跟着浏览器规则走：父域（.qwen.ai）上的凭据对 chat.qwen.ai 同样有效；
 * 5. 文案三档（剩 N 天 / 不足 36 小时转黄 / 已过期）与「这是提示不是保证」的说明同时出现。
 *
 * 运行：npm run test:credential-expiry
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { summarizeAuthCookies } from '../src/main/webview/auth-cookies'
import { cookieExpireText, credentialHint, formatRemaining } from '../src/shared/credentials'

let pass = 0
let fail = 0

async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok   ${name}`)
  } catch (e) {
    fail++
    console.log(`  FAIL ${name}`)
    console.log(`       ${(e as Error).message.split('\n').slice(0, 4).join('\n')}`)
  }
}

/** Electron 的 cookie 形状（只需判定用到的那几个字段） */
type C = { name: string; domain: string; value: string; expirationDate?: number }

const V = 'abcdefgxxxxxxxxx' // 长度 >8 的占位值：非空才算证据
const nowS = Math.floor(Date.now() / 1000)
const days = (n: number) => n * 24 * 3600

async function main(): Promise<void> {
  console.log('\n=== 认证 cookie 的挑选 ===')

  await it('只保留名字像认证凭据的 cookie', () => {
    const { auth } = summarizeAuthCookies(
      [
        { name: 'access_token', domain: 'chat.deepseek.com', value: V, expirationDate: nowS + days(30) },
        { name: 'ds_session_id', domain: 'chat.deepseek.com', value: V, expirationDate: nowS + days(3) },
        { name: 'theme', domain: 'chat.deepseek.com', value: 'dark', expirationDate: nowS + days(300) },
        { name: 'abtest_bucket', domain: 'chat.deepseek.com', value: V, expirationDate: nowS + days(300) },
      ],
      'chat.deepseek.com',
    )
    assert.deepEqual(auth.map((c) => c.name).sort(), ['access_token', 'ds_session_id'])
  })

  await it('排除「看着像认证、实则游客也有」的 cookie', () => {
    const { auth, expiry } = summarizeAuthCookies(
      [
        { name: '__ssid', domain: 'claude.ai', value: V, expirationDate: nowS + days(30) },
        { name: 'cf_clearance', domain: 'claude.ai', value: V, expirationDate: nowS + days(30) },
        { name: 'next-sidebar-entry-order', domain: 'kimi.moonshot.cn', value: V, expirationDate: nowS + days(30) },
        { name: 'passport_csrf_token', domain: 'kimi.moonshot.cn', value: V, expirationDate: nowS + days(30) },
      ],
      'kimi.moonshot.cn',
    )
    assert.equal(auth.length, 0)
    assert.equal(expiry.authCookies, 0)
    assert.equal(expiry.sessionOnly, false)
  })

  await it('空值壳 cookie 不算凭据', () => {
    const { auth } = summarizeAuthCookies(
      [
        { name: 'access_token', domain: 'chat.qwen.ai', value: '', expirationDate: nowS + days(9) },
        { name: 'refresh_token', domain: 'chat.qwen.ai', value: 'short', expirationDate: nowS + days(9) },
      ],
      'chat.qwen.ai',
    )
    assert.equal(auth.length, 0)
  })

  await it('父域上的凭据对子域同样成立（.qwen.ai → chat.qwen.ai）', () => {
    const { auth } = summarizeAuthCookies(
      [{ name: 'refresh_token', domain: '.qwen.ai', value: V, expirationDate: nowS + days(9) }],
      'chat.qwen.ai',
    )
    assert.equal(auth.length, 1)
  })

  await it('别的站的凭据不算本站的', () => {
    const { auth } = summarizeAuthCookies(
      [{ name: 'access_token', domain: 'evil.example.com', value: V, expirationDate: nowS + days(9) }],
      'chat.qwen.ai',
    )
    assert.equal(auth.length, 0)
  })

  await it('www 前缀不参与域名比较', () => {
    const { auth } = summarizeAuthCookies(
      [{ name: 'session_token', domain: 'qwen.ai', value: V, expirationDate: nowS + days(2) }],
      'www.qwen.ai',
    )
    assert.equal(auth.length, 1)
  })

  await it('凭据写在 www 主机上时也认（入口 www.kimi.com + cookie www.kimi.com）', () => {
    // 两侧都剥 www 之前：wantHost 被剥成 kimi.com，而 cookie 域还是 www.kimi.com，
    // 于是整站判成未登录 —— 真实影响是预热与有效期双双失灵（实测 Kimi）。
    const { auth } = summarizeAuthCookies(
      [{ name: 'session_token', domain: 'www.kimi.com', value: V, expirationDate: nowS + days(2) }],
      'www.kimi.com',
    )
    assert.equal(auth.length, 1)
  })

  await it('WAF 会话 cookie 不算凭据（名字以 SID 结尾但不是登录态）', () => {
    // 华为云 WAF 的 HWWAFSESID 正好命中 sid$ 这个通用强信号，实测会混进认证列表，
    // 让「认证 cookie 条数」虚高，还把会话级的东西摆在面板上冒充凭据。
    const { auth, expiry } = summarizeAuthCookies(
      [{ name: 'HWWAFSESID', domain: 'chat.deepseek.com', value: V, expirationDate: nowS + days(1) }],
      'chat.deepseek.com',
    )
    assert.equal(auth.length, 0)
    assert.equal(expiry.sessionOnly, false)
  })

  console.log('\n=== 最早到期：只有一个数字，必须是那个最小的 ===')

  await it('取最早到期的那条，而不是最后写入的', () => {
    const { expiry } = summarizeAuthCookies(
      [
        { name: 'access_token', domain: 'chat.deepseek.com', value: V, expirationDate: nowS + days(30) },
        { name: 'ds_session_id', domain: 'chat.deepseek.com', value: V, expirationDate: nowS + days(3) },
        { name: 'refresh_token', domain: 'chat.deepseek.com', value: V, expirationDate: nowS + days(12) },
      ],
      'chat.deepseek.com',
    )
    assert.equal(expiry.earliest?.name, 'ds_session_id')
    assert.equal(expiry.earliest?.exp, nowS + days(3))
    assert.equal(expiry.authCookies, 3)
  })

  await it('会话级凭据混在有到期时间的中间时，仍然只报有到期时间的最早值', () => {
    const { expiry } = summarizeAuthCookies(
      [
        { name: 'sid', domain: 'a.com', value: V },
        { name: 'access_token', domain: 'a.com', value: V, expirationDate: nowS + days(7) },
      ],
      'a.com',
    )
    assert.equal(expiry.earliest?.name, 'access_token')
    assert.equal(expiry.sessionOnly, false)
  })

  await it('全是会话级：earliest 为空但 sessionOnly 为真', () => {
    const { expiry } = summarizeAuthCookies(
      [{ name: 'sid', domain: 'a.com', value: V, expirationDate: 0 }],
      'a.com',
    )
    assert.equal(expiry.earliest, undefined)
    assert.equal(expiry.sessionOnly, true)
    assert.equal(expiry.authCookies, 1)
  })

  await it('到期时间缺失/非法都按会话级处理，不报错', () => {
    for (const bad of [undefined, NaN, -1]) {
      const { expiry } = summarizeAuthCookies([{ name: 'sid', domain: 'a.com', value: V, expirationDate: bad as number }], 'a.com')
      assert.equal(expiry.earliest, undefined, `expirationDate=${String(bad)}`)
      assert.equal(expiry.sessionOnly, true)
    }
  })

  console.log('\n=== 界面文案：数字要小、依据要全 ===')

  const NOW = Date.now()
  const ms = (d: number) => NOW + d * 86400_000
  const hint = (i: Parameters<typeof credentialHint>[0]) => credentialHint(i, NOW)

  await it('30 天后到期：绿色「剩 N 天」，标题点明依据与局限', () => {
    const h = hint({ expiresAt: ms(30), expiresCookie: 'access_token' })
    assert.equal(h?.tone, 'ok')
    assert.equal(h?.text, '凭据剩 30 天')
    assert.match(h!.title, /access_token/)
    assert.match(h!.title, /不代表|提前注销/)
  })

  await it('不足 36 小时：转黄提醒', () => {
    const h = hint({ expiresAt: ms(1) - 3600_000, expiresCookie: 'ds_session_id' })
    assert.equal(h?.tone, 'warn')
    assert.match(h!.text, /^凭据剩 \d+ 小时$/)
  })

  await it('已过期：说「已过期」而不是「剩 -2 天」', () => {
    const h = hint({ expiresAt: ms(-2), expiresCookie: 'sid' })
    assert.equal(h?.tone, 'warn')
    assert.equal(h?.text, '凭据已过期')
    assert.match(h!.title, /已过期 2 天/)
  })

  await it('不足 1 小时按分钟说，避免出现「剩 0 小时」', () => {
    const h = hint({ expiresAt: NOW + 20 * 60_000, expiresCookie: 'sid' })
    assert.equal(h?.short, '20 分钟')
  })

  await it('会话级：明说问不出还剩多久', () => {
    const h = credentialHint({ sessionOnly: true })
    assert.equal(h?.tone, 'muted')
    assert.equal(h?.text, '凭据会话级')
    assert.match(h!.title, /没有给认证 cookie 设到期时间/)
  })

  await it('没有任何认证 cookie 时不显示（未登录不该出现倒计时）', () => {
    assert.equal(credentialHint({ sessionOnly: false }), null)
    assert.equal(credentialHint(undefined), null)
  })

  await it('逐条文案：0 视为会话级，入参是毫秒', () => {
    assert.equal(cookieExpireText(0).text, '会话级')
    assert.equal(cookieExpireText(Date.now() + days(30) * 1000).tone, 'ok')
    assert.equal(cookieExpireText(Date.now() - 1000).tone, 'warn')
  })

  await it('剩余时长换算：分钟 / 小时 / 天 三档', () => {
    assert.equal(formatRemaining(45 * 60_000), '45 分钟')
    assert.equal(formatRemaining(30 * 1000), '1 分钟')
    assert.equal(formatRemaining(5 * 3600_000), '5 小时')
    assert.equal(formatRemaining(2 * 86400_000 + 3600_000), '2 天')
    assert.equal(formatRemaining(-2 * 86400_000), '2 天')
  })

  console.log('\n=== 口径统一：三处必须同源 ===')

  const ROOT = path.resolve(__dirname, '..')
  const read = (rel: string) => fs.readFile(path.join(ROOT, rel), 'utf8')

  await it('pool 只做转发，判定逻辑集中在 auth-cookies.ts', async () => {
    const pool = await read('src/main/webview/pool.ts')
    assert.match(pool, /from '\.\/auth-cookies'/)
    assert.match(pool, /export \{ summarizeAuthCookies, type AuthCookie, type CredentialExpiry \}/)
  })

  await it('体检、状态快照、网页模型行都走同一个 summarizeAuthCookies', async () => {
    const [doctor, main, rail, panel] = await Promise.all([
      read('src/main/diagnostics/doctor.ts'),
      read('src/main/index.ts'),
      read('src/renderer/components/ModelRail.tsx'),
      read('src/renderer/components/WebModelSection.tsx'),
    ])
    assert.match(doctor, /summarizeAuthCookies\(cookies, host\)\.expiry/)
    assert.match(main, /cred = summarizeAuthCookies\(cookies, host\)/)
    assert.match(main, /credentialExpiry\(partition, host\)/)
    // 界面不自己算：只消费主进程给的时刻
    assert.match(rail, /credentialHint\(\{/)
    assert.match(panel, /credentialHint\(credInput\(model, d\)\)/)
    assert.doesNotMatch(rail, /expirationDate/)
    assert.doesNotMatch(panel, /AUTH_COOKIE_RE/)
  })

  await it('有效期只以毫秒跨进程，界面不再自己乘 1000', async () => {
    const main = await read('src/main/index.ts')
    assert.match(main, /credExpiresAt: ce\?\.earliest \? ce\.earliest\.exp \* 1000 : undefined/)
    assert.match(main, /cred\.auth\.map\(\(c\) => \(\{ name: c\.name, domain: c\.domain, exp: c\.exp \* 1000 \}\)\)/)
    const panel = await read('src/renderer/components/WebModelSection.tsx')
    assert.doesNotMatch(panel, /\* 1000/)
  })

  await it('体检不再用宽口径的 auth 列表算倒计时', async () => {
    const doctor = await read('src/main/diagnostics/doctor.ts')
    assert.doesNotMatch(doctor, /const soon = alive\.filter/)
    assert.match(doctor, /const earliest = expiry\.earliest/)
  })

  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()

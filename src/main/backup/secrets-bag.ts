/**
 * 口令加密的密钥袋（node:crypto，不引第三方依赖）。
 *
 * 判据都在 shared/backup.ts（信封形状、口令下限、路径推导、哪些引用不进袋），
 * 这里只干加解密这一件要碰 crypto 的事。分开写的理由和备份的其它层一样：
 * 判据要能脱机断言，crypto 要能在真 Node 里跑。
 *
 * 三条硬约束，改任何一条都要先看注释：
 * 1. **派生参数随信封走，验签按信封里那份算**。今天把 cost 写死在代码里，
 *    明天想调成本就得把用户的袋子作废；按信封算则新旧版本都能解自己的。
 *    但形状判定（isReadableSecretsEnvelope）只认本机 SCRYPT_KDF 那一组参数，
 *    于是「远端下发一组贵到跑不动的参数把主进程吊死」这条路是关着的。
 * 2. **AAD 绑住信封头**。密文之外还有 refs / createdAt / device 三格，
 *    把它们算进认证数据，改一个数字就解不开 —— 不然远端可以把「3 条」改成「300 条」
 *    来试探恢复端的边界。
 * 3. **明文只在函数返回到写入钥匙串之间存在于内存**。不落盘、不进日志、不回渲染层；
 *    openBag 的返回值由调用方（backup/service.ts）逐条 secrets.set 之后就地丢弃。
 */

import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto'
import type { BinaryLike, ScryptOptions } from 'node:crypto'
import {
  MAX_BAG_BYTES,
  SCRYPT_KDF,
  checkPassphrase,
  isReadableSecretsEnvelope,
  type SecretsEnvelope,
} from '../../shared/backup'

/**
 * 自己包一层 Promise，不用 promisify(scrypt)：
 * 那个重载里带 options 的那一型推不出来，调用会变成「3 个参数、多给了一个」，
 * 而这一层是唯一要传 maxmem 的地方（默认 32 MB 预算会当场失败）。
 */
function scryptAsync(password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, dk) => {
      if (err) reject(err)
      else resolve(dk as Buffer)
    })
  })
}

export interface RefValue {
  ref: string
  value: string
}

export type BuildOutcome = { ok: true; text: string; refs: number } | { ok: false; reason: string }
export type OpenOutcome = { ok: true; entries: RefValue[] } | { ok: false; reason: string }

/**
 * scrypt 的内存上限。Node 默认 maxmem 是 32 MB，而 128·N·r 正好是 32 MB ——
 * 不给这一格，SCRYPT_KDF 那组参数会当场以「memory cost is too small」失败，
 * 报出来像口令问题，实际是内存预算问题。留一倍余量。
 */
const SCRYPT_MAXMEM = 128 * SCRYPT_KDF.N * SCRYPT_KDF.r * 2

async function derive(passphrase: string, salt: Buffer, kdf: SecretsEnvelope['kdf']): Promise<Buffer> {
  return scryptAsync(Buffer.from(passphrase, 'utf8'), salt, kdf.keyLen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAXMEM,
  })
}

/** 认证绑定的那一段：信封里除密文/IV/标签之外的全部字段 */
function aadOf(env: SecretsEnvelope): Buffer {
  return Buffer.from(
    JSON.stringify({
      app: env.app,
      kind: env.kind,
      version: env.version,
      kdf: env.kdf,
      cipher: env.cipher,
      refs: env.refs,
      createdAt: env.createdAt,
      device: env.device,
    }),
    'utf8',
  )
}

/**
 * 装袋。entries 由调用方按 shared 的 BAG_EXCLUDED_REFS 先过滤过（备份令牌不进袋）。
 * 空清单不是错误：一条密钥都没有，就写一个 refs: 0 的袋子 —— 远端那份会被这次覆盖，
 * 这正是「本机已把所有 Key 清空」的同步语义。
 */
export async function buildBag(passphrase: string, entries: RefValue[], device: string): Promise<BuildOutcome> {
  const pw = checkPassphrase(passphrase)
  if (!pw.ok) return { ok: false, reason: pw.reason }
  const clean = entries.filter((e) => typeof e?.ref === 'string' && e.ref && typeof e?.value === 'string')
  const plain = JSON.stringify({ entries: clean })
  if (Buffer.byteLength(plain, 'utf8') > MAX_BAG_BYTES) {
    return { ok: false, reason: `密钥袋正文 ${(Buffer.byteLength(plain, 'utf8') / 1024).toFixed(0)} KB，超过 ${MAX_BAG_BYTES / 1024} KB 上限：钥匙串里不该有这么大的值` }
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  // 派生本身会抛（内存给不够、参数被系统拒）：这一层要把抛变成一句 reason，
  // 否则整个备份动作以异常结束，界面只剩「这一步没走通」这种没用的话
  let key: Buffer
  try {
    key = await derive(passphrase, salt, { ...SCRYPT_KDF, salt: '' })
  } catch (e) {
    return { ok: false, reason: `派生密钥没成功：${(e as Error).message}` }
  }
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    const env: SecretsEnvelope = {
      app: 'torra',
      kind: 'secrets-bag',
      version: 1,
      kdf: {
        name: 'scrypt',
        N: SCRYPT_KDF.N,
        r: SCRYPT_KDF.r,
        p: SCRYPT_KDF.p,
        keyLen: SCRYPT_KDF.keyLen,
        salt: salt.toString('base64'),
      },
      cipher: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: '',
      data: '',
      refs: clean.length,
      createdAt: Date.now(),
      device: String(device ?? ''),
    }
    cipher.setAAD(aadOf(env))
    const data = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()])
    env.tag = cipher.getAuthTag().toString('base64')
    env.data = data.toString('base64')
    return { ok: true, text: JSON.stringify(env, null, 2), refs: clean.length }
  } finally {
    // 派生密钥用完就地清零：留着它，等于在进程活着的每一秒里都揣着一把能解袋子的钥匙
    key.fill(0)
  }
}

/**
 * 开袋。口令错与袋子坏是同一条回答（GCM 标签验不过），不区分 ——
 * 区分它们等于给离线试探的人一个「参数对了、只是口令错」的旁证。
 */
export async function openBag(text: string, passphrase: string): Promise<OpenOutcome> {
  if (!String(passphrase ?? '')) return { ok: false, reason: '这个仓库里有密钥袋，但还没输入备份口令' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: '密钥袋不是可读的 JSON' }
  }
  if (!isReadableSecretsEnvelope(raw)) {
    return { ok: false, reason: '密钥袋的信封形状不认识：版本或加密参数比本机新' }
  }
  const env = raw as SecretsEnvelope
  const pw = checkPassphrase(passphrase)
  if (!pw.ok) return { ok: false, reason: pw.reason }
  const salt = Buffer.from(env.kdf.salt, 'base64')
  let key: Buffer
  try {
    key = await derive(passphrase, salt, env.kdf)
  } catch (e) {
    return { ok: false, reason: `派生密钥没成功：${(e as Error).message}` }
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'), { authTagLength: 16 })
    decipher.setAAD(aadOf(env))
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
    let plain: Buffer
    try {
      plain = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()])
    } catch {
      return { ok: false, reason: '解不开：备份口令不对，或这个袋子已被改动过' }
    }
    const parsed = JSON.parse(plain.toString('utf8')) as { entries?: unknown }
    const list = Array.isArray(parsed.entries) ? (parsed.entries as unknown[]) : []
    const out: RefValue[] = []
    for (const item of list) {
      const e = item as Partial<RefValue>
      if (typeof e?.ref === 'string' && e.ref && typeof e.value === 'string') out.push({ ref: e.ref, value: e.value })
    }
    // 条数与信封声明对不上就是被拆过/拼过：整袋不落地，宁可一条都不恢复
    if (out.length !== env.refs) return { ok: false, reason: '密钥袋内容与信封声明的条数不符，整袋不采用' }
    return { ok: true, entries: out }
  } finally {
    key.fill(0)
  }
}

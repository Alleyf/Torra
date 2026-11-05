/**
 * bash shell 解析的离线回归（不 spawn 真 shell、不读注册表、不碰磁盘上的 Git）
 *
 * 背景：Electron 主进程继承的是注册表里的系统 PATH，Git for Windows 只往那里写
 * `\<root>\cmd`（只有 git.exe）—— 只看 PATH 就会把 `C:\Windows\System32\bash.exe`
 * （WSL 转发 stub）当成唯一的 bash，于是每条终端命令都以「WSL 未安装」告终。
 * 这里把候选收集与解析的关键行为钉死，全部用注入的假候选与假探针：
 *
 * 1. `reg query` 输出解析（真实格式，含表头行与 CRLF）。
 * 2. cmd→bin 兄弟目录推导：PATH 上只有 `\<root>\cmd`，bash.exe 在 `\<root>\bin`。
 * 3. System32 stub 被排到队尾 —— 它能 spawn 不代表能用，排前面就是白等一轮超时。
 * 4. 探针只认通过；全部失败要如实返回 null 与完整 tried 清单；首个成功短路。
 *
 * 运行：npm run test:assistant-bash-shell
 */

import assert from 'node:assert/strict'
import {
  collectCandidates,
  demoteSystemStub,
  parseRegInstallPath,
  resolveBashShell,
} from '../src/main/assistant/bash-shell'

let pass = 0
let fail = 0

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass += 1
  } catch (e) {
    fail += 1
    console.error(`FAIL ${name}`)
    console.error(e)
  }
}

const REG_SAMPLE =
  '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\r\n\r\n' +
  '    InstallPath    REG_SZ    D:\\Git\r\n\r\n'

const ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  SystemRoot: 'C:\\Windows',
  PATH:
    'C:\\Windows\\System32;' +
    'D:\\Git\\cmd;' +
    'C:\\Users\\u\\scoop\\apps\\git\\current\\cmd',
}

async function main(): Promise<void> {
  await it('reg 输出解析：真实格式（表头 + CRLF）', () => {
    assert.equal(parseRegInstallPath(REG_SAMPLE), 'D:\\Git')
  })

  await it('reg 输出解析：没有 InstallPath 时返回 null', () => {
    assert.equal(parseRegInstallPath('\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\r\n\r\n'), null)
    assert.equal(parseRegInstallPath(''), null)
  })

  await it('候选收集：PATH 上的 \\cmd 目录要补同根 \\bin（Git 安装器与 scoop 都这么写）', () => {
    const list = collectCandidates(ENV, true)
    assert.ok(list.includes('D:\\Git\\cmd\\bash.exe'), `cmd 目录本身要列:${list.join('|')}`)
    assert.ok(list.includes('D:\\Git\\bin\\bash.exe'), 'cmd 的同根 bin 要列')
    assert.ok(
      list.includes('C:\\Users\\u\\scoop\\apps\\git\\current\\bin\\bash.exe'),
      'scoop 的 git\\current\\cmd 同理',
    )
    assert.ok(list.includes('C:\\Windows\\System32\\bash.exe'), 'System32 stub 也在候选里（探针会拒它）')
  })

  await it('候选收集：去重且非 win32 返回空', () => {
    const list = collectCandidates(
      { ...ENV, PATH: 'D:\\Git\\cmd;D:\\Git\\cmd;' },
      true,
    )
    assert.equal(list.filter((p) => p === 'D:\\Git\\cmd\\bash.exe').length, 1, '同一目录只列一次')
    assert.deepEqual(collectCandidates(ENV, false), [])
  })

  await it('解析：System32 stub 排到队尾，真正的 Git Bash 先被探针放行', async () => {
    const probed: string[] = []
    const res = await resolveBashShell({
      candidates: [
        'C:\\Windows\\System32\\bash.exe',
        'D:\\Git\\bin\\bash.exe',
      ],
      probe: async (p) => {
        probed.push(p)
        return !p.toLowerCase().includes('system32')
      },
    })
    assert.equal(res.path, 'D:\\Git\\bin\\bash.exe')
    assert.deepEqual(probed, ['D:\\Git\\bin\\bash.exe'], 'stub 不该被先试')
  })

  await it('解析：全部候选失败时返回 null，tried 记录每一次结局', async () => {
    const res = await resolveBashShell({
      candidates: ['C:\\a\\bash.exe', 'C:\\b\\bash.exe'],
      probe: async () => false,
    })
    assert.equal(res.path, null)
    assert.deepEqual(
      res.tried.map((t) => t.path),
      ['C:\\a\\bash.exe', 'C:\\b\\bash.exe'],
    )
    assert.ok(res.tried.every((t) => t.ok === false))
  })

  await it('解析：重复候选只探一次，首个成功短路后面的', async () => {
    const probed: string[] = []
    const res = await resolveBashShell({
      candidates: ['C:\\a\\bash.exe', 'C:\\a\\bash.exe', 'C:\\b\\bash.exe', 'C:\\c\\bash.exe'],
      probe: async (p) => {
        probed.push(p)
        return p.startsWith('C:\\b')
      },
    })
    assert.equal(res.path, 'C:\\b\\bash.exe')
    assert.deepEqual(probed, ['C:\\a\\bash.exe', 'C:\\b\\bash.exe'], '失败一次不重试，成功后不再探')
  })

  await it('队尾重排：stub 永远在最后，其余保持原有顺序', () => {
    const ordered = demoteSystemStub(
      [
        'C:\\Windows\\System32\\bash.exe',
        'D:\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Windows\\System32\\openconsole\\bash.exe',
      ],
      ENV,
    )
    assert.deepEqual(ordered, [
      'D:\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Windows\\System32\\bash.exe',
      'C:\\Windows\\System32\\openconsole\\bash.exe',
    ])
  })

  console.log(`${'-'.repeat(44)}\n${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

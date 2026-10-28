import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;
async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    pass++;
    console.log('  [PASS] ' + name);
  } catch (e) {
    fail++;
    console.log('  [FAIL] ' + name);
    console.log('         ' + (e as Error).message.split('\n').slice(0, 4).join('\n         '));
  }
}
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}
async function main(): Promise<void> {
  console.log('==============================================');
  console.log('  chat clarification continue (webview)');
  console.log('==============================================');
  const inject = readSrc('src/main/webview/inject.ts');
  const agent = readSrc('src/main/agents/webview-agent.ts');
  await it('inject exposes pendingChoice detector', () => {
    assert.match(inject, /pendingChoice: function \(streamSel, sinceCount\)/);
    assert.match(inject, /function detectPendingChoice\(streamSel, sinceCount\)/);
  });
  await it('detector needs options plus choice-like tail', () => {
    assert.ok(inject.includes('请选择'));
    assert.ok(inject.includes('点赞'));
    assert.ok(inject.includes('重新生成'));
    assert.ok(inject.includes('let me know'));
    assert.match(inject, /choiceCueInTail\(tailText\)/);
    assert.match(inject, /choiceLabelBlocked\(t\)/);
  });
  await it('inject build bumped so open pages re-inject', () => {
    // 注入脚本一变就必须抬这个常量，否则已打开的页面会幂等跳过重注入。
    // 用下限而不是字面量：正常抬版本不该反过来把测试改红。
    const m = /INJECT_BUILD = 'torra-inject-(\d+)'/.exec(inject);
    assert.ok(m, '注入构建号要存在且形如 torra-inject-N');
    assert.ok(Number(m![1]) >= 11, `生图通道与澄清检测落地后构建号至少到 11，实得 ${m![1]}`);
  });
  await it('agent keeps chat turn open while awaiting selection', () => {
    assert.match(agent, /window\.__torra\.pendingChoice\(/);
    assert.match(agent, /!clarifyWaited/);
    assert.match(agent, /clarifyDeadline = Math\.min\(deadline/);
    assert.match(agent, /followTail\.slice\(lastText\.length\)/);
    assert.match(agent, /followStable/);
    assert.match(agent, /followTail/);
    assert.match(inject, /isLikelyReasoning/);
    assert.match(agent, /if \(resumedAfterChoice\) continue;/);
  });
  await it('clarify wait runs at most once per turn', () => {
    assert.match(agent, /let clarifyWaited = false/);
    assert.match(agent, /clarifyWaited = true;/);
  });
  await it('clarify outcome merges into result note', () => {
    assert.match(agent, /pasteNote \|\| clarifyNote/);
  });
  await it('shrunk node list after SPA nav rescans instead of blind', () => {
    assert.match(inject, /fromAll >= nodes.length/);
    assert.match(inject, /nodes.length - 40/);
  });
  await it('registered in npm test', () => {
    const pkg = JSON.parse(readSrc('package.json')) as { scripts: Record<string, string> };
    const cmd = pkg.scripts['test:chat-clarify'];
    assert.equal(typeof cmd, 'string');
    assert.equal(cmd.includes('scripts/test-chat-clarify.ts'), true);
  });
  console.log('----------------------------------------------');
  console.log('  通过 ' + pass + ' 条 失败 ' + fail);
  console.log('==============================================');
  if (fail > 0) process.exit(1);
}
void main();

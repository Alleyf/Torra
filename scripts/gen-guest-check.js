/**
 * 生成「未登录可发送」的实测脚本（给 playwright MCP 的 browser_run_code_unsafe 用）。
 *
 * 为什么绕这一圈：注入脚本本体是 87KB 的字符串，直接贴进对话去 evaluate 会把它
 * 塞满上下文；而 playwright 的沙箱里没有 require/fs。所以这里先在 Node 侧把
 * src/main/webview/inject.ts 转译出真正的 INJECT_SCRIPT 落成一个 .js 文件，
 * 再把「addScriptTag(该文件) + 调用 __torra.typePrompt/pressSend」写成一段
 * Playwright 代码文件，由 MCP 侧执行 —— 测的是仓库里正在用的那一份实现，
 * 不是我手抄的副本。适配器 spec 同样直接读 adapters/*.yaml，改 YAML 即改测。
 *
 * 用法：node scripts/gen-guest-check.js   → 产出 output/guest-check/
 */
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const YAML = require('yaml')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'output', 'guest-check')
fs.mkdirSync(OUT, { recursive: true })

// ---- 1. 取出 INJECT_SCRIPT（与主进程注入的是同一段字符串） ----
const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'webview', 'inject.ts'), 'utf8')
const compiled = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const mod = { exports: {} }
new Function('exports', 'require', 'module', '__filename', '__dirname', compiled)(
  mod.exports, require, mod, __filename, __dirname,
)
const INJECT = mod.exports.INJECT_SCRIPT
if (typeof INJECT !== 'string' || INJECT.length < 1000) throw new Error('INJECT_SCRIPT 取不出来')
const injectFile = path.join(OUT, 'inject.js')
fs.writeFileSync(injectFile, INJECT, 'utf8')

// ---- 2. 读真实适配器 YAML ----
function specOf(id) {
  const spec = YAML.parse(fs.readFileSync(path.join(ROOT, 'adapters', id + '.yaml'), 'utf8'))
  // 注入侧只吃这几个字段，测试里把等待压到最短，别真等 15s
  spec.automation = { ...spec.automation, typing_delay_ms: [1, 2], pre_send_pause_ms: [1, 2], jitter: false }
  return spec
}

const targets = [
  { id: 'chatgpt', entry: 'https://chatgpt.com/', ask: '只回复两个字：收到', ask2: '只回复两个字：好' },
  { id: 'doubao', entry: 'https://www.doubao.com/chat/', ask: '只回复两个字：收到', ask2: '只回复两个字：好' },
]

// ---- 3. 生成 Playwright 侧代码 ----
const code = `async (page) => {
  const BASE = ${JSON.stringify('http://127.0.0.1:8791')};
  const targets = ${JSON.stringify(targets.map((t) => ({ ...t, spec: specOf(t.id) })), null, 2)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];

  /*
   * 注入走 HTTP + (0,eval) 而不是 addScriptTag({path})：
   * chatgpt.com 这类站点对 file:// 的 script 标签直接 onerror 拦掉，
   * 于是「注入成功」这一步在测试侧就断了 —— 测的还是同一份 inject.js，只是换了送法。
   */
  const injectViaHttp = async () => {
    const txt = await (await fetch(BASE + '/inject.js')).text();
    (0, eval)(txt);
    return !!(window.__torra && window.__torra.__build);
  };

  /*
   * 框里此刻装着什么：这一条才是「形态判错」的照妖镜。
   * kind 判成 contenteditable 而节点是 textarea 时，清空动的是 textContent，
   * 上一轮的提示词原样留在 .value 里，这一轮拼在尾巴上 —— 站点收到两句话，
   * 而 typePrompt 一路返回 ok:true，日志里完全看不出来。
   */
  const readHold = (s) => {
    var list = document.querySelectorAll(s.selectors.input);
    var pick = null;
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      var v = n.value !== undefined ? n.value : n.textContent;
      if (v && String(v).trim()) { pick = n; break; }
    }
    if (!pick && list.length) pick = list[0];
    if (!pick) return null;
    var cur = String(pick.value !== undefined ? pick.value : pick.textContent || '');
    return { tag: pick.tagName, id: pick.id || '', len: cur.length, value: cur.slice(0, 200) };
  };

  for (const t of targets) {
    const rec = { id: t.id, entry: t.entry };
    try {
      await page.goto(t.entry, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(6000);
      rec.injected = await page.evaluate(injectViaHttp);
      rec.build = await page.evaluate(() => (window.__torra ? window.__torra.__build : ''));

      // 体检：修复前 chatgpt 在这里就返回 login-required
      rec.probe = await page.evaluate(
        ([hp, inp]) => window.__torra.probe(hp, inp),
        [t.spec.health_probe, t.spec.selectors.input],
      );
      // 输入框到底选中了谁
      rec.picked = await page.evaluate((s) => window.__torra.pickInput(s), t.spec);

      // 键入 → 发送（就是 deliverTurn 的那两步，不抄实现）
      const typed = await page.evaluate(
        ([s, p]) => window.__torra.typePrompt(s, p),
        [t.spec, t.ask],
      );
      rec.type = { ok: typed && typed.ok, reason: String((typed && typed.reason) || '').slice(0, 160), mode: typed && typed.mode, kind: typed && typed.kind };
      rec.hold = await page.evaluate(readHold, t.spec);
      rec.holdExact1 = !!(rec.hold && rec.hold.value === t.ask);
      let sent = { ok: false, reason: 'type failed' };
      if (typed && typed.ok) {
        sent = await page.evaluate(
          ([s, p]) => window.__torra.pressSend(s, p, 0),
          [t.spec, t.ask],
        );
      }
      rec.send = { ok: sent && sent.ok, reason: String((sent && sent.reason) || '').slice(0, 160), accepted: sent && sent.accepted, streamCount: sent && sent.streamCount };

      // 等正文落地，用适配器声明的 stream 读回来
      let text = '';
      for (let i = 0; i < 24; i++) {
        await sleep(1000);
        text = await page.evaluate(
          ([sel, mode, ask]) => window.__torra.read(sel, mode, -1, '', ask) || '',
          [t.spec.selectors.stream, t.spec.stream_mode || 'last', t.ask],
        );
        if (text && text.length > 1) break;
      }
      rec.replyChars = text.length;
      rec.reply = text.slice(0, 60);

      /*
       * 第二轮键入：不发出去，只看框里落下的到底是什么。
       * 形态判错时上一轮的提示词还留在 .value 里，clearInput 动的是 textContent，
       * 于是这一轮拼成「第一轮 + 第二轮」—— 这就是那条「收到测试一下AAABBB」现场。
       */
      const typed2 = await page.evaluate(
        ([s, p]) => window.__torra.typePrompt(s, p),
        [t.spec, t.ask2],
      );
      rec.type2 = { ok: typed2 && typed2.ok, kind: typed2 && typed2.kind };
      rec.hold2 = await page.evaluate(readHold, t.spec);
      rec.holdExact2 = !!(rec.hold2 && rec.hold2.value === t.ask2);
      rec.staleFromRound1 = !!(rec.hold2 && rec.hold2.value.indexOf(t.ask) >= 0);

      // 收尾：把测试文本从框里抹掉，别留一个没人认领的草稿
      await page.evaluate((s) => {
        var list = document.querySelectorAll(s.selectors.input);
        for (var i = 0; i < list.length; i++) {
          var n = list[i];
          if (n.tagName === 'TEXTAREA' || n.tagName === 'INPUT') {
            var proto = n.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            var d = Object.getOwnPropertyDescriptor(proto, 'value');
            if (d && d.set) d.set.call(n, ''); else n.value = '';
            n.dispatchEvent(new Event('input', { bubbles: true }));
          } else if (n.isContentEditable) {
            n.textContent = '';
            n.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
          }
        }
        return true;
      }, t.spec);

      rec.url = page.url();
    } catch (e) {
      rec.error = String((e && e.message) || e).slice(0, 240);
    }
    out.push(rec);
  }
  return JSON.stringify(out, null, 2);
}`


const codeFile = path.join(OUT, 'guest-check.js')
fs.writeFileSync(codeFile, code, 'utf8')

// ---- 4. 全部内置适配器的 spec 落一份 JSON，给「只读扫描」那一档用 ----
// 真发送只对游客也能聊的站点做；其余站点只需要看判定给出的是不是「要登录」，
// 而不是「适配器坏了」。浏览器侧要拿到与主进程同一份 spec，不能手抄选择器。
const allSpecs = {}
for (const f of fs.readdirSync(path.join(ROOT, 'adapters')).sort()) {
  if (!/\.ya?ml$/.test(f)) continue
  const raw = YAML.parse(fs.readFileSync(path.join(ROOT, 'adapters', f), 'utf8'))
  if (!raw || typeof raw.id !== 'string') continue
  allSpecs[raw.id] = { ...raw, automation: { ...raw.automation, typing_delay_ms: [1, 2], pre_send_pause_ms: [1, 2], jitter: false } }
}
const specsFile = path.join(OUT, 'specs.json')
fs.writeFileSync(specsFile, JSON.stringify(allSpecs, null, 2), 'utf8')

// ---- 5. 页面内侧 harness：给 MCP 浏览器工具直接 fetch + eval 用 ----
/*
 * 为什么还要这一份：guest-check.js 走的是 Playwright 的 page.* 编排，
 * 而 run_code_unsafe 那条路在受控环境里会被拦（宿主侧任意代码执行）。
 * harness.js 是纯页面内代码 —— 导航到站点后 fetch 它、eval 它、调它一次就出结论，
 * 用的仍是仓库里这份 inject.js 与 adapters/*.yaml。
 *
 * mode：
 * - 'send' 走完 键入 → 发送 → 读回正文，并做第二轮键入（只看框里落下什么，不再发出去）。
 *   只对「未登录也能聊」的站点有意义。
 * - 'scan' 只键入不发：probe / pickInput / typePrompt 的结论 + 形态判定。
 *   登录墙站点要的就是这一档 —— 验证它报的是 login-required 而不是「适配器失效」。
 */
const harness = `(function () {
  var BASE = ${JSON.stringify('http://127.0.0.1:8791')};
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function ensureInject() {
    if (window.__torra && window.__torra.__build) return Promise.resolve(true);
    return fetch(BASE + '/inject.js').then(function (r) { return r.text(); }).then(function (t) {
      (0, eval)(t);
      return !!(window.__torra && window.__torra.__build);
    });
  }

  function specs() {
    return fetch(BASE + '/specs.json').then(function (r) { return r.json(); });
  }

  /** 框里此刻装着什么：形态判错的照妖镜（见 gen 脚本注释） */
  function readHold(spec) {
    var list = document.querySelectorAll(spec.selectors.input);
    var pick = null;
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      var v = n.value !== undefined ? n.value : n.textContent;
      if (v && String(v).trim()) { pick = n; break; }
    }
    if (!pick && list.length) pick = list[0];
    if (!pick) return null;
    var cur = String(pick.value !== undefined ? pick.value : pick.textContent || '');
    return { tag: pick.tagName, id: pick.id || '', len: cur.length, value: cur.slice(0, 200) };
  }

  /** 把测试文本从框里抹掉，别在用户页面上留一个没人认领的草稿 */
  function clearBoxes(spec) {
    var list = document.querySelectorAll(spec.selectors.input);
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.tagName === 'TEXTAREA' || n.tagName === 'INPUT') {
        var proto = n.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var d = Object.getOwnPropertyDescriptor(proto, 'value');
        if (d && d.set) d.set.call(n, ''); else n.value = '';
        n.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (n.isContentEditable) {
        n.textContent = '';
        n.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      }
    }
  }

  /**
   * 选择器逐条命中情况：只看「命中几个、第一个是什么形态」，
   * 用来区分「站点改版选择器全灭」与「命中了但被可见性/登录墙判住」。
   */
  function matchReport(spec) {
    var parts = String(spec.selectors.input).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var hits = [];
    for (var i = 0; i < parts.length; i++) {
      try {
        var list = document.querySelectorAll(parts[i]);
        var first = list[0];
        hits.push({
          sel: parts[i].slice(0, 60),
          n: list.length,
          tag: first ? first.tagName : '',
          vis: first ? (first.offsetWidth > 0 && first.offsetHeight > 0 && getComputedStyle(first).display !== 'none') : false,
        });
      } catch (e) { hits.push({ sel: parts[i].slice(0, 60), err: String(e.message).slice(0, 60) }); }
    }
    return hits;
  }

  window.__guestCheck = function (opt) {
    var mode = opt.mode || 'scan';
    var rec = { id: opt.id, mode: mode, url: location.href.slice(0, 110) };
    var spec = null;
    return Promise.all([specs(), ensureInject()])
      .then(function (both) {
        spec = both[0][opt.id];
        if (!spec) throw new Error('specs.json 里没有 ' + opt.id);
        rec.build = window.__torra.__build;
        rec.matches = matchReport(spec);
        rec.picked = window.__torra.pickInput(spec);
        rec.probe = window.__torra.probe(spec.health_probe, spec.selectors.input);
        return window.__torra.typePrompt(spec, opt.ask);
      })
      .then(function (typed) {
        rec.type = { ok: !!(typed && typed.ok), reason: String((typed && typed.reason) || '').slice(0, 200), kind: typed && typed.kind, mode: typed && typed.mode };
        rec.hold = readHold(spec);
        rec.holdExact = !!(rec.hold && rec.hold.value === opt.ask);
        // 只读档不发送：把刚键入的测试文本抹掉，别在用户页面上留草稿
        if (mode !== 'send') { clearBoxes(spec); return null; }
        if (!typed || !typed.ok) { rec.send = { ok: false, reason: 'type failed' }; return null; }
        return window.__torra.pressSend(spec, opt.ask, 0).then(function (sent) {
          rec.send = { ok: !!(sent && sent.ok), reason: String((sent && sent.reason) || '').slice(0, 200), accepted: sent && sent.accepted, streamCount: sent && sent.streamCount };
          return undefined;
        });
      })
      .then(function () {
        if (mode !== 'send' || !spec.selectors.stream) return null;
        /*
         * 等正文落地：每 2 秒按适配器声明的 stream 读一次，最长约 48 秒。
         * baseline 传 -1、tail 传空串 = 「读最后一条回复」，与聊天模式 extract 视图同一读法。
         */
        return (function poll(i) {
          if (i >= 24) return null;
          return sleep(2000).then(function () {
            var t = window.__torra.read(spec.selectors.stream, spec.stream_mode || 'last', -1, '', opt.ask) || '';
            if (t && t.length > 1) { rec.replyChars = t.length; rec.reply = String(t).slice(0, 80); return null; }
            return poll(i + 1);
          });
        })(0);
      })
      .then(function () {
        if (mode !== 'send' || !rec.type || !rec.type.ok) return null;
        /*
         * 第二轮键入：不发出去，只看框里落下的到底是什么。
         * 形态判错时上一轮提示词仍留在 .value 里（clearInput 动的是 textContent），
         * 于是这一轮拼成「第一轮 + 第二轮」—— 现场就是那条「收到测试一下AAABBB」。
         */
        return window.__torra.typePrompt(spec, opt.ask2 || '只回复两个字：好').then(function () {
          rec.hold2 = readHold(spec);
          rec.holdExact2 = !!(rec.hold2 && rec.hold2.value === (opt.ask2 || '只回复两个字：好'));
          rec.staleFromRound1 = !!(rec.hold2 && rec.hold2.value.indexOf(opt.ask) >= 0);
          clearBoxes(spec);
          return undefined;
        });
      })
      .catch(function (e) {
        rec.error = String((e && e.message) || e).slice(0, 240);
        if (spec) { try { clearBoxes(spec); } catch (e2) {} }
      })
      .then(function () { return JSON.stringify(rec); });
  };
  return 'harness ready';
})()`
fs.writeFileSync(path.join(OUT, 'harness.js'), harness, 'utf8')


process.stdout.write(
  JSON.stringify(
    { injectFile, codeFile, injectBytes: INJECT.length, build: /INJECT_BUILD = '([^']+)'/.exec(src)?.[1], specs: targets.map((t) => ({ id: t.id, input: specOf(t.id).selectors.input })) },
    null,
    2,
  ) + '\n',
)

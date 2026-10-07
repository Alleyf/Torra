/**
 * 注入脚本（运行在站点页面上下文）
 *
 * 该文件被读为纯文本后，用 webContents.executeJavaScript 注入执行。
 * 所有站点相关行为由 AdapterSpec 驱动 —— 换站点只改 YAML，不改本文件。
 *
 * 合规约束（PRD 11.3）：
 * - typing delay / pre-send pause 仅用于避免"机器瞬间连发请求"的异常模式，
 *   不用于伪装人类身份欺诈；不隐藏自动化特征、不篡改页面指纹。
 * - 出现验证码/登录墙时立即返回 login-required，交由用户手动接管，
 *   严禁任何自动破解尝试。
 *
 * 以字符串常量而非立即执行函数导出，便于在 Node 侧读取并注入。
 */
export const INJECT_SCRIPT = `
(function () {
  if (window.__torra) return; // 幂等：避免重复注入

  /**
   * 页面活跃度：距最后一次 DOM 变化的毫秒数。
   * Kimi 这类 agent 站执行工具时正文文本静止，但页面仍在刷新步骤/计时/流式代码。
   * 主进程用它区分「回答写完」与「工具执行间隙」，避免把截断的中间过程当最终答案。
   */
  var __lastMut = Date.now();
  function __watchActivity() {
    if (!document.body || !window.MutationObserver) return;
    try {
      new MutationObserver(function () { __lastMut = Date.now(); }).observe(
        document.body, { childList: true, characterData: true, subtree: true });
    } catch (e) {}
  }
  __watchActivity();
  if (!document.body) document.addEventListener('DOMContentLoaded', __watchActivity, { once: true });

  /**
   * 键入阶段真正写过字的那个节点，页面级留存。
   *
   * 主进程把「键入」与「发送」拆成两次注入调用（中间要贴附件），跨调用带不回 DOM
   * 节点，发送阶段只能按选择器重新查找。而重新查找在 Quill 这类站点必然落空：
   * .ql-blank 只在编辑器为空时存在，字一落地这个 class 就没了，选择器自毁。
   * 元宝实测报的就是「input vanished before send」。
   */
  var __typedInput = null;
  function typedInput() {
    var el = __typedInput;
    if (!el || !document.contains(el)) return null;
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el;
    return null;
  }

  function delayIn(range, jitter) {
    var lo = range[0], hi = range[1];
    var ms = jitter ? lo + Math.floor(Math.random() * (hi - lo + 1)) : hi;
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * 登录墙 / 人机验证判定。
   *
   * 必须早于选择器判定执行：未登录时页面根本没有聊天输入框，
   * 若先查选择器，会把「未登录」误报成「适配器失效」，用户会去查适配器更新
   * 而真正要做的是重新登录。probe 与 send 共用本函数，避免两处判定不一致。
   *
   * 依据（实测 chatgpt.com 未登录页）：存在
   *   <form action="https://chatgpt.com/auth/login_with">
   * 该 form 本身不可见，但确实存在于 DOM，故此处只判存在性、不判可见性。
   */
  function isLoginWall() {
    try {
      if (document.querySelector(
        'form[action*="login"],[name="captcha"],iframe[src*="recaptcha"],' +
        'iframe[title*="challenge"],iframe[src*="challenges.cloudflare"]'
      )) return true;
      // URL 层面的登录/风控拦截，作为 DOM 判定的补充。
      // 注意：本文件处于 TS 模板字面量中，正则里的「\/」会被折叠成「/」，
      // 使正则字面量非法（Invalid regular expression flags），故此处用 indexOf 判断。
      var p = location.pathname;
      // /sign_in 是 DeepSeek 的登录路由：未登录时自动跳过去，
      // 页面上并没有 form[action*=login]，只靠选择器判会误报成适配器失效。
      var paths = ['/auth/login', '/auth/logout', '/login', '/signin', '/sign_in'];
      for (var i = 0; i < paths.length; i++) {
        if (p.indexOf(paths[i]) === 0) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * 站点风控 / 「环境异常」拦截页。
   *
   * DeepSeek 会对非官方客户端 / 自动化环境弹一整屏「使用环境异常……数据和隐私
   * 泄露风险……建议使用官方产品」，把聊天 DOM（含输入框）整个换掉。此时输入框
   * 选择器 0 命中，若按常规判成「适配器失效」或「生成结束但未捕获到内容」，
   * 用户会去改一个根本没坏的适配器 —— 真相是站点把他拦下了，只能人工处理。
   *
   * 本函数处于 TS 模板字面量里：不写正则字面量（反斜杠会被折叠致非法 flag），
   * 用 indexOf 匹配中文串。取组合判据降低正语文案里的误命中。
   */
  function isRiskWall() {
    try {
      var t = (document.body && document.body.innerText) || '';
      if (!t) return false;
      if (t.indexOf('使用环境异常') >= 0) return true;
      if (t.indexOf('数据和隐私泄露风险') >= 0) return true;
      if (t.indexOf('官方产品') >= 0 && t.indexOf('泄露风险') >= 0) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * 失败现场快照。
   *
   * 「适配器失效」是强断言，但未登录、页面还没加载完、视口为 0 导致站点
   * 渲染移动端布局、弹窗遮挡输入框这几种情况在外部看起来一模一样
   * （选择器查不到）。不带现场就把结论抛给用户，只会让人去更新一个没坏的适配器。
   *
   * candidates 列出页面上真实存在的可编辑元素 —— 有了它就能直接判定
   * 是该改选择器，还是该登录/关弹窗。
   */
  function describeEditable(el) {
    var cls = (typeof el.className === 'string' ? el.className : '').split(' ')[0].slice(0, 30);
    var ga = function (k) { return el.getAttribute(k) || ''; };
    return el.tagName.toLowerCase() +
      (el.id ? '#' + el.id : '') +
      (ga('name') ? '[name=' + ga('name') + ']' : '') +
      (cls ? '.' + cls : '') +
      (ga('role') ? ' role=' + ga('role') : '') +
      (ga('aria-label') ? ' aria=' + ga('aria-label') : '') +
      (ga('placeholder') ? ' ph=' + ga('placeholder') : '') +
      (el.isContentEditable ? ' editable' : '') +
      (isVisible(el) ? '' : ' hidden');
  }

  function pageSnapshot() {
    try {
      var cands = document.querySelectorAll(
        '[contenteditable="true"],textarea,input[type=text],input[type=tel],input:not([type])');
      var listed = [];
      for (var i = 0; i < cands.length && i < 4; i++) listed.push(describeEditable(cands[i]));
      var text = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 80);
      return '{url=' + location.href.slice(0, 90) +
        ' title=' + (document.title || '').slice(0, 30) +
        ' viewport=' + window.innerWidth + 'x' + window.innerHeight +
        ' visibility=' + document.visibilityState +
        ' ready=' + document.readyState +
        ' inputs=' + cands.length +
        ' candidates=[' + listed.join(' | ') + ']' +
        ' loginForms=' + document.querySelectorAll('form[action*="login"]').length +
        ' dialog=' + document.querySelectorAll('[role="dialog"],[class*="modal" i]').length +
        ' body="' + text + '"}';
    } catch (e) {
      return '{snapshot unavailable}';
    }
  }

  /**
   * 可见性判定：用 offsetParent 而非 CSS :hidden —— WebContentsView 内
   * 样式计算时序不稳定，:hidden 会误判。
   *
   * 豆包这类「发送与打断按钮同时渲染在 DOM、靠 class 互斥隐藏」的站点，
   * 必须靠可见性而非存在性区分当前处于哪个态。
   */
  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    var st = window.getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  }

  function q(sel) {
    if (!sel) return null;
    try { return document.querySelector(sel); } catch (e) { return null; }
  }

  /**
   * 选择器命中多个时，取第一个「可见」的，全不可见才退回第一个。
   *
   * input 常写成候选并集（DeepSeek 现在是 user query / search / 占位符三档），
   * 而 querySelector 按文档顺序返回 —— 一旦并集里混进侧栏搜索框之类的兄弟节点，
   * 提示词就会被打进那个框，表现为「发送了但永远等不到回复」。
   * 可见优先能把这种错配挡在选择器层之外。
   */
  function pickVisible(sel) {
    if (!sel) return null;
    var list;
    try { list = document.querySelectorAll(sel); } catch (e) { return null; }
    if (!list || !list.length) return null;
    for (var i = 0; i < list.length; i++) { if (isVisible(list[i])) return list[i]; }
    return list[0];
  }

  /**
   * 「本轮文本还在不在输入框里」，并顺手把那个节点留在 window.__torraHold。
   *
   * 不能按 spec.selectors.input 反查：Quill 的 .ql-blank 只在编辑器为空时存在，
   * 字一落地这个 class 就被移除，选择器指向的节点查无此人。
   * 改成扫描通用可编辑候选，谁装着这段话就算谁。取前 12 字做探针即可判定，
   * 整段比较在长提示词上是白花的开销。
   */
  function holdsPromptText(prompt) {
    try {
      var probe = String(prompt || '').replace(/\\s+/g, ' ').trim().slice(0, 12);
      if (!probe) return false;
      var nodes = document.querySelectorAll('textarea,input,[contenteditable]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!(el.isContentEditable || el.tagName === 'TEXTAREA' ||
              (el.tagName === 'INPUT' && el.type !== 'password'))) continue;
        var t = String((el.isContentEditable ? el.innerText : el.value) || '').replace(/\\s+/g, ' ').trim();
        if (t.length > 0 && t.indexOf(probe) >= 0) { window.__torraHold = el; return true; }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * 等待选择器出现。
   * 站点为 SPA，load 完成后输入框仍可能延迟数秒才挂载；
   * 一次性查询会把「还没渲染完」误判为「适配器失效」。
   */
  function waitFor(selector, timeoutMs) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + timeoutMs;
      (function tick() {
        var el = pickVisible(selector);
        if (el) { resolve(el); return; }
        if (Date.now() > deadline) { resolve(null); return; }
        setTimeout(tick, 300);
      })();
    });
  }

  /**
   * React 受控组件陷阱。
   *
   * 直接 el.value += x 不会触发 React 的 onChange —— React 用 value tracker
   * 比对「上一次渲染的值」，绕过原生 setter 就等于没输入。
   * 必须走 prototype 上的原生 setter，再手动派发 input 事件。
   */
  function setNativeValue(el, value) {
    var proto = (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement)
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function resolveKind(spec, input) {
    // 元素本身说了算：input_kind 是人在 YAML 里写的断言，DOM 形态才是事实。
    // 断言写错时按断言走，会打成「输入了但框里是空的」。
    if (input && input.isContentEditable) return 'contenteditable';
    if (spec.input_kind) return spec.input_kind;
    var sel = spec.selectors.input || '';
    if (/contenteditable|\\[role=['"]?textbox/.test(sel)) return 'contenteditable';
    return 'textarea';
  }

  function clearInput(input, kind) {
    input.focus();
    if (kind === 'contenteditable') {
      input.textContent = '';
      try {
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      } catch (e) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      setNativeValue(input, '');
    }
  }

  /**
   * 写入输入框：先整段塞进去，塞不进再逐字。
   *
   * 两条路走的是同一条通道 —— textarea 用原生 setter 再补派发 input 事件（React 受控），
   * contenteditable 用 execCommand('insertText')（Lexical / Slate / ProseMirror 唯一认的
   * 通道，它们本来就天天处理整段粘贴，一次一千字和一次一个字对它们没有区别）。
   * 原来每字符停 80–220ms 唯一的作用像真人打字，而研讨里一轮提问有一千七百字：
   * 光敲就三百秒，站点真正生成只花十几秒（2026-10-07 流水线实测 selector|type avg 143s）。
   *
   * 逐字兜底不许省：站点要是拒收整段写入（自己清空、或只吃下前半截），老路径是验证过能用的。
   * 判据取「首尾探针 + 长度下限」而不是整段比较：长文本上整段比较是白花的开销，
   * 而「只吃下开头」正是截断的形态，光比长度看不出来。
   */
  function typeInto(input, text, delayRange, jitter, kind) {
    if (insertWhole(input, text, kind)) return Promise.resolve('whole');
    // 整段没落地：把写坏的部分抹干净再逐字，否则兜底会拼出半句话
    clearInput(input, kind);
    return typeCharByChar(input, text, delayRange, jitter, kind).then(function () { return 'char'; });
  }

  /** 整段写入，并立刻判定「框里是不是真的装着整段话」 */
  function insertWhole(input, text, kind) {
    try {
      if (kind === 'contenteditable') {
        input.focus();
        document.execCommand('insertText', false, text);
      } else {
        setNativeValue(input, text);
      }
    } catch (e) {
      return false;
    }
    return holdsWhole(input, text);
  }

  function holdsWhole(input, text) {
    var want = flatText(text);
    var got = flatText(input.isContentEditable ? input.innerText : input.value);
    if (!want) return got.length === 0;
    return got.length >= Math.floor(want.length * 0.8) &&
      got.indexOf(want.slice(0, 12)) >= 0 &&
      got.indexOf(want.slice(-12)) >= 0;
  }

  function flatText(v) {
    return String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
  }

  /**
   * 逐字兜底：节奏沿用适配器里的 typing_delay_ms，只在整段写入没落地时走。
   */
  function typeCharByChar(input, text, delayRange, jitter, kind) {
    return new Promise(function (resolve) {
      var i = 0;
      function step() {
        if (i >= text.length) { resolve(); return; }
        var chunk = text.slice(i, i + 1);
        if (kind === 'contenteditable') {
          document.execCommand('insertText', false, chunk);
        } else {
          setNativeValue(input, (input.value || '') + chunk);
        }
        i += 1;
        delayIn(delayRange, jitter).then(step);
      }
      step();
    });
  }

  /**
   * HTML → Markdown。
   *
   * innerText 把富文本 DOM 压成纯字符流：标题、加粗、列表层级、代码块、
   * 表格全部消失，渲染端拿到的就是一坨排版错乱的文本 —— 而 Markdown.tsx
   * 明明支持全套 GFM。抓取侧改走结构化遍历，把站点渲染出的格式还原成
   * Markdown，让渲染端照原样重排。
   *
   * 本文件处于 TS 模板字面量中：正则里的反斜杠必须写成双份（\\s），
   * 反引号字符不能直接出现（会终结模板），注入侧用 \\u0060 表示。
   */
  var MD_SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, BUTTON: 1, SVG: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, IMG: 1, VIDEO: 1, AUDIO: 1, IFRAME: 1, CANVAS: 1, DATALIST: 1, TEMPLATE: 1 };
  var MD_BLOCK = { ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, DETAILS: 1, DIV: 1, DL: 1, FIELDSET: 1, FIGCAPTION: 1, FIGURE: 1, FOOTER: 1, FORM: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, HEADER: 1, HR: 1, LI: 1, MAIN: 1, NAV: 1, OL: 1, P: 1, PRE: 1, SECTION: 1, SUMMARY: 1, TABLE: 1, UL: 1, BR: 1 };
  var MD_BACKTICK = '\\u0060';

  /**
   * 隐藏元素判定：sr-only 标签（「ChatGPT 说：」一类）、display:none 的
   * 折叠内容不该混进回答。用 computed style 而非 offsetParent ——
   * 后台挂起的 WebContentsView 里布局照常，但个别站点用 clip 藏标签。
   */
  function mdHidden(el) {
    try {
      var st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return true;
      if (st.position === 'absolute' &&
          (st.clip.indexOf('rect(0') >= 0 || st.clipPath === 'inset(50%)')) return true;
      if (parseFloat(st.width) <= 1 && parseFloat(st.height) <= 1 && st.overflow === 'hidden') return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  function mdInlineText(t) {
    return String(t || '').replace(/\\s+/g, ' ');
  }

  function mdWrapInline(el, text) {
    var core = String(text || '').trim();
    if (!core) return text || '';
    var lead = /^\\s/.test(text) ? ' ' : '';
    var tail = /\\s$/.test(text) ? ' ' : '';
    var tag = el.tagName;
    if (tag === 'STRONG' || tag === 'B') return lead + '**' + core + '**' + tail;
    if (tag === 'EM' || tag === 'I') return lead + '*' + core + '*' + tail;
    if (tag === 'CODE') {
      // 正文里可能自带反引号：围栏取「最长连续反引号 + 1」才不会被击穿
      var maxRun = 0, run = 0;
      for (var i = 0; i < core.length; i++) {
        if (core[i] === MD_BACKTICK) { run++; if (run > maxRun) maxRun = run; } else run = 0;
      }
      var fence = '';
      for (var f = 0; f <= maxRun; f++) fence += MD_BACKTICK;
      return lead + fence + core + fence + tail;
    }
    if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') return lead + '~~' + core + '~~' + tail;
    if (tag === 'SUP') return lead + '[' + core + ']' + tail;
    if (tag === 'A') {
      var href = el.getAttribute('href') || '';
      if (!href || href.indexOf('javascript:') === 0) return lead + core + tail;
      return lead + '[' + core + '](' + href + ')' + tail;
    }
    return text; // span / u / mark 等内层：原样保留
  }

  var __listDepth = 0;
  /**
   * 列表项序列化。
   *
   * 两个来自真实站点的坑：
   * ① 站点把列表符号本身写成了文本节点（元宝 <span class="ybc-li-component_dot">•</span>，
   *    有序列表里同一个元素装的就是「1.」）。Markdown 的列表项自带符号，再带上它就抓出
   *    「- •」「1. 1.」这样一行 —— 渲染端看着像排版坏了，其实是抓取重复了符号。
   * ② 条目正文是块级元素时（元宝把每条内容包在 <div class="ybc-p"> 里），
   *    序列化结果内部带空行；CommonMark 只承认「缩进的续行」还属于这个条目，
   *    顶格的内容会整段掉出列表。所以除首行外逐行补缩进。
   */
  var MD_LEAD_BULLET = /^[\\u00b7\\u2022\\u2023\\u2027\\u2219\\u25aa\\u25cf\\u25cb\\u25e6\\u30fb\\uff65]+\\s*/;
  // 站点自绘的编号。后面 (?![\\d]) 是为了不吃掉「1.5 米」「2、3 月」这类以数字开头的正文。
  var MD_LEAD_NUM = /^(\\d{1,3})[.、)．）](?![\\d])/;
  function mdList(listEl) {
    var myDepth = __listDepth;
    var ordered = listEl.tagName === 'OL';
    var idx = parseInt(listEl.getAttribute('start') || '1', 10);
    if (isNaN(idx)) idx = 1;
    var start = idx;
    var indent = '';
    for (var d = 0; d < myDepth; d++) indent += '  ';
    var cont = indent + '  ';
    var lines = [];
    var kids = listEl.children;
    var liNo = 0;
    __listDepth = myDepth + 1;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].tagName !== 'LI') continue;
      liNo++;
      // 站点按 li 的位置编号，被跳过的空条目也占一个号，所以不能拿输出用的 idx 比。
      var expect = start + liNo - 1;
      var body = mdChildren(kids[i]).trim().replace(MD_LEAD_BULLET, '').trim();
      if (ordered) {
        var num = body.match(MD_LEAD_NUM);
        // 只在编号和这一项的序号真对得上时才剥：对不上说明那是正文自己的数字，留着。
        if (num && Number(num[1]) === expect) body = body.slice(num[0].length).trim();
      }
      if (!body) continue; // 去完符号就空的条目：宁可不画，也不要留一行孤零零的圆点
      var parts = body.split('\\n');
      for (var p = 1; p < parts.length; p++) {
        // 嵌套列表由内层 mdList 自带缩进，别重复加；空行无需缩进
        if (!parts[p].trim() || /^[ ]{2,}/.test(parts[p])) continue;
        parts[p] = cont + parts[p];
      }
      lines.push(indent + (ordered ? (idx++) + '. ' : '- ') + parts.join('\\n'));
    }
    __listDepth = myDepth;
    return lines.join('\\n');
  }

  function mdPre(el) {
    var codeEl = el.querySelector('code');
    var text = String((codeEl ? codeEl.textContent : el.textContent) || '').replace(/\\n+$/, '');
    var cls = String((codeEl && codeEl.getAttribute('class')) || el.getAttribute('class') || '');
    var m = cls.match(/language-([\\w.+-]+)/);
    var fence = '';
    var maxRun = 0, run = 0;
    for (var i = 0; i < text.length; i++) {
      if (text[i] === MD_BACKTICK) { run++; if (run > maxRun) maxRun = run; } else run = 0;
    }
    // 围栏至少 3 个反引号（GFM 规定）；正文含反引号时再加长，以免代码把围栏击穿
    var need = Math.max(3, maxRun + 1);
    for (var f = 0; f < need; f++) fence += MD_BACKTICK;
    return fence + (m ? m[1] : '') + '\\n' + text + '\\n' + fence;
  }

  function mdTable(el) {
    var trs;
    try { trs = el.querySelectorAll('tr'); } catch (e) { return ''; }
    if (!trs || !trs.length) return '';
    var rows = [];
    var maxCols = 0;
    for (var i = 0; i < trs.length && i < 200; i++) {
      var cells = trs[i].children;
      var cols = [];
      for (var j = 0; j < cells.length; j++) {
        var tg = cells[j].tagName;
        if (tg !== 'TD' && tg !== 'TH') continue;
        var c = mdChildren(cells[j]).replace(/\\s+/g, ' ').trim().replace(/\\|/g, '\\\\|');
        cols.push(c);
      }
      if (!cols.length) continue;
      if (cols.length > maxCols) maxCols = cols.length;
      rows.push('| ' + cols.join(' | ') + ' |');
    }
    if (!rows.length) return '';
    var seps = [];
    for (var s = 0; s < maxCols; s++) seps.push('---');
    return rows[0] + '\\n| ' + seps.join(' | ') + ' |\\n' + rows.slice(1).join('\\n');
  }

  /**
   * 站点自己标注「复制时不要带上」的部件 —— 元宝的相关视频卡片带 data-hidecopy="true"。
   * 那是站点的推荐位而不是回答内容，抓进来就是一坨「00:29 / 标题 / 作者 / 1个月前」。
   * 卡片标题在 data-hidecopy 元素外面，所以整块只剩 hidecopy 内容时连标题一起丢。
   */
  function mdHidecopy(el) {
    if (el.hasAttribute && el.hasAttribute('data-hidecopy')) return 'drop';
    if (!el.querySelector || !el.querySelector('[data-hidecopy]')) return '';
    var own = '';
    var kn = el.childNodes;
    for (var k = 0; k < kn.length; k++) if (kn[k].nodeType === 3) own += kn[k].nodeValue;
    if (own.trim()) return ''; // 自己带正文：只丢卡片，不牵连这一段
    var clone = el.cloneNode(true);
    var hits = clone.querySelectorAll('[data-hidecopy]');
    for (var z = 0; z < hits.length; z++) hits[z].parentNode.removeChild(hits[z]);
    var rest = (clone.textContent || '').trim();
    // 摘掉卡片后只剩一个短标题（「相关视频」）：整块丢掉，别留一行没头没尾的标签。
    return rest.length <= 24 ? 'drop' : '';
  }

  function mdChildren(node) {
    var out = '';
    var inline = '';
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) { inline += mdInlineText(n.nodeValue); continue; }
      if (n.nodeType !== 1) continue;
      var el = n;
      var tag = el.tagName;
      if (MD_SKIP[tag] || mdHidden(el) || mdHidecopy(el)) continue;
      if (tag === 'BR') { inline += '\\n'; continue; }
      if (MD_BLOCK[tag]) {
        out += inline; inline = '';
        out += mdBlock(el);
        continue;
      }
      inline += mdWrapInline(el, mdChildren(el));
    }
    out += inline;
    return out;
  }

  function mdBlock(el) {
    var tag = el.tagName;
    if (tag === 'PRE') return '\\n\\n' + mdPre(el) + '\\n\\n';
    if (tag === 'UL' || tag === 'OL') return '\\n\\n' + mdList(el) + '\\n\\n';
    if (tag === 'TABLE') return '\\n\\n' + mdTable(el) + '\\n\\n';
    if (tag === 'HR') return '\\n\\n---\\n\\n';
    if (tag === 'BLOCKQUOTE') {
      var inner = mdChildren(el).trim();
      if (!inner) return '';
      return '\\n\\n' + '> ' + inner.replace(/\\n/g, '\\n> ') + '\\n\\n';
    }
    if (/^H[1-6]$/.test(tag)) {
      var n = parseInt(tag.slice(1), 10);
      var hashes = '';
      for (var h = 0; h < n; h++) hashes += '#';
      var head = mdChildren(el).trim();
      if (!head) return '';
      return '\\n\\n' + hashes + ' ' + head + '\\n\\n';
    }
    var body = mdChildren(el).trim();
    if (!body) return '';
    return '\\n\\n' + body + '\\n\\n';
  }

  function mdNormalize(t) {
    return String(t || '')
      .replace(/\\u00a0/g, ' ')
      .replace(/[ \\t]+\\n/g, '\\n')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
  }

  /** 任一环节抛错就退回 innerText —— 格式丢了总比内容丢了强 */
  function mdOf(el) {
    if (!el) return '';
    try {
      return mdNormalize(mdChildren(el));
    } catch (e) {
      return cleanCaptured((el.innerText || '').trim());
    }
  }

  /**
   * 发送瞬间页面上已存在的回复快照（Markdown 形态）。
   *
   * 豆包/工作流这类站点会跳新会话页或虚拟化回收节点，导致「本轮新增索引」
   * 失准：旧会话的长回答会以新节点身份落在 sinceCount 之后，被当成本轮发言
   * 提取（实测：议题是「算法效率」，卡片里却是上一会话「Agnes 图片加载」的
   * 全文）。索引挡不住重排，内容指纹可以 —— 读取时凡与发送前某节点
   * 快照完全相同的候选一律跳过。指纹与读取必须同源（都用 mdOf），
   * 否则同一节点两种文本，指纹永远拦不住。
   * 流式中的新文本是其增长前缀，不会与任何旧全文相等，不受影响。
   */
  var __staleSet = [];
  function markStale(sel) {
    __staleSet = [];
    var sels = [];
    if (sel && sel.stream) sels.push(sel.stream);
    // reasoning/steps 同理：历史轮次的思考块在虚拟化重排后同样会顶进「本轮新增索引」
    if (sel && sel.steps) sels.push(sel.steps);
    if (sel && sel.reasoning) sels.push(sel.reasoning);
    for (var si = 0; si < sels.length; si++) {
      var nodes;
      try { nodes = document.querySelectorAll(sels[si]); } catch (e) { continue; }
      for (var i = 0; i < nodes.length && i < 200; i++) {
        var t = mdOf(nodes[i]);
        if (t) __staleSet.push(t);
      }
    }
  }
  function isStaleText(t) {
    var k = (t || '').trim();
    if (!k) return false;
    for (var i = 0; i < __staleSet.length; i++) { if (__staleSet[i] === k) return true; }
    return false;
  }

  /**
   * 读取回复文本。
   * stream_mode=all 用于 segment 分段模型（Kimi：正文/思考/代码各自是独立
   * segment，只取最后一条会漏掉大部分内容）。
   *
   * excludeText：本轮刚发送的提示词。当 stream 选择器用并集把「用户回合」
   * 也纳入时（站点不再给助手元素单独打角色属性，只能按通用回合容器匹配），
   * 发送后瞬间最后一个节点可能是用户自己那句。凡是 trim 后等于提示词的节点
   * 一律跳过，避免把用户的提问当成模型回复。
   */
  /**
   * 带附件的回合里，「用户自己那句」会带着图片预览落在同一个回合容器里。
   *
   * 站点不再给助手元素单独打角色属性时，stream 只能写成通用回合选择器，
   * 于是发送后瞬间最后一个节点是用户那句 —— 而 excludeText 只在整段完全相等时
   * 生效，救不了「提示词 + 文件名/alt」这种变体。模型还没开口，
   * 我们就会把用户的提问当成本轮回复抓回去（表现为「答非所问」的源头）。
   * 判据要收紧：只有「装着 blob/data 图片 + 文本以提示词开头 + 长度只比提示词多一点」
   * 才算用户回合，否则「先复述问题再作答」的回答会被整条丢掉。
   */
  function isAttachmentTurn(el, dropFlat) {
    try {
      if (!el || !el.querySelector) return false;
      if (!el.querySelector('img[src^="blob:"],img[src^="data:"]')) return false;
      var t = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!t) return true;
      if (!dropFlat) return false;
      return t.length <= dropFlat.length + 120 && t.indexOf(dropFlat) === 0;
    } catch (e) {
      return false;
    }
  }

  function readStream(streamSel, mode, sinceCount, baselineTail, excludeText) {
    var nodes;
    try { nodes = document.querySelectorAll(streamSel); } catch (e) { return ''; }
    if (!nodes || !nodes.length) return '';
    var drop = (typeof excludeText === 'string' && excludeText.trim().length > 0) ? excludeText.trim() : null;
    var dropFlat = drop ? drop.replace(/\\s+/g, ' ').trim() : null;
    if (mode === 'all') {
      // segment 分段模型也要限定在本轮新增节点内：拼接整个文档会把历史轮次
      // 全部算进本轮回答，且站点回收/折叠旧节点时拼接结果会突然变短，
      // 让主进程把「非前缀延续」误当成新内容。
      var fromAll = (typeof sinceCount === 'number' && sinceCount >= 0) ? sinceCount : 0;
      var buf = [];
      for (var k = fromAll; k < nodes.length; k++) {
        var s = mdOf(nodes[k]);
        if (!s) continue;
        if (drop && s === drop) continue;
        if (isAttachmentTurn(nodes[k], dropFlat)) continue;
        if (isStaleText(s)) continue;
        buf.push(s);
      }
      return cleanCaptured(buf.join('\\n\\n'));
    }
    // mode 'last'：只看本轮发送之后新增的节点（sinceCount = 发送前的节点数），
    // 并从末尾往前找第一条真正有文字的节点。
    // 两个坑一起堵：① ChatGPT 会在最新回复后追加空的 assistant 占位节点，
    // 直接取 nodes[len-1] 读到空串 → 误判「未捕获到内容」；
    // ② 若本轮模型其实没产出，回退去读上一轮的文本会把旧内容当成本轮发言。
    var from = (typeof sinceCount === 'number' && sinceCount >= 0) ? sinceCount : 0;
    for (var j = nodes.length - 1; j >= from; j--) {
      if (isAttachmentTurn(nodes[j], dropFlat)) continue;
      var t = mdOf(nodes[j]);
      if (!t) continue;
      if (drop && t === drop) continue;
      if (isStaleText(t)) continue;
      return cleanCaptured(t);
    }
    // ChatGPT may reuse the assistant node that existed before sending instead
    // of appending a new node. In that case the count-based lower bound filters
    // out the current answer; accept only a changed, non-empty tail so old
    // answers are never replayed as the current turn.
    if (typeof baselineTail === 'string' && nodes.length > 0) {
      var lastNode = nodes[nodes.length - 1];
      if (!isAttachmentTurn(lastNode, dropFlat)) {
        var lastText = mdOf(lastNode);
        var tail = cleanCaptured(lastText);
        if (tail && tail !== baselineTail && !isStaleText(lastText) && !(drop && lastText === drop)) {
          // ChatGPT may reuse the previous assistant node. Strip the pre-send
          // snapshot so the agent emits only this turn's content and never
          // duplicates the previous answer in the renderer.
          if (baselineTail && tail.indexOf(baselineTail) === 0) return tail.slice(baselineTail.length);
          return tail;
        }
      }
    }
    return '';
  }

  /**
   * 归一化抓取文本。
   *
   * 站点把内联引用（角标 / 来源编号）渲染成独立元素，innerText 会在其前后
   * 各插一个换行，于是正文里出现「……的幻觉-\\n4\\n。……」这种把引用号单独
   * 顶到一行、句子被竖排割裂的情况。独占一行的纯数字即引用编号，合并回去。
   * 段落分隔是 \\n\\n、有序/无序列表项以文字或符号开头，都不会命中此模式。
   */
  function cleanCaptured(t) {
    if (!t) return t;
    return t.replace(/\\n(\\d{1,3})\\n/g, '$1');
  }

  /**
   * 完成判定。
   *
   * mode 指定的手段不可用时返回 null，交由主进程降级，最终兜底 dom_stable
   * （回复文本停止变化即视为完成）—— 这是对改版最鲁棒的一招。
   */
  function isComplete(spec) {
    var sel = spec.selectors || {};
    var mode = spec.completion && spec.completion.mode;

    if (mode === 'generating_absent' && sel.generating) {
      return !isVisible(pickVisible(sel.generating));
    }
    if (mode === 'stop_button_hidden' && sel.stop) {
      // 停止按钮存在且可见 = 仍在生成
      return !isVisible(pickVisible(sel.stop));
    }
    return null;
  }

  /** 三种手段的原始观测，供主进程做降级决策与 UI 诊断 */
  function observe(spec) {
    var sel = spec.selectors || {};
    return {
      stopVisible: sel.stop ? isVisible(pickVisible(sel.stop)) : null,
      generatingVisible: sel.generating ? isVisible(pickVisible(sel.generating)) : null,
      inputPresent: !!q(sel.input),
      sendPresent: sel.send ? !!q(sel.send) : null,
      riskWall: isRiskWall(),
      loginWall: isLoginWall(),
      // 渲染帧的探针：宿主窗口不可见时 Chromium 不出帧，
      // 靠 IntersectionObserver / rAF 挂载消息列表的站点（DeepSeek）就永远不落地正文，
      // 表现成「生成结束但未捕获到内容」。主进程据此说真话，而不是猜适配器坏了。
      visibility: document.visibilityState
    };
  }

  window.__torra = {
    /**
     * 健康自检。返回结构化结论而非裸布尔，
     * 否则主进程无法区分「未登录」与「站点改版」，只能一律报适配器失效。
     */
    probe: function (healthProbe) {
      if (isRiskWall()) return { ok: false, reason: 'risk-blocked' };
      if (isLoginWall()) return { ok: false, reason: 'login-required' };
      try {
        return document.querySelector(healthProbe)
          ? { ok: true, reason: '' }
          : { ok: false, reason: 'selector missing ' + pageSnapshot() };
      } catch (e) {
        return { ok: false, reason: 'probe error' };
      }
    },

    observe: function (spec) {
      return observe(spec);
    },

    /**
     * 按 send() 将要使用的同一条通道，报告输入框会被选中成哪个元素。
     * 体检必须测「真实写入目标」而不是「第一个匹配」，否则体检全绿、
     * 讨论里却把提示词打进了另一个框。
     */
    pickInput: function (spec) {
      var sel = (spec.selectors || {}).input || '';
      var list;
      try { list = document.querySelectorAll(sel); } catch (e) { list = []; }
      var vis = 0;
      var chosen = -1;
      for (var i = 0; i < list.length; i++) {
        if (isVisible(list[i])) { vis++; if (chosen < 0) chosen = i; }
      }
      if (chosen < 0 && list.length) chosen = 0;
      var el = chosen >= 0 ? list[chosen] : null;
      return {
        total: list.length,
        visible: vis,
        index: chosen,
        tag: el ? el.tagName.toLowerCase() : '',
        name: el ? (el.getAttribute('name') || '') : '',
        placeholder: el ? (el.getAttribute('placeholder') || '').slice(0, 24) : '',
        editable: el ? (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') : false
      };
    },

    /**
     * 聚焦 send() 真正会写入的那个输入框。
     * 粘贴必须打在同一个目标上：早期版本用裸 querySelector 取第一个匹配，
     * 而 send() 用 pickVisible 取可见项，两者在「同时挂着隐藏旧输入框」的站点上
     * 不是同一个元素，图片就粘到了没人监听的节点里。
     */
    focusInput: function (spec) {
      var sel = (spec.selectors || {}).input || 'textarea,[contenteditable="true"],input[type="text"]';
      var el = typedInput() || pickVisible(sel) || document.querySelector(sel);
      if (!el) return false;
      el.focus();
      return true;
    },

    /**
     * 附件预览的通用形态：站内新贴的图几乎都以 blob:/data: 的 img 出现。
     * 只用于「粘没粘上」的观测，不作为发送的前置条件（textarea 型站点的附件
     * 存在 React state 里，DOM 上未必有预览，判死会把能发的文字也拦下）。
     */
    attachCount: function () {
      try { return document.querySelectorAll('img[src^="blob:"],img[src^="data:"]').length; } catch (e) { return 0; }
    },

    /**
     * 键入阶段：登录判定 → 等输入框 → 清空 → 写入（整段优先，逐字兜底）→ 发送前停顿。
     * 单独拆出来是为了让「贴附件」插在清空之后、按发送之前 ——
     * clearInput 会把 contenteditable 里的图片节点一起抹掉（实测 img 1→0），
     * 所以早先「先粘图再 send()」的顺序等于白粘。
     * mode 是给诊断日志用的：whole＝整段落地，char＝站点拒收整段、退回逐字。
     */
    typePrompt: function (spec, prompt) {
      // 风控拦截 / 登录墙 / 人机验证检测：不尝试破解，直接交还用户。
      // 顺序不可调整 —— 这些页面根本没有输入框，先查选择器会误判为适配器失效。
      if (isRiskWall()) {
        return Promise.resolve({ ok: false, reason: 'risk-blocked', kind: '', mode: '' });
      }
      if (isLoginWall()) {
        return Promise.resolve({ ok: false, reason: 'login-required', kind: '', mode: '' });
      }
      return waitFor(spec.selectors.input, 15000).then(function (input) {
        if (!input) {
          // 等待期间可能被重定向到登录页 / 风控页：再判一次，
          // 否则「登录过期 / 环境异常」会被报成「适配器失效」。
          if (isRiskWall()) return { ok: false, reason: 'risk-blocked', kind: '', mode: '' };
          if (isLoginWall()) return { ok: false, reason: 'login-required', kind: '', mode: '' };
          return { ok: false, reason: 'input selector missing，适配器期望 ' + spec.selectors.input + ' ' + pageSnapshot(), kind: '', mode: '' };
        }
        var kind = resolveKind(spec, input);
        __typedInput = input;
        clearInput(input, kind);
        return typeInto(input, prompt, spec.automation.typing_delay_ms, spec.automation.jitter, kind)
          .then(function (mode) {
            return delayIn(spec.automation.pre_send_pause_ms, spec.automation.jitter)
              .then(function () { return { ok: true, reason: '', kind: kind, mode: mode }; });
          });
      });
    },

    /**
     * 发送阶段：抓本轮基线 → 点按钮/回车 → 等生成开始。
     * 必须在 typePrompt 之后调用（基线要在文本落地后才准）。
     * attachments：本轮贴了几张图，用于放宽「生成未开始」的判死窗口。
     */
    pressSend: function (spec, prompt, attachments) {
      var sel = spec.selectors || {};
      // 优先用键入阶段真正写过字的节点，其次才是按选择器重查 —— 见 __typedInput 注释
      var input = typedInput() || pickVisible(sel.input) || document.querySelector(sel.input);
      var sendMode = spec.send_mode || 'click';

      // 思考容器基线：必须在「触发发送之前」抓取本轮之前的节点数
      var baseline = -1;
      var baselineTail = '';
      if (sel.stream) {
        try {
          var baselineNodes = document.querySelectorAll(sel.stream);
          baseline = baselineNodes.length;
          if (baseline > 0) baselineTail = cleanCaptured(mdOf(baselineNodes[baseline - 1]));
        } catch (e) {
          baseline = -1;
        }
        markStale(sel);
      }
      // 步骤容器的基线数：agent 站（Kimi）先出工具块、很久之后才有正文，
      // 「生成开始」必须也认步骤增长，否则 20s 内没正文就误判「未开始」。
      var stepsBaseline = -1;
      if (sel.steps) {
        try { stepsBaseline = document.querySelectorAll(sel.steps).length; } catch (e) { stepsBaseline = -1; }
      }

      // A SPA transition can leave an old hidden button in the DOM.
      // Prefer the visible candidate just like we do for the input.
      var sendBtn = sendMode === 'click' && sel.send ? pickVisible(sel.send) : null;
      // 「站点收下了这一轮」的判据要先取样本：只有我们确实把话写进去了，
      // 之后文本消失才算对方接走。空框的一直是空的，不能当收据。
      var heldBefore = holdsPromptText(prompt);
      if (sendBtn) {
        sendBtn.click();
      } else if (!input) {
        return Promise.resolve({ ok: false, reason: 'input vanished before send ' + pageSnapshot() });
      } else {
        // Enter 发送：需同时派发 keydown 与 keyup，部分站点只监听其一
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
        }));
        input.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
        }));
      }

      // 等待生成开始：完成判定手段反转，或回复区节点数增长
      // 带附件的一轮要先上传、再视觉理解，回复容器在头几十秒里就是空的，
      // 只按「回复节点变多」判开始会把已经成立的轮次判死（DeepSeek 实测）。
      // 每张图放宽 10s，上限 40s。
      var attemptAt = Date.now();
      var startDeadline = attemptAt + 20000 + Math.min(Math.max(attachments || 0, 0), 4) * 10000;
      return new Promise(function (resolve) {
        (function waitStart() {
          if (isComplete(spec) === false) { resolve({ ok: true, reason: '', streamCount: baseline }); return; }
          if (sel.stream) {
            var now;
            try { now = document.querySelectorAll(sel.stream).length; } catch (e) { now = baseline; }
            if (now > baseline || readStream(sel.stream, spec.stream_mode || 'last', baseline, baselineTail, prompt)) {
              resolve({ ok: true, reason: '', streamCount: baseline, streamBaselineText: baselineTail }); return;
            }
          }
          if (sel.steps && stepsBaseline >= 0) {
            var stepsNow;
            try { stepsNow = document.querySelectorAll(sel.steps).length; } catch (e) { stepsNow = stepsBaseline; }
            if (stepsNow > stepsBaseline) {
              resolve({ ok: true, reason: '', streamCount: baseline, streamBaselineText: baselineTail }); return;
            }
          }
          // 收据：输入框里的话没了 = 站点把这一轮接走了。
          // 带附件时这比「回复节点变多」来得早得多（上传 + 视觉理解期间容器还是空的），
          // 没有它就只能等 20s 到点，把一轮已经成立的发言判成适配器失效。
          // 1.2s 的门槛：清框与发送在同一拍里发生，太早查会读到还没更新的旧值。
          if (heldBefore && Date.now() - attemptAt > 1200 && !holdsPromptText(prompt)) {
            resolve({ ok: true, reason: '', accepted: true, streamCount: baseline, streamBaselineText: baselineTail });
            return;
          }
          if (Date.now() > startDeadline) {
            resolve({ ok: false, reason: 'generation did not start ' + pageSnapshot() }); return;
          }
          setTimeout(waitStart, 250);
        })();
      });
    },

    /** 本轮提示词是否还留在某个可编辑节点里（并留下该节点供补刀聚焦） */
    holdsPrompt: function (prompt) {
      return holdsPromptText(prompt);
    },

    send: function (spec, prompt) {
      return this.typePrompt(spec, prompt).then(function (r) {
        if (!r.ok) return r;
        return window.__torra.pressSend(spec, prompt);
      });
    },

    /** 读取当前最新一条助手消息（HTML → Markdown，保留原文格式） */
    read: function (streamSel, mode, sinceCount, baselineTail, excludeText) {
      return readStream(streamSel, mode, sinceCount, baselineTail, excludeText);
    },

    /** 距最后一次 DOM 变化的毫秒数（页面活跃度，见 __watchActivity） */
    activity: function () {
      return Date.now() - __lastMut;
    },

    /**
     * 报告选择器当前命中的节点数。
     * 供主进程在发送前抓取「思考容器」的基线数量，读取时只取本轮新增的节点，
     * 避免把上一轮的思维链当成本轮的思考。
     */
    count: function (sel) {
      if (!sel) return 0;
      try { return document.querySelectorAll(sel).length; } catch (e) { return 0; }
    },

    /** 完成判定（供主进程轮询）。返回 { complete, method } */
    done: function (spec) {
      var r = isComplete(spec);
      if (r === null) return { complete: false, method: 'dom_stable' };
      return { complete: r, method: spec.completion ? spec.completion.mode : 'stop_button_hidden' };
    }
  };
})();
`

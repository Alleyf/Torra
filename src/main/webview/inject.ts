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
   * 逐字键入。
   *
   * - textarea：原生 setter + input 事件（兼容 React 受控）
   * - contenteditable：execCommand('insertText')。这是 Lexical / Slate /
   *   ProseMirror 这类富文本编辑器唯一能正确响应的通道 ——
   *   逐字改 textContent 会被它们的内部状态机观察并覆盖回去，结果是「打了字但框里是空的」。
   */
  function typeInto(input, text, delayRange, jitter, kind) {
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
   * 读取回复文本。
   * stream_mode=all 用于 segment 分段模型（Kimi：正文/思考/代码各自是独立
   * segment，只取最后一条会漏掉大部分内容）。
   *
   * excludeText：本轮刚发送的提示词。当 stream 选择器用并集把「用户回合」
   * 也纳入时（站点不再给助手元素单独打角色属性，只能按通用回合容器匹配），
   * 发送后瞬间最后一个节点可能是用户自己那句。凡是 trim 后等于提示词的节点
   * 一律跳过，避免把用户的提问当成模型回复。
   */
  function readStream(streamSel, mode, sinceCount, baselineTail, excludeText) {
    var nodes;
    try { nodes = document.querySelectorAll(streamSel); } catch (e) { return ''; }
    if (!nodes || !nodes.length) return '';
    var drop = (typeof excludeText === 'string' && excludeText.trim().length > 0) ? excludeText.trim() : null;
    if (mode === 'all') {
      var buf = [];
      for (var k = 0; k < nodes.length; k++) buf.push(nodes[k].innerText || '');
      return cleanCaptured(buf.join('\\n'));
    }
    // mode 'last'：只看本轮发送之后新增的节点（sinceCount = 发送前的节点数），
    // 并从末尾往前找第一条真正有文字的节点。
    // 两个坑一起堵：① ChatGPT 会在最新回复后追加空的 assistant 占位节点，
    // 直接取 nodes[len-1] 读到空串 → 误判「未捕获到内容」；
    // ② 若本轮模型其实没产出，回退去读上一轮的文本会把旧内容当成本轮发言。
    var from = (typeof sinceCount === 'number' && sinceCount >= 0) ? sinceCount : 0;
    for (var j = nodes.length - 1; j >= from; j--) {
      var t = nodes[j].innerText;
      if (!t || t.trim().length === 0) continue;
      if (drop && t.trim() === drop) continue;
      return cleanCaptured(t);
    }
    // ChatGPT may reuse the assistant node that existed before sending instead
    // of appending a new node. In that case the count-based lower bound filters
    // out the current answer; accept only a changed, non-empty tail so old
    // answers are never replayed as the current turn.
    if (typeof baselineTail === 'string' && nodes.length > 0) {
      var tail = cleanCaptured(nodes[nodes.length - 1].innerText || '');
      if (tail && tail !== baselineTail && !(drop && nodes[nodes.length - 1].innerText.trim() === drop)) {
        // ChatGPT may reuse the previous assistant node. Strip the pre-send
        // snapshot so the agent emits only this turn's content and never
        // duplicates the previous answer in the renderer.
        if (baselineTail && tail.indexOf(baselineTail) === 0) return tail.slice(baselineTail.length);
        return tail;
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
      loginWall: isLoginWall()
    };
  }

  window.__torra = {
    /**
     * 健康自检。返回结构化结论而非裸布尔，
     * 否则主进程无法区分「未登录」与「站点改版」，只能一律报适配器失效。
     */
    probe: function (healthProbe) {
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

    send: function (spec, prompt) {
      // 登录墙 / 人机验证检测：不尝试破解，直接交还用户。
      // 顺序不可调整 —— 未登录时输入框不存在，先查选择器会误判为适配器失效。
      if (isLoginWall()) {
        return Promise.resolve({ ok: false, reason: 'login-required' });
      }

      return waitFor(spec.selectors.input, 15000).then(function (input) {
        if (!input) {
          // 等待期间可能被重定向到登录页 / 风控页：再判一次，
          // 否则「登录过期」会被报成「适配器失效」。
          if (isLoginWall()) return { ok: false, reason: 'login-required' };
          return { ok: false, reason: 'input selector missing，适配器期望 ' + spec.selectors.input + ' ' + pageSnapshot() };
        }

        var kind = resolveKind(spec, input);
        var sel = spec.selectors || {};
        var sendMode = spec.send_mode || 'click';

        clearInput(input, kind);
        return typeInto(input, prompt, spec.automation.typing_delay_ms, spec.automation.jitter, kind)
          .then(function () { return delayIn(spec.automation.pre_send_pause_ms, spec.automation.jitter); })
          .then(function () {
            // 发送前先记录回复容器节点数：本轮新增的消息必定在此索引之后，
            // 供 read(sinceCount) 精确锁定「本轮回复」，避免读到上一轮或空占位节点
            var baseline = -1;
            var baselineTail = '';
            if (sel.stream) {
              try {
                var baselineNodes = document.querySelectorAll(sel.stream);
                baseline = baselineNodes.length;
                if (baseline > 0) baselineTail = cleanCaptured(baselineNodes[baseline - 1].innerText || '');
              } catch (e) {
                baseline = -1;
              }
            }

            // A SPA transition can leave an old hidden button in the DOM.
            // Prefer the visible candidate just like we do for the input.
            var sendBtn = sendMode === 'click' && sel.send ? pickVisible(sel.send) : null;
            if (sendBtn) {
              sendBtn.click();
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
            var startDeadline = Date.now() + 20000;
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
                if (Date.now() > startDeadline) {
                  resolve({ ok: false, reason: 'generation did not start ' + pageSnapshot() }); return;
                }
                setTimeout(waitStart, 250);
              })();
            });
          });
      });
    },

    /** 读取当前最新一条助手消息的纯文本 */
    read: function (streamSel, mode, sinceCount, baselineTail, excludeText) {
      return readStream(streamSel, mode, sinceCount, baselineTail, excludeText);
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

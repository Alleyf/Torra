/**
 * 选择器拾取脚本（运行在站点页面上下文）
 *
 * 用途：让用户在真实页面上点选元素，自动生成稳健的 CSS 选择器。
 * 这是「用户自己配置网页版 LLM」能否可用的关键 ——
 * 让用户手写选择器既易错又不可验证，而「点一下就生成」能把
 * 「选择器失效」这类静默错误消灭在配置阶段。
 *
 * 生成策略（按稳健度排序）：
 * 1. data-testid —— 最稳，站点为自动化专门预留的钩子
 * 2. id —— 语义 id 稳定；但形如 :r3: 的 React 动态 id 不稳定，剔除
 * 3. aria-label —— 语义稳定且随语言本地化
 * 4. name / placeholder / type 等语义属性
 * 5. 标签名 + 稳定 class 组合 —— 剔除形如 _52c986b、css-md-xxx 的哈希类名
 * 6. 兜底：nth-child 路径 —— 保证总能生成一个，但脆，需在 UI 上标注
 *
 * 与 INJECT_SCRIPT 一样以字符串常量导出，供 executeJavaScript 注入。
 */
export const PICKER_SCRIPT = `
(function () {
  if (window.__torraPicker) return;

  var HASHY = /^(?:_|-)?[a-zA-Z]*[0-9][a-zA-Z0-9]{4,}$/;
  var REACT_ID = /^:[a-zA-Z-]+:$/;
  var CSS_MOD = /^(css|sc|jsx|emotion)-[a-z0-9]{4,}$/i;

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\\\' + c; });
  }

  var EDITABLE_SEL = 'textarea,input[type="text"],[contenteditable="true"],[role="textbox"]';

  /**
   * 命中范围里是否含输入框。
   * 回复容器永远不包含提问输入框；包含的一定是整页/列表外壳 ——
   * 把它当 stream 用「成功」读到整页文本，是比 0 命中更隐蔽的错误。
   */
  function containsComposer(el) {
    try { return !!(el && el.matches && el.matches(EDITABLE_SEL)) || !!(el && el.querySelector && el.querySelector(EDITABLE_SEL)); } catch (e) { return false; }
  }

  function isStableClass(c) {
    if (!c) return false;
    if (REACT_ID.test(c) || CSS_MOD.test(c)) return false;
    // 哈希类名：含数字且总体像随机串（如 _52c986b、UFCX0V、YelHeN）
    if (HASHY.test(c)) return false;
    // Tailwind 原子类不含语义信息，剔除以缩短选择器
    if (/^(sm|md|lg|xl|px|py|pt|pb|mt|mb|ml|mr|flex|grid|w|h|text|bg|border|rounded)-/.test(c)) return false;
    return c.length <= 40;
  }

  /** 生成候选选择器，从最稳到最脆 */
  function candidatesFor(el) {
    var out = [];
    var tag = el.tagName.toLowerCase();

    var testid = el.getAttribute('data-testid') ||
      el.getAttribute('data-test-id') || el.getAttribute('data-qa');
    if (testid) out.push(tag + '[data-testid="' + testid + '"]');

    if (el.id && !REACT_ID.test(el.id)) out.push('#' + cssEscape(el.id));

    var aria = el.getAttribute('aria-label');
    if (aria) out.push(tag + '[aria-label="' + cssEscape(aria) + '"]');

    var name = el.getAttribute('name');
    if (name && name !== 'user query') out.push(tag + '[name="' + cssEscape(name) + '"]');

    var ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder');
    if (ph) out.push(tag + '[placeholder^="' + cssEscape(ph.slice(0, 24)) + '"]');

    var cls = Array.prototype.slice.call(el.classList).filter(isStableClass);
    if (cls.length > 0) {
      out.push(tag + '.' + cls.map(cssEscape).join('.'));
    } else if (tag !== 'div' && tag !== 'span') {
      out.push(tag);
    }

    // 兜底：向上找到有稳定 id/祖先的路径
    var path = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      var ntag = node.tagName.toLowerCase();
      if (node.id && !REACT_ID.test(node.id)) {
        path.unshift('#' + cssEscape(node.id));
        path.unshift(ntag);
        out.push(path.join(' > '));
        break;
      }
      var nth = node.parentNode
        ? Array.prototype.indexOf.call(node.parentNode.children, node) + 1
        : 1;
      path.unshift(ntag + ':nth-child(' + nth + ')');
      node = node.parentNode;
      depth += 1;
    }
    if (path.length > 0) out.push(path.join(' > '));

    return out;
  }

  /** 校验候选唯一性 —— 匹配到多个元素的候选直接标记为不可用 */
  function evaluate(el) {
    var cands = candidatesFor(el);
    var chosen = null;
    var list = [];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var n = 0;
      try { n = document.querySelectorAll(c).length; } catch (e) { n = -1; }
      list.push({ selector: c, matches: n });
      if (n === 1 && !chosen) chosen = c;
    }
    return {
      chosen: chosen || cands[0] || tagFallback(el),
      candidates: list
    };
  }

  function tagFallback(el) {
    return el.tagName.toLowerCase();
  }

  /**
   * 可见性判定用 offsetParent + 尺寸，而不是 CSS :hidden。
   * 与 INJECT_SCRIPT 同一套判据：一个 composer 常有多个候选（历史占位、
   * 折叠的备用输入框），只有可见的那个能收输入。
   */
  function vis(el) {
    if (!el) return false;
    if (el.offsetParent === null && el.tagName !== 'BODY') return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    var st = window.getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  }

  function firstVisible(sel) {
    if (!sel) return null;
    var list;
    try { list = document.querySelectorAll(sel); } catch (e) { return null; }
    for (var i = 0; i < list.length; i++) { if (vis(list[i])) return list[i]; }
    return list.length ? list[0] : null;
  }

  /**
   * 没给输入框选择器时自动认一个对话框：取「最靠下、够宽」的可见可编辑元素。
   * 对话输入框在页面底部，侧栏搜索框既窄又靠上，这条几何判据就够用。
   */
  function autoComposer() {
    var best = null;
    var bestBottom = -1;
    var list;
    try { list = document.querySelectorAll(EDITABLE_SEL); } catch (e) { return null; }
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!vis(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 160) continue;
      if (r.bottom > bestBottom) { bestBottom = r.bottom; best = el; }
    }
    return best;
  }

  /** React 受控组件：必须走原型上的原生 setter，否则 onChange 不触发，框里看着有字而站点认为没字 */
  function setNativeValue(el, value) {
    var proto = (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement)
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function selectAllIn(el) {
    try {
      var r = document.createRange();
      r.selectNodeContents(el);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } catch (e) {}
  }

  function describeEl(el) {
    if (!el) return '';
    var named = el.getAttribute('placeholder') || el.getAttribute('aria-label') ||
      el.getAttribute('data-testid') || el.getAttribute('name') || '';
    return el.tagName.toLowerCase() + (named ? ' 「' + String(named).replace(/\\s+/g, ' ').trim().slice(0, 24) + '」' : '');
  }

  /** 回车三件套：多数网页对话框按 Enter 发送，且只听合成键盘事件 */
  function pressEnter(el) {
    ['keydown', 'keypress', 'keyup'].forEach(function (t) {
      el.dispatchEvent(new KeyboardEvent(t, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
      }));
    });
  }

  /**
   * 页面上「够长、又不含输入框」的文本块，取最深的那些。
   *
   * 为什么要弃掉「按语义类名找气泡」这一条：元宝这类站点的气泡 class 是哈希串，
   * markdown/message-content 一个都没有，探针于是恒报 0 个回复 —— 而用户其实看得见回复。
   * 换成与站点无关的两条判据：文本够长、内部没有输入框（有输入框的一定是页面外壳）。
   *
   * echo 是刚替用户发出去的那句话。它自己也会变成一条气泡，不排掉就会把
   * 「发出去了」误判成「回回来了」，识别链会在没有回复的页面上开始猜 stream。
   */
  function longTextBlocks(echo) {
    var cut = norm2(echo).slice(0, 500);
    var all;
    try { all = document.querySelectorAll('div,section,article,li,p,span'); } catch (e) { return [] }
    var blocks = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (containsComposer(el)) continue;
      var t = norm2(el.innerText);
      // 24 字：一句像样的回答至少这么长，再低就会把导航、菜单读成回复
      if (t.length < 24) continue;
      // 只排掉「整块就是我们刚发出去的那句话」的用户气泡。不能用「含不含」：
      // 助手回复常会复述提问（「你好」开头），那样会把真回复也排掉。
      if (cut && t.slice(0, cut.length) === cut && t.length - cut.length <= 12) continue;
      // 嵌套只留最深的一条：整页外壳、消息列表容器、气泡、气泡内段落都会命中，
      // 全部留下会把一条回复数成四条。
      var k = blocks.length;
      var nested = false;
      while (k--) {
        if (inner(blocks[k], el)) blocks.splice(k, 1);
        else if (inner(el, blocks[k])) nested = true;
      }
      if (!nested && blocks.length < 30) blocks.push(el);
    }
    return blocks;
  }

  function inner(a, b) {
    try { return !!(a && b && a.contains && a.contains(b)); } catch (e) { return false }
  }

  function norm2(s) {
    return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  }

  /**
   * 当前对话框里的文本，每次都重新查询 —— 发送后站点往往会换掉这个节点。
   * 返回 null 表示页面上已经没有对话框（被重置 / 跳页 / 还没加载）。
   */
  function composerText(sel) {
    var input = firstVisible(sel) || autoComposer();
    if (!input) return null;
    return String((input.isContentEditable ? input.innerText : input.value) || '');
  }

  /** 输入框里是否还留着这句话：还留着＝这次发送没被站点接住 */
  function holdsText(sel, text) {
    var t = composerText(sel);
    var body = String(text == null ? '' : text).slice(0, 2000);
    if (t === null || !body) return false;
    return t.indexOf(body.slice(0, 10)) >= 0;
  }

  /**
   * 这句话是否已经作为页面上的一条消息出现（用户气泡）。
   *
   * 这是「站点真的收下了」的正面证据：输入框空了可能是发出去了，也可能是草稿被
   * 误点的按钮丢掉了 —— 只有页面上多出这条消息才算收下了。
   * 判据和 longTextBlocks 排掉提问的那条规则一致：整块基本等于这句话。
   */
  function bubbleWith(text) {
    var body = norm2(text).slice(0, 500);
    if (!body) return false;
    var all;
    try { all = document.querySelectorAll('div,section,article,li,p,span'); } catch (e) { return false; }
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (containsComposer(el)) continue;
      var t = norm2(el.innerText);
      if (t.length >= body.length && t.slice(0, body.length) === body && t.length - body.length <= 12) return true;
    }
    return false;
  }

  /**
   * 「页面上有没有一条像样的助手回复」。
   * 识别链要验证回复容器，前提是回复真的存在 —— 新开对话页面上没有，
   * 于是 stream 恒为 0 候选。本方法给出气泡数与最后一条文本，
   * 主进程据此判断发出去的消息回回来了没有。echo 用于排掉刚发出去的那句提问。
   */
  function replyProbe(echo) {
    var blocks = longTextBlocks(echo);
    var texts = [];
    for (var i = 0; i < blocks.length; i++) texts.push(norm2(blocks[i].innerText));
    var chars = 0;
    try { chars = ((document.body && document.body.innerText) || '').length; } catch (e) {}
    // sig 是「这一块说过什么」的指纹：新对话会把示例面板换成真回复，块数不涨、总字数还跌，
    // 只有按内容比集合才认得出「多了一条以前没有的话」
    var sig = [];
    for (var j = 0; j < texts.length && j < 12; j++) sig.push(texts[j].slice(0, 80));
    return { bubbles: texts.length, last: texts.length ? texts[texts.length - 1].slice(0, 160) : '', chars: chars, sig: sig };
  }

  window.__torraPicker = {
    /** 返回元素的最优选择器及全部候选（含匹配数） */
    pick: function (target) {
      try {
        var ev = evaluate(target);
        ev.tag = target.tagName.toLowerCase();
        ev.text = (target.innerText || target.value || '').slice(0, 60);
        return ev;
      } catch (e) {
        return { chosen: '', candidates: [], error: String(e) };
      }
    },

    /**
     * 扫描页面并对每个选择器角色给出候选。
     * 用于「自动识别」：用户点一次输入框，脚本顺带把
     * 发送/停止/回复容器都猜一遍，大幅减少配置步骤。
     */
    scan: function () {
      var roles = { input: [], send: [], stop: [], stream: [] };
      var BTN_SEL = 'button,[role="button"]';

      function push(bucket, el, label) {
        var e = evaluate(el);
        e.role = label;
        e.tag = el.tagName.toLowerCase();
        e.text = (el.innerText || el.value || '').slice(0, 40);
        e.inViewport = !!(el.getBoundingClientRect().width && el.getBoundingClientRect().height);
        roles[bucket].push(e);
      }

      document.querySelectorAll(EDITABLE_SEL).forEach(function (el) { push('input', el); });
      document.querySelectorAll(BTN_SEL).forEach(function (el) {
        var t = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '') +
                 ' ' + (el.getAttribute('title') || '')).toLowerCase();
        var isStop = /stop|停止|中断|打断|break/.test(t);
        push(isStop ? 'stop' : 'send', el);
      });

      // 回复容器：优先语义类；含输入框的一定是页面外壳，不能当回复节点推荐
      ['[class*="markdown"]', '[class*="markdownContent"]', '[data-message-author-role="assistant"]',
       '[class*="response-message"]', '[class*="message-content"]', '[class*="segment-content"]']
        .forEach(function (s) {
          document.querySelectorAll(s).forEach(function (el) {
            if ((el.innerText || '').length > 20 && !containsComposer(el)) push('stream', el);
          });
        });

      // 哈希类名站点（元宝等）语义类一条都不命中，改用「够长且不含输入框的文本块」兜底。
      // 少了这条，识别链在没有稳定类名时永远拿不到 stream 候选。
      if (roles.stream.length === 0) {
        longTextBlocks('').slice(0, 8).forEach(function (el) { push('stream', el); });
      }

      // 每个角色只保留前 8 个，避免回传数据过大
      Object.keys(roles).forEach(function (k) { roles[k] = roles[k].slice(0, 8); });
      return roles;
    },

    /**
     * 页面结构快照 —— 给「配置助手」（一个 API 模型）读，用于自动推断适配器配置。
     *
     * 与 scan() 的分工：scan() 只给「按角色分组的 selector 候选」，
     * 而本方法让模型看到页面本身：控件的语义属性与几何位置、消息列表的
     * 重复结构、是否停在登录页、有没有 iframe。
     *
     * 严格限制体积：模型需要的是结构，不是整页 DOM。超限时直接截断，
     * 宁可少几个控件也不要让 prompt 爆掉。
     */
    outline: function () {
      var out = {
        url: location.href,
        title: (document.title || '').slice(0, 80),
        viewport: [innerWidth, innerHeight],
        login: null,
        iframes: [],
        controls: [],
        lists: []
      };

      function clsOf(el) {
        var a = [];
        for (var i = 0; i < el.classList.length && a.length < 3; i++) {
          if (isStableClass(el.classList[i])) a.push(el.classList[i]);
        }
        return a;
      }

      function norm(s) {
        return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
      }

      function describe(el) {
        var r = el.getBoundingClientRect();
        var d = {
          tag: el.tagName.toLowerCase(),
          sel: evaluate(el).chosen,
          box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          vis: !!(r.width > 1 && r.height > 1),
          cls: clsOf(el),
          txt: norm(el.innerText || el.value || '').slice(0, 30)
        };
        var ty = el.getAttribute('type'); if (ty) d.type = ty;
        var role = el.getAttribute('role'); if (role) d.role = role;
        var aria = el.getAttribute('aria-label'); if (aria) d.aria = norm(aria).slice(0, 40);
        var ph = el.getAttribute('placeholder'); if (ph) d.ph = norm(ph).slice(0, 40);
        var tid = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-qa');
        if (tid) d.testid = norm(tid).slice(0, 40);
        if (el.id) d.id = el.id.slice(0, 40);
        if (el.isContentEditable) d.ce = 1;
        return d;
      }

      // --- 登录态线索：停在登录页时扫出来的都是登录表单，方案必然不可用 ---
      var LOGIN_HINT_PATH = ['/login', '/signin', '/sign-in', '/signup', '/register', '/auth', '/sso'];
      var path = location.pathname.toLowerCase();
      var onLoginPath = false;
      for (var lp = 0; lp < LOGIN_HINT_PATH.length; lp++) {
        if (path.indexOf(LOGIN_HINT_PATH[lp]) >= 0) onLoginPath = true;
      }
      var CTA_LABELS = ['登录', '立即登录', '登录/注册', '扫码登录', '手机号登录', '注册', 'Sign in', 'Log in', 'Login', 'Sign up'];
      var cta = [];
      var ctaNodes = document.querySelectorAll('button,a,span,div');
      for (var c = 0; c < ctaNodes.length && cta.length < 3; c++) {
        var t = norm(ctaNodes[c].textContent);
        if (t.length > 0 && t.length <= 8 && CTA_LABELS.indexOf(t) >= 0) cta.push(t);
      }
      out.login = {
        onLoginPath: onLoginPath,
        cta: cta,
        chatInputs: document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]').length
      };

      // --- iframe：主帧注入脚本看不到 iframe 里的输入框，必须作为风险提示出 ---
      var frames = document.querySelectorAll('iframe');
      for (var f = 0; f < frames.length && out.iframes.length < 5; f++) {
        var src = frames[f].getAttribute('src') || '';
        out.iframes.push({ host: src.slice(0, 60), box: (function (el) { var r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(frames[f]) });
      }

      // --- 可交互控件：输入类优先，其次按钮，总共不超过 45 个 ---
      var EDITABLE = 'textarea,input[type="text"],input[type="search"],input:not([type]),[contenteditable="true"],[role="textbox"]';
      var CLICKABLE = 'button,[role="button"]';
      var seen = [];
      function pushEl(el) {
        if (out.controls.length >= 45) return;
        if (seen.indexOf(el) >= 0) return; // 一个元素可能同时命中输入与按钮选择器
        seen.push(el);
        out.controls.push(describe(el));
      }
      document.querySelectorAll(EDITABLE).forEach(pushEl);
      document.querySelectorAll(CLICKABLE).forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (!(r.width > 1 && r.height > 1)) return; // 隐藏按钮对模型无信息量，且数量巨大
        pushEl(el);
      });

      // --- 重复结构容器：消息列表几乎都是「同标签同 class 的兄弟节点 >= 3」 ---
      var structural = document.querySelectorAll('div,ul,ol,section');
      for (var s = 0; s < structural.length && out.lists.length < 8; s++) {
        var box = structural[s];
        var n = box.childElementCount;
        if (n < 3) continue;
        var kids = box.children;
        var tag0 = kids[0].tagName;
        var cls0 = kids[0].className;
        if (typeof cls0 !== 'string') continue; // SVGAnimatedString，跳过
        var same = 0;
        var lastSame = null;
        for (var j = n - 1; j >= 0; j--) {
          if (kids[j].tagName === tag0 && kids[j].className === cls0) {
            same++;
            if (!lastSame) lastSame = kids[j];
          }
        }
        if (same < 3 || !lastSame) continue;
        var total = (box.textContent || '').length;
        if (total < 80) continue;
        out.lists.push({
          sel: evaluate(box).chosen,
          tag: tag0.toLowerCase(),
          kids: n,
          same: same,
          textLen: total,
          cls: clsOf(box),
          // 单条气泡自己的选择器：哈希类站点拿不到语义类时，这是唯一能指向「一条回复」的写法
          childSel: evaluate(lastSame).chosen,
          last: norm(lastSame.textContent).slice(0, 50)
        });
      }

      return out;
    },

    /**
     * 判断页面内存储的数量。供主进程判断「登录态是否已落到存储里」。
     * 只回数量与 key 名，不回值。
     */
    storageSnapshot: function () {
      function grab(s) {
        try {
          var a = [];
          for (var i = 0; i < s.length; i++) {
            var k = s.key(i);
            a.push({ key: k, len: (s.getItem(k) || '').length });
          }
          return a;
        } catch (e) {
          return [];
        }
      }
      return { local: grab(localStorage), session: grab(sessionStorage) };
    },

    /** 判断某选择器在当前页面的匹配情况，供 UI 做实时校验 */
    verify: function (selector) {
      try {
        var nodes = document.querySelectorAll(selector);
        var covers = false;
        for (var i = 0; i < nodes.length && i < 50; i++) {
          if (containsComposer(nodes[i])) { covers = true; break; }
        }
        return { ok: nodes.length > 0, matches: nodes.length, covers: covers };
      } catch (e) {
        return { ok: false, matches: 0, covers: false, error: String(e) };
      }
    },

    /** 回复探针：当前页面上有几条像助手回复的文本块、最后一条开头是什么；echo 排掉刚发出去的提问 */
    reply: function (echo) {
      try { return replyProbe(echo); } catch (e) { return { bubbles: 0, last: '', chars: 0, sig: [], error: String(e) }; }
    },

    /**
     * 把焦点交给对话框，供主进程的浏览器级输入通道（insertText / sendInputEvent）使用。
     * 只报「找到的是哪个元素」，不拿 document.activeElement 当成功判据 ——
     * 窗口没有系统焦点时 activeElement 会退回 body，而插入照样能成；成败由 holds() 事后测。
     */
    focusComposer: function (inputSel) {
      var input = firstVisible(inputSel) || autoComposer();
      if (!input) return { ok: false, reason: '页面上找不到可输入的对话框（可能停在登录页或还没加载完）' };
      try { input.focus(); } catch (e) {}
      return { ok: true, input: describeEl(input), ce: !!input.isContentEditable };
    },

    /** 输入框里是否还留着这句话：还留着＝这次发送没被站点接住 */
    holds: function (inputSel, text) {
      return holdsText(inputSel, text);
    },

    /** 这句话是否已经长成页面上的一条消息（用户气泡）：正面确认站点收下了 */
    bubble: function (text) {
      try { return bubbleWith(text); } catch (e) { return false; }
    },

    /**
     * 在真实页面上发一条消息：清空输入框 → 键入 → 发送，不等生成。
     *
     * 为什么要有这一步：回复容器只能在一个「已经有回复」的页面上验证，
     * 而原先这条只能由人敲键盘完成，识别链在第一步就卡死。
     * 与 INJECT_SCRIPT 的 send() 区别：send() 要求 stream 选择器已生效并等生成开始，
     * 而这里正是为了**求出** stream 选择器，页面此刻还没有可用的回复容器。
     *
     * 一次交互，先回车后点按钮：网页对话框绝大多数是 Enter 发送，而规则挑出来的
     * 「唯一命中按钮」经常是别的控件（元宝那次点中的是「进入临时对话」，一点就重置页面）。
     * 不绕过风控：站点拒收合成输入时直接回报失败，让人工发送成为兜底而不是被静默跳过。
     */
    drive: function (inputSel, text, sendSel) {
      var body = String(text == null ? '' : text).slice(0, 2000);
      if (!body.trim()) return { ok: false, reason: '要发送的文本为空' };
      var input = firstVisible(inputSel) || autoComposer();
      if (!input) {
        return { ok: false, reason: '页面上找不到可输入的对话框（可能停在登录页或还没加载完）' };
      }
      var ce = !!input.isContentEditable;
      try {
        input.focus();
        if (ce) {
          selectAllIn(input);
          document.execCommand('delete', false);
          // Lexical/Slate/ProseMirror 只认 insertText 这条通道，改 textContent 会被覆盖回去
          document.execCommand('insertText', false, body);
        } else {
          setNativeValue(input, '');
          setNativeValue(input, body);
        }
      } catch (e) {
        return { ok: false, reason: '键入失败：' + String(e) };
      }
      if ((composerText(inputSel) || '').indexOf(body.slice(0, 10)) < 0) {
        return {
          ok: false,
          reason: '文本没有写进输入框（站点拒收合成输入），请人工在窗口里发一条后重试',
          input: describeEl(input),
        };
      }
      var via = 'enter';
      pressEnter(input);
      var btn = sendSel ? firstVisible(sendSel) : null;
      if (holdsText(inputSel, body) && btn) {
        via = 'enter+click';
        try { btn.click(); } catch (e) {}
      }
      // 重新查询，不读手上这个节点：页面被重置时它脱离文档，innerText 恒为空，
      // 看着就像「站点把消息收走了」。absent＝输入框没了，才算没发出去。
      // URL 变了不算：新开对话时站点正是靠换 URL 来建这轮对话，改判据是看这句话有没有长成气泡。
      var absent = composerText(inputSel) === null;
      return {
        ok: true,
        via: via,
        input: describeEl(input),
        typed: body.length,
        left: absent ? true : holdsText(inputSel, body),
        absent: absent,
        echoed: bubbleWith(body),
        url: location.href,
      };
    }
  };
})();
`

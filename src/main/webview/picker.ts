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
    }
  };
})();
`

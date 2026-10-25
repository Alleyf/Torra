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

/**
 * 注入脚本的身份标记。
 *
 * 主进程原先只判 `!!window.__torra` 就跳过注入，那是「有没有一个叫这名字的东西」，
 * 不是「是不是我们那份」。两种失效都藏在这里：站点自己占用了这个名字（我们的注入变成
 * 空操作，随后每一处 `window.__torra.read(...)` 调的都是别人的实现），以及应用更新后
 * 文档里还留着旧版脚本（选择器口径、完成判定都和主进程对不上，表现为说不清的古怪缺席）。
 * 两者原本都会整个文档期一直错下去 —— 幂等检查把补救路径也一起短路了。
 *
 *
 * 说清楚它管不到哪儿：页面脚本照样可以保留 `__build` 只换掉 `read`，主世界的任何标记
 * 都能被主世界的代码伪造。要真正堵住，注入得搬到隔离世界（contextIsolation 的 preload），
 * 代价是整个通道改用 IPC 往返、每一处 executeJavaScript 都要重铺 —— 那是一次大改，
 * 不该和这轮修复混在一起。
 */
export const INJECT_BUILD = 'torra-inject-21'

export const INJECT_SCRIPT = `
(function () {
  var __BUILD = '${INJECT_BUILD}';
  // 幂等只认自己那份：标记不对就重新覆盖，别拿「存在」当「是我们的」
  if (window.__torra && window.__torra.__build === __BUILD) return;

  /**
   * 页面活跃度：距最后一次 DOM 变化的毫秒数。
   * Kimi 这类 agent 站执行工具时正文文本静止，但页面仍在刷新步骤/计时/流式代码。
   * 主进程用它区分「回答写完」与「工具执行间隙」，避免把截断的中间过程当最终答案。
   */
  var __lastMut = Date.now();
  /** 交付文件期间被吞掉的 file input 原生选择框调用数（诊断用，不进站点状态） */
  var __fileChooserSwallowed = 0;
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
   * 固定等一小段。
   *
   * 用在「删完之后验一遍」之前：Lexical / Slate 这类编辑器的 DOM 是内部文档渲染出来的，
   * 同步读一次往往读到的是刚被我们抹空的壳，下一帧它又把旧内容整份画回来 ——
   * 不等这一帧，清空是否真的成功根本判不出来。
   */
  function waitMs(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * 登录墙 / 人机验证判定。
   *
   * 必须早于选择器判定执行：未登录且没有输入框时，若先查选择器，会把「未登录」
   * 误报成「适配器失效」，用户会去查适配器更新而真正要做的是重新登录。
   * probe 与 send 共用本函数，避免两处判定不一致。
   *
   * 但「页面上有登录入口」从来不等于「这一轮发不出去」。实测（2026-10-19 未登录）：
   *   - chatgpt.com 侧栏那个「登录」按钮是一个 <form action="/auth/login_with"> 的提交，
   *     两个这样的 form 常驻 DOM、都不可见，而页面同时给着一个能用的输入框
   *     （textarea#mobile-composer-prompt），未登录照样能聊（发出去能回「收到」）；
   *   - 未登录的 doubao.com 没有 login form，/chat.deepseek.com 与 /login 后的 claude.ai
   *     则整页就是登录页，没有输入框。
   * 所以判据按「这一屏还能不能接住话」来定，而不是「有没有登录标记」：
   *   ① 路径本身就是登录路由 → 墙（DeepSeek / Claude 未登录必到这儿）；
   *   ② 看得见的人机验证容器 → 墙（验证码在眼前，只能人工过）；
   *   ③ 看得见的登录表单 → 墙（真把这一屏换成了登录页）；
   *   ④ 只剩看不见的登录表单（页头登录按钮的提交壳）→ 看有没有能用的输入框，
   *      有就不是墙，没有才是「未登录，请人工登录」。
   * inputSel 传适配器声明的输入框选择器；缺省时退回体检选择器，两者在内置适配器里同形。
   */
  function isLoginWall(inputSel) {
    try {
      var p = location.pathname;
      // 注意：本文件处于 TS 模板字面量中，正则里的「\/」会被折叠成「/」，
      // 使正则字面量非法（Invalid regular expression flags），故此处用 indexOf 判断。
      // /sign_in 是 DeepSeek 的登录路由：未登录时自动跳过去，
      // 页面上并没有 form[action*=login]，只靠选择器判会误报成适配器失效。
      var paths = ['/auth/login', '/auth/logout', '/login', '/signin', '/sign_in'];
      for (var i = 0; i < paths.length; i++) {
        if (p.indexOf(paths[i]) === 0) return true;
      }
      // 人机验证：看得见才算拦在眼前。看不见的那只是登录表单预挂的 recaptcha 容器，
      // 拿它当墙会把一个本来能发的页面判死（与 ③ 同一把尺子）。
      var caps;
      try {
        caps = document.querySelectorAll(
          '[name="captcha"],iframe[src*="recaptcha"],iframe[title*="challenge"],iframe[src*="challenges.cloudflare"]');
      } catch (e0) { caps = []; }
      for (var c = 0; c < caps.length; c++) { if (isVisible(caps[c])) return true; }
      var forms;
      try {
        forms = document.querySelectorAll('form[action*="login"],form[action*="signin"],form[action*="sign_in"]');
      } catch (e1) { forms = []; }
      if (!forms.length) return false;
      for (var f = 0; f < forms.length; f++) { if (isVisible(forms[f])) return true; }
      // 走到这里，登录标记全是隐藏的：页面若给着一个真能写字的框，那就不是墙。
      return !hasComposer(inputSel);
    } catch (e) {
      return false;
    }
  }

  /** 这个节点本身能不能接住文字（输入框的本体形态） */
  function isEditableNode(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    return tag === 'TEXTAREA' || (tag === 'INPUT' && el.type !== 'password' && el.type !== 'hidden');
  }

  /**
   * 页面上有没有一个「能接住这一轮」的输入框：选择器命中可见、可编辑的节点。
   *
   * 两个细节：
   * - 不能借 pickVisible —— 它在全不可见时退回 list[0]，那会把隐藏的登录页输入框
   *   算成「可用」，正好把该报「未登录」的场景放过去；这里逐个查可见性。
   * - 命中的可能是包装容器：豆包的 [data-testid="chat_input_input"] 是个 div，
   *   真正可编辑的 ProseMirror 在它里面。所以容器可见 + 内含可见可编辑节点同样算数。
   */
  function hasComposer(inputSel) {
    if (!inputSel) return false;
    var list;
    try { list = document.querySelectorAll(inputSel); } catch (e) { return false; }
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!isVisible(el)) continue;
      if (isEditableNode(el)) return true;
      var kids;
      try {
        kids = el.querySelectorAll('textarea,[contenteditable="true"],input[type=text],input:not([type])');
      } catch (e2) { kids = []; }
      for (var j = 0; j < kids.length; j++) {
        if (isVisible(kids[j]) && isEditableNode(kids[j])) return true;
      }
    }
    return false;
  }

  /**
   * 发送之后弹出的「得先登录」对话框。
   *
   * 只看弹出来的模态框里的登录字样，不看页头/侧栏常驻的那枚「登录」按钮 ——
   * 实测（2026-10-20 游客态）未登录的 chatgpt.com 侧栏一直挂着「登录」，
   * 同一轮照样发得出去；把常驻按钮当墙，正好会把唯一能发的站点判死。
   * 而 Kimi 是按下回车才弹出「微信扫码登录 / 手机号码登录 / 企业 SSO 登录」，
   * 那种把这一轮当场收走的弹窗才是真墙：没有它，用户看到的是一句
   * 「网页没有开始回答，请重试本轮」，重试一百次也只是同一堵墙。
   */
  function loginDialogUp() {
    try {
      var labels = ['登录', '注册', 'Sign in', 'Log in', 'Login', '扫码', '手机号', '验证码'];
      var nodes = document.querySelectorAll(
        '[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i]');
      for (var i = 0; i < nodes.length; i++) {
        var d = nodes[i];
        if (!isVisible(d)) continue;
        var t = String(d.innerText || d.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!t) continue;
        for (var k = 0; k < labels.length; k++) {
          if (t.indexOf(labels[k]) >= 0) return true;
        }
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
    /*
     * 这一串只用于「把现场说清楚」，绝不能反过来把发送弄断：
     * 它现在同时活在成功路径上（at: 字段进日志），一旦某个非常规节点
     * （没有 tagName 的包装对象、取值抛错的影子节点）让它 throw，
     * 一轮本来发得出去的发言会变成异常。判不出来就返回一句说明。
     */
    try {
      if (!el) return '(no node)';
      var cls = (typeof el.className === 'string' ? el.className : '').split(' ')[0].slice(0, 30);
      var ga = function (k) { return el.getAttribute(k) || ''; };
      return String(el.tagName || 'node').toLowerCase() +
        (el.id ? '#' + el.id : '') +
        (ga('name') ? '[name=' + ga('name') + ']' : '') +
        (cls ? '.' + cls : '') +
        (ga('role') ? ' role=' + ga('role') : '') +
        (ga('aria-label') ? ' aria=' + ga('aria-label') : '') +
        (ga('placeholder') ? ' ph=' + ga('placeholder') : '') +
        (el.isContentEditable ? ' editable' : '') +
        (isVisible(el) ? '' : ' hidden');
    } catch (e) {
      return '(node shape unknown)';
    }
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
   * 可见性判定：尺寸 + computed style + offsetParent 三者一起看。
   *
   * 不用 CSS :hidden 伪类 —— WebContentsView 内样式计算时序不稳定，:hidden 会误判。
   * 豆包这类「发送与打断按钮同时渲染在 DOM、靠 class 互斥隐藏」的站点，
   * 必须靠可见性而非存在性区分当前处于哪个态。
   *
   * 判不出来时返回 true（当作看得见）：这条判据现在握着「往哪枚框里写字」
   * 和「点哪枚按钮」，一次偶发的取不到 rect 就发不出去，比多试一次的代价大得多。
   */
  function isVisible(el) {
    if (!el) return false;
    try {
      if (typeof el.getBoundingClientRect !== 'function') return true;
      var r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return false;
      if (typeof window.getComputedStyle !== 'function') return true;
      var st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
      /**
       * offsetParent 为 null 不等于「没画出来」：position:fixed 的元素按规范就是
       * offsetParent === null，而聊天输入区恰恰常挂在 fixed 容器里。
       * 早先无条件用 offsetParent 判，会把这种真可见的发送按钮打成 hidden，
       * 于是「严格按可见性挑按钮」这条修复反而把唯一那个按钮挑没了。
       */
      if (el.offsetParent === null && st.position !== 'fixed') return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  /**
   * 只挑「真的看得见」的那个，全不可见就返回 null —— 与 pickVisible 的分工：
   *
   * pickVisible 在全部命中都不可见时退回 list[0]，那份兜底对「读」是对的
   * （DOM 里确实有这个东西，抓得到文本），对「写」和「点」是错的：
   * 往一个没画出来的框里打字、点一个没画出来的按钮，站点什么都收不到，
   * 而我们的日志一路 ok:true，现场只剩「发了但没反应」。
   * 键入与按发送改用这一档，兜底交给上层明确报错，而不是假装成功。
   */
  function pickVisibleOnly(sel) {
    if (!sel) return null;
    var list;
    try { list = document.querySelectorAll(sel); } catch (e) { return null; }
    for (var i = 0; i < list.length; i++) { if (isVisible(list[i])) return list[i]; }
    return null;
  }

  /** 这枚选择器到底命中了几个「看不见」的节点 —— 给失败原因用，好区分改版与未就绪 */
  function hiddenHits(sel) {
    if (!sel) return 0;
    try { return [...document.querySelectorAll(sel)].filter(function (n) { return !isVisible(n) }).length; } catch (e) { return 0; }
  }

  /** 数选择器命中几个节点；查询本身抛错（选择器写坏 / 文档正在换）算 0 个 */
  function safeCount(sel) {
    if (!sel) return -1;
    try { return document.querySelectorAll(sel).length; } catch (e) { return -1; }
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
   * 站点自己的上传入口清单。
   *
   * 剪贴板粘贴那条通道（主进程 writeImage + webContents.paste）只在站点监听
   * paste 事件时才有意义；只认自家「+」按钮 / input[type=file] 的站点压根不看
   * 剪贴板，于是图永远到不了它的待发队列。这里把站点自己的 file input 找出来，
   * 用页面侧能造出来的 File 走原生上传流程（input.files → change → 站点 onChange）。
   *
   * imageish 的判定刻意宽松：accept 为空也当候选。真实站点里既有
   * accept="image/*"，也有什么都不写但只收图的隐藏 input，还有 accept 里写
   * ".png,.jpg" 这种扩展名清单的 —— 宁可多试一个 input，也别把唯一那个漏掉。
   */
  function fileInputCandidates() {
    var out = [];
    var list;
    try { list = document.querySelectorAll('input[type="file"]'); } catch (e) { return out; }
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var accept = String(el.getAttribute('accept') || '').toLowerCase();
      var name = String(el.getAttribute('name') || el.getAttribute('id') || '').toLowerCase();
      var cls = String(el.getAttribute('class') || '').toLowerCase();
      var hay = ' ' + accept + ' ' + name + ' ' + cls;
      // 接受什么都算候选（accept 为空也收），判据只用来排序不用来过滤 ——
      // 站点的 accept 写法五花八门（image/*、.png,图片后缀清单、干脆不写），
      // 宁可多试一个 input，也别把唯一能用的那个漏掉。
      out.push({ el: el, accept: accept, imageish: imageish(hay), used: !!String(el.value || '') });
    }
    return out;
  }

  /**
   * 这个 file input 收不收图片？只用于**排序**（图片多的排前面），
   * 永远不用于过滤 —— 非图片附件（html/代码）同样要从这个控件进去。
   */
  function imageish(hay) {
    return hay.indexOf('image') >= 0 || hay.indexOf('photo') >= 0 ||
           hay.indexOf('picture') >= 0 || hay.indexOf('file') >= 0;
  }

  /** 给一批 base64 在页面侧造出 File 对象；纯页面能力，不需要站点配合 */
  function makeFiles(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      try {
        var bin = atob(it.base64);
        var buf = new Uint8Array(bin.length);
        for (var k = 0; k < bin.length; k++) buf[k] = bin.charCodeAt(k);
        out.push(new File([buf], it.name || ('image-' + (i + 1)), { type: it.mime || 'application/octet-stream' }));
      } catch (e) {}
    }
    return out;
  }

  /**
   * 把文件塞进某个 file input 并派发它期待的 change。
   *
   * DataTransfer 是页面脚本里给 input.files 赋值的唯一办法（直接 defineProperty
   * 会被站点自己的 setter 覆盖或抛错）。change 事件必然是 isTrusted=false ——
   * 这是从页面里能造出来的最强信号，站点 React/Vue 的 onChange 认它，
   * 随后的上传流程由站点自己走。
   */
  function setFilesAndFire(el, files) {
    try {
      var dt = new DataTransfer();
      for (var i = 0; i < files.length; i++) dt.items.add(files[i]);
      el.files = dt.files;
    } catch (e) {
      return false;
    }
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e2) {
      return false;
    }
    return true;
  }

  /**
   * 点开站点的上传菜单：常见形态是输入框旁的「+」「📎」「图片」按钮。
   * 有些站点只在菜单打开之后才把 file input 挂进 DOM，所以点完要重扫一遍。
   *
   * 不写站点专属选择器 —— 适配器 YAML 里没有 attach 段，这里用
   * 「输入框附近 + aria-label/title/class 命中上传语义」的通用口径兜底。
   */
  function openUploadMenu(input, payloads) {
    /*
     * 搜索范围**不能只限输入框的父节点**。
     *
     * DeepSeek 网页版的「+」在页面右上角，输入框在自己的组件里，两者是表亲 ——
     * input.parentElement 那一层根本够不到，于是永远收不到 note=no-file-input，
     * 表现为「站点明明支持上传，我们就是送不进去」。
     * 两段式：先在输入框附近找（最近的优先，误伤最小），
     * 附近没有再退回全文档。全文档这一轮加三道护栏，见下。
     */
    var scopes = [];
    var node = input;
    for (var d = 0; node && d < 4; d++) { scopes.push(node); node = node.parentElement; }
    if (!scopes.length) scopes.push(document.body);
    var cands = [];
    for (var s = 0; s < scopes.length; s++) {
      if (clickUploadCands(scopes[s], payloads, s === 0)) return true;
    }
    // 输入框附近没有，再看整页。最后一跳不加距离护栏，靠下面那三道语义护栏兜住
    try {
      if (clickUploadCands(document, payloads, false)) return true;
    } catch (e5) {}
    /*
     * 图标按钮兜底（放在所有语义跳之后）。
     *
     * 元宝的真实入口是**无 aria-label/title 的纯 SVG 图标按钮**：
     * label 只剩哈希 class，innerText 为空（SVG 不产生文本），语义命中与
     * isPlus 全部落空 —— 这就是 no-upload-entry 的成因。
     * 真人找这个按钮靠的是位置：它挂在输入框的 composer 工具条上。但编辑器
     * 节点本身常常只是 composer 里的**一行**（元宝实测 20px 高），工具条按钮
     * 在它下方几十像素 —— 按「同一行」判永远找不到。所以垂直基准改用
     * 「编辑器为中心的 composer 区域」：向上找最近的**有实际高度**的祖先
     * （高度 ≥ 3 倍编辑器高度且 ≤ 220px，即工具条/输入卡），垂直中心落在
     * 该区域内即算同行；水平仍要求在输入框左侧 160px 内。按钮是编辑器的
     * **兄弟或表亲**而不是后代，所以必须全文档找。加上文本极短（图标按钮
     * 没有文字）与不含发送/停止词两道护栏。
     * 放在最后一步是因为它的误伤面比语义命中大 —— 语义能命中就绝不到这里。
     */
    if (input) {
      try {
        var ir = input.getBoundingClientRect();
        // composer 容器：编辑器向上找最近的"有实际高度"的祖先
        var zone = ir;
        var anc = input.parentElement;
        for (var a = 0; anc && a < 6; a++) {
          var ar = anc.getBoundingClientRect();
          if (ar.height >= Math.max(ir.height * 3, 60) && ar.height <= 220 && ar.width >= ir.width * 0.8) { zone = ar; break; }
          anc = anc.parentElement;
        }
        var btns = document.querySelectorAll('button,[role="button"]');
        for (var j = 0; j < btns.length; j++) {
          var b = btns[j];
          if (!isVisible(b)) continue;
          try { if (b.querySelector('input[type="file"]')) continue; } catch (e6) { continue; }
          var blabel = String(b.getAttribute('aria-label') || b.getAttribute('title') || '').toLowerCase();
          if (/send|submit|stop|break|cancel|发送|提交|停止|中断/.test(blabel)) continue;
          var btxt = '';
          try { btxt = String(b.innerText || '').trim(); } catch (e7) {}
          if (btxt.length > 4) continue;
          var br = b.getBoundingClientRect();
          var sameRow = br.top + br.height / 2 >= zone.top - 12 && br.top + br.height / 2 <= zone.bottom + 12;
          var gap = ir.left - br.right;
          // 水平：按钮中心在输入框左缘左侧 160px 内，或与输入框左缘重叠（都在 composer 里）
          var bcx = br.left + br.width / 2;
          var hOK = (gap >= -8 && gap <= 160) || (bcx >= ir.left - 60 && bcx <= ir.left + 40);
          if (sameRow && hOK) {
            try { b.click(); return true; } catch (e8) {}
          }
        }
      } catch (e9) {}
    }
    return false;
  }

  /**
   * 在一个 scope 里找并点开上传入口。
   *
   * nearScope=true（输入框自身那层）时允许宽松一点：离得近，误伤代价小。
   * 全文档那一跳必须三道护栏全过才敢点，否则一个角落里的「图片」按钮就会
   * 把这一轮提前发出去或者打开无关弹窗 ——
   * 症状比「没找到上传入口」更难排查，所以宁可漏点，不误点。
   */
  function clickUploadCands(scope, payloadsForScan, nearScope) {
    var cands = [];
    try {
      cands = scope.querySelectorAll('button,[role="button"],[class*="upload" i],[class*="attach" i],' +
        '[aria-label*="upload" i],[aria-label*="attach" i],[title*="upload" i],[title*="attach" i],' +
        '[title*="上传"],[title*="附件"],[title*="图片"],[title*="文件"],[title*="更多"],' +
        '[aria-label*="更多"],[aria-label*="上传"],[aria-label*="附件"]');
    } catch (e) {
      return false;
    }
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      // 容器里已经带 file input 的，点它等于点 input 本身，没必要
      try { if (el.querySelector('input[type="file"]')) continue; } catch (e2) { continue; }
      var label = String(el.getAttribute('aria-label') || el.getAttribute('title') ||
        (el.className ? String(el.className) : '')).toLowerCase();
      var txt = '';
      try { txt = String(el.innerText || '').trim(); } catch (e3) {}
      // 「+」按钮的文本就是一个加号。用 charAt 判而不是正则：这段脚本整体活在
      // 模板字符串里，正则里的反斜杠会被模板字面量吃掉一层，写出来的 /\+/ 会变成 /+/。
      var isPlus = txt.length === 1 && txt.charCodeAt(0) === 0x2b;
      /*
       * 命中词里**刻意不含「图片/图像」**。阿里系站点（元宝、Qwen）把上传拆成
       * 「图片」与「文件」两个独立按钮，点错的那一个只收图片 ——
       * html 塞进去会被站点的 accept 拒绝，而页面看起来「有反应」（change 确实触发了）。
       * 这类误判比「找不到入口」更隐蔽：附件凭空消失，没有任何报错。
       * 「+」「上传」「附件」才是通用上传入口的可靠信号。
       */
      /*
       * 「更多」也进命中表：元宝的上传入口就是「更多」菜单（截图可见），
       * 这类入口点开后才出现「上传图片/本地文件」等二级项。
       * 排除词（发送/停止）在下面先判，误伤代价可控。
       */
      /*
       * 「添加」也进命中表：元宝的上传入口 aria-label 就是「添加」（真实页面实测，
       * 真人语义里「添加附件/添加图片」的「添加」就是这个入口）。
       */
      var hit = /upload|attach|plus|paperclip|上传|附件|更多|添加|more/.test(label) || isPlus;
      if (!hit) continue;
      /*
       * 发送/停止/打断按钮绝不能碰：点错等于把这一轮提前发出去或中断生成，
       * 症状是「附件没送进去而且消息已经发出去了」，比不点更难排查。
       * 这道护栏在两跳上都生效，且**先于**语义匹配里的宽松词判断。
       */
      if (/send|submit|stop|break|cancel|发送|提交|停止|中断/.test(label)) continue;
      if (!isVisible(el)) continue;
      /*
       * 收不收得下本轮要送的文件 —— 这一条挡的是阿里系站点（元宝、Qwen）：
       * 上传被拆成「图片」与「+」两个独立按钮，点错的那一个只收图片，
       * html 塞进去会被站点 accept 拒绝，而页面看起来「有反应」（change 确实触发了）。
       * 附带判据：按钮自己是否带 file input 的 accept —— 拿得到就按它判，
       * 拿不到（input 还没挂）就放行，因为此时无从判断。
       */
      if (!nearScope && !buttonAccepts(el, payloadsForScan)) continue;
      /*
       * 全文档那一跳再要一条正向证据：光靠 aria-label 命中「图片」不够 ——
       * 页面上可能有别的「图片」入口（生成图片按钮之类）。
       * 要求元素在视口里可见，且文本/标签里有明确的上传动作词。
       * 「+」这种纯符号按钮靠 isPlus 单独放行，那是最难误伤的一类。
       */
      // 与主命中表同词表（含「添加/更多」）：全文档跳的护栏只负责排误伤，
      // 词表若比主表窄，aria-label=「添加」这种入口会在这里被拦掉 ——
      // 真实元宝页面实测踩过：主表命中、护栏拦掉，最终报 no-upload-entry。
      if (!nearScope && !isPlus && !/upload|attach|上传|附件|添加|更多|more/.test(label)) continue;
      try { el.click(); return true; } catch (e4) {}
    }
    return false;
  }

  /**
   * 这个上传按钮收不收得下本轮的文件？
   *
   * 判据是它自身（或其后代）那个 file input 的 accept —— 站点把「图片」和「文件」
   * 分成两个按钮时，两个 input 的 accept 正好分别是 image 与文档。
   * 拿不到 accept（input 还没创建，点了才有）时返回 true：
   * 那时无从判断，交给点开之后的 pickFileInput 按 accept 二次把关。
   */
  function buttonAccepts(el, payloads) {
    if (!payloads || !payloads.length) return true;
    var inp = null;
    try { inp = el.querySelector('input[type="file"]'); } catch (e) {}
    if (inp) return acceptsAll(inp.getAttribute('accept') || '', payloads);
    /*
     * input 还没创建（点了才有）时，退回按按钮自己的语义判断。
     *
     * 元宝/Qwen 的布局里，「图片」按钮与「+」按钮是兄弟，而**只有「+」是通用入口**。
     * 早期版本把「图片」当宽松命中词，结果总是点中它 —— html 进了只收图的控件，
     * 站点 accept 拒绝，而 change 确实触发过，从外面看「有反应」，附件却凭空消失。
     * 所以这里显式排除「只管图片」的按钮。
     */
    var label = String(el.getAttribute('aria-label') || el.getAttribute('title') ||
      (el.className ? String(el.className) : '')).toLowerCase();
    var txt = '';
    try { txt = String(el.innerText || '').trim().toLowerCase(); } catch (e2) {}
    var blob = label + ' ' + txt;
    var wantsImage = /image|photo|picture|图片|图像|相册/.test(blob);
    /*
     * 「上传图片」这类标签**同时**命中两组词（上传 + 图片）。
     * 这里让「只收图」这个更具体的意图胜出：它描述的是一个更窄的控件，
     * 而「+」/「上传文件」才是通用入口。早期版本要求「命中图片且不命中通用词」
     * 才排除，于是「上传图片」被放行 —— 而它恰恰是最该排除的那个。
     */
    if (wantsImage) return false;
    return true;
  }

  /**
   * 走站点自身上传通道上传一批文件。
   *
   * 与剪贴板通道并列而不是替换：粘贴只在站点认 paste 时有效，
   * 上传只在站点认自家 file input 时有效，两者覆盖面不同。
   * 但站点自身的 input 一旦存在就优先用它 —— 那更接近真人操作路径。
   */
  function uploadViaSite(spec, payloads) {
    if (!payloads || !payloads.length) return { ok: false, placed: 0, note: 'no-files' };
    var files = makeFiles(payloads);
    if (!files.length) return { ok: false, placed: 0, note: 'decode-failed' };
    // 供 waitForFileInput 的每一跳复用：站点异步挂上来的 input 也要按 accept 挑，
    // 不能第一跳挑对了、后面几跳又退化成「取第一个」。
    var currentPayloads = payloads;
    var inputSel = (spec.selectors || {}).input || '';
    var input = typedInput() || pickVisible(inputSel) || q(inputSel);
    /*
     * 上传入口可能不止一级。
     *
     * 元宝的「+」点开的是二级菜单（上传图片 / 本地文件 / 腾讯文档），
     * file input 只在点「本地文件」之后才创建。只点一级按钮等 1.2 秒，
     * 等不到就报 no-file-input —— 用户看到的正是「站点明明支持上传，我们报没有入口」。
     * 所以做成循环：点一级入口 → 等 → 没有就点菜单里新出现的上传项 → 再等。
     * 每一级之间重扫全页面（input 可能挂在任何地方），两层各给一段等待预算。
     */
    /*
     * 先只认「accept 收得下这批文件」的控件；一个都没有时不再当场硬塞，
     * 而是去点上传入口 / 二级菜单，等文档控件挂上来（下面兜底那跳另说）。
     *
     * 为什么不能像早先那样直接回退「取第一个」：站点的上传能力常常拆成
     * 「图片」与「文件」两个控件（元宝、Qwen 实测），页面里已经挂着图控件时，
     * 硬塞会让 change 照样触发、站点按自己的 accept 校验把文件丢掉 ——
     * 我们报 placed=1，用户看到「已投递」，附件却凭空消失。
     * 而文档控件往往要点开菜单才创建：先点菜单才是真人走的那条路。
     */
    var best = pickFileInput(currentPayloads);
    var chain;
    if (best) {
      chain = Promise.resolve(deliverToFileInput(best, files));
    } else {
      var opened = false;
      try { opened = openUploadMenu(input, currentPayloads); } catch (e0) { opened = false; }
      if (!opened) {
        chain = Promise.resolve(deliverToAnyFileInput(files) || { ok: false, placed: 0, note: 'no-upload-entry' });
      } else {
        chain = waitForFileInput(currentPayloads, 1500).then(function (found) {
          if (found) return deliverToFileInput(found, files);
          // 一级菜单点开了但没有 input：元宝形态 —— 里面还有二级菜单项
          return openSecondLevel(currentPayloads, 1500).then(function (found2) {
            if (!found2) {
              return deliverToAnyFileInput(files) || { ok: false, placed: 0, note: 'no-file-input' };
            }
            return deliverToFileInput(found2, files);
          });
        });
      }
    }
    // 交付窗口内拦截站点后续的原生文件选择框调用。
    // 元宝拿到 input.files + change 后，自己的 onChange 处理器还会再
    // input.click() 打开系统选择框 —— Electron 33 没有可用的 file chooser
    // 拦截 API，原生框就真的弹出来。只在本次交付期间接管
    // HTMLInputElement.prototype 的 click/showPicker，完成即还原；
    // 用户在站点 UI 上的手动上传发生在这之外，不受影响。
    var releaseGuard = installFileChooserGuard();
    return chain.then(
      function (result) { releaseGuard(); return result; },
      function (err) { releaseGuard(); throw err; },
    );
  }

  /**
   * 交付期间吞掉 file input 的脚本层原生选择框调用（click/showPicker）。
   *
   * 站点收到我们塞进去的 File 后，有的实现（元宝实测）会在自己的 onChange
   * 处理器里再调一次 input.click() —— 站点浏览器里这是打开系统文件选择框的
   * 无害动作，但在 Electron 里会真的弹窗打断用户。这里临时接管 prototype
   * 方法，只对 type=file 生效；3 秒保险丝兜底，防止任何 promise 路径意外
   * 卡住导致用户后续手动上传被永远拦住。
   */
  function installFileChooserGuard() {
    var proto;
    try { proto = HTMLInputElement.prototype; } catch (e) { return function () {}; }
    if (!proto || typeof proto.click !== 'function') return function () {};
    if (proto.__torraFileChooserGuard) return proto.__torraFileChooserGuard.release || function () {};
    var nativeClick = proto.click;
    var nativeShowPicker = typeof proto.showPicker === 'function' ? proto.showPicker : null;
    var armed = true;
    proto.click = function () {
      if (armed && this && this.type === 'file') { __fileChooserSwallowed++; return undefined; }
      return nativeClick.apply(this, arguments);
    };
    if (nativeShowPicker) {
      proto.showPicker = function () {
        if (armed && this && this.type === 'file') {
          __fileChooserSwallowed++;
          throw new DOMException('Torra suppressed native file chooser during scripted upload', 'NotAllowedError');
        }
        return nativeShowPicker.apply(this, arguments);
      };
    }
    var release = function () {
      if (!armed) return;
      armed = false;
      proto.click = nativeClick;
      if (nativeShowPicker) proto.showPicker = nativeShowPicker;
      try { delete proto.__torraFileChooserGuard; } catch (e1) {}
    };
    try {
      Object.defineProperty(proto, '__torraFileChooserGuard', {
        value: { release: release }, configurable: true,
      });
    } catch (e2) {}
    setTimeout(function () { if (armed) release(); }, 3000);
    return release;
  }

  /**
   * 二级菜单：一级「+」点开后出现的「本地文件/上传图片」等菜单项。
   *
   * 与一级按钮共用同一套语义判据，但有两个不同点：
   * 1) 只扫**新出现的**可见节点太脆（站点可能复用同一个菜单容器），
   *    直接全文档扫，靠 isVisible 与排除「只管图片」来兜住误伤；
   * 2) 不再点一次就 return —— 菜单项可能也是懒挂的，逐个尝试，
   *    每点一个等一小段看 input 是否出现。
   */
  function openSecondLevel(payloads, waitMs) {
    var cands = [];
    try {
      cands = document.querySelectorAll('button,[role="button"],[role="menuitem"],li,div[role="option"]');
    } catch (e) {
      return Promise.resolve(null);
    }
    var hits = [];
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (!isVisible(el)) continue;
      try { if (el.querySelector('input[type="file"]')) continue; } catch (e2) { continue; }
      var label = String(el.getAttribute('aria-label') || el.getAttribute('title') ||
        (el.className ? String(el.className) : '')).toLowerCase();
      var txt = '';
      try { txt = String(el.innerText || '').trim().toLowerCase(); } catch (e3) {}
      var blob = label + ' ' + txt;
      // 与一级同一套判据：只管图片的排除，通用上传词命中
      var wantsImage = /image|photo|picture|图片|图像|相册/.test(blob);
      var isUpload = /upload|attach|本地文件|上传文件|上传附件|文件/.test(blob);
      if (!isUpload || wantsImage) continue;
      // 菜单项文本通常很短；排除长文本节点（可能是别的 UI 误含关键词）
      if (txt.length > 12) continue;
      hits.push(el);
    }
    if (!hits.length) return Promise.resolve(null);
    var k = 0;
    return (function tryNext() {
      if (k >= hits.length) return Promise.resolve(null);
      var el = hits[k++];
      try { el.click(); } catch (e4) { return tryNext(); }
      return waitForFileInput(payloads, waitMs).then(function (found) {
        return found || tryNext();
      });
    })();
  }

  /**
   * 最后一跳：页面上**没有一个** file input 的 accept 收得下这批文件时，
   * 把文件交给「最像通用上传」的那个控件，并明确标记 mismatched。
   *
   * 为什么还留这一跳：Chromium 对脚本赋值 input.files **不做** accept 过滤
   * （本机实测：accept="image/*" 的控件照样收下 text/markdown），收不收完全
   * 取决于站点自己的 change 处理器。有些站点 accept 写得很窄但实际什么都收
   * （本仓库的 web-attach-fileinput 装置就是这种），一律拒送会把「能上传」
   * 改成「不能上传」。
   *
   * 为什么必须标记：另一些站点（元宝、Qwen）确实按 accept 当场丢弃，而 change
   * 照样触发 —— 不标记就是 placed=1 的假成功，用户看到「已投递」而附件凭空消失。
   * 标记之后上层会明说「附件可能未送达」，而不是让用户去猜。
   *
   * 挑哪一个：这批文件不是图片，所以「accept 里只写图片」的控件排到最后 ——
   * pickFileInput 的排序偏向 imageish（那是为图片通道定的），在这里恰好会把
   * 文档塞进最不可能收它的那个。
   *
   * 返回 null 表示页面上压根没有 file input，由调用方报 no-file-input。
   */
  function deliverToAnyFileInput(files) {
    var left = fileInputCandidates();
    if (!left.length) return null;
    var imgOnly = function (c) { return /image|photo|picture/.test(c.accept) };
    var pick = left[0];
    for (var i = 1; i < left.length; i++) {
      var cand = left[i];
      if (imgOnly(pick) && !imgOnly(cand)) pick = cand;
      else if (imgOnly(pick) === imgOnly(cand) && cand.used && !pick.used) pick = cand;
    }
    var accepts = left.map(function (c) { return c.accept || '*' }).join(' | ');
    var delivered = deliverToFileInput(pick, files, true);
    if (delivered.ok) delivered.note = 'site-file-input-mismatch[' + accepts + ']';
    return delivered;
  }

  /** 把造好的 File 塞进选定的 file input 并派发站点认的 change */
  function deliverToFileInput(target, files, mismatched) {
    if (!setFilesAndFire(target.el, files)) return { ok: false, placed: 0, note: 'assign-failed' };
    // 站点后续的上传是异步的（要 PUT 到对象存储），DOM 预览未必同步出现，
    // 所以这里只报「已交给站点」，等待由主进程按附件预览/页面安静来判。
    return {
      ok: true,
      placed: files.length,
      note: 'site-file-input',
      via: target.el.tagName.toLowerCase() + (target.accept ? '[' + target.accept + ']' : ''),
      /*
       * mismatched：送进的控件 accept 收不下这批文件（只有兜底那一条路才会置上）。
       * 上层据此提示「附件可能未送达」——change 触发了不等于站点收下了。
       */
      mismatched: !!mismatched
    };
  }

  /**
   * 等站点把 file input 挂进来。
   *
   * payloads 必须显式传进来：挑 input 的每一跳都要按 accept 判断这批文件收不收得下，
   * 不能第一跳挑对了、后面几跳退化成「取第一个」。
   */
  function waitForFileInput(payloads, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 1200);
    return new Promise(function (resolve) {
      /*
       * 必须**异步**轮询，不能用 while + Date.now() 空转。
       * 空转会把渲染进程的事件循环占死，而站点的 file input 恰恰是
       * 在 click 之后由 React 的 state 更新 / 下一帧挂进来的 ——
       * 它需要事件循环转起来才可能出现在 DOM 里。
       * 空转等下去是死等：input 永远挂不上，最后只能报 no-file-input。
       * setTimeout(0) 把控制权交回事件循环，才接得住站点那次挂载。
       */
      (function tick() {
        var found = pickFileInput(payloads);
        if (found) { resolve(found); return; }
        if (Date.now() >= deadline) { resolve(null); return; }
        // 40ms 一跳：足够接住 React 的一次提交与菜单动画，又不至于让主进程多等
        setTimeout(tick, 40);
      })();
    });
  }

  /**
   * 从候选里挑一个**收得下这批文件**的 file input。
   *
   * payloads 是本轮要送的文件（可能为空 —— 那时退回旧口径，只按 used/imageish 排序）。
   *
   * 为什么必须拿 accept 过滤：站点的上传能力常常拆成「图片」与「文件」两个控件，
   * 两个 input 同时在 DOM 里。把 html 塞进 accept="image/*" 的那个，
   * 站点的 accept 校验会当场拒绝 —— 而 change 事件**确实触发了**，
   * 从外面看「有反应」，附件却凭空消失。所以这里必须挑 accept 收得下的那个。
   *
   * accept 解析按站点真实的几种写法来：image 加星号、.pdf,.doc、全通配、空（表示全收）。
   * 解析不出来（写了看不懂的东西）就当「收得下」——宁可多试一个控件，
   * 也不能因为猜错而把唯一能用的那个排除掉。
   */
  function pickFileInput(payloads) {
    var cands = fileInputCandidates();
    var want = payloads && payloads.length ? payloads : null;
    var best = null;
    var anyFits = null;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!best) { best = c; }
      // 排序不过滤：优先「这一轮真在用」的（有残留 value），其次是收图片的。
      // 只收文档的 input 同样可用 —— 非图片附件正是要往它里面送。
      if (c.used && !best.used) { best = c; continue; }
      if (c.imageish && !best.imageish) best = c;
      if (want && acceptsAll(c.accept, want)) {
        // 收得下的优先于收不下的，但两者之间仍按 used/imageish 排
        if (!anyFits) anyFits = c;
        if (c.used && !anyFits.used) { anyFits = c; continue; }
        if (c.imageish && !anyFits.imageish) anyFits = c;
      }
    }
    /*
     * 有文件要送时，只交「accept 收得下这批文件」的那个控件，不再回退 best。
     *
     * acceptsAll 对空 accept、全通配、看不懂的写法一律判「收得下」，所以
     * anyFits 为空的唯一含义是：**页面上每一个** file input 都明确写着自己
     * 收不下这批文件。往那种控件里塞，站点按 accept 当场丢弃，而 change
     * 确实触发了 —— 我们照样报 placed=1（假成功），用户看到「已投递」，
     * 附件却凭空消失。实测（2026-10-23 元宝的 .md 附件）：当时页面只挂着
     * accept="image/*" 的图控件，md 就是在这里蒸发的。
     *
     * 回 null 不是放弃：uploadViaSite 接着去点上传入口和二级菜单，
     * 等文档控件挂上来再按 accept 挑 —— 那才是真人操作走的路径。
     * 真挑不到就带着明确 note 失败，让上层把「送不进去」如实告诉用户。
     */
    return want ? anyFits : best;
  }

  /**
   * 这个 accept 收不收得下这批文件？
   *
   * 覆盖站点真实的写法：image 加星号、.pdf,.doc、全通配、video 加星号、text/html、空（全收）。
   * （这里刻意不写出带星号的那个通配写法：它的字面量里含连续的星号斜杠，
   *   放在块注释里会提前把注释闭合掉 —— 本文件整体活在模板字符串中，这类字面量
   *   已经吃过两次亏了。判断逻辑里用的是普通字符串拼接，不受影响。）
   * 只看扩展名与顶层类型，不做完整的 MIME 匹配 —— 那套规则站点自己也不遵守，
   * 过度精确只会把能用的控件误判成不能用。
   * 认不出来时返回 true（当作收得下）：宁可多试一个控件，也别把唯一能用的排除掉。
   */
  function acceptsAll(accept, payloads) {
    var a = String(accept || '').trim().toLowerCase();
    // 空 accept 的语义是「什么都收」（HTML 规范如此）
    if (!a) return true;
    var rules = a.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!rules.length) return true;
    for (var i = 0; i < payloads.length; i++) {
      var p = payloads[i];
      var name = String(p.name || '').toLowerCase();
      var mime = String(p.mime || '').toLowerCase();
      var ext = name.indexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')) : '';
      var ok = false;
      for (var k = 0; k < rules.length; k++) {
        var r = rules[k];
        if (r === '*/*' || r === '*') { ok = true; break; }
        // .pdf / .doc 这类扩展名规则
        if (r.charAt(0) === '.' && ext && r === ext) { ok = true; break; }
        // image/* 、 text/* 、 application/* 这类顶层通配
        if (r.charAt(r.length - 1) === '*') {
          var top = r.slice(0, -1);
          if (mime && mime.indexOf(top) === 0) { ok = true; break; }
        }
        // 完整 mime（text/html）
        if (r === mime) { ok = true; break; }
        /*
         * 文件自身类型是「占位值」时不按精确 mime 判死。
         *
         * 渲染层拿不到 File.type 时兜底写 text/plain（ChatPage 的 addFiles），
         * 于是真·markdown 会被记成 text/plain。此时若站点写 accept="text/markdown"，
         * 精确比对会判「收不下」，把好控件误杀成不能用 —— 与「认不出来就当收得下」
         * 是同一条取舍。只有顶层类型一致才放宽，所以 image/* 挡住文档那条主判据不受影响。
         */
        if (r.indexOf('/') > 0 && (!mime || mime === 'text/plain' || mime === 'application/octet-stream')) {
          if (!mime || r.slice(0, r.indexOf('/') + 1) === mime.slice(0, mime.indexOf('/') + 1)) {
            ok = true; break;
          }
        }
        // 认不出来的写法一律放行
        if (r.indexOf('/') < 0 && r.charAt(0) !== '.') { ok = true; break; }
      }
      if (!ok) return false;
    }
    return true;
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
  function waitFor(selector, timeoutMs, onlyVisible) {
    return new Promise(function (resolve) {
      var deadline = Date.now() + timeoutMs;
      (function tick() {
        var el = onlyVisible ? pickVisibleOnly(selector) : pickVisible(selector);
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

  /**
   * 输入框到底按哪种形态写：元素本身说了算。
   *
   * 顺序里「先看标签」这一步是必须的，不能只靠 isContentEditable：
   * ChatGPT 未登录页上真正可用的是 textarea#mobile-composer-prompt，而它的 input
   * 选择器是个候选并集，第一项写着 div[contenteditable="true"][role="textbox"] ——
   * 早先按「选择器串里出现 contenteditable 就算富文本」判定形态，于是给一枚
   * textarea 走了富文本路径：清空用的是 textContent=''（textarea 的值在 .value 上，
   * 动 textContent 等于没动），上一轮的提示词原样留在框里，这一轮直接拼在尾巴上。
   * 表现是「发出去了，但站点收到的是两句话」，而 ok 一路为 true，日志里查不出来。
   *
   * 所以：TEXTAREA / INPUT 这两个原生表单标签必然是普通输入框（contenteditable
   * 加在它们身上不改变浏览器对其值的管理方式），先按 textarea 处理；
   * 剩下才是真富文本。spec.input_kind 只是人在 YAML 里写的断言，排在 DOM 事实之后、
   * 选择器字面量启发式之前。
   */
  function resolveKind(spec, input) {
    var tag = input && input.tagName ? String(input.tagName).toUpperCase() : '';
    if (tag === 'TEXTAREA' || tag === 'INPUT') return 'textarea';
    if (input && input.isContentEditable) return 'contenteditable';
    if (spec.input_kind) return spec.input_kind;
    var sel = spec.selectors.input || '';
    if (/contenteditable|\\[role=['"]?textbox/.test(sel)) return 'contenteditable';
    return 'textarea';
  }

  /**
   * 清空输入框，返回「没清掉的那段字」。
   *
   * 返回空串才算清空成功。调用方必须看这个返回值：DOM 侧删不动的编辑器
   * 清完照样满框，把这一串当 0 处理就会把两轮发言拼成一句发出去。
   */
  function clearInput(input, kind) {
    input.focus();
    if (kind === 'contenteditable') {
      /*
       * 先走浏览器的删除通道：全选 + execCommand('delete')。
       *
       * 只改 textContent 对 Lexical / Slate 这类「状态机拥有 DOM」的编辑器无效 ——
       * 它们的内部文档没动，下一次 input 事件就把旧内容整份渲染回来。实测后果是
       * 提示词首尾相接：2026-10-20 在 kimi.com 连测两轮，框里留下
       * 「只回复两个字：收到只回复两个字：收到」，站点收到的是拼起来的那一句，
       * 而写入回执照样通过（首尾探针都在，长度只多不少）。
       * execCommand 不可用时退回老写法，至少 textarea 型容器仍然有效。
       */
      try {
        var doc = document;
        if (typeof doc.createRange === 'function' && typeof window.getSelection === 'function') {
          var range = doc.createRange();
          range.selectNodeContents(input);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          doc.execCommand('delete', false, null);
        }
      } catch (e0) { /* 退回直接清空 */ }
      if (String(input.innerText || input.textContent || '').replace(/\\s+/g, '').length > 0) {
        input.textContent = '';
      }
      try {
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      } catch (e) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      setNativeValue(input, '');
    }
    return composerText(input);
  }

  /**
   * 写入输入框：先整段塞进去，验过没落地再逐字。
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
   *
   * 但判定必须等一帧。2026-10-20 在 kimi.com 实测：execCommand('insertText') 之后同步读
   * innerText 还是旧的，于是把「其实已经整段落地」误判成拒收，退去走逐字兜底，
   * 编辑器随后按自己的文档渲染 —— 框里留下「新一轮写入的句子一轮写入的句子」，
   * 9 个字的提示词变成 15 个字，而最终回执（首尾探针 + 长度）对它照样判通过。
   * 兜底前还要确认旧内容真的清掉了：清不掉就停（'stuck'），而不是继续往半句话后面拼。
   */
  function typeInto(input, text, delayRange, jitter, kind) {
    if (!writeWhole(input, text, kind)) return charFallback(input, text, delayRange, jitter, kind);
    return waitMs(WHOLE_SETTLE_MS).then(function () {
      if (holdsWhole(input, text)) return 'whole';
      return charFallback(input, text, delayRange, jitter, kind);
    });
  }

  /** 整段写入只做动作本身，成没成由调用方等一帧后判（见 typeInto） */
  function writeWhole(input, text, kind) {
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
    return true;
  }

  /** 逐字兜底：先把上一笔抹干净，抹不干净就报 'stuck'，绝不往残留上拼新句子 */
  function charFallback(input, text, delayRange, jitter, kind) {
    clearInput(input, kind);
    return waitMs(WHOLE_SETTLE_MS).then(function () {
      if (composerText(input).length > 0) return 'stuck';
      return typeCharByChar(input, text, delayRange, jitter, kind).then(function () { return 'char'; });
    });
  }

  /** 整段写入后留给编辑器的渲染时间：状态机拥有 DOM 的那几类都在这一帧里改完 */
  var WHOLE_SETTLE_MS = 160;

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
   * 框里现在装着什么（已压成单行）。
   *
   * 只认「我们写过字的那一枚节点」，不扫全页：上一轮的残留可能就留在另一枚旧壳里，
   * 扫全页会把页面上别的文本当成本轮要防的残留。
   */
  function composerText(input) {
    try {
      if (!input) return '';
      return flatText(input.isContentEditable ? input.innerText : input.value);
    } catch (e) {
      return '';
    }
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
  /** 发送瞬间页面上已有的图片 URL：读取退化成全量扫描时用它排掉上一轮的生成图 */
  var __staleImgs = {};
  function markStale(sel) {
    __staleSet = [];
    __staleImgs = {};
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
        var imgs;
        try { imgs = nodes[i].querySelectorAll('img'); } catch (e2) { imgs = []; }
        for (var k = 0; k < imgs.length; k++) {
          var src = String(imgs[k].currentSrc || imgs[k].getAttribute('src') || '');
          if (src) __staleImgs[src] = 1;
        }
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

  function isLikelyReasoning(t) {
    if (!t) return false;
    var k = String(t);
    if (k.indexOf('ask_user_question') >= 0) return true;
    return false;
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
      // SPA nav recreates the list and invalidates sinceCount; rescan with stale/drop filters still guarding history.
      if (fromAll >= nodes.length) fromAll = 0;
      var buf = [];
      for (var k = fromAll; k < nodes.length; k++) {
        var s = mdOf(nodes[k]);
        if (!s) continue;
        if (drop && s === drop) continue;
        if (isAttachmentTurn(nodes[k], dropFlat)) continue;
        if (isStaleText(s)) continue;
        if (isLikelyReasoning(s)) continue;
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
      if (isLikelyReasoning(t)) continue;
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
        if (tail && tail !== baselineTail && !isStaleText(lastText) && !isLikelyReasoning(tail) && !(drop && lastText === drop)) {
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
   * 收集回答节点里的图片 URL。
   *
   * 为什么要单独一条通道：AI 生图那一轮的回答节点里常常只有 <img>、一个字都没有
   * （元宝实测：div.hyc-content-md 内 textLen=0，四张 694x400 的 CDN 图）。
   * mdChildren 把 IMG 整个跳过 —— 图片 URL 塞进正文只会污染文本，而且渲染层 CSP
   * 不放行任意 https 图床，于是这一轮被读成「空回答」。图片改从这里交给主进程
   * 下载入库，渲染层按图片附件渲染。
   *
   * 两条过滤：用户上传轮（isAttachmentTurn）不是模型的产出；图标/头像类小图不是内容。
   */
  function readImages(streamSel, sinceCount, excludeText) {
    var out = [];
    var seen = {};
    var nodes;
    try { nodes = document.querySelectorAll(streamSel); } catch (e) { return out; }
    if (!nodes || !nodes.length) return out;
    var dropFlat = (typeof excludeText === 'string' && excludeText.trim().length > 0)
      ? excludeText.replace(/\\s+/g, ' ').trim()
      : null;
    var from = (typeof sinceCount === 'number' && sinceCount >= 0) ? sinceCount : 0;
    // Same shrink case for images: cover the tail window instead of going blind.
    if (from >= nodes.length) from = Math.max(0, nodes.length - 40);
    for (var i = from; i < nodes.length && i < from + 40; i++) {
      var node = nodes[i];
      if (isAttachmentTurn(node, dropFlat)) continue;
      var imgs;
      try { imgs = node.querySelectorAll('img'); } catch (e2) { continue; }
      for (var j = 0; j < imgs.length && out.length < 12; j++) {
        var el = imgs[j];
        var src = String(el.currentSrc || el.getAttribute('src') || '');
        if (!src) continue;
        // 还在加载：这一轮先不收，下一轮再抓，避免把占位图当成结果
        if (el.complete === false) continue;
        var nw = el.naturalWidth || 0;
        var nh = el.naturalHeight || 0;
        if (nw && nh && nw < 120 && nh < 120) continue;
        if (!nw) {
          try { if (el.getBoundingClientRect().width < 80) continue; } catch (e3) { /* 量不到就放行 */ }
        }
        // 极小的 data: 只可能是骨架占位；真图交给主进程按字节数再筛
        if (src.indexOf('data:') === 0 && src.length < 4000) continue;
        // 发送前就在页面上的图不算本轮产出（虚拟化重排会让索引挡不住，见 markStale）
        if (__staleImgs[src]) continue;
        if (seen[src]) continue;
        seen[src] = 1;
        out.push({ src: src, alt: String(el.getAttribute('alt') || '').slice(0, 60) });
      }
    }
    return out;
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
    return t
      .replace(/(^|\\n)\\+\\d{1,3}(?=\\n|$)/g, '$1')
      .replace(/\\n(\\d{1,3})\\n/g, '$1');
  }

  /**
   * 完成判定。
   *
   * mode 指定的手段不可用时返回 null，交由主进程降级，最终兜底 dom_stable
   * （回复文本停止变化即视为完成）—— 这是对改版最鲁棒的一招。
   */
  // Clarification-choice detector (chat mode).
  // A site may stop generating to wait for the user to
  // click an option chip/button with the answer. Both
  // checks below must hold, so normal answers never stall.
  var CHOICE_SEL = 'button, a[href], [role="button"]';
  CHOICE_SEL += ', [role="option"], [role="radio"]';
  CHOICE_SEL += ', input[type="radio"], input[type="checkbox"]';
  var CHOICE_TOOLBAR_HINTS = [
    '复制', '拷贝', '点赞', '喜欢',
    '不喜欢', '重新生成', '再试一次', '重试',
    '换一换', '朗读', '分享', '下载',
    '导出', '收藏', '删除', '编辑',
    '收起', '展开', '更多', '详情',
    '反馈', '举报', '引用', '全屏',
  ];
  var CHOICE_CUE_WORDS = [
    '请选择', '选择一个', '选择以下', '选择下面',
    '点击选择', '点击下方', '告诉我', '请告诉',
    '请确认', '确认一下', '需要你', '你希望',
    '你想要', '哪一个', '哪一种', '哪类',
    '是否继续', '是否需要', '请问', '回复数字',
    '输入序号', '发送序号', '追问', '澄清',
    '补充一下', '具体说说', '多说一点', 'pick one',
    'please select', 'please confirm', 'which one',
    'let me know',
  ];
  function choiceLabelBlocked(t) {
    if (!t || t.length < 2) return true;
    var hints = CHOICE_TOOLBAR_HINTS;
    for (var i = 0; i < hints.length; i++) {
      if (t.indexOf(hints[i]) >= 0) return true;
    }
    return false;
  }
  function choiceCueInTail(text) {
    var tail = String(text || '');
    if (tail.length > 220) tail = tail.slice(tail.length - 220);
    var q = tail.length > 120 ? tail.slice(tail.length - 120) : tail;
    if (q.indexOf('?') >= 0 || q.indexOf('？') >= 0) return true;
    var words = CHOICE_CUE_WORDS;
    for (var i = 0; i < words.length; i++) {
      if (tail.indexOf(words[i]) >= 0) return true;
    }
    return false;
  }
  function detectPendingChoice(streamSel, sinceCount) {
    var none = { awaiting: false, options: [] };
    var nodes;
    try { nodes = document.querySelectorAll(streamSel); } catch (e) { return none; }
    if (!nodes || !nodes.length) return none;
    var from = (typeof sinceCount === 'number' && sinceCount >= 0) ? sinceCount : 0;
    if (from >= nodes.length) from = nodes.length - 1;
    var roots = [];
    var k;
    for (k = from; k < nodes.length; k++) roots.push(nodes[k]);
    var last = nodes[nodes.length - 1];
    if (last && last.parentElement) {
      var sibs = last.parentElement.children;
      var idx = Array.prototype.indexOf.call(sibs, last);
      for (k = idx + 1; k < sibs.length && k <= idx + 3; k++) roots.push(sibs[k]);
    }
    var found = [];
    for (var r = 0; r < roots.length; r++) {
      var root = roots[r];
      if (!root || !root.querySelectorAll) continue;
      var hits;
      try { hits = root.querySelectorAll(CHOICE_SEL); } catch (e2) { continue; }
      for (var h = 0; h < hits.length; h++) {
        var el = hits[h];
        if (!isVisible(el)) continue;
        var t = '';
        try {
          var aria = el.getAttribute('aria-label') || el.getAttribute('value') || '';
          var txt = (el.innerText || '') + ' ' + aria;
          t = txt.replace(/\\s+/g, ' ').trim();
        } catch (e3) { continue; }
        if (t.length > 24) t = t.slice(0, 24);
        if (choiceLabelBlocked(t)) continue;
        var dup = false;
        for (var d = 0; d < found.length; d++) {
          if (found[d] === t) { dup = true; break; }
        }
        if (!dup) found.push(t);
        if (found.length >= 6) break;
      }
      if (found.length >= 6) break;
    }
    if (!found.length) return none;
    var tailText = '';
    try { tailText = (last.innerText || last.textContent || ''); } catch (e4) {}
    if (!choiceCueInTail(tailText)) return none;
    return { awaiting: true, options: found.slice(0, 6) };
  }
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
      loginWall: isLoginWall(sel.input || sel.health_probe),
      // 渲染帧的探针：宿主窗口不可见时 Chromium 不出帧，
      // 靠 IntersectionObserver / rAF 挂载消息列表的站点（DeepSeek）就永远不落地正文，
      // 表现成「生成结束但未捕获到内容」。主进程据此说真话，而不是猜适配器坏了。
      visibility: document.visibilityState
    };
  }

  window.__torra = {
    /** 身份标记，主进程据此决定要不要重新注入（见文件头的 INJECT_BUILD） */
    __build: __BUILD,
    /**
     * 健康自检。返回结构化结论而非裸布尔，
     * 否则主进程无法区分「未登录」与「站点改版」，只能一律报适配器失效。
     */
    probe: function (healthProbe, inputSel) {
      if (isRiskWall()) return { ok: false, reason: 'risk-blocked' };
      if (isLoginWall(inputSel || healthProbe)) return { ok: false, reason: 'login-required' };
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
     * 现在这枚框里还剩几个字（诊断 + 主进程按键清空的验收）。
     *
     * 主进程用浏览器级按键（Ctrl+A + Delete）删过一次之后，得有地方问「真删干净了吗」——
     * 就是这里。返回的是节点内的纯文本，不是全页扫描。
     */
    composerText: function (spec) {
      var sel = (spec.selectors || {}).input || 'textarea,[contenteditable="true"],input[type="text"]';
      var el = typedInput() || pickVisibleOnly(sel) || pickVisible(sel);
      var t = composerText(el);
      return { text: t, chars: t.length, at: describeEditable(el) };
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
     * 把附件交给站点自己的上传通道（input[type=file] + change）。
     *
     * 与主进程那条剪贴板粘贴通道并列：站点认 paste 就走粘贴，
     * 只认自家上传控件就走这里 —— 后者在不少站点是唯一能通的通道，
     * 表现为「附件在网页模型那边发不出去」。
     * payloads: [{mime, base64, name}]，返回值 {ok, placed, note, via}。
     */
    uploadFiles: function (spec, payloads) {
      try {
        var before = __fileChooserSwallowed;
        var result = uploadViaSite(spec, payloads || []);
        if (result && typeof result.then === 'function') {
          return result.then(function (r) {
            if (r && typeof r === 'object') r.swallowed = __fileChooserSwallowed - before;
            return r;
          });
        }
        if (result && typeof result === 'object') result.swallowed = __fileChooserSwallowed - before;
        return result;
      } catch (e) {
        return { ok: false, placed: 0, note: 'threw: ' + String((e && e.message) || e) };
      }
    },

    /**
     * 键入阶段：登录判定 → 等输入框 → 清空 → 写入（整段优先，逐字兜底）→ 发送前停顿。
     * 单独拆出来是为了让「贴附件」插在清空之后、按发送之前 ——
     * clearInput 会把 contenteditable 里的图片节点一起抹掉（实测 img 1→0），
     * 所以早先「先粘图再 send()」的顺序等于白粘。
     * mode 是给诊断日志用的：whole＝整段落地，char＝站点拒收整段、退回逐字。
     */
    typePrompt: function (spec, prompt) {
      var sel = spec.selectors || {};
      var inputSel = (spec.selectors || {}).input || spec.health_probe || '';
      // 风控拦截 / 登录墙 / 人机验证检测：不尝试破解，直接交还用户。
      // 顺序不可调整 —— 真到登录页时根本没有输入框，先查选择器会误判为适配器失效。
      // （登录墙本身已经会看「有没有能用的输入框」，未登录也能聊的站点不再被拦。）
      if (isRiskWall()) {
        return Promise.resolve({ ok: false, reason: 'risk-blocked', kind: '', mode: '' });
      }
      if (isLoginWall(inputSel)) {
        return Promise.resolve({ ok: false, reason: 'login-required', kind: '', mode: '' });
      }
      /*
       * 只等「看得见」的输入框（waitFor 第三参）。
       *
       * 用宽松的 pickVisible 等不行：它在全不可见时兜底返回第一个命中，于是
       * 站点把输入区换成了另一个形态（引导页与会话页不是一套 DOM）、而我们指的那档
       * 只是留在树里的旧壳时，照样「等到了」——往一个没画出来的框里打字，
       * typeInto 成功、日志 typed=whole ok:true，站点收到的却是空的，
       * 后面 pressSend 等 20s 判死。用户看到的就是「发不出去，但不知道为什么」。
       * 判成失败并把现场（命中几档、几个不可见）写进 reason，才谈得上可修。
       */
      return waitFor(spec.selectors.input, 15000, true).then(function (input) {
        if (!input) {
          // 等待期间可能被重定向到登录页 / 风控页：再判一次，
          // 否则「登录过期 / 环境异常」会被报成「适配器失效」。
          if (isRiskWall()) return { ok: false, reason: 'risk-blocked', kind: '', mode: '' };
          if (isLoginWall(inputSel)) return { ok: false, reason: 'login-required', kind: '', mode: '' };
          var hid = hiddenHits(spec.selectors.input);
          if (hid > 0) {
            return {
              ok: false,
              reason: 'input not visible，适配器命中的 ' + hid + ' 个节点都在页面上但没画出来 ' + pageSnapshot(),
              kind: '', mode: '',
            };
          }
          return { ok: false, reason: 'input selector missing，适配器期望 ' + spec.selectors.input + ' ' + pageSnapshot(), kind: '', mode: '' };
        }
        var kind = resolveKind(spec, input);
        __typedInput = input;
        clearInput(input, kind);
        /*
         * 清空没成功就先停下来，别急着写。
         *
         * Lexical / Slate 这类编辑器把 DOM 当作内部文档的投影：我们抹掉节点，
         * 它下一帧按自己的状态整份渲染回来，于是这一轮的提示词落在上一轮尾巴上。
         * 而写入回执只看「首尾探针在不在 + 长度够不够」，两句话拼起来照样全过 ——
         * 站点收到的是两句，日志里每一步都是 ok（2026-10-20 kimi.com 连测两轮实测）。
         * 所以这里等一帧再读一次框：还有字就判失败，把「用浏览器级按键真删一次」
         * 这个决定交回主进程，而不是把拼好的半句话发出去。
         */
        return waitMs(WHOLE_SETTLE_MS).then(function () {
          var stale = composerText(input);
          if (stale.length > 0) {
            return {
              ok: false,
              reason: 'composer holds previous text：' + stale.slice(0, 40),
              kind: kind,
              mode: '',
              stale: stale.slice(0, 60),
            };
          }
          var streamBefore = sel.stream ? safeCount(sel.stream) : -1;
          return typeInto(input, prompt, spec.automation.typing_delay_ms, spec.automation.jitter, kind)
            .then(function (mode) {
              // 逐字兜底前发现旧内容删不掉：已经停手，把结论交回主进程（同一条 reason，同一句人话）
              if (mode === 'stuck') {
                var held = composerText(input);
                return {
                  ok: false,
                  reason: 'composer holds previous text：' + held.slice(0, 40),
                  kind: kind,
                  mode: mode,
                  stale: held.slice(0, 60),
                };
              }
              /*
               * 回执：话有没有真的落进这枚看得见的框里。
               * 落不进去就别报 ok —— 后面每一步都会「成功」，
               * 而站点收到的永远是空框，日志里查不出任何异常。
               *
               * 也要等一帧再读：状态机编辑器的 innerText 在写入当场常常还没跟上，
               * 同步读会把明明写成功的一轮判成拒收（typeInto 里那条实测踩坑）。
               *
               * 例外：个别站点在写入当场就把这一轮收走了（框清空 + 回复区多出节点）。
               * 那种是成功，不是失败，所以先看回复容器有没有长，长了就认。
               *
               * 判据先用 holdsWhole 只认「我们刚写过字的那一枚」：typeInto 的成功与否
               * 本就是按这个节点判的，回执若换成全局扫描，两者会分叉 —— 有些页面
               * 只挂一枚框却不在 textarea,input,[contenteditable] 这串通用选择器里
               * （Quill 的 div.ql-editor 要靠 contenteditable 属性命中），扫不到就把
               * 明明写成功的一轮判成拒收。全局扫描留作第二道：站点把话挪去别的节点时，
               * 它还能兜住。
               */
              return waitMs(WHOLE_SETTLE_MS).then(function () {
                if (!(holdsWhole(input, prompt) || holdsPromptText(prompt))) {
                  if (sel.stream && safeCount(sel.stream) > streamBefore) {
                    return delayIn(spec.automation.pre_send_pause_ms, spec.automation.jitter)
                      .then(function () { return { ok: true, reason: '', kind: kind, mode: 'auto', at: describeEditable(input) }; });
                  }
                  // 有些站点根本不让你把话留在框里，而是当场弹出登录框（Kimi 游客按回车即如此）。
                  // 那一屏就是答案：说「需要登录」，别说「站点拒收了这次写入，请重试」。
                  if (loginDialogUp()) {
                    return { ok: false, reason: 'login-required', kind: kind, mode: mode };
                  }
                  return { ok: false, reason: 'input did not keep the prompt ' + describeEditable(input) + ' ' + pageSnapshot(), kind: kind, mode: mode };
                }
                return delayIn(spec.automation.pre_send_pause_ms, spec.automation.jitter)
                  .then(function () { return { ok: true, reason: '', kind: kind, mode: mode, at: describeEditable(input) }; });
              });
            });
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
      var input = typedInput() || pickVisibleOnly(sel.input) || document.querySelector(sel.input);
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

      /**
       * 「点发送」只能点看得见的那个。
       *
       * 这里不用宽松的 pickVisible：它在全部命中都不可见时兜底返回第一个命中，
       * 而 SPA 换页时旧输入区整块留在树里只是隐藏，于是 click() 打在一枚
       * display:none 的按钮上 —— 站点什么都没收到，我们却以为按过了，
       * 只能等满 20s 报「生成未开始」。没有可见按钮就退回键盘 Enter，
       * 那至少是一次真的作用在当前框上的按键。
       */
      var sendBtn = sendMode === 'click' && sel.send ? pickVisibleOnly(sel.send) : null;
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

      /*
       * 等待生成开始：完成判定手段反转、回复区节点增长、或输入框被清空。
       *
       * 每条 ok 分支都要带上 accepted —— 这是原生模式那张收据的全部内容。
       * 早先只有「框里的话消失了」那一档写 accepted:true，另外两条
       * （页面开始生成、回复区多出节点）只回 ok:true，accepted 留空；
       * 主进程 deliverNative 把「站点已经开口的这一轮」当成没送达，
       * 界面上就写「站点没接走这一轮」。实测：豆包那一轮框清空了、
       * .md-box-root 从 2 涨到 4、正文读得到，收据仍是 accepted:false ——
       * 用户看到的「发不出去」就是这么来的。
       */
      var attemptAt = Date.now();
      var startDeadline = attemptAt + 20000 + Math.min(Math.max(attachments || 0, 0), 4) * 10000;
      /** 四条「站点接走了」的证据各留名字，好让日志说得清是按哪一条认下的 */
      function taken(via) {
        return { ok: true, reason: '', accepted: true, via: via, streamCount: baseline, streamBaselineText: baselineTail };
      }
      return new Promise(function (resolve) {
        (function waitStart() {
          if (isComplete(spec) === false) { resolve(taken('generating')); return; }
          if (sel.stream) {
            /*
             * 「回复区多出节点」单独不能算站点接走了这一轮 —— 必须读得出内容。
             *
             * 实测（2026-10-20 chatgpt.com 游客落地页）：页面本身会短暂挂出一枚
             * data-message-author-role=assistant 的空壳，节点数 0 → 1 在 250ms 一档里就成立，
             * 于是收据写成 accepted:true/via:stream，而那一轮根本没发出去，框里的话原样留着。
             * 用户看到的就是一张「已送达」却永远没有下文的卡片 —— 比报错更难查。
             * 现在只认「读到了本轮新增的正文」；至于框已清空、正文还没开写的站点，
             * 下面那条 composer-cleared 收据接得住。
             */
            var flow = readStream(sel.stream, spec.stream_mode || 'last', baseline, baselineTail, prompt);
            if (flow) {
              resolve(taken('stream')); return;
            }
          }
          if (sel.steps && stepsBaseline >= 0) {
            var stepsNow;
            try { stepsNow = document.querySelectorAll(sel.steps).length; } catch (e) { stepsNow = stepsBaseline; }
            if (stepsNow > stepsBaseline) {
              resolve(taken('steps')); return;
            }
          }
          // 收据：输入框里的话没了 = 站点把这一轮接走了。
          // 带附件时这比「回复节点变多」来得早得多（上传 + 视觉理解期间容器还是空的），
          // 没有它就只能等 20s 到点，把一轮已经成立的发言判成适配器失效。
          // 1.2s 的门槛：清框与发送在同一拍里发生，太早查会读到还没更新的旧值。
          if (heldBefore && Date.now() - attemptAt > 1200 && !holdsPromptText(prompt)) {
            resolve(taken('composer-cleared'));
            return;
          }
          if (Date.now() > startDeadline) {
            /**
             * 有些站点不在页面上摆登录标记，而是等你按下发送才弹出登录框
             * （未登录时点豆包发送即如此）。键入前那道检查那时还是干净的，
             * 这里补判一次：弹出来的若是登录墙，就说「需要登录」，
             * 而不是把用户引去重试一个他重试一百次也发不出去的轮次。
             */
            if (isLoginWall(sel.input) || loginDialogUp()) {
              resolve({ ok: false, reason: 'login-required' });
              return;
            }
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

    /**
     * 把「我们自己发出去的那一句问题」在页面上找出来，滚到视野中间。
     *
     * 三条取舍都是被实测逼出来的：
     * ① 不能全文档按文本搜就完事 —— 站家常把问题原文复述进回答里
     *    （DeepSeek 实测：回答第一行就是加粗的问题本身），所以命中节点只要落在
     *    selectors.stream（助手正文容器）或 selectors.input（输入框）的子树里，一律不算气泡。
     * ② 找不到多半不是选择器写错，而是那一轮根本不在 DOM 里：ChatGPT / DeepSeek 的
     *    消息列表是虚拟化的，只挂最近一两个回合（见 adapters/chatgpt.yaml 的注释）。
     *    这里不替调用方硬撑，如实回 reason:'not mounted'，让它去走「跳回那一场会话」那条路。
     * ③ 配了 selectors.user_turn 就只在真气泡里找（精确档），没配才走 ① 的排除式启发（兜底档）；
     *    两条路分开记在 mode 里，否则站点改版时没人知道该去补哪一个字段。
     */
    locateTurn: function (spec, prompt, nth) {
      var sel = (spec && spec.selectors) || {};
      var want = flatText(prompt);
      if (want.length < 2) return { ok: false, found: 0, mode: '', reason: 'empty prompt' };
      // 头尾各取 12 字：只比长度会放行站点改写过的半句话，只比开头会被引用句骗过
      var head = want.slice(0, 12);
      var tail = want.length > 24 ? want.slice(-12) : '';

      var blocked = [];
      function collect(s) {
        if (!s) return;
        try {
          Array.prototype.forEach.call(document.querySelectorAll(s), function (e) { blocked.push(e); });
        } catch (e) { /* 选择器写坏：当作没有排除区，宁可少认也别整条路失效 */ }
      }
      collect(sel.stream);
      collect(sel.input);
      function blockedBy(el) {
        for (var i = 0; i < blocked.length; i++) {
          try {
            if (blocked[i] === el || blocked[i].contains(el)) return true;
          } catch (e) { /* 节点已被换掉 */ }
        }
        return false;
      }
      function inField(el) {
        try {
          return !!(el.closest && el.closest('textarea,input,[contenteditable="true"],[role="textbox"]'));
        } catch (e) {
          return false;
        }
      }

      var hits = [];
      function accept(el, mode) {
        if (!el) return;
        var r;
        try { r = el.getBoundingClientRect(); } catch (e) { return; }
        // 零尺寸那格是站点收在菜单里的副本（实测 DeepSeek 侧栏历史条目宽 0），滚过去没有意义
        if (!r || r.width < 2 || r.height < 2) return;
        if (inField(el) || blockedBy(el)) return;
        hits.push({ el: el, mode: mode });
      }

      var bubbles = [];
      if (sel.user_turn) {
        try { bubbles = [].slice.call(document.querySelectorAll(sel.user_turn)); } catch (e) { bubbles = []; }
      }
      if (bubbles.length) {
        bubbles.forEach(function (b) {
          var t = flatText(b.innerText);
          if (t.indexOf(head) >= 0 && (!tail || t.indexOf(tail) >= 0)) accept(b, 'user_turn');
        });
      } else {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        var n;
        var scanned = 0;
        while ((n = walker.nextNode()) && scanned < 40000) {
          scanned++;
          var t2 = flatText(n.nodeValue);
          if (!t2 || t2.length < head.length) continue;
          if (t2.indexOf(head) < 0 || (tail && t2.indexOf(tail) < 0)) continue;
          var el = n.parentElement;
          if (!el) continue;
          // 往上并到「整条气泡」那一层：文本节点的父亲常常只包住一句里的半行
          var up = el;
          for (var k = 0; k < 4; k++) {
            var p = up.parentElement;
            if (!p || p === document.body) break;
            if (flatText(p.innerText) !== t2) break;
            up = p;
          }
          accept(up, 'heuristic');
          if (hits.length >= 12) break;
        }
      }

      if (!hits.length) {
        return { ok: false, found: 0, mode: bubbles.length ? 'user_turn' : 'heuristic', reason: 'not mounted' };
      }
      var idx = Math.min(Math.max((nth || 1) - 1, 0), hits.length - 1);
      var pick = hits[idx];
      try {
        pick.el.scrollIntoView({ block: 'center' });
      } catch (e) {
        try { pick.el.scrollIntoView(); } catch (e2) { /* 文档正在换页 */ }
      }
      var r3;
      try { r3 = pick.el.getBoundingClientRect(); } catch (e) { r3 = null; }
      return {
        ok: true,
        found: hits.length,
        index: idx + 1,
        mode: pick.mode,
        top: r3 ? Math.round(r3.top) : -1,
        at: describeEditable(pick.el),
      };
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

    /**
     * 本轮回答里的图片（{src, alt} 列表）。与 read() 共用同一套 sinceCount 口径，
     * 因此不会把上一轮的图当成本轮产出。
     */
    readImages: function (streamSel, sinceCount, excludeText) {
      return readImages(streamSel, sinceCount, excludeText);
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

    /**
     * 增量探针：只回答「流式容器有没有变」，不做 Markdown 化。
     * read() 每次都要把回复子树走一遍（mdOf：表格、代码块、内联引用），
     * 8 路并发时它才是网页通道的成本大头。节点数 + 末尾节点字符长度
     * 足以当「有没有新字」的哨兵，变了才值得去 read()。
     * textContent 不触发排版，比 innerText 更便宜。
     */
    growth: function (streamSel) {
      if (!streamSel) return { n: 0, len: 0 };
      var nodes;
      try { nodes = document.querySelectorAll(streamSel); } catch (e) { return { n: -1, len: -1 }; }
      var n = nodes.length;
      var last = n > 0 ? nodes[n - 1] : null;
      return { n: n, len: last ? String(last.textContent || '').length : 0 };
    },

    /** 完成判定（供主进程轮询）。返回 { complete, method } */
    done: function (spec) {
      var r = isComplete(spec);
      if (r === null) return { complete: false, method: 'dom_stable' };
      return { complete: r, method: spec.completion ? spec.completion.mode : 'stop_button_hidden' };
    },
    pendingChoice: function (streamSel, sinceCount) {
      return detectPendingChoice(streamSel, sinceCount);
    }
  };
})();
`

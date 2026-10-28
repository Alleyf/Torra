/**
 * 面板文档的拼装：公共样式 + 面板 SDK + 主题标记。
 *
 * 单独成文件是为了能离线测：service 会连带 import electron，而这里只做字符串处理。
 * 拼出来的文档会走 torra-ui 沙箱帧（无网络、无 Node、独立源），所以 SDK 只能靠
 * postMessage 回宿主，不能在这里塞任何 Node 能力。
 */

/** 面板源文件上限。与 torra-ui 帧上限一致：超了在拼 URL 时也会被拒 */
export const PANEL_MAX_BYTES = 512 * 1024

export function panelBaseStyles(): string {
  return `
:root {
  color-scheme: dark;
  --p-bg: #0a0b14; --p-fg: #e8e9ee; --p-muted: #8b90a0; --p-border: rgba(255,255,255,.10);
  --p-card: rgba(255,255,255,.035); --p-accent: #4f7cff; --p-danger: #ff6b6b; --p-warn: #f0b04c;
  --p-radius: 10px; --p-gap: 10px;
}
:root[data-theme="light"] {
  color-scheme: light;
  --p-bg: #faf9f7; --p-fg: #1d1f27; --p-muted: #6b7080; --p-border: rgba(0,0,0,.10);
  --p-card: rgba(0,0,0,.028); --p-accent: #2f5bd7; --p-danger: #c0392b; --p-warn: #a86b12;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--p-bg); color: var(--p-fg); }
body {
  font: 13.5px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  padding: 12px 14px 24px;
}
button, input, select, textarea { font: inherit; color: inherit; }
button {
  border: 1px solid var(--p-border); background: var(--p-card); color: var(--p-fg);
  border-radius: 8px; padding: 5px 10px; cursor: pointer; white-space: nowrap;
}
button:hover { border-color: var(--p-accent); }
button.primary { background: var(--p-accent); border-color: var(--p-accent); color: #fff; }
button.danger { color: var(--p-danger); }
input, select, textarea {
  background: var(--p-card); border: 1px solid var(--p-border); border-radius: 8px;
  padding: 5px 9px; outline: none; width: 100%;
}
input:focus, select:focus, textarea:focus { border-color: var(--p-accent); }
a { color: var(--p-accent); }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: rgba(127,127,127,.35); border-radius: 10px; border: 2px solid transparent; background-clip: content-box; }
.muted { color: var(--p-muted); }
.row { display: flex; align-items: center; gap: 8px; }
.row > button { flex: 0 0 auto; }
.row > input, .row > select { flex: 1 1 auto; min-width: 0; width: auto; }
.grow { flex: 1 1 auto; min-width: 0; }
`.trim()
}

/** 面板脚本能用的 SDK：没有 Node，没有 fetch，只有一条回宿主的路 */
export function panelSdkScript(token: string, pluginId: string): string {
  return `
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var pending = new Map();
  var seq = 0;
  var themeHandlers = [];
  window.__TORRA_PLUGIN__ = { id: ${JSON.stringify(pluginId)}, token: TOKEN };
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var m = event.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'torra:reply' && pending.has(m.id)) {
      var p = pending.get(m.id);
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(String(m.error || '调用失败')));
      return;
    }
    if (m.type === 'torra:theme') {
      document.documentElement.dataset.theme = m.theme === 'light' ? 'light' : 'dark';
      for (var i = 0; i < themeHandlers.length; i += 1) { try { themeHandlers[i](m.theme); } catch (e) {} }
    }
  });
  window.torraPlugin = {
    call: function (method, params) {
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        pending.set(id, { resolve: resolve, reject: reject });
        parent.postMessage({ type: 'torra:call', id: id, token: TOKEN, method: method, params: params || {} }, '*');
      });
    },
    onTheme: function (fn) { if (typeof fn === 'function') themeHandlers.push(fn); }
  };
  parent.postMessage({ type: 'torra:ready', token: TOKEN }, '*');
})();
`.trim()
}

export function injectPanel(html: string, token: string, pluginId: string, theme: 'dark' | 'light'): string {
  const head = `<style data-torra-plugin="base">${panelBaseStyles()}</style>\n<script data-torra-plugin="sdk">${panelSdkScript(token, pluginId)}</script>`
  const withTheme = html.replace(/<html\b([^>]*)>/i, (m, attrs) => {
    const cleaned = String(attrs).replace(/\sdata-theme="[^"]*"/i, '')
    return `<html${cleaned} data-theme="${theme}">`
  })
  if (/<head\b[^>]*>/i.test(withTheme)) return withTheme.replace(/<head\b[^>]*>/i, (m) => `${m}\n${head}`)
  if (/<html\b[^>]*>/i.test(withTheme)) return withTheme.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${head}</head>`)
  return `<!doctype html><html data-theme="${theme}"><head>${head}</head><body>${html}</body></html>`
}

// 落地页：读取同源 version.json 获取最新发布版，更新下载链接与版本标记。
//
// 为什么不直接请求 GitHub：
//   latest.yml / releases 页面都不带 CORS 头，浏览器 fetch 会被拦截；
//   GitHub API 虽然有 CORS，但未认证请求只有 60 次/小时，落地页扛不住。
// 因此版本号由 Pages 部署流程写入 version.json（同源、无跨域、无速率限制）。
// 读不到时页面保持 HTML 里的兜底值，链接仍可用。
(function () {
  'use strict'

  var REPO = 'https://github.com/Alleyf/Torra'

  function loadVersion() {
    return fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (data) {
        var v = data && data.version ? String(data.version).replace(/^v/, '') : null
        return /^\d+(\.\d+){1,3}$/.test(v || '') ? v : null
      })
  }

  function apply(version) {
    ;(document.querySelectorAll('[data-version]')).forEach(function (el) { el.textContent = version })
    ;(document.querySelectorAll('[data-setup]')).forEach(function (el) {
      el.href = REPO + '/releases/download/v' + version + '/Torra-Setup-' + version + '.exe'
    })
    ;(document.querySelectorAll('[data-portable]')).forEach(function (el) {
      el.href = REPO + '/releases/download/v' + version + '/Torra-Portable-' + version + '.exe'
    })
    ;(document.querySelectorAll('[data-sha256]')).forEach(function (el) {
      el.href = REPO + '/releases/latest/download/SHA256SUMS.txt'
    })
    ;(document.querySelectorAll('[data-link]')).forEach(function (el) {
      el.href = REPO + '/releases/latest'
    })
  }

  function ready() {
    loadVersion()
      .then(function (version) {
        if (version) apply(version)
      })
      .catch(function (e) {
        console.info('site-ver: 未取得最新版本，保留页面兜底值', e)
      })
  }

  if (document.readyState === 'complete') ready()
  else document.addEventListener('DOMContentLoaded', ready)
})()

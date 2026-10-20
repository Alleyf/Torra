// 落地页的三个交互：主题、滚动出场、导航状态。
//
// 主题口径与应用一致：明暗只靠 <html data-theme> 上的一组令牌切换，
// 页面规则本身与主题无关。默认跟随系统，用户手动选过一次之后记住它，
// 不再被系统偏好改回去 —— 和应用里那颗面板按钮同一个道理。
(function () {
  'use strict'

  var KEY = 'torra-site-theme'
  var root = document.documentElement

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme)
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0a0b14' : '#faf9f7')
  }

  var stored = null
  try {
    stored = localStorage.getItem(KEY)
  } catch (e) {
    /* 隐私模式下读不到，退成跟随系统 */
  }
  apply(stored || systemTheme())

  document.querySelectorAll('.theme-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
      apply(next)
      try {
        localStorage.setItem(KEY, next)
      } catch (e) {
        /* 存不下就算了，这一场浏览还是会切过去 */
      }
    })
  })

  // 系统偏好变了要跟着变，但用户手动选过之后就不再多事
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: light)')
    var onChange = function (e) {
      var manual
      try {
        manual = localStorage.getItem(KEY)
      } catch (err) {
        manual = null
      }
      if (!manual) apply(e.matches ? 'light' : 'dark')
    }
    if (mq.addEventListener) mq.addEventListener('change', onChange)
    else if (mq.addListener) mq.addListener(onChange)
  }

  // ── 滚动出场 ──
  var riseEls = document.querySelectorAll('.rise')
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!('IntersectionObserver' in window) || reduced) {
    riseEls.forEach(function (el) {
      el.classList.add('in')
    })
  } else {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return
          en.target.classList.add('in')
          io.unobserve(en.target)
        })
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
    )
    riseEls.forEach(function (el) {
      io.observe(el)
    })
  }

  // ── 导航：贴顶加深 + 当前分区高亮 ──
  var nav = document.querySelector('.nav')
  var links = Array.prototype.slice.call(document.querySelectorAll('.nav-links a[href^="#"]'))
  var targets = links
    .map(function (a) {
      return document.querySelector(a.getAttribute('href'))
    })
    .filter(Boolean)

  // 「下载」不占导航链接位（右侧那颗按钮就是它），但滚到下载区时若不点亮点什么，
  // 高亮会停在「安全与合规」上，看着像定位坏了。给那颗 CTA 单独一个选中态。
  var dlSec = document.getElementById('download')
  var dlBtn = document.querySelector('.nav-acts a.btn[href="#download"]')

  function onScroll() {
    if (nav) nav.classList.toggle('stuck', window.scrollY > 8)
    var probe = window.scrollY + 140
    // 下载区不归导航链接管，归那颗 CTA 管。两个一起亮等于两个都没说清在哪儿。
    var atDl = !!(dlSec && dlSec.offsetTop <= probe)
    var current = null
    if (!atDl) {
      targets.forEach(function (sec) {
        if (sec.offsetTop <= probe) current = sec.id
      })
    }
    links.forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('href') === '#' + current)
    })
    if (dlBtn) dlBtn.classList.toggle('active', atDl)
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  // ── 移动端菜单 ──
  var menuBtn = document.querySelector('.menu-btn')
  var mobile = document.querySelector('.mobile-links')
  function closeMenu(refocus) {
    if (!mobile || !mobile.classList.contains('open')) return
    mobile.classList.remove('open')
    menuBtn.setAttribute('aria-expanded', 'false')
    if (refocus) menuBtn.focus()
  }
  if (menuBtn && mobile) {
    menuBtn.addEventListener('click', function () {
      var open = mobile.classList.toggle('open')
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
    })
    mobile.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') closeMenu(false)
    })
    // 触屏没有 Esc，点面板外面得能收起来
    document.addEventListener('click', function (e) {
      if (mobile.classList.contains('open') && !mobile.contains(e.target) && !menuBtn.contains(e.target)) {
        closeMenu(false)
      }
    })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu(true)
    })
  }
})()

// 首屏那张圆桌：把「一轮 = 六家并行发言 + 一次主持小结 + 一格格落下的台账」演一遍。
//
// 为什么是 JS 而不是纯 CSS 关键帧：这条时间线是「一场讨论」，六家模型的粒子在同一场里
// 各有段落，台账要在小结那一刻逐格落下去，而且整张图要在滚出视口时停住 ——
// CSS 的 animation-play-state 管不到「这张图现在没人看」这件事。
// 这里只有一个时钟 + 一张到点执行的表：暂停 = 不再累加时间，回来从这一格接着走，
// 不会一跳跳到十分钟后的状态。
//
// 几何写在 index.html 的 SVG 里，这里照抄一份只为了算粒子轨迹。
// 三处口径必须一起改：圆心 300,300 / 半径 150 / 六席在 -90,-30,30,90,150,210 度 /
// 台账轨道横向段 y=300、竖向轨 x=575 / 九格结论的 dot cy 见 ROWS。
(function () {
  'use strict'

  var stage = document.getElementById('fl-stage')
  var scene = document.getElementById('fl-scene')
  if (!stage || !scene) return

  var CX = 300
  var CY = 300
  // 主持盘的右沿 —— 往台账推东西都从这里出发
  var BUS = { x: 340, y: 300 }
  var SPINE = 575
  var SEATS = [
    { x: 300, y: 150 },
    { x: 429.9, y: 225 },
    { x: 429.9, y: 375 },
    { x: 300, y: 450 },
    { x: 170.1, y: 375 },
    { x: 170.1, y: 225 },
  ]
  var ALL = [0, 1, 2, 3, 4, 5]
  // 九格结论的落点（圆点的 cy），跟 index.html 里 fl-r1..fl-r9 一一对应
  var ROWS = { r1: 98, r2: 140, r3: 182, r4: 224, r5: 284, r6: 326, r7: 368, r8: 428, r9: 470 }
  var CH = ['API', 'API', 'API', '网页通道', '网页通道', '网页通道']
  // 每家每轮的响应时长。写死而不是随机生成：这一场的数字要和台账里那九格对得上，
  // 随机数每次刷新都不一样，看着就像贴图在动而不是讨论在跑。
  var LAT = [
    ['1.2s', '0.9s', '1.4s'],
    ['1.6s', '1.1s', '1.8s'],
    ['1.1s', '0.8s', '1.3s'],
    ['2.3s', '1.7s', '2.6s'],
    ['2.1s', '1.5s', '缺席'],
    ['1.9s', '1.4s', '2.1s'],
  ]
  var LOOP = 26000

  var seatEls = [].slice.call(scene.querySelectorAll('[data-seat]'))
  var stEls = seatEls.map(function (el) {
    return el.querySelector('.fl-st')
  })
  var pkEls = [].slice.call(document.querySelectorAll('#fl-pks .fl-pk'))
  var feedEls = [].slice.call(document.querySelectorAll('#fl-pk-feed .fl-pk'))
  var pkTopic = document.getElementById('fl-pk-topic')
  var pkCut = document.getElementById('fl-pk-cut')
  var pkRep = document.getElementById('fl-pk-rep')
  var topicEl = document.getElementById('fl-topic')
  var cutEl = document.getElementById('fl-cut')
  var repEl = document.getElementById('fl-rep')
  var hubEl = document.getElementById('fl-hub')
  var snapEl = document.getElementById('fl-snap')
  var x1 = document.getElementById('fl-x1')
  var x2 = document.getElementById('fl-x2')
  var xlab = document.getElementById('fl-xlab')
  var noteEl = document.getElementById('fl-note')
  var tlfill = document.getElementById('fl-tlfill')
  var progEl = document.getElementById('fl-prog')
  var tnodes = [].slice.call(scene.querySelectorAll('.fl-tnode'))
  var rows = {}
  Object.keys(ROWS).forEach(function (k) {
    rows[k] = document.getElementById('fl-' + k)
  })
  var elRound = document.getElementById('fl-round')
  var elAgree = document.getElementById('fl-agree')
  var elDisp = document.getElementById('fl-disp')
  var elTodo = document.getElementById('fl-todo')
  var elCost = document.getElementById('fl-cost')

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ── 时钟与两张表 ──
  // tweens 管连续量（粒子位置、进度条长度），jobs 管到点一次的量（换文案、亮灯、加计数）。
  // 每轮重播时两张表一起清空，否则上一轮的尾巴会拖进下一轮。
  var tweens = []
  var jobs = []
  var t = 0

  function ease(k) {
    return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
  }
  function tween(at, dur, fn) {
    tweens.push({ at: at, dur: dur, fn: fn })
  }
  function fire(at, fn) {
    jobs.push({ at: at, fn: fn })
  }
  function clearAll() {
    tweens.length = 0
    jobs.length = 0
  }

  function move(el, from, to, at, dur) {
    tween(at, dur, function (k, done) {
      // 到点才现身：在排期时就写 opacity 的话，粒子会先钉在起点上等着被推走
      el.style.opacity = '1'
      var e = ease(k)
      el.setAttribute('cx', from.x + (to.x - from.x) * e)
      el.setAttribute('cy', from.y + (to.y - from.y) * e)
      if (done) el.style.opacity = '0'
    })
  }

  /** 两折：先沿轨道走到竖轨，再斜着落到某一格。走直线的话会压在任何一家身上。 */
  function move2(el, a, m, b, at, dur) {
    tween(at, dur, function (k, done) {
      el.style.opacity = '1'
      var from, to, kk
      if (k < 0.4) {
        from = a; to = m; kk = k / 0.4
      } else {
        from = m; to = b; kk = (k - 0.4) / 0.6
      }
      var e = ease(kk)
      el.setAttribute('cx', from.x + (to.x - from.x) * e)
      el.setAttribute('cy', from.y + (to.y - from.y) * e)
      if (done) el.style.opacity = '0'
    })
  }

  /** dir='out' 是快照下发（琥珀），'in' 是发言回收（青）。list 缺省 = 全部六家。 */
  function fan(at, dir, list, stagger) {
    var seats = list || ALL
    seats.forEach(function (i, n) {
      var at2 = at + n * (stagger == null ? 90 : stagger)
      var pk = pkEls[i]
      // 换色要排在起飞那一刻，不能就在 schedule() 里当场改：整场是排班表，
      // 六个 fan() 在同一毫秒里连着跑完，最后那次（回收）会把前面所有琥珀色
      // 一把抹掉 —— 结果「下发」和「回收」看着是同一种颜色，caption 白写。
      fire(at2, function () {
        pk.classList.toggle('amber', dir === 'out')
      })
      var a = { x: CX, y: CY }
      var b = { x: SEATS[i].x, y: SEATS[i].y }
      move(pk, dir === 'out' ? a : b, dir === 'out' ? b : a, at2, 850)
      // 亮灯跟着粒子到点，而不是整轮一起到点：六家本来就差几十毫秒开始说话
      if (dir === 'out') {
        fire(at2 + 850, function () {
          seatEls[i].classList.add('speaking', 'said')
          stEls[i].textContent = CH[i] + ' · 发言中…'
        })
      }
    })
  }

  /** 这一批说完：把「发言中…」换成「已回 x.xs」。r 是本轮下标（0 起）。 */
  function hush(at, r) {
    fire(at, function () {
      seatEls.forEach(function (el, i) {
        if (!el.classList.contains('speaking')) return
        el.classList.remove('speaking')
        stEls[i].textContent = CH[i] + ' · 已回 ' + LAT[i][r]
      })
    })
  }

  function note(at, s) {
    fire(at, function () {
      noteEl.textContent = s
    })
  }

  /** 数字跳一下：给个 0.5s 的强调色，让人知道这一格变了 */
  function bump(el, at, v) {
    fire(at, function () {
      el.textContent = v
      el.classList.add('bump')
      fire(at + 520, function () {
        el.classList.remove('bump')
      })
    })
  }

  function hubHit(at) {
    fire(at, function () {
      hubEl.classList.remove('hit')
      // 同一场里连着两次小结时，不重启动画就只会看到第二次之后的静默
      void hubEl.getBoundingClientRect()
      hubEl.classList.add('hit')
      fire(at + 950, function () {
        hubEl.classList.remove('hit')
      })
    })
  }

  /** 主持在整理结论的那一段：盘外一圈虚线慢慢转 */
  function summ(at, dur) {
    fire(at, function () {
      hubEl.classList.add('summ')
    })
    fire(at + dur, function () {
      hubEl.classList.remove('summ')
    })
  }

  function snap(at) {
    fire(at, function () {
      snapEl.classList.remove('on')
      void snapEl.getBoundingClientRect()
      snapEl.classList.add('on')
      fire(at + 1150, function () {
        snapEl.classList.remove('on')
      })
    })
  }

  function xlink(at, el) {
    fire(at, function () {
      el.classList.add('on')
      fire(at + 1400, function () {
        el.classList.remove('on')
      })
    })
  }

  /** 一条结论落进台账：绿色粒子沿轨道走两折，到点那一格才亮。 */
  var feedTurn = 0
  function feed(at, key) {
    fire(at, function () {
      var el = feedEls[feedTurn % feedEls.length]
      feedTurn++
      el.classList.add('green')
      move2(el, BUS, { x: SPINE, y: CY }, { x: 618, y: ROWS[key] }, at, 1000)
      fire(at + 1000, function () {
        rows[key].classList.add('on', 'flash')
        fire(at + 1950, function () {
          rows[key].classList.remove('flash')
        })
      })
    })
  }

  /** 时间轴：走到哪一轮，哪一格亮、进度线长到哪 */
  function tl(at, n, fillTo) {
    fire(at, function () {
      tnodes.forEach(function (el, i) {
        el.classList.toggle('active', i === n)
        el.classList.toggle('done', i < n)
      })
    })
    if (fillTo == null) return
    var from = fillTo === 230 ? 0 : 230
    tween(at, 700, function (k) {
      tlfill.setAttribute('width', from + (fillTo - from) * ease(k))
    })
  }

  function reset() {
    seatEls.forEach(function (el, i) {
      el.classList.remove('speaking', 'said', 'absent')
      stEls[i].textContent = CH[i]
    })
    pkEls.concat(feedEls, [pkTopic, pkCut, pkRep]).forEach(function (el) {
      el.style.opacity = '0'
      el.classList.remove('amber', 'green')
    })
    Object.keys(rows).forEach(function (k) {
      rows[k].classList.remove('on', 'flash')
    })
    topicEl.classList.remove('on')
    cutEl.classList.remove('on')
    repEl.classList.remove('on')
    x1.classList.remove('on')
    x2.classList.remove('on')
    xlab.classList.remove('on')
    snapEl.classList.remove('on')
    hubEl.classList.remove('hit', 'summ')
    tlfill.setAttribute('width', '0')
    progEl.style.transform = 'scaleX(0)'
    elRound.textContent = '第 1 / 3 轮'
    elAgree.textContent = '0'
    elDisp.textContent = '0'
    elTodo.textContent = '0'
    elCost.textContent = '¥0.00'
  }

  /** 排一整场。时间都是绝对毫秒，读起来就是一张节目单。 */
  function schedule() {
    note(0, '议题进场 → 交给主持：主持把它连同背景材料、各家通道状态一起分发下去')
    fire(0, function () {
      topicEl.classList.add('on')
    })
    // 进度条走满一格 = 这场演示重播一次，不是研讨的进度
    tween(0, LOOP, function (k) {
      progEl.style.transform = 'scaleX(' + k + ')'
    })

    move(pkTopic, { x: 420, y: 42 }, { x: 272, y: 298 }, 400, 900)

    // ── 第 1 轮 ──
    hubHit(1400)
    summ(1400, 900)
    note(1500, '第 1 轮 · 六家并行发言：同一份快照，互相看不见本轮谁先开口')
    tl(1500, 0)
    fan(1700, 'out')

    hush(4800, 0)
    note(4800, '回收六份发言 → 主持小结')
    fan(4900, 'in')

    hubHit(5800)
    summ(5800, 1500)
    bump(elAgree, 5800, '1')
    bump(elDisp, 5920, '2')
    bump(elCost, 6040, '¥0.11')
    note(5800, '第 1 轮小结：共识 +1 · 分歧 +2 —— 分歧不会因为「大家都这么说」而消失')
    feed(6100, 'r1')
    feed(6400, 'r5')
    feed(6700, 'r6')
    snap(7300)
    note(7400, '快照回灌：下一批六家看到的是同一份「上轮结束时的快照」')

    // ── 第 2 轮 ──
    bump(elRound, 8400, '第 2 / 3 轮')
    tl(8400, 1, 230)
    note(8500, '第 2 轮 · 交叉质询由主持发起：把没谈拢的那两条抛回给具体两家')
    fan(8600, 'out')
    xlink(9600, x1)
    xlink(9900, x2)
    fire(9900, function () {
      xlab.classList.add('on')
      fire(11200, function () {
        xlab.classList.remove('on')
      })
    })

    // 中途插话：进来的是下一批快照，不打断正在发言的这一批
    fire(10300, function () {
      cutEl.classList.add('on')
    })
    note(10300, '你插了一句 → 它进的是下一批快照，不打断正在发言的这一批')
    move(pkCut, { x: 560, y: 580 }, { x: 322, y: 318 }, 10800, 700)

    hush(11600, 1)
    note(11600, '回收发言 → 主持小结')
    fan(11700, 'in')

    hubHit(12600)
    summ(12600, 1500)
    bump(elAgree, 12600, '2')
    bump(elDisp, 12720, '3')
    bump(elTodo, 12840, '1')
    bump(elCost, 12960, '¥0.28')
    note(12600, '第 2 轮小结：共识 +1 · 分歧 +1 · 又冒出一条缺依据的，标成待验证')
    feed(13000, 'r2')
    feed(13300, 'r7')
    feed(13600, 'r8')
    snap(14200)

    // ── 第 3 轮 ──
    bump(elRound, 15000, '第 3 / 3 轮')
    tl(15000, 2, 460)
    note(15100, '第 3 轮 · 通义千问·网页 那一格没回：标成缺席，不静默留白')
    fire(15200, function () {
      seatEls[4].classList.add('absent')
      seatEls[4].classList.remove('speaking')
      stEls[4].textContent = '网页通道 · 缺席'
    })
    fan(15300, 'out', [0, 1, 2, 3, 5])

    hush(17000, 2)
    note(17000, '回收五份发言 → 主持小结（缺席那家不计入共识度）')
    fan(17100, 'in', [0, 1, 2, 3, 5])

    hubHit(18000)
    summ(18000, 1600)
    bump(elAgree, 18000, '4')
    bump(elTodo, 18120, '2')
    bump(elCost, 18240, '¥0.52')
    note(18000, '第 3 轮小结：你那句插话生效 —— 预算那条重算后进了共识')
    feed(18400, 'r3')
    feed(18700, 'r4')
    feed(19000, 'r9')
    snap(19600)

    // ── 出报告 ──
    note(20400, '轮次用尽 → 主持把三张快照汇成一份报告')
    move2(pkRep, BUS, { x: SPINE, y: CY }, { x: 618, y: 548 }, 20500, 1400)

    fire(22000, function () {
      repEl.classList.add('on')
      tnodes.forEach(function (el) {
        el.classList.add('done')
        el.classList.remove('active')
      })
    })
    note(22000, '报告：共识 4 · 保留分歧 3 · 待验证 2 · 溯源 21 条，缺席的那家写在报告里')
  }

  // ── 跑起来 ──
  if (reduced) {
    // 静态兜底：直接摆到终态。HTML 里的默认值就是这个态，所以这里只需补齐
    // 「发言过」的痕迹，不启动时钟。
    seatEls.forEach(function (el, i) {
      if (i !== 4) {
        el.classList.add('said')
        stEls[i].textContent = CH[i] + ' · 已回 ' + LAT[i][2]
      }
    })
    seatEls[4].classList.add('absent')
    stEls[4].textContent = '网页通道 · 缺席'
    return
  }

  var visible = true
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(
      function (entries) {
        visible = entries[0].isIntersecting
      },
      { threshold: 0 },
    ).observe(stage)
  }

  var last = 0
  function frame(now) {
    requestAnimationFrame(frame)
    if (!last) last = now
    // 一次最多算 100ms：切走标签页回来时 dt 可能是几分钟，
    // 不夹住的话整场会在同一帧里被快进完，粒子全停在终点。
    var dt = Math.min(now - last, 100)
    last = now
    if (!visible || document.hidden) return

    t += dt
    if (t >= LOOP) {
      t = 0
      feedTurn = 0
      clearAll()
      reset()
      schedule()
    }

    for (var i = jobs.length - 1; i >= 0; i--) {
      if (t >= jobs[i].at) {
        var j = jobs[i]
        jobs.splice(i, 1)
        j.fn()
      }
    }
    for (var k = tweens.length - 1; k >= 0; k--) {
      var w = tweens[k]
      if (t < w.at) continue
      var p = (t - w.at) / w.dur
      if (p >= 1) {
        tweens.splice(k, 1)
        w.fn(1, true)
      } else {
        w.fn(p, false)
      }
    }
  }

  reset()
  schedule()
  requestAnimationFrame(frame)
})()

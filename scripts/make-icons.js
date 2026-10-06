/**
 * 把品牌标记 SVG 光栅化成全套应用图标（PNG 各尺寸 + icon.ico + icon.icns → resources/brand/）。
 *
 * 为什么不直接截图窗口：Chromium 允许把 data: URL 的 SVG 画进 canvas 并
 * toDataURL 取 PNG，带 alpha、尺寸精确，也不依赖窗口是否可见。
 *
 * 为什么放 resources/ 而不是 build/：build/ 是 electron-builder 默认的
 * buildResources 目录，图标源文件压在那里会让打包器以为自己覆盖了品牌层。
 *
 * .ico / .icns 用纯 Node 写（PNG-in-ICO / PNG-entry ICNS），不引第三方图像库：
 * Windows Vista+ 与 macOS 都接受「容器里直接塞 PNG」，代价只是没有 BMP 兜底，
 * 而我们要的尺寸全在 256 以内。
 *
 * 产物是提交进仓库的静态资源：`npm run icons` 只在改了 mark.svg 之后需要跑。
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src', 'renderer', 'assets', 'brand', 'mark.svg')
const OUT_DIR = path.join(ROOT, 'resources', 'brand')

/** PNG 全集：应用窗口图标、安装包、任务栏、Retina 各档都要有对应的尺寸 */
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
/** .ico：Windows 外壳最多用到 256，更大的塞进去反而没人读 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
/** .icns：type → 取哪个尺寸（PNG 条目，macOS 11+ 全识别） */
const ICNS_ENTRIES = [
  ['icp4', 16],
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
]

app.disableHardwareAcceleration()

/** 从 PNG 字节里读宽高（IHDR），用来验证写出来的图标尺寸没写歪 */
function pngSize(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('不是 PNG')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

/** PNG-in-ICO：1 字节宽/高里 256 要写成 0，这是这个格式唯一的坑 */
function buildIco(items) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type 1 = 图标
  header.writeUInt16LE(items.length, 4)
  const DIR = 16
  let offset = header.length + items.length * DIR
  const dir = Buffer.alloc(items.length * DIR)
  const parts = []
  items.forEach(({ size, buf }, i) => {
    const base = i * DIR
    dir.writeUInt8(size === 256 ? 0 : size, base)
    dir.writeUInt8(size === 256 ? 0 : size, base + 1)
    dir.writeUInt32LE(buf.length, base + 8)
    dir.writeUInt32LE(offset, base + 12)
    offset += buf.length
    parts.push(buf)
  })
  return Buffer.concat([header, dir, ...parts])
}

function buildIcns(items) {
  const body = items.map(({ type, buf }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 4, 'ascii')
    head.writeUInt32BE(8 + buf.length, 4) // 长度含这 8 字节自己的头
    return Buffer.concat([head, buf])
  })
  const all = Buffer.concat(body)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(8 + all.length, 4)
  return Buffer.concat([header, all])
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SRC, 'utf8')
  if (!/<svg[^>]*\swidth="64"/.test(svg)) {
    console.log('[icons] mark.svg 必须自带 width/height，否则 Chromium 画不出尺寸')
    app.exit(1)
  }
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')

  const win = new BrowserWindow({ show: false, width: 64, height: 64 })
  await win.loadURL('data:text/html,<!doctype html><title>icons</title>')
  const pngs = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    for (const size of ${JSON.stringify(SIZES)}) {
      const img = new Image();
      img.src = ${JSON.stringify(dataUrl)};
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = size; cv.height = size;
      cv.getContext('2d').drawImage(img, 0, 0, size, size);
      out.push({ size, data: cv.toDataURL('image/png') });
    }
    return out;
  })()`)
  win.destroy()

  fs.mkdirSync(OUT_DIR, { recursive: true })
  // app.exit 要等一轮消息循环，失败时后面的日志会照样打完、看起来像成功，
  // 所以校验路径统一用 process.exit。
  const die = () => process.exit(1)
  const bySize = new Map()
  for (const { size, data } of pngs) {
    const buf = Buffer.from(data.split(',')[1], 'base64')
    const { w, h } = pngSize(buf)
    if (w !== size || h !== size) {
      console.log(`[icons] icon-${size}.png 光栅化结果尺寸不对：${w}x${h}`)
      die()
    }
    bySize.set(size, buf)
    const file = path.join(OUT_DIR, `icon-${size}.png`)
    fs.writeFileSync(file, buf)
    console.log(`[icons] ${path.relative(ROOT, file)} (${buf.length}B)`)
  }

  const write = (name, buf) => {
    const file = path.join(OUT_DIR, name)
    fs.writeFileSync(file, buf)
    console.log(`[icons] ${path.relative(ROOT, file)} (${buf.length}B)`)
  }

  write('icon.ico', buildIco(ICO_SIZES.map((size) => ({ size, buf: bySize.get(size) }))))
  write('icon.icns', buildIcns(ICNS_ENTRIES.map(([type, size]) => ({ type, buf: bySize.get(size) }))))

  // 读回校验：容器格式全靠自己手写，解析不回来就是打包时才炸的哑弹。
  const ico = fs.readFileSync(path.join(OUT_DIR, 'icon.ico'))
  if (ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== ICO_SIZES.length) {
    console.log('[icons] icon.ico 头校验失败')
    die()
  }
  for (let i = 0; i < ICO_SIZES.length; i++) {
    const off = ico.readUInt32LE(6 + i * 16 + 12)
    const expect = ICO_SIZES[i] === 256 ? 0 : ICO_SIZES[i]
    // 至少要读到 IHDR 末尾（8 字节签名 + 宽高），切 8 字节只够判断签名。
    if (ico.readUInt8(6 + i * 16) !== expect || pngSize(ico.slice(off, off + 24)).w !== ICO_SIZES[i]) {
      console.log(`[icons] icon.ico 第 ${i} 张（${ICO_SIZES[i]}px）解析不回来`)
      die()
    }
  }
  const icns = fs.readFileSync(path.join(OUT_DIR, 'icon.icns'))
  if (icns.toString('ascii', 0, 4) !== 'icns' || icns.readUInt32BE(4) !== icns.length) {
    console.log('[icons] icon.icns 头校验失败')
    die()
  }
  let p = 8
  const seen = []
  while (p < icns.length) {
    const type = icns.toString('ascii', p, p + 4)
    const len = icns.readUInt32BE(p + 4)
    const data = icns.slice(p + 8, p + len)
    const entry = ICNS_ENTRIES.find(([t]) => t === type)
    if (!entry || pngSize(data).w !== entry[1]) {
      console.log(`[icons] icon.icns 的 ${type} 尺寸对不上`)
      die()
    }
    seen.push(type)
    p += len
  }
  if (seen.join(',') !== ICNS_ENTRIES.map(([t]) => t).join(',')) {
    console.log(`[icons] icon.icns 条目不全：${seen.join(', ')}`)
    die()
  }
  console.log('[icons] ico/icns 读回校验通过')
  app.exit(0)
})

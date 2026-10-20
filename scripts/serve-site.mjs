// 本地预览落地页：node scripts/serve-site.mjs [端口]
//
// 为什么要单独一个脚本：site/index.html 里的 favicon 写的是 ../resources/brand/icon-64.png，
// 只有把仓库根当站点根才能解析得到；直接双击 index.html 走 file:// 也能看，
// 但 localStorage 在部分内核的 file:// 下不可用，主题记忆和滚动出场会一起失真。
//
// 只监听 127.0.0.1，只读，路径越界一律 403 —— 这是个预览器，不是服务器。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = Number(process.argv[2] || 4173)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  let p = decodeURIComponent(url.pathname)
  if (p.endsWith('/')) p += 'index.html'

  // 先解析再比对：'..' 在字符串里长什么样不重要，落到磁盘上是什么才重要
  const file = path.resolve(ROOT, '.' + p)
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('403 越界了')
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('404 ' + p)
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(buf)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`落地页：http://127.0.0.1:${PORT}/site/`)
  console.log(`（Ctrl+C 停）`)
})

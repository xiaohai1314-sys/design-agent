#!/usr/bin/env node
// 从配置的地址下载运行资源包并解压到 resources/ 下（新机器 clone 后执行一次）。
// 用法：npm run fetch:resources
import { createHash } from 'node:crypto'
import { closeSync, createWriteStream, createReadStream, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const configPath = join(root, 'resources-bundle.json')

let config = {}
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    console.error(`无法解析 ${configPath}`)
    process.exit(1)
  }
}

const url = (process.env.RESOURCES_BUNDLE_URL || config.url || '').trim()
const expectedSha = (process.env.RESOURCES_BUNDLE_SHA256 || config.sha256 || '').trim().toLowerCase()

// 私有仓库的 Release 只能通过 API 资产端点下载，需要令牌。
// 令牌优先取环境变量，其次读仓库根目录的 gh-token.txt（已 gitignore）。
function readToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim()
  const tokenFile = join(root, 'gh-token.txt')
  if (!existsSync(tokenFile)) return ''
  return readFileSync(tokenFile, 'utf8').split(/\r?\n/)[0].trim()
}
const token = readToken()
const isApiAsset = /^https:\/\/api\.github\.com\//i.test(url)
const headers = isApiAsset && token ? { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' } : undefined

if (!url) {
  console.error(
    [
      '尚未配置资源包地址。两种方式任选其一：',
      '',
      '  1) 编辑 resources-bundle.json，填入 "url"（以及可选的 "sha256"）',
      '  2) 临时指定：RESOURCES_BUNDLE_URL=<地址> npm run fetch:resources',
      '',
      '资源包用 npm run pack:resources 生成，上传到 GitHub Release 后取其下载地址。'
    ].join('\n')
  )
  process.exit(1)
}

// 下载到仓库内的 dist-resources/，解压时才能用相对路径
// （GNU tar 在 Windows 上会把 "F:" 当成远程主机名）
const workDir = join(root, 'dist-resources')
mkdirSync(workDir, { recursive: true })
const tmpName = `.fetch-${Date.now()}.tar.gz`
const tmpFile = join(workDir, tmpName)
// 支持本地路径（U 盘 / 局域网共享 / 离线校验），其余按 URL 下载
if (/^https?:\/\//i.test(url)) {
  if (isApiAsset && !token) {
    console.error(
      [
        '这是私有仓库的资产地址，需要访问令牌。两种方式任选其一：',
        '',
        '  1) 在仓库根目录新建 gh-token.txt，内容只有一行令牌（该文件已 gitignore）',
        '  2) 临时指定：GH_TOKEN=<令牌> npm run fetch:resources',
        '',
        '令牌在 https://github.com/settings/personal-access-tokens 创建，',
        '只授权 design-agent-resources 仓库，Contents 权限选 Read-only。'
      ].join('\n')
    )
    process.exit(1)
  }
  console.log(`下载：${url}`)
  await download(url, tmpFile, headers)
} else {
  const local = resolve(root, url)
  if (!existsSync(local)) {
    console.error(`本地资源包不存在：${local}`)
    process.exit(1)
  }
  console.log(`使用本地资源包：${local}`)
  copyFileSync(local, tmpFile)
}

// 网盘分享页、登录页、错误页都会返回 200 的 HTML，这里先确认拿到的确实是 gzip
const magic = Buffer.alloc(2)
const fd = openSync(tmpFile, 'r')
readSync(fd, magic, 0, 2, 0)
closeSync(fd)
if (magic[0] !== 0x1f || magic[1] !== 0x8b) {
  rmSync(tmpFile, { force: true })
  console.error(
    [
      '拿到的不是 gzip 压缩包，地址可能指向了网盘分享页或登录页。',
      '',
      '网盘（115、百度网盘等）的分享链接不能直接下载，请先在浏览器里下载到本地，再用本地路径：',
      '  RESOURCES_BUNDLE_URL=<本地文件路径> npm run fetch:resources'
    ].join('\n')
  )
  process.exit(1)
}

const actualSha = await hashFile(tmpFile)
if (expectedSha && actualSha !== expectedSha) {
  rmSync(tmpFile, { force: true })
  console.error(`sha256 不匹配，已中止。\n  期望：${expectedSha}\n  实际：${actualSha}`)
  process.exit(1)
}
console.log(`sha256：${actualSha}${expectedSha ? '（校验通过）' : '（未配置校验值）'}`)

console.log('解压到 resources/ …')
const res = spawnSync('tar', ['-xzf', `dist-resources/${tmpName}`, '-C', '.'], {
  cwd: root,
  stdio: 'inherit'
})
rmSync(tmpFile, { force: true })
if (res.error) {
  console.error('调用 tar 失败：', res.error.message)
  process.exit(1)
}
if (res.status !== 0) process.exit(res.status ?? 1)

console.log('\n完成。运行 npm run check:resources 确认 11 项全部就绪。')

async function download(from, to, reqHeaders) {
  const res = await fetch(from, { redirect: 'follow', headers: reqHeaders })
  if (!res.ok || !res.body) {
    const hint = res.status === 404 ? '（私有仓库需令牌，或资产 ID 已失效）' : ''
    console.error(`下载失败：HTTP ${res.status} ${res.statusText}${hint}`)
    process.exit(1)
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  const file = createWriteStream(to)
  let received = 0
  let lastLogged = 0
  for await (const chunk of res.body) {
    if (!file.write(chunk)) {
      await new Promise((resolve) => file.once('drain', resolve))
    }
    received += chunk.length
    if (received - lastLogged >= 32 * 1024 * 1024) {
      lastLogged = received
      const mb = (received / 1024 / 1024).toFixed(0)
      console.log(total ? `  ${mb} / ${(total / 1024 / 1024).toFixed(0)} MB` : `  ${mb} MB`)
    }
  }
  await new Promise((resolve, reject) => {
    file.end((err) => (err ? reject(err) : resolve()))
  })
  console.log(`  已下载 ${(received / 1024 / 1024).toFixed(1)} MB`)
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(file)
    s.on('data', (c) => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

#!/usr/bin/env node
// 从配置的地址下载运行资源包并解压到 resources/ 下（新机器 clone 后执行一次）。
// 用法：npm run fetch:resources
//
// 解压先进临时目录：整包 sha256 → 逐文件清单核对 → 全部通过才写入 resources/。
// 中途任何一步失败都不会动到现有的 resources/。
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadResumable } from './lib/download.mjs'
import { MANIFEST_PATH, applyStaged, formatBytes, hashFile, toPosix, verifyManifest, walkFiles } from './lib/resources.mjs'

const startedAt = Date.now()
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
// 半截包按地址区分：换了资源包地址，不会续到上一个包的字节上
const urlTag = createHash('sha1').update(url).digest('hex').slice(0, 12)
const tmpName = `.fetch-${urlTag}.tar.gz`
const tmpFile = join(workDir, tmpName)
// 别的地址留下的半截包没有续传价值，顺手清掉
for (const name of readdirSync(workDir)) {
  if (name.startsWith('.fetch-') && name !== tmpName) rmSync(join(workDir, name), { force: true })
}
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
  if (expectedSha && existsSync(tmpFile) && (await hashFile(tmpFile)) === expectedSha) {
    console.log('本地已有完整的资源包，跳过下载。')
  } else {
    if (existsSync(tmpFile)) {
      console.log(`发现未下完的资源包（${formatBytes(statSync(tmpFile).size)}），从断点续传。`)
    }
    console.log(`下载：${url}`)
    let lastLogged = 0
    await downloadResumable(url, tmpFile, {
      headers,
      onProgress: (received, total) => {
        if (received - lastLogged < 32 * 1024 * 1024) return
        lastLogged = received
        console.log(
          total
            ? `  ${(received / 1024 / 1024).toFixed(0)} / ${(total / 1024 / 1024).toFixed(0)} MB`
            : `  ${(received / 1024 / 1024).toFixed(0)} MB`
        )
      },
      onRetry: (attempt, error, have, wait) => {
        console.warn(
          `  第 ${attempt} 次中断：${error.message}；已收到 ${formatBytes(have)}，${Math.round(wait / 1000)} 秒后续传。`
        )
      }
    })
    console.log(`  已下载 ${formatBytes(statSync(tmpFile).size)}`)
  }
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
  console.error(`sha256 不匹配，已中止。\n  期望：${expectedSha}\n  实际：${actualSha}\n  已删除本地文件，重跑会重新下载。`)
  process.exit(1)
}
console.log(`sha256：${actualSha}${expectedSha ? '（校验通过）' : '（未配置校验值）'}`)

// 上次被打断留下的临时目录：里面的内容都还没校验过，直接清掉
for (const name of readdirSync(workDir)) {
  if (name.startsWith('.staging-')) rmSync(join(workDir, name), { recursive: true, force: true })
}

const stamp = Date.now()
const stagingRel = `dist-resources/.staging-${stamp}`
const staging = join(root, stagingRel)
mkdirSync(staging, { recursive: true })

console.log('解压到临时目录 …')
const res = spawnSync('tar', ['-xzf', `dist-resources/${tmpName}`, '-C', stagingRel], {
  cwd: root,
  stdio: 'inherit'
})
if (res.error) {
  rmSync(staging, { recursive: true, force: true })
  console.error('调用 tar 失败：', res.error.message)
  console.error(`资源包留在 ${tmpFile}，处理好后重跑不会再下载。`)
  process.exit(1)
}
if (res.status !== 0) {
  rmSync(staging, { recursive: true, force: true })
  console.error(`tar 解压失败（退出码 ${res.status}）。资源包留在 ${tmpFile}，处理好后重跑不会再下载。`)
  process.exit(res.status ?? 1)
}
// CI 里设 RESOURCES_KEEP_BUNDLE=1 把包留着：下次跑能直接命中缓存，不用重下几百 MB
if (process.env.RESOURCES_KEEP_BUNDLE) {
  console.log(`保留资源包：${tmpFile}`)
} else {
  rmSync(tmpFile, { force: true })
}

// 清单在包里，解压后才拿得到；它记录每个文件的 sha256
const manifestFile = join(staging, MANIFEST_PATH)
let manifest = null
if (existsSync(manifestFile)) {
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  } catch {
    manifest = null
  }
}

if (manifest?.files) {
  console.log(`逐文件核对 ${manifest.fileCount} 个文件 …`)
  const check = await verifyManifest(staging, manifest, (done, total) => {
    console.log(`  已核对 ${done} / ${total}`)
  })
  if (!check.ok) {
    rmSync(staging, { recursive: true, force: true })
    console.error(
      [
        '',
        '资源包内容与清单不符，已中止，现有 resources/ 未做任何改动。',
        `  缺失：${check.missing.length} 个`,
        `  不符：${check.mismatched.length} 个`,
        ...check.missing.slice(0, 10).map((rel) => `    缺失 ${rel}`),
        ...check.mismatched.slice(0, 10).map((m) => `    不符 ${m.rel}（${m.reason}）`),
        check.missing.length + check.mismatched.length > 20 ? '    …其余见上，请重新下载资源包' : '',
        '',
        '多半是下载中断或上传的包不完整，重新打包上传后再取一次。'
      ]
        .filter(Boolean)
        .join('\n')
    )
    process.exit(1)
  }
  console.log('  全部通过')
} else {
  console.warn('⚠️  资源包内没有清单文件（旧版打包），跳过逐文件校验，只依赖整包 sha256。')
}

// 清单本身不在 files 里（它记录的是别人的哈希），但也要落到 resources/ 下，
// 装好之后 verify:resources 才有得核对
const files = manifest?.files
  ? [...Object.keys(manifest.files), MANIFEST_PATH]
  : walkFiles(staging).map((full) => toPosix(relative(staging, full)))

// 资源包只该往 resources/ 下写。applyStaged 只拦了逃出仓库根目录的路径，
// 清单或旧版包里如果有 src/、package.json、.git/hooks/ 这类路径，照样会覆盖源码或钩子
const outside = files.filter((rel) => !rel.startsWith('resources/'))
if (outside.length > 0) {
  rmSync(staging, { recursive: true, force: true })
  console.error(
    [
      `资源包里有 ${outside.length} 个文件不在 resources/ 下，已中止，现有文件未做任何改动：`,
      ...outside.slice(0, 10).map((rel) => `  ${rel}`),
      outside.length > 10 ? '  …' : ''
    ]
      .filter(Boolean)
      .join('\n')
  )
  process.exit(1)
}

if (files.length === 0) {
  rmSync(staging, { recursive: true, force: true })
  console.error('资源包是空的，已中止。')
  process.exit(1)
}

// 写入前先备份被覆盖的文件，中途失败可以整体回滚
const backupDir = join(workDir, `.backup-${stamp}`)
const totalBytes = files.reduce((n, rel) => {
  const meta = manifest?.files?.[rel]
  if (meta) return n + meta.size
  try {
    return n + statSync(join(staging, rel)).size
  } catch {
    return n
  }
}, 0)

const result = applyStaged(root, staging, files, backupDir)
if (!result.ok) {
  const reason = result.error instanceof Error ? result.error.message : String(result.error)
  if (result.restored) rmSync(backupDir, { recursive: true, force: true })
  rmSync(staging, { recursive: true, force: true })
  console.error(
    [
      '',
      `写入失败：${reason}`,
      result.restored
        ? '已回滚，resources/ 恢复到安装前的状态。'
        : `回滚未完成，原文件备份在 ${backupDir}，请手动恢复。`
    ].join('\n')
  )
  process.exit(result.restored ? 1 : 2)
}

const applied = result.applied
rmSync(staging, { recursive: true, force: true })
rmSync(backupDir, { recursive: true, force: true })

const replaced = applied.filter((a) => a.backedUp).length
const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
const minutes = Math.floor(elapsed / 60)
const seconds = elapsed % 60

console.log(
  [
    '',
    '资源包已就位。',
    `  写入文件：${applied.length} 个（覆盖 ${replaced}，新增 ${applied.length - replaced}）`,
    `  大小：${formatBytes(totalBytes)}`,
    `  逐文件校验：${manifest?.files ? '通过' : '跳过（旧版包无清单）'}`,
    `  耗时：${minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`}`,
    '',
    '下一步：npm run check:resources 确认 11 项全部就绪。'
  ].join('\n')
)

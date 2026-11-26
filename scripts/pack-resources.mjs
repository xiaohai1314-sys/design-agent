#!/usr/bin/env node
// 把 .gitignore 排除的运行资源打成可分发压缩包，供 fetch:resources 在新机器上还原。
// 用法：npm run pack:resources
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version ?? '0.0.0'

// 与 check-resources.mjs 的检查项一一对应
const ENTRIES = [
  'resources/runtime',
  'resources/mcp/sketchup/lib',
  'resources/mcp/blender/lib',
  'resources/mcp/3dsmax/lib',
  'resources/mcp/multicad/lib',
  'resources/mcp/photoshop/node_modules',
  'resources/mcp/computer-use',
  'resources/skills/cad/vendor'
]

const outDir = join(root, 'dist-resources')
mkdirSync(outDir, { recursive: true })
// 用相对路径传给 tar：GNU tar 在 Windows 上会把 "F:" 当成远程主机名
const outRel = `dist-resources/design-agent-resources-v${version}.tar.gz`
const outFile = join(root, outRel)

const present = []
let bytes = 0
for (const rel of ENTRIES) {
  const abs = join(root, rel)
  if (!existsSync(abs)) {
    console.warn(`⚠️  跳过（不存在）：${rel}`)
    continue
  }
  present.push(rel)
  bytes += dirSize(abs)
}
if (present.length === 0) {
  console.error('没有可打包的资源，先按 README「运行资源」一节放置文件。')
  process.exit(1)
}

console.log(`打包 ${present.length} 个目录（约 ${(bytes / 1024 / 1024).toFixed(0)} MB）…`)
const res = spawnSync('tar', ['-czf', outRel, ...present], { cwd: root, stdio: 'inherit' })
if (res.error) {
  console.error('调用 tar 失败：', res.error.message)
  process.exit(1)
}
if (res.status !== 0) process.exit(res.status ?? 1)

const size = statSync(outFile).size
const sha256 = await hashFile(outFile)
console.log(`\n已生成：${outFile}`)
console.log(`大小：${(size / 1024 / 1024).toFixed(1)} MB`)
console.log(`sha256：${sha256}`)
console.log('\n下一步：上传到 GitHub Release，再把地址和 sha256 填进 resources-bundle.json')

function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) {
        try {
          total += statSync(full).size
        } catch {
          // 忽略并发删除等偶发错误
        }
      }
    }
  }
  return total
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

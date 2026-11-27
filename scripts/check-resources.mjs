#!/usr/bin/env node
// 检查 resources/ 下未纳入 Git 的运行资源是否齐全，并说明缺失时受影响的功能。
// 用法：npm run check:resources            只看 11 项是否就位
//      npm run verify:resources          --verify：再按清单逐文件核对 sha256
// （有必需资源缺失或校验不符时退出码为 1）
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MANIFEST_PATH, findUnlisted, formatBytes, verifyManifest } from './lib/resources.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = (...p) => join(root, 'resources', ...p)
const verify = process.argv.includes('--verify')

const nonEmptyDir = (p) => {
  try {
    return statSync(p).isDirectory() && readdirSync(p).length > 0
  } catch {
    return false
  }
}

const checks = [
  { label: '内置 Python', path: res('runtime', 'python', 'python.exe'), impact: '技能脚本与 Python 类连接器回退到系统 python' },
  { label: '内置 Node', path: res('runtime', 'node', 'node.exe'), impact: 'Photoshop 连接器回退到 Electron 自带的 Node' },
  { label: '规范索引器', path: res('runtime', 'reg-indexer.exe'), impact: '规范检索回退到逐文件扫描（较慢）' },
  { label: '原生分词库', path: res('runtime', 'design_native.dll'), impact: '规范索引器无法运行' },
  { label: 'DWG 转换（LibreDWG）', path: res('skills', 'cad', 'vendor', 'win64'), dir: true, impact: '无法解析 .dwg 图纸（.dxf 不受影响）' },
  { label: 'SketchUp 连接器依赖', path: res('mcp', 'sketchup', 'lib'), dir: true, impact: 'SketchUp 连接器不可用' },
  { label: 'Blender 连接器依赖', path: res('mcp', 'blender', 'lib'), dir: true, impact: 'Blender 连接器不可用' },
  { label: '3ds Max 连接器依赖', path: res('mcp', '3dsmax', 'lib'), dir: true, impact: '3ds Max 连接器不可用' },
  { label: 'multicad 连接器', path: res('mcp', 'multicad', 'lib', 'server.py'), impact: 'CAD 编辑连接器不可用' },
  { label: 'Photoshop 连接器依赖', path: res('mcp', 'photoshop', 'node_modules'), dir: true, impact: 'Photoshop 连接器不可用（可在该目录执行 npm install）' },
  { label: 'computer-use 驱动', path: res('mcp', 'computer-use', 'cua-driver.exe'), impact: 'computer-use 连接器不可用' }
]

let missing = 0
console.log('运行资源检查（resources/）\n')
for (const c of checks) {
  const ok = c.dir ? nonEmptyDir(c.path) : existsSync(c.path)
  if (!ok) missing++
  const rel = c.path.slice(root.length + 1).replace(/\\/g, '/')
  console.log(`${ok ? '✅' : '❌'} ${c.label.padEnd(16, '　')} ${rel}${ok ? '' : `\n     缺失影响：${c.impact}`}`)
}
console.log(missing === 0 ? `\n${checks.length} 项资源全部就位。` : `\n共 ${missing} 项缺失，详见 README 的“运行资源”一节。`)

let bad = missing

if (verify) {
  const manifestFile = join(root, MANIFEST_PATH)
  if (!existsSync(manifestFile)) {
    console.log('\n逐文件校验：没有清单（resources/.resources-manifest.json）。')
    console.log('  清单由 npm run pack:resources 生成，或直接用 npm run fetch:resources 重装一次。')
  } else {
    let manifest = null
    try {
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    } catch {
      console.log('\n逐文件校验：清单无法解析。')
      bad += 1
    }
    if (manifest?.files) {
      console.log(`\n逐文件校验 ${manifest.fileCount} 个文件（${formatBytes(manifest.bytes)}）…`)
      const check = await verifyManifest(root, manifest, (done, total) => {
        if (done % 2000 === 0) console.log(`  已核对 ${done} / ${total}`)
      })
      const extra = findUnlisted(root, manifest)
      if (check.ok) {
        console.log(`  全部通过${extra.length ? `（另有 ${extra.length} 个不在清单内的文件，未计入）` : ''}`)
      } else {
        bad += check.missing.length + check.mismatched.length
        console.log(`  缺失 ${check.missing.length} 个，不符 ${check.mismatched.length} 个`)
        for (const rel of check.missing.slice(0, 20)) console.log(`    缺失 ${rel}`)
        for (const m of check.mismatched.slice(0, 20)) console.log(`    不符 ${m.rel}（${m.reason}）`)
        console.log('  修法：npm run fetch:resources 重装（先校验再落盘，失败不会留下半套资源）。')
      }
    }
  }
}

process.exitCode = bad === 0 ? 0 : 1

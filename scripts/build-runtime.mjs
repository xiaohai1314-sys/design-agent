import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nativeDir = join(root, 'tools', 'native-core')
const csDir = join(root, 'tools', 'RegIndexerCs')
const publishDir = join(csDir, 'publish')
const outDir = join(root, 'resources', 'runtime')

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root })
}

function has(cmd, probe = ['--version']) {
  try {
    execFileSync(cmd, probe, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

if (!has('dotnet', ['--list-sdks'])) {
  console.error('未找到 .NET SDK。安装：winget install Microsoft.DotNet.SDK.10')
  process.exit(1)
}
if (!has('g++')) {
  console.error('未找到 g++。安装：winget install BrechtSanders.WinLibs.POSIX.UCRT')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

const dllPath = join(outDir, 'zmo_native.dll')
run('g++', [
  '-shared', '-O2', '-static', '-static-libgcc', '-static-libstdc++',
  '-o', dllPath, join(nativeDir, 'zmo_native.cpp')
])

run('dotnet', ['publish', csDir, '-c', 'Release', '-r', 'win-x64', '-o', publishDir])

const exePath = join(publishDir, 'reg-indexer.exe')
if (!existsSync(exePath)) {
  console.error(`dotnet publish 未产出 ${exePath}`)
  process.exit(1)
}

// reg-indexer 通过 P/Invoke 加载同目录的 zmo_native.dll
copyFileSync(dllPath, join(publishDir, 'zmo_native.dll'))
copyFileSync(exePath, join(outDir, 'reg-indexer.exe'))

console.log(`runtime 产物已就绪：${outDir}`)

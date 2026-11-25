#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const source = process.argv[2]
const destination = process.argv[3]
if (!source || !destination) {
  throw new Error('用法：node dwg_to_dxf.mjs <source.dwg> <destination.dxf>')
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const vendorRoot = resolve(scriptDir, '..', 'vendor', 'web')
const modulePath = join(vendorRoot, 'dist', 'libredwg-web.js')
const wasmDir = join(vendorRoot, 'wasm')
if (!existsSync(modulePath)) {
  throw new Error('缺少 LibreDWG WASM 运行时，请先执行 pnpm -F @zmo/agent-runtime cad:setup')
}

const { LibreDwg } = await import(pathToFileURL(modulePath).href)
const converter = await LibreDwg.create(`${wasmDir}${process.platform === 'win32' ? '\\' : '/'}`)
const bytes = readFileSync(source)
const dxf = converter.dwg_write_dxf(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
)
if (!dxf || dxf.byteLength < 256) {
  throw new Error('LibreDWG WASM 未生成有效 DXF')
}

mkdirSync(dirname(destination), { recursive: true })
const temporary = `${destination}.tmp-${process.pid}`
try {
  writeFileSync(temporary, dxf)
  rmSync(destination, { force: true })
  renameSync(temporary, destination)
} finally {
  rmSync(temporary, { force: true })
}

process.stdout.write(`LibreDWG WASM 转换完成：${dxf.byteLength} bytes\n`)

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { ModelPreviewResult } from '@shared/ipc'

const GL_ARRAY_BUFFER = 34962
const GL_ELEMENT_ARRAY_BUFFER = 34963
const GL_FLOAT = 5126
const GL_UNSIGNED_INT = 5125

const pad4 = (n: number): number => (4 - (n % 4)) % 4

function srgbToLinear(v: number): number {
  const x = Math.min(Math.max(v, 0), 255) / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}

function computeBounds(pos: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const val = pos[i + k]
      if (val < min[k]) min[k] = val
      if (val > max[k]) max[k] = val
    }
  }
  return { min, max }
}

interface RawMeshInput {
  positions: Float32Array
  normals?: Float32Array
  indices: Uint32Array
  material: number
  name?: string
  extras?: Record<string, unknown>
}

interface RawMatInput {
  name?: string
  baseColor: [number, number, number, number]
  metallic?: number
  roughness?: number
}

function packGlb(jsonObj: Record<string, unknown>, binBuf: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(jsonObj))
  const jsonLen = jsonBytes.byteLength + pad4(jsonBytes.byteLength)
  const binLen = binBuf.byteLength + pad4(binBuf.byteLength)
  const totalLen = 20 + jsonLen + (binLen ? 8 + binLen : 0)

  const out = new Uint8Array(totalLen)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true) // 'glTF'
  dv.setUint32(4, 2, true)
  dv.setUint32(8, totalLen, true)
  dv.setUint32(12, jsonLen, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(jsonBytes, 20)
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLen)

  if (binLen > 0) {
    dv.setUint32(20 + jsonLen, binLen, true)
    dv.setUint32(24 + jsonLen, 0x004e4942, true) // 'BIN\0'
    out.set(binBuf, 28 + jsonLen)
  }
  return out
}

function unpackGlb(glb: Uint8Array): { json: Record<string, any>; bin: Uint8Array } {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  if (glb.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) {
    throw new Error('不是有效的 GLB 文件')
  }
  const jsonLen = dv.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)))
  const binOffset = 20 + jsonLen
  const bin =
    binOffset + 8 <= glb.byteLength && dv.getUint32(binOffset + 4, true) === 0x004e4942
      ? glb.subarray(binOffset + 8, binOffset + 8 + dv.getUint32(binOffset, true))
      : new Uint8Array()
  return { json, bin }
}

function buildGlbFromMeshes(meshesIn: RawMeshInput[], materialsIn: RawMatInput[]): Uint8Array {
  const chunks: Uint8Array[] = []
  const bufferViews: Array<Record<string, unknown>> = []
  const accessors: Array<Record<string, unknown>> = []
  let byteOffset = 0

  const pushView = (arr: Float32Array | Uint32Array, target: number): number => {
    const pad = pad4(byteOffset)
    if (pad) {
      chunks.push(new Uint8Array(pad))
      byteOffset += pad
    }
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: bytes.byteLength,
      target
    })
    chunks.push(bytes)
    byteOffset += bytes.byteLength
    return bufferViews.length - 1
  }

  const gltfMeshes: Array<Record<string, unknown>> = []
  const gltfNodes: Array<Record<string, unknown>> = []

  for (const item of meshesIn) {
    if (item.positions.length < 9 || item.indices.length < 3) continue
    const { min, max } = computeBounds(item.positions)
    accessors.push({
      bufferView: pushView(item.positions, GL_ARRAY_BUFFER),
      componentType: GL_FLOAT,
      count: item.positions.length / 3,
      type: 'VEC3',
      min,
      max
    })
    const attributes: Record<string, number> = { POSITION: accessors.length - 1 }

    if (item.normals && item.normals.length === item.positions.length) {
      accessors.push({
        bufferView: pushView(item.normals, GL_ARRAY_BUFFER),
        componentType: GL_FLOAT,
        count: item.normals.length / 3,
        type: 'VEC3'
      })
      attributes.NORMAL = accessors.length - 1
    }

    accessors.push({
      bufferView: pushView(item.indices, GL_ELEMENT_ARRAY_BUFFER),
      componentType: GL_UNSIGNED_INT,
      count: item.indices.length,
      type: 'SCALAR'
    })

    gltfMeshes.push({
      primitives: [
        {
          attributes,
          indices: accessors.length - 1,
          material: item.material
        }
      ]
    })

    gltfNodes.push({
      mesh: gltfMeshes.length - 1,
      ...(item.name ? { name: item.name } : {}),
      ...(item.extras && Object.keys(item.extras).length ? { extras: item.extras } : {})
    })
  }

  const binCombined = new Uint8Array(byteOffset)
  let ptr = 0
  for (const c of chunks) {
    binCombined.set(c, ptr)
    ptr += c.byteLength
  }

  const gltfJson = {
    asset: { version: '2.0', generator: 'design-agent model preview' },
    scene: 0,
    scenes: [{ nodes: gltfNodes.map((_, idx) => idx) }],
    nodes: gltfNodes,
    meshes: gltfMeshes,
    materials: materialsIn.map((m) => ({
      ...(m.name ? { name: m.name } : {}),
      pbrMetallicRoughness: {
        baseColorFactor: m.baseColor,
        metallicFactor: m.metallic ?? 0,
        roughnessFactor: m.roughness ?? 0.8
      },
      ...(m.baseColor[3] < 1 ? { alphaMode: 'BLEND' } : {})
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: byteOffset }]
  }

  return packGlb(gltfJson, binCombined)
}

/** 对齐原版 modelPreviewWorker.js：修复 openskp 导出的 UV V 轴翻转 */
function flipGlbTexcoordV(rawGlb: Uint8Array): Uint8Array {
  const { json, bin } = unpackGlb(rawGlb.slice())
  const texAccessors = new Set<number>()
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const [attrName, accIdx] of Object.entries(prim.attributes ?? {})) {
        if (attrName.startsWith('TEXCOORD_') && typeof accIdx === 'number') {
          texAccessors.add(accIdx)
        }
      }
    }
  }
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  for (const accIdx of texAccessors) {
    const acc = json.accessors?.[accIdx]
    if (!acc || acc.componentType !== GL_FLOAT || acc.type !== 'VEC2' || acc.bufferView === undefined) continue
    const bv = json.bufferViews?.[acc.bufferView]
    if (!bv || (bv.buffer ?? 0) !== 0) continue
    const stride = bv.byteStride || 8
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0) + 4
    for (let k = 0; k < acc.count; k++) {
      const off = base + k * stride
      dv.setFloat32(off, 1 - dv.getFloat32(off, true), true)
    }
    if (acc.min && acc.max) {
      const [minV, maxV] = [acc.min[1], acc.max[1]]
      acc.min[1] = 1 - maxV
      acc.max[1] = 1 - minV
    }
  }
  return packGlb(json, bin)
}

function findLocalBlenderExe(): string | null {
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]
    for (const r of roots) {
      const bf = join(r, 'Blender Foundation')
      if (!existsSync(bf)) continue
      try {
        for (const sub of readdirSync(bf).reverse()) {
          const exe = join(bf, sub, 'blender.exe')
          if (existsSync(exe)) return exe
        }
      } catch {
        // ignore
      }
    }
  }
  return null
}

const ASSIMP_EXTS = new Set(['fbx', 'obj', 'dae', '3ds', 'stl', 'ply'])

export class ModelPreviewService {
  constructor(private readonly cacheDir: string) {
    mkdirSync(this.cacheDir, { recursive: true })
  }

  async prepare(filePath: string): Promise<ModelPreviewResult> {
    try {
      if (!existsSync(filePath)) return { ok: false, error: '模型文件不存在' }
      const st = statSync(filePath)
      if (st.size > 180 * 1024 * 1024) {
        return { ok: false, error: '模型体积较大（>180MB），建议使用本机三维软件直接打开' }
      }

      const ext = extname(filePath).toLowerCase().replace(/^\./, '')
      if (ext === 'max') {
        return { ok: false, error: '.max 为 3ds Max 专有格式，不支持离线网格提取，请点击右上角用本机 3ds Max 打开' }
      }

      if (ext === 'glb') {
        const bytes = readFileSync(filePath)
        return { ok: true, glbBase64: bytes.toString('base64'), detail: 'native-glb' }
      }

      const key = createHash('sha256')
        .update(`${filePath}:${st.size}:${Math.floor(st.mtimeMs)}`)
        .digest('hex')
        .slice(0, 20)
      const cachedGlbPath = join(this.cacheDir, `${key}.glb`)

      if (existsSync(cachedGlbPath) && statSync(cachedGlbPath).size > 32) {
        return {
          ok: true,
          glbBase64: readFileSync(cachedGlbPath).toString('base64'),
          detail: 'cached'
        }
      }

      if (ext === 'skp') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const openskp = require('openskp') as {
          SkpFile: { open: (p: string) => { buildInstancedScene: () => unknown } }
          toInstancedGLB: (scene: unknown, opts: { textures: boolean }) => Uint8Array
        }
        const raw = openskp.toInstancedGLB(openskp.SkpFile.open(filePath).buildInstancedScene(), {
          textures: true
        })
        const fixed = flipGlbTexcoordV(raw)
        writeFileSync(cachedGlbPath, fixed)
        return { ok: true, glbBase64: Buffer.from(fixed).toString('base64'), detail: 'openskp' }
      }

      if (ext === '3dm') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const rhino3dmInit = require('rhino3dm')
        const initFn = typeof rhino3dmInit === 'function' ? rhino3dmInit : rhino3dmInit.default
        const rhino = await initFn()
        const doc = rhino.File3dm.fromByteArray(new Uint8Array(readFileSync(filePath)))
        if (!doc) throw new Error('无法解析 .3dm 文件')

        const layers = doc.layers()
        const materials = doc.materials()
        const outMats: RawMatInput[] = []
        const matCache = new Map<string, number>()

        const resolveMat = (attrs: any): number => {
          const fromObj =
            attrs.materialSource === rhino.ObjectMaterialSource.MaterialFromObject &&
            attrs.materialIndex >= 0 &&
            attrs.materialIndex < materials.count
          const mKey = fromObj ? `m${attrs.materialIndex}` : `l${attrs.layerIndex}`
          if (matCache.has(mKey)) return matCache.get(mKey)!
          let mItem: RawMatInput
          if (fromObj) {
            const m = materials.get(attrs.materialIndex)
            const pbr = m.physicallyBased()
            mItem = pbr.supported
              ? {
                  name: m.name,
                  baseColor: [pbr.baseColor.r, pbr.baseColor.g, pbr.baseColor.b, pbr.opacity ?? 1],
                  metallic: pbr.metallic,
                  roughness: pbr.roughness
                }
              : {
                  name: m.name,
                  baseColor: [
                    srgbToLinear(m.diffuseColor.r),
                    srgbToLinear(m.diffuseColor.g),
                    srgbToLinear(m.diffuseColor.b),
                    1 - (m.transparency || 0)
                  ]
                }
          } else {
            const lyr = attrs.layerIndex >= 0 && attrs.layerIndex < layers.count ? layers.get(attrs.layerIndex) : null
            const col = lyr?.color ?? { r: 200, g: 200, b: 200, a: 255 }
            mItem = {
              name: lyr?.fullPath,
              baseColor: [srgbToLinear(col.r), srgbToLinear(col.g), srgbToLinear(col.b), 1]
            }
          }
          outMats.push(mItem)
          matCache.set(mKey, outMats.length - 1)
          return outMats.length - 1
        }

        const outMeshes: RawMeshInput[] = []
        const objects = doc.objects()
        for (let idx = 0; idx < objects.count; idx++) {
          const obj = objects.get(idx)
          const geom = obj.geometry()
          const rMeshes: any[] = []
          if (geom.objectType === rhino.ObjectType.Mesh) {
            rMeshes.push(geom)
          } else if (geom.objectType === rhino.ObjectType.Brep && geom.faces) {
            const faces = geom.faces()
            for (let f = 0; f < faces.count; f++) {
              const fm = faces.get(f).getMesh(rhino.MeshType.Any)
              if (fm) rMeshes.push(fm)
            }
          } else if (
            (geom.objectType === rhino.ObjectType.Extrusion || geom.objectType === rhino.ObjectType.SubD) &&
            geom.getMesh
          ) {
            const gm = geom.getMesh(rhino.MeshType.Any)
            if (gm) rMeshes.push(gm)
          }
          if (rMeshes.length === 0) continue

          const bufs = rMeshes.map((rm) => rm.toThreejsBuffers(true))
          const posLen = bufs.reduce((s, b) => s + b.position.length, 0)
          const idxLen = bufs.reduce((s, b) => s + (b.index?.length ?? b.position.length / 3), 0)
          if (!posLen || !idxLen) continue

          const positions = new Float32Array(posLen)
          const hasNorms = bufs.every((b) => b.normal?.length === b.position.length)
          const normals = hasNorms ? new Float32Array(posLen) : undefined
          const indices = new Uint32Array(idxLen)
          let pOff = 0
          let iOff = 0
          for (const b of bufs) {
            const vBase = pOff / 3
            positions.set(b.position, pOff)
            if (normals && b.normal) normals.set(b.normal, pOff)
            if (b.index) {
              for (let q = 0; q < b.index.length; q++) indices[iOff + q] = b.index[q] + vBase
              iOff += b.index.length
            } else {
              const cnt = b.position.length / 3
              for (let q = 0; q < cnt; q++) indices[iOff + q] = vBase + q
              iOff += cnt
            }
            pOff += b.position.length
          }

          const attrs = obj.attributes()
          const lyr = attrs.layerIndex >= 0 && attrs.layerIndex < layers.count ? layers.get(attrs.layerIndex) : null
          outMeshes.push({
            positions,
            normals,
            indices,
            material: resolveMat(attrs),
            name: attrs.name || lyr?.name || `Object_${idx + 1}`,
            extras: lyr ? { layer: lyr.fullPath } : undefined
          })
        }

        if (outMeshes.length === 0) {
          return { ok: false, error: '该 .3dm 文件未包含渲染网格缓存（请在 Rhino 中切换着色模式保存后再试）' }
        }
        const glb = buildGlbFromMeshes(outMeshes, outMats)
        writeFileSync(cachedGlbPath, glb)
        return { ok: true, glbBase64: Buffer.from(glb).toString('base64'), detail: `rhino3dm (${outMeshes.length} nodes)` }
      }

      if (ASSIMP_EXTS.has(ext) || ext === 'gltf') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const assimpInit = require('assimpjs')
        const initFn = typeof assimpInit === 'function' ? assimpInit : assimpInit.default
        const ajs = await initFn()
        const dir = dirname(filePath)
        const mainBytes = new Uint8Array(readFileSync(filePath))
        const fileList = new ajs.FileList()
        fileList.AddFile(basename(filePath), mainBytes)

        if (ext === 'obj') {
          const txt = new TextDecoder().decode(mainBytes)
          for (const line of txt.split(/\r?\n/)) {
            const m = /^\s*mtllib\s+(.+?)\s*$/.exec(line)
            if (m) {
              const mtlPath = isAbsolute(m[1]) ? m[1] : resolve(dir, m[1].trim())
              if (existsSync(mtlPath)) {
                fileList.AddFile(m[1].trim(), new Uint8Array(readFileSync(mtlPath)))
              }
            }
          }
        }

        const res = ajs.ConvertFileList(fileList, 'glb2')
        if (!res.IsSuccess() || res.FileCount() === 0) {
          throw new Error(`Assimp 转换失败：${res.GetErrorCode() || '不支持的子格式'}`)
        }
        const glbContent: Uint8Array = res.GetFile(0).GetContent()
        writeFileSync(cachedGlbPath, glbContent)
        return { ok: true, glbBase64: Buffer.from(glbContent).toString('base64'), detail: 'assimpjs' }
      }

      if (ext === 'blend') {
        const blenderExe = findLocalBlenderExe()
        if (!blenderExe) {
          return { ok: false, error: '预览 .blend 需要本机已安装 Blender' }
        }
        const expr = [
          'import bpy, sys',
          "out = sys.argv[sys.argv.index('--') + 1]",
          "bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_apply=True, export_cameras=False, export_lights=False)"
        ].join('\n')
        await new Promise<void>((resB, rejB) => {
          execFile(
            blenderExe,
            ['-b', '--factory-startup', '-Y', filePath, '--python-expr', expr, '--', cachedGlbPath],
            { timeout: 60000, windowsHide: true },
            (err) => (err ? rejB(err) : resB())
          )
        })
        return { ok: true, glbBase64: readFileSync(cachedGlbPath).toString('base64'), detail: 'blender-cli' }
      }

      return { ok: false, error: `暂不支持直接三维预览 .${ext} 格式` }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }
}

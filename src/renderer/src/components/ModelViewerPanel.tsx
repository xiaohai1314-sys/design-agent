import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  Box,
  Grid3X3,
  Info,
  ListTree,
  LoaderCircle,
  MapPinPlus,
  MessageSquarePlus,
  RotateCcw,
  Ruler,
  Scissors,
  Search,
  Trash2
} from 'lucide-react'
import clsx from 'clsx'
import type { ModelAnnotationRef } from '@shared/protocol'

interface ModelPointAnnotation {
  id: string
  objectName: string
  point: [number, number, number]
  note: string
}

interface TreeNodeItem {
  uuid: string
  name: string
  visible: boolean
}

interface ModelViewerPanelProps {
  filePath: string
  title: string
  onAttachAnnotations: (ref: ModelAnnotationRef) => void
}

export const ModelViewerPanel: React.FC<ModelViewerPanelProps> = ({
  filePath,
  title,
  onAttachAnnotations
}) => {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [glbBase64, setGlbBase64] = useState<string | null>(null)

  const [wireframe, setWireframe] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [annotateMode, setAnnotateMode] = useState(false)
  const [measureMode, setMeasureMode] = useState(false)
  const [clipEnabled, setClipEnabled] = useState(false)
  const [clipAxis, setClipAxis] = useState<'x' | 'y' | 'z'>('y')
  const [clipFlip, setClipFlip] = useState(false)
  const [clipOffset, setClipOffset] = useState(0)
  const [measurePts, setMeasurePts] = useState<Array<[number, number, number]>>([])
  const [treeOpen, setTreeOpen] = useState(false)
  const [treeSearch, setTreeSearch] = useState('')
  const [infoOpen, setInfoOpen] = useState(false)

  const [treeNodes, setTreeNodes] = useState<TreeNodeItem[]>([])
  const [stats, setStats] = useState<{
    meshes: number
    triangles: number
    size: [number, number, number]
  } | null>(null)

  const [pendingPin, setPendingPin] = useState<{
    objectName: string
    point: [number, number, number]
  } | null>(null)
  const [pinNote, setPinNote] = useState('')
  const [annotations, setAnnotations] = useState<ModelPointAnnotation[]>([])

  const mountRef = useRef<HTMLDivElement | null>(null)
  const sceneObjectsMapRef = useRef<Map<string, THREE.Object3D>>(new Map())
  const gridRef = useRef<THREE.GridHelper | null>(null)
  const resetCamRef = useRef<(() => void) | null>(null)
  const focusObjRef = useRef<((uuid: string) => void) | null>(null)
  const markersGroupRef = useRef<THREE.Group | null>(null)
  const measureGroupRef = useRef<THREE.Group | null>(null)
  const clipPlaneRef = useRef<THREE.Plane>(new THREE.Plane(new THREE.Vector3(0, -1, 0), 10000))
  const modelBoundsRef = useRef<{ center: [number, number, number]; size: [number, number, number] } | null>(null)
  const annotateModeRef = useRef(annotateMode)
  annotateModeRef.current = annotateMode
  const measureModeRef = useRef(measureMode)
  measureModeRef.current = measureMode

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setGlbBase64(null)
    setAnnotations([])
    setPendingPin(null)

    window.zmo.modelPreview
      .prepare(filePath)
      .then((res) => {
        if (cancelled) return
        if (!res.ok || !res.glbBase64) {
          setError(res.error || '无法生成三维预览')
        } else {
          setGlbBase64(res.glbBase64)
        }
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [filePath])

  useEffect(() => {
    const container = mountRef.current
    if (!container || !glbBase64) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#181a1f')

    const camera = new THREE.PerspectiveCamera(
      45,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.01,
      100000
    )

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(container.clientWidth, container.clientHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.localClippingEnabled = true
    container.innerHTML = ''
    container.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444455, 1.1)
    scene.add(hemiLight)
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.2)
    dirLight1.position.set(10, 20, 15)
    scene.add(dirLight1)
    const dirLight2 = new THREE.DirectionalLight(0xdbeafe, 0.55)
    dirLight2.position.set(-12, -8, -10)
    scene.add(dirLight2)

    const markersGroup = new THREE.Group()
    scene.add(markersGroup)
    markersGroupRef.current = markersGroup
    const measureGroup = new THREE.Group()
    scene.add(measureGroup)
    measureGroupRef.current = measureGroup

    // Base64 -> ArrayBuffer
    const binaryStr = atob(glbBase64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)

    const loader = new GLTFLoader()
    let modelRoot: THREE.Group | null = null

    loader.parse(
      bytes.buffer,
      '',
      (gltf) => {
        modelRoot = gltf.scene
        scene.add(modelRoot)

        const box = new THREE.Box3().setFromObject(modelRoot)
        const size = box.getSize(new THREE.Vector3())
        const center = box.getCenter(new THREE.Vector3())
        const maxDim = Math.max(size.x, size.y, size.z, 0.1)

        const gridSize = Math.pow(10, Math.ceil(Math.log10(maxDim * 2)))
        const grid = new THREE.GridHelper(gridSize, 20, 0x4b5563, 0x27272a)
        grid.position.set(center.x, box.min.y, center.z)
        scene.add(grid)
        gridRef.current = grid

        const fitCamera = (): void => {
          const dist = maxDim * 1.75
          camera.near = Math.max(0.001, maxDim / 2000)
          camera.far = Math.max(1000, maxDim * 100)
          camera.position.set(center.x + dist, center.y + dist * 0.75, center.z + dist)
          camera.updateProjectionMatrix()
          controls.target.copy(center)
          controls.update()
        }
        fitCamera()
        resetCamRef.current = fitCamera
        modelBoundsRef.current = {
          center: [center.x, center.y, center.z],
          size: [size.x, size.y, size.z]
        }
        focusObjRef.current = (uuid: string) => {
          const obj = sceneObjectsMapRef.current.get(uuid)
          if (!obj) return
          const ob = new THREE.Box3().setFromObject(obj)
          const oc = ob.getCenter(new THREE.Vector3())
          const os = ob.getSize(new THREE.Vector3())
          const d = Math.max(os.x, os.y, os.z, 0.2) * 2.2
          camera.position.set(oc.x + d, oc.y + d * 0.75, oc.z + d)
          controls.target.copy(oc)
          controls.update()
        }

        let meshCount = 0
        let triCount = 0
        const objMap = new Map<string, THREE.Object3D>()
        const nodes: TreeNodeItem[] = []

        modelRoot.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh) {
            meshCount++
            const mesh = obj as THREE.Mesh
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
            for (const m of mats) {
              if (m) {
                m.clippingPlanes = [clipPlaneRef.current]
                m.clipShadows = true
              }
            }
            const geom = mesh.geometry
            if (geom.index) triCount += geom.index.count / 3
            else if (geom.attributes.position) triCount += geom.attributes.position.count / 3
            objMap.set(mesh.uuid, mesh)
            nodes.push({
              uuid: mesh.uuid,
              name: mesh.name || `构件_${meshCount}`,
              visible: mesh.visible
            })
          }
        })

        sceneObjectsMapRef.current = objMap
        setTreeNodes(nodes.slice(0, 200))
        setStats({
          meshes: meshCount,
          triangles: Math.round(triCount),
          size: [
            Number(size.x.toFixed(2)),
            Number(size.y.toFixed(2)),
            Number(size.z.toFixed(2))
          ]
        })
      },
      (err) => {
        setError(`GLB 渲染解析失败：${err instanceof Error ? err.message : String(err)}`)
      }
    )

    // Raycaster 打点批注拾取
    const raycaster = new THREE.Raycaster()
    let downPos = { x: 0, y: 0 }

    const onPointerDown = (e: PointerEvent): void => {
      downPos = { x: e.clientX, y: e.clientY }
    }

    const onPointerUp = (e: PointerEvent): void => {
      if ((!annotateModeRef.current && !measureModeRef.current) || !modelRoot) return
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 4) return
      const rect = renderer.domElement.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      )
      raycaster.setFromCamera(ndc, camera)
      const hits = raycaster.intersectObject(modelRoot, true)
      if (hits.length > 0) {
        const hit = hits[0]
        const p = hit.point
        const pt: [number, number, number] = [
          Number(p.x.toFixed(3)),
          Number(p.y.toFixed(3)),
          Number(p.z.toFixed(3))
        ]
        if (measureModeRef.current) {
          setMeasurePts((prev) => (prev.length >= 2 ? [pt] : [...prev, pt]))
        } else if (annotateModeRef.current) {
          setPendingPin({
            objectName: hit.object.name || '未命名构件',
            point: pt
          })
        }
      }
    }

    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointerup', onPointerUp)

    const ro = new ResizeObserver(() => {
      if (!container) return
      const w = Math.max(1, container.clientWidth)
      const h = Math.max(1, container.clientHeight)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    })
    ro.observe(container)

    let rafId = 0
    const animate = (): void => {
      rafId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      controls.dispose()
      renderer.dispose()
    }
  }, [glbBase64])

  // 同步线框开关
  useEffect(() => {
    for (const obj of sceneObjectsMapRef.current.values()) {
      const mesh = obj as THREE.Mesh
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if (m && 'wireframe' in m) {
          ;(m as THREE.MeshStandardMaterial).wireframe = wireframe
        }
      }
    }
  }, [wireframe])

  // 同步地面网格开关
  useEffect(() => {
    if (gridRef.current) gridRef.current.visible = showGrid
  }, [showGrid])

  // 同步三维实时剖切面
  useEffect(() => {
    const plane = clipPlaneRef.current
    if (!clipEnabled || !modelBoundsRef.current) {
      plane.set(new THREE.Vector3(0, -1, 0), 1e6)
      return
    }
    const sign = clipFlip ? 1 : -1
    const normal =
      clipAxis === 'x'
        ? new THREE.Vector3(sign, 0, 0)
        : clipAxis === 'y'
          ? new THREE.Vector3(0, sign, 0)
          : new THREE.Vector3(0, 0, sign)
    const idx = clipAxis === 'x' ? 0 : clipAxis === 'y' ? 1 : 2
    const c = modelBoundsRef.current.center[idx]
    const s = Math.max(modelBoundsRef.current.size[idx], 0.5)
    const worldPos = c + clipOffset * (s * 0.55)
    plane.set(normal, -sign * worldPos)
  }, [clipEnabled, clipAxis, clipFlip, clipOffset, glbBase64])

  // 同步三维两点测距线段
  useEffect(() => {
    const mg = measureGroupRef.current
    if (!mg) return
    mg.clear()
    if (measurePts.length === 0) return
    const r = stats ? Math.max(...stats.size) * 0.012 : 0.08
    const sphereGeo = new THREE.SphereGeometry(Math.max(0.015, r), 12, 12)
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0xf97316 })
    for (const pt of measurePts) {
      const sp = new THREE.Mesh(sphereGeo, sphereMat)
      sp.position.set(pt[0], pt[1], pt[2])
      mg.add(sp)
    }
    if (measurePts.length === 2) {
      const pts = [new THREE.Vector3(...measurePts[0]), new THREE.Vector3(...measurePts[1])]
      const lineGeo = new THREE.BufferGeometry().setFromPoints(pts)
      const lineMat = new THREE.LineBasicMaterial({ color: 0xf97316 })
      mg.add(new THREE.Line(lineGeo, lineMat))
    }
  }, [measurePts, stats])

  // 在三维空间同步渲染红色打点球标
  useEffect(() => {
    const group = markersGroupRef.current
    if (!group) return
    group.clear()
    const radius = stats ? Math.max(...stats.size) * 0.015 : 0.1
    const geom = new THREE.SphereGeometry(Math.max(0.02, radius), 16, 16)
    const mat = new THREE.MeshBasicMaterial({ color: 0x3b82f6 })
    for (const ann of annotations) {
      const sp = new THREE.Mesh(geom, mat)
      sp.position.set(ann.point[0], ann.point[1], ann.point[2])
      group.add(sp)
    }
  }, [annotations, stats])

  const confirmPinAnnotation = (): void => {
    if (!pendingPin || !pinNote.trim()) return
    setAnnotations((prev) => [
      ...prev,
      {
        id: `3d_ann_${Date.now()}`,
        objectName: pendingPin.objectName,
        point: pendingPin.point,
        note: pinNote.trim()
      }
    ])
    setPendingPin(null)
    setPinNote('')
    setAnnotateMode(false)
  }

  const attachToChat = (): void => {
    if (annotations.length === 0) return
    const lines = annotations.map(
      (a, i) =>
        `${i + 1}. 构件「${a.objectName}」三维坐标 (${a.point[0]}, ${a.point[1]}, ${a.point[2]})：${a.note}`
    )
    onAttachAnnotations({
      title,
      path: filePath,
      count: annotations.length,
      text: lines.join('\n')
    })
  }

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-xs text-zinc-500">
        <LoaderCircle className="w-5 h-5 animate-spin text-blue-600" />
        <span>正在转换三维模型网格并构建 WebGL 场景…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center gap-2">
        <p className="text-xs text-rose-600 font-medium">{error}</p>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      {/* 顶部三维工具条 */}
      <div className="flex items-center justify-between gap-1 px-2 py-1.5 rounded-xl bg-zinc-900 text-zinc-200 text-[11px]">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setMeasureMode(false)
              setAnnotateMode(!annotateMode)
            }}
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer',
              annotateMode ? 'bg-blue-600 text-white' : 'hover:bg-zinc-800'
            )}
          >
            <MapPinPlus className="w-3.5 h-3.5" />
            <span>打点批注</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setAnnotateMode(false)
              setMeasureMode(!measureMode)
              setMeasurePts([])
            }}
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer',
              measureMode ? 'bg-orange-600 text-white' : 'hover:bg-zinc-800'
            )}
          >
            <Ruler className="w-3.5 h-3.5" />
            <span>测距</span>
          </button>
          <button
            type="button"
            onClick={() => setClipEnabled(!clipEnabled)}
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer',
              clipEnabled ? 'bg-amber-600 text-white' : 'hover:bg-zinc-800'
            )}
          >
            <Scissors className="w-3.5 h-3.5" />
            <span>剖切</span>
          </button>
          <button
            type="button"
            onClick={() => setWireframe(!wireframe)}
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer',
              wireframe ? 'bg-zinc-700 text-white' : 'hover:bg-zinc-800'
            )}
          >
            <Box className="w-3.5 h-3.5" />
            <span>线框</span>
          </button>
          <button
            type="button"
            onClick={() => setShowGrid(!showGrid)}
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer',
              showGrid ? 'text-emerald-400 bg-zinc-800' : 'text-zinc-400 hover:bg-zinc-800'
            )}
          >
            <Grid3X3 className="w-3.5 h-3.5" />
            <span>网格</span>
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTreeOpen(!treeOpen)}
            className={clsx(
              'inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer',
              treeOpen ? 'bg-zinc-700 text-white' : 'hover:bg-zinc-800'
            )}
          >
            <ListTree className="w-3.5 h-3.5" />
            <span>构件树</span>
          </button>
          <button
            type="button"
            onClick={() => setInfoOpen(!infoOpen)}
            className="p-1 rounded-md hover:bg-zinc-800 cursor-pointer"
            title="模型尺寸与面数统计"
          >
            <Info className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => resetCamRef.current?.()}
            className="p-1 rounded-md hover:bg-zinc-800 cursor-pointer"
            title="重置视角"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Three.js 视口 */}
      <div className="relative flex-1 min-h-[320px] rounded-xl overflow-hidden border border-zinc-800 bg-[#181a1f]">
        <div
          ref={mountRef}
          className={clsx('w-full h-full', annotateMode ? 'cursor-crosshair' : 'cursor-grab')}
        />

        {annotateMode && !pendingPin && (
          <div className="absolute left-2.5 top-2.5 px-2.5 py-1 rounded-lg bg-blue-600/90 text-white text-[11px] pointer-events-none">
            请直接点击三维模型表面添加批注点
          </div>
        )}

        {measureMode && (
          <div className="absolute left-2.5 top-2.5 rounded-lg bg-zinc-900/95 border border-orange-500/60 px-2.5 py-1.5 text-[11px] text-orange-200 space-y-0.5">
            {measurePts.length === 0 ? (
              <span>在模型表面依次点击两个点进行测距</span>
            ) : measurePts.length === 1 ? (
              <span>已选第 1 点，请点击第 2 点</span>
            ) : (
              <div className="flex items-center gap-2">
                <span className="font-semibold text-orange-400">
                  直线距离：
                  {Math.hypot(
                    measurePts[1][0] - measurePts[0][0],
                    measurePts[1][1] - measurePts[0][1],
                    measurePts[1][2] - measurePts[0][2]
                  ).toFixed(3)}{' '}
                  m
                </span>
                <button
                  type="button"
                  onClick={() => setMeasurePts([])}
                  className="text-[10px] underline text-zinc-300 cursor-pointer"
                >
                  重测
                </button>
              </div>
            )}
          </div>
        )}

        {clipEnabled && (
          <div className="absolute left-2.5 bottom-2.5 rounded-xl bg-zinc-900/95 border border-amber-500/50 px-3 py-2 text-[11px] text-zinc-200 shadow-lg flex items-center gap-2">
            <span className="text-amber-400 font-semibold">剖切轴</span>
            {(['x', 'y', 'z'] as const).map((ax) => (
              <button
                key={ax}
                type="button"
                onClick={() => setClipAxis(ax)}
                className={clsx(
                  'px-1.5 py-0.5 rounded uppercase font-mono cursor-pointer',
                  clipAxis === ax ? 'bg-amber-600 text-white' : 'bg-zinc-800 text-zinc-400'
                )}
              >
                {ax}
              </button>
            ))}
            <input
              type="range"
              min={-1}
              max={1}
              step={0.02}
              value={clipOffset}
              onChange={(e) => setClipOffset(Number(e.target.value))}
              className="w-24 accent-amber-500"
            />
            <button
              type="button"
              onClick={() => setClipFlip(!clipFlip)}
              className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] cursor-pointer"
            >
              翻转
            </button>
          </div>
        )}

        {infoOpen && stats && (
          <div className="absolute left-2.5 bottom-2.5 rounded-xl bg-zinc-900/95 border border-zinc-700 p-2.5 text-[11px] text-zinc-200 space-y-1 shadow-lg">
            <div>构件数量：{stats.meshes}</div>
            <div>三角面数：{stats.triangles.toLocaleString()}</div>
            <div className="font-mono text-[10px] text-zinc-400">
              尺寸：{stats.size[0]} × {stats.size[1]} × {stats.size[2]}
            </div>
          </div>
        )}

        {treeOpen && (
          <div className="absolute right-2 top-2 bottom-2 w-56 rounded-xl bg-zinc-900/95 border border-zinc-700 p-2 flex flex-col shadow-xl">
            <div className="flex items-center justify-between text-[11px] font-semibold text-zinc-300 pb-1.5 mb-1.5 border-b border-zinc-800">
              <span>模型构件 ({treeNodes.length})</span>
              <button
                type="button"
                onClick={() => {
                  for (const obj of sceneObjectsMapRef.current.values()) obj.visible = true
                  setTreeNodes((prev) => prev.map((x) => ({ ...x, visible: true })))
                }}
                className="text-[10px] text-blue-400 hover:underline font-normal cursor-pointer"
              >
                全部显示
              </button>
            </div>
            <div className="relative mb-1.5">
              <Search className="w-3 h-3 text-zinc-500 absolute left-2 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={treeSearch}
                onChange={(e) => setTreeSearch(e.target.value)}
                placeholder="搜索构件…"
                className="w-full pl-6 pr-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-[11px] text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex-1 overflow-y-auto space-y-0.5">
              {treeNodes
                .filter((n) =>
                  treeSearch.trim()
                    ? n.name.toLowerCase().includes(treeSearch.trim().toLowerCase())
                    : true
                )
                .map((n) => (
                  <div
                    key={n.uuid}
                    className="group flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-zinc-800 text-[11px] text-zinc-200"
                  >
                    <label className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={n.visible}
                        onChange={(e) => {
                          const obj = sceneObjectsMapRef.current.get(n.uuid)
                          if (obj) obj.visible = e.target.checked
                          setTreeNodes((prev) =>
                            prev.map((x) =>
                              x.uuid === n.uuid ? { ...x, visible: e.target.checked } : x
                            )
                          )
                        }}
                      />
                      <span className="truncate flex-1" onDoubleClick={() => focusObjRef.current?.(n.uuid)}>
                        {n.name}
                      </span>
                    </label>
                    <button
                      type="button"
                      title="单独显示并聚焦"
                      onClick={() => {
                        for (const [uid, obj] of sceneObjectsMapRef.current.entries()) {
                          obj.visible = uid === n.uuid
                        }
                        setTreeNodes((prev) => prev.map((x) => ({ ...x, visible: x.uuid === n.uuid })))
                        focusObjRef.current?.(n.uuid)
                      }}
                      className="opacity-0 group-hover:opacity-100 text-[10px] text-blue-400 hover:underline cursor-pointer shrink-0"
                    >
                      聚焦
                    </button>
                  </div>
                ))}
            </div>
          </div>
        )}

        {pendingPin && (
          <div className="absolute inset-x-3 bottom-3 rounded-xl bg-zinc-900/95 border border-blue-500/60 p-2.5 shadow-xl space-y-2">
            <div className="text-[11px] text-blue-300">
              构件「{pendingPin.objectName}」坐标 ({pendingPin.point.join(', ')})：
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                autoFocus
                value={pinNote}
                onChange={(e) => setPinNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmPinAnnotation()
                }}
                placeholder="输入针对该构件的修改意见…"
                className="flex-1 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-white outline-none focus:border-blue-400"
              />
              <button
                type="button"
                onClick={() => setPendingPin(null)}
                className="px-2 py-1.5 text-xs text-zinc-400 hover:text-white cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmPinAnnotation}
                className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-500 cursor-pointer"
              >
                确定
              </button>
            </div>
          </div>
        )}
      </div>

      {annotations.length > 0 && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-2.5 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-blue-900">
              已标记 {annotations.length} 处三维模型批注
            </span>
            <button
              type="button"
              onClick={attachToChat}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 cursor-pointer"
            >
              <MessageSquarePlus className="w-3.5 h-3.5" />
              <span>加入对话</span>
            </button>
          </div>
          <div className="space-y-1 max-h-24 overflow-y-auto">
            {annotations.map((a, idx) => (
              <div key={a.id} className="flex items-center justify-between gap-2 text-[11px] text-zinc-700">
                <span className="truncate">
                  <strong className="text-blue-700">#{idx + 1}</strong> [{a.objectName}] {a.note}
                </span>
                <button
                  type="button"
                  onClick={() => setAnnotations((prev) => prev.filter((x) => x.id !== a.id))}
                  className="text-zinc-400 hover:text-rose-600 cursor-pointer shrink-0"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

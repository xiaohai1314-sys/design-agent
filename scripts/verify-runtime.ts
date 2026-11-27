import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import * as mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { PptProposal, RuntimeInbound, RuntimeOutbound } from '../src/shared/protocol'
import { parsePptxDeck } from '../src/shared/pptParser'
import { applyPptProposalToFile } from '../src/main/pptPatcher'
import { CadPreviewService } from '../src/main/cadService'
import { McpConnectorManager } from '../src/main/mcpManager'
import { ModelPreviewService } from '../src/main/modelService'
import { parseCcSwitchRow, parseCodexTomlConfig, testModelProfileConnection } from '../src/main/ccSwitchService'
import { LocalAppStore } from '../src/main/store'
import {
  FEATURE_CATALOG,
  FEATURE_FORMS,
  composeFeatureSubmission,
  filterFeatures
} from '../src/renderer/src/features/taskForm/compose'
import { buildSystemMessage, offloadLargeToolOutput } from '../src/runtime/checkpoint'
import { applyProfilePatch, emptyProfile, summarizeProfile } from '../src/runtime/projectProfile'
import {
  listFileSnapshots,
  recordImageLineageSnapshot,
  restoreFileSnapshot
} from '../src/shared/fileSnapshots'
import { createLocalRegulationTool } from '../src/runtime/tools/regulationTool'
import {
  buildModelingPresetDirective,
  discoverModelingPresets,
  matchModelingPreset
} from '../src/runtime/presets'
import { selectToolsForSubagentRole } from '../src/runtime/tools/asyncSubagents'
import { createImageTools } from '../src/runtime/tools/imageTools'
import { createDeferredMcpTools, connectMcpServers } from '../src/runtime/tools/mcpBridge'
import { createWorkspaceTools } from '../src/runtime/tools/workspaceTools'

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

// 1x1 有效透明 PNG Base64
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

async function verifyCadAnd3dServices(tempRoot: string, skillsRoot: string): Promise<void> {
  const cadService = new CadPreviewService(join(tempRoot, 'cad-cache'), skillsRoot)
  const sampleDwg = process.env.VERIFY_SAMPLE_DWG || join(tempRoot, 'sample-plan.dwg')

  if (existsSync(sampleDwg)) {
    const dwgRes = await cadService.prepare(sampleDwg)
    if (!dwgRes.ok || !dwgRes.entities || dwgRes.entities.length === 0) {
      throw new Error(`Real DWG parse failed: ${dwgRes.error}`)
    }
    console.log(
      `✅ [CAD Service] Real DWG converted & parsed: ${dwgRes.entityTotal} entities, ${dwgRes.layers?.length} layers`
    )
  } else {
    const testDxf = join(tempRoot, 'sample.dxf')
    writeFileSync(
      testDxf,
      [
        '0', 'SECTION', '2', 'ENTITIES',
        '0', 'LINE', '8', 'WALL', '10', '0', '20', '0', '11', '6000', '21', '0',
        '0', 'CIRCLE', '8', 'FURN', '10', '3000', '20', '2000', '40', '500',
        '0', 'ENDSEC', '0', 'EOF'
      ].join('\n'),
      'utf8'
    )
    const dxfRes = await cadService.prepare(testDxf)
    if (!dxfRes.ok || (dxfRes.entityTotal ?? 0) < 2) {
      throw new Error(`DXF parse failed: ${dxfRes.error}`)
    }
    console.log(`✅ [CAD Service] DXF parsed: ${dxfRes.entityTotal} entities`)
  }

  const modelService = new ModelPreviewService(join(tempRoot, 'model-cache'))
  const sampleObj = join(tempRoot, 'cube.obj')
  writeFileSync(
    sampleObj,
    ['v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'f 1 2 3', 'f 1 3 4'].join('\n'),
    'utf8'
  )
  const modelRes = await modelService.prepare(sampleObj)
  if (!modelRes.ok || !modelRes.glbBase64) {
    throw new Error(`3D OBJ -> GLB conversion failed: ${modelRes.error}`)
  }
  const glbBytes = Buffer.from(modelRes.glbBase64, 'base64')
  if (glbBytes.readUInt32LE(0) !== 0x46546c67) {
    throw new Error('Output is not valid GLB binary header!')
  }
  console.log(`✅ [3D Model Service] OBJ -> GLB converted (${glbBytes.byteLength} bytes, valid glTF magic)`)
}

async function verifyStandaloneMcpManager(tempRoot: string, resourcesRoot: string): Promise<void> {
  const mgr = new McpConnectorManager(join(tempRoot, 'userdata'), resourcesRoot)
  const list = await mgr.listConnectors()
  const names = new Set(list.map((c) => c.name))
  for (const expected of ['sketchup', 'multicad', 'blender', '3dsmax', 'photoshop', 'computer-use', 'rhino']) {
    if (!names.has(expected)) {
      throw new Error(`Standalone McpConnectorManager missing connector: ${expected}`)
    }
  }

  const cuaSpec = mgr.resolveServerSpec('computer-use')
  const cuaConnector = list.find((connector) => connector.name === 'computer-use')
  if (cuaSpec) {
    if (!cuaSpec.command.toLowerCase().endsWith('cua-driver.exe') || cuaSpec.args[0] !== 'mcp') {
      throw new Error(`Unexpected computer-use MCP spec: ${JSON.stringify(cuaSpec)}`)
    }
  } else if (!cuaConnector || cuaConnector.available || cuaConnector.enabled) {
    throw new Error('computer-use is missing its driver but was not reported unavailable')
  } else {
    console.warn('⚠️ [Standalone MCP] computer-use runtime driver is not present; connector is correctly unavailable')
  }

  const suSpec = mgr.resolveServerSpec('sketchup')
  const appData = process.env.APPDATA ?? ''
  const pythonCandidates = [
    join(resourcesRoot, 'runtime', 'python', 'python.exe'),
    join(appData, '@design-agent', 'agent-desktop', 'agent-runtime', 'python', 'python.exe'),
    join(appData, '@design-agent', 'agent-desktop', 'agent-runtime', 'runtime', 'python', 'python.exe')
  ]
  const expectedPython = pythonCandidates.find((candidate) => existsSync(candidate)) ?? 'python'
  if (
    !suSpec ||
    suSpec.command !== expectedPython ||
    !suSpec.args.includes('sketchup_mcp')
  ) {
    throw new Error(`SketchUp MCP did not resolve using the configured Python fallback: ${JSON.stringify(suSpec)}`)
  }
  console.log(
    `✅ [Standalone MCP] Discovered ${list.length} connectors; SketchUp resolver valid; computer-use ${cuaSpec ? 'driver resolved' : 'unavailable without runtime binary'}`
  )
}

async function verifyOfficeLibs(): Promise<void> {
  // Excel XLSX roundtrip + merged cell verification（exceljs 取代已停更的 xlsx）
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('清单一览')
  sheet.addRow(['茶室物料清单', null, '预算汇总'])
  sheet.addRow(['材料名称', '规格', '单价(元)'])
  sheet.addRow(['黑胡桃木饰面', '2440x1220x18', 680])
  sheet.mergeCells('A1:B1')
  const xlsxBuf = (await workbook.xlsx.writeBuffer()) as ArrayBuffer

  const readBack = new ExcelJS.Workbook()
  await readBack.xlsx.load(xlsxBuf)
  const sheetRead = readBack.getWorksheet('清单一览')
  if (!sheetRead) throw new Error('XLSX roundtrip failed')
  const merges = (sheetRead.model?.merges ?? []) as string[]
  if (
    sheetRead.rowCount !== 3 ||
    String(sheetRead.getCell('A3').value ?? '') !== '黑胡桃木饰面' ||
    merges.length === 0
  ) {
    throw new Error('XLSX roundtrip failed')
  }

  // PPTX JSZip slide XML extraction verification
  const zip = new JSZip()
  zip.file(
    'ppt/slides/slide1.xml',
    '<p:sld><p:cSld><p:spTree><p:sp><a:t>方案一：清雅茶室汇报</a:t></p:sp></p:spTree></p:cSld></p:sld>'
  )
  const pptxBytes = await zip.generateAsync({ type: 'uint8array' })
  const loadedZip = await JSZip.loadAsync(pptxBytes)
  const slideXml = await loadedZip.file('ppt/slides/slide1.xml')?.async('string')
  if (!slideXml || !slideXml.includes('方案一：清雅茶室汇报')) {
    throw new Error('PPTX JSZip slide XML readback failed')
  }

  // Mammoth export check
  if (typeof mammoth.convertToHtml !== 'function') {
    throw new Error('mammoth.convertToHtml missing')
  }
  console.log('✅ [Office Libs] exceljs + jszip + mammoth sanity checks passed')

  // DeferredToolFilter (mcp_tools + tool_search) check
  const fakeMcpTools = Array.from({ length: 18 }, (_, i) =>
    new DynamicStructuredTool({
      name: `blender__op_${i}`,
      description: `Blender operation ${i}`,
      schema: z.object({}),
      func: async () => 'ok'
    })
  )
  const activePool: DynamicStructuredTool[] = []
  const deferred = createDeferredMcpTools(fakeMcpTools, activePool)
  activePool.push(...deferred.initialTools)
  if (deferred.initialTools.length !== 2) {
    throw new Error(`Expected 2 deferred proxy tools, got ${deferred.initialTools.length}`)
  }
  await deferred.initialTools[1].invoke({ names: ['blender__op_3'] })
  if (!activePool.some((t) => t.name === 'blender__op_3')) {
    throw new Error('tool_search did not promote blender__op_3 into activePool')
  }
  console.log('✅ [Deferred MCP] mcp_tools + tool_search promotion passed')
}

async function verifyWorkspacePathBoundary(tempRoot: string): Promise<void> {
  // 文件工具只能访问工作区，明确附件仅授予单文件只读权限
  const boundaryRoot = join(tempRoot, 'workspace-boundary')
  const outsideFile = join(tempRoot, 'outside-secret.txt')
  mkdirSync(boundaryRoot, { recursive: true })
  writeFileSync(outsideFile, 'OUTSIDE_SECRET', 'utf8')
  const boundaryTools = createWorkspaceTools({
    rootDir: boundaryRoot,
    signal: new AbortController().signal,
    requireApproval: async () => {},
    recordToolData: () => {},
    onTodosChange: () => {}
  })
  const boundaryLs = boundaryTools.find((tool) => tool.name === 'ls')!
  const boundaryGlob = boundaryTools.find((tool) => tool.name === 'glob')!
  const boundaryGrep = boundaryTools.find((tool) => tool.name === 'grep')!
  const boundaryRead = boundaryTools.find((tool) => tool.name === 'read_file')!
  const boundaryWrite = boundaryTools.find((tool) => tool.name === 'write_file')!
  const boundaryEdit = boundaryTools.find((tool) => tool.name === 'edit_file')!
  for (const outsidePath of ['../outside-secret.txt', outsideFile]) {
    for (const [label, operation] of [
      ['ls', () => boundaryLs.invoke({ path: outsidePath })],
      ['glob', () => boundaryGlob.invoke({ pattern: '*', path: outsidePath })],
      ['grep', () => boundaryGrep.invoke({ pattern: 'OUTSIDE_SECRET', path: outsidePath })],
      ['read_file', () => boundaryRead.invoke({ file_path: outsidePath })],
      [
        'edit_file',
        () =>
          boundaryEdit.invoke({
            file_path: outsidePath,
            old_string: 'OUTSIDE_SECRET',
            new_string: 'OVERWRITTEN'
          })
      ]
    ] as const) {
      let blocked = false
      try {
        await operation()
      } catch {
        blocked = true
      }
      if (!blocked) throw new Error(`${label} escaped the workspace using ${outsidePath}`)
    }
  }
  let outsideWriteBlocked = false
  try {
    await boundaryWrite.invoke({ file_path: outsideFile, content: 'OVERWRITTEN' })
  } catch {
    outsideWriteBlocked = true
  }
  if (!outsideWriteBlocked || readFileSync(outsideFile, 'utf8') !== 'OUTSIDE_SECRET') {
    throw new Error('write_file escaped the workspace')
  }

  const externalLink = join(boundaryRoot, 'external-link.txt')
  try {
    symlinkSync(outsideFile, externalLink)
    let symlinkReadBlocked = false
    try {
      await boundaryRead.invoke({ file_path: 'external-link.txt' })
    } catch {
      symlinkReadBlocked = true
    }
    if (!symlinkReadBlocked) throw new Error('read_file followed a symlink outside the workspace')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOSYS') throw err
    console.log('⚠️ [Workspace Boundary] symlink test skipped: platform does not permit creating symlinks')
  } finally {
    rmSync(externalLink, { force: true })
  }

  const attachmentTools = createWorkspaceTools({
    rootDir: boundaryRoot,
    allowedReadPaths: [outsideFile],
    signal: new AbortController().signal,
    requireApproval: async () => {},
    recordToolData: () => {},
    onTodosChange: () => {}
  })
  const attachmentRead = attachmentTools.find((tool) => tool.name === 'read_file')!
  const attachmentGrep = attachmentTools.find((tool) => tool.name === 'grep')!
  const attachmentWrite = attachmentTools.find((tool) => tool.name === 'write_file')!
  const attachedText = await attachmentRead.invoke({ file_path: outsideFile })
  if (typeof attachedText !== 'string' || !attachedText.includes('OUTSIDE_SECRET')) {
    throw new Error('Explicitly attached file could not be read')
  }
  const attachedGrep = await attachmentGrep.invoke({ pattern: 'OUTSIDE_SECRET', path: outsideFile })
  if (typeof attachedGrep !== 'string' || !attachedGrep.includes('OUTSIDE_SECRET')) {
    throw new Error('Explicitly attached file could not be searched as a single read-only file')
  }
  let attachedWriteBlocked = false
  try {
    await attachmentWrite.invoke({ file_path: outsideFile, content: 'OVERWRITTEN' })
  } catch {
    attachedWriteBlocked = true
  }
  if (!attachedWriteBlocked) throw new Error('write_file modified an explicitly attached external file')

  const projectMemoryPath = join(tempRoot, 'managed-project-memory', 'memory.md')
  const memoryTools = createWorkspaceTools({
    rootDir: boundaryRoot,
    projectMemoryPath,
    signal: new AbortController().signal,
    requireApproval: async () => {},
    recordToolData: () => {},
    onTodosChange: () => {}
  })
  await memoryTools.find((tool) => tool.name === 'remember')!.invoke({ note: '安全记忆写入测试' })
  if (!readFileSync(projectMemoryPath, 'utf8').includes('安全记忆写入测试')) {
    throw new Error('remember could not write its runtime-designated project memory file')
  }
  console.log('✅ [Workspace Boundary] traversal/symlink escapes blocked; exact attachments are single-file read-only')
}

async function verifyLocalLibraryBoundary(tempRoot: string): Promise<void> {
  const store = new LocalAppStore(
    join(tempRoot, 'library-user-data'),
    join(tempRoot, 'library-projects-home'),
    join(tempRoot, 'library-resources')
  )
  const defaultRoot = store.getDefaultWorkspaceRoot()
  const siblingRoot = join(dirname(defaultRoot), 'unregistered-sibling')
  const projectRoot = join(tempRoot, 'registered-project')
  const libraryRoot = join(tempRoot, 'explicit-library')
  mkdirSync(siblingRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(libraryRoot, { recursive: true })
  const defaultFile = join(defaultRoot, 'default-visible.md')
  const siblingFile = join(siblingRoot, 'sibling-secret.md')
  const projectFile = join(projectRoot, 'project-visible.md')
  const libraryFile = join(libraryRoot, 'library-visible.md')
  writeFileSync(defaultFile, 'default workspace', 'utf8')
  writeFileSync(siblingFile, 'unregistered sibling', 'utf8')
  writeFileSync(projectFile, 'registered project', 'utf8')
  writeFileSync(libraryFile, 'explicit library', 'utf8')
  store.createProject('Registered project', projectRoot)
  const task = store.createTask({ id: 'task-boundary-check' })
  const transcriptPath = store.getTranscriptPath(task.id)
  mkdirSync(dirname(transcriptPath), { recursive: true })
  writeFileSync(
    transcriptPath,
    JSON.stringify([
      {
        role: 'assistant',
        deliverables: [
          { path: defaultFile, title: 'Allowed deliverable', kind: 'doc' },
          { path: siblingFile, title: 'Unregistered sibling leak', kind: 'doc' }
        ]
      }
    ]),
    'utf8'
  )
  store.addLibraryFolder(libraryRoot)

  let traversalIdRejected = false
  try {
    store.getTranscriptPath('../outside-task')
  } catch {
    traversalIdRejected = true
  }
  let traversalProjectRejected = false
  try {
    store.readProjectMemory('../outside-project')
  } catch {
    traversalProjectRejected = true
  }
  if (!traversalIdRejected || !traversalProjectRejected) {
    throw new Error('Store accepted a traversal-like project/task identifier')
  }

  const paths = new Set(store.scanLocalLibrary().items.map((item) => item.path))
  for (const allowed of [defaultFile, projectFile, libraryFile]) {
    if (!paths.has(resolve(allowed))) throw new Error(`Authorized library path missing: ${allowed}`)
  }
  if (paths.has(resolve(siblingFile))) {
    throw new Error('Local library exposed an unregistered sibling directory')
  }
  console.log('✅ [Workspace Boundary] local library limited to default, registered, and explicitly added roots')
}

async function verifyHardeningChecks(tempRoot: string): Promise<void> {
  // 1. DESIGN-AGENT.md 宪章防覆写保护
  const charterPath = join(tempRoot, 'DESIGN-AGENT.md')
  writeFileSync(charterPath, '# 项目宪章\n禁止修改层高限制\n', 'utf8')
  const tools = createWorkspaceTools({
    rootDir: tempRoot,
    signal: new AbortController().signal,
    requireApproval: async () => {},
    recordToolData: () => {},
    onTodosChange: () => {}
  })
  const writeTool = tools.find((t) => t.name === 'write_file')!
  const editTool = tools.find((t) => t.name === 'edit_file')!
  let writeBlocked = false
  let editBlocked = false
  try {
    await writeTool.invoke({ file_path: 'DESIGN-AGENT.md', content: 'hacked' })
  } catch (err) {
    writeBlocked = String(err).includes('DESIGN-AGENT.md')
  }
  try {
    await editTool.invoke({ file_path: 'DESIGN-AGENT.md', old_string: '禁止修改层高限制', new_string: '允许修改' })
  } catch (err) {
    editBlocked = String(err).includes('DESIGN-AGENT.md')
  }
  if (!writeBlocked || !editBlocked) {
    throw new Error(`DESIGN-AGENT.md protection failed: writeBlocked=${writeBlocked}, editBlocked=${editBlocked}`)
  }

  // 1a. 项目档案合并规则：rooms 按名合并、约束取并集、null 删除、decisions 去重
  let profile = applyProfilePatch(emptyProfile(), {
    name: '测试项目',
    rooms: [{ name: '客厅', area_m2: 25 }],
    constraints: ['不要大理石'],
    budget: { total: 300000 }
  })
  profile = applyProfilePatch(profile, {
    rooms: [{ name: '客厅', function: '会客' }, { name: '主卧', area_m2: 15.3 }],
    constraints: ['不要大理石', '保留原有窗户'],
    decisions: ['主材用木饰面', '主材用木饰面'],
    budget: null
  })
  const living = profile.rooms?.find((r) => r.name === '客厅')
  if (
    profile.rooms?.length !== 2 ||
    living?.area_m2 !== 25 ||
    living?.function !== '会客' ||
    profile.constraints?.length !== 2 ||
    profile.decisions?.length !== 1 ||
    profile.budget !== undefined ||
    !summarizeProfile(profile).includes('主卧 15.3㎡')
  ) {
    throw new Error(`project profile merge failed: ${JSON.stringify(profile)}`)
  }

  // 1b. 技能目录作为只读根：read_file 能读到工作区外的 SKILL.md，write_file 仍然被拦截
  const fakeSkillsRoot = mkdtempSync(join(tmpdir(), 'design-agent-skills-'))
  mkdirSync(join(fakeSkillsRoot, 'demo'), { recursive: true })
  const fakeSkillMd = join(fakeSkillsRoot, 'demo', 'SKILL.md')
  writeFileSync(fakeSkillMd, '---\nname: demo\ndescription: 只读技能测试\n---\n# Demo Skill\n', 'utf8')
  const skillTools = createWorkspaceTools({
    rootDir: tempRoot,
    readOnlyRoots: [fakeSkillsRoot],
    signal: new AbortController().signal,
    requireApproval: async () => {},
    recordToolData: () => {},
    onTodosChange: () => {}
  })
  const skillRead = await skillTools.find((t) => t.name === 'read_file')!.invoke({ file_path: fakeSkillMd })
  if (typeof skillRead !== 'string' || !skillRead.includes('Demo Skill')) {
    throw new Error(`read_file could not read SKILL.md under a read-only root: ${String(skillRead).slice(0, 200)}`)
  }
  let skillWriteBlocked = false
  try {
    await skillTools.find((t) => t.name === 'write_file')!.invoke({ file_path: fakeSkillMd, content: 'hacked' })
  } catch {
    skillWriteBlocked = true
  }
  if (!skillWriteBlocked || !readFileSync(fakeSkillMd, 'utf8').includes('Demo Skill')) {
    throw new Error('write_file must not modify files under read-only roots')
  }
  rmSync(fakeSkillsRoot, { recursive: true, force: true })

  await verifyWorkspacePathBoundary(tempRoot)

  // 2. 大工具结果自动外置 (.design-agent/tool-results/)
  const hugeOutput = 'A'.repeat(24000)
  const offloaded = offloadLargeToolOutput({
    rootDir: tempRoot,
    toolCallId: 'tc_huge_1',
    toolName: 'glob',
    output: hugeOutput
  })
  if (typeof offloaded !== 'string' || offloaded.length >= 6000 || !offloaded.includes('.design-agent/tool-results/')) {
    throw new Error('offloadLargeToolOutput did not compact huge tool output!')
  }
  const savedOffloadFile = join(tempRoot, '.design-agent', 'tool-results', 'glob_tc_huge_1.txt')
  if (!existsSync(savedOffloadFile) || readFileSync(savedOffloadFile, 'utf8').length !== 24000) {
    throw new Error('Offloaded tool result file missing or truncated!')
  }

  // 3. Anthropic cache_control 系统提示构造
  const cachedSys = buildSystemMessage('设计系统规范提示词', true)
  const blocks = cachedSys.content as unknown as Array<{ type?: string; cache_control?: { type?: string } }>
  if (!Array.isArray(blocks) || blocks[0]?.cache_control?.type !== 'ephemeral') {
    throw new Error('Anthropic prompt cache block missing cache_control=ephemeral!')
  }

  // 4. MCP hostState 结构化归因
  const mcpBundle = await connectMcpServers(
    [
      {
        name: 'blender',
        label: 'Blender',
        description: 'Blender 3D',
        command: 'nonexistent_blender_exe_xyz',
        args: [],
        hostState: {
          state: 'host-not-running',
          hostRunning: false,
          pluginInstalled: true,
          reason: 'Blender 宿主软件尚未启动'
        }
      }
    ],
    async () => {}
  )
  const statusBlock = mcpBundle.serverPrompts.join('\n')
  if (
    mcpBundle.failedServers.length !== 1 ||
    mcpBundle.failedServers[0].hostState?.state !== 'host-not-running' ||
    !statusBlock.includes('[hostState=host-not-running]')
  ) {
    throw new Error(`MCP hostState attribution failed: ${statusBlock}`)
  }
  await mcpBundle.closeAll()

  // 5. 子智能体角色工具裁剪 (research 只读 / modeler 允许 MCP)
  const fakeMcp = new DynamicStructuredTool({
    name: 'blender__add_cube',
    description: 'Add cube',
    schema: z.object({}),
    func: async () => 'ok'
  })
  const pool = [...tools, fakeMcp]
  const researchScoped = selectToolsForSubagentRole('research', pool)
  if (
    researchScoped.tools.some((t) => ['write_file', 'edit_file', 'execute', 'blender__add_cube'].includes(t.name)) ||
    !researchScoped.tools.some((t) => t.name === 'read_file')
  ) {
    throw new Error(`research subagent scoping failed: ${researchScoped.tools.map((t) => t.name).join(',')}`)
  }
  // 5b. 白名单里的工具名必须对应真实注册的工具（曾误写为 search_regulations）
  const fakeRegTool = new DynamicStructuredTool({
    name: 'retrieve_regulation_chunks',
    description: 'regulation',
    schema: z.object({}),
    func: async () => 'ok'
  })
  if (!selectToolsForSubagentRole('research', [...pool, fakeRegTool]).tools.some((t) => t.name === 'retrieve_regulation_chunks')) {
    throw new Error('research subagent cannot use retrieve_regulation_chunks')
  }
  const modelerScoped = selectToolsForSubagentRole('modeler', pool)
  if (!modelerScoped.tools.some((t) => t.name === 'blender__add_cube')) {
    throw new Error('modeler subagent scoping dropped MCP tool!')
  }

  // 6. Codex TOML 解析 & Anthropic Base URL 末尾 /v1 自动规整 + testModelProfileConnection
  const parsedCodex = parseCodexTomlConfig(`
model = "gemini-4-hydrogen"
model_provider = "custom"
[model_providers.custom]
name = "custom"
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
experimental_bearer_token = "sk-test-token"
`)
  if (
    parsedCodex.model !== 'gemini-4-hydrogen' ||
    parsedCodex.baseUrl !== 'http://127.0.0.1:15721/v1' ||
    parsedCodex.wireApi !== 'responses' ||
    parsedCodex.bearerToken !== 'sk-test-token'
  ) {
    throw new Error(`parseCodexTomlConfig mismatch: ${JSON.stringify(parsedCodex)}`)
  }

  let antPathSeen = ''
  const antServer = createServer((req, res) => {
    antPathSeen = req.url || ''
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (antPathSeen !== '/v1/messages') {
        res.statusCode = 404
        res.end('wrong path ' + antPathSeen)
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      const ev = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
      res.write(
        ev('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [],
            usage: { input_tokens: 10, output_tokens: 1 }
          }
        })
      )
      res.write(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      res.write(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }))
      res.write(ev('content_block_stop', { type: 'content_block_stop', index: 0 }))
      res.write(ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }))
      res.write(ev('message_stop', { type: 'message_stop' }))
      res.end()
    })
  })
  await new Promise<void>((r) => antServer.listen(0, '127.0.0.1', () => r()))
  const antPort = (antServer.address() as { port: number }).port
  const antProbe = await testModelProfileConnection({
    id: 'ant_test',
    label: 'Anthropic Relay',
    protocol: 'anthropic',
    // 故意在 Anthropic URL 末尾带上 /v1 验证自动去重不拼出 /v1/v1/messages
    baseUrl: `http://127.0.0.1:${antPort}/v1`,
    apiKey: 'sk-ant-mock',
    model: 'claude-sonnet-4-5',
    supportsThinking: false
  })
  antServer.close()
  if (!antProbe.ok || antPathSeen !== '/v1/messages') {
    throw new Error(`Anthropic /v1 normalization probe failed: ${JSON.stringify(antProbe)} path=${antPathSeen}`)
  }

  // 6b. OpenAI/Codex 无 /v1 前缀且 wire_api=responses 遇 404 时自动探测 /v1/chat/completions
  const oaiAdaptServer = createServer((req, res) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write(
        sseChunk({
          id: 'chatcmpl_adapt',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }]
        })
      )
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.statusCode = 404
    res.end('404 page not found')
  })
  await new Promise<void>((r) => oaiAdaptServer.listen(0, '127.0.0.1', () => r()))
  const oaiAdaptPort = (oaiAdaptServer.address() as { port: number }).port
  const oaiAdaptProbe = await testModelProfileConnection({
    id: 'oai_adapt',
    label: 'Codex Gemini NoV1',
    protocol: 'openai',
    baseUrl: `http://127.0.0.1:${oaiAdaptPort}`,
    apiKey: 'sk-adapt-mock',
    model: 'gemini-4-hydrogen',
    useResponsesApi: true,
    supportsThinking: false
  })
  oaiAdaptServer.close()
  if (
    !oaiAdaptProbe.ok ||
    oaiAdaptProbe.resolvedBaseUrl !== `http://127.0.0.1:${oaiAdaptPort}/v1` ||
    oaiAdaptProbe.resolvedUseResponsesApi !== false
  ) {
    throw new Error(`OpenAI 404 endpoint adaptation failed: ${JSON.stringify(oaiAdaptProbe)}`)
  }

  // 6c. 验证 Anthropic 严格区分 Bearer vs x-api-key 时，testModelProfileConnection 自动探测适配
  let anthAuthMode: 'bearer-only' | 'x-api-key-only' = 'x-api-key-only'
  const anthAuthServer = createServer((req, res) => {
    const hasBearer = /^Bearer\s+sk-anth-test$/i.test(String(req.headers.authorization || ''))
    const hasXApiKey = req.headers['x-api-key'] === 'sk-anth-test'
    const ok =
      anthAuthMode === 'x-api-key-only' ? hasXApiKey && !hasBearer : hasBearer && !hasXApiKey
    if (!ok) {
      res.statusCode = 401
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid auth header' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_auth_ok","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"usage":{"input_tokens":8,"output_tokens":0}}}\n\n'
    )
    res.write(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
    )
    res.write(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n'
    )
    res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
    res.write(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n'
    )
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    res.end()
  })
  await new Promise<void>((r) => anthAuthServer.listen(0, '127.0.0.1', () => r()))
  const anthPort = (anthAuthServer.address() as { port: number }).port
  const xKeyProbe = await testModelProfileConnection({
    id: 'anth_xkey',
    label: 'Anthropic Strict X-API-KEY',
    protocol: 'anthropic',
    authStyle: 'bearer',
    baseUrl: `http://127.0.0.1:${anthPort}`,
    apiKey: 'sk-anth-test',
    model: 'claude-sonnet-4-5',
    supportsThinking: false
  })
  anthAuthMode = 'bearer-only'
  const bearerProbe = await testModelProfileConnection({
    id: 'anth_bearer',
    label: 'Anthropic Strict Bearer',
    protocol: 'anthropic',
    authStyle: 'x-api-key',
    baseUrl: `http://127.0.0.1:${anthPort}`,
    apiKey: 'sk-anth-test',
    model: 'claude-sonnet-4-5',
    supportsThinking: false
  })
  anthAuthServer.close()
  if (
    !xKeyProbe.ok ||
    xKeyProbe.resolvedAuthStyle !== 'x-api-key' ||
    !bearerProbe.ok ||
    bearerProbe.resolvedAuthStyle !== 'bearer'
  ) {
    throw new Error(
      `Anthropic authStyle auto-adaptation failed: xKey=${JSON.stringify(xKeyProbe)}, bearer=${JSON.stringify(bearerProbe)}`
    )
  }

  // 7. 统一使用主模型渠道直接出图（无需单独 imageGen 配置）+ Gemini/Banana 模型优先走 chat/completions + 不支持生图时诚实报错
  let imgMode: 'chat_ok' | 'unsupported' = 'chat_ok'
  let imgApiCalls = 0
  let chatImgCalls = 0
  const imgTestServer = createServer((req, res) => {
    if (req.url?.endsWith('/images/generations')) {
      imgApiCalls += 1
      res.statusCode = 404
      res.end('not supported on this model')
      return
    }
    if (req.url?.endsWith('/chat/completions')) {
      chatImgCalls += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (imgMode === 'chat_ok') {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: `![render](data:image/png;base64,${TINY_PNG_BASE64})`
                }
              }
            ]
          })
        )
      } else {
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '我是一个纯文本模型，没有生成图像的能力。' } }]
          })
        )
      }
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => imgTestServer.listen(0, '127.0.0.1', () => r()))
  const imgPort = (imgTestServer.address() as { port: number }).port
  // 7. 纯文本模型默认不挂载生图工具（避免兜圈）+ 独立 imageGenConfig / 生图多模态模型挂载验证
  const textOnlyImgTools = createImageTools({
    rootDir: tempRoot,
    modelProfile: {
      id: 'ds_text',
      label: 'DeepSeek Text',
      protocol: 'openai',
      baseUrl: `http://127.0.0.1:${imgPort}/v1`,
      apiKey: 'sk-ds',
      model: 'deepseek-v4.1-flash'
    },
    signal: new AbortController().signal,
    requireApproval: async () => {},
    waitForImageEdit: async () => ({ action: 'cancel' }),
    recordToolData: () => {}
  })
  if (
    textOnlyImgTools.some((t) => t.name === 'generate_image' || t.name === 'edit_image_with_ref')
  ) {
    throw new Error('Pure text model (deepseek-v4.1-flash) should NOT mount generate_image without imageGenConfig!')
  }

  const withDedicatedApiTools = createImageTools({
    rootDir: tempRoot,
    modelProfile: {
      id: 'ds_text',
      label: 'DeepSeek Text',
      protocol: 'openai',
      baseUrl: `http://127.0.0.1:${imgPort}/v1`,
      apiKey: 'sk-ds',
      model: 'deepseek-v4.1-flash'
    },
    imageGenConfig: {
      enabled: true,
      baseUrl: `http://127.0.0.1:${imgPort}/v1`,
      apiKey: 'sk-dedicated-img',
      model: 'Kwai-Kolors/Kolors',
      defaultSize: '1024x1024'
    },
    signal: new AbortController().signal,
    requireApproval: async () => {},
    waitForImageEdit: async () => ({ action: 'cancel' }),
    recordToolData: () => {}
  })
  if (
    !withDedicatedApiTools.some((t) => t.name === 'generate_image') ||
    !withDedicatedApiTools.some((t) => t.name === 'edit_image_with_ref')
  ) {
    throw new Error('Dedicated imageGenConfig should mount generate_image & edit_image_with_ref for DeepSeek!')
  }

  const unifiedImgTools = createImageTools({
    rootDir: tempRoot,
    modelProfile: {
      id: 'unified',
      label: 'Unified Relay',
      protocol: 'openai',
      baseUrl: `http://127.0.0.1:${imgPort}/v1`,
      apiKey: 'sk-unified',
      model: 'gemini-2.5-flash-image'
    },
    signal: new AbortController().signal,
    requireApproval: async () => {},
    waitForImageEdit: async () => ({ action: 'cancel' }),
    recordToolData: () => {}
  })
  const genTool = unifiedImgTools.find((t) => t.name === 'generate_image')
  if (!genTool || !unifiedImgTools.some((t) => t.name === 'edit_image_with_ref')) {
    throw new Error('Unified image tools were NOT mounted without separate imageGenConfig!')
  }
  const genOut = await genTool.invoke({ prompt: '现代建筑白天俯视效果图', image_name: 'unified_day' })
  if (!String(genOut).includes('unified_day.png') || !existsSync(join(tempRoot, 'renders', 'unified_day.png'))) {
    throw new Error(`Chat fallback image generation failed: ${genOut}`)
  }
  if (chatImgCalls !== 1 || imgApiCalls !== 0) {
    throw new Error(`Gemini/Banana image model should prioritize /chat/completions first without hitting /images/generations, got chat=${chatImgCalls}, img=${imgApiCalls}`)
  }
  imgMode = 'unsupported'
  let unsupportedErr = ''
  try {
    await genTool.invoke({ prompt: '夜景效果图', image_name: 'should_fail' })
  } catch (err) {
    unsupportedErr = String(err)
  }
  imgTestServer.close()
  if (!unsupportedErr.includes('不支持生图')) {
    throw new Error(`Unsupported model should report honest error, got: ${unsupportedErr}`)
  }

  // 7. 验证启动时不预置空白内置模型模板，且旧库中的空白模板会被自动清理
  const savedEnvs = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
  }
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.DASHSCOPE_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    const storeUserData = join(tempRoot, 'store-verify')
    const storeProjHome = join(tempRoot, 'store-projects')
    const storeResDir = join(tempRoot, 'store-res')
    const appStore = new LocalAppStore(storeUserData, storeProjHome, storeResDir)
    const freshSettings = appStore.getModelSettings()
    if (freshSettings.profiles.length !== 0 || freshSettings.activeProfileId !== '') {
      throw new Error(
        `Fresh store without env keys should have 0 profiles, got: ${JSON.stringify(freshSettings)}`
      )
    }

    // 模拟旧版本遗留：4 个未填 Key 模板 + 1 个已导入渠道 wbzz
    writeFileSync(
      join(storeUserData, 'model-settings.json'),
      JSON.stringify({
        activeProfileId: 'deepseek-default',
        imageGen: freshSettings.imageGen,
        regulation: freshSettings.regulation,
        webSearch: freshSettings.webSearch,
        profiles: [
          {
            id: 'deepseek-default',
            label: 'DeepSeek (OpenAI 兼容)',
            protocol: 'openai',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKey: '',
            model: 'deepseek-chat'
          },
          {
            id: 'dashscope-qwen',
            label: '通义千问 DashScope',
            protocol: 'openai',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            apiKey: '',
            model: 'qwen-plus'
          },
          {
            id: 'openai-compatible',
            label: 'OpenAI / 自定义中转站',
            protocol: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: '',
            model: 'gpt-4o'
          },
          {
            id: 'anthropic-claude',
            label: 'Anthropic Claude',
            protocol: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            apiKey: '',
            model: 'claude-sonnet-4-20250514'
          },
          {
            id: 'cc_wbzz',
            label: 'wbzz',
            protocol: 'openai',
            baseUrl: 'http://127.0.0.1:8788/v1',
            apiKey: 'sk-wbzz-123',
            model: 'deepseek-v4.1-flash'
          }
        ]
      }),
      'utf8'
    )
    const migrated = appStore.getModelSettings()
    if (
      migrated.profiles.length !== 1 ||
      migrated.profiles[0].id !== 'cc_wbzz' ||
      migrated.activeProfileId !== 'cc_wbzz'
    ) {
      throw new Error(
        `Legacy empty builtin templates were NOT stripped cleanly: ${JSON.stringify(migrated)}`
      )
    }
  } finally {
    for (const [k, v] of Object.entries(savedEnvs)) {
      if (v !== undefined) process.env[k] = v
    }
  }

  // 8. 验证 CC Switch 同渠道 modelCatalog 多模型全部拆出（含 gemini-nano-banana-2.1）且尊重 meta.apiFormat
  const parsedGeminiRows = parseCcSwitchRow({
    id: 'gem-1',
    app_type: 'codex',
    name: 'gemini',
    is_current: 0,
    settings_config: JSON.stringify({
      auth: { OPENAI_API_KEY: 'sk-gem' },
      config: 'model = "gemini-4-hydrogen"\n[model_providers.custom]\nwire_api = "responses"\nbase_url = "http://127.0.0.1:2048"',
      modelCatalog: {
        models: [
          { model: 'gemini-4-hydrogen', contextWindow: 1048576 },
          { model: 'gemini-nano-banana-2.1', contextWindow: 128000 }
        ]
      }
    }),
    meta: JSON.stringify({ apiFormat: 'openai_chat' })
  })
  if (
    parsedGeminiRows.length !== 2 ||
    parsedGeminiRows[0].model !== 'gemini-4-hydrogen' ||
    parsedGeminiRows[1].model !== 'gemini-nano-banana-2.1' ||
    parsedGeminiRows[0].useResponsesApi !== false ||
    parsedGeminiRows[1].contextWindowTokens !== 128000
  ) {
    throw new Error(`Multi-model CC Switch parsing mismatch: ${JSON.stringify(parsedGeminiRows)}`)
  }

  // 9. 验证自然结束（done）时自动收口未刷新完成的 Todo 计划项，而 aborted 保留中断态
  const todoStore = new LocalAppStore(
    join(tempRoot, 'todo-user-data'),
    join(tempRoot, 'todo-proj'),
    join(tempRoot, 'todo-res')
  )
  const todoTask = todoStore.createTask({ id: 'todo_done_test', title: 'Todo Settle Test' })
  todoStore.appendUserTurn({ threadId: todoTask.id, requestId: 'req_todo_1', text: '测试计划完成收口' })
  todoStore.applyRuntimeEventToTranscript({
    type: 'tool-result',
    requestId: 'req_todo_1',
    threadId: todoTask.id,
    name: 'write_todos',
    ok: true,
    message: 'ok',
    toolData: {
      kind: 'write_todos',
      todos: [
        { content: '步骤1', status: 'completed' },
        { content: '步骤2', status: 'in_progress' },
        { content: '步骤3', status: 'pending' }
      ]
    }
  })
  todoStore.applyRuntimeEventToTranscript({
    type: 'done',
    requestId: 'req_todo_1',
    threadId: todoTask.id,
    turnId: 'turn_todo_1',
    deliverables: []
  })
  const settledItems = todoStore.readTranscript(todoTask.id)
  const settledAsst = settledItems.find((it) => it.role === 'assistant')
  if (
    !settledAsst ||
    settledAsst.role !== 'assistant' ||
    !settledAsst.todos.every((td) => td.status === 'completed')
  ) {
    throw new Error(`Completed turn did NOT settle pending todos: ${JSON.stringify(settledAsst)}`)
  }

  const abortTask = todoStore.createTask({ id: 'todo_abort_test', title: 'Todo Abort Test' })
  todoStore.appendUserTurn({ threadId: abortTask.id, requestId: 'req_todo_2', text: '测试中断保留计划' })
  todoStore.applyRuntimeEventToTranscript({
    type: 'tool-result',
    requestId: 'req_todo_2',
    threadId: abortTask.id,
    name: 'write_todos',
    ok: true,
    message: 'ok',
    toolData: {
      kind: 'write_todos',
      todos: [
        { content: '步骤1', status: 'completed' },
        { content: '步骤2', status: 'in_progress' }
      ]
    }
  })
  todoStore.applyRuntimeEventToTranscript({
    type: 'aborted',
    requestId: 'req_todo_2',
    threadId: abortTask.id,
    turnId: 'turn_todo_2',
    deliverables: []
  })
  const abortedItems = todoStore.readTranscript(abortTask.id)
  const abortedAsst = abortedItems.find((it) => it.role === 'assistant')
  if (
    !abortedAsst ||
    abortedAsst.role !== 'assistant' ||
    abortedAsst.todos[1]?.status !== 'in_progress'
  ) {
    throw new Error(`Aborted turn should keep unfinished todo state: ${JSON.stringify(abortedAsst)}`)
  }

  // 验证中断后点击「从中断处继续」，续跑轮次继承未完成进度，并在 done 后收口为全部完成
  todoStore.appendUserTurn({
    threadId: abortTask.id,
    requestId: 'req_todo_2_cont',
    text: '请从上次中断的步骤继续执行剩余任务。'
  })
  const contBeforeDone = todoStore.readTranscript(abortTask.id)
  const contAsstBeforeDone = contBeforeDone[contBeforeDone.length - 1]
  if (
    !contAsstBeforeDone ||
    contAsstBeforeDone.role !== 'assistant' ||
    contAsstBeforeDone.todos.length !== 2 ||
    contAsstBeforeDone.todos[1].status !== 'in_progress'
  ) {
    throw new Error(`Continuation turn should inherit interrupted todos: ${JSON.stringify(contAsstBeforeDone)}`)
  }
  todoStore.applyRuntimeEventToTranscript({
    type: 'done',
    requestId: 'req_todo_2_cont',
    threadId: abortTask.id,
    turnId: 'turn_todo_2_cont',
    deliverables: []
  })
  const contAfterDone = todoStore.readTranscript(abortTask.id)
  const contAsstAfterDone = contAfterDone[contAfterDone.length - 1]
  if (
    !contAsstAfterDone ||
    contAsstAfterDone.role !== 'assistant' ||
    !contAsstAfterDone.todos.every((td) => td.status === 'completed')
  ) {
    throw new Error(`Continuation done should settle inherited todos: ${JSON.stringify(contAsstAfterDone)}`)
  }

  // 10. 验证 43 任务目录 + 动态表单 + composeFeatureSubmission 拼装逻辑
  if (FEATURE_CATALOG.length !== 43 || Object.keys(FEATURE_FORMS).length !== 43) {
    throw new Error(
      `Expected 43 catalog items & forms, got catalog=${FEATURE_CATALOG.length}, forms=${Object.keys(FEATURE_FORMS).length}`
    )
  }
  const aliasHits = filterFeatures(FEATURE_CATALOG, '生图', '白模')
  if (!aliasHits.some((f) => f.featureCode === 'B4.3')) {
    throw new Error(`searchAlias filter failed for '白模': ${JSON.stringify(aliasHits)}`)
  }
  const b43 = aliasHits.find((f) => f.featureCode === 'B4.3')!
  const b43Fields = FEATURE_FORMS['B4.3'].fields
  const sub = composeFeatureSubmission(b43, b43Fields, {
    fields: {
      'B4.3.r0': {
        text: '',
        attachments: [{ path: 'D:/a/model.png', name: 'model.png', kind: 'image', size: 120 }]
      },
      'B4.3.r1': { text: '现代极简客厅白模渲染，暖光氛围', attachments: [] },
      'B4.3.o0': {
        text: '',
        attachments: [{ path: 'D:/a/wood.jpg', name: 'wood.jpg', kind: 'image', size: 80 }]
      }
    }
  })
  if (
    sub.title !== '精准渲染：现代极简客厅白模渲染，暖光氛围' ||
    !sub.text.includes('附件[1] model.png') ||
    !sub.text.includes('附件[2] wood.jpg') ||
    sub.attachments.length !== 2 ||
    sub.sceneParam.toolTitle !== '精准渲染'
  ) {
    throw new Error(`composeFeatureSubmission mismatch: ${JSON.stringify(sub)}`)
  }

  // 10. P1 SketchUp 住宅客厅预置建模工程包校验（脚本/贴图/参数解析/提示词指令 + 窗口拖拽区回归）
  const presetsRoot = resolve('resources/presets')
  const presetSkillsRoot = resolve('resources/skills')
  const discoveredPresets = discoverModelingPresets(presetsRoot, presetSkillsRoot)
  const suPreset = discoveredPresets.find((p) => p.id === 'living-room-modeling-v1')
  if (!suPreset) {
    throw new Error('living-room-modeling-v1 preset not discovered!')
  }
  const requiredScripts = ['run.rb', 'finish.rb', 'architecture.rb', 'furniture.rb', 'decor.rb', 'refine.rb']
  for (const fname of requiredScripts) {
    const fpath = join(suPreset.presetDir, 'scripts', fname)
    if (!existsSync(fpath)) throw new Error(`Missing preset script: ${fpath}`)
  }
  for (const tex of ['oak_wood.png', 'walnut_wood.png', 'terrazzo_stone.png', 'microcement_plaster.png', 'linen_fabric.png', 'boucle_rug.png']) {
    const tpath = join(suPreset.presetDir, 'textures', tex)
    const buf = readFileSync(tpath)
    if (buf.length < 64 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
      throw new Error(`Invalid PNG texture in preset: ${tpath}`)
    }
  }
  const matchedExplicit = matchModelingPreset(discoveredPresets, {
    text: '生成一个新中式 5.2x7.0m 客厅模型',
    sceneParam: {
      toolTitle: '照图建模',
      paramValues: { 预置包: 'living-room-modeling-v1', 建模软件: 'SketchUp' }
    }
  })
  const matchedNatural = matchModelingPreset(discoveredPresets, {
    text: '在 SketchUp 里帮我建一个 5.2米x7米 侘寂原木风住宅客厅白模'
  })
  const skippedRenderOnly = matchModelingPreset(discoveredPresets, {
    text: '帮我画一张现代简约客厅夜景效果图'
  })
  if (!matchedExplicit || !matchedNatural || skippedRenderOnly) {
    throw new Error(
      `Preset matching logic mismatch: explicit=${Boolean(matchedExplicit)}, natural=${Boolean(matchedNatural)}, renderOnly=${Boolean(skippedRenderOnly)}`
    )
  }
  const directive = buildModelingPresetDirective(suPreset, {
    text: '新中式 5.2m x 7.0m 层高 3.0m',
    skillsRoot: presetSkillsRoot
  })
  if (
    !directive.includes("load '") ||
    !directive.includes('LivingRoomPreset.build(') ||
    !directive.includes("style: 'new_chinese'") ||
    !directive.includes('width_mm: 5200') ||
    !directive.includes('depth_mm: 7000')
  ) {
    throw new Error(`Unexpected preset directive output: ${directive}`)
  }

  const globalsCss = readFileSync(resolve('src/renderer/src/styles/globals.css'), 'utf8')
  const appTsx = readFileSync(resolve('src/renderer/src/App.tsx'), 'utf8')
  // 标题栏已拆到独立组件：拖拽热区在新文件里，同时确认 App 仍在用它
  const titleBarTsx = readFileSync(
    resolve('src/renderer/src/components/layout/WindowTitleBar.tsx'),
    'utf8'
  )
  if (
    !globalsCss.includes('.app-drag-region') ||
    !titleBarTsx.includes('flex-1 h-full min-w-[64px] app-drag-region') ||
    !appTsx.includes('<WindowTitleBar')
  ) {
    throw new Error('Frameless window drag spacer regression detected!')
  }

  // 11. P2 本地规范库 SQLite FTS5 持久化索引 + 单位等价 + 效力替代 + 页码定位校验
  const regSandbox = join(tempRoot, 'reg-fts-test')
  mkdirSync(regSandbox, { recursive: true })
  writeFileSync(
    join(regSandbox, 'GB50016-2014《建筑设计防火规范》.md'),
    [
      '5.5.18 除本规范另有规定外，公共建筑内疏散门和安全出口的净宽度不应小于 0.90m，面积大于 200m² 的房间应设两个疏散门。',
      '',
      '5.5.180 干扰测试条号不得命中 5.5.18。'
    ].join('\n'),
    'utf8'
  )
  writeFileSync(
    join(regSandbox, 'GB55037-2022《建筑防火通用规范》.md'),
    '7.1.4 公共建筑内每个防火分区或一个防火分区的每个楼层，其安全出口的数量应经计算确定，且不应少于2个。房间建筑面积大于 200㎡ 时至少设两个疏散门。',
    'utf8'
  )
  let capturedRegData: { retrievedChunks: Array<{ standardNo: string; pageNo?: number; supersededBy?: string; clauseId: string }> } | null = null
  const regTool = createLocalRegulationTool({
    regulationFolder: regSandbox,
    pythonExe: resolve('resources/runtime/python/python.exe'),
    recordToolData: (_id, d) => {
      capturedRegData = d
    }
  })
  // 测试工程单位等价：查 200平方米 应命中文本中的 200m² 与 200㎡，且 GB 55037 通用规范排位高于已替代强条 GB 50016，且带 pageNo & supersededBy
  const unitOut = String(await regTool.invoke({ query: '200平方米 疏散门' }))
  const unitJson = JSON.parse(unitOut) as {
    engine?: string
    chunks: Array<{ standardNo: string; pageNo?: number; supersededBy?: string; clauseId: string }>
  }
  const nativeFts5Available = unitJson.engine === 'sqlite-fts5'
  if (nativeFts5Available) {
    if (
      !existsSync(join(regSandbox, '.design-agent-reg-index.db')) ||
      unitJson.chunks.length < 2 ||
      !unitJson.chunks.some((c) => c.standardNo.includes('55037')) ||
      !unitJson.chunks.some((c) => c.supersededBy?.includes('GB 55037-2022')) ||
      !capturedRegData?.retrievedChunks?.every((c) => typeof c.pageNo === 'number' && c.pageNo >= 1)
    ) {
      throw new Error(`Native FTS5 regulation search failed: ${unitOut}`)
    }
  } else if (
    unitJson.chunks.length === 0 ||
    !unitJson.chunks.some((c) => c.standardNo.includes('55037')) ||
    !capturedRegData?.retrievedChunks?.length
  ) {
    throw new Error(`Portable regulation search fallback failed: ${unitOut}`)
  } else {
    console.warn('⚠️ [Hardening] Native SQLite FTS5 indexer unavailable; portable regulation search fallback smoke-check passed')
  }
  // 测试排除词 -55037 过滤
  const excludeOut = JSON.parse(String(await regTool.invoke({ query: '疏散门 -55037' }))) as {
    chunks: Array<{ standardNo: string }>
  }
  if (nativeFts5Available && excludeOut.chunks.some((c) => c.standardNo.includes('55037'))) {
    throw new Error('Negative term exclusion (-55037) failed!')
  }
  if (!nativeFts5Available) {
    console.warn('⚠️ [Hardening] Native-only negative-term and page/supersession assertions skipped without the native indexer')
  }

  // 12. P2 Before/After 文件级快照、图生图血缘记录与可逆一键回滚校验
  const snapSandbox = join(tempRoot, 'snap-test')
  mkdirSync(snapSandbox, { recursive: true })
  const snapTools = createWorkspaceTools({
    rootDir: snapSandbox,
    signal: new AbortController().signal,
    requireApproval: async () => {},
    recordToolData: () => {},
    onTodosChange: () => {}
  })
  const snapWrite = snapTools.find((t) => t.name === 'write_file')!
  const snapEdit = snapTools.find((t) => t.name === 'edit_file')!
  await snapWrite.invoke({ file_path: 'living_room.rb', content: "style = 'modern'\nwidth = 4800\n" })
  await snapEdit.invoke({ file_path: 'living_room.rb', old_string: "style = 'modern'", new_string: "style = 'new_chinese'" })
  await snapWrite.invoke({ file_path: 'living_room.rb', content: "style = 'wabi'\nwidth = 5200\n" })
  const snaps = listFileSnapshots({ filePath: join(snapSandbox, 'living_room.rb'), rootDir: snapSandbox })
  if (snaps.length < 2 || snaps[0].sourceTool !== 'write_file' || snaps[1].sourceTool !== 'edit_file') {
    throw new Error(`Expected >=2 snapshots (write_file + edit_file), got ${JSON.stringify(snaps)}`)
  }
  const restoreRes = restoreFileSnapshot({
    filePath: join(snapSandbox, 'living_room.rb'),
    snapshotId: snaps[1].id,
    rootDir: snapSandbox
  })
  const restoredText = readFileSync(join(snapSandbox, 'living_room.rb'), 'utf8')
  const snapsAfterRollback = listFileSnapshots({ filePath: join(snapSandbox, 'living_room.rb'), rootDir: snapSandbox })
  if (!restoreRes.ok || !restoredText.includes("style = 'modern'") || snapsAfterRollback[0]?.sourceTool !== 'pre_rollback') {
    throw new Error(`Rollback failed or missing pre_rollback safety backup: ${restoredText}`)
  }
  const refImg = join(snapSandbox, 'before_render.png')
  const editedImg = join(snapSandbox, 'after_render.png')
  writeFileSync(refImg, Buffer.from(TINY_PNG_BASE64, 'base64'))
  writeFileSync(editedImg, Buffer.from(TINY_PNG_BASE64, 'base64'))
  recordImageLineageSnapshot({
    afterPath: editedImg,
    beforeRefPath: refImg,
    rootDir: snapSandbox,
    sourceTool: 'edit_image_with_ref',
    summary: '改为暖光夜景'
  })
  const imgSnaps = listFileSnapshots({ filePath: editedImg, rootDir: snapSandbox })
  if (imgSnaps.length !== 1 || !imgSnaps[0].beforeRefPath?.endsWith('before_render.png')) {
    throw new Error(`Image lineage snapshot failed: ${JSON.stringify(imgSnaps)}`)
  }
  console.log('✅ [Hardening] DESIGN-AGENT.md protection + Tool Output Offload + Anthropic Cache + MCP hostState + Subagent Role Scoping + CC Switch Multi-Model / Unified Image + Empty Preset Stripping + Todo Settlement + 43-Task Forms + P1 SU Preset & Drag Fix + Regulation Search (native FTS5 when available) + P2 Before/After Diff & Rollback PASSED!')
}

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'design-agent-full-verify-'))
  const resourcesRoot = resolve(__dirname, '../resources')
  const skillsRoot = join(resourcesRoot, 'skills')
  const regulationsRoot = join(resourcesRoot, 'regulations')
  const workspacesBase = join(tempRoot, 'workspaces')

  await verifyCadAnd3dServices(tempRoot, skillsRoot)
  await verifyStandaloneMcpManager(tempRoot, resourcesRoot)
  await verifyOfficeLibs()
  await verifyHardeningChecks(tempRoot)

  let llmTurn = 0
  let sawAnnotationsTag = false
  let sawConversationsTag = false
  let sawMcpServersTag = false
  let sawSketchupToolSchema = false
  let sawRegulationToolSchema = false
  let sawEditImageToolSchema = false
  let sawImagesEditsCall = false
  let sawNextSuggestionsCall = false
  let sawDistillCall = false

  // 本地模拟 OpenAI Chat SSE + /images/generations + /images/edits 接口
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/images/generations') && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG_BASE64 }] }))
      return
    }

    if (req.url?.endsWith('/images/edits') && req.method === 'POST') {
      const ct = req.headers['content-type'] ?? ''
      if (ct.includes('multipart/form-data')) {
        sawImagesEditsCall = true
      }
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG_BASE64 }] }))
      })
      return
    }

    if (req.url?.endsWith('/chat/completions') && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const parsed = JSON.parse(body) as {
          messages: Array<{ role: string; content: unknown }>
          tools?: Array<{ function?: { name?: string } }>
        }
        const allText = JSON.stringify(parsed.messages)
        const systemText = parsed.messages
          .filter((m) => m.role === 'system')
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n')

        // 旁路 1：下一步建议生成器 (s3r)
        if (!parsed.tools && systemText.includes('下一步建议')) {
          sawNextSuggestionsCall = true
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })
          res.write(
            sseChunk({
              id: 'sugg_1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content: JSON.stringify([
                      '把茶桌材质替换成深胡桃木再出一版夜景图',
                      '输出符合北京无障碍规范的平面尺寸核查表'
                    ])
                  },
                  finish_reason: 'stop'
                }
              ]
            })
          )
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // 旁路 2：项目记忆蒸馏器
        if (!parsed.tools && systemText.includes('记忆蒸馏器')) {
          sawDistillCall = true
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })
          res.write(
            sseChunk({
              id: 'distill_1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content: JSON.stringify({
                      confirmed: [
                        '茶室主材选用深胡桃木与哑光青石板',
                        '无障碍卫生间按北京 DB11/1950-2021 留 1.50m 轮椅回转圆'
                      ],
                      rejected: ['高光大理石地面']
                    })
                  },
                  finish_reason: 'stop'
                }
              ]
            })
          )
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        if (allText.includes('<annotations>')) sawAnnotationsTag = true
        if (allText.includes('<conversations>')) sawConversationsTag = true
        if (allText.includes('<mcp-servers>')) sawMcpServersTag = true
        if (parsed.tools?.some((t) => t.function?.name === 'sketchup__eval_ruby')) {
          sawSketchupToolSchema = true
        }
        if (parsed.tools?.some((t) => t.function?.name === 'retrieve_regulation_chunks')) {
          sawRegulationToolSchema = true
        }
        if (parsed.tools?.some((t) => t.function?.name === 'edit_image_with_ref')) {
          sawEditImageToolSchema = true
        }

        llmTurn++
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })

        if (llmTurn === 1) {
          // 第 1 步：并行调用 规范检索 + SketchUp MCP + 文生图
          res.write(
            sseChunk({
              id: 'c1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    reasoning_content: '检索当地无障碍规范，查询 SketchUp 场景，并生成初版效果图…',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_reg_1',
                        type: 'function',
                        function: {
                          name: 'retrieve_regulation_chunks',
                          arguments: JSON.stringify({
                            query: '无障碍厕所 轮椅回转空间 1.50m'
                          })
                        }
                      },
                      {
                        index: 1,
                        id: 'call_mcp_1',
                        type: 'function',
                        function: {
                          name: 'sketchup__eval_ruby',
                          arguments: JSON.stringify({ code: 'Sketchup.active_model.entities.count' })
                        }
                      },
                      {
                        index: 2,
                        id: 'call_genimg_1',
                        type: 'function',
                        function: {
                          name: 'generate_image',
                          arguments: JSON.stringify({
                            prompt: '清雅新中式茶室效果图',
                            image_name: 'tea_room_v1'
                          })
                        }
                      }
                    ]
                  },
                  finish_reason: 'tool_calls'
                }
              ]
            })
          )
          res.write('data: [DONE]\n\n')
          res.end()
        } else if (llmTurn === 2) {
          // 第 2 步：对初版图片发起涂抹标注请求
          res.write(
            sseChunk({
              id: 'c2',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_imgedit_1',
                        type: 'function',
                        function: {
                          name: 'ask_image_edit',
                          arguments: JSON.stringify({
                            image_path: 'renders/tea_room_v1.png',
                            hint: '请圈出需要调整茶桌位置的地方'
                          })
                        }
                      }
                    ]
                  },
                  finish_reason: 'tool_calls'
                }
              ]
            })
          )
          res.write('data: [DONE]\n\n')
          res.end()
        } else if (llmTurn === 3) {
          // 第 3 步：调用 edit_image_with_ref 进行图生图垫图重绘
          res.write(
            sseChunk({
              id: 'c3',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_refimg_1',
                        type: 'function',
                        function: {
                          name: 'edit_image_with_ref',
                          arguments: JSON.stringify({
                            reference_image_path: 'renders/tea_room_v1_annotated.png',
                            prompt: '保持空间透视不变，将圈选茶桌修改为黑胡桃木矮茶桌',
                            image_name: 'tea_room_v2'
                          })
                        }
                      }
                    ]
                  },
                  finish_reason: 'tool_calls'
                }
              ]
            })
          )
          res.write('data: [DONE]\n\n')
          res.end()
        } else if (llmTurn === 4) {
          // 第 4 步：交付图生图成品
          res.write(
            sseChunk({
              id: 'c4',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_deliver_1',
                        type: 'function',
                        function: {
                          name: 'deliver',
                          arguments: JSON.stringify({
                            items: [{ path: 'renders/tea_room_v2.png' }]
                          })
                        }
                      }
                    ]
                  },
                  finish_reason: 'tool_calls'
                }
              ]
            })
          )
          res.write('data: [DONE]\n\n')
          res.end()
        } else {
          res.write(
            sseChunk({
              id: 'c5',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    content:
                      '已完成无障碍规范检索、SketchUp 联动、局部涂抹垫图改图，并交付 `renders/tea_room_v2.png`。'
                  },
                  finish_reason: 'stop'
                }
              ]
            })
          )
          res.write('data: [DONE]\n\n')
          res.end()
        }
      })
      return
    }
    res.statusCode = 404
    res.end()
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address() as { port: number }
  const mockBaseUrl = `http://127.0.0.1:${addr.port}/v1`

  const runtimeJs = resolve(__dirname, '../out/main/runtime.js')
  const mockMcpScript = resolve(__dirname, './mock-mcp-server.mjs')

  const transcriptPath = join(tempRoot, 'transcript.json')
  writeFileSync(
    transcriptPath,
    JSON.stringify(
      [
        {
          id: 'u1',
          role: 'user',
          text: '茶室采用深胡桃木和青石板，拒绝高光大理石；卫生间必须符合北京无障碍规范',
          createdAt: Date.now() - 2000
        },
        {
          id: 'a1',
          role: 'assistant',
          content: '已确认主材方案，无障碍卫生间按北京 DB11/1950-2021 留设 1.50m 轮椅回转空间。',
          segments: [],
          createdAt: Date.now()
        }
      ],
      null,
      2
    ),
    'utf8'
  )

  const child = fork(runtimeJs, [], {
    env: {
      ...process.env,
      DESIGN_AGENT_SKILLS_ROOT: skillsRoot,
      DESIGN_AGENT_WORKSPACES_DIR: workspacesBase
    }
  })

  const events: string[] = []
  let regulationHitCount = 0
  let deliveredPath = ''
  let receivedSuggestions: string[] = []
  let distillResult: { ok: boolean; updated: boolean } | null = null

  const sendToRuntime = (msg: RuntimeInbound): void => {
    child.send(msg)
  }

  const mockProfile = {
    id: 'mock',
    label: 'Mock Model',
    protocol: 'openai' as const,
    baseUrl: mockBaseUrl,
    apiKey: 'sk-mock',
    model: 'mock-v2',
    supportsThinking: true
  }

  await new Promise<void>((resolveAll, rejectAll) => {
    const timeout = setTimeout(() => rejectAll(new Error('Full verification timed out')), 30000)

    child.on('message', (raw: unknown) => {
      const ev = raw as RuntimeOutbound
      events.push(ev.type)

      if (ev.type === 'ready') {
        sendToRuntime({
          type: 'mcp_check',
          requestId: 'chk_1',
          server: {
            name: 'sketchup',
            label: 'SketchUp',
            description: 'SketchUp 建模连接器',
            command: process.execPath,
            args: [mockMcpScript]
          }
        })
      } else if (ev.type === 'mcp_check_done') {
        if (!ev.ok || ev.toolCount !== 1) {
          clearTimeout(timeout)
          rejectAll(new Error(`MCP check failed: ${JSON.stringify(ev)}`))
          return
        }
        console.log(`✅ [MCP Check] SketchUp MCP server handshake OK (${ev.toolCount} tool)`)

        sendToRuntime({
          type: 'chat',
          requestId: 'req_full_1',
          threadId: 'thread_full_1',
          text: '核对无障碍规范并参考历史茶室参数做局部改图',
          rootDir: tempRoot,
          projectId: 'proj_verify',
          transcriptPath,
          thinking: true,
          permissionMode: 'default',
          regulationFolder: regulationsRoot,
          annotations: [
            {
              title: 'plan.dwg',
              path: join(tempRoot, 'plan.dwg'),
              count: 1,
              text: '1. 图纸框选区域 --bbox 1200,800,4500,3600 (mm)：茶桌移至采光窗侧'
            }
          ],
          conversationRefs: [
            {
              title: '一楼茶室初步意向讨论',
              path: transcriptPath
            }
          ],
          mcp: [{ name: 'sketchup', label: 'SketchUp' }],
          mcpServers: [
            {
              name: 'sketchup',
              label: 'SketchUp',
              description: 'SketchUp 本地建模连接器',
              command: process.execPath,
              args: [mockMcpScript]
            }
          ],
          modelProfile: mockProfile,
          imageGenConfig: {
            enabled: true,
            baseUrl: mockBaseUrl,
            apiKey: 'sk-img-mock',
            model: 'FLUX.1-schnell',
            editModel: 'gpt-image-1',
            defaultSize: '1024x1024'
          }
        })
      } else if (ev.type === 'tool-result') {
        if (
          ev.name === 'retrieve_regulation_chunks' &&
          ev.toolData &&
          typeof ev.toolData === 'object' &&
          'total' in ev.toolData
        ) {
          regulationHitCount = Number((ev.toolData as { total: number }).total)
        }
      } else if (ev.type === 'interrupt') {
        sendToRuntime({
          type: 'resume',
          requestId: `res_${Date.now()}`,
          threadId: 'thread_full_1',
          decision: { type: 'approve', scope: 'all' }
        })
      } else if (ev.type === 'ask_image_edit') {
        const annotatedPath = join(tempRoot, 'renders', 'tea_room_v1_annotated.png')
        mkdirSync(join(tempRoot, 'renders'), { recursive: true })
        writeFileSync(annotatedPath, Buffer.from(TINY_PNG_BASE64, 'base64'))
        sendToRuntime({
          type: 'image_edit_answer',
          requestId: 'ans_img_1',
          threadId: 'thread_full_1',
          id: ev.id,
          answer: { action: 'confirm', imagePath: annotatedPath }
        })
      } else if (ev.type === 'done') {
        if (ev.deliverables.length !== 1 || ev.deliverables[0].kind !== 'image') {
          clearTimeout(timeout)
          rejectAll(new Error(`Unexpected deliverables: ${JSON.stringify(ev.deliverables)}`))
          return
        }
        deliveredPath = ev.deliverables[0].path
      } else if (ev.type === 'suggestions') {
        receivedSuggestions = ev.items
        // 在收到 suggestions 后紧接着触发项目记忆蒸馏验证
        sendToRuntime({
          type: 'distill_project',
          requestId: 'distill_req_1',
          projectId: 'proj_verify',
          conversationId: 'conv_prev_001',
          transcriptPath,
          modelProfile: mockProfile
        })
      } else if (ev.type === 'distill_done') {
        clearTimeout(timeout)
        distillResult = { ok: ev.ok, updated: ev.updated }
        try {
          if (!sawAnnotationsTag) throw new Error('<annotations> block was not injected!')
          if (!sawConversationsTag) throw new Error('<conversations> block was not injected!')
          if (!sawMcpServersTag) throw new Error('<mcp-servers> block was not injected!')
          if (!sawSketchupToolSchema) throw new Error('sketchup__eval_ruby tool was not bound to LLM!')
          if (!sawRegulationToolSchema) throw new Error('retrieve_regulation_chunks was not bound!')
          if (!sawEditImageToolSchema) throw new Error('edit_image_with_ref was not bound!')
          if (regulationHitCount < 1) throw new Error('retrieve_regulation_chunks returned 0 chunks!')
          if (!sawImagesEditsCall) throw new Error('/images/edits multipart API was not invoked!')
          if (!sawNextSuggestionsCall || receivedSuggestions.length !== 2) {
            throw new Error(`NextSuggestions failed: ${JSON.stringify(receivedSuggestions)}`)
          }
          if (!sawDistillCall || !distillResult.ok || !distillResult.updated) {
            throw new Error(`Distill failed: ${JSON.stringify(distillResult)}`)
          }

          const decFile = join(workspacesBase, 'proj_verify', 'project_decisions.md')
          const memFile = join(workspacesBase, 'proj_verify', 'memory.md')
          const regFile = join(workspacesBase, 'proj_verify', 'distill_registry.json')
          if (!existsSync(decFile) || !existsSync(memFile) || !existsSync(regFile)) {
            throw new Error('Distilled memory files were not written!')
          }
          const decText = readFileSync(decFile, 'utf8')
          if (!decText.includes('深胡桃木') || !decText.includes('不默认采用')) {
            throw new Error(`Unexpected project_decisions.md content: ${decText}`)
          }
          resolveAll()
        } catch (e) {
          rejectAll(e as Error)
        }
      } else if (ev.type === 'error') {
        clearTimeout(timeout)
        rejectAll(new Error(`Runtime error: ${ev.message}`))
      }
    })
  })

  child.kill()

  // ==================== 1.5 极速能力预检：非生图模型收到出图请求零 Token 立即回复 ====================
  {
    const fastChild = fork(runtimeJs, [], {
      env: {
        ...process.env,
        DESIGN_AGENT_SKILLS_ROOT: skillsRoot,
        DESIGN_AGENT_WORKSPACES_DIR: workspacesBase
      }
    })
    const llmTurnsBefore = llmTurn
    let fastReply = ''
    let fastDone = false
    await new Promise<void>((resFast, rejFast) => {
      const timer = setTimeout(() => rejFast(new Error('Fast image preflight timed out')), 10000)
      fastChild.on('message', (raw: unknown) => {
        const ev = raw as RuntimeOutbound
        if (ev.type === 'ready') {
          fastChild.send({
            type: 'chat',
            requestId: 'req_fast_fail',
            threadId: 'thread_fast_fail',
            text: '根据这个图纸生成一张夜景图，要求是人的视角，周围要有环境',
            rootDir: tempRoot,
            projectId: null,
            modelProfile: {
              ...mockProfile,
              model: 'deepseek-v4.1-flash'
            }
          })
        } else if (ev.type === 'token') {
          fastReply += ev.delta
        } else if (ev.type === 'done') {
          fastDone = true
          clearTimeout(timer)
          resFast()
        } else if (ev.type === 'error') {
          clearTimeout(timer)
          rejFast(new Error(`Fast fail test errored: ${ev.message}`))
        }
      })
    })
    fastChild.kill()
    if (!fastDone || llmTurn !== llmTurnsBefore || !fastReply.includes('效果图 / 图生图 API')) {
      throw new Error(
        `Fast image preflight failed: done=${fastDone}, llmDelta=${llmTurn - llmTurnsBefore}, reply=${fastReply}`
      )
    }
    console.log('✅ [Image Preflight] Non-image model immediate 0-token refusal PASSED!')
  }

  // ==================== 第二阶段：跨重启恢复 + 上下文压缩 + PPT 工作台局改提案 + 异步子任务 ====================
  const samplePptPath = join(tempRoot, 'sample_workbench.pptx')
  const pptZip = new JSZip()
  pptZip.file(
    'ppt/presentation.xml',
    '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>'
  )
  pptZip.file(
    'ppt/_rels/presentation.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'
  )
  pptZip.file(
    'ppt/slides/slide1.xml',
    '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="4" name="Title 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="457200"/><a:ext cx="9000000" cy="1200000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="3200" b="1"/><a:t>旧标题：概念方案</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  )
  writeFileSync(samplePptPath, await pptZip.generateAsync({ type: 'nodebuffer' }))

  const parsedDeck = await parsePptxDeck(new Uint8Array(readFileSync(samplePptPath)), false)
  if (parsedDeck.slides.length !== 1 || parsedDeck.slides[0].elements[0]?.elementId !== 'slide-1-el-4') {
    throw new Error(`parsePptxDeck failed: ${JSON.stringify(parsedDeck)}`)
  }

  let phase2Turn = 0
  let sawRestoredHistory = false
  let sawCompactedSummary = false
  let sawPptWorkbenchTag = false
  let sawSceneTag = false
  let sawPptTemplateRole = false
  let sawHostReadinessPrompt = false
  let sawWebSearchTool = false
  let sawAsyncTaskTools = false
  let receivedProposal: PptProposal | null = null

  // 启动第二套独立 mock HTTP 服务验证重启恢复 + 上下文压缩 + PPT 工作台 + 异步子任务
  const server2 = createServer((req, res) => {
    if (!req.url?.endsWith('/chat/completions') || req.method !== 'POST') {
      res.statusCode = 404
      res.end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body) as {
        messages: Array<{ role: string; content: unknown }>
        tools?: Array<{ function?: { name?: string } }>
      }
      const allText = JSON.stringify(parsed.messages)
      const sysText = parsed.messages
        .filter((m) => m.role === 'system')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n')

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })

      if (!parsed.tools && sysText.includes('上下文压缩器')) {
        res.write(
          sseChunk({
            id: 'cmp_1',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: '已确认茶室风格及无障碍规范，已交付 tea_room_v2.png。' }, finish_reason: 'stop' }]
          })
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      if (!parsed.tools && sysText.includes('下一步建议')) {
        res.write(
          sseChunk({
            id: 'sg2',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: '["导出最终PPTX"]' }, finish_reason: 'stop' }]
          })
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      // 判断是子智能体还是主对话
      if (sysText.includes('后台异步执行子智能体')) {
        res.write(
          sseChunk({
            id: 'as_sub_1',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: '异步子智能体研究完成：木饰面厚度 18mm。' }, finish_reason: 'stop' }]
          })
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      if (allText.includes('核对无障碍规范并参考历史茶室参数做局部改图')) sawRestoredHistory = true
      if (allText.includes('<context-summary')) sawCompactedSummary = true
      if (allText.includes('<ppt-workbench>')) sawPptWorkbenchTag = true
      if (allText.includes('<scene tool=')) sawSceneTag = true
      if (allText.includes('role=ppt_template')) sawPptTemplateRole = true
      if (parsed.tools?.some((t) => t.function?.name === 'web_search')) sawWebSearchTool = true
      if (
        parsed.tools?.some((t) => t.function?.name === 'start_async_task') &&
        parsed.tools?.some((t) => t.function?.name === 'check_async_task')
      ) {
        sawAsyncTaskTools = true
      }

      phase2Turn++
      if (phase2Turn === 1) {
        // 调用 ppt_workbench(read) + ppt_workbench(suggest) + start_async_task
        res.write(
          sseChunk({
            id: 'p2_1',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_wb_read',
                      type: 'function',
                      function: {
                        name: 'ppt_workbench',
                        arguments: JSON.stringify({ action: 'read', mode: 'elements', slideId: 'slide-1' })
                      }
                    },
                    {
                      index: 1,
                      id: 'call_wb_sug',
                      type: 'function',
                      function: {
                        name: 'ppt_workbench',
                        arguments: JSON.stringify({
                          action: 'suggest',
                          summary: '将封面标题优化为扬州清雅茶室概念方案',
                          operations: [
                            {
                              op: 'update_text',
                              slideId: 'slide-1',
                              elementId: 'slide-1-el-4',
                              text: '新标题：扬州清雅茶室'
                            }
                          ]
                        })
                      }
                    },
                    {
                      index: 2,
                      id: 'call_async_1',
                      type: 'function',
                      function: {
                        name: 'start_async_task',
                        arguments: JSON.stringify({
                          description: '整理木饰面节点',
                          prompt: '列出木饰面节点要求'
                        })
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ]
          })
        )
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.write(
          sseChunk({
            id: 'p2_2',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '已基于重启恢复的上下文提交 PPT 修改提案。' },
                finish_reason: 'stop'
              }
            ]
          })
        )
        res.write('data: [DONE]\n\n')
        res.end()
      }
    })
  })
  await new Promise<void>((r) => server2.listen(0, '127.0.0.1', () => r()))
  const addr2 = server2.address() as { port: number }
  const mockBaseUrl2 = `http://127.0.0.1:${addr2.port}/v1`

  const child2 = fork(runtimeJs, [], {
    env: {
      ...process.env,
      DESIGN_AGENT_SKILLS_ROOT: skillsRoot,
      DESIGN_AGENT_WORKSPACES_DIR: workspacesBase
    }
  })

  await new Promise<void>((resolveP2, rejectP2) => {
    const t2 = setTimeout(() => rejectP2(new Error('Phase 2 verification timed out')), 30000)
    child2.on('message', (raw: unknown) => {
      const ev = raw as RuntimeOutbound
      if (ev.type === 'ready') {
        // 使用相同的 threadId + transcriptPath（由 phase 1 生成），并调小 contextWindowTokens 触发压缩
        child2.send({
          type: 'chat',
          requestId: 'req_phase2_1',
          threadId: 'thread_full_1',
          text: '把 PPT 第1页标题改成新方案，同时后台跑一个节点研究',
          rootDir: tempRoot,
          projectId: 'proj_verify',
          transcriptPath,
          pptSelection: {
            documentPath: samplePptPath,
            currentSlideId: 'slide-1',
            references: [{ kind: 'element', slideId: 'slide-1', elementId: 'slide-1-el-4' }],
            referenceLabels: ['slide-1/slide-1-el-4']
          },
          filelist: [{ path: samplePptPath, name: 'tpl.pptx', role: 'ppt_template', size: 100 }],
          sceneParam: { toolTitle: '概念方案 PPT 策划生成', paramValues: { 风格: '新中式' } },
          mcpServers: [
            {
              name: 'fake-host',
              label: 'FakeHost',
              description: '模拟未启动的宿主',
              command: 'nonexistent_exe_zzz_12345',
              args: []
            }
          ],
          webSearchConfig: { enabled: true, provider: 'duckduckgo' },
          permissionMode: 'auto',
          modelProfile: {
            ...mockProfile,
            baseUrl: mockBaseUrl2,
            contextWindowTokens: 900
          }
        } satisfies RuntimeInbound)
      } else if (ev.type === 'ask_user') {
        if (ev.interaction === 'host-readiness') {
          sawHostReadinessPrompt = true
        }
        child2.send({
          type: 'user_answer',
          requestId: `ans_host_${Date.now()}`,
          threadId: 'thread_full_1',
          answers: [{ question: ev.questions[0]?.question ?? '', selected: ['跳过连接器，先直接对话'] }]
        })
      } else if (ev.type === 'ppt_proposal') {
        receivedProposal = ev.proposal
      } else if (ev.type === 'done') {
        clearTimeout(t2)
        resolveP2()
      } else if (ev.type === 'error') {
        clearTimeout(t2)
        rejectP2(new Error(`Phase 2 error: ${ev.message}`))
      }
    })
  })

  child2.kill()
  server2.close()

  if (!sawCompactedSummary) throw new Error('Auto context compaction (<context-summary>) did NOT trigger!')
  const archiveDir = join(tempRoot, '.design-agent', 'history-archive')
  const archiveFiles = existsSync(archiveDir) ? (await import('node:fs')).readdirSync(archiveDir) : []
  const archiveJoined = archiveFiles.map((f) => readFileSync(join(archiveDir, f), 'utf8')).join('\n')
  if (!sawRestoredHistory && !archiveJoined.includes('核对无障碍规范并参考历史茶室参数做局部改图')) {
    throw new Error('Cross-restart checkpoint did NOT restore prior conversation into runtime or archive!')
  }
  if (!sawPptWorkbenchTag) throw new Error('<ppt-workbench> context was not injected!')
  if (!sawSceneTag) throw new Error('<scene> params were not injected!')
  if (!sawPptTemplateRole) throw new Error('ppt_template role tag was not injected!')
  if (!sawHostReadinessPrompt) throw new Error('host-readiness interactive card was not emitted!')
  if (!sawWebSearchTool) throw new Error('web_search tool was not bound!')
  if (!sawAsyncTaskTools) throw new Error('Async subagent tools were not bound!')
  if (!receivedProposal) throw new Error('ppt_proposal event was not emitted!')

  const applyRes = await applyPptProposalToFile(receivedProposal)
  if (!applyRes.ok || applyRes.appliedCount !== 1) {
    throw new Error(`applyPptProposalToFile failed: ${JSON.stringify(applyRes)}`)
  }
  const patchedDeck = await parsePptxDeck(new Uint8Array(readFileSync(samplePptPath)), false)
  if (patchedDeck.slides[0].elements[0]?.text !== '新标题：扬州清雅茶室') {
    throw new Error(`Patched PPTX text mismatch: ${patchedDeck.slides[0].elements[0]?.text}`)
  }
  console.log('✅ [Phase 2: Restart Checkpoint + Compaction + PPT Workbench + Async Subagents + WebSearch] PASSED!')

  // Phase 3 & 4: 验证 (A) 工具中途停止后的历史闭合与继续执行; (B) 审批挂起时强杀进程 -> 重启后 resume_suspended_turn 断点续跑
  let abortContinueSawClosedToolMsg = false
  let suspendRestartSawToolOutput = false
  let server3Turn = 0
  let server4Turn = 0

  const server3 = createServer((req, res) => {
    if (!req.url?.endsWith('/chat/completions') || req.method !== 'POST') {
      res.statusCode = 404
      res.end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body) as {
        messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
        tools?: unknown[]
      }
      const sysText = parsed.messages
        .filter((m) => m.role === 'system')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n')

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })

      if (!parsed.tools && sysText.includes('下一步建议')) {
        res.write(
          sseChunk({
            id: 'sg3',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: '[]' }, finish_reason: 'stop' }]
          })
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      if (sysText.includes('Phase3Abort')) {
        // Never actually happens; differentiated by server port
      }

      server3Turn++
      if (server3Turn === 1) {
        res.write(
          sseChunk({
            id: 'ab_tc_1',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_abort_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ file_path: 'aborted_draft.txt', content: 'draft' })
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ]
          })
        )
      } else {
        abortContinueSawClosedToolMsg = parsed.messages.some(
          (m) => m.role === 'tool' && m.tool_call_id === 'call_abort_write'
        )
        res.write(
          sseChunk({
            id: 'ab_done_2',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '已从中断处继续完成任务。' },
                finish_reason: 'stop'
              }
            ]
          })
        )
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => server3.listen(0, '127.0.0.1', () => r()))
  const mockBaseUrl3 = `http://127.0.0.1:${(server3.address() as { port: number }).port}/v1`
  const abortTranscriptPath = join(tempRoot, 'transcript_abort.json')
  writeFileSync(abortTranscriptPath, '[]', 'utf8')

  const child3a = fork(runtimeJs, [], {
    env: { ...process.env, DESIGN_AGENT_SKILLS_ROOT: skillsRoot, DESIGN_AGENT_WORKSPACES_DIR: workspacesBase }
  })
  await new Promise<void>((resolveP3a, rejectP3a) => {
    const t = setTimeout(() => rejectP3a(new Error('Phase 3a abort timed out')), 20000)
    child3a.on('message', (raw: unknown) => {
      const ev = raw as RuntimeOutbound
      if (ev.type === 'ready') {
        child3a.send({
          type: 'chat',
          requestId: 'req_ab_1',
          threadId: 'thread_abort_1',
          text: '写一个草稿文件',
          rootDir: tempRoot,
          projectId: null,
          transcriptPath: abortTranscriptPath,
          permissionMode: 'default',
          modelProfile: { ...mockProfile, baseUrl: mockBaseUrl3 }
        } satisfies RuntimeInbound)
      } else if (ev.type === 'interrupt') {
        child3a.send({ type: 'abort', requestId: 'ab_now', threadId: 'thread_abort_1' })
      } else if (ev.type === 'aborted') {
        clearTimeout(t)
        resolveP3a()
      } else if (ev.type === 'error') {
        clearTimeout(t)
        rejectP3a(new Error(`Phase 3a error: ${ev.message}`))
      }
    })
  })
  child3a.kill()

  // 在新进程中点击「从中断处继续」发送续跑请求
  const child3b = fork(runtimeJs, [], {
    env: { ...process.env, DESIGN_AGENT_SKILLS_ROOT: skillsRoot, DESIGN_AGENT_WORKSPACES_DIR: workspacesBase }
  })
  await new Promise<void>((resolveP3b, rejectP3b) => {
    const t = setTimeout(() => rejectP3b(new Error('Phase 3b continue timed out')), 20000)
    child3b.on('message', (raw: unknown) => {
      const ev = raw as RuntimeOutbound
      if (ev.type === 'ready') {
        child3b.send({
          type: 'chat',
          requestId: 'req_ab_2',
          threadId: 'thread_abort_1',
          text: '请从上次中断的步骤继续执行剩余任务。',
          rootDir: tempRoot,
          projectId: null,
          transcriptPath: abortTranscriptPath,
          permissionMode: 'default',
          modelProfile: { ...mockProfile, baseUrl: mockBaseUrl3 }
        } satisfies RuntimeInbound)
      } else if (ev.type === 'done') {
        clearTimeout(t)
        resolveP3b()
      } else if (ev.type === 'error') {
        clearTimeout(t)
        rejectP3b(new Error(`Phase 3b error: ${ev.message}`))
      }
    })
  })
  child3b.kill()
  server3.close()
  if (!abortContinueSawClosedToolMsg) {
    throw new Error('Abort resume did NOT sanitize/close orphan tool_call_id before continuing!')
  }
  console.log('✅ [Phase 3: Mid-Turn Abort Sanitization & Continue Resume] PASSED!')

  // Phase 4: 审批挂起态杀进程重启 + resume_suspended_turn
  const server4 = createServer((req, res) => {
    if (!req.url?.endsWith('/chat/completions') || req.method !== 'POST') {
      res.statusCode = 404
      res.end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body) as {
        messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
        tools?: unknown[]
      }
      const sysText = parsed.messages
        .filter((m) => m.role === 'system')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n')

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })

      if (!parsed.tools && sysText.includes('下一步建议')) {
        res.write(
          sseChunk({
            id: 'sg4',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: '[]' }, finish_reason: 'stop' }]
          })
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      server4Turn++
      if (server4Turn === 1) {
        res.write(
          sseChunk({
            id: 'susp_tc_1',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_suspend_write',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          file_path: 'resumed_after_restart.txt',
                          content: 'RESTART_RESUME_OK'
                        })
                      }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ]
          })
        )
      } else {
        suspendRestartSawToolOutput = parsed.messages.some(
          (m) => m.role === 'tool' && m.tool_call_id === 'call_suspend_write'
        )
        res.write(
          sseChunk({
            id: 'susp_done_2',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '已在重启批准后完成文件写入。' },
                finish_reason: 'stop'
              }
            ],
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 80,
              total_tokens: 1280,
              prompt_tokens_details: { cached_tokens: 900 }
            }
          })
        )
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => server4.listen(0, '127.0.0.1', () => r()))
  const mockBaseUrl4 = `http://127.0.0.1:${(server4.address() as { port: number }).port}/v1`
  const suspendTranscriptPath = join(tempRoot, 'transcript_suspend.json')
  writeFileSync(suspendTranscriptPath, '[]', 'utf8')

  const child4a = fork(runtimeJs, [], {
    env: { ...process.env, DESIGN_AGENT_SKILLS_ROOT: skillsRoot, DESIGN_AGENT_WORKSPACES_DIR: workspacesBase }
  })
  await new Promise<void>((resolveP4a, rejectP4a) => {
    const t = setTimeout(() => rejectP4a(new Error('Phase 4a suspend timed out')), 20000)
    child4a.on('message', (raw: unknown) => {
      const ev = raw as RuntimeOutbound
      if (ev.type === 'ready') {
        child4a.send({
          type: 'chat',
          requestId: 'req_susp_1',
          threadId: 'thread_susp_1',
          text: '生成 resumed_after_restart.txt',
          rootDir: tempRoot,
          projectId: null,
          transcriptPath: suspendTranscriptPath,
          permissionMode: 'default',
          modelProfile: { ...mockProfile, baseUrl: mockBaseUrl4 }
        } satisfies RuntimeInbound)
      } else if (ev.type === 'interrupt') {
        clearTimeout(t)
        // 模拟在等待审批时直接关闭应用（强杀子进程）
        child4a.kill()
        resolveP4a()
      } else if (ev.type === 'error') {
        clearTimeout(t)
        rejectP4a(new Error(`Phase 4a error: ${ev.message}`))
      }
    })
  })

  // 重启全新子进程，发送 resume_suspended_turn（批准挂起的工具调用并继续后续循环）
  let sawResumedToolResult = false
  let doneUsage: { totalTokens: number; cacheReadTokens: number } | null = null
  const child4b = fork(runtimeJs, [], {
    env: { ...process.env, DESIGN_AGENT_SKILLS_ROOT: skillsRoot, DESIGN_AGENT_WORKSPACES_DIR: workspacesBase }
  })
  await new Promise<void>((resolveP4b, rejectP4b) => {
    const t = setTimeout(() => rejectP4b(new Error('Phase 4b resume_suspended_turn timed out')), 20000)
    child4b.on('message', (raw: unknown) => {
      const ev = raw as RuntimeOutbound
      if (ev.type === 'ready') {
        child4b.send({
          type: 'resume_suspended_turn',
          requestId: 'req_susp_1',
          threadId: 'thread_susp_1',
          rootDir: tempRoot,
          projectId: null,
          transcriptPath: suspendTranscriptPath,
          permissionMode: 'default',
          modelProfile: { ...mockProfile, baseUrl: mockBaseUrl4 },
          resolution: { kind: 'interrupt', decision: { type: 'approve', scope: 'once' } }
        } satisfies RuntimeInbound)
      } else if (ev.type === 'tool-result' && ev.name === 'write_file' && ev.ok) {
        sawResumedToolResult = true
      } else if (ev.type === 'done') {
        doneUsage = ev.usage ?? null
        clearTimeout(t)
        resolveP4b()
      } else if (ev.type === 'error') {
        clearTimeout(t)
        rejectP4b(new Error(`Phase 4b error: ${ev.message}`))
      }
    })
  })
  child4b.kill()
  server4.close()

  const resumedFilePath = join(tempRoot, 'resumed_after_restart.txt')
  if (!sawResumedToolResult || !existsSync(resumedFilePath)) {
    throw new Error('resume_suspended_turn did NOT execute the suspended write_file tool!')
  }
  if (readFileSync(resumedFilePath, 'utf8') !== 'RESTART_RESUME_OK') {
    throw new Error(`Unexpected resumed file content: ${readFileSync(resumedFilePath, 'utf8')}`)
  }
  if (!suspendRestartSawToolOutput) {
    throw new Error('Resumed agent loop did NOT pass ToolMessage result to LLM!')
  }
  if (!doneUsage || doneUsage.totalTokens < 1280 || doneUsage.cacheReadTokens !== 900) {
    throw new Error(`Usage & cacheReadTokens tracking mismatch: ${JSON.stringify(doneUsage)}`)
  }
  console.log('✅ [Phase 4: Kill-on-Interrupt + Restart resume_suspended_turn + Usage Tracking] PASSED!')

  server.close()
  rmSync(tempRoot, { recursive: true, force: true })

  console.log('✅ [Full Agent Pipeline] ALL CAPABILITIES PASSED!')
  console.log(`   - Regulation hits: ${regulationHitCount} chunks (from sample-regulations.json)`)
  console.log(`   - Delivered edited render: ${deliveredPath}`)
  console.log(`   - NextSuggestions emitted: ${JSON.stringify(receivedSuggestions)}`)
  console.log('   - Distilled files verified: project_decisions.md + memory.md + distill_registry.json')
  console.log('   - PPT Workbench XML patched text: 新标题：扬州清雅茶室')
  console.log('   - Event trace:', events.join(' -> '))
}

const run = process.argv.includes('--workspace-boundary-only')
  ? (async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), 'design-agent-boundary-verify-'))
      try {
        await verifyWorkspacePathBoundary(tempRoot)
        await verifyLocalLibraryBoundary(tempRoot)
      } finally {
        rmSync(tempRoot, { recursive: true, force: true })
      }
    })()
  : process.argv.includes('--hardening-only')
  ? (async () => {
      const tempRoot = mkdtempSync(join(tmpdir(), 'design-agent-hardening-verify-'))
      try {
        await verifyHardeningChecks(tempRoot)
      } finally {
        rmSync(tempRoot, { recursive: true, force: true })
      }
    })()
  : main()

run.catch((err) => {
  console.error('❌ Verification failed:', err)
  process.exit(1)
})

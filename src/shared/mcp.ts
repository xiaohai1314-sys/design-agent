export interface SelectedMcpConnector {
  name: string
  label: string
}

export const MCP_CONNECTOR_LABELS: Readonly<Record<string, string>> = {
  rhino: 'Rhino',
  sketchup: 'SketchUp',
  blender: 'Blender',
  '3dsmax': '3dsMax',
  photoshop: 'Photoshop',
  multicad: 'AutoCAD',
  'computer-use': 'ComputerUse'
}

export const MCP_CONNECTOR_REQUIREMENTS: Readonly<Record<string, string>> = {
  rhino: '支持 Rhino 8.29+',
  sketchup: '支持 SketchUp 2022+',
  blender: '支持 Blender 3.0+',
  '3dsmax': '支持 3dsMax 2023–2027',
  photoshop: '支持 Photoshop 2023+',
  multicad: '支持 AutoCAD 2018+/浩辰/中望',
  'computer-use': '操作浏览器，控制电脑屏幕'
}

export function mcpConnectorLabel(name: string): string {
  return MCP_CONNECTOR_LABELS[name] ?? name
}

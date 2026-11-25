import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

async function runMockSketchupMcp() {
  const server = new Server(
    { name: 'mock-sketchup-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'eval_ruby',
        description: '在 SketchUp 活动模型中执行 Ruby 代码',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Ruby 脚本源码' }
          },
          required: ['code']
        }
      }
    ]
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'eval_ruby') {
      const args = req.params.arguments || {}
      const code = String(args.code || '')
      return {
        content: [{ type: 'text', text: `SKETCHUP_OK: executed ${code.length} chars` }]
      }
    }
    throw new Error(`Unknown tool: ${req.params.name}`)
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

runMockSketchupMcp()

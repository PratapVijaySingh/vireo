import type { AppConfig } from '../config'
import {
  anthropicMessagesUrl,
  azureChatUrl,
  chatCompletionsUrl,
  geminiGenerateUrl,
  providerById
} from './providers'

export interface ToolCall {
  name: string
  arguments: unknown
}

export interface LlmTurn {
  skipped: boolean
  content: string | null
  toolCalls: ToolCall[]
  error?: string
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'update_test_plan',
      description: 'Submit a complete test-plan model. Do not invent credentials.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan: { type: 'object', additionalProperties: true }
        },
        required: ['plan']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Pause and ask the operator for missing credentials, request bodies, or the performance goal.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          questions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                prompt: { type: 'string' }
              },
              required: ['id', 'prompt']
            }
          }
        },
        required: ['questions']
      }
    }
  }
]

export { chatCompletionsUrl } from './providers'

export function llmReady(config: AppConfig): boolean {
  if (config.llmActive === 'ollama' && config.llmBaseUrl) return true
  return Boolean(config.llmApiKey)
}

export async function completeWithTools(config: AppConfig, messages: ChatMessage[]): Promise<LlmTurn> {
  if (!llmReady(config)) return { skipped: true, content: null, toolCalls: [] }
  const preset = providerById(config.llmActive) ?? providerById('openai')!
  try {
    if (preset.protocol === 'anthropic') return await anthropicTurn(config, messages)
    if (preset.protocol === 'gemini') return await geminiTurn(config, messages)
    return await openaiTurn(config, messages, preset.id === 'azure-openai')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { skipped: false, content: null, toolCalls: [], error: reason }
  }
}

async function openaiTurn(config: AppConfig, messages: ChatMessage[], azure: boolean): Promise<LlmTurn> {
  const url = azure
    ? azureChatUrl(config.llmBaseUrl, config.llmModel, config.llmApiVersion)
    : chatCompletionsUrl(config.llmBaseUrl)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.llmApiKey) headers[azure ? 'api-key' : 'Authorization'] = azure ? config.llmApiKey : `Bearer ${config.llmApiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.llmModel, temperature: 0.1, messages, tools: TOOLS }),
    signal: AbortSignal.timeout(45000)
  })
  return readTurn(response, (body) => {
    const parsed = body as {
      choices?: { message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[]
    }
    const message = parsed.choices?.[0]?.message
    return {
      content: message?.content ?? null,
      toolCalls: (message?.tool_calls ?? []).flatMap((call) => namedCall(call.function?.name, call.function?.arguments))
    }
  })
}

async function anthropicTurn(config: AppConfig, messages: ChatMessage[]): Promise<LlmTurn> {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n')
  const dialogue = messages.filter((message) => message.role !== 'system')
  const response = await fetch(anthropicMessagesUrl(config.llmBaseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.llmApiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: 4096,
      temperature: 0.1,
      system,
      messages: dialogue,
      tools: TOOLS.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters
      }))
    }),
    signal: AbortSignal.timeout(45000)
  })
  return readTurn(response, (body) => {
    const parsed = body as { content?: { type?: string; text?: string; name?: string; input?: unknown }[] }
    const blocks = parsed.content ?? []
    return {
      content: blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n') || null,
      toolCalls: blocks.filter((block) => block.type === 'tool_use').flatMap((block) => namedCall(block.name, block.input))
    }
  })
}

async function geminiTurn(config: AppConfig, messages: ChatMessage[]): Promise<LlmTurn> {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n')
  const contents = messages.filter((message) => message.role !== 'system').map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }]
  }))
  const response = await fetch(geminiGenerateUrl(config.llmBaseUrl, config.llmModel), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.llmApiKey
    },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      tools: [{
        functionDeclarations: TOOLS.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        }))
      }],
      generationConfig: { temperature: 0.1 }
    }),
    signal: AbortSignal.timeout(45000)
  })
  return readTurn(response, (body) => {
    const parsed = body as { candidates?: { content?: { parts?: { text?: string; functionCall?: { name?: string; args?: unknown } }[] } }[] }
    const parts = parsed.candidates?.[0]?.content?.parts ?? []
    return {
      content: parts.map((part) => part.text ?? '').join('\n') || null,
      toolCalls: parts.flatMap((part) => namedCall(part.functionCall?.name, part.functionCall?.args))
    }
  })
}

async function readTurn(response: Response, parse: (body: unknown) => { content: string | null; toolCalls: ToolCall[] }): Promise<LlmTurn> {
  const raw = await response.text()
  if (!response.ok) return { skipped: false, content: null, toolCalls: [], error: `LLM HTTP ${response.status}: ${raw.slice(0, 500)}` }
  const parsed = parse(raw ? JSON.parse(raw) as unknown : {})
  return { skipped: false, ...parsed }
}

function namedCall(name: string | undefined, args: unknown): ToolCall[] {
  if (!name) return []
  return [{ name, arguments: typeof args === 'string' ? parseArguments(args) : (args ?? {}) }]
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

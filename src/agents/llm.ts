import type { AppConfig } from '../config'

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

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '')
  if (trimmed.endsWith('/chat/completions')) return trimmed
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

export async function completeWithTools(config: AppConfig, messages: ChatMessage[]): Promise<LlmTurn> {
  if (!config.llmApiKey) return { skipped: true, content: null, toolCalls: [] }

  try {
    const response = await fetch(chatCompletionsUrl(config.llmBaseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.llmApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0.1,
        messages,
        tools: TOOLS
      }),
      signal: AbortSignal.timeout(45000)
    })
    const raw = await response.text()
    if (!response.ok) {
      return { skipped: false, content: null, toolCalls: [], error: `LLM HTTP ${response.status}: ${raw.slice(0, 500)}` }
    }
    const body = JSON.parse(raw) as {
      choices?: { message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[]
    }
    const message = body.choices?.[0]?.message
    const toolCalls = (message?.tool_calls ?? []).map((call) => ({
      name: call.function?.name ?? '',
      arguments: parseArguments(call.function?.arguments)
    })).filter((call) => call.name.length > 0)
    return { skipped: false, content: message?.content ?? null, toolCalls }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { skipped: false, content: null, toolCalls: [], error: reason }
  }
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

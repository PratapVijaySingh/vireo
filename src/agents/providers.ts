export type LlmEndpoint = 'hidden' | 'optional' | 'required'
export type LlmProtocol = 'openai' | 'anthropic' | 'gemini'

export interface LlmProviderPreset {
  id: string
  label: string
  protocol: LlmProtocol
  defaultBaseUrl: string
  defaultModel: string
  defaultApiVersion: string
  endpoint: LlmEndpoint
  keyOptional?: boolean
}

export interface StoredLlmProvider {
  apiKey: string
  model: string
  baseUrl: string
  apiVersion: string
}

export const LLM_PROVIDERS: LlmProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', protocol: 'openai', defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', defaultApiVersion: '', endpoint: 'hidden' },
  { id: 'azure-openai', label: 'Azure OpenAI', protocol: 'openai', defaultBaseUrl: '', defaultModel: '', defaultApiVersion: '2024-10-21', endpoint: 'required' },
  { id: 'anthropic', label: 'Claude', protocol: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-4-5', defaultApiVersion: '', endpoint: 'hidden' },
  { id: 'gemini', label: 'Gemini', protocol: 'gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.5-flash', defaultApiVersion: '', endpoint: 'hidden' },
  { id: 'groq', label: 'Groq', protocol: 'openai', defaultBaseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', defaultApiVersion: '', endpoint: 'hidden' },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', defaultBaseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini', defaultApiVersion: '', endpoint: 'hidden' },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', defaultBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', defaultApiVersion: '', endpoint: 'hidden' },
  { id: 'mistral', label: 'Mistral', protocol: 'openai', defaultBaseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest', defaultApiVersion: '', endpoint: 'hidden' },
  { id: 'together', label: 'Together', protocol: 'openai', defaultBaseUrl: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', defaultApiVersion: '', endpoint: 'hidden' },
  { id: 'xai', label: 'Grok', protocol: 'openai', defaultBaseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-3', defaultApiVersion: '', endpoint: 'hidden' },
  { id: 'fireworks', label: 'Fireworks', protocol: 'openai', defaultBaseUrl: 'https://api.fireworks.ai/inference/v1', defaultModel: 'accounts/fireworks/models/llama-v3p1-70b-instruct', defaultApiVersion: '', endpoint: 'hidden' },
  { id: 'perplexity', label: 'Perplexity', protocol: 'openai', defaultBaseUrl: 'https://api.perplexity.ai', defaultModel: 'sonar', defaultApiVersion: '', endpoint: 'hidden' },
  { id: 'ollama', label: 'Ollama', protocol: 'openai', defaultBaseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama3.1', defaultApiVersion: '', endpoint: 'optional', keyOptional: true },
  { id: 'custom', label: 'Other OpenAI-compatible', protocol: 'openai', defaultBaseUrl: '', defaultModel: '', defaultApiVersion: '', endpoint: 'required' }
]

export function providerById(id: string): LlmProviderPreset | undefined {
  return LLM_PROVIDERS.find((provider) => provider.id === id)
}

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '')
  if (trimmed.endsWith('/chat/completions')) return trimmed
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

export function azureChatUrl(endpoint: string, deployment: string, apiVersion: string): string {
  const base = endpoint.replace(/\/$/, '')
  if (base.includes('/chat/completions')) return base
  const version = apiVersion.trim() || '2024-10-21'
  return `${base}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(version)}`
}

export function anthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '')
  if (trimmed.endsWith('/messages')) return trimmed
  if (trimmed.endsWith('/v1')) return `${trimmed}/messages`
  return `${trimmed}/v1/messages`
}

export function geminiGenerateUrl(baseUrl: string, model: string): string {
  const trimmed = baseUrl.replace(/\/$/, '')
  if (trimmed.endsWith(':generateContent')) return trimmed
  return `${trimmed}/models/${encodeURIComponent(model)}:generateContent`
}

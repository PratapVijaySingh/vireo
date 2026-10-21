const form = document.querySelector('#job-form')
const formError = document.querySelector('#form-error')
const submitButton = document.querySelector('#submit')
const statusBar = document.querySelector('#status-bar')
const jobList = document.querySelector('#job-list')
const jobDetail = document.querySelector('#job-detail')

const state = {
  workbench: null,
  jobs: [],
  selectedId: null,
  detailStamp: ''
}

const ACTIVE = new Set(['intake', 'planning', 'validating', 'running', 'reviewing'])
const SAMPLE_SPEC = {
  openapi: '3.0.3',
  info: { title: 'Local health', version: '1.0.0' },
  servers: [{ url: 'http://127.0.0.1:4010' }],
  paths: {
    '/health': {
      get: {
        operationId: 'health',
        responses: { '200': { description: 'ok' } }
      }
    }
  }
}

form.addEventListener('change', (event) => {
  if (event.target.name === 'source') showSource(event.target.value)
  if (event.target.id === 'auth') showAuth(event.target.value)
})
form.addEventListener('submit', (event) => {
  event.preventDefault()
  void createJob()
})
document.querySelector('#sample-spec').addEventListener('click', () => {
  document.querySelector('#spec').value = JSON.stringify(SAMPLE_SPEC, null, 2)
})
document.querySelector('#spec-file').addEventListener('change', (event) => readFileInto(event.target, '#spec'))
document.querySelector('#har-file').addEventListener('change', (event) => readFileInto(event.target, '#har'))
jobList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-job-id]')
  if (!button) return
  state.selectedId = button.dataset.jobId
  state.detailStamp = ''
  renderList()
  void refreshSelected()
})
jobDetail.addEventListener('submit', (event) => {
  if (event.target.id !== 'answer-form') return
  event.preventDefault()
  void sendAnswers(event.target)
})

showSource('openapi')
showAuth('none')
void boot()

async function boot() {
  state.workbench = await api('/workbench')
  fillDefaults(state.workbench)
  renderStatus(state.workbench)
  await refreshJobs()
  window.setInterval(() => {
    if (state.jobs.some((job) => ACTIVE.has(job.status) || job.status === 'needs_input')) void refreshJobs()
  }, 1500)
  connectSocket()
}

function fillDefaults(workbench) {
  document.querySelector('#threads').value = workbench.defaultThreads
  document.querySelector('#threads').max = workbench.maxThreads
  document.querySelector('#ramp').value = workbench.defaultRampUpSec
  document.querySelector('#duration').value = workbench.defaultDurationSec
  document.querySelector('#duration').max = workbench.maxDurationSec
}

function renderStatus(workbench) {
  const hosts = workbench.allowedHosts.map((host) => `<span class="chip">${escapeHtml(host)}</span>`).join('')
  const jmeter = workbench.jmeterConfigured
    ? '<span class="chip good">JMeter ready</span>'
    : '<span class="chip warn">JMETER_BIN is not set</span>'
  const llm = workbench.llmConfigured
    ? '<span class="chip good">LLM planner on</span>'
    : '<span class="chip">Deterministic planner</span>'
  statusBar.innerHTML = `${jmeter}${llm}<span class="chip">Cap ${workbench.maxThreads} threads / ${workbench.maxDurationSec}s</span>${hosts}`
}

function showSource(source) {
  for (const panel of document.querySelectorAll('[data-panel]')) {
    panel.hidden = panel.dataset.panel !== source
  }
}

function showAuth(kind) {
  document.querySelector('#auth-bearer').hidden = kind !== 'bearer'
  document.querySelector('#auth-basic').hidden = kind !== 'basic'
}

async function readFileInto(input, selector) {
  const file = input.files?.[0]
  if (!file) return
  document.querySelector(selector).value = await file.text()
}

async function createJob() {
  formError.textContent = ''
  const source = new FormData(form).get('source')
  let payload
  try {
    payload = payloadFor(source)
  } catch (error) {
    formError.textContent = error.message
    return
  }
  const body = {
    source,
    payload,
    goal: goalFrom('#p95', '#error-rate'),
    load: {
      threads: numberValue('#threads'),
      rampUpSec: numberValue('#ramp'),
      durationSec: numberValue('#duration')
    }
  }
  const auth = authFrom()
  if (auth) body.auth = auth
  submitButton.disabled = true
  try {
    const job = await api('/jobs', { method: 'POST', body: JSON.stringify(body) })
    state.selectedId = job.id
    state.detailStamp = ''
    await refreshJobs()
  } catch (error) {
    formError.textContent = error.message
  } finally {
    submitButton.disabled = false
  }
}

function payloadFor(source) {
  if (source === 'journey') {
    const url = document.querySelector('#url').value.trim()
    if (!url) throw new Error('Enter the journey URL.')
    return { url, steps: document.querySelector('#steps').value.trim() }
  }
  const raw = document.querySelector(source === 'har' ? '#har' : '#spec').value.trim()
  if (!raw) throw new Error(source === 'har' ? 'Paste or upload a HAR file.' : 'Paste or upload a JSON spec.')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('That text is not JSON. Export the spec or HAR as JSON and try again.')
  }
}

function goalFrom(p95Selector, errorSelector) {
  const goal = {}
  const p95 = numberValue(p95Selector)
  const errorRate = numberValue(errorSelector)
  if (p95 != null) goal.p95Ms = p95
  if (errorRate != null) goal.errorRatePct = errorRate
  return goal
}

function authFrom() {
  const kind = document.querySelector('#auth').value
  if (kind === 'bearer') {
    const token = document.querySelector('#token').value
    return token ? { type: 'bearer', token } : { type: 'bearer' }
  }
  if (kind === 'basic') {
    return {
      type: 'basic',
      username: document.querySelector('#username').value,
      password: document.querySelector('#password').value
    }
  }
  return null
}

function numberValue(selector) {
  const raw = document.querySelector(selector).value.trim()
  if (raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

async function refreshJobs() {
  state.jobs = await api('/jobs')
  if (!state.selectedId && state.jobs[0]) state.selectedId = state.jobs[0].id
  renderList()
  await refreshSelected()
}

async function refreshSelected() {
  if (!state.selectedId) {
    jobDetail.innerHTML = '<p class="empty">Create a measurement to see the script, verdict, and report here.</p>'
    return
  }
  const job = await api(`/jobs/${state.selectedId}`)
  const stamp = JSON.stringify({
    id: job.id,
    status: job.status,
    updatedAt: job.updatedAt,
    verdict: job.verdict,
    error: job.error,
    questions: job.questions,
    history: job.history?.length
  })
  if (stamp === state.detailStamp) return
  state.detailStamp = stamp
  jobDetail.dataset.id = job.id
  jobDetail.innerHTML = renderDetail(job)
}

function renderList() {
  if (state.jobs.length === 0) {
    jobList.innerHTML = '<p class="empty">No runs yet.</p>'
    return
  }
  jobList.innerHTML = state.jobs.map((job) => `
    <button type="button" class="job-button ${job.id === state.selectedId ? 'selected' : ''}" data-job-id="${escapeHtml(job.id)}">
      <span>${escapeHtml(job.name || job.source)}<br><small>${escapeHtml(job.source)} · ${escapeHtml(formatTime(job.createdAt))}</small></span>
      <small>${escapeHtml(label(job.status))}</small>
    </button>
  `).join('')
}

function renderDetail(job) {
  const bannerClass = job.status === 'failed' ? 'failed' : (job.verdict || '')
  const headline = job.status === 'failed'
    ? job.error
    : (job.reason || `Status: ${label(job.status)}`)
  const questions = job.status === 'needs_input' ? answerForm(job) : ''
  const notes = (job.notes || []).map((note) => `<li>${escapeHtml(note)}</li>`).join('')
  const rows = (job.history || []).map((entry) => {
    const total = entry.metrics?.total
    return `<tr>
      <td>${entry.iteration}</td>
      <td>${escapeHtml(entry.verdict || '')}</td>
      <td>${total ? total.sampleCount : ''}</td>
      <td>${total ? `${total.errorPct.toFixed(1)}%` : ''}</td>
      <td>${total ? `${Math.round(total.pct2ResTime)} ms` : ''}</td>
      <td>${escapeHtml(entry.reason || '')}</td>
    </tr>`
  }).join('')
  const actions = [
    job.artifacts?.jmx ? `<a class="ghost" href="/files/${job.id}/plan.jmx">Download .jmx</a>` : '',
    job.artifacts?.report ? `<a class="ghost" href="/files/${job.id}/report/index.html" target="_blank" rel="noreferrer">Open HTML report</a>` : ''
  ].join('')
  return `
    <h2>${escapeHtml(job.name || 'Run')}</h2>
    <div class="meta">
      <span class="chip">${escapeHtml(label(job.status))}</span>
      <span class="chip">Iteration ${job.iteration || 0}</span>
      ${job.verdict ? `<span class="chip">${escapeHtml(label(job.verdict))}</span>` : ''}
    </div>
    <div class="banner ${bannerClass}">${escapeHtml(headline || 'Waiting to start.')}</div>
    ${questions}
    ${notes ? `<ul>${notes}</ul>` : ''}
    ${rows ? `<table><thead><tr><th>#</th><th>Verdict</th><th>Samples</th><th>Errors</th><th>p95</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    <div class="actions">${actions}</div>
  `
}

function answerForm(job) {
  const fields = job.questions.map((question) => {
    if (question.id === 'goal') {
      return `<p>${escapeHtml(question.prompt)}</p>
        <div class="grid">
          <label>p95 under (ms)<input name="p95Ms" type="number" min="1" step="1"></label>
          <label>Max error rate (%)<input name="errorRatePct" type="number" min="0" step="0.1"></label>
        </div>`
    }
    const secret = question.id === 'token' || question.id === 'password'
    return `<label>${escapeHtml(question.prompt)}
      <input name="${escapeHtml(question.id)}" ${secret ? 'type="password"' : ''} autocomplete="off">
    </label>`
  }).join('')
  return `<form id="answer-form" class="answer">${fields}<button type="submit">Continue</button></form>`
}

async function sendAnswers(answerFormElement) {
  const data = new FormData(answerFormElement)
  const answers = {}
  for (const [key, value] of data.entries()) {
    if (String(value).trim() !== '') answers[key] = String(value)
  }
  try {
    await api(`/jobs/${state.selectedId}`, { method: 'PATCH', body: JSON.stringify({ answers }) })
    state.detailStamp = ''
    await refreshJobs()
  } catch (error) {
    formError.textContent = error.message
  }
}

function connectSocket() {
  const socket = window.io?.({ transports: ['websocket', 'polling'] })
  if (!socket) return
  socket.on('jobs status', () => {
    void refreshJobs()
  })
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(body?.message || `Request failed (${response.status})`)
  return body
}

function label(value) {
  return String(value || '').replaceAll('_', ' ')
}

function formatTime(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }).format(new Date(value))
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]))
}

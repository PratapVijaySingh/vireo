# Using Vireo

Vireo is a local workbench that turns an API description into an Apache JMeter script, runs it, and reports whether the goal was met.

You give it one of three inputs:

- an OpenAPI or Postman document
- a HAR capture from the browser
- a URL plus a short list of steps, such as `click Export`

The workbench builds one test-plan model, writes a real `.jmx` file, and runs that file with the JMeter command line. It can revise a script defect and run again, up to three times. A slow application is reported as a performance finding. The reviewer does not delete requests or loosen the goal to force a pass.

This project is separate from the [Feather Wand JMeter plugin](https://jmeter.ai/products/feather-wand/). That plugin chats and edits a test plan inside the JMeter window. This workbench starts from a spec, a capture, or a journey and produces a run you can open later in JMeter.

The server binds to `127.0.0.1` and only calls hosts you allow. The default allowlist is `127.0.0.1` and `localhost`.

## 1. Install

You need:

- Node.js 20 or newer
- Apache JMeter 5.6 or a compatible 5.6 release
- Java, which JMeter requires. JMeter 5.6.3 runs on the Java 8 already present on many Windows machines

Optional:

- An OpenAI-compatible API key, if you want a model to adjust the plan. With no key, the workbench still builds, runs, and corrects scripts with fixed rules
- Playwright Chromium, only for the URL-and-journey source

```bash
git clone https://github.com/PratapVijaySingh/vireo.git
cd vireo
npm install
```

Install JMeter from the [Apache JMeter download page](https://jmeter.apache.org/download_jmeter.cgi) and unzip it. Remember the launcher path:

- Windows: `C:\apache-jmeter\bin\jmeter.bat`
- macOS or Linux: `/opt/apache-jmeter/bin/jmeter`

For journeys only:

```bash
npx playwright install chromium
```

## 2. Start

Windows Command Prompt:

```bat
set JMETER_BIN=C:\apache-jmeter\bin\jmeter.bat
npm start
```

Windows PowerShell:

```powershell
$env:JMETER_BIN = 'C:\apache-jmeter\bin\jmeter.bat'
npm start
```

macOS or Linux:

```bash
export JMETER_BIN=/opt/apache-jmeter/bin/jmeter
npm start
```

Open [http://127.0.0.1:3030](http://127.0.0.1:3030).

The status bar shows whether JMeter is ready, whether a model is configured, the load cap, and the allowed hosts. `JMETER_BIN` here is the launcher file. JMeter's own scripts expect `JMETER_BIN` to be a directory. The runner sets the child process to that directory so the launcher still starts.

Leave `LLM_API_KEY` unset for the first run. Add it later when you want the planner to use a model:

```powershell
$env:LLM_API_KEY = 'your-key'
$env:LLM_MODEL = 'gpt-4o-mini'
npm start
```

## 3. Allow the system you are testing

A run is refused with `Host … is not in ALLOWED_HOSTS` until the hostname is listed. Create `config/local.json` in the project folder. This file is gitignored and stays on your machine:

```json
{
  "allowedHosts": ["my-app.example.com"]
}
```

Those hosts are added to `127.0.0.1` and `localhost`. Restart `npm start` after editing the file. The new hostname appears as a chip in the status bar.

You can instead replace the whole list for one shell:

```powershell
$env:ALLOWED_HOSTS = '127.0.0.1,localhost,my-app.example.com'
npm start
```

When `ALLOWED_HOSTS` is set, it replaces the file list rather than merging with it. Only `http` and `https` URLs are accepted. The metadata address `169.254.169.254` is refused even if you add it.

Point the workbench only at systems you are allowed to test.

## 4. Run the local sample

This checks that JMeter and the UI work before you point them at a real app.

1. In another terminal, serve a tiny health endpoint, or use any HTTP server already listening on `127.0.0.1`.
2. In the UI, leave **OpenAPI or Postman** selected and click **Use local sample**. The sample calls `GET http://127.0.0.1:4010/health`.
3. Set a small load for the first try: 1 thread, 0 seconds ramp-up, 3 seconds duration.
4. Leave auth as **None yet**.
5. Click **Create and run**.

A completed sample looks like this: status `completed`, verdict `goal met`, a history row with samples and a p95, plus **Download .jmx** and **Open HTML report**.

One way to serve the sample target:

```bash
node --input-type=module -e "import http from 'node:http'; http.createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true})); }).listen(4010, '127.0.0.1')"
```

## 5. Choose a source

### OpenAPI or Postman

Paste the JSON document or upload the file. The document needs a server URL on the allowlist. The workbench reads up to 25 operations, turns `{id}` path parameters into `${id}` when an earlier call extracts `id`, `token`, or `access_token`, and adds a status check for the lowest successful response. Bearer, basic, and API-key header auth are detected from the spec. Request bodies come from examples or the schema. If a body is required and missing, the run pauses and asks for it.

Minimal document:

```json
{
  "openapi": "3.0.3",
  "info": { "title": "Local health", "version": "1.0.0" },
  "servers": [{ "url": "http://127.0.0.1:4010" }],
  "paths": {
    "/health": {
      "get": {
        "operationId": "health",
        "responses": { "200": { "description": "ok" } }
      }
    }
  }
}
```

A Postman collection is detected automatically and uses the same form. Requests need absolute URLs, or a base the collection already contains.

### HAR capture

In Chrome or Edge: DevTools, Network, record the actions, then **Save all as HAR with content**. Paste that JSON or upload the `.har` file.

The workbench keeps the primary site and drops static files plus common analytics hosts. A `Bearer` token in a request is lifted into the plan's auth and stored as a variable, so later calls reuse `${token}` instead of the raw secret. HTTP/2 pseudo-headers such as `:path` and `:method` are removed. JMeter speaks HTTP/1.1, and sending those names as normal headers makes many servers return 400.

A capture of a single-page app often contains only `GET /`. Clicks that stay in the browser do not become extra JMeter samplers.

### URL and journey

Enter an allowed base URL and one step per line. `then` and semicolons also separate steps.

```text
click Import
click Title
click Export
go to /account
fill ada@example.com into Email
```

| Step | What it does |
| --- | --- |
| `click Export` | Clicks a link or button with that visible name. `press` and `tap` work the same way. |
| `go to /account` | Opens a path on the same site. `open` and `visit` work the same way. |
| `fill ada@example.com into Email` | Types into the field with that label. `type` and `enter` work the same way. |

A step that does not start with a verb is treated as a click. `Export` means `click Export`.

The name must match text on the page. If it does not, the error lists the controls that were visible, and you can copy one of those names. Playwright Chromium must be installed. The recorder uses a headless browser, writes a HAR, and then follows the HAR rules above. It will not follow a link to a different host.

Journey steps exercise the page once so the HTTP calls can be copied into JMeter. The load test is the JMeter run after that, not the browser session.

## 6. Set the goal, the load, and credentials

**Goal**

- **p95 under (ms)** is the response-time limit. The default in the form is 500.
- **Max error rate (%)** is the failure budget. The default is 1.

Both are optional on the API. The form sends the values that are filled in. A run with no goal pauses and asks for one.

**Load**

| Field | Default | Cap |
| --- | --- | --- |
| Threads | 5 | 20 |
| Ramp-up (seconds) | 5 | |
| Duration (seconds) | 60 | 120 |

Values above the cap are reduced to the cap. Start with 1 thread and a few seconds while you confirm the script, then raise the load.

**Auth**

- **None yet** sends no credentials.
- **Bearer token** sends `Authorization: Bearer …`.
- **Basic auth** sends the username and password.

If the spec requires a token or a body and you leave it blank, the job stays on `needs_input`. Type the answer in the detail pane and resume. API clients send:

```json
{ "answers": { "token": "the-token", "p95Ms": "500" } }
```

Answer ids are `token`, `username`, `password`, `p95Ms`, `errorRatePct`, `goal` (a JSON object), and `body:0:0` for the first call's JSON body.

Tokens and passwords are shown as `***` on `GET /jobs`. They can still be written into `data/jobs/.../plan.jmx` on disk. Keep that folder private.

## 7. Read the result

The detail pane shows the status, the iteration, the verdict, planner notes, and a history table. **Download .jmx** saves the script. **Open HTML report** opens the JMeter dashboard for that run.

| Status | Meaning |
| --- | --- |
| `intake` | The document or journey is being read. |
| `needs_input` | A token, body, or goal is missing. Answer it to continue. |
| `planning` | The test plan is being finished. |
| `validating` | JMeter is loading the script with the thread group disabled, so no load is sent. |
| `running` | JMeter is sending the load. |
| `reviewing` | Results are being judged. |
| `completed` | The loop finished with a verdict. |
| `failed` | The run stopped on an error. The message is on the job. |

| Verdict | Meaning |
| --- | --- |
| `goal_met` | Error rate and p95 are inside the goal. |
| `script_defect` | Responses did not match the script. A safe correction, such as expecting `201` when every sample for that call was `201`, is applied and the plan runs again. |
| `performance_finding` | The script looks valid and the application missed the goal, usually because it was slow or most failures were server errors. |

The loop stops after three iterations. A defect that cannot be corrected safely completes as `script_defect` and leaves the scenario intact.

While a job is active, the page refreshes about every 1.5 seconds. A Socket.io client can also listen for `jobs status`.

## 8. Call the HTTP API

Create a run:

```bash
curl -s -X POST http://127.0.0.1:3030/jobs ^
  -H "Content-Type: application/json" ^
  -d "{\"source\":\"openapi\",\"payload\":{\"openapi\":\"3.0.3\",\"info\":{\"title\":\"Local health\",\"version\":\"1.0.0\"},\"servers\":[{\"url\":\"http://127.0.0.1:4010\"}],\"paths\":{\"/health\":{\"get\":{\"responses\":{\"200\":{\"description\":\"ok\"}}}}}},\"goal\":{\"p95Ms\":500,\"errorRatePct\":1},\"load\":{\"threads\":1,\"rampUpSec\":0,\"durationSec\":3}}"
```

On PowerShell, `Invoke-RestMethod` is easier:

```powershell
$body = @{
  source = 'openapi'
  payload = @{
    openapi = '3.0.3'
    info = @{ title = 'Local health'; version = '1.0.0' }
    servers = @(@{ url = 'http://127.0.0.1:4010' })
    paths = @{ '/health' = @{ get = @{ responses = @{ '200' = @{ description = 'ok' } } } } }
  }
  goal = @{ p95Ms = 500; errorRatePct = 1 }
  load = @{ threads = 1; rampUpSec = 0; durationSec = 3 }
} | ConvertTo-Json -Depth 8
Invoke-RestMethod http://127.0.0.1:3030/jobs -Method Post -ContentType 'application/json' -Body $body
```

Journey body:

```json
{
  "source": "journey",
  "payload": {
    "url": "https://my-app.example.com",
    "steps": "click Export"
  },
  "goal": { "p95Ms": 500, "errorRatePct": 1 },
  "load": { "threads": 1, "rampUpSec": 0, "durationSec": 15 }
}
```

| Request | Result |
| --- | --- |
| `GET /jobs` | List of runs. Secrets are redacted. |
| `GET /jobs/:id` | One run: status, iteration, verdict, history, questions, artifact paths. |
| `PATCH /jobs/:id` | Resume a `needs_input` run with `{ "answers": { ... } }`. |
| `GET /workbench` | Allowed hosts, caps, and whether JMeter and the model are configured. No secrets. |
| `GET /files/:id/plan.jmx` | Download the generated script. |
| `GET /files/:id/report/index.html` | JMeter HTML dashboard. |

`source` is `openapi`, `har`, or `journey`. For `openapi` and `har`, `payload` is the JSON document itself.

## 9. Where files go

Each run is a folder under `data/jobs/<id>/`:

| File | Contents |
| --- | --- |
| `job.json` | Status, verdict, and history. |
| `plan.json` | The test-plan model. |
| `plan.jmx` | The script JMeter ran. |
| `validate.jmx` | The same plan with the thread group disabled. |
| `iteration-N/results.jtl` | Raw sample log. |
| `iteration-N/report/index.html` | HTML dashboard. |

`data/` is gitignored. Delete a job folder when you no longer need the script or the report.

## 10. What the model does

With no `LLM_API_KEY`, the planner adds a 200 ms think time and a status assertion, and the reviewer applies fixed corrections. The UI says **Deterministic planner**.

With a key, two steps may call the model:

1. The planner, once, before the first run. It may submit a revised plan or ask you a question. It receives the plan with secrets replaced by `${provided}`.
2. The reviewer, only when a run is a script defect and the fixed rules did not already produce a patch.

The model cannot change the target host, invent a password, delete a call, drop an assertion, change the load during review, or loosen the goal. A plan that breaks those rules is discarded.

`LLM_BASE_URL` defaults to `https://api.openai.com/v1`. Any compatible chat-completions endpoint works. `LLM_MODEL` defaults to `gpt-4o-mini`.

## 11. Configuration reference

[config/default.json](../config/default.json) holds the shared defaults. `config/local.json` adds allowed hosts on your machine. Environment variables override both.

| Variable | Default | Purpose |
| --- | --- | --- |
| `JMETER_BIN` | empty | Path to `jmeter.bat` or `jmeter`. |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL. |
| `LLM_MODEL` | `gpt-4o-mini` | Model name. |
| `LLM_API_KEY` | empty | Key for the planner and reviewer. |
| `ALLOWED_HOSTS` | `127.0.0.1,localhost` | Comma-separated hostnames. Replaces the file list when set. |
| `MAX_THREADS` | `20` | Hard cap. |
| `MAX_DURATION_SEC` | `120` | Hard cap. |
| `PORT` | `3030` | UI and API port. |
| `HOST` | `127.0.0.1` | Bind address. |
| `DATA_DIR` | `data/jobs` | Job artifacts. |

`npm run dev` restarts the server when source files change. `npm start` does not.

## 12. Troubleshooting

**`JMETER_BIN is not set. The .jmx was written, but JMeter was not started.`**

Set `JMETER_BIN` to the launcher file and start the server again. The script is still in that job's folder.

**`Host example.com is not in ALLOWED_HOSTS.`**

Add the hostname to `config/local.json` and restart. Confirm the chip in the status bar before creating the run.

**`Playwright Chromium is not installed.`**

Run `npx playwright install chromium`, then create the journey again. The server does not need a restart.

**`No control matches "…" Visible controls: …`**

Use one of the listed names, for example `click Export`. A phrase that is not on the page will not be clicked.

**Every sample is HTTP 400 after a HAR or journey.**

Update to a build that drops HTTP/2 pseudo-headers. Headers whose names start with `:` must not be copied into the `.jmx`.

**Some samples are 403 while others are 200.**

The script reached the site, and the site refused part of the load. Check the history table. If most responses are 401 or 403, resume the job with the credential the app expects. A public page can also return 403 when the same request is repeated quickly.

**The HTML report link returns 404.**

The report exists after a run that produced a results log. A job that failed before JMeter started has a `.jmx` and no dashboard.

**Port 3030 is already in use.**

Stop the other `npm start`, or set `PORT` to a free port.

## 13. Develop

```bash
npm test
npm run typecheck
```

Tests cover the test-plan model, the JMX builder, OpenAPI, Postman, and HAR intake, the review loop, the HTTP API, and the UI shell. A live JMeter test runs when `JMETER_BIN` is set and is skipped otherwise.

## License

[MIT](../LICENSE)

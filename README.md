# Feathers Wand

Agents that write, run, and refine [Apache JMeter](https://jmeter.apache.org/) scripts for HTTP APIs and web apps you are allowed to test.

Give it an OpenAPI or Postman document, a HAR capture, or a URL plus a short journey. It turns that into one test-plan model, renders a real `.jmx` file, runs it with the JMeter CLI, and revises script defects from the results. A slow application is reported as a performance finding. The reviewer does not delete requests or loosen the goal to force a green result.

The UI is at [http://127.0.0.1:3030](http://127.0.0.1:3030) after you start the server.

## Requirements

- Node.js 20 or newer
- Apache JMeter 5.6, with `JMETER_BIN` pointing at `jmeter.bat` (Windows) or the `jmeter` launcher
- An OpenAI-compatible API key if you want the planner and reviewer to use a model. Without a key, the workbench still builds scripts, runs them, and applies deterministic corrections
- Playwright Chromium only for the URL-and-journey intake: `npx playwright install chromium`

## Run

```bash
npm install
set JMETER_BIN=C:\apache-jmeter\bin\jmeter.bat
set LLM_API_KEY=your-key
npm start
```

On macOS or Linux, export the same variables and point `JMETER_BIN` at the `jmeter` shell script. Then open [http://127.0.0.1:3030](http://127.0.0.1:3030).

`JMETER_BIN` in this project is the launcher file. JMeter's own scripts also read a `JMETER_BIN` variable, but they expect a directory. The runner sets the child process to that directory so the launcher still starts.

## Use the UI

1. Choose a source.
   - **OpenAPI or Postman:** paste or upload JSON.
   - **HAR:** paste or upload a capture. Static assets and common analytics hosts are dropped.
   - **URL and journey:** enter an allowed base URL and steps such as `click Login then go to /account`.
2. Set a goal (`p95` and/or max error rate) and a small load shape.
3. Add a bearer token or basic credentials when you already have them. If the spec requires auth and you leave it blank, the run pauses and asks.
4. Create the run. The detail pane shows each iteration, the verdict, a `.jmx` download, and the JMeter HTML report when one is produced.

Live updates arrive on the Socket.io event `jobs status`. The page also refreshes while a run is active.

## What a run decides

Each job stops after at most three iterations.

| Verdict | Meaning |
| --- | --- |
| `goal_met` | Error rate and p95 are inside the goal. |
| `script_defect` | The script did not match the responses. Safe corrections, such as expecting `201` when every sample was `201`, are applied and the plan is run again. |
| `performance_finding` | The script looks valid and the application missed the goal. |
| `needs_input` | A token, body, or goal is missing. Resume with `PATCH /jobs/:id`. |

## HTTP API

`POST /jobs`

```json
{
  "source": "openapi",
  "payload": { "openapi": "3.0.3" },
  "goal": { "p95Ms": 500, "errorRatePct": 1 },
  "load": { "threads": 5, "rampUpSec": 5, "durationSec": 60 },
  "auth": { "type": "bearer", "token": "optional" }
}
```

`source` is `openapi`, `har`, or `journey`. A journey payload is `{ "url": "http://127.0.0.1:4010", "steps": "click Login" }`.

- `GET /jobs` lists runs. Tokens and passwords are redacted.
- `GET /jobs/:id` returns status, iteration, verdict, history, and artifact paths.
- `PATCH /jobs/:id` with `{ "answers": { "token": "...", "p95Ms": "500" } }` resumes a run that is waiting for input.
- `GET /workbench` returns allowlist, load caps, and whether JMeter and the LLM are configured. It does not return secrets.
- `GET /files/:id/plan.jmx` downloads the generated script.
- `GET /files/:id/report/index.html` opens the JMeter dashboard.

## Configure

Defaults live in [config/default.json](config/default.json). Environment variables override them:

| Variable | Purpose |
| --- | --- |
| `JMETER_BIN` | Path to `jmeter.bat` or `jmeter` |
| `LLM_BASE_URL` | OpenAI-compatible base URL. Default `https://api.openai.com/v1` |
| `LLM_MODEL` | Model name. Default `gpt-4o-mini` |
| `LLM_API_KEY` | Key for the planner and reviewer |
| `ALLOWED_HOSTS` | Comma-separated hostnames. Default `127.0.0.1,localhost` |
| `MAX_THREADS` | Hard cap. Default `20` |
| `MAX_DURATION_SEC` | Hard cap. Default `120` |
| `PORT` | UI and API port. Default `3030` |
| `HOST` | Bind address. Default `127.0.0.1` |
| `DATA_DIR` | Job artifacts. Default `data/jobs` |

Only `http` and `https` targets are accepted. The link-local metadata address is refused even if it is added to the allowlist.

## Safety

This is a local performance-test workbench. A generated `.jmx` can contain the credentials you supplied, so keep `data/jobs` private and do not expose the port to the internet. Load stays inside the configured caps. Point it only at systems you are allowed to test.

## Development

```bash
npm test
npm run typecheck
```

Tests cover the test-plan model, the JMX builder, OpenAPI, Postman, and HAR intake, the review loop, the HTTP API, and the UI shell. A live JMeter test runs when `JMETER_BIN` is set.

## License

[MIT](LICENSE)

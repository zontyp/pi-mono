# PekChat Browser-Use Integration Plan

## Overview

Add a **mode-based routing** system to pekchat. A config file defines the active mode: `normal` or `browseruse`. In normal mode, everything works as it does today (messages go through pi-web-ui → pi-agent → LLM). In browseruse mode, every user message is sent to a browser-use server which executes it as a browser automation task and streams results back to the UI.

No intent classification. The mode is an explicit, user-configured switch.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  pi-web-ui (Frontend)                 │
│                                                      │
│  ChatPanel / AgentInterface                          │
│    │                                                 │
│    ▼                                                 │
│  User sends message                                  │
│    │                                                 │
│    ▼                                                 │
│  Read config → mode?                                 │
│    │                                                 │
│    ├── "normal"        → agent.prompt(message)       │
│    │                     (existing pi-agent flow)    │
│    │                                                 │
│    └── "browseruse"    → POST browser-use server     │
│                          /task { task: message }     │
│                          ← SSE stream of steps       │
│                          → render in chat UI         │
└──────────────────────────────────────────────────────┘
                              │
               ┌──────────────┴──────────────┐
               │                             │
               ▼                             ▼
     ┌──────────────────┐       ┌─────────────────────────┐
     │  LLM Provider    │       │  Browser-Use Server      │
     │  (normal mode)   │       │  (Python / FastAPI)      │
     │                  │       │                           │
     │  Anthropic,      │       │  - browser-use library    │
     │  OpenAI, etc.    │       │  - Playwright browser     │
     └──────────────────┘       │  - Streams steps via SSE  │
                                └─────────────────────────┘
```

---

## Config File

**Location**: `pekchat.config.json` (project root or configurable path)

```json
{
  "mode": "normal",
  "browseruse": {
    "serverUrl": "http://localhost:8000",
    "model": "gpt-4o",
    "headless": true
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `mode` | `"normal" \| "browseruse"` | `"normal"` | Active routing mode |
| `browseruse.serverUrl` | `string` | `"http://localhost:8000"` | Browser-use server URL |
| `browseruse.model` | `string` | `"gpt-4o"` | LLM model the browser-use agent uses for planning |
| `browseruse.headless` | `boolean` | `true` | Run browser headless or visible |

The frontend reads this config at startup and routes all messages accordingly.

---

## Components

### 1. Mode Router (Frontend)

**Location**: `packages/web-ui/src/mode-router.ts`

A thin routing layer that wraps message sending. Injected into or called before `agent.prompt()`.

```typescript
type Mode = "normal" | "browseruse";

interface PekChatConfig {
  mode: Mode;
  browseruse: {
    serverUrl: string;
    model: string;
    headless: boolean;
  };
}

async function routeMessage(
  message: string,
  config: PekChatConfig,
  agent: Agent,
  onBrowserStep: (step: BrowserStepMessage) => void,
  signal?: AbortSignal
): Promise<void> {
  if (config.mode === "normal") {
    await agent.prompt(message);
    return;
  }

  // browseruse mode — send entire message as a browser task
  const response = await fetch(`${config.browseruse.serverUrl}/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task: message,
      model: config.browseruse.model,
      headless: config.browseruse.headless,
    }),
    signal,
  });

  // Parse SSE stream, emit BrowserStepMessages
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE lines from buffer, emit steps via onBrowserStep
    // ... (SSE parsing logic)
  }
}
```

**Integration point**: Override or wrap the send behavior in `AgentInterface` or `ChatPanel`. When mode is `browseruse`, intercept the message before it reaches `agent.prompt()` and route to the browser-use server instead.

### 2. Browser-Use Python Server

**Location**: `services/browser-use/`

```
services/browser-use/
├── main.py           # FastAPI app
├── requirements.txt  # browser-use, fastapi, uvicorn, playwright
├── Dockerfile
└── README.md
```

**Endpoints**:

| Endpoint | Method | Description |
|---|---|---|
| `POST /task` | POST | `{ task, model?, headless? }` → SSE stream of steps |
| `POST /task/{id}/stop` | POST | Abort a running task |
| `GET /health` | GET | Health check |

**`main.py` sketch**:

```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from browser_use import Agent
from langchain_openai import ChatOpenAI
import asyncio
import json
import uuid

app = FastAPI()
active_tasks: dict[str, asyncio.Task] = {}

@app.post("/task")
async def run_task(request: TaskRequest):
    task_id = str(uuid.uuid4())

    async def stream():
        llm = ChatOpenAI(model=request.model or "gpt-4o")
        agent = Agent(task=request.task, llm=llm)

        # browser-use runs the task, we capture steps
        # and yield them as SSE events
        try:
            result = await agent.run()
            # Yield intermediate steps
            for step in agent.history:
                event = {
                    "type": "action",
                    "content": str(step),
                }
                yield f"event: step\ndata: {json.dumps(event)}\n\n"

            # Yield screenshots if available
            # ...

            yield f"event: result\ndata: {json.dumps({'type': 'done', 'summary': str(result)})}\n\n"
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")

@app.post("/task/{task_id}/stop")
async def stop_task(task_id: str):
    if task_id in active_tasks:
        active_tasks[task_id].cancel()
    return {"status": "stopped"}

@app.get("/health")
async def health():
    return {"status": "ok"}
```

**SSE event format**:
```
event: step
data: {"type": "thinking", "content": "Navigating to booking.com"}

event: step
data: {"type": "action", "action": "goto", "url": "https://booking.com"}

event: step
data: {"type": "screenshot", "base64": "iVBOR..."}

event: result
data: {"type": "done", "summary": "Opened booking.com successfully"}

event: error
data: {"type": "error", "message": "Timeout waiting for page load"}
```

### 3. Custom Message Type

**Location**: `packages/web-ui/src/components/browser-step-message.ts`

```typescript
interface BrowserStepMessage {
  role: "browser-step";
  stepType: "thinking" | "action" | "screenshot" | "done" | "error";
  content: string;
  screenshot?: string; // base64
  url?: string;
  timestamp: number;
}

declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    "browser-step": BrowserStepMessage;
  }
}
```

In browseruse mode, each SSE event from the server becomes a `BrowserStepMessage` appended to `agent.state.messages`.

### 4. Custom Message Renderer

**Location**: `packages/web-ui/src/components/renderers/browser-step-renderer.ts`

```typescript
registerMessageRenderer("browser-step", {
  render: (msg: BrowserStepMessage) => {
    if (msg.stepType === "screenshot") {
      return html`
        <div class="browser-step screenshot">
          <img src="data:image/png;base64,${msg.screenshot}" class="rounded border" />
        </div>`;
    }
    if (msg.stepType === "error") {
      return html`<div class="browser-step error text-red-500">${msg.content}</div>`;
    }
    if (msg.stepType === "done") {
      return html`<div class="browser-step done font-semibold">${msg.content}</div>`;
    }
    return html`<div class="browser-step">${msg.content}</div>`;
  },
});
```

### 5. Mode Selector UI (optional)

A toggle in the ChatPanel header or settings dialog to switch between `normal` and `browseruse` mode. Updates `pekchat.config.json` or an in-memory/storage setting.

```typescript
// Simple toggle in AgentInterface header
html`
  <select @change=${(e) => setMode(e.target.value)}>
    <option value="normal">Chat Mode</option>
    <option value="browseruse">Browser Mode</option>
  </select>
`;
```

---

## Implementation Order

### Phase 1: Browser-Use Python Server
1. Create `services/browser-use/` directory
2. Implement FastAPI app with `/task` SSE endpoint
3. Implement `/task/{id}/stop` and `/health`
4. Add `requirements.txt`: `browser-use`, `fastapi`, `uvicorn`, `playwright`, `langchain-openai`
5. Test: `curl -N -X POST localhost:8000/task -H 'Content-Type: application/json' -d '{"task":"open booking.com"}'`
6. Add Dockerfile

### Phase 2: Config + Mode Router
1. Define `PekChatConfig` type and `pekchat.config.json` schema
2. Implement config loading (from file or storage)
3. Implement `routeMessage()` with SSE parsing
4. Wire into `ChatPanel` / `AgentInterface` send path

### Phase 3: Custom Messages + Rendering
1. Define `BrowserStepMessage` custom message type
2. Register message renderer for `browser-step`
3. Map SSE events to `BrowserStepMessage` instances
4. Append to `agent.state.messages` as they arrive

### Phase 4: UI + Polish
1. Add mode toggle in UI (settings or header)
2. Abort support (cancel running browser tasks)
3. Error handling (server down, task timeout)
4. Screenshot size optimization
5. Session persistence for browser-step messages

---

## Configuration (Environment / Config File)

```json
// pekchat.config.json
{
  "mode": "normal",
  "browseruse": {
    "serverUrl": "http://localhost:8000",
    "model": "gpt-4o",
    "headless": true
  }
}
```

```bash
# Or via environment variables (override config file)
PEKCHAT_MODE=browseruse
BROWSER_USE_URL=http://localhost:8000
BROWSER_USE_MODEL=gpt-4o
BROWSER_USE_HEADLESS=true
```

---

## Dependencies

| Component | Technology | New? |
|---|---|---|
| Browser-Use server | Python, FastAPI, browser-use, Playwright | Yes |
| Mode router | TypeScript (frontend) | Yes (thin layer) |
| Config file | JSON | Yes |
| Custom messages | pi-agent-core CustomAgentMessages | No (existing extension point) |
| Message renderer | pi-web-ui registerMessageRenderer | No (existing renderer system) |

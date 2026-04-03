// ============================================================================
// pekserve API client — SSE streaming
// ============================================================================
// Talks to pekserve (Hono proxy on port 3000) which proxies to
// browser-use-api-server (FastAPI on port 8000).
//
// Implements:
//   - createSession()    — create a new browser-use session
//   - sendTaskStream()   — stream a task via SSE (step-by-step events)
//   - abortTask()        — abort a running task
// ============================================================================

const PEKSERVE_URL = "http://localhost:3000";

// ============================================================================
// SSE event types — match the events emitted by browser-use-api-server
// ============================================================================

/** One step of agent execution (navigate, click, type, etc.) */
export interface StepEvent {
  step: number;
  url: string;
  title: string;
  eval: string | null;       // evaluation of previous goal
  memory: string | null;     // agent's memory/notes
  next_goal: string | null;  // what the agent plans to do next
  actions: Record<string, any>[];  // list of actions taken (e.g. [{click: {index: 5}}])
}

/** Final result when the agent finishes a task */
export interface ResultEvent {
  ok: boolean;
  result: string;
}

/** Error event when something goes wrong */
export interface ErrorEvent {
  error: string;
}

// ============================================================================
// createSession — create a new browser-use session
// ============================================================================

/**
 * Create a new browser-use session.
 * Returns the session_id from browser-use-api-server.
 *
 * POST /sessions → { session_id: "abc123" }
 */
export async function createSession(): Promise<string> {
  const res = await fetch(`${PEKSERVE_URL}/sessions`, { method: "POST" });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create session: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.session_id;
}

// ============================================================================
// abortTask — cancel a running task
// ============================================================================
// Called when the user clicks the stop button. Tells the server-side agent
// to stop at the next step boundary.
// ============================================================================

export async function abortTask(sessionId: string): Promise<void> {
  const res = await fetch(`${PEKSERVE_URL}/sessions/${sessionId}/abort`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Abort failed: ${res.status} ${err}`);
  }
}

// ============================================================================
// sendTaskStream — SSE streaming task execution
// ============================================================================
// Connects to the SSE endpoint and calls callbacks as events arrive.
// Returns a promise that resolves when the stream ends.
//
// How SSE parsing works:
//   - SSE format: "event: <type>\ndata: <json>\n\n"
//   - We read chunks from the ReadableStream via fetch API
//   - Buffer partial chunks until we have complete events (split on "\n\n")
//   - Parse each complete event and call the appropriate callback
//
// Abort support:
//   - Pass an AbortSignal to cancel the fetch mid-stream
//   - When aborted, fetch throws an AbortError
//   - The caller (main.ts) handles this gracefully
//
// Usage:
//   const controller = new AbortController();
//   await sendTaskStream(sessionId, "search for hotels", {
//     onStep: (step) => { /* render step card in chat */ },
//     onResult: (result) => { /* render final result */ },
//     onError: (err) => { /* show error notification */ },
//   }, controller.signal);
// ============================================================================

export async function sendTaskStream(
  sessionId: string,
  task: string,
  callbacks: {
    onStep: (data: StepEvent) => void;
    onResult: (data: ResultEvent) => void;
    onError: (data: ErrorEvent) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${PEKSERVE_URL}/sessions/${sessionId}/tasks/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task }),
    signal, // abort fetch when signal fires
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Task stream failed: ${res.status} ${err}`);
  }

  // Read SSE stream via fetch ReadableStream API
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // Append the new chunk to the buffer.
    // { stream: true } tells TextDecoder not to flush — needed for
    // multi-byte characters that may be split across chunks.
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by double newlines.
    // Split to find complete events. The last element may be incomplete.
    const events = buffer.split("\n\n");
    buffer = events.pop()!; // keep incomplete part in buffer

    for (const eventBlock of events) {
      if (!eventBlock.trim()) continue;

      // Parse the SSE event block.
      // Format: "event: step\ndata: {...json...}"
      let eventType = "";
      let eventData = "";

      for (const line of eventBlock.split("\n")) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          eventData = line.slice(6);
        }
      }

      if (!eventType || !eventData) continue;

      const parsed = JSON.parse(eventData);

      // Dispatch to the appropriate callback
      switch (eventType) {
        case "step":
          callbacks.onStep(parsed as StepEvent);
          break;
        case "result":
          callbacks.onResult(parsed as ResultEvent);
          break;
        case "error":
          callbacks.onError(parsed as ErrorEvent);
          break;
      }
    }
  }
}

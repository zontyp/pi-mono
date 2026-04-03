// ============================================================================
// pekserve API client
// ============================================================================
// Talks to pekserve (Hono proxy on port 3000) which proxies to
// browser-use-api-server (FastAPI on port 8000).
//
// Currently implements:
//   - createSession() — create a new browser-use session
//   - sendTask()      — send a task (user message) to a session
// ============================================================================

const PEKSERVE_URL = "http://localhost:3000";

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

// ---------------------------------------------------------------------------
// sendTask — send a browser-use task to an existing session
// ---------------------------------------------------------------------------
// The user's chat message becomes the "task" string. browser-use-api-server
// decides whether it's the first task (creates a new Agent) or a follow-up
// (reuses the Agent with conversation history).
//
// Returns { ok: true, result: "..." } on success.
// Throws on network errors, 404 (session gone), 409 (task already running).
// ---------------------------------------------------------------------------

export interface SendTaskResponse {
  ok: boolean;
  result: string;
}

export async function sendTask(
  sessionId: string,
  task: string,
): Promise<SendTaskResponse> {
  const res = await fetch(`${PEKSERVE_URL}/sessions/${sessionId}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Task failed: ${res.status} ${err}`);
  }

  return await res.json();
}

// TODO: Add these in next phase
// export async function deleteSession(sessionId: string): Promise<void>
// export async function listSessions(): Promise<any[]>

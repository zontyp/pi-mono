// ============================================================================
// pekserve API client
// ============================================================================
// Talks to pekserve (Hono proxy on port 3000) which proxies to
// browser-use-api-server (FastAPI on port 8000).
//
// For now, only createSession() is implemented.
// sendTask(), deleteSession(), listSessions() will be added later.
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

// TODO: Add these in next phase
// export async function sendTask(sessionId: string, task: string): Promise<{ ok: boolean; result: string }>
// export async function deleteSession(sessionId: string): Promise<void>
// export async function listSessions(): Promise<any[]>

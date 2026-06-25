// ============================================================================
// pekserve API client — fastpekzho override
// ============================================================================
// Same-origin: the PekChat SPA and its pekserve API are served by ONE Hono
// process (behind Caddy), so the base URL is relative ("").
//
//   createSession(model) → POST /sessions { model }            → session_id
//   sendTask(id, task)   → POST /sessions/:id/tasks { task }   → { ok, result, model }
//
// Each session is bound server-side to a model ("glm" | "deepseek"), so the
// model is chosen once at session-creation time and every task on that session
// goes to the same warm agent.
// ============================================================================

const PEKSERVE_URL = "";

/**
 * Create a new conversation bound to a model.
 * @param model "glm" | "deepseek" — which warm agent should own this session.
 * POST /sessions { model } → { session_id, model }
 */
export async function createSession(model: string): Promise<string> {
	const res = await fetch(`${PEKSERVE_URL}/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model }),
	});

	if (!res.ok) {
		const err = await res.text();
		throw new Error(`Failed to create session: ${res.status} ${err}`);
	}

	const data = await res.json();
	return data.session_id;
}

export interface SendTaskResponse {
	ok: boolean;
	result: string;
	model?: string; // human label of the model that produced this reply
}

/**
 * Send the user's message to an existing (model-bound) session.
 * Throws on network errors, 404 (session gone), 409 (task already running).
 */
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

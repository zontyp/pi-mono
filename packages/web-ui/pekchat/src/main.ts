import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import {
	type AgentState,
	ApiKeyPromptDialog,
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	createJavaScriptReplTool,
	IndexedDBStorageBackend,
	// PersistentStorageDialog, // TODO: Fix - currently broken
	ProviderKeysStore,
	ProvidersModelsTab,
	ProxyTab,
	SessionListDialog,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { Bell, History, Plus, Settings } from "lucide";
import "./app.css";
import { createSession, sendTaskStream, abortTask } from "./api.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { createBrowserUseStep, createBrowserUseResult, createSystemNotification, customConvertToLlm, registerCustomMessageRenderers } from "./custom-messages.js";

// Register custom message renderers so the chat UI knows how to
// display our custom message types (step cards, result alerts, etc.)
registerCustomMessageRenderers();

// ============================================================================
// STORES & BACKEND — IndexedDB persistence for sessions, settings, etc.
// ============================================================================

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const configs = [
	settings.getConfig(),
	SessionsStore.getMetadataConfig(),
	providerKeys.getConfig(),
	customProviders.getConfig(),
	sessions.getConfig(),
];

const backend = new IndexedDBStorageBackend({
	dbName: "pi-web-ui-example",
	version: 2,
	stores: configs,
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

// ============================================================================
// APP STATE
// ============================================================================

let currentSessionId: string | undefined;  // IndexedDB session ID (for persistence)
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;

// Browser-use session ID from pekserve.
// Different from currentSessionId (IndexedDB). This is the server-side session
// that holds the browser connection and agent state.
// Set when user clicks '+', persisted in IndexedDB, restored on page reload.
let browserUseSessionId: string | null = null;

// AbortController for the current SSE stream.
// Used by agent.stop() to cancel the fetch mid-stream when
// the user clicks the stop button.
let abortController: AbortController | null = null;

// ============================================================================
// HELPERS
// ============================================================================

/** Generate a session title from the first user message (truncated to 50 chars) */
const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user" || m.role === "user-with-attachments");
	if (!firstUserMsg || (firstUserMsg.role !== "user" && firstUserMsg.role !== "user-with-attachments")) return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c: any) => c.type === "text");
		text = textBlocks.map((c: any) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

/** Check if session has enough messages to warrant saving (user + assistant) */
const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m: any) => m.role === "user" || m.role === "user-with-attachments");
	const hasAssistantMsg = messages.some((m: any) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

/** Save the current session to IndexedDB */
const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;

	const state = agent.state;
	if (state.messages.length === 0) return;

	try {
		// browserUseSessionId is persisted so it survives page refresh.
		// On reload, we restore it and can continue sending tasks to
		// the same server-side session (if the server is still running).
		const sessionData = {
			id: currentSessionId,
			title: currentTitle,
			model: state.model!,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages,
			browserUseSessionId,
			createdAt: new Date().toISOString(),
			lastModified: new Date().toISOString(),
		};

		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt: sessionData.createdAt,
			lastModified: sessionData.lastModified,
			messageCount: state.messages.length,
			usage: {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			modelId: state.model?.id || null,
			thinkingLevel: state.thinkingLevel,
			preview: generateTitle(state.messages),
		};

		await storage.sessions.save(sessionData, metadata);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

/** Update the URL with the session ID (for bookmarking / reload) */
const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

// ---------------------------------------------------------------------------
// extractTextFromPromptInput — pull plain text from agent.prompt() arguments
// ---------------------------------------------------------------------------
// agent.prompt() accepts multiple overloads:
//   - prompt("hello")                    → string
//   - prompt({ role: "user", content: "hello", ... })  → single AgentMessage
//   - prompt([msg1, msg2])               → array of AgentMessage
//
// We need to extract the user's text regardless of which overload was used.
// ---------------------------------------------------------------------------
const extractTextFromPromptInput = (input: string | AgentMessage | AgentMessage[]): string => {
	// Simple string — most common case (ChatPanel calls prompt("user text"))
	if (typeof input === "string") {
		return input;
	}

	// Array of messages — take text from the first user message
	if (Array.isArray(input)) {
		const firstUser = input.find((m) => m.role === "user");
		if (firstUser && "content" in firstUser && typeof firstUser.content === "string") {
			return firstUser.content;
		}
		return JSON.stringify(input);
	}

	// Single AgentMessage object
	if ("content" in input) {
		const content = (input as any).content;
		if (typeof content === "string") {
			return content;
		}
		if (Array.isArray(content)) {
			const textParts = content
				.filter((block: any) => block.type === "text")
				.map((block: any) => block.text || "");
			if (textParts.length > 0) {
				return textParts.join(" ");
			}
		}
	}

	return JSON.stringify(input);
};

// ============================================================================
// CREATE AGENT
// ============================================================================
// Sets up the pi-agent-core Agent instance and overrides agent.prompt()
// and agent.stop() to route messages through browser-use SSE streaming.

const createAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	agent = new Agent({
		initialState: initialState || {
			systemPrompt: `You are a helpful AI assistant with access to various tools.

Available tools:
- JavaScript REPL: Execute JavaScript code in a sandboxed browser environment (can do calculations, get time, process data, create visualizations, etc.)
- Artifacts: Create interactive HTML, SVG, Markdown, and text artifacts

Feel free to use these tools when needed to provide accurate and helpful responses.`,
			model: getModel("openai", "gpt-4o"),
			thinkingLevel: "off",
			messages: [],
			tools: [],
		},
		// Custom transformer: convert custom messages to LLM-compatible format
		convertToLlm: customConvertToLlm,
	});

	agentUnsubscribe = agent.subscribe((event: any) => {
		// Save session on message_end and agent_end events.
		if (event.type === "message_end" || event.type === "agent_end") {
			const messages = agent.state.messages;

			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
			}
			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();
				updateUrl(currentSessionId);
			}
			if (currentSessionId) {
				saveSession();
			}
			renderApp();
		}
	});

	await chatPanel.setAgent(agent, {
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyPromptDialog.prompt(provider);
		},
		toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
			const replTool = createJavaScriptReplTool();
			replTool.runtimeProvidersFactory = runtimeProvidersFactory;
			return [replTool];
		},
	});

	// ========================================================================
	// OVERRIDE agent.prompt() — route messages to browser-use SSE stream
	// ========================================================================
	//
	// How it works:
	//   1. ChatPanel → AgentInterface → sendMessage() calls agent.prompt(input)
	//   2. Our override intercepts this call
	//   3. Instead of sending to the LLM, we stream via pekserve SSE
	//   4. We manually manage agent.state.messages and isStreaming
	//
	// Why override instead of modifying library code:
	//   - Zero changes to MessageEditor, AgentInterface, or ChatPanel
	//   - The entire ChatPanel UI (input, attachments, stop button) works as-is
	//   - isStreaming=true makes the send arrow become a stop button automatically
	//
	// KNOWN LIMITATION:
	//   AgentInterface.sendMessage() checks for an API key BEFORE calling
	//   agent.prompt(). If no API key is configured, it will show an API key
	//   dialog. Enter any key — it won't be used since we bypass the LLM.
	// ========================================================================

	agent.prompt = async (input: string | AgentMessage | AgentMessage[]) => {
		const text = extractTextFromPromptInput(input);

		// --- Guard: no browser-use session ---
		if (!browserUseSessionId) {
			const notification = createSystemNotification(
				"No active session. Click '+' to create a browser-use session first.",
				"destructive",
			);
			agent.state.messages = [...agent.state.messages, notification];
			chatPanel.agentInterface?.requestUpdate();
			return;
		}

		// --- Add user message to chat ---
		agent.state.messages = [
			...agent.state.messages,
			{ role: "user" as const, content: text, timestamp: Date.now() },
		];
		chatPanel.agentInterface?.requestUpdate();

		// --- Show loading state (stop button) ---
		// isStreaming=true makes the send arrow become a stop button.
		// Cast needed because isStreaming is readonly on public AgentState type.
		(agent.state as any).isStreaming = true;
		chatPanel.agentInterface?.requestUpdate();

		// --- Create AbortController for this request ---
		// agent.stop() will call abortController.abort() to cancel mid-stream
		abortController = new AbortController();

		try {
			// --- Stream task via SSE ---
			await sendTaskStream(browserUseSessionId, text, {
				onStep: (data) => {
					// Each step becomes a card in the chat (real-time)
					const stepMsg = createBrowserUseStep(data);
					agent.state.messages = [...agent.state.messages, stepMsg];
					chatPanel.agentInterface?.requestUpdate();
				},
				onResult: (data) => {
					// Final result — success or failure alert
					const resultMsg = createBrowserUseResult(data);
					agent.state.messages = [...agent.state.messages, resultMsg];
					chatPanel.agentInterface?.requestUpdate();
				},
				onError: (data) => {
					// Server-side error — show as red notification
					const errorMsg = createSystemNotification(data.error, "destructive");
					agent.state.messages = [...agent.state.messages, errorMsg];
					chatPanel.agentInterface?.requestUpdate();
				},
			}, abortController.signal);

			// --- Title & session management ---
			if (!currentTitle) {
				currentTitle = generateTitle(agent.state.messages);
			}
			if (!currentSessionId) {
				currentSessionId = crypto.randomUUID();
				updateUrl(currentSessionId);
			}
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				// User clicked stop button — not a real error.
				// Show a friendly notification instead of a scary red alert.
				const notification = createSystemNotification("Task aborted by user.");
				agent.state.messages = [...agent.state.messages, notification];
			} else {
				// Real error: network failure, 404, 409, 500, etc.
				const errorNotification = createSystemNotification(
					`Browser task error: ${(err as Error).message}`,
					"destructive",
				);
				agent.state.messages = [...agent.state.messages, errorNotification];
			}
		} finally {
			// --- Cleanup ---
			abortController = null;
			(agent.state as any).isStreaming = false;
			chatPanel.agentInterface?.requestUpdate();
			// Always save — even on abort, we want to preserve the steps received so far
			await saveSession();
			renderApp();
		}
	};

	// ========================================================================
	// OVERRIDE agent.abort() — abort SSE stream + server-side agent
	// ========================================================================
	// Called when the user clicks the stop button in the ChatPanel.
	// Two things happen:
	//   1. Client-side: abort the fetch (stops reading SSE events)
	//   2. Server-side: call /abort endpoint (tells agent to stop at next step)
	// ========================================================================

	agent.abort = () => {
		// Cancel the fetch stream (client-side)
		if (abortController) {
			abortController.abort();
			abortController = null;
		}

		// Tell the server to stop the agent (server-side).
		// Fire-and-forget — abort() is sync, so we can't await.
		// The fetch abort already stopped the client; this just tells
		// the server to stop the agent at the next step boundary.
		if (browserUseSessionId) {
			abortTask(browserUseSessionId).catch((err) => {
				console.error("Abort request failed:", err);
			});
		}

		(agent.state as any).isStreaming = false;
		chatPanel.agentInterface?.requestUpdate();
	};
};

// ============================================================================
// LOAD SESSION — restore a session from IndexedDB
// ============================================================================

const loadSession = async (sessionId: string): Promise<boolean> => {
	if (!storage.sessions) return false;

	const sessionData = await storage.sessions.get(sessionId);
	if (!sessionData) {
		console.error("Session not found:", sessionId);
		return false;
	}

	currentSessionId = sessionId;
	const metadata = await storage.sessions.getMetadata(sessionId);
	currentTitle = metadata?.title || "";

	// Restore the browser-use session ID so the user can continue sending
	// tasks without clicking '+' again. If the server-side session is gone
	// (e.g. server restarted), sendTaskStream() will return 404 and we show an error.
	browserUseSessionId = (sessionData as any).browserUseSessionId || null;

	await createAgent({
		model: sessionData.model,
		thinkingLevel: sessionData.thinkingLevel,
		messages: sessionData.messages,
		tools: [],
	});

	updateUrl(sessionId);
	renderApp();
	return true;
};

/** Navigate to a fresh session (clears URL params and reloads) */
const newSession = () => {
	const url = new URL(window.location.href);
	url.search = "";
	window.location.href = url.toString();
};

// ============================================================================
// RENDER
// ============================================================================
const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-4 py-">
					<!-- Sessions list button -->
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SessionListDialog.open(
								async (sessionId) => {
									await loadSession(sessionId);
								},
								(deletedSessionId) => {
									if (deletedSessionId === currentSessionId) {
										newSession();
									}
								},
							);
						},
						title: "Sessions",
					})}

					<!-- New browser-use session button -->
					${Button({
						variant: "ghost",
						size: "sm",
						disabled: agent?.state?.isStreaming ?? false,
						children: icon(Plus, "sm"),
						onClick: async () => {
							try {
								// Call pekserve to create a new browser-use session
								const sessionId = await createSession();
								browserUseSessionId = sessionId;

								// Show confirmation in chat
								if (agent) {
									const notification = createSystemNotification(
										`New session created - ${sessionId}`,
									);
									agent.state.messages = [...agent.state.messages, notification];
									chatPanel.agentInterface?.requestUpdate();

									// Persist to IndexedDB immediately
									if (!currentSessionId) {
										currentSessionId = crypto.randomUUID();
										updateUrl(currentSessionId);
									}
									if (!currentTitle) {
										currentTitle = `Browser session ${sessionId}`;
									}
									await saveSession();
									renderApp();
								}
							} catch (err) {
								// Show error if pekserve is unreachable
								if (agent) {
									const notification = createSystemNotification(
										`Failed to create session: ${(err as Error).message}`,
										"destructive",
									);
									agent.state.messages = [...agent.state.messages, notification];
									chatPanel.agentInterface?.requestUpdate();
								}
							}
						},
						title: "New Session",
					})}

					<!-- Session title (editable) -->
					${
						currentTitle
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: currentTitle,
										className: "text-sm w-64",
										onChange: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
												await storage.sessions.updateTitle(currentSessionId, newTitle);
												currentTitle = newTitle;
											}
											isEditingTitle = false;
											renderApp();
										},
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
													await storage.sessions.updateTitle(currentSessionId, newTitle);
													currentTitle = newTitle;
												}
												isEditingTitle = false;
												renderApp();
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderApp();
											}
										},
									})}
								</div>`
								: html`<button
									class="px-2 py-1 text-sm text-foreground hover:bg-secondary rounded transition-colors"
									@click=${() => {
										isEditingTitle = true;
										renderApp();
										requestAnimationFrame(() => {
											const input = app?.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title="Click to edit title"
								>
									${currentTitle}
								</button>`
							: html`<span class="text-base font-semibold text-foreground">Pekchat</span>`
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					<theme-toggle></theme-toggle>
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () => SettingsDialog.open([new ProvidersModelsTab(), new ProxyTab()]),
						title: "Settings",
					})}
				</div>
			</div>

			<!-- Chat Panel -->
			${chatPanel}
		</div>
	`;

	render(appHtml, app);
};

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	// Show loading
	render(
		html`
			<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading...</div>
			</div>
		`,
		app,
	);

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Check for session in URL
	const urlParams = new URLSearchParams(window.location.search);
	const sessionIdFromUrl = urlParams.get("session");

	if (sessionIdFromUrl) {
		const loaded = await loadSession(sessionIdFromUrl);
		if (!loaded) {
			newSession();
			return;
		}
	} else {
		await createAgent();
	}

	renderApp();
}

initApp();

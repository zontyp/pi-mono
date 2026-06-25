// ============================================================================
// fastpekzho override — PekChat with a model switcher (GLM + DeepSeek)
// ============================================================================
// Left column = one row per model (GLM, DeepSeek). Click a row → the main window
// shows THAT model's conversation. Each model is its own "lane": an independent
// pi Agent + its own server-side session + its own message history. Switching
// lanes never mixes their memories.
//
// The LLM call itself happens server-side (our Hono server → z.ai / pekzho proxy);
// the browser never sees an API key. We reuse PekChat's proven pattern of
// overriding agent.prompt() to POST to pekserve instead of calling an LLM.
//
// In-memory only (per the MVP decision): no IndexedDB session persistence here —
// reloading the page starts fresh lanes. ChatPanel's own stores still init so the
// component is happy.
// ============================================================================

import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import {
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	createJavaScriptReplTool,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import "./app.css";
import { createSession, sendTask } from "./api.js";
import {
	createBrowserTaskResult,
	createSystemNotification,
	customConvertToLlm,
	registerCustomMessageRenderers,
} from "./custom-messages.js";

// 🌙 Dark mode by default. The theme is driven by a `dark` class on <html>
//    (Tailwind's dark selector + mini-lit's CSS vars key off it; the stylesheet's
//    light rules are written as `:root:not(.dark)`). We removed the top-bar theme
//    toggle, so just pin it on at startup — and write the stored key too, in case
//    any component reads it back.
document.documentElement.classList.add("dark");
try {
	localStorage.setItem("theme", "dark");
} catch {
	/* private-mode / storage-disabled — class alone is enough */
}

registerCustomMessageRenderers();

// ── 🗄️ Storage init (ChatPanel/AppStorage rely on it even though we don't
//    persist conversations ourselves) ─────────────────────────────────────────
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessionsStore = new SessionsStore();
const customProviders = new CustomProvidersStore();
const backend = new IndexedDBStorageBackend({
	dbName: "pi-web-ui-example",
	version: 2,
	stores: [
		settings.getConfig(),
		SessionsStore.getMetadataConfig(),
		providerKeys.getConfig(),
		customProviders.getConfig(),
		sessionsStore.getConfig(),
	],
});
settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessionsStore.setBackend(backend);
setAppStorage(
	new AppStorage(settings, providerKeys, sessionsStore, customProviders, backend),
);

// ── 🛤️ The model lanes ────────────────────────────────────────────────────────
type ModelKey = "glm" | "deepseek";
interface ModelLane {
	key: ModelKey;
	label: string; // sidebar + header + reply-bubble label
	blurb: string; // sidebar subtitle
	agent: Agent;
	browserUseSessionId: string | null; // server-side session id (lazily minted)
}

// Order here = order in the sidebar. GLM first (default selection).
const LANE_DEFS: { key: ModelKey; label: string; blurb: string }[] = [
	{ key: "glm", label: "GLM 5.2", blurb: "Zhipu · z.ai" },
	{ key: "deepseek", label: "DeepSeek V4 Flash", blurb: "OpenCode Go" },
];

const lanes: Partial<Record<ModelKey, ModelLane>> = {};
let activeKey: ModelKey = LANE_DEFS[0].key;
let chatPanel: ChatPanel;

// Options handed to ChatPanel.setAgent — identical for every lane.
const chatPanelOptions = () => ({
	// The LLM runs server-side, so PekChat never needs a real key. Return a
	// placeholder instead of popping the OpenAI key dialog.
	onApiKeyRequired: async (_provider: string) => "fastpekzho-unused",
	toolsFactory: (
		_agent: unknown,
		_agentInterface: unknown,
		_artifactsPanel: unknown,
		runtimeProvidersFactory: unknown,
	) => {
		const replTool = createJavaScriptReplTool();
		(replTool as any).runtimeProvidersFactory = runtimeProvidersFactory;
		return [replTool];
	},
});

// Pull plain text out of agent.prompt()'s several overloads.
const extractText = (input: string | AgentMessage | AgentMessage[]): string => {
	if (typeof input === "string") return input;
	if (Array.isArray(input)) {
		const firstUser = input.find((m) => m.role === "user");
		if (firstUser && "content" in firstUser && typeof firstUser.content === "string")
			return firstUser.content;
		return JSON.stringify(input);
	}
	if ("content" in input) {
		const content = (input as any).content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const parts = content
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text || "");
			if (parts.length) return parts.join(" ");
		}
	}
	return JSON.stringify(input);
};

// Drop a system note into a lane's transcript and repaint.
const pushNote = (
	agent: Agent,
	message: string,
	variant: "default" | "destructive" = "default",
) => {
	agent.state.messages = [...agent.state.messages, createSystemNotification(message, variant)];
	chatPanel.agentInterface?.requestUpdate();
};

// Build one lane: a fresh Agent whose prompt() routes to ITS model's session.
const makeLane = (def: { key: ModelKey; label: string; blurb: string }): ModelLane => {
	const agent = new Agent({
		initialState: {
			// This model is only a placeholder for ChatPanel — the real model lives
			// server-side and is chosen by the session we create with def.key. We DO
			// overwrite its id/name with the friendly label, because the chat input
			// area shows currentModel.id as a (now non-clickable) text label — so it
			// reads "GLM 5.2" / "DeepSeek V4 Flash" and follows the left-column pick.
			systemPrompt: "You are a helpful AI assistant.",
			model: { ...getModel("openai", "gpt-4o"), id: def.label, name: def.label } as any,
			thinkingLevel: "off",
			messages: [],
			tools: [],
		},
		convertToLlm: customConvertToLlm,
	});

	const lane: ModelLane = {
		key: def.key,
		label: def.label,
		blurb: def.blurb,
		agent,
		browserUseSessionId: null,
	};

	// 🔁 Route every message to OUR server instead of an LLM.
	agent.prompt = async (input: string | AgentMessage | AgentMessage[]) => {
		const text = extractText(input);

		// Lazily mint a server session bound to THIS lane's model on first send.
		if (!lane.browserUseSessionId) {
			try {
				lane.browserUseSessionId = await createSession(lane.key);
			} catch (err) {
				pushNote(
					agent,
					`Could not start a ${lane.label} session - backend unreachable. Please retry.`,
					"destructive",
				);
				return;
			}
		}

		// Show the user's message + a streaming state (turns send arrow → stop).
		agent.state.messages = [
			...agent.state.messages,
			{ role: "user" as const, content: text, timestamp: Date.now() },
		];
		(agent.state as any).isStreaming = true;
		chatPanel.agentInterface?.requestUpdate();

		try {
			const response = await sendTask(lane.browserUseSessionId, text);
			agent.state.messages = [
				...agent.state.messages,
				createBrowserTaskResult(text, response.result, response.ok, response.model || lane.label),
			];
		} catch (err) {
			// 404 = server restarted / session expired → forget it so the NEXT send
			// transparently mints a fresh one instead of erroring forever.
			if (String((err as Error).message).includes("404")) lane.browserUseSessionId = null;
			pushNote(agent, `${lane.label} error: ${(err as Error).message}`, "destructive");
		} finally {
			(agent.state as any).isStreaming = false;
			chatPanel.agentInterface?.requestUpdate();
			renderApp();
		}
	};

	return lane;
};

// Swap the main window over to a lane.
const switchTo = async (key: ModelKey) => {
	if (key === activeKey) return;
	activeKey = key;
	await chatPanel.setAgent(lanes[key]!.agent, chatPanelOptions());
	renderApp();
};

// ── 🎨 Render ────────────────────────────────────────────────────────────────
const renderApp = () => {
	const appEl = document.getElementById("app");
	if (!appEl) return;

	const sidebar = html`
		<div class="w-56 shrink-0 border-r border-border flex flex-col bg-background">
			<div class="px-4 py-3 text-xs font-semibold uppercase tracking-wide opacity-60">Pegzo</div>
			${LANE_DEFS.map(
				(def) => html`
					<button
						class="text-left px-4 py-3 border-b border-border transition-colors hover:bg-secondary ${activeKey === def.key
							? "bg-secondary"
							: ""}"
						@click=${() => switchTo(def.key)}
						title=${def.label}
					>
						<div class="text-sm ${activeKey === def.key ? "font-semibold" : ""}">${def.label}</div>
						<div class="text-xs opacity-60">${def.blurb}</div>
					</button>
				`,
			)}
		</div>
	`;

	// No top bar — the active model is shown by the left column + the label in the
	// chat input area, so the main pane is just the chat panel, full height.
	const main = html`
		<div class="flex-1 flex flex-col min-w-0">${chatPanel}</div>
	`;

	render(
		html`
			<div class="w-full h-screen flex bg-background text-foreground overflow-hidden">
				${sidebar}${main}
			</div>
		`,
		appEl,
	);
};

// ── 🚀 Init ──────────────────────────────────────────────────────────────────
async function initApp() {
	const appEl = document.getElementById("app");
	if (!appEl) throw new Error("App container not found");
	render(
		html`<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
			<div class="text-muted-foreground">Loading...</div>
		</div>`,
		appEl,
	);

	chatPanel = new ChatPanel();

	// Build both lanes up front so each keeps its own live history.
	for (const def of LANE_DEFS) lanes[def.key] = makeLane(def);

	// Open on the default lane (GLM).
	await chatPanel.setAgent(lanes[activeKey]!.agent, chatPanelOptions());
	renderApp();
}

initApp();

import { Alert } from "@mariozechner/mini-lit/dist/Alert.js";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentMessage, MessageRenderer } from "@mariozechner/pi-web-ui";
import { defaultConvertToLlm, registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import type { StepEvent, ResultEvent } from "./api.js";

// ============================================================================
// 1. CUSTOM MESSAGE TYPES (declaration merging with pi-agent-core)
// ============================================================================
//
// We define three custom message types:
//   - "system-notification"   — generic UI alerts (session created, errors, etc.)
//   - "browser-use-step"      — one step of agent execution (SSE step event)
//   - "browser-use-result"    — final result of a task (SSE result event)
//
// Declaration merging lets agent.state.messages accept these custom roles
// alongside the standard "user" / "assistant" / "tool-result" roles.
// ============================================================================

// --- System Notification ---------------------------------------------------

export interface SystemNotificationMessage {
	role: "system-notification";
	message: string;
	variant: "default" | "destructive";
	timestamp: string;
}

// --- Browser-Use Step ------------------------------------------------------
// Represents one step of agent execution. The agent navigates, clicks,
// types, etc. — each step produces one of these messages in the chat.

export interface BrowserUseStepMessage {
	role: "browser-use-step";
	step: number;              // step number (1, 2, 3, ...)
	url: string;               // current page URL
	title: string;             // current page title
	eval: string | null;       // agent's evaluation of previous goal
	memory: string | null;     // agent's memory/notes
	nextGoal: string | null;   // what the agent plans to do next
	actions: Record<string, any>[]; // actions taken (e.g. [{click: {index: 5}}])
	timestamp: string;
}

// --- Browser-Use Result ----------------------------------------------------
// Final result of a task — success or failure.

export interface BrowserUseResultMessage {
	role: "browser-use-result";
	ok: boolean;
	result: string;
	timestamp: string;
}

// Extend CustomAgentMessages via declaration merging.
// This must target pi-agent-core where CustomAgentMessages is defined.
declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		"system-notification": SystemNotificationMessage;
		"browser-use-step": BrowserUseStepMessage;
		"browser-use-result": BrowserUseResultMessage;
	}
}

// ============================================================================
// 2. RENDERERS
// ============================================================================

// --- System Notification Renderer ------------------------------------------

const systemNotificationRenderer: MessageRenderer<SystemNotificationMessage> = {
	render: (notification) => {
		return html`
			<div class="px-4">
				${Alert({
					variant: notification.variant,
					children: html`
						<div class="flex flex-col gap-1">
							<div>${notification.message}</div>
							<div class="text-xs opacity-70">${new Date(notification.timestamp).toLocaleTimeString()}</div>
						</div>
					`,
				})}
			</div>
		`;
	},
};

// --- Browser-Use Step Renderer ---------------------------------------------
// Shows a card for each agent step:
//   Step 1 • https://google.com
//   ✅ Successfully navigated to page
//   🎯 Type search query in search box
//   ▶ navigate: {"url":"https://google.com"}

const browserUseStepRenderer: MessageRenderer<BrowserUseStepMessage> = {
	render: (msg) => {
		// Format actions as human-readable strings.
		// Each action is like { click: { index: 5 } } or { input: { index: 2, text: "hello" } }
		// We show: "click: {"index":5}" — simple and debuggable.
		const actionStrings = msg.actions.map((a) => {
			const entries = Object.entries(a);
			if (entries.length === 0) return "unknown action";
			const [type, params] = entries[0];
			return `${type}: ${JSON.stringify(params)}`;
		});

		return html`
			<div class="px-4 py-1">
				<div class="rounded-lg border border-border bg-card p-3 text-sm">
					<!-- Header: step number + URL -->
					<div class="flex items-center gap-2 text-muted-foreground mb-1">
						<span class="font-mono font-bold">Step ${msg.step}</span>
						<span>•</span>
						<span class="truncate">${msg.url}</span>
					</div>
					<!-- Eval: how the agent judged the previous step -->
					${msg.eval ? html`<div class="text-foreground">✅ ${msg.eval}</div>` : ""}
					<!-- Next goal: what the agent plans to do -->
					${msg.nextGoal ? html`<div class="text-muted-foreground">🎯 ${msg.nextGoal}</div>` : ""}
					<!-- Actions: what the agent actually did -->
					<div class="mt-1 text-xs text-muted-foreground">
						${actionStrings.map((a) => html`<div class="font-mono">▶ ${a}</div>`)}
					</div>
				</div>
			</div>
		`;
	},
};

// --- Browser-Use Result Renderer -------------------------------------------
// Shows the final result with a success/failure indicator.

const browserUseResultRenderer: MessageRenderer<BrowserUseResultMessage> = {
	render: (msg) => {
		return html`
			<div class="px-4">
				${Alert({
					variant: msg.ok ? "default" : "destructive",
					children: html`
						<div class="flex flex-col gap-1">
							<div class="font-semibold">${msg.ok ? "✅ Task completed" : "❌ Task failed"}</div>
							<div class="whitespace-pre-wrap">${msg.result}</div>
						</div>
					`,
				})}
			</div>
		`;
	},
};

// ============================================================================
// 3. REGISTER RENDERERS
// ============================================================================

export function registerCustomMessageRenderers() {
	registerMessageRenderer("system-notification", systemNotificationRenderer);
	registerMessageRenderer("browser-use-step", browserUseStepRenderer);
	registerMessageRenderer("browser-use-result", browserUseResultRenderer);
}

// ============================================================================
// 4. HELPER FUNCTIONS — create custom messages from SSE events
// ============================================================================

/**
 * Create a system notification message for the chat.
 * Used for: session created, errors, abort confirmation, etc.
 */
export function createSystemNotification(
	message: string,
	variant: "default" | "destructive" = "default",
): SystemNotificationMessage {
	return {
		role: "system-notification",
		message,
		variant,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Create a browser-use step message from an SSE StepEvent.
 * Called in main.ts when an onStep callback fires.
 */
export function createBrowserUseStep(data: StepEvent): BrowserUseStepMessage {
	return {
		role: "browser-use-step",
		step: data.step,
		url: data.url,
		title: data.title,
		eval: data.eval,
		memory: data.memory,
		nextGoal: data.next_goal,  // snake_case from server → camelCase in UI
		actions: data.actions,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Create a browser-use result message from an SSE ResultEvent.
 * Called in main.ts when an onResult callback fires.
 */
export function createBrowserUseResult(data: ResultEvent): BrowserUseResultMessage {
	return {
		role: "browser-use-result",
		ok: data.ok,
		result: data.result,
		timestamp: new Date().toISOString(),
	};
}

// ============================================================================
// 5. CUSTOM MESSAGE TRANSFORMER
// ============================================================================

/**
 * Convert custom message types to standard LLM-compatible messages.
 *
 * This is needed because agent.state.messages can contain our custom types
 * (system-notification, browser-use-step, browser-use-result) which the
 * LLM doesn't understand. We convert them to plain user messages with
 * XML-like tags so the LLM could understand them if needed.
 *
 * Currently all messages go to browser-use (not an LLM), so this is
 * mainly for future-proofing and the pi-agent-core pipeline.
 */
export function customConvertToLlm(messages: AgentMessage[]): Message[] {
	const processed = messages.map((m): AgentMessage => {
		// System notifications → user message with <system> tags
		if (m.role === "system-notification") {
			const notification = m as SystemNotificationMessage;
			return {
				role: "user",
				content: `<system>${notification.message}</system>`,
				timestamp: Date.now(),
			};
		}

		// Browser-use steps → user message with <browser-step> tags
		if (m.role === "browser-use-step") {
			const step = m as BrowserUseStepMessage;
			return {
				role: "user",
				content: `<browser-step step="${step.step}" url="${step.url}">${step.eval || ""}</browser-step>`,
				timestamp: Date.now(),
			};
		}

		// Browser-use results → user message with <browser-result> tags
		if (m.role === "browser-use-result") {
			const result = m as BrowserUseResultMessage;
			return {
				role: "user",
				content: `<browser-result ok="${result.ok}">${result.result}</browser-result>`,
				timestamp: Date.now(),
			};
		}

		return m;
	});

	return defaultConvertToLlm(processed);
}

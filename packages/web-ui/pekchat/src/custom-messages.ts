import { icon } from "@mariozechner/mini-lit";
import { Alert } from "@mariozechner/mini-lit/dist/Alert.js";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentMessage, MessageRenderer } from "@mariozechner/pi-web-ui";
import { defaultConvertToLlm, registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { Globe } from "lucide";

// ============================================================================
// 1. CUSTOM MESSAGE TYPES (declaration merging with pi-agent-core)
// ============================================================================
//
// We define two custom message types:
//   - "system-notification"  — generic UI alerts (session created, errors, etc.)
//   - "browser-task-result"  — result of a browser-use task sent via pekserve
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

// --- Browser Task Result ---------------------------------------------------
// Rendered with a Globe icon badge so the user can distinguish browser-use
// responses from regular assistant messages.

export interface BrowserTaskResultMessage {
	role: "browser-task-result";
	task: string;       // the original user input that triggered this task
	result: string;     // the text result returned by browser-use
	ok: boolean;        // whether the task succeeded
	sessionId: string;  // browser-use session ID (for display / debugging)
	timestamp: string;
}

// Extend CustomAgentMessages interface via declaration merging.
// This must target pi-agent-core where CustomAgentMessages is defined.
declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		"system-notification": SystemNotificationMessage;
		"browser-task-result": BrowserTaskResultMessage;
	}
}

// ============================================================================
// 2. CREATE CUSTOM RENDERER (TYPED TO SystemNotificationMessage)
// ============================================================================

const systemNotificationRenderer: MessageRenderer<SystemNotificationMessage> = {
	render: (notification) => {
		// notification is fully typed as SystemNotificationMessage!
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

// ============================================================================
// 2b. BROWSER TASK RESULT RENDERER
// ============================================================================
// Shows the result of a browser-use task with a Globe icon badge.
// Green border (default variant) for success, red (destructive) for failure.
// ============================================================================

const browserTaskResultRenderer: MessageRenderer<BrowserTaskResultMessage> = {
	render: (msg) => {
		return html`
			<div class="px-4">
				${Alert({
					variant: msg.ok ? "default" : "destructive",
					children: html`
						<div class="flex flex-col gap-1">
							<!-- Header: Globe icon + label + session ID for debugging -->
							<div class="flex items-center gap-2 text-xs font-medium opacity-70">
								${icon(Globe, "sm")}
								<span>Browser Task Result</span>
								<span class="font-mono">[${msg.sessionId}]</span>
							</div>
							<!-- The actual result text from browser-use -->
							<div class="whitespace-pre-wrap">${msg.result}</div>
							<div class="text-xs opacity-70">${new Date(msg.timestamp).toLocaleTimeString()}</div>
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
	registerMessageRenderer("browser-task-result", browserTaskResultRenderer);
}

// ============================================================================
// 4. HELPER TO CREATE CUSTOM MESSAGES
// ============================================================================

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
 * Create a browser-task-result message for the chat.
 *
 * @param task   - the original user input (e.g. "Go to google.com")
 * @param result - the text result from browser-use
 * @param ok     - whether the task succeeded
 * @param sessionId - the browser-use session ID
 */
export function createBrowserTaskResult(
	task: string,
	result: string,
	ok: boolean,
	sessionId: string,
): BrowserTaskResultMessage {
	return {
		role: "browser-task-result",
		task,
		result,
		ok,
		sessionId,
		timestamp: new Date().toISOString(),
	};
}

// ============================================================================
// 5. CUSTOM MESSAGE TRANSFORMER
// ============================================================================

/**
 * Custom message transformer that extends defaultConvertToLlm.
 *
 * Converts our custom message types into standard user messages so the LLM
 * can understand them if the conversation is ever sent to an LLM.
 * (Currently all messages go to browser-use, but this keeps things future-proof.)
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

		// Browser task results → user message with <browser-task-result> tags
		if (m.role === "browser-task-result") {
			const taskResult = m as BrowserTaskResultMessage;
			return {
				role: "user",
				content: `<browser-task-result session="${taskResult.sessionId}" ok="${taskResult.ok}">${taskResult.result}</browser-task-result>`,
				timestamp: Date.now(),
			};
		}

		return m;
	});

	return defaultConvertToLlm(processed);
}

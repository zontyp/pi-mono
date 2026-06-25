// ============================================================================
// fastpekzho override — custom chat message types + renderers
// ============================================================================
// Two custom message roles flow through agent.state.messages:
//   - "system-notification" — generic UI alerts (session errors, etc.)
//   - "browser-task-result" — a reply produced by a warm pi agent via pekserve
//
// We keep the upstream "browser-task-result" role name (so the renderer plumbing
// is unchanged), but it now carries the responding model's LABEL instead of a
// browser session id, and the bubble shows that label in its bottom-right corner.
// ============================================================================

import { Alert } from "@mariozechner/mini-lit/dist/Alert.js";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentMessage, MessageRenderer } from "@mariozechner/pi-web-ui";
import { defaultConvertToLlm, registerMessageRenderer } from "@mariozechner/pi-web-ui";
import { html } from "lit";

// --- System Notification ---------------------------------------------------

export interface SystemNotificationMessage {
	role: "system-notification";
	message: string;
	variant: "default" | "destructive";
	timestamp: string;
}

// --- Model Reply ------------------------------------------------------------
// `model` is the human label (e.g. "GLM 5.2" / "DeepSeek V4 Flash") shown
// bottom-right so the user always knows who answered.

export interface BrowserTaskResultMessage {
	role: "browser-task-result";
	task: string; // the original user input that triggered this reply
	result: string; // the assistant's text
	ok: boolean; // whether the call succeeded
	model: string; // human label of the responding model
	timestamp: string;
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		"system-notification": SystemNotificationMessage;
		"browser-task-result": BrowserTaskResultMessage;
	}
}

// ── Renderers ────────────────────────────────────────────────────────────────

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

// 💬 A model reply: just the text, with timestamp (left) + model name (right).
const browserTaskResultRenderer: MessageRenderer<BrowserTaskResultMessage> = {
	render: (msg) => {
		return html`
			<div class="px-4">
				${Alert({
					variant: msg.ok ? "default" : "destructive",
					children: html`
						<div class="flex flex-col gap-1">
							<div class="whitespace-pre-wrap">${msg.result}</div>
							<!-- Bottom-left, stacked: timestamp on top, model name below it. -->
							<div class="flex flex-col text-xs opacity-70">
								<span>${new Date(msg.timestamp).toLocaleTimeString()}</span>
								<span class="font-mono">${msg.model}</span>
							</div>
						</div>
					`,
				})}
			</div>
		`;
	},
};

export function registerCustomMessageRenderers() {
	registerMessageRenderer("system-notification", systemNotificationRenderer);
	registerMessageRenderer("browser-task-result", browserTaskResultRenderer);
}

// ── Helpers to mint custom messages ──────────────────────────────────────────

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

/** Create a model-reply message for the chat. */
export function createBrowserTaskResult(
	task: string,
	result: string,
	ok: boolean,
	model: string,
): BrowserTaskResultMessage {
	return {
		role: "browser-task-result",
		task,
		result,
		ok,
		model,
		timestamp: new Date().toISOString(),
	};
}

// ── Custom → LLM transformer (future-proofing; LLM is server-side today) ──────

export function customConvertToLlm(messages: AgentMessage[]): Message[] {
	const processed = messages.map((m): AgentMessage => {
		if (m.role === "system-notification") {
			const notification = m as SystemNotificationMessage;
			return {
				role: "user",
				content: `<system>${notification.message}</system>`,
				timestamp: Date.now(),
			};
		}
		if (m.role === "browser-task-result") {
			const reply = m as BrowserTaskResultMessage;
			return {
				role: "user",
				content: `<model-reply model="${reply.model}" ok="${reply.ok}">${reply.result}</model-reply>`,
				timestamp: Date.now(),
			};
		}
		return m;
	});

	return defaultConvertToLlm(processed);
}

import "dotenv/config";
import { WebSocket } from "ws";
import { hostname } from "os";
import { randomUUID } from "crypto";
import { WSMessage, Msg, JobStatus, AgentState, StreamMetadata } from "@warm-room-manager/shared";
import { OBSManager } from "./obs-manager";

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? "ws://localhost:8080/agent";
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? "dev-shared-token";
const AGENT_ID = process.env.AGENT_ID || `agent-${hostname()}-${randomUUID().slice(0, 8)}`;
const AGENT_NAME = process.env.AGENT_NAME || hostname();
const VERSION = "0.1.0";

let ws: WebSocket | null = null;
let state: AgentState = "OFFLINE";
let currentJobId: string | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatIntervalMs = 3000;
let obsManager: OBSManager | null = null;

function connect() {
	console.log(`Agent ${AGENT_NAME} connecting to ${ORCHESTRATOR_URL}...`);

	// Initialize OBS Manager
	obsManager = new OBSManager();

	ws = new WebSocket(ORCHESTRATOR_URL);

	ws.on("open", () => {
		state = "IDLE";
		const hello: WSMessage = {
			type: Msg.AgentHello,
			msgId: randomUUID(),
			ts: new Date().toISOString(),
			agentId: AGENT_ID,
			payload: {
				agentId: AGENT_ID,
				name: AGENT_NAME,
				version: VERSION,
				capabilities: { slots: 1 },
				drain: false,
				activeJob: currentJobId ? { jobId: currentJobId, status: "RUNNING" as JobStatus } : null,
				auth: { token: AGENT_TOKEN },
			},
		};
		ws?.send(JSON.stringify(hello));
	});

	ws.on("message", (raw) => {
		let msg: WSMessage<any>;
		try {
			msg = JSON.parse(String(raw));
		} catch {
			return;
		}

		switch (msg.type) {
			case Msg.OrchestratorHelloOk: {
				const p = msg.payload as {
					heartbeatIntervalMs: number;
					heartbeatTimeoutMs: number;
					stopGraceMs: number;
					killAfterMs: number;
				};
				heartbeatIntervalMs = p.heartbeatIntervalMs;
				startHeartbeat();
				break;
			}
			case Msg.OrchestratorAssignStart: {
				onAssignStart(msg);
				break;
			}
			case Msg.OrchestratorJobStop: {
				onJobStop(msg);
				break;
			}
			case Msg.OrchestratorJobMute: {
				onJobMute(msg);
				break;
			}
			case Msg.OrchestratorJobUnmute: {
				onJobUnmute(msg);
				break;
			}
			default:
				break;
		}
	});

	ws.on("close", async () => {
		console.log("Connection closed. Reconnecting in 3s...");
		stopHeartbeat();
		state = "OFFLINE";

		// Clean up OBS processes
		if (obsManager) {
			try {
				await obsManager.disconnect();
			} catch (error) {
				console.error('Error cleaning up OBS on disconnect:', error);
			}
		}

		setTimeout(connect, 3000);
	});

	ws.on("error", (err) => {
		console.error("WS error:", err);
	});
}

function send<T = unknown>(type: string, payload: T, correlationId?: string) {
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	const msg: WSMessage<T> = {
		type,
		msgId: randomUUID(),
		correlationId: correlationId ?? null,
		ts: new Date().toISOString(),
		agentId: AGENT_ID,
		payload,
	};
	ws.send(JSON.stringify(msg));
}

function startHeartbeat() {
	stopHeartbeat();
	heartbeatTimer = setInterval(() => {
		send(Msg.AgentHeartbeat, {
			metrics: {},
		});
	}, heartbeatIntervalMs);
}

function stopHeartbeat() {
	if (heartbeatTimer) clearInterval(heartbeatTimer);
	heartbeatTimer = null;
}

// Real OBS and FFmpeg streaming
async function startStreamingJob(jobId: string, streamMetadata?: StreamMetadata) {
	try {
		console.log(`Starting streaming job ${jobId}`);
		console.log(`Stream metadata received:`, JSON.stringify(streamMetadata, null, 2));

		if (!obsManager) {
			throw new Error('OBS Manager not initialized');
		}

		if (!streamMetadata?.youtube?.streamUrl || !streamMetadata?.youtube?.streamKey) {
			console.error('Missing YouTube stream configuration for FFmpeg:', {
				hasStreamMetadata: !!streamMetadata,
				hasYoutube: !!streamMetadata?.youtube,
				streamUrl: streamMetadata?.youtube?.streamUrl,
				streamKey: streamMetadata?.youtube?.streamKey
			});
			throw new Error('Missing YouTube stream configuration for FFmpeg');
		}

		// Determine scene name from stream metadata
		let sceneName = 'Scene';
		if (streamMetadata.streamContext?.sheet) {
			if (streamMetadata.streamContext.sheet === 'vibe') {
				sceneName = 'Vibe Scene';
			} else {
				sceneName = `Sheet ${streamMetadata.streamContext.sheet} Scene`;
			}
		}

		// Start OBS if not already running
		if (!obsManager.isOBSConnected()) {
			await obsManager.startOBS();
		}

		// Start streaming to YouTube
		await obsManager.startStreaming({
			streamUrl: streamMetadata.youtube.streamUrl,
			streamKey: streamMetadata.youtube.streamKey
		}, sceneName);

		console.log(`Streaming job ${jobId} started successfully (OBS Virtual Camera + FFmpeg)`);
		send(Msg.AgentJobUpdate, { jobId, status: "RUNNING" as JobStatus });

	} catch (error) {
		console.error(`Failed to start streaming job ${jobId}:`, error);
		send(Msg.AgentJobStopped, {
			jobId,
			status: "FAILED" as const,
			error: {
				code: "STREAMING_FAILED",
				message: error instanceof Error ? error.message : "Unknown error"
			}
		});
	}
}

async function stopStreamingJob(jobId: string, reason?: string) {
	try {
		console.log(`Stopping streaming job ${jobId}. Reason: ${reason ?? "n/a"}`);

		if (obsManager) {
			await obsManager.stopStreaming();
			await obsManager.stopFFmpegStream();
		}

		currentJobId = null;
		send(Msg.AgentJobStopped, { jobId, status: "STOPPED" as const });

	} catch (error) {
		console.error(`Error stopping streaming job ${jobId}:`, error);
		send(Msg.AgentJobStopped, {
			jobId,
			status: "FAILED" as const,
			error: {
				code: "STOP_FAILED",
				message: error instanceof Error ? error.message : "Unknown error"
			}
		});
	}
}

function onAssignStart(
	msg: WSMessage<{
		jobId: string;
		idempotencyKey: string;
		config: unknown;
		expiresAt: string;
		metadata?: Record<string, unknown>;
		streamMetadata?: StreamMetadata;
	}>
) {
	const { jobId, config, streamMetadata } = msg.payload;

	console.log(`Received job assignment for ${jobId}`);
	console.log(`Assignment payload:`, JSON.stringify(msg.payload, null, 2));

	if (state !== "IDLE" || currentJobId) {
		send(Msg.AgentAssignAck, { jobId, accepted: false, reason: "busy" }, msg.msgId);
		return;
	}

	currentJobId = jobId;
	state = "STARTING";
	send(Msg.AgentAssignAck, { jobId, accepted: true }, msg.msgId);

	// Start streaming job asynchronously
	startStreamingJob(jobId, streamMetadata);
}

function onJobStop(msg: WSMessage<{ jobId: string; reason?: string; deadlineMs?: number }>) {
	const { jobId, reason } = msg.payload;
	if (!currentJobId || currentJobId !== jobId) return;
	stopStreamingJob(jobId, reason);
}

async function onJobMute(msg: WSMessage<{ jobId: string }>) {
	const { jobId } = msg.payload;
	if (!currentJobId || currentJobId !== jobId) return;

	try {
		console.log(`Muting audio for job ${jobId}`);

		if (obsManager) {
			await obsManager.muteAudio();
		}

		// Send acknowledgment back to orchestrator
		send(Msg.AgentJobMute, { jobId, success: true });
	} catch (error) {
		console.error(`Failed to mute job ${jobId}:`, error);
		send(Msg.AgentJobMute, { jobId, success: false });
	}
}

async function onJobUnmute(msg: WSMessage<{ jobId: string }>) {
	const { jobId } = msg.payload;
	if (!currentJobId || currentJobId !== jobId) return;

	try {
		console.log(`Unmuting audio for job ${jobId}`);

		if (obsManager) {
			await obsManager.unmuteAudio();
		}

		// Send acknowledgment back to orchestrator
		send(Msg.AgentJobUnmute, { jobId, success: true });
	} catch (error) {
		console.error(`Failed to unmute job ${jobId}:`, error);
		send(Msg.AgentJobUnmute, { jobId, success: false });
	}
}

connect();

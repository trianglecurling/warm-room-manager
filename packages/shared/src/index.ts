export type AgentState = "OFFLINE" | "IDLE" | "RESERVED" | "STARTING" | "RUNNING" | "STOPPING" | "ERROR" | "DRAINING";

export type JobStatus =
	| "CREATED"
	| "PENDING"
	| "ASSIGNED"
	| "ACCEPTED"
	| "STARTING"
	| "RUNNING"
	| "STOPPING"
	| "STOPPED"
	| "FAILED"
	| "CANCELED"
	| "UNKNOWN"
	| "DISMISSED";

export interface AgentInfo {
	id: string;
	name: string;
	version: string;
	state: AgentState;
	currentJobId?: string | null;
	lastSeenAt: string;
	drain: boolean;
	capabilities: { slots: number; maxResolution?: string };
	meta?: Record<string, unknown>;
	error?: { code: string; message: string } | null;
}

export interface YouTubeMetadata {
	broadcastId?: string;
	streamId?: string;
	streamKey?: string;
	streamUrl?: string;
	privacyStatus?: "public" | "private" | "unlisted";
	scheduledStartTime?: string;
	actualStartTime?: string;
	actualEndTime?: string;
	concurrentViewers?: number;
	totalViewers?: number;
	likeCount?: number;
	dislikeCount?: number;
	commentCount?: number;
	channelId?: string;
	videoId?: string;
}

export interface StreamContext {
	context?: string; // e.g., "Tournament", "League", etc.
	drawNumber?: number; // Optional draw number
	sheet?: 'A' | 'B' | 'C' | 'D' | 'vibe'; // Sheet identifier or 'vibe' for Vibe Stream
	team1?: string; // First team name
	team2?: string; // Second team name
	// Note: Date is always today's date, no need to specify
}

export interface StreamMetadata {
	title?: string;
	description?: string;
	viewers?: number;
	publicUrl?: string;
	adminUrl?: string;
	isMuted?: boolean;
	isPaused?: boolean;
	autoStopEnabled?: boolean;
	autoStopMinutes?: number;
	autoStopAt?: string;
	streamId?: string;
	platform?: string; // e.g., "youtube", "twitch", etc.
	youtube?: YouTubeMetadata;
	streamContext?: StreamContext; // New field for stream generation
}

export interface Job {
	id: string;
	templateId?: string | null;
	inlineConfig?: Record<string, unknown> | null;
	status: JobStatus;
	agentId?: string | null;
	createdAt: string;
	updatedAt: string;
	startedAt?: string | null;
	endedAt?: string | null;
	error?: { code: string; message: string; detail?: unknown } | null;
	requestedBy: string;
	idempotencyKey?: string;
	restartPolicy?: "never" | "onFailure";
	streamMetadata?: StreamMetadata;
}

export interface WSMessage<T = unknown> {
	type: string;
	msgId: string;
	correlationId?: string | null;
	ts: string;
	agentId?: string | null;
	payload: T;
}

export const Msg = {
	AgentHello: "agent.hello",
	AgentHeartbeat: "agent.heartbeat",
	AgentAssignAck: "agent.assign.ack",
	AgentJobUpdate: "agent.job.update",
	AgentJobLog: "agent.job.log",
	AgentJobStopped: "agent.job.stopped",
	AgentError: "agent.error",
	AgentJobMute: "agent.job.mute",
	AgentJobUnmute: "agent.job.unmute",
	AgentJobPaused: "agent.job.paused",
	AgentJobUnpaused: "agent.job.unpaused",
	AgentRebootAck: "agent.reboot.ack",

	OrchestratorHelloOk: "orchestrator.hello.ok",
	OrchestratorAssignStart: "orchestrator.assign.start",
	OrchestratorJobStop: "orchestrator.job.stop",
	OrchestratorJobKill: "orchestrator.job.kill",
	OrchestratorJobMute: "orchestrator.job.mute",
	OrchestratorJobUnmute: "orchestrator.job.unmute",
	OrchestratorJobPause: "orchestrator.job.pause",
	OrchestratorJobUnpause: "orchestrator.job.unpause",
	OrchestratorReboot: "orchestrator.reboot",

	UIAgentUpdate: "ui.agent.update",
	UIJobUpdate: "ui.job.update",
	UIJobEvent: "ui.job.event",
} as const;
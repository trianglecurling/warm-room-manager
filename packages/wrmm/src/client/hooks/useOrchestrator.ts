import { useState, useEffect, useRef, useCallback } from 'react';
import { apiClient, OrchestratorAgent, OrchestratorJob, OrchestratorJobEvent, WebSocketMessage } from '../lib/api';

interface UseOrchestratorOptions {
  autoConnect?: boolean;
  reconnectInterval?: number;
}

interface UseOrchestratorReturn {
  agents: OrchestratorAgent[];
  jobs: OrchestratorJob[];
  restartEvents: Record<string, OrchestratorJobEvent>;
  isConnected: boolean;
  error: string | null;
  connect: () => void;
  disconnect: () => void;
  reconnect: () => void;
}

const RESTART_EVENT_CLEAR_STATUSES = new Set(['RUNNING', 'STOPPED', 'FAILED', 'DISMISSED', 'CANCELED']);

const normalizeAgent = (agent: any): OrchestratorAgent => ({
  id: agent.id,
  name: agent.name,
  state: agent.state,
  currentJobId: agent.currentJobId,
  lastSeenAt: agent.lastSeenAt,
  drain: agent.drain,
  capabilities: agent.capabilities,
  meta: agent.meta,
});

const normalizeJob = (job: any): OrchestratorJob => ({
  id: job.id,
  templateId: job.templateId,
  inlineConfig: job.inlineConfig,
  status: job.status,
  agentId: job.agentId,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  startedAt: job.startedAt,
  endedAt: job.endedAt,
  error: job.error,
  requestedBy: job.requestedBy,
  idempotencyKey: job.idempotencyKey,
  restartPolicy: job.restartPolicy,
  streamMetadata: job.streamMetadata,
});

export function useOrchestrator(options: UseOrchestratorOptions = {}): UseOrchestratorReturn {
  const { autoConnect = true, reconnectInterval = 5000 } = options;

  const [agents, setAgents] = useState<OrchestratorAgent[]>([]);
  const [jobs, setJobs] = useState<OrchestratorJob[]>([]);
  const [restartEvents, setRestartEvents] = useState<Record<string, OrchestratorJobEvent>>({});
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const isMountedRef = useRef(true);
  // Note: no local isConnectingRef needed; using module-level singleton

  // Module-level singletons to survive StrictMode remounts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moduleState = (useOrchestrator as any)._singleton || ((useOrchestrator as any)._singleton = {
    socket: null as WebSocket | null,
    reconnectTimer: null as NodeJS.Timeout | null,
    isConnecting: false,
  });

  const handleWebSocketMessage = useCallback((message: WebSocketMessage) => {
    switch (message.type) {
      case 'ui.agent.update':
        if (Array.isArray(message.payload)) {
          setAgents(message.payload.map(normalizeAgent));
          break;
        }
        setAgents(prev => {
          const next = normalizeAgent(message.payload);
          const existingIndex = prev.findIndex(agent => agent.id === next.id);
          if (existingIndex >= 0) {
            const updated = [...prev];
            updated[existingIndex] = next;
            return updated;
          }
          return [...prev, next];
        });
        break;

      case 'ui.job.update':
        if (Array.isArray(message.payload)) {
          const normalized = message.payload.map(normalizeJob);
          const idsToClear = normalized
            .filter(job => RESTART_EVENT_CLEAR_STATUSES.has(job.status))
            .map(job => job.id);
          if (idsToClear.length > 0) {
            setRestartEvents(prevEvents => {
              const nextEvents = { ...prevEvents };
              idsToClear.forEach(id => delete nextEvents[id]);
              return nextEvents;
            });
          }
          setJobs(normalized);
          break;
        }

        setJobs(prev => {
          const next = normalizeJob(message.payload);
          const existingIndex = prev.findIndex(job => job.id === next.id);
          if (RESTART_EVENT_CLEAR_STATUSES.has(next.status)) {
            setRestartEvents(prevEvents => {
              if (!prevEvents[next.id]) return prevEvents;
              const { [next.id]: _removed, ...rest } = prevEvents;
              return rest;
            });
          }
          if (existingIndex >= 0) {
            const updated = [...prev];
            updated[existingIndex] = next;
            return updated;
          }
          return [...prev, next];
        });
        break;
      case 'ui.job.event': {
        const event = message.payload as OrchestratorJobEvent;
        const isRestartEvent = event.type === 'stream.restart_requested' || event.type === 'stream.restart_ready';
        const attempt = typeof event.data?.attempt === 'number' ? event.data.attempt : undefined;
        if (isRestartEvent && attempt !== undefined) {
          setRestartEvents(prevEvents => ({ ...prevEvents, [event.jobId]: event }));
        }
        break;
      }

      default:
        console.log('Unhandled WebSocket message type:', message.type);
    }
  }, []);

  // Initial data fetch
  const fetchInitialData = useCallback(async () => {
    try {
      const [agentsData, jobsData] = await Promise.all([
        apiClient.getAgents(),
        apiClient.getJobs(),
      ]);

      if (isMountedRef.current) {
        setAgents(agentsData);
        setJobs(jobsData);
        if (agentsData.length > 0 || jobsData.length > 0) {
          setError(null);
        }
      }
    } catch (_) {
      if (isMountedRef.current) {
        setError('Orchestrator service not available. Start the stream orchestrator service to enable stream controls.');
      }
    }
  }, []);

  const connect = useCallback(() => {
    if (moduleState.isConnecting) {
      return;
    }

    if (moduleState.socket && moduleState.socket.readyState === WebSocket.OPEN) {
      wsRef.current = moduleState.socket;
      return;
    }

    try {
      moduleState.isConnecting = true;
      const ws = apiClient.createOrchestratorWebSocket();
      moduleState.socket = ws;
      wsRef.current = moduleState.socket;

      ws.onopen = () => {
        moduleState.isConnecting = false;
        if (isMountedRef.current) {
          setIsConnected(true);
          setError(null);
          // Force a full refresh after reconnect so stale local jobs do not survive service restarts.
          fetchInitialData();
        }
      };

      ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          if (isMountedRef.current) {
            handleWebSocketMessage(message);
          }
        } catch (_) {}
      };

      ws.onclose = () => {
        moduleState.isConnecting = false;
        if (moduleState.socket === ws) {
          moduleState.socket = null;
        }
        if (isMountedRef.current) {
          setIsConnected(false);
          if (moduleState.reconnectTimer) {
            clearTimeout(moduleState.reconnectTimer);
          }
          moduleState.reconnectTimer = setTimeout(() => {
            if (isMountedRef.current) {
              connect();
            }
          }, reconnectInterval);
        }
      };

      ws.onerror = () => {
        moduleState.isConnecting = false;
        if (isMountedRef.current) {
          setError('Orchestrator service not available. Start the stream orchestrator service to enable stream controls.');
        }
      };
    } catch (_) {
      moduleState.isConnecting = false;
      setError('Failed to create WebSocket connection');
    }
  }, [fetchInitialData, handleWebSocketMessage, moduleState, reconnectInterval]);

  const disconnect = useCallback(() => {
    if (moduleState.reconnectTimer) {
      clearTimeout(moduleState.reconnectTimer);
      moduleState.reconnectTimer = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    moduleState.socket = null;
    moduleState.isConnecting = false;
    setIsConnected(false);
  }, [moduleState]);

  const reconnect = useCallback(() => {
    disconnect();
    connect();
  }, [connect, disconnect]);

  // Connect on mount if autoConnect is true
  useEffect(() => {
    isMountedRef.current = true;

    if (autoConnect) {
      fetchInitialData();
      connect();
    }

    return () => {
      isMountedRef.current = false;
      // Keep the singleton socket alive across StrictMode remounts
    };
  }, [autoConnect, connect, fetchInitialData]);

  return {
    agents,
    jobs,
    restartEvents,
    isConnected,
    error,
    connect,
    disconnect,
    reconnect,
  };
}

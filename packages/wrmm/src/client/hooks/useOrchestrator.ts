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

export function useOrchestrator(options: UseOrchestratorOptions = {}): UseOrchestratorReturn {
  const { autoConnect = true, reconnectInterval = 5000 } = options;

  const [agents, setAgents] = useState<OrchestratorAgent[]>([]);
  const [jobs, setJobs] = useState<OrchestratorJob[]>([]);
  const [restartEvents, setRestartEvents] = useState<Record<string, OrchestratorJobEvent>>({});
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);
  // Note: no local isConnectingRef needed; using module-level singleton

  // Module-level singletons to survive StrictMode remounts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moduleState = (useOrchestrator as any)._singleton || ((useOrchestrator as any)._singleton = {
    socket: null as WebSocket | null,
    reconnectTimer: null as NodeJS.Timeout | null,
    isConnecting: false,
  });

  const connect = useCallback(() => {
    if (moduleState.isConnecting) {
      return;
    }

    if (moduleState.socket && moduleState.socket.readyState === WebSocket.OPEN) {
      wsRef.current = moduleState.socket;
      return;
    }

    // Clean up any existing connection
    // Do not forcibly close moduleState.socket here; let the existing connection live

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
        if (isMountedRef.current) {
          setIsConnected(false);

          // Attempt to reconnect after delay
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
    } catch (error) {
      moduleState.isConnecting = false;
      setError('Failed to create WebSocket connection');
    }
  }, [reconnectInterval]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsConnected(false);
  }, []);

  const reconnect = useCallback(() => {
    disconnect();
    connect();
  }, [connect, disconnect]);

  const handleWebSocketMessage = useCallback((message: WebSocketMessage) => {
    switch (message.type) {
      case 'ui.agent.update':
        setAgents(prev => {
          const existingIndex = prev.findIndex(agent => agent.id === message.payload.id);
          if (existingIndex >= 0) {
            // Update existing agent
            const updated = [...prev];
            updated[existingIndex] = {
              id: message.payload.id,
              name: message.payload.name,
              state: message.payload.state,
              currentJobId: message.payload.currentJobId,
              lastSeenAt: message.payload.lastSeenAt,
              drain: message.payload.drain,
              capabilities: message.payload.capabilities,
              meta: message.payload.meta,
            };
            return updated;
          } else {
            // Add new agent
            return [...prev, {
              id: message.payload.id,
              name: message.payload.name,
              state: message.payload.state,
              currentJobId: message.payload.currentJobId,
              lastSeenAt: message.payload.lastSeenAt,
              drain: message.payload.drain,
              capabilities: message.payload.capabilities,
              meta: message.payload.meta,
            }];
          }
        });
        break;

      case 'ui.job.update':
        setJobs(prev => {
          const existingIndex = prev.findIndex(job => job.id === message.payload.id);
          const shouldClearRestart = ['RUNNING', 'STOPPED', 'FAILED', 'DISMISSED', 'CANCELED'].includes(message.payload.status);
          if (shouldClearRestart) {
            setRestartEvents(prevEvents => {
              if (!prevEvents[message.payload.id]) return prevEvents;
              const { [message.payload.id]: _removed, ...rest } = prevEvents;
              return rest;
            });
          }
          if (existingIndex >= 0) {
            // Update existing job
            const updated = [...prev];
            updated[existingIndex] = {
              id: message.payload.id,
              templateId: message.payload.templateId,
              inlineConfig: message.payload.inlineConfig,
              status: message.payload.status,
              agentId: message.payload.agentId,
              createdAt: message.payload.createdAt,
              updatedAt: message.payload.updatedAt,
              startedAt: message.payload.startedAt,
              endedAt: message.payload.endedAt,
              error: message.payload.error,
              requestedBy: message.payload.requestedBy,
              idempotencyKey: message.payload.idempotencyKey,
              restartPolicy: message.payload.restartPolicy,
              streamMetadata: message.payload.streamMetadata,
            };
            return updated;
          } else {
            // Add new job
            return [...prev, {
              id: message.payload.id,
              templateId: message.payload.templateId,
              inlineConfig: message.payload.inlineConfig,
              status: message.payload.status,
              agentId: message.payload.agentId,
              createdAt: message.payload.createdAt,
              updatedAt: message.payload.updatedAt,
              startedAt: message.payload.startedAt,
              endedAt: message.payload.endedAt,
              error: message.payload.error,
              requestedBy: message.payload.requestedBy,
              idempotencyKey: message.payload.idempotencyKey,
              restartPolicy: message.payload.restartPolicy,
              streamMetadata: message.payload.streamMetadata,
            }];
          }
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
  }, [autoConnect, connect, disconnect, fetchInitialData, isConnected]);

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

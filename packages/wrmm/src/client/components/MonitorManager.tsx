import { useState, useMemo, useEffect, useRef, memo } from 'react';
import { ArrowsUpDownIcon, ArrowsRightLeftIcon, PlusCircleIcon, TrashIcon } from '@heroicons/react/24/outline';
import { ExclamationTriangleIcon as ExclamationSolidIcon, CheckCircleIcon as CheckSolidIcon, PencilSquareIcon } from '@heroicons/react/24/solid';
import logo from '../assets/logo.png';
import { useAutocomplete } from '../hooks/useAutocomplete';
import { AutocompleteInput } from './AutocompleteInput';
import { SearchResult, PresetData, CreateTeamRequest, PlayerPosition, apiClient, Team, OrchestratorBroadcast } from '../lib/api';
import { ContextModal } from './ContextModal';
import { usePresets } from '../hooks/usePresets';
import { PresetNameModal } from './PresetNameModal';
import { TeamSaveModal } from './TeamSaveModal';
import { TimerManager } from './TimerManager';
import { useQueryClient } from '@tanstack/react-query';
import { useOrchestrator } from '../hooks/useOrchestrator';
import { YouTubeOAuthPanel } from './YouTubeOAuthPanel';
import { SecretConfigModal } from './SecretConfigModal';
import { StreamStartCountdownModal } from './StreamStartCountdownModal';


interface SheetData {
  red: string;
  yellow: string;
}

interface MonitorData {
  A: SheetData;
  B: SheetData;
  C: SheetData;
  D: SheetData;
}

// Track whether a textarea's current content originated from a Team selection (unmodified)
type TeamOrigin = Partial<Record<keyof MonitorData, { red?: Team; yellow?: Team }>>;

type StreamTextFieldProps = {
  value: string;
  placeholder?: string;
  className?: string;
  onChange: (value: string) => void;
  isTextarea?: boolean;
};

const StreamTextField = memo(({
  value,
  placeholder,
  className,
  onChange,
  isTextarea,
}: StreamTextFieldProps) => {
  const [localValue, setLocalValue] = useState(value ?? '');
  const lastEditRef = useRef(0);

  useEffect(() => {
    const now = Date.now();
    if (now - lastEditRef.current < 500) return;
    if (localValue !== value) {
      setLocalValue(value ?? '');
    }
  }, [value, localValue]);

  const handleChange = (next: string) => {
    lastEditRef.current = Date.now();
    setLocalValue(next);
    onChange(next);
  };

  if (isTextarea) {
    return (
      <textarea
        className={className}
        placeholder={placeholder}
        value={localValue}
        onChange={e => handleChange(e.target.value)}
      />
    );
  }

  return (
    <input
      className={className}
      placeholder={placeholder}
      value={localValue}
      onChange={e => handleChange(e.target.value)}
    />
  );
});

export const MonitorManager = () => {
  const [monitorData, setMonitorData] = useState<MonitorData>({
    A: { red: '', yellow: '' },
    B: { red: '', yellow: '' },
    C: { red: '', yellow: '' },
    D: { red: '', yellow: '' }
  });
  const [teamOrigin, setTeamOrigin] = useState<TeamOrigin>({});

  const {
    contexts,
    selectedContext,
    setSelectedContext,
    searchQuery,
    setSearchQuery,
    searchResults,
    isLoading
  } = useAutocomplete();

  const { presets, savePreset, deletePreset, isLoading: presetsLoading } = usePresets(selectedContext);

  const [activeField, setActiveField] = useState<string | null>(null);
  const [showAllContexts, setShowAllContexts] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('wrmm.showAllContexts');
      return raw ? JSON.parse(raw) : false;
    } catch { return false; }
  });
  const [isContextModalOpen, setIsContextModalOpen] = useState<null | { mode: 'new' | 'edit' }>(null);
  const [isPresetNameModalOpen, setIsPresetNameModalOpen] = useState(false);
  const [isSecretConfigModalOpen, setIsSecretConfigModalOpen] = useState(false);
  const isSecretConfigModalOpenRef = useRef(isSecretConfigModalOpen);

  // Update ref when state changes
  useEffect(() => {
    isSecretConfigModalOpenRef.current = isSecretConfigModalOpen;
  }, [isSecretConfigModalOpen]);
  const [pendingStreamStarts, setPendingStreamStarts] = useState<(() => Promise<void>)[] | null>(null);
  const [selectedPresetName, setSelectedPresetName] = useState<string>(() => localStorage.getItem('wrmm.selectedPreset') || '');
  const [monitorHydrated, setMonitorHydrated] = useState<boolean>(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const queryClient = useQueryClient();
  const isExecutingStreamStartsRef = useRef(false);
  const [isRefreshingCache, setIsRefreshingCache] = useState(false);
  const [colorsRandomized, setColorsRandomized] = useState(false);
  const [monitorErrors, setMonitorErrors] = useState<Partial<Record<keyof MonitorData, string>>>({});
  type StatusKind = 'info' | 'success' | 'warning' | 'error' | 'busy';
  const [status, setStatus] = useState<{ kind: StatusKind; message: string } | null>(null);
  const [isFlashing, setIsFlashing] = useState(false);
  const [activeSection, setActiveSection] = useState('monitor-manager');
  const [useAlternateColors, setUseAlternateColors] = useState(true);
  
  // Track last update time for each stream to avoid cursor jumps
  const lastUpdateTimeRef = useRef<Record<StreamKey, number>>({} as Record<StreamKey, number>);

  // Stream/Agent types and state
  type StreamKey = 'sheetA' | 'sheetB' | 'sheetC' | 'sheetD' | 'vibe';

  interface StreamState {
    key: StreamKey;
    name: string;
    isLive: boolean;
    isPaused?: boolean;
    broadcastId?: string;
    autoStopEnabled?: boolean;
    autoStopMinutes?: number;
    autoStopAt?: string;
    title: string;
    description: string;
    viewers: number;
    publicUrl: string | null;
    adminUrl: string | null;
    jobId?: string; // Associated orchestrator job ID
    jobStatus?: string; // Status from orchestrator job
    error?: string; // Error message from failed jobs
    redTeam?: string;
    yellowTeam?: string;
  }

  const streamOrder: StreamKey[] = ['sheetA','sheetB','sheetC','sheetD','vibe'];
  const NEW_BROADCAST_VALUE = '__new__';
  const [streams, setStreams] = useState<Record<StreamKey, StreamState>>({
    sheetA: { key: 'sheetA', name: 'Sheet A', isLive: false, isPaused: false, title: '', description: '', viewers: 0, publicUrl: null, adminUrl: null, redTeam: '', yellowTeam: '' },
    sheetB: { key: 'sheetB', name: 'Sheet B', isLive: false, isPaused: false, title: '', description: '', viewers: 0, publicUrl: null, adminUrl: null, redTeam: '', yellowTeam: '' },
    sheetC: { key: 'sheetC', name: 'Sheet C', isLive: false, isPaused: false, title: '', description: '', viewers: 0, publicUrl: null, adminUrl: null, redTeam: '', yellowTeam: '' },
    sheetD: { key: 'sheetD', name: 'Sheet D', isLive: false, isPaused: false, title: '', description: '', viewers: 0, publicUrl: null, adminUrl: null, redTeam: '', yellowTeam: '' },
    vibe:   { key: 'vibe',   name: 'Vibe Stream', isLive: false, isPaused: false, title: '', description: '', viewers: 0, publicUrl: null, adminUrl: null, redTeam: '', yellowTeam: '' },
  });
  const draftTitlesRef = useRef<Record<StreamKey, string>>({
    sheetA: '',
    sheetB: '',
    sheetC: '',
    sheetD: '',
    vibe: '',
  });
  const draftDescriptionsRef = useRef<Record<StreamKey, string>>({
    sheetA: '',
    sheetB: '',
    sheetC: '',
    sheetD: '',
    vibe: '',
  });
  const [broadcasts, setBroadcasts] = useState<OrchestratorBroadcast[]>([]);
  const [selectedBroadcastIds, setSelectedBroadcastIds] = useState<string[]>([]);
  const [broadcastSelection, setBroadcastSelection] = useState<Record<StreamKey, string>>({
    sheetA: NEW_BROADCAST_VALUE,
    sheetB: NEW_BROADCAST_VALUE,
    sheetC: NEW_BROADCAST_VALUE,
    sheetD: NEW_BROADCAST_VALUE,
    vibe: NEW_BROADCAST_VALUE,
  });
  const [startMenuOpenFor, setStartMenuOpenFor] = useState<StreamKey | null>(null);
  const [bulkStartMenuOpen, setBulkStartMenuOpen] = useState(false);
  const [bulkStopMenuOpen, setBulkStopMenuOpen] = useState(false);
  const [scheduleDialog, setScheduleDialog] = useState<{ open: boolean; mode: 'single' | 'bulk'; streamKey?: StreamKey }>({
    open: false,
    mode: 'single',
  });
  const [scheduledStartLocal, setScheduledStartLocal] = useState<string>('');
  const [scheduleMode, setScheduleMode] = useState<'datetime' | 'delay'>('datetime');
  const [delayMinutes, setDelayMinutes] = useState<string>('60');
  const [autoStartChecked, setAutoStartChecked] = useState(false);
  const [autoStopChecked, setAutoStopChecked] = useState(false);
  const [autoStopHours, setAutoStopHours] = useState<string>('2');
  const [autoStopMinutes, setAutoStopMinutes] = useState<string>('15');
  const [autoStopDialog, setAutoStopDialog] = useState<{ open: boolean; mode: 'running' | 'future' | 'running-bulk'; streamKey: StreamKey | null; streamKeys?: StreamKey[] }>({
    open: false,
    mode: 'future',
    streamKey: null,
  });
  const [isCreatingBroadcast, setIsCreatingBroadcast] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [youtubeUpdateState, setYoutubeUpdateState] = useState<Record<StreamKey, { pending: boolean; message?: string }>>({
    sheetA: { pending: false },
    sheetB: { pending: false },
    sheetC: { pending: false },
    sheetD: { pending: false },
    vibe: { pending: false },
  });
  const pendingYoutubeUpdatesRef = useRef<Record<StreamKey, { title?: string; description?: string }>>({} as Record<StreamKey, { title?: string; description?: string }>);
  const youtubeUpdateTimersRef = useRef<Record<StreamKey, ReturnType<typeof setTimeout> | null>>({} as Record<StreamKey, ReturnType<typeof setTimeout> | null>);
  const youtubeSuccessTimersRef = useRef<Record<StreamKey, ReturnType<typeof setTimeout> | null>>({} as Record<StreamKey, ReturnType<typeof setTimeout> | null>);
  const streamsWithJobsRef = useRef<Record<StreamKey, StreamState> | null>(null);
  const broadcastSelectionRef = useRef(broadcastSelection);
  const jobStatusRef = useRef<Record<string, string>>({});
  const lastBroadcastRefreshAtRef = useRef(0);

  const [selectedStreams, setSelectedStreams] = useState<StreamKey[]>([]);

  // Use orchestrator hook for real-time data
  const { agents: orchestratorAgents, jobs: orchestratorJobs, restartEvents, isConnected: orchestratorConnected } = useOrchestrator();

  const restartInfoByJobId = useMemo(() => {
    const map: Record<string, { attempt: number; backoffMs?: number; ts?: string }> = {};
    Object.values(restartEvents).forEach(event => {
      const attempt = typeof event.data?.attempt === 'number' ? event.data.attempt : undefined;
      if (attempt === undefined) return;
      map[event.jobId] = {
        attempt,
        backoffMs: typeof event.data?.backoffMs === 'number' ? event.data.backoffMs : undefined,
        ts: event.ts,
      };
    });
    return map;
  }, [restartEvents]);

  // Helper function to convert StreamKey to sheet identifier
  const getSheetIdentifier = (streamKey: StreamKey): 'A' | 'B' | 'C' | 'D' | 'vibe' => {
    switch (streamKey) {
      case 'sheetA': return 'A';
      case 'sheetB': return 'B';
      case 'sheetC': return 'C';
      case 'sheetD': return 'D';
      case 'vibe': return 'vibe';
      default: return 'A';
    }
  };

  const formatDateTimeLocal = (date: Date) => {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  };

  const toIsoFromLocal = (value: string) => {
    if (!value) return undefined;
    return new Date(value).toISOString();
  };

  // Map orchestrator data to UI concepts
  // Deduplicate agents by name, preferring online agents over offline ones
  const agents = useMemo(() => {
    const agentMap = new Map<string, typeof orchestratorAgents[0]>();

    // Group agents by name and select the best one for each name
    orchestratorAgents.forEach(agent => {
      const existing = agentMap.get(agent.name);
      if (!existing) {
        // First agent with this name
        agentMap.set(agent.name, agent);
      } else {
        // Compare agents - prefer online (non-OFFLINE) over offline
        const existingIsOnline = existing.state !== 'OFFLINE';
        const currentIsOnline = agent.state !== 'OFFLINE';

        if (currentIsOnline && !existingIsOnline) {
          // Current is online, existing is offline - use current
          agentMap.set(agent.name, agent);
        } else if (!currentIsOnline && !existingIsOnline) {
          // Both offline - use the more recently seen one
          const existingTime = new Date(existing.lastSeenAt).getTime();
          const currentTime = new Date(agent.lastSeenAt).getTime();
          if (currentTime > existingTime) {
            agentMap.set(agent.name, agent);
          }
        }
        // If existing is online and current is also online, keep existing
        // If existing is online and current is offline, keep existing
      }
    });

    // Convert back to array and map to UI format
    return Array.from(agentMap.values())
      .map(agent => ({
      id: agent.id,
      name: agent.name,
      status: agent.state,
      assignedStreamKey: orchestratorJobs.find(job => job.id === agent.currentJobId)?.inlineConfig?.streamKey as StreamKey | undefined,
      }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  }, [orchestratorAgents, orchestratorJobs]);

  useEffect(() => {
    broadcastSelectionRef.current = broadcastSelection;
  }, [broadcastSelection]);

  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleClickAway = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
    if (target.closest('[data-start-toggle], [data-start-menu], [data-bulk-start-toggle], [data-bulk-start-menu], [data-bulk-stop-toggle], [data-bulk-stop-menu]')) {
        return;
      }
      setStartMenuOpenFor(null);
      setBulkStartMenuOpen(false);
    setBulkStopMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClickAway);
    return () => document.removeEventListener('mousedown', handleClickAway);
  }, []);

  // Update streams based on orchestrator jobs
  const streamsWithJobs = useMemo(() => {
    const updatedStreams: Record<StreamKey, StreamState> = {} as Record<StreamKey, StreamState>;

    // Reset all streams to not live initially (create new objects)
    Object.keys(streams).forEach(key => {
      updatedStreams[key as StreamKey] = {
        ...streams[key as StreamKey],
        isLive: false,
        jobId: undefined,
        jobStatus: undefined,
      };
    });

    // Set streams based on jobs - show URLs as soon as metadata is available
    orchestratorJobs.forEach(job => {
      if (job.inlineConfig?.streamKey) {
        const streamKey = job.inlineConfig.streamKey as StreamKey;
        if (updatedStreams[streamKey]) {
          const metadata = job.streamMetadata;

          // Use metadata from orchestrator for URLs and other data, regardless of job status
          const baseStreamData = {
            ...updatedStreams[streamKey],
            jobId: job.id,
            jobStatus: job.status,
            // Only show real YouTube URLs when available from metadata
            publicUrl: metadata?.publicUrl || null,
            adminUrl: metadata?.adminUrl || null,
            isPaused: metadata?.isPaused ?? false,
            broadcastId: metadata?.youtube?.broadcastId,
            autoStopEnabled: metadata?.autoStopEnabled,
            autoStopMinutes: metadata?.autoStopMinutes,
            autoStopAt: metadata?.autoStopAt,
            // ONLY use metadata for title/description (which gets synced to local state via useEffect)
            // Never use inlineConfig as it contains the pre-generation values
            title: updatedStreams[streamKey].title,
            description: updatedStreams[streamKey].description,
          };

          if (job.status === 'RUNNING') {
            // Running jobs are live and show real-time data
            updatedStreams[streamKey] = {
              ...baseStreamData,
              isLive: true,
              viewers: metadata?.viewers ?? 0, // Use real viewer count from orchestrator
            };
          } else if (job.status === 'FAILED' && job.error) {
            // Handle failed jobs by showing error state
            updatedStreams[streamKey] = {
              ...baseStreamData,
              isLive: false,
              error: job.error.message,
            };
          } else if (job.status === 'DISMISSED') {
            // Dismissed jobs don't show any error state
            updatedStreams[streamKey] = {
              ...baseStreamData,
              isLive: false,
              error: undefined,
            };
          } else {
            // Other job statuses (CREATED, PENDING, ASSIGNED, ACCEPTED, etc.)
            // Show URLs but not live status
            updatedStreams[streamKey] = {
              ...baseStreamData,
              isLive: false,
            };
          }
        }
      }
    });

    return updatedStreams;
  }, [streams, orchestratorJobs]);

  useEffect(() => {
    streamsWithJobsRef.current = streamsWithJobs;
  }, [streamsWithJobs]);

  useEffect(() => {
    const now = Date.now();
    streamOrder.forEach(key => {
      const lastUpdate = lastUpdateTimeRef.current[key] || 0;
      if (now - lastUpdate < 2000) return;
      draftTitlesRef.current[key] = streams[key].title ?? '';
      draftDescriptionsRef.current[key] = streams[key].description ?? '';
    });
  }, [streams]);

  // Sync title/description from job metadata to local state
  useEffect(() => {
    orchestratorJobs.forEach(job => {
      if (job.inlineConfig?.streamKey && job.streamMetadata) {
        const streamKey = job.inlineConfig.streamKey as StreamKey;
        const metadata = job.streamMetadata;
        
        // Skip syncing if we just updated this stream (prevents cursor jumps while typing)
        const lastUpdate = lastUpdateTimeRef.current[streamKey] || 0;
        const timeSinceUpdate = Date.now() - lastUpdate;
        if (timeSinceUpdate < 2000) {
          // Skip syncing for 2 seconds after user edits
          return;
        }
        
        setStreams(prev => {
          const currentStream = prev[streamKey];
          
          // Check if we need to update
          const titleNeedsSync = metadata.title !== undefined && currentStream.title !== metadata.title;
          const descriptionNeedsSync = metadata.description !== undefined && currentStream.description !== metadata.description;
          
          if (titleNeedsSync || descriptionNeedsSync) {
            return {
              ...prev,
              [streamKey]: {
                ...currentStream,
                title: metadata.title ?? currentStream.title,
                description: metadata.description ?? currentStream.description,
              }
            };
          }
          
          return prev;
        });
      }
    });
  }, [orchestratorJobs]);

  useEffect(() => {
    orchestratorJobs.forEach(job => {
      if (!job.inlineConfig?.streamKey || !job.streamMetadata?.youtube?.broadcastId) return;
      if (['STOPPED', 'FAILED', 'DISMISSED', 'CANCELED'].includes(job.status)) return;
      const streamKey = job.inlineConfig.streamKey as StreamKey;
      const broadcastId = job.streamMetadata.youtube.broadcastId;
      setBroadcastSelection(prev => {
        if (prev[streamKey] === broadcastId) return prev;
        return { ...prev, [streamKey]: broadcastId };
      });
    });
  }, [orchestratorJobs]);

  useEffect(() => {
    const stoppedStatuses = new Set(['STOPPED', 'FAILED', 'CANCELED', 'DISMISSED', 'UNKNOWN']);
    let shouldRefresh = false;
    const now = Date.now();

    orchestratorJobs.forEach(job => {
      const prevStatus = jobStatusRef.current[job.id];
      if (prevStatus === job.status) return;
      jobStatusRef.current[job.id] = job.status;

      if (!stoppedStatuses.has(job.status)) return;
      shouldRefresh = true;

      const streamKey = job.inlineConfig?.streamKey as StreamKey | undefined;
      if (!streamKey || streamKey === 'vibe') return;

      setStreams(prev => {
        const current = prev[streamKey];
        if (!current || (!current.redTeam && !current.yellowTeam)) return prev;
        return {
          ...prev,
          [streamKey]: {
            ...current,
            redTeam: '',
            yellowTeam: '',
          },
        };
      });

      const sheetId = getSheetIdentifier(streamKey);
      apiClient.updateTeamNames(sheetId, '', '').catch(err => {
        console.error(`Failed to clear team names for ${streamKey}:`, err);
      });
    });

    if (shouldRefresh && now - lastBroadcastRefreshAtRef.current > 3000) {
      lastBroadcastRefreshAtRef.current = now;
      refreshBroadcasts();
    }
  }, [orchestratorJobs]);

  useEffect(() => {
    orchestratorJobs.forEach(job => {
      if (!job.inlineConfig?.streamKey) return;
      if (!['STOPPED', 'FAILED', 'DISMISSED', 'CANCELED'].includes(job.status)) return;
      const streamKey = job.inlineConfig.streamKey as StreamKey;
      const hasAutoStart = broadcasts.some(b => b.autoStart && b.sheetKey === streamKey);
      if (hasAutoStart) return;
      setBroadcastSelection(prev => {
        const currentSelection = prev[streamKey];
        if (currentSelection && currentSelection !== NEW_BROADCAST_VALUE) {
          const stillExists = broadcasts.some(b => b.broadcastId === currentSelection);
          if (stillExists) return prev;
        }
        if (prev[streamKey] === NEW_BROADCAST_VALUE) return prev;
        return { ...prev, [streamKey]: NEW_BROADCAST_VALUE };
      });
    });
  }, [orchestratorJobs, broadcasts]);

  // Stream start function that contains the actual logic
  const startStream = async (key: StreamKey) => {
    console.log(`🎬 startStream called for key: ${key}`);
    let stream = streams[key];

    // Auto-populate team names from monitors if they're blank (for non-vibe streams)
    if (key !== 'vibe' && (!stream.redTeam || !stream.yellowTeam)) {
      try {
        console.log(`🎬 Auto-populating team names for ${key}`);
        const data = await apiClient.getMonitors();
        const sheetKey = key.replace('sheet', '').toUpperCase(); // 'sheetA' -> 'A'
        const sheet = (data as any)[sheetKey];
        
        if (sheet && sheet.status === 'online') {
          // Parse text into players array (split by newlines)
          const redPlayers = sheet.red?.text ? sheet.red.text.split('\n').filter((line: string) => line.trim()) : [];
          const yellowPlayers = sheet.yellow?.text ? sheet.yellow.text.split('\n').filter((line: string) => line.trim()) : [];
          
          // Extract team names using the same logic as synchronize
          const extractTeamName = (players: string[]): string => {
            if (!players || players.length === 0) return '';
            
            const getLastName = (fullName: string): string => {
              const parts = fullName.trim().split(/\s+/);
              return parts.length > 0 ? parts[parts.length - 1] : '';
            };
            
            const lineCount = players.length;
            
            if (lineCount === 4) {
              return getLastName(players[0]);
            } else if (lineCount === 5) {
              return getLastName(players[1]);
            } else if (lineCount === 2) {
              const last1 = getLastName(players[0]);
              const last2 = getLastName(players[1]);
              return `${last1}/${last2}`;
            } else if (lineCount === 3) {
              const last1 = getLastName(players[1]);
              const last2 = getLastName(players[2]);
              return `${last1}/${last2}`;
            }
            
            return getLastName(players[0]);
          };
          
          const redTeam = !stream.redTeam ? extractTeamName(redPlayers) : stream.redTeam;
          const yellowTeam = !stream.yellowTeam ? extractTeamName(yellowPlayers) : stream.yellowTeam;
          
          console.log(`🎬 Populated team names: red="${redTeam}", yellow="${yellowTeam}"`);
          
          // Update stream object with populated team names
          stream = {
            ...stream,
            ...(redTeam && { redTeam }),
            ...(yellowTeam && { yellowTeam })
          };
          
          // Update state
          setStreams(prev => ({
            ...prev,
            [key]: stream
          }));
          
          // Send to orchestrator
          const sheetId = getSheetIdentifier(key);
          await apiClient.updateTeamNames(sheetId, redTeam || undefined, yellowTeam || undefined);
        }
      } catch (err) {
        console.error('Failed to auto-populate team names from monitors:', err);
        // Continue with stream start even if auto-populate fails
      }
    }

    const idempotencyKey = `stream-${key}-${Date.now()}`;
    console.log(`🎬 startStream: Generated idempotency key: ${idempotencyKey}`);

    const selectedBroadcastId = broadcastSelection[key];
    const defaultAutoStopMinutes = 140; // 2h 20m default for immediate starts
    const draftTitle = draftTitlesRef.current[key] || stream.title;
    const draftDescription = draftDescriptionsRef.current[key] || stream.description;
    const jobRequest = {
      inlineConfig: {
        streamKey: key,
        streamName: stream.name,
        title: draftTitle, // Send empty string if blank - backend will auto-generate
        description: draftDescription, // Send empty string if blank - backend will auto-generate
      },
      streamContext: {
        context: selectedContext || 'Triangle Curling',
        sheet: getSheetIdentifier(key),
        team1: stream.redTeam || undefined,
        team2: stream.yellowTeam || undefined,
      },
      autoStopEnabled: true,
      autoStopMinutes: defaultAutoStopMinutes,
      idempotencyKey,
      restartPolicy: 'never' as const,
    };

    if (selectedBroadcastId && selectedBroadcastId !== NEW_BROADCAST_VALUE) {
      (jobRequest as any).broadcastId = selectedBroadcastId;
    }

    console.log(`🎬 startStream: Calling apiClient.createJob for ${key}`);
    // Create the job
    const job = await apiClient.createJob(jobRequest);
    console.log(`🎬 startStream: Job created successfully for ${key}, job ID: ${job.id}`);

    // The backend sets all the metadata (title, description, URLs) when creating the job
    // No need to update it here - it will come through via WebSocket
  };

  // Stream handlers using orchestrator
  const toggleLive = async (key: StreamKey, live: boolean) => {
    try {
      if (live) {
        // Start stream - queue for countdown modal
        // Team name auto-population now happens inside startStream
        queueStreamsForStart([() => startStream(key)]);
      } else {
        // Stop stream - find and stop the job
        const stream = streamsWithJobs[key];
        if (stream.jobId) {
          await apiClient.stopJob(stream.jobId);
          
          // Clear team names when stopping (except for vibe)
          if (key !== 'vibe') {
            setStreams(prev => ({
              ...prev,
              [key]: {
                ...prev[key],
                redTeam: '',
                yellowTeam: ''
              }
            }));
            
            // Clear team names in orchestrator
            const sheetId = getSheetIdentifier(key);
            await apiClient.updateTeamNames(sheetId, '', '');
          }
          
          setSuccess(`Stopped ${stream.name}`);
          setTimeout(() => {
            refreshBroadcasts();
          }, 2000);
        }
      }
    } catch (error: any) {
      setError(`Failed to ${live ? 'start' : 'stop'} ${streams[key].name}: ${error.message}`);
    }
  };

  const togglePause = async (key: StreamKey) => {
    const stream = streamsWithJobs[key];
    if (!stream.jobId) return;

    try {
      if (stream.isPaused) {
        await apiClient.unpauseJob(stream.jobId);
        setSuccess(`Unpaused ${stream.name}`);
      } else {
        await apiClient.pauseJob(stream.jobId);
        setSuccess(`Paused ${stream.name}`);
      }
    } catch (error: any) {
      setError(`Failed to ${stream.isPaused ? 'unpause' : 'pause'} ${streams[key].name}: ${error.message}`);
    }
  };

  const cancelAutoStart = async (broadcastId: string) => {
    try {
      const updated = await apiClient.updateBroadcastMetadata(broadcastId, { autoStart: false });
      setBroadcasts(prev => prev.map(b => (b.broadcastId === updated.broadcastId ? updated : b)));
      setSuccess('Auto start canceled');
    } catch (error: any) {
      setError(`Failed to cancel auto start: ${error.message}`);
    }
  };

  const clearStreamCard = async (key: StreamKey) => {
    setBroadcastSelection(prev => ({ ...prev, [key]: NEW_BROADCAST_VALUE }));
    draftTitlesRef.current[key] = '';
    draftDescriptionsRef.current[key] = '';
    setStreams(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        title: '',
        description: '',
        redTeam: '',
        yellowTeam: '',
      },
    }));
    if (key !== 'vibe') {
      const sheetId = getSheetIdentifier(key);
      apiClient.updateTeamNames(sheetId, '', '').catch(err => {
        console.error(`Failed to clear team names for ${key}:`, err);
      });
    }
  };

  const refreshBroadcasts = async () => {
    try {
      const data = await apiClient.refreshBroadcasts();
      setBroadcasts(data);
      setBroadcastSelection(prev => {
        let updated = prev;
        data.forEach((record) => {
          if (record.autoStart && record.sheetKey) {
            if (updated[record.sheetKey as StreamKey] !== record.broadcastId) {
              updated = { ...updated, [record.sheetKey as StreamKey]: record.broadcastId };
            }
          }
        });
        return updated;
      });
    } catch (error: any) {
      setError(`Failed to load broadcasts: ${error.message}`);
    }
  };

  const createBroadcastForStream = async (
    key: StreamKey,
    scheduledStartTime?: string,
    autoStart?: boolean,
    autoStopEnabled?: boolean,
    autoStopMinutesValue?: number
  ) => {
    const stream = streams[key];
    let team1 = stream.redTeam || undefined;
    let team2 = stream.yellowTeam || undefined;

    if (key !== 'vibe' && (!team1 || !team2)) {
      const sheetId = getSheetIdentifier(key) as keyof MonitorData;
      const sheet = monitorData[sheetId];
      const toPlayers = (value?: string) =>
        (value || '').split('\n').map(s => s.trim()).filter(Boolean);
      const extractTeamName = (players: string[]): string => {
        if (!players || players.length === 0) return '';
        const getLastName = (fullName: string): string => {
          const parts = fullName.trim().split(/\s+/);
          return parts.length > 0 ? parts[parts.length - 1] : '';
        };
        if (players.length === 4) return getLastName(players[0]);
        if (players.length === 5) return getLastName(players[1]);
        if (players.length === 2) return `${getLastName(players[0])}/${getLastName(players[1])}`;
        if (players.length === 3) return `${getLastName(players[1])}/${getLastName(players[2])}`;
        return getLastName(players[0]);
      };
      const redFromMonitor = extractTeamName(toPlayers(sheet?.red));
      const yellowFromMonitor = extractTeamName(toPlayers(sheet?.yellow));
      team1 = team1 || redFromMonitor || undefined;
      team2 = team2 || yellowFromMonitor || undefined;
    }

    const streamContext = {
      context: selectedContext || 'Triangle Curling',
      sheet: getSheetIdentifier(key),
      team1,
      team2,
    };
    const draftTitle = (draftTitlesRef.current[key] || stream.title).trim();
    const draftDescription = (draftDescriptionsRef.current[key] || stream.description).trim();
    const title = draftTitle ? draftTitle : undefined;
    const description = draftDescription ? draftDescription : undefined;

    const record = await apiClient.createBroadcast({
      title,
      description,
      scheduledStartTime,
      sheetKey: key,
      autoStart: !!autoStart,
      autoStopEnabled: !!autoStopEnabled,
      autoStopMinutes: autoStopEnabled ? autoStopMinutesValue : undefined,
      streamContext,
    });

    setBroadcasts(prev => [...prev, record].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    setBroadcastSelection(prev => ({ ...prev, [key]: record.broadcastId }));
    if (record.title || record.description) {
      setStreams(prev => ({
        ...prev,
        [key]: {
          ...prev[key],
          title: record.title ?? prev[key].title,
          description: record.description ?? prev[key].description,
        },
      }));
    }
    return record;
  };

  const openScheduleDialog = (mode: 'single' | 'bulk', streamKey?: StreamKey) => {
    setScheduleDialog({ open: true, mode, streamKey });
    setScheduledStartLocal(formatDateTimeLocal(new Date(Date.now() + 60 * 60 * 1000)));
    setScheduleMode('delay');
    setDelayMinutes('10');
    setAutoStartChecked(true);
    setAutoStopChecked(true);
    setAutoStopHours('2');
    setAutoStopMinutes('15');
  };

  const closeScheduleDialog = () => {
    setScheduleDialog({ open: false, mode: 'single' });
  };

  const confirmScheduleDialog = async () => {
    if (scheduleMode === 'delay' && (!delayMinutes || Number(delayMinutes) < 1)) {
      setError('Please enter a delay of at least 1 minute.');
      return;
    }
    const scheduledIso = scheduleMode === 'delay'
      ? toIsoFromLocal(formatDateTimeLocal(new Date(Date.now() + Number(delayMinutes || '0') * 60 * 1000)))
      : toIsoFromLocal(scheduledStartLocal);
    if (!scheduledIso) {
      setError('Please select a start time.');
      return;
    }

    if (isCreatingBroadcast) return;
    setIsCreatingBroadcast(true);
    try {
      const totalAutoStopMinutes = autoStopChecked
        ? Math.max(1, (Number(autoStopHours || '0') * 60) + Number(autoStopMinutes || '0'))
        : undefined;
      if (scheduleDialog.mode === 'single' && scheduleDialog.streamKey) {
        await createBroadcastForStream(scheduleDialog.streamKey, scheduledIso, autoStartChecked, autoStopChecked, totalAutoStopMinutes);
        setSuccess(`Created broadcast for ${streams[scheduleDialog.streamKey].name}`);
      } else {
        const targets = selectedButNotRunning();
        await Promise.all(targets.map(key => createBroadcastForStream(key, scheduledIso, autoStartChecked, autoStopChecked, totalAutoStopMinutes)));
        setSuccess(`Created ${targets.length} broadcast(s) without streaming`);
      }
      closeScheduleDialog();
    } catch (error: any) {
      setError(`Failed to create broadcast: ${error.message}`);
    } finally {
      setIsCreatingBroadcast(false);
    }
  };

  const openAutoStopDialog = (key: StreamKey, mode: 'running' | 'future', initialMinutes?: number) => {
    setAutoStopDialog({ open: true, mode, streamKey: key });
    const total = initialMinutes ?? 135;
    setAutoStopHours(String(Math.floor(total / 60)));
    setAutoStopMinutes(String(total % 60));
  };

  const openAutoStopDialogForRunning = (keys: StreamKey[], initialMinutes?: number) => {
    setAutoStopDialog({ open: true, mode: 'running-bulk', streamKey: null, streamKeys: keys });
    const total = initialMinutes ?? 135;
    setAutoStopHours(String(Math.floor(total / 60)));
    setAutoStopMinutes(String(total % 60));
  };

  const closeAutoStopDialog = () => {
    setAutoStopDialog({ open: false, mode: 'future', streamKey: null });
  };

  const confirmAutoStopDialog = async () => {
    const totalMinutes = Math.max(1, (Number(autoStopHours || '0') * 60) + Number(autoStopMinutes || '0'));

    try {
      const applyRunningJob = async (jobId?: string) => {
        if (!jobId) return;
        if (!autoStopChecked) {
          await apiClient.updateJobMetadata(jobId, { autoStopEnabled: false, autoStopAt: undefined, autoStopMinutes: undefined });
        } else {
          const autoStopAt = new Date(Date.now() + totalMinutes * 60 * 1000).toISOString();
          await apiClient.updateJobMetadata(jobId, { autoStopEnabled: true, autoStopAt, autoStopMinutes: totalMinutes });
        }
      };

      if (autoStopDialog.mode === 'running' && autoStopDialog.streamKey) {
        const keyLower = autoStopDialog.streamKey.toLowerCase();
        const jobId = orchestratorJobs.find(job => (job.status === 'RUNNING' || job.status === 'STARTING') && String(job.inlineConfig?.streamKey ?? '').toLowerCase() === keyLower)?.id;
        await applyRunningJob(jobId);
      } else if (autoStopDialog.mode === 'running-bulk') {
        const selected = new Set(effectiveSelectedStreams().map(k => k.toLowerCase()));
        const runningJobs = orchestratorJobs.filter(job => job.status === 'RUNNING' || job.status === 'STARTING');
        if (runningJobs.some(job => String(job.inlineConfig?.streamKey ?? '').toLowerCase() === 'vibe')) {
          selected.add('vibe');
        }
        const targetJobs = selected.size > 0
          ? runningJobs.filter(job => selected.has(String(job.inlineConfig?.streamKey ?? '').toLowerCase()))
          : runningJobs;
        console.log('🛑 Bulk auto stop', {
          selected: Array.from(selected),
          runningJobs: runningJobs.map(j => ({ id: j.id, streamKey: j.inlineConfig?.streamKey, status: j.status })),
          targetJobs: targetJobs.map(j => ({ id: j.id, streamKey: j.inlineConfig?.streamKey, status: j.status })),
          autoStopChecked,
          totalMinutes,
        });
        await Promise.all(targetJobs.map(job => applyRunningJob(job.id)));
      } else if (autoStopDialog.streamKey) {
        const key = autoStopDialog.streamKey;
        const currentBroadcastId = broadcastSelection[key];
        if (!currentBroadcastId || currentBroadcastId === NEW_BROADCAST_VALUE) return;
        if (!autoStopChecked) {
          await apiClient.updateBroadcastMetadata(currentBroadcastId, { autoStopEnabled: false, autoStopMinutes: undefined, autoStopAt: undefined });
        } else {
          await apiClient.updateBroadcastMetadata(currentBroadcastId, { autoStopEnabled: true, autoStopMinutes: totalMinutes });
        }
        await refreshBroadcasts();
      }
      closeAutoStopDialog();
    } catch (error: any) {
      setError(`Failed to update auto-stop: ${error.message}`);
    }
  };


  const scheduleYouTubeUpdate = (key: StreamKey, updates: { title?: string; description?: string }) => {
    const streamMap = streamsWithJobsRef.current;
    const selectedBroadcastId = broadcastSelectionRef.current[key];
    const stream = streamMap ? streamMap[key] : undefined;
    const stoppedStatuses = new Set(['STOPPED', 'FAILED', 'CANCELED', 'DISMISSED', 'UNKNOWN']);
    const hasActiveJob = !!(stream?.jobId && (!stream.jobStatus || !stoppedStatuses.has(stream.jobStatus)));
    const hasBroadcastSelection = !!(selectedBroadcastId && selectedBroadcastId !== NEW_BROADCAST_VALUE);

    if (!hasActiveJob && !hasBroadcastSelection) {
      return;
    }

    pendingYoutubeUpdatesRef.current[key] = {
      ...pendingYoutubeUpdatesRef.current[key],
      ...updates,
    };

    if (youtubeUpdateTimersRef.current[key]) {
      clearTimeout(youtubeUpdateTimersRef.current[key]!);
    }

    setYoutubeUpdateState(prev => {
      if (prev[key]?.pending) {
        return prev;
      }
      return {
        ...prev,
        [key]: { pending: true },
      };
    });

    youtubeUpdateTimersRef.current[key] = setTimeout(async () => {
      const pending = pendingYoutubeUpdatesRef.current[key];
      pendingYoutubeUpdatesRef.current[key] = {};

      const streamMap = streamsWithJobsRef.current;
      if (!streamMap) {
        setYoutubeUpdateState(prev => ({ ...prev, [key]: { pending: false } }));
        return;
      }
      const stream = streamMap[key];
      const selectedBroadcastId = broadcastSelectionRef.current[key];
      const runningStatuses = new Set(['RUNNING', 'STARTING']);
      const canUpdateJob = !!(stream.jobId && stream.jobStatus && runningStatuses.has(stream.jobStatus));

      try {
        if (canUpdateJob && stream.jobId) {
          await apiClient.updateJobMetadata(stream.jobId, pending);
        } else if (selectedBroadcastId && selectedBroadcastId !== NEW_BROADCAST_VALUE) {
          const updated = await apiClient.updateBroadcastMetadata(selectedBroadcastId, pending);
          setBroadcasts(prev => prev.map(b => (b.broadcastId === updated.broadcastId ? updated : b)));
        } else {
          setYoutubeUpdateState(prev => ({ ...prev, [key]: { pending: false } }));
          return;
        }

        setYoutubeUpdateState(prev => ({
          ...prev,
          [key]: { pending: false, message: 'YouTube updated successfully' },
        }));

        if (youtubeSuccessTimersRef.current[key]) {
          clearTimeout(youtubeSuccessTimersRef.current[key]!);
        }
        youtubeSuccessTimersRef.current[key] = setTimeout(() => {
          setYoutubeUpdateState(prev => ({
            ...prev,
            [key]: { pending: false },
          }));
        }, 5000);
      } catch (error: any) {
        setYoutubeUpdateState(prev => ({ ...prev, [key]: { pending: false } }));
        setError(`Failed to update YouTube: ${error.message}`);
      }
    }, 5000);
  };

  const updateTitle = async (key: StreamKey, title: string) => {
    const selectedBroadcastId = broadcastSelection[key];
    const stream = streamsWithJobs[key];
    const hasBroadcastSelection = !!(selectedBroadcastId && selectedBroadcastId !== NEW_BROADCAST_VALUE);
    
    // Mark that we just updated this stream (to prevent cursor jumps from syncing)
    lastUpdateTimeRef.current[key] = Date.now();
    
    // Always update local state immediately for responsive UI
    draftTitlesRef.current[key] = title;

    if (stream.jobId || hasBroadcastSelection) {
      scheduleYouTubeUpdate(key, { title });
    }
  };

  const dismissStreamError = async (key: StreamKey) => {
    const stream = streamsWithJobs[key];
    if (!stream.jobId) {
      console.log(`No job ID found for stream: ${key}`);
      return;
    }

    try {
      console.log(`Dismissing error for stream: ${key}, job: ${stream.jobId}`);
      await apiClient.dismissJob(stream.jobId);
      setSuccess(`Cleared error state for ${stream.name}`);
    } catch (error: any) {
      console.error(`Failed to dismiss error for stream ${key}:`, error);
      setError(`Failed to dismiss error: ${error.message}`);
    }
  };

  const updateDescription = async (key: StreamKey, description: string) => {
    const selectedBroadcastId = broadcastSelection[key];
    const stream = streamsWithJobs[key];
    const hasBroadcastSelection = !!(selectedBroadcastId && selectedBroadcastId !== NEW_BROADCAST_VALUE);
    
    // Mark that we just updated this stream (to prevent cursor jumps from syncing)
    lastUpdateTimeRef.current[key] = Date.now();
    
    // Always update local state immediately for responsive UI
    draftDescriptionsRef.current[key] = description;

    if (stream.jobId || hasBroadcastSelection) {
      scheduleYouTubeUpdate(key, { description });
    }
  };

  const updateTeamNames = async (key: StreamKey, red?: string, yellow?: string) => {
    try {
      const sheet = getSheetIdentifier(key);
      await apiClient.updateTeamNames(sheet, red, yellow);
      // Update local state
      const updates: Partial<StreamState> = {};
      if (red !== undefined) updates.redTeam = red;
      if (yellow !== undefined) updates.yellowTeam = yellow;
      setStreams(prev => ({ ...prev, [key]: { ...prev[key], ...updates } }));
    } catch (error: any) {
      console.error(`Failed to update team names for ${key}:`, error);
      // Still update local state even if API call fails
      const updates: Partial<StreamState> = {};
      if (red !== undefined) updates.redTeam = red;
      if (yellow !== undefined) updates.yellowTeam = yellow;
      setStreams(prev => ({ ...prev, [key]: { ...prev[key], ...updates } }));
    }
  };

  const toggleSelect = (key: StreamKey) => {
    if (key === 'vibe') return; // Vibe stream is auto-selected, not manually selectable
    // Don't allow unselecting running streams - they should always remain selected
    if (streamsWithJobs[key].isLive) return;
    setSelectedStreams(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };
  const selectAll = () => {
    const nonVibeStreams = streamOrder.filter(k => k !== 'vibe');
    const running = runningStreams();
    const allToSelect = [...new Set([...nonVibeStreams, ...running])];
    setSelectedStreams(allToSelect);
  };
  const clearSelection = () => {
    // Only clear manually selected streams; running streams should always remain selected
    const running = runningStreams();
    setSelectedStreams(running);
  };
  const availableAgents = () => agents.filter(a => a.status === 'IDLE').length;

  // Helper function to get all currently running streams
  const runningStreams = () => streamOrder.filter(key => streamsWithJobs[key].isLive);
  
  // Auto-select Vibe Stream logic
  const shouldAutoSelectVibe = () => {
    const nonVibeSelected = selectedStreams.filter(k => k !== 'vibe');
    const totalStreamsNeeded = nonVibeSelected.length + 1; // +1 for vibe stream
    return nonVibeSelected.length >= 2 && availableAgents() >= totalStreamsNeeded;
  };

  
  // Update selectedStreams to always include running streams and handle vibe auto-selection
  const effectiveSelectedStreams = (): StreamKey[] => {
    // Always include all running streams
    const running = runningStreams();
    const userSelected = selectedStreams;

    // Combine running streams with user selections, removing duplicates
    const combined = [...new Set([...running, ...userSelected])];

    // Handle Vibe Stream auto-selection
    const shouldIncludeVibe = shouldAutoSelectVibe();
    const hasVibe = combined.includes('vibe');

    if (shouldIncludeVibe && !hasVibe) {
      return [...combined, 'vibe'];
    } else if (!shouldIncludeVibe && hasVibe) {
      return combined.filter(k => k !== 'vibe');
    }
    return combined;
  };
  
  // Helper function to get selected streams that are not running
  const selectedButNotRunning = () => {
    const effective = effectiveSelectedStreams();
    return effective.filter(key => !streamsWithJobs[key].isLive);
  };

  // Helper function to get number of selected streams that are not running
  const numSelectedNotRunning = () => selectedButNotRunning().length;

  // Helper function to get number of running streams
  const numRunningStreams = () => runningStreams().length;

  // Counter that includes vibe for display purposes (independent of agent availability)
  const displaySelectedCount = () => {
    const running = runningStreams();
    const userSelected = selectedStreams;
    const combined = [...new Set([...running, ...userSelected])];

    // Include vibe if 2+ non-vibe streams are selected (for display purposes only)
    const nonVibeSelected = selectedStreams.filter(k => k !== 'vibe');
    const shouldIncludeVibe = nonVibeSelected.length >= 2;
    const hasVibe = combined.includes('vibe');

    if (shouldIncludeVibe && !hasVibe) {
      return combined.length + 1;
    }
    return combined.length;
  };

  // Stream start countdown functions
  const queueStreamsForStart = (streamFunctions: (() => Promise<void>)[]) => {
    setPendingStreamStarts(streamFunctions);
  };

  const executePendingStreamStarts = async () => {
    console.log('🚀 executePendingStreamStarts called', {
      hasPending: !!pendingStreamStarts,
      isAlreadyExecuting: isExecutingStreamStartsRef.current,
      pendingCount: pendingStreamStarts?.length || 0
    });

    if (!pendingStreamStarts || isExecutingStreamStartsRef.current) {
      console.log('🚀 executePendingStreamStarts: Skipping (no pending or already executing)');
      return;
    }

    isExecutingStreamStartsRef.current = true;
    console.log('🚀 executePendingStreamStarts: Starting execution');
    setBusy('Starting streams...');
    try {
      await Promise.all(pendingStreamStarts.map((fn, index) => {
        console.log(`🚀 executePendingStreamStarts: Executing function ${index + 1}/${pendingStreamStarts!.length}`);
        return fn();
      }));
      setSuccess(`Started ${pendingStreamStarts.length} stream(s)`);
      setTimeout(() => {
        refreshBroadcasts();
      }, 2000);
    } catch (error: any) {
      setError(`Failed to start streams: ${error.message}`);
    } finally {
      setPendingStreamStarts(null);
      isExecutingStreamStartsRef.current = false;
      console.log('🚀 executePendingStreamStarts: Completed execution');
    }
  };

  const cancelPendingStreamStarts = () => {
    setPendingStreamStarts(null);
  };

  const canStart = () => {
    const notRunning = selectedButNotRunning();
    return notRunning.length > 0 && availableAgents() >= notRunning.length;
  };
  const canStop = () => numRunningStreams() > 0;
  const bulkStart = async () => {
    if (!canStart()) return;
    const streamsToStart = selectedButNotRunning();

    // Queue the stream start functions for the countdown modal
    const streamFunctions = streamsToStart.map((k: StreamKey) => () => startStream(k));

    queueStreamsForStart(streamFunctions);
  };

  const bulkStop = async () => {
    if (!canStop()) return;
    const streamsToStop = runningStreams();
    setBusy('Stopping streams...');
    try {
      await Promise.all(streamsToStop.map((k: StreamKey) => toggleLive(k, false)));
      setSuccess(`Stopped ${streamsToStop.length} stream(s)`);
      setTimeout(() => {
        refreshBroadcasts();
      }, 2000);
    } catch (error: any) {
      setError(`Failed to stop streams: ${error.message}`);
    }
  };

  const toggleBroadcastSelection = (broadcastId: string) => {
    setSelectedBroadcastIds(prev => (
      prev.includes(broadcastId) ? prev.filter(id => id !== broadcastId) : [...prev, broadcastId]
    ));
  };

  const deleteSelectedBroadcasts = async () => {
    if (selectedBroadcastIds.length === 0) return;
    if (!confirm(`Delete ${selectedBroadcastIds.length} broadcast(s)? This will end them on YouTube.`)) return;
    try {
      await Promise.all(selectedBroadcastIds.map(id => apiClient.deleteBroadcast(id)));
      setSelectedBroadcastIds([]);
      await refreshBroadcasts();
      setSuccess(`Deleted ${selectedBroadcastIds.length} broadcast(s)`);
    } catch (error: any) {
      setError(`Failed to delete broadcasts: ${error.message}`);
    }
  };
  // no-op placeholder for future bulk metadata if needed

  const setBusy = (message: string) => setStatus({ kind: 'busy', message });
  const setSuccess = (message: string) => setStatus({ kind: 'success', message });
  const setError = (message: string) => setStatus({ kind: 'error', message });
  const setWarning = (message: string) => setStatus({ kind: 'warning', message });
  const clearStatus = () => setStatus(null);

  // Flash effect when status changes
  useEffect(() => {
    if (status && status.kind !== 'busy') {
      setIsFlashing(true);
      const timer = setTimeout(() => setIsFlashing(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [status]);

  // Load alternate colors setting and team names on mount
  useEffect(() => {
    apiClient.getAlternateColors()
      .then(result => setUseAlternateColors(result.alternateColors))
      .catch(err => console.error('Failed to load alternate colors setting:', err));

    apiClient.getBroadcasts()
      .then(setBroadcasts)
      .catch(err => console.error('Failed to load broadcasts:', err));
    
    // Fetch team names from orchestrator
    fetch('http://localhost:3014/v1/teamnames')
      .then(res => res.json())
      .then(teamNamesData => {
        // teamNamesData structure: { A: { red: '', yellow: '' }, B: { ... }, ... }
        setStreams(prev => {
          const next = { ...prev };
          
          // Map orchestrator sheet IDs to stream keys
          const sheetMapping: Record<string, StreamKey> = {
            'A': 'sheetA',
            'B': 'sheetB',
            'C': 'sheetC',
            'D': 'sheetD',
            'vibe': 'vibe'
          };
          
          // Update each sheet with team names from orchestrator
          Object.entries(sheetMapping).forEach(([sheetId, streamKey]) => {
            if (teamNamesData[sheetId]) {
              next[streamKey] = {
                ...prev[streamKey],
                redTeam: teamNamesData[sheetId].red || '',
                yellowTeam: teamNamesData[sheetId].yellow || ''
              };
            }
          });
          
          return next;
        });
      })
      .catch(err => console.error('Failed to load team names from orchestrator:', err));
  }, []);

  // Auto-scroll to section on page load if URL has fragment
  useEffect(() => {
    if (window.location.hash) {
      const sectionId = window.location.hash.substring(1);
      setActiveSection(sectionId);
      const element = document.getElementById(sectionId);
      if (element) {
        // Small delay to ensure page is fully rendered
        setTimeout(() => {
          element.scrollIntoView({ 
            behavior: 'smooth',
            block: 'start',
            inline: 'nearest'
          });
        }, 100);
      }
    }
  }, []);

  // Update active section based on scroll position
  useEffect(() => {
    const scrollContainer = document.querySelector('.overflow-y-auto') as HTMLElement;
    
    const handleScroll = () => {
      if (!scrollContainer) return;
      
      const sections = ['monitor-manager', 'timer-manager', 'stream-manager'];
      const containerRect = scrollContainer.getBoundingClientRect();
      const containerTop = containerRect.top;
      
      // Find which section is most visible in the viewport
      let activeSectionId = 'monitor-manager';
      let maxVisibility = 0;
      
      sections.forEach(sectionId => {
        const element = document.getElementById(sectionId);
        if (element) {
          const elementRect = element.getBoundingClientRect();
          const elementTop = elementRect.top;
          const elementHeight = elementRect.height;
          
          // Calculate how much of the section is visible
          const visibleTop = Math.max(elementTop, containerTop);
          const visibleBottom = Math.min(elementTop + elementHeight, containerTop + scrollContainer.clientHeight);
          const visibleHeight = Math.max(0, visibleBottom - visibleTop);
          
          if (visibleHeight > maxVisibility) {
            maxVisibility = visibleHeight;
            activeSectionId = sectionId;
          }
        }
      });
      
      if (activeSectionId !== activeSection) {
        setActiveSection(activeSectionId);
        // Update URL fragment without triggering scroll
        window.history.replaceState(null, '', `#${activeSectionId}`);
      }
    };
    
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
      return () => scrollContainer.removeEventListener('scroll', handleScroll);
    }
  }, [activeSection]);

  const allEmpty = useMemo(() => {
    const sheets = ['A','B','C','D'] as (keyof MonitorData)[];
    for (const s of sheets) {
      if ((monitorData[s].red || '').trim()) return false;
      if ((monitorData[s].yellow || '').trim()) return false;
    }
    return true;
  }, [monitorData]);

  const toggleMenu = () => setIsMenuOpen(v => !v);

  const dayOrder = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const timeOrder = ['morning','early','evening','late'];

  function parseLeague(leagueName: string): { dayIdx: number; timeIdx: number; season: 'Fall' | 'Winter'; year: number } {
    const dayIdx = dayOrder.findIndex(d => leagueName.toLowerCase().startsWith(d.toLowerCase()));
    const lower = leagueName.toLowerCase();
    const timeIdx = timeOrder.findIndex(t => lower.includes(t));
    const season: 'Fall' | 'Winter' = lower.includes('winter') ? 'Winter' : 'Fall';
    const yearMatch = leagueName.match(/(20\d{2})/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();
    return { dayIdx: dayIdx === -1 ? 7 : dayIdx, timeIdx: timeIdx === -1 ? 99 : timeIdx, season, year };
  }

  async function synchronizeLeagues() {
    if (!confirm('Warning: all league contexts will be deleted and replaced with leagues discovered in Curling Club Manager. Are you sure you want to continue?')) return;
    setIsSyncing(true);
    try {
      // 1. Delete all contexts of type league (case-insensitive)
      const allContexts = await apiClient.getContexts();
      for (const ctx of allContexts) {
        if ((ctx.type || '').toLowerCase() === 'league') {
          await apiClient.deleteContext(ctx.name);
        }
      }
      // 2. Fetch CCM teams (respect refresh)
      const ccmTeams: any[] = await apiClient.getCcmTeams(false);
      // 3. Build sorted unique league names
      const leagueSet = new Set<string>();
      ccmTeams.forEach(t => {
        if (t.league) leagueSet.add(String(t.league));
      });
      const leagues = Array.from(leagueSet);
      leagues.sort((a,b) => {
        const pa = parseLeague(a);
        const pb = parseLeague(b);
        if (pa.dayIdx !== pb.dayIdx) return pa.dayIdx - pb.dayIdx;
        if (pa.timeIdx !== pb.timeIdx) return pa.timeIdx - pb.timeIdx;
        if (pa.season !== pb.season) return pa.season === 'Fall' ? -1 : 1;
        return pa.year - pb.year;
      });
      // 4. Create contexts with dates by season/year
      const createdMap = new Map<string, { name: string; type: 'league'; startDate: string; endDate: string }>();
      for (const name of leagues) {
        const p = parseLeague(name);
        const startDate = p.season === 'Fall' ? `${p.year}-09-15T00:00:00Z` : `${p.year}-01-01T00:00:00Z`;
        const endDate = p.season === 'Fall' ? `${p.year}-12-31T23:59:59Z` : `${p.year}-05-15T23:59:59Z`;
        await apiClient.createContext({ name, type: 'league', startDate, endDate });
        createdMap.set(name, { name, type: 'league', startDate, endDate });
      }
      // 5. Create teams within their league contexts
      for (const t of ccmTeams) {
        const league = createdMap.get(t.league);
        if (!league) continue;
        
        // Extract player names from nested objects
        const lead = t.lead?.last && t.lead?.first ? `${t.lead.first} ${t.lead.last}` : '';
        const second = t.second?.last && t.second?.first ? `${t.second.first} ${t.second.last}` : '';
        const third = t.vice?.last && t.vice?.first ? `${t.vice.first} ${t.vice.last}` : '';
        const fourth = t.skip?.last && t.skip?.first ? `${t.skip.first} ${t.skip.last}` : '';
        
        const input: CreateTeamRequest = {
          teamName: t.name || `Team ${fourth || third || second || lead}`,
          contextName: league.name,
          contextType: 'league',
          contextStartDate: league.startDate,
          contextEndDate: league.endDate,
          lead: lead || undefined,
          second: second || undefined,
          third: third || undefined,
          fourth: fourth || undefined,
          skipPosition: 'fourth',
          vicePosition: 'third',
          homeClub: undefined, // CCM doesn't provide home club info
        };
        try {
          await apiClient.createTeam(input);
        } catch (err) {
          // continue syncing other teams
          // optionally collect errors if desired
        }
      }
      // Proactively refresh contexts list so dropdown updates
      await queryClient.invalidateQueries({ queryKey: ['contexts'] });
    } catch (e: any) {
      setError(e?.message || 'Synchronization failed');
    } finally {
      setIsSyncing(false);
    }
  }

  async function refreshCcmCache() {
    setIsRefreshingCache(true);
    try {
      // Force CCM to refresh its cache, ignore returned data
      await apiClient.getCcmTeams(true);
    } catch (e: any) {
      setError(e?.message || 'Failed to refresh CCM cache');
    } finally {
      setIsRefreshingCache(false);
    }
  }

  const nowIso = useMemo(() => new Date().toISOString(), []);
  const filteredContexts = useMemo(() => {
    if (showAllContexts) return contexts;
    return contexts.filter((c) => {
      const startOk = !c.startDate || c.startDate <= nowIso;
      const endOk = !c.endDate || c.endDate >= nowIso;
      return startOk && endOk;
    });
  }, [contexts, nowIso, showAllContexts]);

  // Group contexts for dropdown headings
  const miscellaneousContexts = useMemo(() => filteredContexts.filter(c => (c.type || '').toLowerCase() === 'miscellaneous'), [filteredContexts]);
  const tournamentContexts = useMemo(() => filteredContexts.filter(c => (c.type || '').toLowerCase() === 'tournament'), [filteredContexts]);
  const leagueContexts = useMemo(() => filteredContexts.filter(c => (c.type || '').toLowerCase() === 'league'), [filteredContexts]);

  // Ensure selectedContext is in filtered list; if not, pick first available
  useEffect(() => {
    if (!filteredContexts.some((c) => c.name === selectedContext)) {
      if (filteredContexts.length > 0) {
        setSelectedContext(filteredContexts[0].name);
      }
    }
  }, [filteredContexts, selectedContext, setSelectedContext]);

  // Keep selected preset name in sync with list
  useEffect(() => {
    if (presetsLoading) return;
    if (selectedPresetName && !presets.find(p => p.name === selectedPresetName)) {
      setSelectedPresetName('');
    }
  }, [presets, selectedPresetName, presetsLoading]);

  // Persist showAllContexts
  useEffect(() => {
    try { localStorage.setItem('wrmm.showAllContexts', JSON.stringify(showAllContexts)); } catch {}
  }, [showAllContexts]);

  // Persist selected preset
  useEffect(() => {
    try { localStorage.setItem('wrmm.selectedPreset', selectedPresetName || ''); } catch {}
  }, [selectedPresetName]);

  // Persist monitorData per context (only after hydration)
  useEffect(() => {
    if (!monitorHydrated) return;
    try {
      const key = `wrmm.monitorData.${selectedContext || 'noctx'}`;
      localStorage.setItem(key, JSON.stringify(monitorData));
    } catch {}
  }, [monitorData, selectedContext, monitorHydrated]);

  // Restore monitorData when context changes
  useEffect(() => {
    setMonitorHydrated(false);
    try {
      const key = `wrmm.monitorData.${selectedContext || 'noctx'}`;
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.A && parsed?.B && parsed?.C && parsed?.D) {
          setMonitorData(parsed);
          // Reset team origin when restoring cached text
          setTeamOrigin({});
        }
      }
    } catch {}
    setMonitorHydrated(true);
  }, [selectedContext]);

  // Auto-select running streams when they become available
  useEffect(() => {
    const running = runningStreams();
    if (running.length > 0) {
      setSelectedStreams(prev => {
        const combined = [...new Set([...prev, ...running])];
        return combined;
      });
    }
  }, [streamsWithJobs]); // Re-run when streams state changes

  const makeFieldKey = (sheet: keyof MonitorData, team: 'red' | 'yellow') => `${sheet}-${team}`;
  const storageKeyFor = (context: string | undefined, sheet: keyof MonitorData, team: 'red' | 'yellow') => `wrmm.editMode.${context || 'noctx'}.${sheet}.${team}`;

  type EditMode = { teamName: string } | null;
  const [editModes, setEditModes] = useState<Record<string, EditMode>>({});

  // Load edit modes from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem('wrmm.editModes');
      if (raw) setEditModes(JSON.parse(raw));
    } catch {}
  }, []);

  // Persist edit modes
  useEffect(() => {
    try {
      localStorage.setItem('wrmm.editModes', JSON.stringify(editModes));
    } catch {}
  }, [editModes]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Open secret config with "CTRL + SHIFT + /" key chord
      // Note: SHIFT + / produces key="?" in the event
      if (e.key === '?' && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setIsSecretConfigModalOpen(true);
        return;
      }
      // Close secret config modal with Escape
      if (e.key === 'Escape' && isSecretConfigModalOpenRef.current) {
        setIsSecretConfigModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true); // Use capture phase on window to get events before other handlers
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []); // Empty dependency array - stable event listener

  const setFieldEditMode = (sheet: keyof MonitorData, team: 'red' | 'yellow', mode: EditMode) => {
    const key = storageKeyFor(selectedContext, sheet, team);
    setEditModes(prev => {
      // Defensive: ensure we preserve all existing edit modes
      const current = prev || {};
      return {
        ...current,
        [key]: mode
      };
    });
  };

  const clearEditModeForSheet = (sheet: keyof MonitorData) => {
    const redKey = storageKeyFor(selectedContext, sheet, 'red');
    const yellowKey = storageKeyFor(selectedContext, sheet, 'yellow');
    setEditModes(prev => {
      // Defensive: ensure we preserve other edit modes
      const current = prev || {};
      return {
        ...current,
        [redKey]: null,
        [yellowKey]: null
      };
    });
  };

  const clearEditModeForAllSheets = () => {
    (['A','B','C','D'] as (keyof MonitorData)[]).forEach(s => clearEditModeForSheet(s));
  };

  const getFieldEditMode = (sheet: keyof MonitorData, team: 'red' | 'yellow'): EditMode => {
    const key = storageKeyFor(selectedContext, sheet, team);
    return editModes[key] || null;
  };

  const activateField = (sheet: keyof MonitorData, team: 'red' | 'yellow') => {
    setActiveField(makeFieldKey(sheet, team));
    setSearchQuery('');
  };

  const handleSheetChange = (sheet: keyof MonitorData, color: 'red' | 'yellow', value: string) => {
    setMonitorData(prev => ({
      ...prev,
      [sheet]: {
        ...prev[sheet],
        [color]: value
      }
    }));
    setColorsRandomized(false);
    // Any manual edit clears edit mode for this specific field only (not the entire sheet)
    setFieldEditMode(sheet, color, null);
    // Any manual edit clears origin for that field
    setTeamOrigin(prev => ({
      ...prev,
      [sheet]: { ...(prev[sheet] || {}), [color]: undefined }
    }));
    // Clear monitor errors for this sheet if content changes
    if (monitorErrors[sheet]) {
      setMonitorErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[sheet];
        return newErrors;
      });
    }
  };

  const clearAll = () => {
    setMonitorData({ A: { red: '', yellow: '' }, B: { red: '', yellow: '' }, C: { red: '', yellow: '' }, D: { red: '', yellow: '' } });
    setSelectedPresetName('');
    setColorsRandomized(false);
    clearEditModeForAllSheets();
    setTeamOrigin({});
  };

  const randomizeColors = () => {
    setMonitorData(prev => {
      const newData = { ...prev } as MonitorData;
      (Object.keys(newData) as Array<keyof MonitorData>).forEach(sheetKey => {
        if (Math.random() > 0.5) {
          const temp = newData[sheetKey].red;
          newData[sheetKey].red = newData[sheetKey].yellow;
          newData[sheetKey].yellow = temp;
        }
      });
      return newData;
    });
    setColorsRandomized(true);
    // Randomize only swaps within sheets, so swap origins accordingly
    setTeamOrigin(prev => {
      const next: TeamOrigin = { ...prev };
      (['A','B','C','D'] as (keyof MonitorData)[]).forEach(s => {
        const orig = next[s] || {};
        next[s] = { red: orig.yellow, yellow: orig.red };
      });
      return next;
    });
  };

  const swapSheetColors = (sheet: keyof MonitorData) => {
    setMonitorData(prev => ({
      ...prev,
      [sheet]: {
        red: prev[sheet].yellow,
        yellow: prev[sheet].red
      }
    }));
    setColorsRandomized(false);
    clearEditModeForSheet(sheet);
    setTeamOrigin(prev => ({
      ...prev,
      [sheet]: { red: (prev[sheet] || {}).yellow, yellow: (prev[sheet] || {}).red }
    }));
  };

  const swapSheets = (sheet1: keyof MonitorData, sheet2: keyof MonitorData) => {
    setMonitorData(prev => {
      const newData = { ...prev };
      [newData[sheet1], newData[sheet2]] = [newData[sheet2], newData[sheet1]];
      return newData;
    });
    setColorsRandomized(false);
    clearEditModeForAllSheets();
    setTeamOrigin(prev => {
      const next: TeamOrigin = { ...prev };
      const t1 = next[sheet1];
      const t2 = next[sheet2];
      next[sheet1] = t2;
      next[sheet2] = t1;
      return next;
    });
  };

  const pullFromMonitors = async () => {
    setColorsRandomized(false);
    try {
      setBusy('Pulling from monitors...');
      // Use rich monitors response to capture team origin
      const resp = await apiClient.getMonitorsRich();
      const sheets = ['A','B','C','D'] as (keyof MonitorData)[];
      const toText = (players: string[]) => players.filter(p => /[A-Za-z]/.test(p)).join('\n');
      const next: MonitorData = { A: { red: monitorData.A.red, yellow: monitorData.A.yellow }, B: { red: monitorData.B.red, yellow: monitorData.B.yellow }, C: { red: monitorData.C.red, yellow: monitorData.C.yellow }, D: { red: monitorData.D.red, yellow: monitorData.D.yellow } };
      const nextOrigin: TeamOrigin = {};
      const errors: Partial<Record<keyof MonitorData, string>> = {};
      for (const s of sheets) {
        const sheet = (resp as any)[s];
        if (sheet && sheet.status === 'online' && sheet.red && sheet.yellow) {
          // Handle different text formats from monitor service
          let redText: string[];
          let yellowText: string[];

          if (typeof sheet.red.text === 'string') {
            // Text is a single string with newlines
            redText = sheet.red.text.split('\n').filter((line: string) => line.trim());
          } else if (Array.isArray(sheet.red.text)) {
            // Text is an array of player strings
            redText = sheet.red.text;
          } else if (sheet.red.players && Array.isArray(sheet.red.players)) {
            // Legacy format with players array
            redText = sheet.red.players;
          } else {
            redText = [];
          }

          if (typeof sheet.yellow.text === 'string') {
            // Text is a single string with newlines
            yellowText = sheet.yellow.text.split('\n').filter((line: string) => line.trim());
          } else if (Array.isArray(sheet.yellow.text)) {
            // Text is an array of player strings
            yellowText = sheet.yellow.text;
          } else if (sheet.yellow.players && Array.isArray(sheet.yellow.players)) {
            // Legacy format with players array
            yellowText = sheet.yellow.players;
          } else {
            yellowText = [];
          }

          next[s] = { red: toText(redText), yellow: toText(yellowText) };
          // Capture team origin if provided
          if (sheet.red.team) {
            nextOrigin[s] = nextOrigin[s] || {};
            nextOrigin[s]!.red = sheet.red.team as Team;
          }
          if (sheet.yellow.team) {
            nextOrigin[s] = nextOrigin[s] || {};
            nextOrigin[s]!.yellow = sheet.yellow.team as Team;
          }
          clearEditModeForSheet(s);
        } else if (sheet && sheet.status && sheet.status !== 'online') {
          errors[s] = sheet.errorMessage || 'Unknown monitor error';
        }
      }
      setMonitorData(next);
      setTeamOrigin(nextOrigin);
      setMonitorErrors(errors);
      if (Object.keys(errors).length > 0) setWarning('Some monitors reported errors'); else setSuccess('Pulled from monitors');
      setSelectedPresetName('');
    } catch (e: any) {
      setError(e?.message || 'Failed to pull from monitors');
    }
  };

  const upcomingDraw = async () => {
    setColorsRandomized(false);
    try {
      setBusy('Loading upcoming draw...');
      const nextGames = await apiClient.getCcmNextGames();
      // Flatten all games with their sheet key
      type Entry = { sheet: keyof MonitorData; game: any };
      const entries: Entry[] = [];
      (['A','B','C','D'] as (keyof MonitorData)[]).forEach((s) => {
        const arr = Array.isArray((nextGames as any)[s]) ? (nextGames as any)[s] : [];
        arr.forEach((g: any) => entries.push({ sheet: s, game: g }));
      });
      if (entries.length === 0) return;
      // Find earliest ISO date among all games
      entries.sort((a,b) => new Date(a.game.date).getTime() - new Date(b.game.date).getTime());
      const earliestTs = new Date(entries[0].game.date).getTime();
      // Tolerance: match exact same start time
      const atEarliest = entries.filter(e => new Date(e.game.date).getTime() === earliestTs);

      // Update context to match the league of the upcoming draw
      const earliestGame = entries[0].game;
      if (earliestGame.league) {
        const matchingContext = contexts.find(c => c.name === earliestGame.league);
        if (matchingContext) {
          setSelectedContext(earliestGame.league);
          setSuccess(`Context updated to "${earliestGame.league}"`);
        } else {
          setError(`Warning: No context found for league "${earliestGame.league}". Please create a context for this league or select one manually.`);
        }
      }
      // Prepare whimsical placeholders
      const whimsies = ['Echoes', 'Ghosts', 'Tumbleweeds', 'Dust Bunnies', 'Falling Snowflakes', 'Emptiness', 'Phantoms'];
      let whimIdx = Math.floor(Math.random() * whimsies.length);

      const toLine = (person?: { first?: string; last?: string }) => {
        if (!person || !person.first || !person.last) return '';
        return `${person.first} ${person.last}`;
      };
      const teamToText = (t: any) => {
        const fourth = toLine(t?.skip);
        const third = toLine(t?.vice);
        const second = toLine(t?.second);
        const lead = toLine(t?.lead);
        const lines = [fourth, third, second, lead].filter(l => /[A-Za-z]/.test(l));
        return lines.join('\n');
      };

      // Random assignment helper
      const randomBool = () => Math.random() < 0.5;

      setMonitorData(prev => {
        const next: MonitorData = {
          A: { ...prev.A },
          B: { ...prev.B },
          C: { ...prev.C },
          D: { ...prev.D },
        };
        const earliestSheets = new Set<keyof MonitorData>(atEarliest.map(e => e.sheet));
        // Fill sheets with earliest games
        for (const e of atEarliest) {
          const t1 = teamToText(e.game.team1);
          const t2 = teamToText(e.game.team2);
          const redFirst = randomBool();
          next[e.sheet] = redFirst ? { red: t1, yellow: t2 } : { red: t2, yellow: t1 };
          clearEditModeForSheet(e.sheet);
        }
        // Non-playing sheets: whimsical filler
        (['A','B','C','D'] as (keyof MonitorData)[]).forEach(s => {
          if (!earliestSheets.has(s)) {
            const w1 = whimsies[whimIdx % whimsies.length];
            whimIdx++;
            // Ensure second whimsy is different
            let w2 = whimsies[whimIdx % whimsies.length];
            if (w2 === w1) {
              whimIdx++;
              w2 = whimsies[whimIdx % whimsies.length];
            }
            whimIdx++;
            next[s] = { red: w1, yellow: w2 };
            clearEditModeForSheet(s);
          }
        });
        return next;
      });
      setSuccess('Upcoming draw loaded');
      setSelectedPresetName('');
    } catch (err) {
      setError((err as any)?.message || 'Failed to load upcoming draw');
    }
  };

  const publishUpdates = () => {
    const toPlayers = (text: string) => text.split('\n').map(l => l.trim()).filter(l => /[A-Za-z]/.test(l));
    const buildSide = (sheet: keyof MonitorData, color: 'red' | 'yellow') => {
      const originTeam = (teamOrigin[sheet] || {})[color];
      if (originTeam) return originTeam as any; // send full Team
      return { players: toPlayers(monitorData[sheet][color]) };
    };
    const data: { [k in keyof MonitorData]: { red: Team | { players: string[] }, yellow: Team | { players: string[] }, status: 'online' | 'error', errorMessage?: string } } = {
      A: { red: buildSide('A','red'), yellow: buildSide('A','yellow'), status: monitorErrors.A ? 'error' : 'online', errorMessage: monitorErrors.A },
      B: { red: buildSide('B','red'), yellow: buildSide('B','yellow'), status: monitorErrors.B ? 'error' : 'online', errorMessage: monitorErrors.B },
      C: { red: buildSide('C','red'), yellow: buildSide('C','yellow'), status: monitorErrors.C ? 'error' : 'online', errorMessage: monitorErrors.C },
      D: { red: buildSide('D','red'), yellow: buildSide('D','yellow'), status: monitorErrors.D ? 'error' : 'online', errorMessage: monitorErrors.D },
    } as any;
    setBusy('Sending updates to monitors...');
    apiClient.postMonitors(data as any)
      .then(() => setSuccess('Updates sent to monitors'))
      .catch((e) => setError(e?.message || 'Failed to send updates to monitors'));
  };

  // Compose textarea text from a CreateTeamRequest (similar to autocomplete composition inverse)
  function composeTextFromTeam(team: CreateTeamRequest): string {
    const players = [team.fourth || '', team.third || '', team.second || '', team.lead || ''];
    const posToIndex: Record<PlayerPosition, number> = { fourth: 0, third: 1, second: 2, lead: 3 };
    const marked = players.map((name, idx) => {
      let out = name;
      if (team.skipPosition && team.skipPosition !== 'fourth' && posToIndex[team.skipPosition] === idx && out) out = `${out}*`;
      if (team.vicePosition && team.vicePosition !== 'third' && posToIndex[team.vicePosition] === idx && out) out = `${out}**`;
      return out;
    });
    let playerLines = marked.filter(l => /[A-Za-z]/.test(l));
    const headerText = team.teamName && team.homeClub ? `${team.teamName} - ${team.homeClub}` : (team.homeClub || team.teamName || '');
    const includeHeader = Boolean(headerText) && (playerLines.length === 2 || playerLines.length === 4);
    const lines = includeHeader ? [headerText, ...playerLines] : playerLines;
    return lines.join('\n');
  }

  const handleResultSelect = (result: SearchResult, sheet: keyof MonitorData, team: 'red' | 'yellow') => {
    // Capture current context to ensure consistency across all state updates
    const currentContext = selectedContext;

    setColorsRandomized(false);
    const composeFromResult = (r: SearchResult): string => {
      const rawLines = (r.teamData || '').split('\n').map(s => s.trim()).filter(Boolean);
      // teamData lines were [lead, second, third, fourth]; reorder to [fourth, third, second, lead]
      const lead = rawLines[0] || '';
      const second = rawLines[1] || '';
      const third = rawLines[2] || '';
      const fourth = rawLines[3] || '';
      let playerLines = [fourth, third, second, lead];

      // Apply role markers: single * for skip, double ** for vice
      const applyMarkers = (lines: string[]) => {
        const posToIndex: Record<PlayerPosition, number> = { fourth: 0, third: 1, second: 2, lead: 3 };
        let marked = [...lines];
        if (r.skipPosition && r.skipPosition !== 'fourth') {
          const i = posToIndex[r.skipPosition];
          if (marked[i]) marked[i] = `${marked[i]}*`;
        }
        if (r.vicePosition && r.vicePosition !== 'third') {
          const i = posToIndex[r.vicePosition];
          if (marked[i]) marked[i] = `${marked[i]}**`;
        }
        return marked;
      };

      playerLines = playerLines.filter(l => /[A-Za-z]/.test(l));
      playerLines = applyMarkers(playerLines);

      const hasHeaderInfo = Boolean(r.name || r.homeClub);
      const shouldIncludeHeader = hasHeaderInfo && (playerLines.length === 2 || playerLines.length === 4);

      const header = r.name && r.homeClub ? `${r.name} - ${r.homeClub}` : (r.homeClub || r.name || '');
      const lines = shouldIncludeHeader && header ? [header, ...playerLines] : playerLines;
      return lines.join('\n');
    };

    const value = composeFromResult(result);
    // Persist edit mode for this field and team (defer to avoid timing issues)
    if (result.name) {
      const key = storageKeyFor(currentContext, sheet, team);
      setTimeout(() => {
        setEditModes(prev => {
          // Defensive: ensure we preserve all existing edit modes
          const current = prev || {};
          return {
            ...current,
            [key]: { teamName: result.name }
          };
        });
      }, 0);
    }

    // When selecting from search, we only have text and metadata, not full Team object
    // So clear any prior origin and rely on text
    setTeamOrigin(prev => ({
      ...prev,
      [sheet]: { ...(prev[sheet] || {}), [team]: undefined }
    }));

    setMonitorData(prev => ({
      ...prev,
      [sheet]: {
        ...prev[sheet],
        [team]: value
      }
    }));
  };

  const loadPreset = (presetName: string) => {
    const preset = presets.find(p => p.name === presetName);
    if (preset) {
      setMonitorData(preset.data);
      setColorsRandomized(false);

      // Restore edit modes if saved in preset
      if (preset.data.editModes) {
        setEditModes(preset.data.editModes);
      } else {
        clearEditModeForAllSheets();
      }

      // Restore team origins if saved in preset
      if (preset.data.teamOrigins) {
        setTeamOrigin(preset.data.teamOrigins);
      } else {
        setTeamOrigin({});
      }
    }
  };

  // Team saving helpers
  const [teamSaveInitial, setTeamSaveInitial] = useState<null | (Partial<CreateTeamRequest> & { contextName: string; contextType: 'league' | 'tournament' | 'miscellaneous' })>(null);
  const [pendingSaveField, setPendingSaveField] = useState<null | { sheet: keyof MonitorData; color: 'red' | 'yellow' }>(null);

  function parseTeamFromText(value: string): Partial<CreateTeamRequest> {
    const lines = value.split('\n').map(l => l.trim()).filter(l => /[A-Za-z]/.test(l));
    if (lines.length === 0) return {};

    let teamName = '';
    let homeClub = '';
    let players: string[] = [];

    const endsWith = (s: string, suffix: string) => s.endsWith(suffix);

    let startIndex = 0;
    if (lines.length === 3 || lines.length === 5) {
      const header = lines[0];
      startIndex = 1;
      if (header.includes(' - ') || header.includes('/')) {
        const sep = header.includes(' - ') ? ' - ' : '/';
        const [namePart, clubPart] = header.split(sep).map(s => s.trim());
        teamName = namePart || '';
        homeClub = clubPart || '';
      } else {
        homeClub = header;
      }
    }

    players = lines.slice(startIndex);

    const fourth = players[0] || '';
    const third = players[1] || '';
    const second = players[2] || '';
    const lead = players[3] || '';

    const lastName = (full: string) => {
      const parts = full.trim().split(/\s+/);
      return parts.length ? parts[parts.length - 1] : '';
    };

    let defaultSkip: PlayerPosition = 'fourth';
    let defaultVice: PlayerPosition = 'third';

    let skipPos: PlayerPosition | null = null;
    let vicePos: PlayerPosition | null = null;

    const assignRoleFromSuffix = (text: string, idx: number) => {
      const clean = text.replace(/\*+$/, '').trim();
      if (endsWith(text, '**')) {
        vicePos = (['fourth', 'third', 'second', 'lead'][idx] as PlayerPosition);
      } else if (endsWith(text, '*')) {
        skipPos = (['fourth', 'third', 'second', 'lead'][idx] as PlayerPosition);
      }
      return clean;
    };

    const rawPlayers = [fourth, third, second, lead];
    const cleanedPlayers = rawPlayers.map(assignRoleFromSuffix);

    const [cleanFourth, cleanThird, cleanSecond, cleanLead] = cleanedPlayers;

    if (!teamName) {
      if (cleanFourth && cleanThird && cleanSecond) {
        teamName = `Team ${lastName(cleanFourth)}`;
      } else if (cleanFourth && cleanThird) {
        teamName = `${lastName(cleanFourth)}/${lastName(cleanThird)}`;
      }
    }

    let skipPosition: PlayerPosition = (skipPos ?? defaultSkip) as PlayerPosition;
    let vicePosition: PlayerPosition = (vicePos ?? defaultVice) as PlayerPosition;
    if (skipPosition === vicePosition) {
      vicePosition = ((skipPosition as string) === 'third' ? 'fourth' : 'third') as PlayerPosition;
    }

    return {
      teamName,
      homeClub,
      fourth: cleanFourth || undefined,
      third: cleanThird || undefined,
      second: cleanSecond || undefined,
      lead: cleanLead || undefined,
      skipPosition,
      vicePosition,
    } as Partial<CreateTeamRequest>;
  }

  const openSaveTeamModal = (value: string, sheet: keyof MonitorData, teamColor: 'red' | 'yellow') => {
    if (!selectedContext) return;
    const ctx = contexts.find(c => c.name === selectedContext);
    const contextType = (ctx?.type as any) || 'league';
    const initial = parseTeamFromText(value);
    const mode = getFieldEditMode(sheet, teamColor);
    const prefill: Partial<CreateTeamRequest> = { ...initial };
    if (mode?.teamName) {
      // Keep the originally selected team name for updates
      prefill.teamName = mode.teamName;
    }
    setPendingSaveField({ sheet, color: teamColor });
    setTeamSaveInitial({
      ...prefill,
      contextName: selectedContext,
      contextType,
      contextStartDate: ctx?.startDate,
      contextEndDate: ctx?.endDate,
    });
  };

  const onSaveTeam = async (input: CreateTeamRequest) => {
    if (!selectedContext) return;
    try {
      const originalTeamName = getFieldEditMode((pendingSaveField?.sheet as keyof MonitorData) ?? 'A', (pendingSaveField?.color as 'red' | 'yellow') ?? 'red')?.teamName;
      await (originalTeamName
        ? apiClient.updateTeam(selectedContext, originalTeamName, input)
        : apiClient.createTeam(input)
      );
      // No success alert; proactively update textarea on update
      setSuccess(originalTeamName ? 'Team updated' : 'Team created');
      if (pendingSaveField && getFieldEditMode(pendingSaveField.sheet, pendingSaveField.color)?.teamName) {
        const value = composeTextFromTeam(input);
        setMonitorData(prev => ({
          ...prev,
          [pendingSaveField.sheet]: {
            ...prev[pendingSaveField.sheet],
            [pendingSaveField.color]: value,
          }
        }));
        // After saving an update to an existing team, we can safely set origin
        setTeamOrigin(prev => ({
          ...prev,
          [pendingSaveField.sheet]: {
            ...(prev[pendingSaveField.sheet] || {}),
            [pendingSaveField.color]: {
              teamName: input.teamName || originalTeamName,
              contextId: 0,
              lead: input.lead,
              second: input.second,
              third: input.third,
              fourth: input.fourth,
              vicePosition: input.vicePosition,
              skipPosition: input.skipPosition,
              homeClub: input.homeClub,
            } as Team
          }
        }));
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to save team');
    } finally {
      setTeamSaveInitial(null);
      setPendingSaveField(null);
    }
  };

  const onDeleteTeam = async (sheet: keyof MonitorData, teamColor: 'red' | 'yellow') => {
    const mode = getFieldEditMode(sheet, teamColor);
    if (!selectedContext || !mode?.teamName) return;
    if (!confirm(`Delete team \"${mode.teamName}\" from ${selectedContext}?`)) return;
    try {
      await apiClient.deleteTeam(selectedContext, mode.teamName);
      setFieldEditMode(sheet, teamColor, null);
      setSuccess('Team deleted');
    } catch (e: any) {
      setError(e?.message || 'Failed to delete team');
    }
  };

  const onSavePreset = async (name: string) => {
    if (!selectedContext || !name.trim()) return;
    const data: PresetData = {
      A: monitorData.A,
      B: monitorData.B,
      C: monitorData.C,
      D: monitorData.D,
      editModes: { ...editModes },
      teamOrigins: { ...teamOrigin }
    };
    try {
      await savePreset(name.trim(), data);
      setSelectedPresetName(name.trim());
      setIsPresetNameModalOpen(false);
      setSuccess('Preset saved');
    } catch (e: any) {
      setError(e?.message || 'Failed to save preset');
    }
  };

  const onClickDeletePreset = async () => {
    if (!selectedContext || !selectedPresetName) return;
    if (!confirm(`Delete preset \"${selectedPresetName}\"?`)) return;
    try {
      await deletePreset(selectedPresetName);
      setSelectedPresetName('');
      setSuccess('Preset deleted');
    } catch (e: any) {
      setError(e?.message || 'Failed to delete preset');
    }
  };

  const hasContext = !!selectedContext;
  const hasPresets = presets.length > 0;
  const canDelete = !!selectedPresetName;

  const navigateToSection = (sectionId: string) => {
    // Update URL fragment
    window.location.hash = sectionId;
    
    const element = document.getElementById(sectionId);
    if (element) {
      // Use a more reliable approach - scroll the element into view within its scrollable parent
      element.scrollIntoView({ 
        behavior: 'smooth',
        block: 'start',
        inline: 'nearest'
      });
    }
  };

  return (
    <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
      {/* Fixed Height Navigation Bar */}
      <nav className="bg-white border-b shadow-sm">
        <div className="px-4 sm:px-6 lg:px-8 py-4">
          {/* Logo positioned absolutely on the left */}
          <div className="relative h-24">
            <div className="absolute left-0 top-0">
              <img src={logo} alt="Triangle Curling Club Logo" className="h-24 w-auto" />
            </div>
            
            {/* Title and Navigation truly centered on screen */}
            <div className="flex flex-col items-center justify-center h-full">
              <h1 className="text-2xl font-bold text-gray-900 mb-4">Triangle Curling Warm Room Manager</h1>
              
              <div className="flex justify-center">
                <div className="grid grid-cols-3 gap-8 relative">
                  <button
                    onClick={() => navigateToSection('monitor-manager')}
                    className={`px-3 py-2 text-sm font-medium transition-colors duration-200 ${activeSection === 'monitor-manager' ? 'text-blue-600' : 'text-gray-900 hover:text-blue-600'} cursor-pointer`}
                  >
                    Monitor Manager
                  </button>
                  <button
                    onClick={() => navigateToSection('timer-manager')}
                    className={`px-3 py-2 text-sm font-medium transition-colors duration-200 ${activeSection === 'timer-manager' ? 'text-blue-600' : 'text-gray-500 hover:text-blue-600'} cursor-pointer`}
                  >
                    Timer Manager
                  </button>
                  <button
                    onClick={() => navigateToSection('stream-manager')}
                    className={`px-3 py-2 text-sm font-medium transition-colors duration-200 ${activeSection === 'stream-manager' ? 'text-blue-600' : 'text-gray-500 hover:text-blue-600'} cursor-pointer`}
                  >
                    Stream Manager
                  </button>
                  {/* Sliding highlight bar */}
                  <div 
                    className={`absolute bottom-0 h-0.5 bg-blue-600 transition-all duration-300 ease-in-out w-32 ${
                     activeSection === 'monitor-manager' ? 'left-0' :
                     activeSection === 'timer-manager' ? 'left-1/2 transform -translate-x-1/2' :
                     'right-0'
                    }`}
                  ></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </nav>
 
      {/* Main scrollable content - takes remaining height */}
      <div className="flex-1 overflow-y-auto" style={{ scrollBehavior: 'smooth' }}>
        {/* Monitor Manager Section */}
        <section id="monitor-manager" className="min-h-full">
          <div className="px-4 sm:px-6 lg:px-8 py-8">
            {/* Header */}
            

            {/* Quick Actions + Context Selector */}
            <div className="mb-6 flex items-start justify-between gap-4">
              {/* Left: Populate buttons + Presets */}
              <div className="flex flex-col gap-2">
                <p className="text-sm text-gray-600">Populate fields with:</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={upcomingDraw}
                    className="btn btn-primary text-sm px-3 py-2"
                    tabIndex={21}
                  >
                    Upcoming Draw
                  </button>
                  <button
                    onClick={pullFromMonitors}
                    className="btn btn-primary text-sm px-3 py-2"
                    tabIndex={22}
                  >
                    Pull from Monitors
                  </button>

                  {/* Presets UI */}
                  {hasContext && (
                    <>
                      {hasPresets && (
                        <select
                          value={selectedPresetName}
                          onChange={(e) => {
                            const name = e.target.value;
                            setSelectedPresetName(name);
                            if (name) loadPreset(name);
                          }}
                          className="px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 min-w-[200px]"
                          title="Load preset"
                        >
                          <option value="">Load a preset...</option>
                          {presets.map(p => (
                            <option key={p.id} value={p.name}>{p.name}</option>
                          ))}
                        </select>
                      )}

                      {/* Separator and Save */}
                      <span className="text-gray-300 mx-1">|</span>
                      <button
                        className="text-blue-600 hover:text-blue-700 cursor-pointer"
                        title="Save preset"
                        onClick={() => setIsPresetNameModalOpen(true)}
                      >
                        <PlusCircleIcon className="w-6 h-6" />
                      </button>

                      {/* Delete */}
                      {canDelete && (
                        <button
                          className="text-gray-600 hover:text-red-600 ml-1 cursor-pointer"
                          title="Delete selected preset"
                          onClick={onClickDeletePreset}
                        >
                          <TrashIcon className="w-6 h-6" />
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Right: Search Context (right-justified) */}
              <div className="flex flex-col items-end min-w-[300px]">
                <div className="flex items-center gap-2 mb-2">
                  <input
                    id="showAllContexts"
                    type="checkbox"
                    className="h-4 w-4"
                    checked={showAllContexts}
                    onChange={(e) => setShowAllContexts(e.target.checked)}
                    tabIndex={23}
                  />
                  <label htmlFor="showAllContexts" className="text-sm text-gray-700 select-none">
                    Show all contexts
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Context:
                  </label>
                  <select
                    value={selectedContext}
                    onChange={(e) => setSelectedContext(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    disabled={!Array.isArray(filteredContexts) || filteredContexts.length === 0}
                    tabIndex={24}
                  >
                    {Array.isArray(filteredContexts) && filteredContexts.length > 0 ? (
                      <>
                        {miscellaneousContexts.length > 0 && (
                          <optgroup label="Miscellaneous">
                            {miscellaneousContexts.map((context) => (
                              <option key={`misc-${context.id}`} value={context.name}>
                                {context.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {tournamentContexts.length > 0 && (
                          <optgroup label="Tournaments">
                            {tournamentContexts.map((context) => (
                              <option key={`tournament-${context.id}`} value={context.name}>
                                {context.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {leagueContexts.length > 0 && (
                          <optgroup label="Leagues">
                            {leagueContexts.map((context) => (
                              <option key={`league-${context.id}`} value={context.name}>
                                {context.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </>
                    ) : (
                      <option value="">No active contexts</option>
                    )}
                  </select>
                  <button
                    className="btn btn-secondary text-xs px-3 py-2"
                    onClick={() => setIsContextModalOpen({ mode: 'edit' })}
                    disabled={!selectedContext || !filteredContexts.some(c => c.name === selectedContext)}
                    title="Edit selected context"
                  >
                    Edit Context
                  </button>
                  <button
                    className="btn btn-primary text-xs px-3 py-2"
                    onClick={() => setIsContextModalOpen({ mode: 'new' })}
                    title="Create new context"
                  >
                    New Context
                  </button>
                  <div className="relative">
                    <button className="btn btn-secondary text-xs px-3 py-2 ml-2" onClick={toggleMenu} title="More actions">...</button>
                    {isMenuOpen && (
                      <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded shadow z-10">
                        <button
                          className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer"
                          onClick={() => { setIsMenuOpen(false); synchronizeLeagues(); }}
                          disabled={isSyncing || isRefreshingCache}
                        >
                          Synchronize leagues
                        </button>
                        <button
                          className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer"
                          onClick={() => { setIsMenuOpen(false); refreshCcmCache(); }}
                          disabled={isSyncing || isRefreshingCache}
                        >
                          Refresh CCM cache
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {/* Errors and syncing now routed to status bar */}
              </div>
            </div>

            {/* Monitor Grid with Swap Buttons */}
            <div className="flex items-center gap-2">
              {/* Sheet A */}
              <div className="bg-white rounded-lg shadow-md p-4 flex-1">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-bold" style={{ color: 'var(--color-primary-800)' }}>Sheet A</h3>
                  {monitorErrors.A && (
                    <ExclamationSolidIcon className="w-5 h-5 text-red-600" title={monitorErrors.A} />
                  )}
                </div>
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-red-700">🔴 Red Team</label>
                      <div className="flex items-center gap-1 h-5">
                        {monitorData.A.red && selectedContext ? (
                          getFieldEditMode('A','red')?.teamName ? (
                            <>
                              <button className="text-green-600 hover:text-green-700 cursor-pointer" title="Update team..." onClick={() => openSaveTeamModal(monitorData.A.red, 'A', 'red')}>
                                <PencilSquareIcon className="w-5 h-5" />
                              </button>
                              <button className="text-gray-600 hover:text-red-600 cursor-pointer" title="Delete team" onClick={() => onDeleteTeam('A','red')}>
                                <TrashIcon className="w-5 h-5" />
                              </button>
                            </>
                          ) : (
                            <button className="text-blue-600 hover:text-blue-700 cursor-pointer" title="Create new team..." onClick={() => openSaveTeamModal(monitorData.A.red, 'A', 'red')}>
                              <PlusCircleIcon className="w-5 h-5" />
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                    <AutocompleteInput
                      value={monitorData.A.red}
                      onChange={(value) => handleSheetChange('A', 'red', value)}
                      placeholder="Enter red team names..."
                      className="w-full p-2 border border-red-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-red-500 bg-red-50 text-sm resize-none"
                      searchQuery={searchQuery}
                      setSearchQuery={setSearchQuery}
                      searchResults={searchResults}
                      isLoading={isLoading}
                      onSelectResult={(result) => handleResultSelect(result, 'A', 'red')}
                      isActive={activeField === makeFieldKey('A', 'red')}
                      onActivate={() => activateField('A', 'red')}
                      onDeactivate={() => setActiveField(null)}
                      tabIndex={1}
                    />
                  </div>
                  
                  {/* Color Swap Button */}
                  <div className="flex justify-center">
                    <button
                      onClick={() => swapSheetColors('A')}
                      className="btn btn-secondary text-xs px-3 py-1"
                      title="Swap Red and Yellow Teams"
                    >
                      <ArrowsUpDownIcon className="w-4 h-4" />
                    </button>
                  </div>
                  
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-yellow-700">🟡 Yellow Team</label>
                      <div className="flex items-center gap-1 h-5">
                        {monitorData.A.yellow && selectedContext ? (
                          getFieldEditMode('A','yellow')?.teamName ? (
                            <>
                              <button className="text-green-600 hover:text-green-700 cursor-pointer" title="Update team..." onClick={() => openSaveTeamModal(monitorData.A.yellow, 'A', 'yellow')}>
                                <PencilSquareIcon className="w-5 h-5" />
                              </button>
                              <button className="text-gray-600 hover:text-red-600 cursor-pointer" title="Delete team" onClick={() => onDeleteTeam('A','yellow')}>
                                <TrashIcon className="w-5 h-5" />
                              </button>
                            </>
                          ) : (
                            <button className="text-blue-600 hover:text-blue-700 cursor-pointer" title="Create new team..." onClick={() => openSaveTeamModal(monitorData.A.yellow, 'A', 'yellow')}>
                              <PlusCircleIcon className="w-5 h-5" />
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                    <AutocompleteInput
                      value={monitorData.A.yellow}
                      onChange={(value) => handleSheetChange('A', 'yellow', value)}
                      placeholder="Enter yellow team names..."
                      className="w-full p-2 border border-yellow-300 rounded-md focus:ring-2 focus:ring-yellow-500 focus:border-yellow-500 bg-yellow-50 text-sm resize-none"
                      searchQuery={searchQuery}
                      setSearchQuery={setSearchQuery}
                      searchResults={searchResults}
                      isLoading={isLoading}
                      onSelectResult={(result) => handleResultSelect(result, 'A', 'yellow')}
                      isActive={activeField === makeFieldKey('A', 'yellow')}
                      onActivate={() => activateField('A', 'yellow')}
                      onDeactivate={() => setActiveField(null)}
                      tabIndex={2}
                    />
                  </div>
                </div>
              </div>

              {/* Swap A ↔ B Button */}
              <div className="flex items-center justify-center">
                <button
                  onClick={() => swapSheets('A', 'B')}
                  className="btn btn-secondary text-xs px-2 py-1"
                  title="Swap Sheets A and B"
                >
                  <ArrowsRightLeftIcon className="w-4 h-4" />
                </button>
              </div>

              {/* Sheet B */}
              <div className="bg-white rounded-lg shadow-md p-4 flex-1">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-bold" style={{ color: 'var(--color-primary-800)' }}>Sheet B</h3>
                  {monitorErrors.B && (
                    <ExclamationSolidIcon className="w-5 h-5 text-red-600" title={monitorErrors.B} />
                  )}
                </div>
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-red-700">🔴 Red Team</label>
                      <div className="flex items-center gap-1 h-5">
                        {monitorData.B.red && selectedContext ? (
                          getFieldEditMode('B','red')?.teamName ? (
                            <>
                              <button className="text-green-600 hover:text-green-700 cursor-pointer" title="Update team..." onClick={() => openSaveTeamModal(monitorData.B.red, 'B', 'red')}>
                                <PencilSquareIcon className="w-5 h-5" />
                              </button>
                              <button className="text-gray-600 hover:text-red-600 cursor-pointer" title="Delete team" onClick={() => onDeleteTeam('B','red')}>
                                <TrashIcon className="w-5 h-5" />
                              </button>
                            </>
                          ) : (
                            <button className="text-blue-600 hover:text-blue-700 cursor-pointer" title="Create new team..." onClick={() => openSaveTeamModal(monitorData.B.red, 'B', 'red')}>
                              <PlusCircleIcon className="w-5 h-5" />
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                    <AutocompleteInput
                      value={monitorData.B.red}
                      onChange={(value) => handleSheetChange('B', 'red', value)}
                      placeholder="Enter red team names..."
                      className="w-full p-2 border border-red-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-red-500 bg-red-50 text-sm resize-none"
                      searchQuery={searchQuery}
                      setSearchQuery={setSearchQuery}
                      searchResults={searchResults}
                      isLoading={isLoading}
                      onSelectResult={(result) => handleResultSelect(result, 'B', 'red')}
                      isActive={activeField === makeFieldKey('B', 'red')}
                      onActivate={() => activateField('B', 'red')}
                      onDeactivate={() => setActiveField(null)}
                      tabIndex={3}
                    />
                  </div>
                  
                  {/* Color Swap Button */}
                  <div className="flex justify-center">
                    <button
                      onClick={() => swapSheetColors('B')}
                      className="btn btn-secondary text-xs px-3 py-1"
                      title="Swap Red and Yellow Teams"
                    >
                      <ArrowsUpDownIcon className="w-4 h-4" />
                    </button>
                  </div>
                  
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-yellow-700">🟡 Yellow Team</label>
                      <div className="flex items-center gap-1 h-5">
                        {monitorData.B.yellow && selectedContext ? (
                          getFieldEditMode('B','yellow')?.teamName ? (
                            <>
                              <button className="text-green-600 hover:text-green-700 cursor-pointer" title="Update team..." onClick={() => openSaveTeamModal(monitorData.B.yellow, 'B', 'yellow')}>
                                <PencilSquareIcon className="w-5 h-5" />
                              </button>
                              <button className="text-gray-600 hover:text-red-600 cursor-pointer" title="Delete team" onClick={() => onDeleteTeam('B','yellow')}>
                                <TrashIcon className="w-5 h-5" />
                              </button>
                            </>
                          ) : (
                            <button className="text-blue-600 hover:text-blue-700 cursor-pointer" title="Create new team..." onClick={() => openSaveTeamModal(monitorData.B.yellow, 'B', 'yellow')}>
                              <PlusCircleIcon className="w-5 h-5" />
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                    <AutocompleteInput
                      value={monitorData.B.yellow}
                      onChange={(value) => handleSheetChange('B', 'yellow', value)}
                      placeholder="Enter yellow team names..."
                      className="w-full p-2 border border-yellow-300 rounded-md focus:ring-2 focus:ring-yellow-500 focus:border-yellow-500 bg-yellow-50 text-sm resize-none"
                      searchQuery={searchQuery}
                      setSearchQuery={setSearchQuery}
                      searchResults={searchResults}
                      isLoading={isLoading}
                      onSelectResult={(result) => handleResultSelect(result, 'B', 'yellow')}
                      isActive={activeField === makeFieldKey('B', 'yellow')}
                      onActivate={() => activateField('B', 'yellow')}
                      onDeactivate={() => setActiveField(null)}
                      tabIndex={4}
                    />
                  </div>
                </div>
              </div>

              {/* Swap B ↔ C Button */}
              <div className="flex items-center justify-center">
                <button
                  onClick={() => swapSheets('B', 'C')}
                  className="btn btn-secondary text-xs px-2 py-1"
                  title="Swap Sheets B and C"
                >
                  <ArrowsRightLeftIcon className="w-4 h-4" />
                </button>
              </div>

              {/* Sheet C */}
              <div className="bg-white rounded-lg shadow-md p-4 flex-1">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-bold" style={{ color: 'var(--color-primary-800)' }}>Sheet C</h3>
                  {monitorErrors.C && (
                    <ExclamationSolidIcon className="w-5 h-5 text-red-600" title={monitorErrors.C} />
                  )}
                </div>
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-red-700">🔴 Red Team</label>
                      <div className="flex items-center gap-1 h-5">
                        {monitorData.C.red && selectedContext ? (
                          getFieldEditMode('C','red')?.teamName ? (
                            <>
                              <button className="text-green-600 hover:text-green-700 cursor-pointer" title="Update team..." onClick={() => openSaveTeamModal(monitorData.C.red, 'C', 'red')}>
                                <PencilSquareIcon className="w-5 h-5" />
                              </button>
                              <button className="text-gray-600 hover:text-red-600 cursor-pointer" title="Delete team" onClick={() => onDeleteTeam('C','red')}>
                                <TrashIcon className="w-5 h-5" />
                              </button>
                            </>
                          ) : (
                            <button className="text-blue-600 hover:text-blue-700 cursor-pointer" title="Create new team..." onClick={() => openSaveTeamModal(monitorData.C.red, 'C', 'red')}>
                              <PlusCircleIcon className="w-5 h-5" />
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                    <AutocompleteInput
                      value={monitorData.C.red}
                      onChange={(value) => handleSheetChange('C', 'red', value)}
                      placeholder="Enter red team names..."
                      className="w-full p-2 border border-red-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-red-500 bg-red-50 text-sm resize-none"
                      searchQuery={searchQuery}
                      setSearchQuery={setSearchQuery}
                      searchResults={searchResults}
                      isLoading={isLoading}
                      onSelectResult={(result) => handleResultSelect(result, 'C', 'red')}
                      isActive={activeField === makeFieldKey('C', 'red')}
                      onActivate={() => activateField('C', 'red')}
                      onDeactivate={() => setActiveField(null)}
                      tabIndex={5}
                    />
                  </div>
                  
                  {/* Color Swap Button */}
                  <div className="flex justify-center">
                    <button
                      onClick={() => swapSheetColors('C')}
                      className="btn btn-secondary text-xs px-3 py-1"
                      title="Swap Red and Yellow Teams"
                    >
                      <ArrowsUpDownIcon className="w-4 h-4" />
                    </button>
                  </div>
                  
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-yellow-700">🟡 Yellow Team</label>
                      <div className="flex items-center gap-1 h-5">
                        {monitorData.C.yellow && selectedContext ? (
                          getFieldEditMode('C','yellow')?.teamName ? (
                            <>
                              <button className="text-green-600 hover:text-green-700 cursor-pointer" title="Update team..." onClick={() => openSaveTeamModal(monitorData.C.yellow, 'C', 'yellow')}>
                                <PencilSquareIcon className="w-5 h-5" />
                              </button>
                              <button className="text-gray-600 hover:text-red-600 cursor-pointer" title="Delete team" onClick={() => onDeleteTeam('C','yellow')}>
                                <TrashIcon className="w-5 h-5" />
                              </button>
                            </>
                          ) : (
                            <button className="text-blue-600 hover:text-blue-700 cursor-pointer" title="Create new team..." onClick={() => openSaveTeamModal(monitorData.C.yellow, 'C', 'yellow')}>
                              <PlusCircleIcon className="w-5 h-5" />
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                    <AutocompleteInput
                      value={monitorData.C.yellow}
                      onChange={(value) => handleSheetChange('C', 'yellow', value)}
                      placeholder="Enter yellow team names..."
                      className="w-full p-2 border border-yellow-300 rounded-md focus:ring-2 focus:ring-yellow-500 focus:border-yellow-500 bg-yellow-50 text-sm resize-none"
                      searchQuery={searchQuery}
                      setSearchQuery={setSearchQuery}
                      searchResults={searchResults}
                      isLoading={isLoading}
                      onSelectResult={(result) => handleResultSelect(result, 'C', 'yellow')}
                      isActive={activeField === makeFieldKey('C', 'yellow')}
                      onActivate={() => activateField('C', 'yellow')}
                      onDeactivate={() => setActiveField(null)}
                      tabIndex={6}
                    />
                  </div>
                </div>
              </div>

              {/* Swap C ↔ D Button */}
              <div className="flex items-center justify-center">
                <button
                  onClick={() => swapSheets('C', 'D')}
                  className="btn btn-secondary text-xs px-2 py-1"
                  title="Swap Sheets C and D"
                >
                  <ArrowsRightLeftIcon className="w-4 h-4" />
                </button>
              </div>

              {/* Sheet D */}
              <div className="bg-white rounded-lg shadow-md p-4 flex-1">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-bold" style={{ color: 'var(--color-primary-800)' }}>Sheet D</h3>
                  {monitorErrors.D && (
                    <ExclamationSolidIcon className="w-5 h-5 text-red-600" title={monitorErrors.D} />
                  )}
                </div>
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-red-700">🔴 Red Team</label>
                      <div className="flex items-center gap-1 h-5">
                        {monitorData.D.red && selectedContext ? (
                          getFieldEditMode('D','red')?.teamName ? (
                            <>
                              <button className="text-green-600 hover:text-green-700 cursor-pointer" title="Update team..." onClick={() => openSaveTeamModal(monitorData.D.red, 'D', 'red')}>
                                <PencilSquareIcon className="w-5 h-5" />
                              </button>
                              <button className="text-gray-600 hover:text-red-600 cursor-pointer" title="Delete team" onClick={() => onDeleteTeam('D','red')}>
                                <TrashIcon className="w-5 h-5" />
                              </button>
                            </>
                          ) : (
                            <button className="text-blue-600 hover:text-blue-700 cursor-pointer" title="Create new team..." onClick={() => openSaveTeamModal(monitorData.D.red, 'D', 'red')}>
                              <PlusCircleIcon className="w-5 h-5" />
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                    <AutocompleteInput
                      value={monitorData.D.red}
                      onChange={(value) => handleSheetChange('D', 'red', value)}
                      placeholder="Enter red team names..."
                      className="w-full p-2 border border-red-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-red-500 bg-red-50 text-sm resize-none"
                      searchQuery={searchQuery}
                      setSearchQuery={setSearchQuery}
                      searchResults={searchResults}
                      isLoading={isLoading}
                      onSelectResult={(result) => handleResultSelect(result, 'D', 'red')}
                      isActive={activeField === makeFieldKey('D', 'red')}
                      onActivate={() => activateField('D', 'red')}
                      onDeactivate={() => setActiveField(null)}
                      tabIndex={7}
                    />
                  </div>
                  
                  {/* Color Swap Button */}
                  <div className="flex justify-center">
                    <button
                      onClick={() => swapSheetColors('D')}
                      className="btn btn-secondary text-xs px-3 py-1"
                      title="Swap Red and Yellow Teams"
                    >
                      <ArrowsUpDownIcon className="w-4 h-4" />
                    </button>
                  </div>
                  
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-yellow-700">🟡 Yellow Team</label>
                      <div className="flex items-center gap-1 h-5">
                        {monitorData.D.yellow && selectedContext ? (
                          getFieldEditMode('D','yellow')?.teamName ? (
                            <>
                              <button className="text-green-600 hover:text-green-700 cursor-pointer" title="Update team..." onClick={() => openSaveTeamModal(monitorData.D.yellow, 'D', 'yellow')}>
                                <PencilSquareIcon className="w-5 h-5" />
                              </button>
                              <button className="text-gray-600 hover:text-red-600 cursor-pointer" title="Delete team" onClick={() => onDeleteTeam('D','yellow')}>
                                <TrashIcon className="w-5 h-5" />
                              </button>
                            </>
                          ) : (
                            <button className="text-blue-600 hover:text-blue-700 cursor-pointer" title="Create new team..." onClick={() => openSaveTeamModal(monitorData.D.yellow, 'D', 'yellow')}>
                              <PlusCircleIcon className="w-5 h-5" />
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                    <AutocompleteInput
                      value={monitorData.D.yellow}
                      onChange={(value) => handleSheetChange('D', 'yellow', value)}
                      placeholder="Enter yellow team names..."
                      className="w-full p-2 border border-yellow-300 rounded-md focus:ring-2 focus:ring-yellow-500 focus:border-yellow-500 bg-yellow-50 text-sm resize-none"
                      searchQuery={searchQuery}
                      setSearchQuery={setSearchQuery}
                      searchResults={searchResults}
                      isLoading={isLoading}
                      onSelectResult={(result) => handleResultSelect(result, 'D', 'yellow')}
                      isActive={activeField === makeFieldKey('D', 'yellow')}
                      onActivate={() => activateField('D', 'yellow')}
                      onDeactivate={() => setActiveField(null)}
                      tabIndex={8}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="mt-8 flex justify-center gap-4">
              <button
                onClick={clearAll}
                className="btn btn-secondary text-sm px-4 py-2 disabled:opacity-50"
                disabled={allEmpty}
                tabIndex={31}
              >
                Clear All
              </button>
              <button
                onClick={randomizeColors}
                className="btn btn-secondary text-sm px-4 py-2 disabled:opacity-50"
                disabled={colorsRandomized || allEmpty}
                tabIndex={32}
              >
                {colorsRandomized ? 'Colors Randomized!' : 'Randomize Colors'}
              </button>
              <button
                onClick={publishUpdates}
                className="btn btn-primary text-lg px-8 py-4 disabled:opacity-50"
                disabled={allEmpty}
                tabIndex={33}
              >
                Send Updates to Monitors
              </button>
            </div>
          </div>
        </section>

        {/* Timer Manager Section */}
        <section id="timer-manager" className="min-h-full bg-white">
          <TimerManager />
        </section>

        {/* Stream Manager Section */}
        <section id="stream-manager" className="min-h-full bg-gray-50">
          <div className="px-4 sm:px-6 lg:px-8 py-8">
            <div className="mb-8">
              <h1 className="text-3xl font-bold text-gray-900 text-center">Stream Manager</h1>
              <p className="text-center text-gray-500 mt-1">Control multiple streams and monitor agent capacity</p>
            </div>

            {/* Context Selection */}
            <div className="bg-white rounded-lg shadow p-4 mb-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-gray-900">Stream Context</h2>
                <div className="text-sm text-gray-600">Select context for stream titles</div>
              </div>
              <div className="flex items-center gap-2">
                <label className="block text-sm font-medium text-gray-700">
                  Context:
                </label>
                <select
                  value={selectedContext}
                  onChange={(e) => setSelectedContext(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 min-w-[200px]"
                  disabled={!Array.isArray(filteredContexts) || filteredContexts.length === 0}
                >
                  {Array.isArray(filteredContexts) && filteredContexts.length > 0 ? (
                    <>
                      {miscellaneousContexts.length > 0 && (
                        <optgroup label="Miscellaneous">
                          {miscellaneousContexts.map((context) => (
                            <option key={`misc-${context.id}`} value={context.name}>
                              {context.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {tournamentContexts.length > 0 && (
                        <optgroup label="Tournaments">
                          {tournamentContexts.map((context) => (
                            <option key={`tournament-${context.id}`} value={context.name}>
                              {context.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {leagueContexts.length > 0 && (
                        <optgroup label="Leagues">
                          {leagueContexts.map((context) => (
                            <option key={`league-${context.id}`} value={context.name}>
                              {context.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </>
                  ) : (
                    <option disabled>No contexts available</option>
                  )}
                </select>
              </div>
            </div>

            {/* Bulk Controls */}
            <div className="bg-white rounded-lg shadow p-4 mb-6">
                <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-gray-900">Multiple Stream Control</h2>
                  <div className="text-sm text-gray-600">
                    Available agents: {availableAgents()} / {agents.length}
                  </div>
              </div>
                <div className="text-sm text-gray-600 mb-3">
                  Total viewers: {streamOrder.reduce((sum, key) => sum + (streamsWithJobs[key]?.viewers ?? 0), 0)}
                </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 mr-4">
                  <button className="btn btn-secondary text-xs px-3 py-2" onClick={selectAll} title="Select all streams">Select All</button>
                  <button className="btn btn-secondary text-xs px-3 py-2" onClick={clearSelection} title="Clear selection">Clear</button>
                  <span className="text-sm text-gray-600">{displaySelectedCount()} selected</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative inline-flex">
                    <button className="btn btn-primary text-sm px-4 py-2 disabled:opacity-50 rounded-r-none" onClick={bulkStart} disabled={!canStart() || !orchestratorConnected}>
                      {orchestratorConnected ? `Start ${numSelectedNotRunning()} Stream${numSelectedNotRunning() === 1 ? '' : 's'}` : 'Orchestrator Offline'}
                    </button>
                    <button
                      className="btn btn-primary text-sm px-2 py-2 disabled:opacity-50 rounded-l-none border-l border-blue-700/30"
                      onClick={() => setBulkStartMenuOpen(prev => !prev)}
                      disabled={!orchestratorConnected || numSelectedNotRunning() === 0}
                      title="More start options"
                      data-bulk-start-toggle
                    >
                      ▾
                    </button>
                    {bulkStartMenuOpen && (
                      <div className="absolute z-10 right-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded shadow" data-bulk-start-menu>
                        <button
                          className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                          onClick={() => {
                            setBulkStartMenuOpen(false);
                            openScheduleDialog('bulk');
                          }}
                        >
                          Schedule future stream
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="relative inline-flex">
                    <button className="btn btn-secondary text-sm px-4 py-2 disabled:opacity-50 rounded-r-none" onClick={bulkStop} disabled={!canStop() || !orchestratorConnected}>
                      {orchestratorConnected ? `Stop ${numRunningStreams()} Stream${numRunningStreams() === 1 ? '' : 's'}` : 'Orchestrator Offline'}
                    </button>
                    <button
                      className="btn btn-secondary text-sm px-2 py-2 disabled:opacity-50 rounded-l-none border-l border-gray-300/60"
                      onClick={() => setBulkStopMenuOpen(prev => !prev)}
                      disabled={!canStop() || !orchestratorConnected}
                      title="More stop options"
                      data-bulk-stop-toggle
                    >
                      ▾
                    </button>
                    {bulkStopMenuOpen && (
                      <div className="absolute z-10 right-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded shadow" data-bulk-stop-menu>
                        <button
                          className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                          onClick={() => {
                            setBulkStopMenuOpen(false);
                            const running = runningStreams();
                            const selected = effectiveSelectedStreams();
                            const runningSelected = selected.filter((key) => running.includes(key));
                            const targets = runningSelected.length > 0 ? runningSelected : running;
                            if (targets.length > 0) {
                              const stream = streamsWithJobs[targets[0]];
                              const initialMinutes = stream.autoStopAt
                                ? Math.ceil((new Date(stream.autoStopAt).getTime() - nowTick) / 60000)
                                : (stream.autoStopMinutes ?? 135);
                              setAutoStopChecked(!!stream.autoStopEnabled);
                              openAutoStopDialogForRunning(targets, initialMinutes);
                            }
                          }}
                        >
                          Configure auto stop
                        </button>
                      </div>
                    )}
                  </div>
                  <span className="text-gray-300">|</span>
                  <button
                    className="btn btn-secondary text-sm px-4 py-2"
                    onClick={async () => {
                      try {
                        const data = await apiClient.getMonitors();
                        console.log('Monitor data received:', data);
                        
                        // Extract team name based on number of players
                        const extractTeamName = (players: string[]): string => {
                          if (!players || players.length === 0) return '';
                          
                          // Helper to get last name from a full name string
                          const getLastName = (fullName: string): string => {
                            const parts = fullName.trim().split(/\s+/);
                            return parts.length > 0 ? parts[parts.length - 1] : '';
                          };
                          
                          const lineCount = players.length;
                          
                          if (lineCount === 4) {
                            // 4 lines: First line is skip (first and last name) - use last name
                            return getLastName(players[0]);
                          } else if (lineCount === 5) {
                            // 5 lines: Second line is skip - use last name
                            return getLastName(players[1]);
                          } else if (lineCount === 2) {
                            // 2 lines: Doubles game - format as "LastName1/LastName2"
                            const last1 = getLastName(players[0]);
                            const last2 = getLastName(players[1]);
                            return `${last1}/${last2}`;
                          } else if (lineCount === 3) {
                            // 3 lines: Ignore first line, treat as doubles (lines 2 and 3)
                            const last1 = getLastName(players[1]);
                            const last2 = getLastName(players[2]);
                            return `${last1}/${last2}`;
                          }
                          
                          // Fallback: use first line's last name
                          return getLastName(players[0]);
                        };
                        
                        // Update streams with proper immutability
                        setStreams(prev => {
                          const next = { ...prev };
                          
                          const mapSheet = (sheetKey: StreamKey, sheet?: any) => {
                            if (!sheet || sheet.status !== 'online') {
                              console.log(`Skipping ${sheetKey}: not online or no data`);
                              return;
                            }
                            
                            // Parse text into players array (split by newlines)
                            const redPlayers = sheet.red?.text ? sheet.red.text.split('\n').filter((line: string) => line.trim()) : [];
                            const yellowPlayers = sheet.yellow?.text ? sheet.yellow.text.split('\n').filter((line: string) => line.trim()) : [];
                            
                            console.log(`Processing ${sheetKey}:`, {
                              redPlayers,
                              yellowPlayers
                            });
                            
                            const redTeam = extractTeamName(redPlayers);
                            const yellowTeam = extractTeamName(yellowPlayers);
                            
                            console.log(`Extracted team names for ${sheetKey}:`, { redTeam, yellowTeam });
                            
                            // Create new stream object with updated team names
                            if (redTeam || yellowTeam) {
                              next[sheetKey] = {
                                ...prev[sheetKey],
                                ...(redTeam && { redTeam }),
                                ...(yellowTeam && { yellowTeam })
                              };
                              
                              console.log(`Updated ${sheetKey} state:`, next[sheetKey]);
                              
                              // Send to orchestrator
                              const sheetId = getSheetIdentifier(sheetKey);
                              apiClient.updateTeamNames(sheetId, redTeam || undefined, yellowTeam || undefined).catch(err => {
                                console.error(`Failed to update teams for ${sheetKey}:`, err);
                              });
                            }
                          };
                          
                          mapSheet('sheetA', (data as any).A);
                          mapSheet('sheetB', (data as any).B);
                          mapSheet('sheetC', (data as any).C);
                          mapSheet('sheetD', (data as any).D);
                          
                          return next;
                        });
                        setSuccess('Synchronized team names from monitors');
                      } catch (e: any) {
                        setError(e?.message || 'Failed to synchronize team names');
                      }
                    }}
                    title="Set team names from monitors (skip last names or doubles format)"
                  >
                    Synchronize with Monitors
                  </button>
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none" title="Use blue/green colors instead of red/yellow in browser sources">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={useAlternateColors}
                      onChange={async (e) => {
                        const newValue = e.target.checked;
                        setUseAlternateColors(newValue);
                        try {
                          await apiClient.updateAlternateColors(newValue);
                          setSuccess(`Alternate colors ${newValue ? 'enabled' : 'disabled'} - browser sources will ${newValue ? 'use blue/green' : 'use red/yellow'}`);
                        } catch (err: any) {
                          setError(`Failed to update alternate colors: ${err.message}`);
                          setUseAlternateColors(!newValue); // Revert on error
                        }
                      }}
                    />
                    Use Alternate Colors
                  </label>
                </div>
              </div>
            </div>

            {/* Streams Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              {streamOrder.map(key => {
                const s = streamsWithJobs[key];
                const autoStartRecord = broadcasts.find((b) => b.autoStart && b.sheetKey === key);
                const currentBroadcastId = (s.isLive && s.broadcastId)
                  ? s.broadcastId
                  : (autoStartRecord?.broadcastId ?? broadcastSelection[key] ?? NEW_BROADCAST_VALUE);
                const selectedBroadcast = currentBroadcastId && currentBroadcastId !== NEW_BROADCAST_VALUE
                  ? broadcasts.find(b => b.broadcastId === currentBroadcastId)
                  : undefined;
                const autoStartEnabled = !!selectedBroadcast?.autoStart;
                const canToggleAutoStart = orchestratorConnected &&
                  !s.isLive &&
                  currentBroadcastId &&
                  currentBroadcastId !== NEW_BROADCAST_VALUE &&
                  (availableAgents() > 0 || autoStartEnabled);
                const scheduledStartTime = selectedBroadcast?.scheduledStartTime;
                const scheduledStartMs = scheduledStartTime ? new Date(scheduledStartTime).getTime() : undefined;
                const countdownMs = scheduledStartMs ? scheduledStartMs - nowTick : undefined;
                const showCountdown = !s.isLive && countdownMs !== undefined && countdownMs > 0;
                const showAutoStart = showCountdown;
                const runtimeMinutesFromBroadcast = selectedBroadcast?.autoStopMinutes;
                const toCountdown = (ms: number) => {
                  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
                  const hours = Math.floor(totalSeconds / 3600);
                  const minutes = Math.floor((totalSeconds % 3600) / 60);
                  const seconds = totalSeconds % 60;
                  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
                };
                const selected = key === 'vibe'
                  ? selectedStreams.filter(k => k !== 'vibe').length >= 2 // Vibe is selected if 2+ other streams are selected
                  : effectiveSelectedStreams().includes(key);
                const isRunning = s.isLive;
                const isDisabled = isRunning || (key === 'vibe' && selectedStreams.filter(k => k !== 'vibe').length >= 2); // Vibe is disabled when auto-selected
                const restartInfo = s.jobId ? restartInfoByJobId[s.jobId] : undefined;
                const showRestart = Boolean(
                  restartInfo &&
                  s.jobStatus &&
                  !['STOPPED', 'FAILED', 'DISMISSED', 'CANCELED'].includes(s.jobStatus)
                );
                return (
                  <div key={key} className={`bg-white rounded-lg shadow p-4 ${selected ? 'ring-2 ring-blue-500' : ''}`}>
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900">{s.name}</h3>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`inline-block w-2.5 h-2.5 rounded-full ${s.isLive ? 'bg-red-500' : s.error ? 'bg-red-500' : 'bg-gray-300'}`} title={s.isLive ? 'Live' : s.error ? 'Error' : 'Offline'}></span>
                          <span className="text-sm text-gray-600">{s.isLive ? 'LIVE' : s.error ? 'ERROR' : 'OFFLINE'}</span>
                          {s.isPaused && s.isLive && (
                            <>
                              <span className="text-gray-300">•</span>
                              <span className="text-xs font-medium text-amber-700">Paused</span>
                            </>
                          )}
                          {s.isLive && (
                            <>
                              <span className="text-gray-300">•</span>
                              <span className="text-sm text-gray-600">Viewers: {s.viewers}</span>
                            </>
                          )}
                        </div>
                        {showRestart && restartInfo && (
                          <div className="mt-1 text-xs text-amber-700">
                            Restart attempt {restartInfo.attempt}/3{restartInfo.backoffMs ? ` (backoff ${Math.round(restartInfo.backoffMs / 1000)}s)` : ''}
                          </div>
                        )}
                        {showCountdown && (
                          <div className="mt-1 text-xs text-blue-700 flex items-center gap-2">
                            <span>Broadcast set to begin in {toCountdown(countdownMs!)}</span>
                            {autoStartEnabled && selectedBroadcast?.broadcastId && (
                              <button
                                className="text-xs text-blue-600 hover:text-blue-700 underline"
                                onClick={() => cancelAutoStart(selectedBroadcast.broadcastId)}
                              >
                                cancel
                              </button>
                            )}
                          </div>
                        )}
                        {s.isLive && s.autoStopAt && (
                          <div className="mt-1 text-xs text-purple-700 flex items-center gap-2">
                            <span>Auto stopping in {toCountdown(new Date(s.autoStopAt).getTime() - nowTick)}</span>
                            <button
                              className="text-xs text-blue-600 hover:text-blue-700 underline"
                              onClick={() => {
                                const initialMinutes = s.autoStopAt
                                  ? Math.ceil((new Date(s.autoStopAt).getTime() - nowTick) / 60000)
                                  : (s.autoStopMinutes ?? 135);
                                setAutoStopChecked(!!s.autoStopEnabled);
                                openAutoStopDialog(key, 'running', initialMinutes);
                              }}
                            >
                              edit
                            </button>
                          </div>
                        )}
                        {youtubeUpdateState[key]?.pending && (
                          <div className="mt-1 flex items-center gap-2 text-xs text-gray-600">
                            <span className="inline-block w-3 h-3 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
                            Updating YouTube...
                          </div>
                        )}
                        {!youtubeUpdateState[key]?.pending && youtubeUpdateState[key]?.message && (
                          <div className="mt-1 text-xs text-green-700">{youtubeUpdateState[key].message}</div>
                        )}
                        {s.error && (
                          <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-800 relative">
                            <button
                              onClick={() => dismissStreamError(key)}
                              className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center text-red-600 hover:text-red-800 hover:bg-red-100 rounded-full transition-colors"
                              title="Dismiss error"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                            <strong>Error:</strong> {s.error}
                          </div>
                        )}
                      </div>
                      <label className="flex items-center gap-2 text-sm text-gray-700 select-none" title={isRunning ? 'Running streams are always selected' : key === 'vibe' ? 'Auto-selected when 2+ other streams selected and agent available' : 'Select for bulk controls'}>
                        <input type="checkbox" className="h-4 w-4" checked={selected} onChange={() => toggleSelect(key)} disabled={isDisabled} />
                        {key === 'vibe' ? 'Auto' : 'Select'}
                      </label>
                    </div>

                    <div className="mt-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <div className="relative inline-flex">
                          <button
                            className="btn btn-primary text-sm px-4 py-2 disabled:opacity-50 rounded-r-none"
                            onClick={() => toggleLive(key, !s.isLive)}
                            disabled={!orchestratorConnected}
                          >
                            {orchestratorConnected ? (s.isLive ? 'Stop' : 'Start') : 'Offline'}
                          </button>
                          <button
                            className="btn btn-primary text-sm px-2 py-2 disabled:opacity-50 rounded-l-none border-l border-blue-700/30"
                            onClick={() => setStartMenuOpenFor(prev => (prev === key ? null : key))}
                            disabled={!orchestratorConnected}
                            title={s.isLive ? 'More stop options' : 'More start options'}
                            data-start-toggle
                          >
                            ▾
                          </button>
                          {startMenuOpenFor === key && (
                            <div className="absolute z-10 left-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded shadow" data-start-menu>
                              {!s.isLive && (
                                <button
                                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                                  onClick={() => {
                                    setStartMenuOpenFor(null);
                                    openScheduleDialog('single', key);
                                  }}
                                >
                                  Schedule future stream
                                </button>
                              )}
                              {(s.isLive || showCountdown) && (
                                <button
                                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                                  onClick={() => {
                                    setStartMenuOpenFor(null);
                                    const initialMinutes = s.isLive
                                      ? (s.autoStopAt ? Math.ceil((new Date(s.autoStopAt).getTime() - nowTick) / 60000) : (s.autoStopMinutes ?? 135))
                                      : (runtimeMinutesFromBroadcast ?? 135);
                                    setAutoStopChecked(!!(s.isLive ? s.autoStopEnabled : runtimeMinutesFromBroadcast));
                                    openAutoStopDialog(key, s.isLive ? 'running' : 'future', initialMinutes);
                                  }}
                                >
                                  Configure auto stop
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                        {s.isLive && (
                          <button
                            className="btn btn-secondary text-sm px-4 py-2 disabled:opacity-50"
                            onClick={() => togglePause(key)}
                            disabled={!orchestratorConnected || !s.jobId || s.jobStatus !== 'RUNNING'}
                            title={!s.jobId ? 'No active job' : s.jobStatus !== 'RUNNING' ? 'Pause available when running' : s.isPaused ? 'Resume stream' : 'Pause stream'}
                          >
                            {s.isPaused ? 'Unpause' : 'Pause'}
                          </button>
                        )}
                        {!s.isLive && (
                          <button
                            className="btn btn-secondary text-sm px-4 py-2"
                            onClick={() => clearStreamCard(key)}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-1 gap-2">
                        <div className="flex flex-col">
                          <label className="text-sm font-medium text-gray-700 mb-1">Broadcast</label>
                          <select
                            className="px-3 py-2 border border-gray-300 rounded-md disabled:bg-gray-100 disabled:text-gray-500 disabled:border-gray-200 disabled:cursor-not-allowed"
                            value={currentBroadcastId}
                            onChange={async (e) => {
                              const nextId = e.target.value;
                              setBroadcastSelection(prev => ({ ...prev, [key]: nextId }));
                              if (nextId === NEW_BROADCAST_VALUE) {
                                setStreams(prev => ({
                                  ...prev,
                                  [key]: { ...prev[key], title: '', description: '' },
                                }));
                                draftTitlesRef.current[key] = '';
                                draftDescriptionsRef.current[key] = '';
                                return;
                              }
                              if (nextId) {
                                try {
                                  const refreshed = await apiClient.refreshBroadcast(nextId);
                                  setBroadcasts(prev => prev.map(b => (b.broadcastId === refreshed.broadcastId ? refreshed : b)));
                                  setStreams(prev => ({
                                    ...prev,
                                    [key]: {
                                      ...prev[key],
                                      title: refreshed.title ?? prev[key].title,
                                      description: refreshed.description ?? prev[key].description,
                                    },
                                  }));
                                  draftTitlesRef.current[key] = refreshed.title ?? '';
                                  draftDescriptionsRef.current[key] = refreshed.description ?? '';
                                } catch (error: any) {
                                  setError(`Failed to refresh broadcast: ${error.message}`);
                                }
                              }
                            }}
                            disabled={s.isLive || autoStartEnabled}
                          >
                            <option value={NEW_BROADCAST_VALUE}>Create new broadcast</option>
                            {s.isLive && s.broadcastId && !broadcasts.find(b => b.broadcastId === s.broadcastId) && (
                              <option value={s.broadcastId}>Current broadcast (not in list)</option>
                            )}
                            {broadcasts.map((b) => (
                              <option key={b.broadcastId} value={b.broadcastId}>
                                {b.title ? b.title : b.broadcastId}{b.scheduledStartTime ? ` (${new Date(b.scheduledStartTime).toLocaleString()})` : ''}
                              </option>
                            ))}
                          </select>
                          {showAutoStart && (
                            <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
                              <input
                                type="checkbox"
                                checked={autoStartEnabled}
                                disabled={!canToggleAutoStart}
                                onChange={async (e) => {
                                  if (!currentBroadcastId || currentBroadcastId === NEW_BROADCAST_VALUE) return;
                                  try {
                                    const updated = await apiClient.updateBroadcastMetadata(currentBroadcastId, {
                                      autoStart: e.target.checked,
                                      sheetKey: key,
                                    });
                                    setBroadcasts(prev => prev.map(b => (b.broadcastId === updated.broadcastId ? updated : b)));
                                  } catch (error: any) {
                                    setError(`Failed to update auto start: ${error.message}`);
                                  }
                                }}
                              />
                              Auto start stream
                              {!autoStartEnabled && availableAgents() === 0 && (
                                <span className="text-xs text-gray-500">(no agents available)</span>
                              )}
                            </label>
                          )}
                        </div>
                        <div className="flex flex-col">
                          <label className="text-sm font-medium text-gray-700 mb-1">Title</label>
                          <StreamTextField
                            className="px-3 py-2 border border-gray-300 rounded-md"
                            placeholder="<Autogenerated>"
                            value={s.title ?? ''}
                            onChange={value => updateTitle(key, value)}
                          />
                        </div>
                        <div className="flex flex-col">
                          <label className="text-sm font-medium text-gray-700 mb-1">Description</label>
                          <StreamTextField
                            className="px-3 py-2 border border-gray-300 rounded-md min-h-[84px]"
                            placeholder="<Autogenerated>"
                            value={s.description ?? ''}
                            onChange={value => updateDescription(key, value)}
                            isTextarea
                          />
                        </div>
                        {key !== 'vibe' && (
                          <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col">
                              <label className="text-sm font-medium mb-1" style={{ color: useAlternateColors ? '#3B82F6' : '#DC2626' }}>
                                {useAlternateColors ? 'Blue Team' : 'Red Team'}
                              </label>
                              <input className="px-3 py-2 border border-gray-300 rounded-md" placeholder="<Skip last name>" value={s.redTeam || ''} onChange={e => updateTeamNames(key, e.target.value, undefined)} />
                            </div>
                            <div className="flex flex-col">
                              <label className="text-sm font-medium mb-1" style={{ color: useAlternateColors ? '#10B981' : '#EAB308' }}>
                                {useAlternateColors ? 'Green Team' : 'Yellow Team'}
                              </label>
                              <input className="px-3 py-2 border border-gray-300 rounded-md" placeholder="<Skip last name>" value={s.yellowTeam || ''} onChange={e => updateTeamNames(key, undefined, e.target.value)} />
                            </div>
                          </div>
                        )}
                      </div>
                      {s.publicUrl && s.adminUrl && (
                        <div className="flex items-center gap-3 text-sm">
                          <a href={s.publicUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-700" title="Open public stream">Public link</a>
                          <span className="text-gray-300">|</span>
                          <a href={s.adminUrl} target="_blank" rel="noreferrer" className="text-gray-700 hover:text-gray-900" title="Open YouTube Studio">Studio Admin</a>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Agents Status */}
            <div className="mt-8 bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-gray-900">Streaming Agents</h2>
                <div className="text-sm text-gray-600">
                  {!orchestratorConnected ? (
                    <div className="text-xs text-red-600">
                      Orchestrator service not connected
                    </div>
                  ) : (
                    <>
                      Available: {agents.filter(a => a.status === 'IDLE').length} / {agents.length}
                      <span className="ml-2 text-xs text-gray-400">(Total agents: {orchestratorAgents.length})</span>
                      {orchestratorAgents.length === 0 && (
                        <div className="text-xs text-amber-600 mt-1">
                          No agents connected. Agents register when they start up.
                        </div>
                      )}
                      {orchestratorAgents.length > 0 && (
                        <div className="text-xs text-gray-400 mt-1">
                          Agents: {orchestratorAgents.map(a => `${a.name}(${a.state})`).join(', ')}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
              {agents.length > 0 && (
                <div className="mb-3">
                  <button
                    onClick={async () => {
                      const agentCount = agents.length;
                      if (!confirm(`Are you sure you want to reboot all ${agentCount} agent(s)? This will restart all agent machines.`)) {
                        return;
                      }
                      try {
                        const result = await apiClient.rebootAllAgents('Reboot all agents requested from UI');
                        const successCount = result.results.filter(r => r.success).length;
                        const failureCount = result.results.filter(r => !r.success).length;
                        if (failureCount === 0) {
                          setSuccess(`Reboot commands sent to all ${successCount} agent(s)`);
                        } else {
                          setError(`Reboot sent to ${successCount} agent(s), ${failureCount} failed. Check logs for details.`);
                        }
                      } catch (error: any) {
                        setError(`Failed to reboot all agents: ${error.message}`);
                      }
                    }}
                    className="text-sm px-3 py-1.5 rounded bg-red-100 text-red-800 hover:bg-red-200 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                    disabled={!orchestratorConnected || agents.length === 0}
                    title={orchestratorConnected ? `Reboot all ${agents.length} agent(s) via SSH` : 'Orchestrator offline'}
                  >
                    🔄 Restart All Agents
                  </button>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
                {agents.map((a, idx) => {
                  const orchestratorAgent = orchestratorAgents.find(oa => oa.id === a.id);
                  return (
                    <div key={a.id || `agent-${idx}`} className="border rounded-md p-3">
                      <div className="flex items-center justify-between">
                        <div className="font-medium text-gray-800">{a.name}</div>
                        <span className={`inline-block w-2.5 h-2.5 rounded-full ${
                          a.status === 'RUNNING' ? 'bg-green-500' :
                          a.status === 'IDLE' ? 'bg-gray-300' :
                          a.status === 'OFFLINE' ? 'bg-red-500' : 'bg-yellow-400'
                        }`} title={a.status}></span>
                      </div>
                      <div className="mt-1 text-sm text-gray-600">{a.status}</div>
                      {a.assignedStreamKey && (
                        <div className="mt-1 text-xs text-gray-500">Assigned to: {streamsWithJobs[a.assignedStreamKey].name}</div>
                      )}
                      {orchestratorAgent && (
                        <div className="mt-2 space-y-1">
                          <div className="flex items-center gap-2">
                            <label className="text-xs text-gray-600">Drain mode:</label>
                            <button
                              onClick={async () => {
                                try {
                                  await apiClient.setAgentDrain(a.id, !orchestratorAgent.drain);
                                  setSuccess(`${orchestratorAgent.drain ? 'Disabled' : 'Enabled'} drain mode for ${a.name}`);
                                } catch (error: any) {
                                  setError(`Failed to set drain mode: ${error.message}`);
                                }
                              }}
                              className={`text-xs px-2 py-1 rounded disabled:opacity-50 ${
                                orchestratorAgent.drain
                                  ? 'bg-yellow-100 text-yellow-800 hover:bg-yellow-200'
                                  : 'bg-gray-100 text-gray-800 hover:bg-gray-200'
                              }`}
                              disabled={!orchestratorConnected}
                              title={orchestratorConnected ? `${orchestratorAgent.drain ? 'Disable' : 'Enable'} drain mode` : 'Orchestrator offline'}
                            >
                              {orchestratorConnected ? (orchestratorAgent.drain ? 'ON' : 'OFF') : 'N/A'}
                            </button>
                          </div>
                          <button
                            onClick={async () => {
                              if (!confirm(`Are you sure you want to reboot agent "${a.name}"? This will restart the entire machine.`)) {
                                return;
                              }
                              try {
                                const result = await apiClient.rebootAgent(a.id, 'Reboot requested from UI');
                                setSuccess(`Reboot command sent to ${a.name} via ${result.method || 'unknown method'}`);
                              } catch (error: any) {
                                setError(`Failed to reboot agent: ${error.message}`);
                              }
                            }}
                            className="text-xs px-2 py-1 rounded bg-red-100 text-red-800 hover:bg-red-200 disabled:opacity-50 disabled:cursor-not-allowed"
                            disabled={!orchestratorConnected}
                            title={orchestratorConnected ? 'Reboot this agent via SSH' : 'Orchestrator offline'}
                          >
                            🔄 Reboot
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Broadcast Management */}
            <div className="mt-8 bg-white rounded-lg shadow p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-gray-900">Broadcast Management</h2>
                <div className="flex items-center gap-2">
                  <button
                    className="btn btn-secondary text-sm px-3 py-2 disabled:opacity-50"
                    onClick={refreshBroadcasts}
                    disabled={!orchestratorConnected}
                  >
                    Refresh
                  </button>
                  <button
                    className="btn btn-secondary text-sm px-3 py-2 disabled:opacity-50"
                    onClick={deleteSelectedBroadcasts}
                    disabled={!orchestratorConnected || selectedBroadcastIds.length === 0}
                  >
                    Delete Selected
                  </button>
                </div>
              </div>
              {!orchestratorConnected ? (
                <div className="text-xs text-red-600">Orchestrator service not connected</div>
              ) : broadcasts.length === 0 ? (
                <div className="text-sm text-gray-500">No stored broadcasts.</div>
              ) : (
                <div className="space-y-2">
                  {broadcasts.map((b) => (
                    <div key={b.broadcastId} className="flex items-center justify-between border rounded-md px-3 py-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={selectedBroadcastIds.includes(b.broadcastId)}
                          onChange={() => toggleBroadcastSelection(b.broadcastId)}
                        />
                        <div>
                          <div className="text-sm font-medium text-gray-800">
                            {b.title || 'Untitled Broadcast'}
                          </div>
                          <div className="text-xs text-gray-500">
                            {b.scheduledStartTime ? `Scheduled: ${new Date(b.scheduledStartTime).toLocaleString()}` : 'No scheduled start'}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        {b.publicUrl && (
                          <a href={b.publicUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-700">Public</a>
                        )}
                        {b.adminUrl && (
                          <a href={b.adminUrl} target="_blank" rel="noreferrer" className="text-gray-700 hover:text-gray-900">Studio</a>
                        )}
                        <span className="text-gray-400">{b.broadcastId}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
      
      {/* Fixed Height Status Bar at Bottom */}
      <div className={`bg-white border-t px-3 py-2 text-sm transition-all duration-300 ${isFlashing && status?.kind === 'success' ? 'animate-success-flash' : ''} ${isFlashing && status?.kind === 'warning' ? 'animate-warning-flash' : ''} ${isFlashing && status?.kind === 'error' ? 'animate-error-flash' : ''}`}>
        {/* Service Status & Integrations */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <div className="flex items-center gap-1">
              <div className={`w-2 h-2 rounded-full ${orchestratorConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
              <span>Orchestrator</span>
            </div>
          </div>
          <YouTubeOAuthPanel />
        </div>

        {status ? (
          <div className="flex items-center gap-2">
            {status.kind === 'busy' && (
              <span className="inline-block w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
            )}
            {status.kind === 'success' && <CheckSolidIcon className="w-4 h-4 text-green-600" />}
            {status.kind === 'error' && <ExclamationSolidIcon className="w-4 h-4 text-red-600" />}
            {status.kind === 'warning' && <ExclamationSolidIcon className="w-4 h-4 text-yellow-500" />}
            <span className={status.kind === 'error' ? 'text-red-700' : status.kind === 'warning' ? 'text-yellow-700' : 'text-gray-800'}>
              {status.message}
            </span>
            <button className="ml-auto text-xs text-gray-500 hover:text-gray-700" onClick={clearStatus} title="Dismiss">Dismiss</button>
          </div>
        ) : (
          <div className="text-gray-400">Ready</div>
        )}
      </div>
    {/* Modals */}
    {isContextModalOpen && (
      <ContextModal
        mode={isContextModalOpen.mode}
        initial={isContextModalOpen.mode === 'edit' ? contexts.find((c) => c.name === selectedContext) ?? null : null}
        onClose={() => setIsContextModalOpen(null)}
      />
    )}
    {isPresetNameModalOpen && (
      <PresetNameModal
        initialName={selectedPresetName || ''}
        onSave={onSavePreset}
        onCancel={() => setIsPresetNameModalOpen(false)}
      />
    )}
    {teamSaveInitial && (
      <TeamSaveModal
        mode={getFieldEditMode((pendingSaveField?.sheet as keyof MonitorData) ?? 'A', (pendingSaveField?.color as 'red' | 'yellow') ?? 'red')?.teamName ? 'update' : 'create'}
        initial={teamSaveInitial}
        onSave={onSaveTeam}
        onCancel={() => setTeamSaveInitial(null)}
      />
    )}
    {isSecretConfigModalOpen && (
      <SecretConfigModal
        onClose={() => setIsSecretConfigModalOpen(false)}
      />
    )}
    {pendingStreamStarts && (
      <StreamStartCountdownModal
        streamCount={pendingStreamStarts.length}
        onConfirm={executePendingStreamStarts}
        onCancel={cancelPendingStreamStarts}
      />
    )}
    {scheduleDialog.open && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-white rounded-lg shadow-lg p-5 w-[360px]">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            {scheduleDialog.mode === 'bulk' ? 'Schedule Broadcasts' : 'Schedule Broadcast'}
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            Choose a scheduled start time for the broadcast{scheduleDialog.mode === 'bulk' ? 's' : ''}.
          </p>
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="radio"
                name="scheduleMode"
                checked={scheduleMode === 'datetime'}
                onChange={() => setScheduleMode('datetime')}
              />
              Specific date/time
            </label>
            {scheduleMode === 'datetime' && (
              <input
                type="datetime-local"
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                value={scheduledStartLocal}
                onChange={(e) => setScheduledStartLocal(e.target.value)}
              />
            )}
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="radio"
                name="scheduleMode"
                checked={scheduleMode === 'delay'}
                onChange={() => setScheduleMode('delay')}
              />
              Delay (minutes)
            </label>
            {scheduleMode === 'delay' && (
              <input
                type="number"
                min="1"
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                value={delayMinutes}
                onChange={(e) => setDelayMinutes(e.target.value)}
              />
            )}
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={autoStartChecked}
                disabled={availableAgents() === 0}
                onChange={(e) => setAutoStartChecked(e.target.checked)}
              />
              Auto start stream
              {availableAgents() === 0 && (
                <span className="text-xs text-gray-500">(no agents available)</span>
              )}
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={autoStopChecked}
                onChange={(e) => setAutoStopChecked(e.target.checked)}
              />
              Auto stop stream
            </label>
            {autoStopChecked && (
              <div className="space-y-2">
                <div className="text-xs text-gray-500">
                  Set total runtime for this stream.
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col text-xs text-gray-600">
                    Hours
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                      value={autoStopHours}
                      onChange={(e) => setAutoStopHours(e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col text-xs text-gray-600">
                    Minutes
                    <input
                      type="number"
                      min="0"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                      value={autoStopMinutes}
                      onChange={(e) => setAutoStopMinutes(e.target.value)}
                    />
                  </label>
                </div>
              </div>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-secondary text-sm px-3 py-2" onClick={closeScheduleDialog} disabled={isCreatingBroadcast}>Cancel</button>
            <button className="btn btn-primary text-sm px-3 py-2" onClick={confirmScheduleDialog} disabled={isCreatingBroadcast}>
              {isCreatingBroadcast ? 'Creating broadcast...' : 'OK'}
            </button>
          </div>
        </div>
      </div>
    )}
    {autoStopDialog.open && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-white rounded-lg shadow-lg p-5 w-[360px]">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Auto stop stream</h3>
          <p className="text-sm text-gray-600 mb-4">
            {autoStopDialog.mode === 'running'
              ? 'Set time until stop.'
              : autoStopDialog.mode === 'running-bulk'
                ? 'Set time until stop for all running streams.'
                : 'Set total runtime for the scheduled stream.'}
          </p>
          <label className="flex items-center gap-2 text-sm text-gray-700 mb-3">
            <input
              type="checkbox"
              checked={autoStopChecked}
              onChange={(e) => setAutoStopChecked(e.target.checked)}
            />
            Enable auto stop
          </label>
          {autoStopChecked && (
            <div className="space-y-2">
              <div className="text-xs text-gray-500">
                {autoStopDialog.mode === 'running'
                  ? 'Set remaining runtime for this stream.'
                  : autoStopDialog.mode === 'running-bulk'
                    ? 'Set remaining runtime for all running streams.'
                    : 'Set total runtime for this stream.'}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col text-xs text-gray-600">
                  Hours
                  <input
                    type="number"
                    min="0"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    value={autoStopHours}
                    onChange={(e) => setAutoStopHours(e.target.value)}
                  />
                </label>
                <label className="flex flex-col text-xs text-gray-600">
                  Minutes
                  <input
                    type="number"
                    min="0"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    value={autoStopMinutes}
                    onChange={(e) => setAutoStopMinutes(e.target.value)}
                  />
                </label>
              </div>
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-secondary text-sm px-3 py-2" onClick={closeAutoStopDialog}>Cancel</button>
            <button className="btn btn-primary text-sm px-3 py-2" onClick={confirmAutoStopDialog}>OK</button>
          </div>
        </div>
      </div>
    )}
  </div>
);
}; 
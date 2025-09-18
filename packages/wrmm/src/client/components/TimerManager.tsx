import React, { useState, useEffect, useRef } from 'react';
import { PlayIcon, PauseIcon } from '@heroicons/react/24/solid';

interface TimerSettings {
  ends: number;
  gameTimeSec: number;
  noMoreEndsTimeSec: number;
  numberOfEndsAfterNoMoreEndsTime: number;
  pregameTimeSec: number;
  stonesPerEnd: number;
  warningTimeSec: number;
  playWarningSound: boolean;
  playExpirationSound: boolean;
  soundVolume: number;
  pregameColorForeground: string;
  pregameColorBackground: string;
  normalColorForeground: string;
  normalColorBackground: string;
  warningColorForeground: string;
  warningColorBackground: string;
  expiredColorForeground: string;
  expiredColorBackground: string;
  skipStonesMultiplier: number;
  timerSpeedMultiplier: number;
  fontFamily: string;
  fontTransform: string;
  fontWeight: string;
  showCurrentEnd: boolean;
  showEndProgress: boolean;
}

interface HeadlessTimer {
  _date: number;
  isRunning: boolean;
  timeRemaining: number;
  settings: {
    totalTime: number;
    timerSpeedMultiplier: number;
  };
}

interface TimerDetails {
  timerId: string;
  name: string;
  settings: TimerSettings;
  headlessTimer: HeadlessTimer;
  lastModified: string;
  public: boolean;
}

interface TimerPreset {
  name: string;
  settings: TimerSettings;
}

interface TimerPresets {
  basic: TimerPreset[];
  competition?: TimerPreset[];
}

interface TimerData {
  timerId: string | null;
  timerDetails: TimerDetails | null;
  isConnected: boolean;
  error: string | null;
  isLoading: boolean;
  timerSecret: string | null;
  adminPassword: string | null;
  presets: TimerPresets | null;
  selectedPreset: string | null;
}

export const TimerManager: React.FC = () => {
  const [timerData, setTimerData] = useState<TimerData>({
    timerId: null,
    timerDetails: null,
    isConnected: false,
    error: null,
    isLoading: false,
    timerSecret: null,
    adminPassword: null,
    presets: null,
    selectedPreset: null
  });
  
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  
     const wsRef = useRef<WebSocket | null>(null);
   const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
   const pendingRequestsRef = useRef<Map<string, { command: string; timestamp: number }>>(new Map());
   const isMountedRef = useRef(true);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const localTimeRemainingRef = useRef<number>(0);
  const currentTimerIdRef = useRef<string | null>(null);
  // Using moduleState.isConnecting; no local ref needed
  // Module-level singleton to prevent duplicate sockets in StrictMode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const moduleState = (TimerManager as any)._wsSingleton || ((TimerManager as any)._wsSingleton = {
    socket: null as WebSocket | null,
    reconnectTimer: null as NodeJS.Timeout | null,
    isConnecting: false,
  });

  // Generate a random correlation ID
  const generateCorrelationId = (): string => {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  };

  // Send a command and track the pending request
  const sendCommand = (command: string, data: any) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('WebSocket is not connected');
      return;
    }

    const correlationId = generateCorrelationId();
    const message = {
      command,
      data,
      clientId: "wrmm",
      correlationId
    };

    // Track this request
    pendingRequestsRef.current.set(correlationId, {
      command,
      timestamp: Date.now()
    });

    // Clean up old pending requests (older than 30 seconds)
    const now = Date.now();
    for (const [id, request] of pendingRequestsRef.current.entries()) {
      if (now - request.timestamp > 30000) {
        pendingRequestsRef.current.delete(id);
      }
    }

    console.log('Sending command:', message);
    wsRef.current.send(JSON.stringify(message));
  };

  // Fetch admin password from server
  const fetchAdminPassword = async () => {
    try {
      const response = await fetch('/api/timer-admin-password');
      if (response.ok) {
        const data = await response.json();
        if (isMountedRef.current) {
          setTimerData(prev => ({ ...prev, adminPassword: data.password }));
        }
      } else {
        console.error('Failed to fetch admin password');
      }
    } catch (error) {
      console.error('Error fetching admin password:', error);
    }
  };

  // Fetch timer secret using admin password
  const fetchTimerSecret = (timerId: string) => {
    if (!timerId || !timerData.adminPassword || !isMountedRef.current) return;
    
    sendCommand('get-timer-secret', {
      timerId,
      password: timerData.adminPassword
    });
  };

  // Fetch timer presets
  const fetchPresets = () => {
    if (!isMountedRef.current) return;
    
    sendCommand('get-presets', {});
  };

  // Fetch timer details once we have a timer ID
  const fetchTimerDetails = (timerId: string) => {
    if (!timerId || !isMountedRef.current) return;
    
    setTimerData(prev => ({ ...prev, isLoading: true }));
    
    // Fetch timer details
    sendCommand('get-basic', {
      timerId,
      subscribe: true
    });
    
    // Also fetch timer secret for control operations
    if (timerData.adminPassword) {
      fetchTimerSecret(timerId);
    }
  };

  // Connect to websocket
  const connectWebSocket = () => {
    // Prevent multiple connections
    if (moduleState.isConnecting) return;

    if (moduleState.socket && moduleState.socket.readyState === WebSocket.OPEN) {
      wsRef.current = moduleState.socket;
      return;
    }
    
    // Do not forcibly close an existing/connecting socket; reuse if it becomes ready
    
    try {
      moduleState.isConnecting = true;
      const ws = new WebSocket('ws://localhost:4001/ws');
      moduleState.socket = ws;
      wsRef.current = moduleState.socket;

      ws.onopen = () => {
        moduleState.isConnecting = false;
        if (isMountedRef.current) {
          setTimerData(prev => ({ ...prev, isConnected: true, error: null }));
          
                     // Subscribe to live timer updates
           sendCommand('subscribe', {
             topics: ["liveTimer:stream"]
           });
           
           // Send get-live-timer command
           sendCommand('get-live-timer', {
             liveTimerKey: "stream"
           });
           
           // Also fetch presets for the dropdown
           fetchPresets();
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // Handle response messages
          if (data.command === 'response' && data.correlationId) {
            const pendingRequest = pendingRequestsRef.current.get(data.correlationId);
            if (pendingRequest) {
              pendingRequestsRef.current.delete(data.correlationId);
              
                             if (pendingRequest.command === 'get-live-timer') {
                                    if (data.data.result === 'success') {
                     const timerId = data.data.data;
                     if (isMountedRef.current) {
                       currentTimerIdRef.current = timerId;
                       setTimerData(prev => ({ 
                         ...prev, 
                         timerId,
                         error: null 
                       }));
                       
                       // Now fetch the timer details
                       fetchTimerDetails(timerId);
                     }
                   } else if (data.data.result === 'error') {
                   if (isMountedRef.current) {
                     setTimerData(prev => ({ 
                       ...prev, 
                       timerId: null,
                       error: data.data.message 
                     }));
                   }
                 }
                               } else if (pendingRequest.command === 'get-timer-secret') {
                  if (data.data.result === 'success') {
                    if (isMountedRef.current) {
                      setTimerData(prev => ({ 
                        ...prev, 
                        timerSecret: data.data.data 
                      }));
                    }
                  } else if (data.data.result === 'error') {
                    console.error('Failed to get timer secret:', data.data.message);
                  }
                                 } else if (pendingRequest.command === 'get-basic') {
                   if (data.data.result === 'success') {
                     if (isMountedRef.current) {
                       const timerDetails = data.data.data.timer;
                       setTimerData(prev => ({ 
                         ...prev, 
                         timerDetails,
                         isLoading: false,
                         error: null 
                       }));
                       
                       // Update local countdown with server data
                       updateLocalCountdown(
                         timerDetails.headlessTimer.timeRemaining,
                         timerDetails.headlessTimer.isRunning
                       );
                     }
                   } else if (data.data.result === 'error') {
                     if (isMountedRef.current) {
                       setTimerData(prev => ({ 
                         ...prev, 
                         error: data.data.message,
                         isLoading: false
                       }));
                     }
                   }
                 } else if (pendingRequest.command === 'get-presets') {
                   if (data.data.result === 'success') {
                     if (isMountedRef.current) {
                       setTimerData(prev => ({ 
                         ...prev, 
                         presets: data.data.data
                       }));
                     }
                   } else if (data.data.result === 'error') {
                     console.error('Failed to get presets:', data.data.message);
                   }
                 }
            }
          }
          
                     // Handle synchronize messages (real-time updates)
           if (data.data && data.data.command === 'synchronize') {
             if (data.data.data) {
               // Normal synchronize message with timer data
               const timerDetails = data.data.data;
               console.log('Received timer synchronization for timer:', timerDetails.timerId, 'current timer ID ref:', currentTimerIdRef.current);
               
               if (isMountedRef.current) {
                 // Only process synchronize messages for our current timer
                 if (currentTimerIdRef.current === null) {
                   // First timer message - accept it and set our timer ID
                   console.log('First timer message, accepting:', timerDetails.timerId);
                   currentTimerIdRef.current = timerDetails.timerId;
                   setTimerData(prev => ({ 
                     ...prev, 
                     timerId: timerDetails.timerId,
                     timerDetails,
                     isLoading: false
                   }));
                   
                   // Update local countdown with server data
                   updateLocalCountdown(
                     timerDetails.headlessTimer.timeRemaining,
                     timerDetails.headlessTimer.isRunning
                   );
                 } else if (timerDetails.timerId === currentTimerIdRef.current) {
                   // Message for our current timer - process it
                   console.log('Processing synchronize message for current timer:', timerDetails.timerId);
                   setTimerData(prev => ({ 
                     ...prev, 
                     timerDetails,
                     isLoading: false
                   }));
                   
                   // Update local countdown with server data
                   updateLocalCountdown(
                     timerDetails.headlessTimer.timeRemaining,
                     timerDetails.headlessTimer.isRunning
                   );
                 } else {
                   // Message for a different timer - ignore it
                   console.log('IGNORING synchronize message for different timer:', timerDetails.timerId, 'current:', currentTimerIdRef.current);
                   return; // Early return to prevent any processing
                 }
               }
             } else {
               // Synchronize message with no data - timer was deleted
               console.log('Received synchronize message with no data - timer deletion detected');
               
               // Parse the topic to get the timer ID
               const topic = data.topic;
               if (topic && topic.startsWith('timer:basic:')) {
                 const deletedTimerId = topic.replace('timer:basic:', '');
                 console.log('Timer deleted:', deletedTimerId, 'current timer ID ref:', currentTimerIdRef.current);
                 
                 // If this was our current timer, clear the state
                 if (deletedTimerId === currentTimerIdRef.current) {
                   console.log('Our current timer was deleted, clearing state');
                   currentTimerIdRef.current = null;
                   setTimerData(prev => ({ 
                     ...prev, 
                     timerId: null,
                     timerDetails: null,
                     timerSecret: null,
                     isLoading: false,
                     error: null
                   }));
                   
                   // Stop the countdown
                   stopCountdown();
                   
                   // Try to get a new live timer
                   sendCommand('get-live-timer', {
                     liveTimerKey: "stream"
                   });
                 }
               }
             }
           }
           
           // Handle switch-timer messages (when a new timer becomes live)
           if (data.data && data.data.command === 'switch-timer' && data.data.data) {
             console.log('Received timer switch:', data.data.data);
                            if (isMountedRef.current) {
                 const newTimerId = data.data.data.timerId;
                 
                 // Update the timer ID
                 currentTimerIdRef.current = newTimerId;
                 setTimerData(prev => ({ 
                   ...prev, 
                   timerId: newTimerId,
                   timerDetails: null, // Clear old timer details
                   timerSecret: null,  // Clear old timer secret
                   isLoading: true,
                   error: null
                 }));
                 
                 // Fetch details for the new timer
                 fetchTimerDetails(newTimerId);
               }
           }
          
        } catch (_) {}
      };

      ws.onclose = () => {
        moduleState.isConnecting = false;
        if (isMountedRef.current) {
          setTimerData(prev => ({ ...prev, isConnected: false }));
          
          // Clear pending requests
          pendingRequestsRef.current.clear();
          
          // Attempt to reconnect after 5 seconds
          if (moduleState.reconnectTimer) {
            clearTimeout(moduleState.reconnectTimer);
          }
          moduleState.reconnectTimer = setTimeout(() => {
            if (isMountedRef.current) {
              connectWebSocket();
            }
          }, 5000);
        }
      };

      ws.onerror = () => {
        moduleState.isConnecting = false;
        if (isMountedRef.current) {
          setTimerData(prev => ({
            ...prev,
            error: 'Timer service not available. Start the Eye on the Clock timer service to enable timer controls.',
            isConnected: false
          }));
        }
      };

    } catch (error) {
      moduleState.isConnecting = false;
      console.error('Failed to create WebSocket:', error);
      setTimerData(prev => ({ ...prev, error: 'Failed to create WebSocket connection' }));
    }
  };

     // Disconnect websocket
   const disconnectWebSocket = () => {
     if (wsRef.current) {
       wsRef.current.close();
       wsRef.current = null;
     }
     if (reconnectTimeoutRef.current) {
       clearTimeout(reconnectTimeoutRef.current);
       reconnectTimeoutRef.current = null;
     }
     // Clear pending requests
     pendingRequestsRef.current.clear();
     // Stop countdown
     stopCountdown();
     // Clear current timer ID
     currentTimerIdRef.current = null;
     setTimerData(prev => ({ ...prev, isConnected: false }));
   };

  // Connect on component mount
  useEffect(() => {
    isMountedRef.current = true;
    fetchAdminPassword();
    connectWebSocket();
    
    // Cleanup on unmount
    return () => {
      isMountedRef.current = false;
      stopCountdown();
      // Keep module-level socket alive to avoid StrictMode churn during dev
    };
  }, []);

  // Handle shift key events
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setIsShiftPressed(true);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setIsShiftPressed(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Fetch timer secret when admin password becomes available and we have a timer ID
  useEffect(() => {
    if (timerData.adminPassword && timerData.timerId && !timerData.timerSecret) {
      fetchTimerSecret(timerData.timerId);
    }
  }, [timerData.adminPassword, timerData.timerId, timerData.timerSecret]);

  // Fetch timer secret when a new timer is loaded
  useEffect(() => {
    if (timerData.adminPassword && timerData.timerId && !timerData.timerSecret) {
      fetchTimerSecret(timerData.timerId);
    }
  }, [timerData.timerId]);

  // Manual reconnect function
  const handleReconnect = () => {
    disconnectWebSocket();
    connectWebSocket();
  };

  // Start local countdown timer
  const startCountdown = (initialTimeRemaining: number) => {
    // Clear any existing countdown
    stopCountdown();
    
    // Set initial time
    localTimeRemainingRef.current = initialTimeRemaining;
    
    // Start countdown interval
    countdownIntervalRef.current = setInterval(() => {
      if (isMountedRef.current && localTimeRemainingRef.current > 0) {
        localTimeRemainingRef.current -= 1000; // Decrease by 1 second
        // Force re-render to update display
        setTimerData(prev => ({ ...prev }));
      } else if (localTimeRemainingRef.current <= 0) {
        stopCountdown();
      }
    }, 1000);
  };

  // Stop local countdown timer
  const stopCountdown = () => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  };

  // Toggle pause/start timer
  const togglePause = () => {
    if (!timerData.timerId || !timerData.timerSecret) {
      console.error('Cannot toggle timer: missing timer ID or secret');
      return;
    }
    
    sendCommand('toggle-pause-basic', {
      timerId: timerData.timerId,
      secret: timerData.timerSecret
    });
  };

  // Add time to timer (positive for add, negative for subtract)
  const adjustTime = (timeMs: number) => {
    if (!timerData.timerId || !timerData.timerSecret) {
      console.error('Cannot adjust time: missing timer ID or secret');
      return;
    }
    
    // Apply shift multiplier if shift is pressed
    const multiplier = isShiftPressed ? 5 : 1;
    const adjustedTimeMs = timeMs * multiplier;
    
    sendCommand('add-time-basic', {
      timerId: timerData.timerId,
      secret: timerData.timerSecret,
      timeMs: adjustedTimeMs
    });
  };

  // Convenience functions for time adjustments
  const addOneSecond = () => adjustTime(1000);
  const addOneMinute = () => adjustTime(60000);
  const subtractOneSecond = () => adjustTime(-1000);
  const subtractOneMinute = () => adjustTime(-60000);

  // Handle preset selection
  const handlePresetChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setTimerData(prev => ({ ...prev, selectedPreset: event.target.value }));
  };

  // Start a new timer with the selected preset
  const startNewTimer = () => {
    if (!timerData.selectedPreset || !timerData.presets) {
      console.error('Cannot start new timer: no preset selected');
      return;
    }

    // Find the selected preset to get its settings
    const selectedPreset = timerData.presets.basic.find(
      preset => preset.name === timerData.selectedPreset
    );

    if (!selectedPreset) {
      console.error('Selected preset not found');
      return;
    }

    // Send create-basic command with the preset settings
    sendCommand('create-basic', {
      settings: selectedPreset.settings
    });

    // Clear the selection after sending the command
    setTimerData(prev => ({ ...prev, selectedPreset: null }));
  };

  // Update local countdown with server data
  const updateLocalCountdown = (serverTimeRemaining: number, isRunning: boolean) => {
    // Update local time with server data
    localTimeRemainingRef.current = serverTimeRemaining;
    
    if (isRunning && serverTimeRemaining > 0) {
      // Start countdown if timer is running and has time remaining
      startCountdown(serverTimeRemaining);
    } else {
      // Stop countdown if timer is not running or has no time remaining
      stopCountdown();
    }
  };

  // Format time remaining in HH:MM:SS format
  const formatTimeRemaining = (milliseconds: number): string => {
    const totalSeconds = Math.ceil(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    } else {
      return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
  };

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Timer Manager</h1>
      </div>

             {/* Main Timer Display */}
       {timerData.timerDetails ? (
         <div className="max-w-2xl mx-auto mb-8">
           <div className={`bg-white rounded-lg shadow-lg p-8 text-center transition-opacity duration-200 ${
             timerData.isConnected ? 'opacity-100' : 'opacity-50'
           }`}>
            {/* Timer Name as Clickable Link */}
                         <h2 className="text-xl font-semibold text-gray-900 mb-6">
               <a 
                 href={`http://localhost:4001/${timerData.timerDetails.timerId}`}
                 target="_blank"
                 rel="noopener noreferrer"
                 className="text-blue-600 hover:text-blue-800"
                 title="Open timer in Eye on the Clock"
               >
                 {timerData.timerDetails.name}
               </a>
             </h2>
            
            {/* Time Remaining - Main Focus */}
            <div className="mb-6">
              <div className="flex items-center justify-between">
                <div className="flex-1"></div>
                <div className="text-center">
                  <div className="text-6xl font-mono font-bold text-gray-900 mb-2">
                    {formatTimeRemaining(localTimeRemainingRef.current)}
                  </div>
                </div>
                
                {/* Running Status - Positioned to the right */}
                <div className="flex-1 flex justify-end">
                  <div className={`inline-flex items-center px-4 py-2 rounded-full text-sm font-medium ${
                    timerData.timerDetails.headlessTimer.isRunning 
                      ? 'bg-green-100 text-green-800' 
                      : 'bg-gray-100 text-gray-800'
                  }`}>
                    <div className={`w-2 h-2 rounded-full mr-2 ${
                      timerData.timerDetails.headlessTimer.isRunning ? 'bg-green-500' : 'bg-gray-500'
                    }`}></div>
                    {timerData.timerDetails.headlessTimer.isRunning ? 'Running' : 'Paused'}
                  </div>
                </div>
              </div>
              
            </div>
            
            {/* Controls inside card (UI only for now) */}
            <div className="mt-2">
              {/* Primary Control - Start/Pause */}
              <div className="flex justify-center mb-5">
                                 <button
                   type="button"
                   className={`inline-flex items-center gap-2 px-8 py-3 rounded-lg text-white shadow transition-colors focus:outline-none focus:ring-4 focus:ring-offset-2 ${
                     timerData.timerDetails.headlessTimer.isRunning
                       ? 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500'
                       : 'bg-green-600 hover:bg-green-700 focus:ring-green-500'
                   } ${!timerData.isConnected ? 'opacity-50 cursor-not-allowed' : ''}`}
                   title={timerData.timerDetails.headlessTimer.isRunning ? 'Pause timer' : 'Start timer'}
                   onClick={togglePause}
                   disabled={!timerData.isConnected}
                 >
                  {timerData.timerDetails.headlessTimer.isRunning ? (
                    <>
                      <PauseIcon className="w-5 h-5" />
                      <span className="text-lg font-semibold">Pause</span>
                    </>
                  ) : (
                    <>
                      <PlayIcon className="w-5 h-5" />
                      <span className="text-lg font-semibold">Start</span>
                    </>
                  )}
                </button>
              </div>

                             {/* Time Adjustment Controls */}
               <div className="flex justify-center mb-4">
                 <div className="inline-flex rounded-md shadow-sm" role="group">
                                       <button
                      type="button"
                      className={`px-3 py-2 bg-gray-100 text-gray-800 border border-gray-300 hover:bg-gray-200 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-1 text-sm font-medium rounded-l-md w-28 ${
                        !timerData.isConnected ? 'opacity-50 cursor-not-allowed' : ''
                      }`}
                      title={isShiftPressed ? "Subtract 5 minutes" : "Subtract 1 minute"}
                      onClick={subtractOneMinute}
                      disabled={!timerData.isConnected}
                    >
                      {isShiftPressed ? "-5 minutes" : "-1 minute"}
                    </button>
                                         <button
                       type="button"
                       className={`px-3 py-2 bg-gray-100 text-gray-800 border border-gray-300 hover:bg-gray-200 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-1 text-sm font-medium w-28 ${
                         !timerData.isConnected ? 'opacity-50 cursor-not-allowed' : ''
                       }`}
                       title={isShiftPressed ? "Subtract 5 seconds" : "Subtract 1 second"}
                       onClick={subtractOneSecond}
                       disabled={!timerData.isConnected}
                     >
                      {isShiftPressed ? "-5 seconds" : "-1 second"}
                    </button>
                                         <button
                       type="button"
                       className={`px-3 py-2 bg-gray-100 text-gray-800 border border-gray-300 hover:bg-gray-200 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-1 text-sm font-medium w-28 ${
                         !timerData.isConnected ? 'opacity-50 cursor-not-allowed' : ''
                       }`}
                       title={isShiftPressed ? "Add 5 seconds" : "Add 1 second"}
                       onClick={addOneSecond}
                       disabled={!timerData.isConnected}
                     >
                      {isShiftPressed ? "+5 seconds" : "+1 second"}
                    </button>
                                         <button
                       type="button"
                       className={`px-3 py-2 bg-gray-100 text-gray-800 border border-gray-300 hover:bg-gray-200 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-1 text-sm font-medium rounded-r-md w-28 ${
                         !timerData.isConnected ? 'opacity-50 cursor-not-allowed' : ''
                       }`}
                       title={isShiftPressed ? "Add 5 minutes" : "Add 1 minute"}
                       onClick={addOneMinute}
                       disabled={!timerData.isConnected}
                     >
                      {isShiftPressed ? "+5 minutes" : "+1 minute"}
                    </button>
                 </div>
               </div>

                                          {/* Start New Timer - with preset selection */}
               <div className="flex justify-center mt-4">
                 <div className="flex items-center gap-3">
                   <select
                     value={timerData.selectedPreset || ''}
                     onChange={handlePresetChange}
                     className={`px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-gray-500 focus:border-gray-500 ${
                       !timerData.isConnected ? 'opacity-50 cursor-not-allowed' : ''
                     }`}
                     disabled={!timerData.presets || !timerData.isConnected}
                   >
                     <option value="">Select timer type...</option>
                     {timerData.presets?.basic?.map((preset, index) => (
                       <option key={index} value={preset.name}>
                         {preset.name}
                       </option>
                     ))}
                   </select>
                                        <button
                       type="button"
                       className={`inline-flex items-center gap-2 px-5 py-2 rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed ${
                         !timerData.isConnected ? 'opacity-50 cursor-not-allowed' : ''
                       }`}
                       title="Start a new timer"
                       disabled={!timerData.selectedPreset || !timerData.isConnected}
                       onClick={startNewTimer}
                     >
                       Start New Timer
                     </button>
                 </div>
               </div>
             </div>
  
             
           </div>
         </div>
               ) : (
          /* No Timer Found State */
          <div className="max-w-md mx-auto mb-8">
            <div className="bg-white rounded-lg shadow-md p-8 text-center">
              <div className="text-gray-400 mb-4">
                <svg className="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-900 mb-2">No Active Timer</h3>
              <p className="text-gray-500 mb-6">No timer is currently active.</p>
              
              {/* Create New Timer - Integrated */}
              <div className="flex items-center justify-center gap-3">
                <select
                  value={timerData.selectedPreset || ''}
                  onChange={handlePresetChange}
                  className={`px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-gray-500 focus:border-gray-500 ${
                    !timerData.isConnected ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                  disabled={!timerData.presets || !timerData.isConnected}
                >
                  <option value="">Select timer type...</option>
                  {timerData.presets?.basic?.map((preset, index) => (
                    <option key={index} value={preset.name}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`inline-flex items-center gap-2 px-5 py-2 rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed ${
                    !timerData.isConnected ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                  title="Start a new timer"
                  disabled={!timerData.selectedPreset || !timerData.isConnected}
                  onClick={startNewTimer}
                >
                  Start New Timer
                </button>
              </div>
            </div>
          </div>
        )}

             {/* Connection Status - Less Prominent */}
       <div className="max-w-md mx-auto">
         <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
           <h3 className="text-sm font-medium text-gray-900 mb-3">Eye on the Clock Server</h3>
           <div className="flex items-center justify-between text-sm">
             <span className="text-gray-600">Connection:</span>
             <div className="flex items-center gap-2">
               <div className={`w-2 h-2 rounded-full ${timerData.isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
               <span className={`text-xs ${timerData.isConnected ? 'text-green-700' : 'text-red-700'}`}>
                 {timerData.isConnected ? 'Connected' : 'Disconnected'}
               </span>
             </div>
           </div>
          
          {/* Timer ID */}
          {timerData.timerId && (
            <div className="flex items-center justify-between text-sm mt-2">
              <span className="text-gray-600">Timer ID:</span>
              <span className="text-xs font-mono text-gray-700">{timerData.timerId}</span>
            </div>
          )}
          
          {/* Loading State */}
          {timerData.isLoading && (
            <div className="flex items-center justify-center py-2 mt-2">
              <div className="w-3 h-3 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin"></div>
              <span className="text-xs text-blue-600 ml-2">Loading...</span>
            </div>
          )}
          
          {/* Error Display */}
          {timerData.error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-2 mt-2">
              <p className="text-xs text-red-700">{timerData.error}</p>
            </div>
          )}
          
          {/* Action Buttons */}
          <div className="flex gap-2 mt-3">
                         <button
               onClick={handleReconnect}
               className="flex-1 bg-gray-600 text-white px-3 py-1.5 rounded text-xs hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-1 transition-colors"
             >
               Reconnect
             </button>
            <button
              onClick={timerData.isConnected ? disconnectWebSocket : connectWebSocket}
              className={`flex-1 px-3 py-1.5 rounded text-xs focus:outline-none focus:ring-2 focus:ring-offset-1 transition-colors ${
                timerData.isConnected
                  ? 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500'
                  : 'bg-green-600 text-white hover:bg-green-700 focus:ring-green-500'
              }`}
            >
              {timerData.isConnected ? 'Disconnect' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

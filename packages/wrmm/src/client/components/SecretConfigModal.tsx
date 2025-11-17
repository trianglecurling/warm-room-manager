import React, { useState, useEffect } from 'react';
import { apiClient, OAuthStatus, OrchestratorAgent } from '../lib/api';

interface SecretConfigModalProps {
  onClose: () => void;
}

const STREAM_VISIBILITY_KEY = 'wrmm.streamVisibility';

type OAuthPanelState =
  | { loading: true; status?: undefined; error?: undefined }
  | { loading: false; status: OAuthStatus; error?: undefined }
  | { loading: false; status?: undefined; error: string };

interface SSHSettings {
  host: string;
  user: string;
  keyPath: string;
  rebootCommand: string;
}

export const SecretConfigModal: React.FC<SecretConfigModalProps> = ({ onClose }) => {
  const [streamVisibility, setStreamVisibility] = useState<'public' | 'unlisted'>('unlisted');
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthState, setOauthState] = useState<OAuthPanelState>({ loading: true });
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [agents, setAgents] = useState<OrchestratorAgent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [sshSettings, setSshSettings] = useState<Record<string, SSHSettings>>({});
  const [savingAgentId, setSavingAgentId] = useState<string | null>(null);

  // Load saved setting on mount
  useEffect(() => {
    const saved = localStorage.getItem(STREAM_VISIBILITY_KEY);
    if (saved === 'public' || saved === 'unlisted') {
      setStreamVisibility(saved);
    }
  }, []);

  // Load OAuth status on mount
  useEffect(() => {
    const loadOAuthStatus = async () => {
      setOauthState({ loading: true });
      try {
        const status = await apiClient.getOAuthStatus();
        setOauthState({ loading: false, status });
      } catch (e: any) {
        setOauthState({ loading: false, error: e?.message || 'Failed to load OAuth status' });
      }
    };
    loadOAuthStatus();
  }, []);

  // Load agents on mount
  useEffect(() => {
    const loadAgents = async () => {
      setLoadingAgents(true);
      try {
        const agentsData = await apiClient.getAgents();
        setAgents(agentsData);
        
        // Initialize SSH settings from agent metadata
        const initialSshSettings: Record<string, SSHSettings> = {};
        agentsData.forEach(agent => {
          const sshMeta = agent.meta?.ssh as Partial<SSHSettings> | undefined;
          initialSshSettings[agent.id] = {
            host: sshMeta?.host || '',
            user: sshMeta?.user || 'Administrator',
            keyPath: sshMeta?.keyPath || '',
            rebootCommand: sshMeta?.rebootCommand || 'shutdown /r /f /t 0',
          };
        });
        setSshSettings(initialSshSettings);
      } catch (e: any) {
        console.error('Failed to load agents:', e);
      } finally {
        setLoadingAgents(false);
      }
    };
    loadAgents();
  }, []);

  const disconnectOAuth = async () => {
    setIsDisconnecting(true);
    try {
      await apiClient.clearOAuthToken();
      // Reload status after disconnect
      const status = await apiClient.getOAuthStatus();
      setOauthState({ loading: false, status });
    } catch (e: any) {
      setOauthState({ loading: false, error: e?.message || 'Failed to disconnect' });
    } finally {
      setIsDisconnecting(false);
    }
  };

  // Save setting when it changes
  const handleVisibilityChange = async (value: 'public' | 'unlisted') => {
    setStreamVisibility(value);
    localStorage.setItem(STREAM_VISIBILITY_KEY, value);

    // Also update the orchestrator setting
    setIsUpdating(true);
    setError(null);

    try {
      await apiClient.updateStreamPrivacy(value);
    } catch (err) {
      setError('Failed to update orchestrator setting');
      console.error('Failed to update stream privacy:', err);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  const handleSshSettingChange = (agentId: string, field: keyof SSHSettings, value: string) => {
    setSshSettings(prev => ({
      ...prev,
      [agentId]: {
        ...prev[agentId],
        [field]: value,
      },
    }));
  };

  const handleSaveSshSettings = async (agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return;

    setSavingAgentId(agentId);
    try {
      const settings = sshSettings[agentId];
      await apiClient.updateAgentMeta(agentId, {
        ...agent.meta,
        ssh: {
          host: settings.host,
          user: settings.user || 'Administrator',
          keyPath: settings.keyPath || undefined,
          rebootCommand: settings.rebootCommand || 'shutdown /r /f /t 0',
        },
      });
      
      // Reload agents to get updated metadata
      const updatedAgents = await apiClient.getAgents();
      setAgents(updatedAgents);
      setEditingAgentId(null);
    } catch (e: any) {
      setError(`Failed to save SSH settings: ${e?.message || 'Unknown error'}`);
    } finally {
      setSavingAgentId(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Secret Configuration</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Close"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label htmlFor="streamVisibility" className="block text-sm font-medium text-gray-700 mb-2">
              Live Stream Visibility
            </label>
            <select
              id="streamVisibility"
              value={streamVisibility}
              onChange={(e) => handleVisibilityChange(e.target.value as 'public' | 'unlisted')}
              disabled={isUpdating}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
            </select>
            <p className="mt-1 text-sm text-gray-500">
              Controls the privacy setting for newly created live streams.
            </p>
            {isUpdating && (
              <p className="mt-1 text-sm text-blue-600">
                Updating orchestrator setting...
              </p>
            )}
            {error && (
              <p className="mt-1 text-sm text-red-600">
                {error}
              </p>
            )}
          </div>

          {/* OAuth Management Section */}
          <div className="border-t border-gray-200 pt-4">
            <h3 className="text-sm font-medium text-gray-700 mb-3">YouTube OAuth</h3>

            {oauthState.loading ? (
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <span className="inline-block w-3 h-3 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
                <span>Loading OAuth status...</span>
              </div>
            ) : oauthState.error ? (
              <div className="text-sm text-red-600">
                <span>Error: {oauthState.error}</span>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className={`inline-block w-2 h-2 rounded-full ${
                    oauthState.status?.tokenStatus === 'valid' ? 'bg-green-500' :
                    oauthState.status?.tokenStatus === 'expired' ? 'bg-yellow-500' : 'bg-red-500'
                  }`} />
                  <span className="text-sm text-gray-700">
                    {oauthState.status?.tokenStatus === 'valid' ? 'Connected' :
                     oauthState.status?.tokenStatus === 'expired' ? 'Expired' : 'Not connected'}
                  </span>
                </div>

                {oauthState.status?.tokenStatus === 'valid' && (
                  <button
                    onClick={disconnectOAuth}
                    disabled={isDisconnecting}
                    className="px-4 py-2 bg-red-600 text-white text-sm rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isDisconnecting ? 'Disconnecting...' : 'Disconnect YouTube'}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Agent SSH Configuration Section */}
          <div className="border-t border-gray-200 pt-4">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Agent SSH Configuration</h3>
            <p className="text-xs text-gray-500 mb-3">
              Configure SSH settings for rebooting agents. Required for reboot functionality.
            </p>

            {loadingAgents ? (
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <span className="inline-block w-3 h-3 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
                <span>Loading agents...</span>
              </div>
            ) : agents.length === 0 ? (
              <div className="text-sm text-gray-500">
                No agents connected. Agents will appear here when they connect to the orchestrator.
              </div>
            ) : (
              <div className="space-y-4">
                {agents.map(agent => {
                  const isEditing = editingAgentId === agent.id;
                  const settings = sshSettings[agent.id] || {
                    host: '',
                    user: 'Administrator',
                    keyPath: '',
                    rebootCommand: 'shutdown /r /f /t 0',
                  };
                  const hasSshConfig = !!(agent.meta?.ssh as any)?.host;

                  return (
                    <div key={agent.id} className="border border-gray-200 rounded-md p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <span className="text-sm font-medium text-gray-900">{agent.name}</span>
                          <span className="ml-2 text-xs text-gray-500">({agent.id})</span>
                          {hasSshConfig && (
                            <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                              Configured
                            </span>
                          )}
                        </div>
                        {!isEditing ? (
                          <button
                            onClick={() => setEditingAgentId(agent.id)}
                            className="text-xs px-2 py-1 bg-blue-100 text-blue-800 rounded hover:bg-blue-200"
                          >
                            {hasSshConfig ? 'Edit' : 'Configure'}
                          </button>
                        ) : (
                          <button
                            onClick={() => setEditingAgentId(null)}
                            className="text-xs px-2 py-1 bg-gray-100 text-gray-800 rounded hover:bg-gray-200"
                          >
                            Cancel
                          </button>
                        )}
                      </div>

                      {isEditing && (
                        <div className="space-y-2 mt-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              SSH Host (IP or hostname) *
                            </label>
                            <input
                              type="text"
                              value={settings.host}
                              onChange={(e) => handleSshSettingChange(agent.id, 'host', e.target.value)}
                              placeholder="192.168.1.100"
                              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              SSH User
                            </label>
                            <input
                              type="text"
                              value={settings.user}
                              onChange={(e) => handleSshSettingChange(agent.id, 'user', e.target.value)}
                              placeholder="Administrator"
                              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              SSH Private Key Path (on orchestrator machine)
                            </label>
                            <input
                              type="text"
                              value={settings.keyPath}
                              onChange={(e) => handleSshSettingChange(agent.id, 'keyPath', e.target.value)}
                              placeholder="C:\\Users\\orchestrator\\.ssh\\key"
                              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <p className="mt-1 text-xs text-gray-500">
                              Optional. Leave empty to use default SSH keys.
                            </p>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-1">
                              Reboot Command
                            </label>
                            <input
                              type="text"
                              value={settings.rebootCommand}
                              onChange={(e) => handleSshSettingChange(agent.id, 'rebootCommand', e.target.value)}
                              placeholder="shutdown /r /f /t 0"
                              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <p className="mt-1 text-xs text-gray-500">
                              Windows reboot command. Default: shutdown /r /f /t 0
                            </p>
                          </div>
                          <div className="flex justify-end gap-2 pt-2">
                            <button
                              onClick={() => handleSaveSshSettings(agent.id)}
                              disabled={!settings.host || savingAgentId === agent.id}
                              className="text-xs px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {savingAgentId === agent.id ? 'Saving...' : 'Save'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end p-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

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


export const SecretConfigModal: React.FC<SecretConfigModalProps> = ({ onClose }) => {
  const [streamVisibility, setStreamVisibility] = useState<'public' | 'unlisted'>('unlisted');
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthState, setOauthState] = useState<OAuthPanelState>({ loading: true });
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [agents, setAgents] = useState<OrchestratorAgent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [allowAllYoutubeAccounts, setAllowAllYoutubeAccounts] = useState(false);
  const [loadingAllowAll, setLoadingAllowAll] = useState(true);
  const [updatingAllowAll, setUpdatingAllowAll] = useState(false);

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
      } catch (e: any) {
        console.error('Failed to load agents:', e);
      } finally {
        setLoadingAgents(false);
      }
    };
    loadAgents();
  }, []);

  // Load allow-all-youtube-accounts on mount
  useEffect(() => {
    const loadAllowAll = async () => {
      setLoadingAllowAll(true);
      try {
        const data = await apiClient.getAllowAllYoutubeAccounts();
        setAllowAllYoutubeAccounts(data.allowAllYoutubeAccounts);
      } catch (e: any) {
        console.error('Failed to load allow-all-youtube-accounts:', e);
      } finally {
        setLoadingAllowAll(false);
      }
    };
    loadAllowAll();
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

  const handleAllowAllYoutubeAccountsChange = async (value: boolean) => {
    setUpdatingAllowAll(true);
    setError(null);
    try {
      await apiClient.updateAllowAllYoutubeAccounts(value);
      setAllowAllYoutubeAccounts(value);
    } catch (err) {
      setError('Failed to update allow-all-youtube-accounts setting');
      console.error('Failed to update allow-all-youtube-accounts:', err);
    } finally {
      setUpdatingAllowAll(false);
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

                <div className="border-t border-gray-100 pt-3 mt-3">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={allowAllYoutubeAccounts}
                      onChange={(e) => handleAllowAllYoutubeAccountsChange(e.target.checked)}
                      disabled={loadingAllowAll || updatingAllowAll}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                    />
                    <span className="text-sm text-gray-700">
                      Allow any YouTube account
                    </span>
                  </label>
                  <p className="mt-1 text-xs text-gray-500">
                    When enabled, any account can connect. When disabled, only the channel in ALLOWED_YOUTUBE_CHANNEL_ID can connect.
                  </p>
                  {(loadingAllowAll || updatingAllowAll) && (
                    <p className="mt-1 text-xs text-blue-600">
                      {updatingAllowAll ? 'Updating...' : 'Loading...'}
                    </p>
                  )}
                </div>
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

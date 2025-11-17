import React, { useEffect, useState, useCallback } from 'react';
import { apiClient, OAuthStatus } from '../lib/api';

type PanelState =
  | { loading: true; status?: undefined; error?: undefined }
  | { loading: false; status: OAuthStatus; error?: undefined }
  | { loading: false; status?: undefined; error: string };

export const YouTubeOAuthPanel: React.FC = () => {
  const [state, setState] = useState<PanelState>({ loading: true });
  const [isWorking, setIsWorking] = useState(false);

  const loadStatus = useCallback(async () => {
    setState({ loading: true });
    try {
      const status = await apiClient.getOAuthStatus();
      setState({ loading: false, status });
    } catch (e: any) {
      setState({ loading: false, error: e?.message || 'Failed to load OAuth status' });
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // Handle being loaded inside the OAuth popup after Google redirects back
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    // Detect we are in a popup OAuth redirect context
    if (code && window.opener) {
      (async () => {
        try {
          await apiClient.exchangeOAuthCode(code);
          // Notify parent to refresh status
          try { window.opener.postMessage({ type: 'oauth:complete', success: true }, '*'); } catch {}
        } catch {
          try { window.opener?.postMessage({ type: 'oauth:complete', success: false }, '*'); } catch {}
        } finally {
          // Close the popup window
          window.close();
        }
      })();
    }
  }, []);

  // Parent window listener for popup completion
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (event?.data?.type === 'oauth:complete') {
        await loadStatus();
        setIsWorking(false);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadStatus]);

  const openAuthPopup = async () => {
    setIsWorking(true);
    try {
      const { authUrl } = await apiClient.getOAuthAuthUrl();
      const popup = window.open(
        authUrl,
        'youtube-oauth',
        'width=600,height=700,scrollbars=yes,resizable=yes'
      );
      const timer = setInterval(async () => {
        if (!popup || popup.closed) {
          clearInterval(timer);
          await loadStatus();
          setIsWorking(false);
        }
      }, 800);
    } catch (e) {
      setIsWorking(false);
      await loadStatus();
    }
  };


  // Compact UI for status bar
  if (state.loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span className="inline-block w-2 h-2 border-2 border-gray-300 border-t-red-500 rounded-full animate-spin" />
        <span>YouTube</span>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex items-center gap-2 text-xs text-red-600">
        <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
        <span>YouTube</span>
        <button
          className="ml-2 underline disabled:opacity-50"
          onClick={loadStatus}
          disabled={isWorking}
          title="Retry"
        >
          Retry
        </button>
      </div>
    );
  }

  const s = state.status!;
  const badgeColor = s.tokenStatus === 'valid' ? 'bg-green-500' : s.tokenStatus === 'expired' ? 'bg-yellow-500' : 'bg-red-500';
  const label = s.tokenStatus === 'valid' ? 'Connected' : s.tokenStatus === 'expired' ? 'Expired' : 'Not connected';

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`inline-block w-2 h-2 rounded-full ${badgeColor}`} />
      <span>YouTube</span>
      <span className="text-gray-500">{label}</span>
      {s.tokenStatus !== 'valid' ? (
        <button
          className="ml-2 px-2 py-0.5 rounded bg-blue-600 text-white disabled:opacity-50"
          onClick={openAuthPopup}
          disabled={isWorking || !s.configured}
          title={s.configured ? 'Connect YouTube' : 'Server not configured'}
        >
          {s.tokenStatus === 'expired' ? 'Reconnect' : 'Connect'}
        </button>
      ) : null /* Disconnect button moved to secret settings */}
      <button
        className="ml-1 underline text-gray-500 disabled:opacity-50"
        onClick={loadStatus}
        disabled={isWorking}
        title="Refresh"
      >
        Refresh
      </button>
    </div>
  );
};



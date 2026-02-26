import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/api';
import { useOAuthStatus } from '../hooks/useOAuthStatus';

export const YouTubeOAuthPanel: React.FC = () => {
  const [isWorking, setIsWorking] = useState(false);
  const { data: status, isLoading, error } = useOAuthStatus();
  const queryClient = useQueryClient();

  const loadStatus = () => queryClient.invalidateQueries({ queryKey: ['oauth', 'status'] });

  useEffect(() => {
    // Handle being loaded inside the OAuth popup after Google redirects back
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    if (code && window.opener) {
      (async () => {
        try {
          await apiClient.exchangeOAuthCode(code);
          try { window.opener.postMessage({ type: 'oauth:complete', success: true }, '*'); } catch {}
        } catch (e: any) {
          const msg = e?.message || 'Connection failed';
          try { window.opener?.postMessage({ type: 'oauth:complete', success: false, error: msg }, '*'); } catch {}
          alert(msg);
        } finally {
          window.close();
        }
      })();
    }
  }, []);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (event?.data?.type === 'oauth:complete') {
        await loadStatus();
        setIsWorking(false);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

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
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span className="inline-block w-2 h-2 border-2 border-gray-300 border-t-red-500 rounded-full animate-spin" />
        <span>YouTube</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-xs text-red-600">
        <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
        <span>YouTube</span>
        <button
          className="ml-2 underline disabled:opacity-50"
          onClick={() => loadStatus()}
          disabled={isWorking}
          title="Retry"
        >
          Retry
        </button>
      </div>
    );
  }

  const s = status!;
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
        onClick={() => loadStatus()}
        disabled={isWorking}
        title="Refresh"
      >
        Refresh
      </button>
    </div>
  );
};



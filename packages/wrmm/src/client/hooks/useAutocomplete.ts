import { useState, useMemo, useEffect } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiClient, Context, SearchResult, SearchResponse } from '../lib/api';

export const useAutocomplete = () => {
  const savedContext = (typeof window !== 'undefined') ? localStorage.getItem('wrmm.selectedContext') || '' : '';
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedContext, setSelectedContext] = useState<string>(savedContext);

  // Persist selectedContext
  useEffect(() => {
    try {
      if (selectedContext) localStorage.setItem('wrmm.selectedContext', selectedContext);
    } catch {}
  }, [selectedContext]);

  // Fetch contexts
  const {
    data: contextsData,
    error: contextsError,
    isLoading: contextsLoading,
  } = useQuery<Context[], Error>({
    queryKey: ['contexts'],
    queryFn: () => apiClient.getContexts(),
    staleTime: 5 * 60 * 1000,
  });

  const contexts: Context[] = Array.isArray(contextsData) ? contextsData : [];

  // Default selected context to saved or first item when contexts load
  useMemo(() => {
    if (!selectedContext && contexts.length > 0) {
      setSelectedContext(contexts[0].name);
    }
  }, [contexts, selectedContext]);

  // Search query should not run when:
  // - empty/whitespace
  // - multi-line
  const normalizedQuery = searchQuery;
  const searchEnabled = Boolean(
    selectedContext && normalizedQuery.trim() && !normalizedQuery.includes('\n')
  );

  const {
    data: searchData,
    error: searchError,
    isLoading: searchLoading,
  } = useQuery<SearchResponse, Error>({
    queryKey: ['search', selectedContext, normalizedQuery],
    queryFn: () => apiClient.search(selectedContext, normalizedQuery),
    enabled: searchEnabled,
    placeholderData: keepPreviousData,
  });

  const searchResults: SearchResult[] = searchEnabled && Array.isArray(searchData?.results)
    ? searchData!.results
    : [];

  const error = contextsError?.message || searchError?.message || null;
  const isLoading = contextsLoading || (searchEnabled && searchLoading);

  return {
    contexts,
    selectedContext,
    setSelectedContext,
    searchQuery,
    setSearchQuery,
    searchResults,
    isLoading,
    error,
  };
}; 
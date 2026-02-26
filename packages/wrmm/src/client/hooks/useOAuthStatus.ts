import { useQuery } from '@tanstack/react-query';
import { apiClient, type OAuthStatus } from '../lib/api';

export const useOAuthStatus = () => {
  return useQuery<OAuthStatus>({
    queryKey: ['oauth', 'status'],
    queryFn: () => apiClient.getOAuthStatus(),
    staleTime: 60000, // Consider data fresh for 1 minute
  });
};

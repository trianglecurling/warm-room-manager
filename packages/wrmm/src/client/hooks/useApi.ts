import { useQuery } from '@tanstack/react-query';
import { apiClient, type HealthResponse, type HelloResponse } from '../lib/api';

export const useHealth = () => {
  return useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: () => apiClient.getHealth(),
    refetchInterval: 30000, // Refetch every 30 seconds
  });
};

export const useHello = () => {
  return useQuery<HelloResponse>({
    queryKey: ['hello'],
    queryFn: () => apiClient.getHello(),
    staleTime: 60000, // Consider data fresh for 1 minute
  });
}; 
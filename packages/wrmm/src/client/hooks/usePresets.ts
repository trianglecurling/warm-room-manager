import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, Preset, PresetData } from '../lib/api';

export const usePresets = (contextName?: string) => {
  const queryClient = useQueryClient();

  const enabled = Boolean(contextName);

  const { data: presetsData, isLoading, error } = useQuery<Preset[], Error>({
    queryKey: ['presets', contextName],
    queryFn: () => apiClient.listPresets(contextName!),
    enabled,
    staleTime: 30_000,
  });

  const presets: Preset[] = Array.isArray(presetsData) ? presetsData : [];

  const saveMutation = useMutation({
    mutationFn: ({ name, data }: { name: string; data: PresetData }) => apiClient.savePreset(contextName!, name, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['presets', contextName] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => apiClient.deletePreset(contextName!, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['presets', contextName] });
    },
  });

  return {
    presets,
    isLoading,
    error: error?.message || null,
    savePreset: (name: string, data: PresetData) => saveMutation.mutateAsync({ name, data }),
    deletePreset: (name: string) => deleteMutation.mutateAsync(name),
  };
}; 
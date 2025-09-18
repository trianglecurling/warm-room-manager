import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient, CreateContextInput, UpdateContextInput, Context } from '../lib/api';

interface ContextModalProps {
  mode: 'new' | 'edit';
  initial?: Context | null;
  onClose: () => void;
}

// Format an ISO date string to a local datetime-local input value (YYYY-MM-DDTHH:mm)
function toLocalInputValue(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

// Convert a datetime-local input value (local time) to ISO string (UTC)
function fromLocalInputValue(local?: string): string {
  if (!local) return '';
  const d = new Date(local);
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
}

export const ContextModal: React.FC<ContextModalProps> = ({ mode, initial, onClose }) => {
  const queryClient = useQueryClient();

  const [name, setName] = useState<string>(initial?.name ?? '');
  const [type, setType] = useState<'league' | 'tournament' | 'miscellaneous' | ''>((initial?.type as any) ?? '');
  const [startDate, setStartDate] = useState<string>(initial?.startDate ?? '');
  const [endDate, setEndDate] = useState<string>(initial?.endDate ?? '');
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const title = mode === 'new' ? 'New Context' : 'Edit Context';

  // Basic validation
  const isValid = useMemo(() => {
    if (!name.trim()) return false;
    // type is required and must be one of the allowed values
    if (!type || !['league', 'tournament', 'miscellaneous'].includes(type)) return false;
    if (startDate && endDate) {
      try {
        const s = new Date(startDate).getTime();
        const e = new Date(endDate).getTime();
        if (isNaN(s) || isNaN(e)) return false;
        if (s > e) return false;
      } catch {
        return false;
      }
    }
    return true;
  }, [name, type, startDate, endDate]);

  const createMutation = useMutation({
    mutationFn: (input: CreateContextInput) => apiClient.createContext(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contexts'] });
      onClose();
    },
    onError: (e: any) => setError(e?.message || 'Failed to create context'),
  });

  const updateMutation = useMutation({
    mutationFn: (input: UpdateContextInput) => apiClient.updateContext(initial!.name, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contexts'] });
      onClose();
    },
    onError: (e: any) => setError(e?.message || 'Failed to update context'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiClient.deleteContext(initial!.name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contexts'] });
      onClose();
    },
    onError: (e: any) => setError(e?.message || 'Failed to delete context'),
  });

  const onSave = () => {
    setError(null);
    if (!isValid) {
      setError('Please check required fields and date ranges.');
      return;
    }
    if (mode === 'new') {
      createMutation.mutate({
        name: name.trim(),
        type: (type || undefined) as any,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
    } else {
      updateMutation.mutate({
        name: name.trim() !== initial!.name ? name.trim() : undefined,
        type: (type || undefined) as any,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
    }
  };

  const onDelete = () => {
    setError(null);
    if (!initial) return;
    setConfirmingDelete(true);
  };

  const confirmDelete = () => {
    deleteMutation.mutate();
  };

  const busy = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-lg p-5">
        <h2 className="text-lg font-semibold mb-4">{title}</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
            <select
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              value={type}
              onChange={(e) => setType(e.target.value as any)}
              disabled={busy}
              required
            >
              <option value="" disabled>
                Select a type...
              </option>
              <option value="league">League</option>
              <option value="tournament">Tournament</option>
              <option value="miscellaneous">Miscellaneous</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
              <input
                type="datetime-local"
                className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                value={toLocalInputValue(startDate)}
                onChange={(e) => setStartDate(fromLocalInputValue(e.target.value))}
                disabled={busy}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
              <input
                type="datetime-local"
                className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                value={toLocalInputValue(endDate)}
                onChange={(e) => setEndDate(fromLocalInputValue(e.target.value))}
                disabled={busy}
              />
            </div>
          </div>

          {error && <div className="text-sm text-red-600">{error}</div>}
        </div>

        <div className="mt-5 flex justify-between items-center">
          {mode === 'edit' ? (
            <button
              onClick={onDelete}
              className="text-red-600 text-sm cursor-pointer"
              disabled={busy}
            >
              Delete context
            </button>
          ) : <span />}

          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="btn btn-secondary px-4 py-2 text-sm"
              disabled={busy}
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              className="btn btn-primary px-4 py-2 text-sm"
              disabled={!isValid || busy}
            >
              Save
            </button>
          </div>
        </div>

        {confirmingDelete && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40" />
            <div className="relative bg-white rounded-md shadow p-4 w-full max-w-sm">
              <div className="text-sm mb-3">Delete this context and all associated teams?</div>
              {error && <div className="text-sm text-red-600 mb-2">{error}</div>}
              <div className="flex justify-end gap-2">
                <button className="btn btn-secondary px-3 py-1 text-sm" disabled={busy} onClick={() => setConfirmingDelete(false)}>Cancel</button>
                <button className="btn btn-primary px-3 py-1 text-sm bg-red-600 hover:bg-red-700" disabled={busy} onClick={confirmDelete}>Delete</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
} 
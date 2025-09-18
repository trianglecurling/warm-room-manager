import React, { useEffect, useMemo, useRef, useState } from 'react';

interface PresetNameModalProps {
  initialName: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}

export const PresetNameModal: React.FC<PresetNameModalProps> = ({ initialName, onSave, onCancel }) => {
  const [name, setName] = useState<string>(initialName || '');
  const inputRef = useRef<HTMLInputElement>(null);

  const canSave = useMemo(() => !!name.trim(), [name]);

  useEffect(() => {
    inputRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && canSave) onSave(name.trim());
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [canSave, name, onCancel, onSave]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-sm p-5">
        <h3 className="text-base font-medium mb-3">Save Preset</h3>
        <label className="block text-sm font-medium text-gray-700 mb-1">Preset name</label>
        <input
          ref={inputRef}
          type="text"
          className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter a preset name"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn btn-secondary px-3 py-2 text-sm" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary px-3 py-2 text-sm" onClick={() => onSave(name.trim())} disabled={!canSave}>Save</button>
        </div>
      </div>
    </div>
  );
}; 
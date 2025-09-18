import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CreateTeamRequest, PlayerPosition } from '../lib/api';

interface TeamSaveModalProps {
  mode: 'create' | 'update';
  initial: Partial<CreateTeamRequest> & { contextName: string; contextType: 'league' | 'tournament' | 'miscellaneous' };
  onSave: (input: CreateTeamRequest) => void;
  onCancel: () => void;
}

export const TeamSaveModal: React.FC<TeamSaveModalProps> = ({ mode, initial, onSave, onCancel }) => {
  const [teamName, setTeamName] = useState(initial.teamName || '');
  const [homeClub, setHomeClub] = useState(initial.homeClub || '');
  const [lead, setLead] = useState(initial.lead || '');
  const [second, setSecond] = useState(initial.second || '');
  const [third, setThird] = useState(initial.third || '');
  const [fourth, setFourth] = useState(initial.fourth || '');
  const [skipPosition, setSkipPosition] = useState<PlayerPosition>(initial.skipPosition || 'fourth');
  const [vicePosition, setVicePosition] = useState<PlayerPosition>(initial.vicePosition || 'third');

  const canSave = useMemo(() => Boolean(initial.contextName && initial.contextType && teamName.trim()), [initial.contextName, initial.contextType, teamName]);

  const onConfirm = () => {
    if (!canSave) return;
    onSave({
      teamName: teamName.trim(),
      contextName: initial.contextName,
      contextType: initial.contextType,
      contextStartDate: initial.contextStartDate,
      contextEndDate: initial.contextEndDate,
      lead: lead.trim() || undefined,
      second: second.trim() || undefined,
      third: third.trim() || undefined,
      fourth: fourth.trim() || undefined,
      vicePosition,
      skipPosition,
      homeClub: homeClub.trim() || undefined,
    });
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && canSave) onConfirm();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [canSave]);

  const title = mode === 'update' ? 'Update Team' : 'Create New Team';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-lg p-5">
        <h3 className="text-base font-medium mb-3">{title}</h3>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Team name</label>
            <input className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500" value={teamName} onChange={(e) => setTeamName(e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Home club</label>
            <input className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500" value={homeClub} onChange={(e) => setHomeClub(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Lead</label>
            <input className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500" value={lead} onChange={(e) => setLead(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Second</label>
            <input className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500" value={second} onChange={(e) => setSecond(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Third</label>
            <input className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500" value={third} onChange={(e) => setThird(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Fourth</label>
            <input className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500" value={fourth} onChange={(e) => setFourth(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Skip position</label>
            <select className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500" value={skipPosition} onChange={(e) => setSkipPosition(e.target.value as PlayerPosition)}>
              <option value="lead">Lead</option>
              <option value="second">Second</option>
              <option value="third">Third</option>
              <option value="fourth">Fourth</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vice position</label>
            <select className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500" value={vicePosition} onChange={(e) => setVicePosition(e.target.value as PlayerPosition)}>
              <option value="lead">Lead</option>
              <option value="second">Second</option>
              <option value="third">Third</option>
              <option value="fourth">Fourth</option>
            </select>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn btn-secondary px-3 py-2 text-sm" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary px-3 py-2 text-sm" disabled={!canSave} onClick={onConfirm}>Save</button>
        </div>
      </div>
    </div>
  );
}; 
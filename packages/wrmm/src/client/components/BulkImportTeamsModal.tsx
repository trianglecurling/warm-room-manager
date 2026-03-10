import React, { useState, useMemo, useCallback } from 'react';
import { apiClient, Context } from '../lib/api';

interface BulkImportTeamsModalProps {
  context: Context | null;
  onClose: () => void;
  onSuccess?: (count: number) => void;
}

const HEADER_FIRST = 'team name';
const HEADER_SECOND = 'club';

/** Parse pasted spreadsheet data. Columns: Team Name, Club, Skip, Vice, Second, Lead (tab-separated). */
function parseBulkPaste(text: string): string[][] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const rows: string[][] = [];
  for (const line of lines) {
    const cells = line.split(/\t+/).map((c) => c.trim());
    if (cells.length >= 6) {
      const first = (cells[0] || '').toLowerCase();
      const second = (cells[1] || '').toLowerCase();
      if (first === HEADER_FIRST && second === HEADER_SECOND) continue;
      rows.push(cells.slice(0, 6));
    } else if (cells.length > 0) {
      const alt = line.split(/\s{2,}/).map((c) => c.trim());
      if (alt.length >= 6) {
        const first = (alt[0] || '').toLowerCase();
        const second = (alt[1] || '').toLowerCase();
        if (first === HEADER_FIRST && second === HEADER_SECOND) continue;
        rows.push(alt.slice(0, 6));
      } else {
        rows.push(cells);
      }
    }
  }
  return rows;
}

const EXPECTED_COLUMNS = ['Team Name', 'Club', 'Skip', 'Vice', 'Second', 'Lead'];
const FORMAT = 'teamName, homeClub, fourth, third, second, lead';

export const BulkImportTeamsModal: React.FC<BulkImportTeamsModalProps> = ({
  context,
  onClose,
  onSuccess,
}) => {
  const [pasteText, setPasteText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const parsedRows = useMemo(() => parseBulkPaste(pasteText), [pasteText]);
  const validRows = useMemo(() => {
    return parsedRows.filter((row) => row.length >= 6 && row[0]?.trim());
  }, [parsedRows]);

  const handleImport = useCallback(async () => {
    if (!context || validRows.length === 0) return;
    setError(null);
    setIsSubmitting(true);
    try {
      // API requires dates; use context dates or fallback to current season
      const now = new Date();
      const fallbackStart = `${now.getFullYear()}-01-01T00:00:00Z`;
      const fallbackEnd = `${now.getFullYear()}-12-31T23:59:59Z`;
      const { count } = await apiClient.bulkCreateTeams({
        format: FORMAT,
        data: validRows,
        contextName: context.name,
        contextType: (context.type as 'league' | 'tournament' | 'miscellaneous') || 'league',
        contextStartDate: context.startDate || fallbackStart,
        contextEndDate: context.endDate || fallbackEnd,
      });
      onSuccess?.(count);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Failed to import teams');
    } finally {
      setIsSubmitting(false);
    }
  }, [context, validRows, onClose, onSuccess]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        className="relative bg-white rounded-lg shadow-xl w-full max-w-2xl p-5"
        onKeyDown={handleKeyDown}
      >
        <h2 className="text-lg font-semibold mb-2">Bulk Import Teams</h2>
        <p className="text-sm text-gray-600 mb-3">
          Paste from a spreadsheet with columns: <strong>{EXPECTED_COLUMNS.join(', ')}</strong>. Use
          tab-separated format (copy from Excel/Sheets).
        </p>

        <textarea
          className="w-full h-40 p-3 border border-gray-300 rounded-md font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          disabled={isSubmitting}
        />

        {parsedRows.length > 0 && (
          <p className="text-sm text-gray-600 mt-2">
            {validRows.length} team{validRows.length !== 1 ? 's' : ''} ready to import
            {parsedRows.length !== validRows.length && (
              <span className="text-amber-600">
                {' '}
                ({parsedRows.length - validRows.length} row(s) skipped - need 6 columns)
              </span>
            )}
          </p>
        )}

        {error && <div className="text-sm text-red-600 mt-2">{error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary px-4 py-2 text-sm"
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleImport}
            className="btn btn-primary px-4 py-2 text-sm"
            disabled={!context || validRows.length === 0 || isSubmitting}
          >
            {isSubmitting ? 'Importing…' : `Import ${validRows.length} team${validRows.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
};

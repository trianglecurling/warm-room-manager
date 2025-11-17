import React, { useState, useEffect, useRef } from 'react';

interface StreamStartCountdownModalProps {
  streamCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export const StreamStartCountdownModal: React.FC<StreamStartCountdownModalProps> = ({
  streamCount,
  onConfirm,
  onCancel
}) => {
  const [countdown, setCountdown] = useState(10);
  const hasConfirmedRef = useRef(false);

  // Reset confirmation flag when component mounts
  useEffect(() => {
    hasConfirmedRef.current = false;
  }, []);

  useEffect(() => {
    if (countdown <= 0) {
      if (!hasConfirmedRef.current) {
        hasConfirmedRef.current = true;
        console.log('🎯 CountdownModal: Calling onConfirm (countdown reached 0)');
        onConfirm();
      } else {
        console.log('🎯 CountdownModal: Skipping duplicate onConfirm call');
      }
      return;
    }

    const timer = setTimeout(() => {
      setCountdown(countdown - 1);
    }, 1000);

    return () => clearTimeout(timer);
  }, [countdown, onConfirm]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onCancel}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <div className="p-6 text-center">
          <div className="mb-4">
            <div className="w-16 h-16 mx-auto mb-4 bg-blue-100 rounded-full flex items-center justify-center">
              <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              Starting {streamCount} Stream{streamCount === 1 ? '' : 's'}
            </h2>
            <p className="text-gray-600 mb-4">
              Starting in <span className="font-bold text-2xl text-blue-600">{countdown}</span> seconds
            </p>
          </div>

          <div className="flex justify-center">
            <button
              onClick={onCancel}
              className="px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};


import React, { useState, useRef, useEffect } from 'react';
import { SearchResult } from '../lib/api';

interface AutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className: string;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchResults: SearchResult[];
  isLoading: boolean;
  onSelectResult: (result: SearchResult) => void;
  isActive: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  tabIndex?: number;
}

const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const HighlightedText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  if (!query || query.trim().length < 2) return <>{text}</>;
  try {
    const regex = new RegExp(`(${escapeRegExp(query)})`, 'ig');
    const parts = text.split(regex);
    return (
      <>
        {parts.map((part, idx) =>
          part.toLowerCase() === query.toLowerCase() ? (
            <mark key={idx} className="bg-yellow-200 px-0.5 rounded">
              {part}
            </mark>
          ) : (
            <span key={idx}>{part}</span>
          )
        )}
      </>
    );
  } catch {
    return <>{text}</>; // Fallback on regex errors
  }
};

export const AutocompleteInput: React.FC<AutocompleteInputProps> = ({
  value,
  onChange,
  placeholder,
  className,
  searchQuery,
  setSearchQuery,
  searchResults,
  isLoading,
  onSelectResult,
  isActive,
  onActivate,
  onDeactivate,
  tabIndex
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasNewline = (text: string) => text.includes('\n');

  // Handle input change
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    onChange(newValue);

    if (hasNewline(newValue)) {
      // Bypass autocomplete entirely for multi-line values
      setSearchQuery('');
      setIsOpen(false);
      setSelectedIndex(-1);
      return;
    }

    setSearchQuery(newValue);
    setSelectedIndex(-1);
  };

  // Open/close dropdown based on active state and results only; never open for multiline values
  useEffect(() => {
    if (
      isActive &&
      !hasNewline(value) &&
      searchQuery.trim() &&
      Array.isArray(searchResults) &&
      searchResults.length > 0
    ) {
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  }, [isActive, searchResults, value, searchQuery]);

  // Handle key navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // If multiline, bypass autocomplete behaviors completely
    if (hasNewline(value)) return;

    if (!isOpen || !Array.isArray(searchResults) || searchResults.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => 
          prev < searchResults.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => prev > 0 ? prev - 1 : -1);
        break;
      case 'Enter':
        if (selectedIndex >= 0) {
          e.preventDefault();
          onSelectResult(searchResults[selectedIndex]);
          setIsOpen(false);
          onDeactivate();
        }
        // If no selection, allow default to insert newline
        break;
      case 'Escape':
        setIsOpen(false);
        setSelectedIndex(-1);
        onDeactivate();
        break;
    }
  };

  // Handle result selection
  const handleResultClick = (result: SearchResult) => {
    onSelectResult(result);
    setIsOpen(false);
    setSelectedIndex(-1);
    onDeactivate();
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current && 
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current && 
        !inputRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setSelectedIndex(-1);
        onDeactivate();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onDeactivate]);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      // add 2px to account for sub-pixel rounding causing tiny scrollbar
      inputRef.current.style.height = inputRef.current.scrollHeight + 2 + 'px';
    }
  }, [value]);

  return (
    <div className="relative">
      <textarea
        ref={inputRef}
        value={value}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onFocus={onActivate}
        placeholder={placeholder}
        className={`${className} overflow-hidden`}
        rows={5}
        maxLength={200}
        tabIndex={tabIndex}
      />
      
      {/* Autocomplete Dropdown */}
      {isActive && isOpen && Array.isArray(searchResults) && searchResults.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-auto"
        >
          {searchResults.map((result, index) => {
            const playersLine = result.teamData
              ? result.teamData.split('\n').filter(Boolean).join(', ')
              : '';
            return (
              <div
                key={result.id}
                className={`px-3 py-2 text-sm cursor-pointer hover:bg-gray-100 ${
                  index === selectedIndex ? 'bg-blue-100' : ''
                }`}
                onClick={() => handleResultClick(result)}
              >
                <div className="font-medium">
                  <HighlightedText text={result.name} query={searchQuery} />
                </div>
                {playersLine && (
                  <div className="text-xs text-gray-600 mt-1">
                    <HighlightedText text={playersLine} query={searchQuery} />
                  </div>
                )}
                {result.homeClub && (
                  <div className="text-xs text-gray-400 mt-0.5">
                    <HighlightedText text={result.homeClub} query={searchQuery} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}; 
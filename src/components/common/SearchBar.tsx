import React, { useState, useEffect } from 'react';
import { Search, X } from 'lucide-react';

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit?: () => void;
  onClear?: () => void;
  placeholder?: string;
  rotatingPlaceholders?: string[];
  onSelectRotatingPlaceholder?: (term: string) => void;
  autoFocus?: boolean;
}

export const SearchBar: React.FC<SearchBarProps> = ({
  value,
  onChangeText,
  onSubmit,
  onClear,
  placeholder = 'Search movies, TV shows, anime...',
  rotatingPlaceholders = [],
  onSelectRotatingPlaceholder,
  autoFocus = false,
}) => {
  const [rotIndex, setRotIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);

  const hasRotating = rotatingPlaceholders.length > 0 && !value;

  useEffect(() => {
    if (!hasRotating || rotatingPlaceholders.length <= 1) {
      setRotIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setIsAnimating(true);
      setTimeout(() => {
        setRotIndex((prev) => (prev + 1) % rotatingPlaceholders.length);
        setIsAnimating(false);
      }, 220);
    }, 3000);
    return () => clearInterval(interval);
  }, [hasRotating, rotatingPlaceholders.length]);

  const currentRotatingText =
    hasRotating && rotatingPlaceholders[rotIndex % rotatingPlaceholders.length]
      ? rotatingPlaceholders[rotIndex % rotatingPlaceholders.length]
      : '';

  return (
    <div className="relative flex h-[48px] w-full items-center rounded-full bg-[#1C1C1E] border border-white/5 px-4 shadow-sm overflow-hidden">
      <Search className="h-5 w-5 text-[#6B7280] flex-shrink-0 z-10" />

      <div className="relative ml-3 flex-1 h-full flex items-center overflow-hidden">
        {/* Rotating Placeholder Overlay with Smooth Right-Edge Fade Out for Long Titles */}
        {hasRotating && currentRotatingText && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 right-2 flex items-center overflow-hidden select-none"
            style={{
              WebkitMaskImage: 'linear-gradient(to right, rgba(0,0,0,1) 72%, rgba(0,0,0,0) 100%)',
              maskImage: 'linear-gradient(to right, rgba(0,0,0,1) 72%, rgba(0,0,0,0) 100%)',
            }}
          >
            <span
              className={`whitespace-nowrap text-sm font-medium text-[#8E8E93] transition-all duration-200 ease-out ${
                isAnimating ? '-translate-y-3 opacity-0' : 'translate-y-0 opacity-100'
              }`}
            >
              Search &ldquo;{currentRotatingText}&rdquo;
            </span>
          </div>
        )}

        <input
          type="text"
          value={value}
          onChange={(e) => onChangeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (!value && currentRotatingText && onSelectRotatingPlaceholder) {
                onSelectRotatingPlaceholder(currentRotatingText);
              } else {
                onSubmit?.();
              }
            }
          }}
          placeholder={hasRotating ? '' : placeholder}
          autoFocus={autoFocus}
          className="relative z-10 w-full h-full bg-transparent text-sm text-white placeholder-[#6B7280] outline-none"
        />
      </div>

      {value ? (
        <button
          type="button"
          onClick={() => {
            onChangeText('');
            onClear?.();
          }}
          className="p-1 text-[#6B7280] hover:text-white cursor-pointer z-10"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
};


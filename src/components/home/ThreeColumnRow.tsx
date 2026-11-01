import React, { useState, useEffect, useRef } from 'react';
import { Star, Sparkles } from 'lucide-react';
import { ContentItem } from '../../types';

interface ThreeColumnRowProps {
  title: string;
  icon?: React.ReactNode;
  items: ContentItem[];
  onSelectContent: (item: ContentItem) => void;
  onSeeAll?: () => void;
}

export const ThreeColumnRow: React.FC<ThreeColumnRowProps> = React.memo(({
  title,
  icon,
  items,
  onSelectContent,
  onSeeAll,
}) => {
  const [displayCount, setDisplayCount] = useState<number>(9);
  const observerTarget = useRef<HTMLDivElement>(null);
  const prevTitleRef = useRef<string>(title);

  useEffect(() => {
    if (prevTitleRef.current !== title) {
      prevTitleRef.current = title;
      setDisplayCount(9);
    }
  }, [title]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setDisplayCount((prevCount) => Math.min(prevCount + 9, items.length));
        }
      },
      { threshold: 0.1 }
    );

    const currentTarget = observerTarget.current;
    if (currentTarget) {
      observer.observe(currentTarget);
    }

    return () => {
      if (currentTarget) {
        observer.unobserve(currentTarget);
      }
    };
  }, [items.length]);

  if (!items || items.length === 0) return null;

  const displayedItems = items.slice(0, displayCount);

  return (
    <div className="mt-5 px-4">
      {/* SECTION HEADER */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          {icon || <Sparkles className="h-5 w-5 text-[#8B5CF6]" />}
          <h2 className="text-base sm:text-lg font-black tracking-tight text-white flex items-center gap-2">
            {title}
          </h2>
        </div>

        {onSeeAll && (
          <button
            type="button"
            onClick={onSeeAll}
            className="text-xs font-bold text-[#8B5CF6] hover:text-[#A78BFA] transition cursor-pointer px-1 py-0.5"
          >
            See All
          </button>
        )}
      </div>

      {/* 3-COLUMN VERTICAL GRID (3 CARDS PER ROW, FLOWING DOWNWARD) */}
      <div className="grid grid-cols-3 gap-2.5 sm:gap-3.5 pt-1">
        {displayedItems.map((item, idx) => {
          const displayPoster =
            (item as any).customImage ||
            item.posterUrl ||
            'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=300';
          const displayTitle = (item as any).customTitle || item.title;
          const langBadge =
            item.language ||
            (Array.isArray((item as any).audioLanguages) && (item as any).audioLanguages[0]) ||
            '';

          return (
            <div
              key={`${item.id}-${idx}`}
              onClick={() => onSelectContent(item)}
              className="group relative flex flex-col cursor-pointer transition-transform duration-200 active:scale-95 select-none rounded-lg overflow-hidden bg-[#161922] border border-white/5 shadow-md shadow-black/40"
            >
              {/* Clean Poster Box */}
              <div className="relative w-full aspect-[2/3] overflow-hidden bg-[#1C1C1E]">
                <img
                  src={displayPoster || undefined}
                  alt={displayTitle}
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  loading="lazy"
                  decoding="async"
                />

                {/* Top Right Language Badge */}
                {langBadge && (
                  <div className="absolute top-1.5 right-1.5 rounded bg-black/75 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-[2px] pointer-events-none">
                    {langBadge}
                  </div>
                )}
              </div>

              {/* Attached Dark Footer Strip with Single-Line Truncated Title */}
              <div className="bg-[#161922] px-2 py-2 text-left">
                <h3
                  className="truncate block text-[12px] sm:text-[13px] font-medium text-[#E4E4E7] group-hover:text-white transition-colors leading-tight"
                  title={displayTitle}
                >
                  {displayTitle}
                </h3>
              </div>
            </div>
          );
        })}
      </div>

      {/* LAZY LOADING SENTINEL */}
      {displayCount < items.length && (
        <div ref={observerTarget} className="w-full h-10 mt-4 flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-[#8B5CF6] border-t-transparent rounded-full animate-spin"></div>
        </div>
      )}
    </div>
  );
});


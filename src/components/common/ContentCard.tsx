import React from 'react';
import { Star, Pencil } from 'lucide-react';
import { ContentItem } from '../../types';

interface ContentCardProps {
  item: ContentItem;
  onPress?: (item: ContentItem) => void;
  onEdit?: (item: ContentItem) => void;
  width?: number;
  height?: number;
}

export const ContentCard: React.FC<ContentCardProps> = React.memo(({
  item,
  onPress,
  onEdit,
  width = 120,
  height = 175,
}) => {
  const displayPoster = (item as any).customImage || item.posterUrl || undefined;
  const displayTitle = (item as any).customTitle || item.title;
  const langBadge =
    item.language ||
    (Array.isArray((item as any).audioLanguages) && (item as any).audioLanguages[0]) ||
    '';

  return (
    <div
      onClick={() => {
        onPress?.(item);
      }}
      className="group relative cursor-pointer flex-shrink-0 transition-transform duration-150 active:scale-95 touch-manipulation rounded-lg overflow-hidden bg-[#161922] border border-white/5 shadow-md shadow-black/40"
      style={{ width }}
    >
      {/* Poster Container */}
      <div
        className="relative overflow-hidden bg-[#1C1C1E]"
        style={{ width, height }}
      >
        <img
          src={displayPoster}
          alt={displayTitle}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          loading="lazy"
          decoding="async"
        />

        {/* Edit Button (if onEdit callback provided) */}
        {onEdit && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(item);
            }}
            className="absolute top-2 left-2 z-10 flex h-7 w-7 items-center justify-center rounded-lg bg-[#8B5CF6] text-white shadow-lg hover:bg-[#7C3AED] transition active:scale-90 cursor-pointer touch-manipulation"
            title="Edit Content Details"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Language Badge (top right) */}
        {langBadge && (
          <div className="absolute top-1.5 right-1.5 rounded bg-black/75 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-[2px] pointer-events-none">
            {langBadge}
          </div>
        )}
      </div>

      {/* Attached Dark Footer Strip below poster */}
      <div className="bg-[#161922] px-2 py-2 text-left">
        <h3
          className="truncate block text-[12px] font-medium text-[#E4E4E7] group-hover:text-white transition-colors leading-tight"
          title={displayTitle}
        >
          {displayTitle}
        </h3>
      </div>
    </div>
  );
});

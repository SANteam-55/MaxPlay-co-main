import React from 'react';
import {
  ChevronRight,
  Trash2,
  HardDrive,
  CheckCircle2,
} from 'lucide-react';
import { DownloadedFile } from '../../services/DownloadManager';

interface SeriesFolderCardProps {
  seriesTitle: string;
  posterUrl: string;
  episodes: DownloadedFile[];
  onPlayEpisode: (item: DownloadedFile) => void;
  onDeleteEpisode: (id: string) => void;
  onDeleteSeries?: (files: DownloadedFile[]) => void;
  onOpenSeriesPage?: (seriesTitle: string, posterUrl: string, episodes: DownloadedFile[]) => void;
}

export const SeriesFolderCard: React.FC<SeriesFolderCardProps> = ({
  seriesTitle,
  posterUrl,
  episodes,
  onPlayEpisode,
  onDeleteEpisode,
  onDeleteSeries,
  onOpenSeriesPage,
}) => {
  // Sort episodes logically by episodeIndex or episode number
  const sortedEpisodes = [...episodes].sort((a, b) => {
    const numA =
      a.episodeIndex !== undefined
        ? a.episodeIndex
        : parseInt(a.episodeId?.replace(/\D/g, '') || '0', 10) || 0;
    const numB =
      b.episodeIndex !== undefined
        ? b.episodeIndex
        : parseInt(b.episodeId?.replace(/\D/g, '') || '0', 10) || 0;
    return numA - numB;
  });

  const totalMb = episodes.reduce((acc, ep) => acc + (ep.fileSizeMb || 0), 0);
  const formattedTotalSize =
    totalMb >= 1000 ? `${(totalMb / 1024).toFixed(1)} GB` : `${Math.round(totalMb)} MB`;

  const handleOpenSeries = () => {
    if (onOpenSeriesPage) {
      onOpenSeriesPage(seriesTitle, posterUrl, sortedEpisodes);
    } else if (sortedEpisodes.length > 0) {
      onPlayEpisode(sortedEpisodes[0]);
    }
  };

  const handleDeleteAll = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDeleteSeries) {
      onDeleteSeries(episodes);
    } else {
      episodes.forEach((ep) => onDeleteEpisode(ep.id));
    }
  };

  return (
    <div
      onClick={handleOpenSeries}
      className="flex items-center gap-3.5 rounded-2xl bg-[#121216] border border-[#27272A] p-3.5 cursor-pointer hover:bg-white/[0.03] hover:border-[#3F3F46] active:scale-[0.99] transition shadow-lg group"
    >
      {/* Clean Series Poster Thumbnail */}
      <div className="relative h-[92px] w-[64px] flex-shrink-0 rounded-xl overflow-hidden bg-[#181820] border border-white/10 shadow-md">
        <img
          src={posterUrl}
          alt={seriesTitle}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
      </div>

      {/* Series Title & Metadata (Only Series Name, Total Videos, and Storage) */}
      <div className="flex flex-1 flex-col justify-center min-w-0 pr-1 text-left">
        <h4 className="text-sm sm:text-base font-extrabold text-white truncate max-w-[230px] sm:max-w-xs group-hover:text-purple-300 transition-colors">
          {seriesTitle}
        </h4>

        <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-[#A1A1AA]">
          <span className="flex items-center gap-1 font-semibold text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>
              {episodes.length} {episodes.length === 1 ? 'Video' : 'Videos'}
            </span>
          </span>
          <span className="text-white/20">•</span>
          <span className="flex items-center gap-1 font-semibold text-sky-400">
            <HardDrive className="h-3.5 w-3.5" />
            <span>{formattedTotalSize}</span>
          </span>
        </div>
      </div>

      {/* Right Action Buttons */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          type="button"
          onClick={handleDeleteAll}
          className="flex h-8 w-8 items-center justify-center rounded-xl text-[#71717A] hover:bg-red-500/20 hover:text-red-400 transition cursor-pointer"
          title="Delete whole series"
        >
          <Trash2 className="h-4 w-4" />
        </button>

        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/5 text-[#A1A1AA] group-hover:bg-[#8B5CF6]/20 group-hover:text-white transition">
          <ChevronRight className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
};

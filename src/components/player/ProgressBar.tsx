import React, { useState, useRef, useEffect } from 'react';
import Hls from 'hls.js';

interface ProgressBarProps {
  currentTime: number; // in seconds
  duration: number;    // in seconds
  buffered?: number;   // 0 to 100 percentage
  onSeek: (time: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  videoElement?: HTMLVideoElement | null;
  previewStreamUrl?: string;
  posterUrl?: string;
  timeOffset?: number;
  skipMarkers?: {
    intro?: { start: number; end: number };
    outro?: { start: number; end: number };
    credits?: { start: number; end: number };
  };
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  currentTime,
  duration,
  buffered = 0,
  onSeek,
  onScrubStart,
  onScrubEnd,
  videoElement,
  previewStreamUrl,
  posterUrl,
  timeOffset = 0,
  skipMarkers,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragTime, setDragTime] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hasPreviewFrame, setHasPreviewFrame] = useState(false);
  const dragTimeRef = useRef<number | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const previewHlsRef = useRef<Hls | null>(null);
  const loadedPreviewUrlRef = useRef<string>('');
  const lastPreviewSeekMsRef = useRef<number>(0);
  const pendingPreviewTimeRef = useRef<number | null>(null);
  const isPreviewSeekingRef = useRef<boolean>(false);

  const isScrubActive = isDragging || isHovered;

  const displayTime = isDragging && dragTime !== null
    ? dragTime
    : isHovered && hoverTime !== null
    ? hoverTime
    : currentTime;
  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (displayTime / duration) * 100)) : 0;
  const clampedPreviewPercent = Math.min(88, Math.max(12, progressPercent));

  const formatTime = (secs: number) => {
    if (isNaN(secs) || secs < 0) return '00:00';
    const hrs = Math.floor(secs / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);

    const pad = (num: number) => (num < 10 ? `0${num}` : `${num}`);
    if (hrs > 0) {
      return `${hrs}:${pad(mins)}:${pad(s)}`;
    }
    return `${pad(mins)}:${pad(s)}`;
  };

  const formatDelta = (targetSecs: number, currentSecs: number) => {
    const diff = Math.round(targetSecs - currentSecs);
    if (Math.abs(diff) < 1) return '';
    const sign = diff > 0 ? '+' : '-';
    const abs = Math.abs(diff);
    const mins = Math.floor(abs / 60);
    const secs = abs % 60;
    if (mins > 0) {
      return `${sign}${mins}:${secs < 10 ? `0${secs}` : secs}`;
    }
    return `${sign}${secs}s`;
  };

  const getActiveMarkerLabel = (t: number): string | null => {
    if (!skipMarkers) return null;
    if (skipMarkers.intro && t >= skipMarkers.intro.start && t <= skipMarkers.intro.end) return 'INTRO';
    if (skipMarkers.outro && t >= skipMarkers.outro.start && t <= skipMarkers.outro.end) return 'OUTRO';
    if (skipMarkers.credits && t >= skipMarkers.credits.start && t <= skipMarkers.credits.end) return 'CREDITS';
    return null;
  };

  // Resolve effective stream URL for the dedicated preview video element
  const effectivePreviewUrl = previewStreamUrl || videoElement?.currentSrc || videoElement?.src || '';

  // Clean up preview HLS instance when stream URL changes or component unmounts
  useEffect(() => {
    return () => {
      if (previewHlsRef.current) {
        previewHlsRef.current.destroy();
        previewHlsRef.current = null;
      }
      loadedPreviewUrlRef.current = '';
      setHasPreviewFrame(false);
    };
  }, [effectivePreviewUrl]);

  // Lazily initialize and seek the dedicated muted preview <video> element to the target scrubbed timestamp
  useEffect(() => {
    if (!isScrubActive || !effectivePreviewUrl || duration <= 0) return;
    const pVideo = previewVideoRef.current;
    if (!pVideo) return;

    const localTarget = Math.max(0, displayTime - timeOffset);

    // 1. Initialize preview stream on first scrub/hover for this URL
    if (loadedPreviewUrlRef.current !== effectivePreviewUrl) {
      loadedPreviewUrlRef.current = effectivePreviewUrl;
      setHasPreviewFrame(false);
      isPreviewSeekingRef.current = false;

      if (previewHlsRef.current) {
        previewHlsRef.current.destroy();
        previewHlsRef.current = null;
      }

      const lower = effectivePreviewUrl.toLowerCase();
      const isHls =
        lower.includes('.m3u8') ||
        lower.includes('/proxy/m3u8') ||
        lower.includes('master.txt') ||
        lower.includes('/offline-vault/');

      if (isHls && Hls.isSupported()) {
        const hls = new Hls({
          startPosition: localTarget,
          enableWorker: true,
          lowLatencyMode: false,
          maxBufferLength: 2,
          maxMaxBufferLength: 4,
          backBufferLength: 0,
          maxBufferSize: 4 * 1000 * 1000,
        });
        previewHlsRef.current = hls;
        hls.loadSource(effectivePreviewUrl);
        hls.attachMedia(pVideo);

        hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
          // Lock preview player onto the smallest/fastest resolution level for instant frame decoding
          if (data.levels && data.levels.length > 0) {
            let lowestIdx = 0;
            let lowestHeight = data.levels[0]?.height || 9999;
            data.levels.forEach((lvl: any, idx: number) => {
              const h = lvl.height || 9999;
              if (h < lowestHeight) {
                lowestHeight = h;
                lowestIdx = idx;
              }
            });
            hls.startLevel = lowestIdx;
            hls.currentLevel = lowestIdx;
            hls.loadLevel = lowestIdx;
          }
          try {
            pVideo.currentTime = pendingPreviewTimeRef.current ?? localTarget;
          } catch {}
        });
      } else {
        pVideo.src = effectivePreviewUrl;
        pVideo.preload = 'auto';
        const onLoadedMeta = () => {
          try {
            pVideo.currentTime = pendingPreviewTimeRef.current ?? localTarget;
          } catch {}
        };
        pVideo.addEventListener('loadedmetadata', onLoadedMeta, { once: true });
        pVideo.load();
      }
    }

    // 2. Seek the preview video to the exact target timestamp (throttled for smooth 60fps dragging)
    pendingPreviewTimeRef.current = localTarget;
    const now = Date.now();
    if (!isPreviewSeekingRef.current && now - lastPreviewSeekMsRef.current >= 90) {
      if (Math.abs((pVideo.currentTime || 0) - localTarget) > 0.35) {
        lastPreviewSeekMsRef.current = now;
        isPreviewSeekingRef.current = true;
        try {
          pVideo.currentTime = localTarget;
        } catch {
          isPreviewSeekingRef.current = false;
        }
      }
    }
  }, [isScrubActive, displayTime, effectivePreviewUrl, duration, timeOffset]);

  const getTimeFromEvent = (e: React.MouseEvent | MouseEvent | TouchEvent | React.TouchEvent) => {
    if (!barRef.current || duration <= 0) return 0;
    const rect = barRef.current.getBoundingClientRect();
    let clientX = 0;
    const nativeEvent = 'nativeEvent' in e ? (e as any).nativeEvent : e;

    if ('touches' in nativeEvent && nativeEvent.touches && nativeEvent.touches.length > 0) {
      clientX = nativeEvent.touches[0].clientX;
    } else if ('changedTouches' in nativeEvent && nativeEvent.changedTouches && nativeEvent.changedTouches.length > 0) {
      clientX = nativeEvent.changedTouches[0].clientX;
    } else if ('clientX' in nativeEvent) {
      clientX = (nativeEvent as MouseEvent).clientX;
    } else if ('clientX' in e) {
      clientX = (e as React.MouseEvent).clientX;
    }

    const clickX = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const ratio = clickX / rect.width;
    return ratio * duration;
  };

  const handleStart = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    setIsDragging(true);
    onScrubStart?.();
    const newTime = getTimeFromEvent(e);
    setDragTime(newTime);
    dragTimeRef.current = newTime;
  };

  const handleMouseMoveHover = (e: React.MouseEvent) => {
    if (!isDragging && duration > 0) {
      setHoverTime(getTimeFromEvent(e));
    }
  };

  useEffect(() => {
    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (isDragging) {
        const newTime = getTimeFromEvent(e);
        setDragTime(newTime);
        dragTimeRef.current = newTime;
      }
    };

    const handleEnd = () => {
      if (isDragging) {
        const finalTime = dragTimeRef.current ?? 0;
        onSeek(finalTime);
        setIsDragging(false);
        setDragTime(null);
        dragTimeRef.current = null;
        onScrubEnd?.();
      }
    };

    if (isDragging) {
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', handleMove);
      window.addEventListener('touchend', handleEnd);
    }

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleEnd);
    };
  }, [isDragging, duration]);

  const activeMarkerLabel = getActiveMarkerLabel(displayTime);
  const deltaLabel = isDragging ? formatDelta(displayTime, currentTime) : '';

  return (
    <div
      ref={barRef}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false);
        setHoverTime(null);
      }}
      onMouseMove={handleMouseMoveHover}
      onMouseDown={handleStart}
      onTouchStart={handleStart}
      className="relative flex h-6 w-full cursor-pointer items-center py-2 select-none group touch-none"
      data-interactive="true"
    >
      {/* Floating Video Preview Frame during Drag/Hover (keeps previewVideo mounted once initialized so seeking is instant) */}
      {duration > 0 && (
        <div
          style={{
            left: `${clampedPreviewPercent}%`,
            visibility: isScrubActive ? 'visible' : 'hidden',
            opacity: isScrubActive ? 1 : 0,
          }}
          className="absolute -top-24 sm:-top-28 -translate-x-1/2 z-40 flex flex-col items-center pointer-events-none transition-opacity duration-100"
        >
          <div className="relative w-32 h-18 sm:w-36 sm:h-20 rounded-lg overflow-hidden bg-[#0D0D14] border-2 border-[#8B5CF6]/80 shadow-[0_8px_28px_rgba(0,0,0,0.85)] flex items-center justify-center">
            {posterUrl && !hasPreviewFrame && (
              <img
                src={posterUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-cover opacity-45"
              />
            )}
            <video
              ref={previewVideoRef}
              muted
              playsInline
              preload="metadata"
              referrerPolicy="no-referrer"
              onLoadedData={() => setHasPreviewFrame(true)}
              onSeeked={() => {
                setHasPreviewFrame(true);
                isPreviewSeekingRef.current = false;
                // If user dragged further while previous seek was in flight, immediately seek to latest target
                const pVideo = previewVideoRef.current;
                const latestTarget = pendingPreviewTimeRef.current;
                if (pVideo && latestTarget !== null && Math.abs((pVideo.currentTime || 0) - latestTarget) > 0.6) {
                  lastPreviewSeekMsRef.current = Date.now();
                  isPreviewSeekingRef.current = true;
                  try {
                    pVideo.currentTime = latestTarget;
                  } catch {
                    isPreviewSeekingRef.current = false;
                  }
                }
              }}
              className={`relative z-10 w-full h-full object-cover transition-opacity duration-100 ${
                hasPreviewFrame ? 'opacity-100' : 'opacity-0'
              }`}
            />
            <div className="absolute inset-0 z-20 bg-gradient-to-t from-black/85 via-transparent to-transparent" />

            {/* Chapter / Skip Marker Badge inside Preview Frame */}
            {activeMarkerLabel && (
              <span className="absolute top-1.5 left-1.5 z-30 rounded bg-[#8B5CF6] px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider text-white shadow">
                {activeMarkerLabel}
              </span>
            )}

            {/* Relative Seek Delta Badge (+01:15 / -00:30) */}
            {deltaLabel && (
              <span className="absolute top-1.5 right-1.5 z-30 rounded bg-black/80 px-1.5 py-0.5 text-[9px] font-bold text-[#C4B5FD] border border-white/15">
                {deltaLabel}
              </span>
            )}

            {/* Timestamp Pill at Bottom of Preview Frame */}
            <div className="absolute bottom-1 inset-x-0 z-30 flex items-center justify-center">
              <span className="rounded bg-black/85 px-2 py-0.5 text-[10px] sm:text-[11px] font-extrabold tabular-nums text-white border border-white/15 shadow">
                {formatTime(displayTime)}
              </span>
            </div>

            {/* Mini Progress Line inside Preview Card */}
            <div className="absolute bottom-0 inset-x-0 z-30 h-0.5 bg-white/20">
              <div
                style={{ width: `${progressPercent}%` }}
                className="h-full bg-gradient-to-r from-[#A855F7] via-[#8B5CF6] to-[#6366F1]"
              />
            </div>
          </div>
          <div className="w-2 h-2 rotate-45 bg-[#8B5CF6] -mt-1 shadow" />
        </div>
      )}

      {/* Main Track Bar */}
      <div className="relative h-1.5 w-full rounded-full bg-white/20 transition-all duration-150 group-hover:h-2.5 overflow-hidden">
        {/* Buffer Bar */}
        <div
          style={{ width: `${buffered}%` }}
          className="absolute h-full bg-white/30 transition-all duration-300"
        />

        {/* Progress Fill Bar with MaxPlay Signature Purple Gradient */}
        <div
          style={{ width: `${progressPercent}%` }}
          className="absolute h-full bg-gradient-to-r from-[#A855F7] via-[#8B5CF6] to-[#6366F1] shadow-[0_0_10px_rgba(139,92,246,0.6)] z-10"
        />
      </div>

      {/* Scrubber Thumb Knob */}
      <div
        style={{ left: `${progressPercent}%` }}
        className={`absolute -translate-x-1/2 h-3.5 w-3.5 rounded-full bg-gradient-to-r from-[#A855F7] via-[#8B5CF6] to-[#6366F1] border-2 border-white shadow-[0_0_10px_rgba(139,92,246,0.8)] transition-transform duration-100 ${
          isHovered || isDragging ? 'scale-125' : 'scale-100'
        }`}
      />
    </div>
  );
};


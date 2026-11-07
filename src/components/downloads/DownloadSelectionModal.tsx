import React, { useState, useMemo, useEffect } from 'react';
import {
  X,
  Download,
  Check,
  Sparkles,
  Film,
  Tv,
  HardDrive,
  CheckSquare,
  Square,
  AlertCircle,
  AlertTriangle,
  Trash2,
  ChevronDown,
  Crown,
  HelpCircle,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { ContentItem } from '../../types';
import { downloadManager } from '../../services/DownloadManager';
import { SmartStreamService } from '../../services/smartStreamService';
import { NativeBridgeService } from '../../services/nativeBridgeService';
import { ClientHlsDownloader } from '../../services/clientHlsDownloader';

interface DownloadSelectionModalProps {
  visible: boolean;
  content: ContentItem;
  initialSeasonIndex?: number;
  initialEpisodeIndex?: number;
  selectedServer?: 'server1' | 'server2';
  activePrimaryUrl?: string;
  activeSecondaryUrl?: string;
  activeStreamDuration?: number;
  onClose: () => void;
  onSuccessToast?: (msg: string) => void;
}

interface QualityOptionItem {
  id: string;
  label: string;
  badge: string;
  movieSizeMb: number;
  epSizeMb: number;
  bandwidth: number;
  url: string;
  isLive: boolean;
  serverSource: 'server1' | 'server2';
}

interface EpisodeResolvedPlan {
  epIndex: number;
  epNumber: number;
  epTitle: string;
  epId: string;
  requestedQuality: string;
  resolvedQuality: string;
  resolvedServer: 'server1' | 'server2';
  language: string;
  targetUrl: string;
  backupUrl?: string;
  sizeMb: number;
  status: 'exact' | 'cross_server_exact' | 'fallback_quality' | 'unavailable';
  isFallbackQuality: boolean;
  isCrossServerAuto: boolean;
}

export const DownloadSelectionModal: React.FC<DownloadSelectionModalProps> = (props) => {
  return (
    <AnimatePresence>
      {props.visible && props.content && <DownloadSelectionModalInner {...props} />}
    </AnimatePresence>
  );
};

const DownloadSelectionModalInner: React.FC<DownloadSelectionModalProps> = ({
  visible = true,
  content,
  initialSeasonIndex = 0,
  initialEpisodeIndex = 0,
  selectedServer = 'server1',
  activePrimaryUrl = '',
  activeSecondaryUrl = '',
  activeStreamDuration = 0,
  onClose,
  onSuccessToast,
}) => {

  // Content type evaluation - Precise Movie vs Series / Anime
  const isMovie = useMemo(() => {
    if (!content) return true;
    const cType = (
      content.type ||
      (content as any).media_type ||
      (content as any).uploadMode ||
      (content as any).category ||
      ''
    )
      .toString()
      .toLowerCase();

    if (cType === 'movie' || cType === 'film' || cType === 'feature') {
      return true;
    }

    const seasons = content.seasonsData;
    const hasEpisodesInSeasons =
      Array.isArray(seasons) &&
      seasons.some((s) => Array.isArray(s?.episodes) && s.episodes.length > 0);
    const hasEpisodesList =
      Array.isArray(content.episodesList) && content.episodesList.length > 0;

    if (hasEpisodesInSeasons || hasEpisodesList) {
      return false;
    }

    if (cType === 'series' || cType === 'tv' || cType === 'anime' || cType === 'show') {
      return false;
    }

    if (typeof content.episodes === 'number' && content.episodes > 1) {
      return false;
    }

    return true;
  }, [content]);

  const isSeries = !isMovie;

  // 1. Series Season and Episode selection state
  const seasonsData = content.seasonsData || [];
  const [selectedSeasonIdx, setSelectedSeasonIdx] = useState<number>(
    initialSeasonIndex < seasonsData.length ? initialSeasonIndex : 0
  );

  const currentEpisodes = useMemo(() => {
    if (!isSeries) return [];
    if (seasonsData.length > 0 && seasonsData[selectedSeasonIdx]?.episodes) {
      return seasonsData[selectedSeasonIdx].episodes;
    }
    if (content.episodesList && content.episodesList.length > 0) {
      return content.episodesList;
    }
    if (content.type === 'series' && content.episodes && content.episodes > 0) {
      const count = content.episodes;
      return Array.from({ length: count }, (_, i) => ({
        id: `ep-${i + 1}`,
        episodeNumber: i + 1,
        title: `Episode ${i + 1}`,
        duration: content.duration || 1440,
        videoUrl: i === 0 ? content.videoUrl || '' : '',
      }));
    }
    return [];
  }, [isSeries, seasonsData, selectedSeasonIdx, content]);

  // Active reference episode for initial probe only (does NOT change on every checkbox tap so UI stays 0ms instant)
  const [focusedEpisodeIdx] = useState<number>(() => {
    return initialEpisodeIndex < currentEpisodes.length ? initialEpisodeIndex : 0;
  });

  // Selected episodes set for batch downloading
  const [selectedEpIndices, setSelectedEpIndices] = useState<Set<number>>(() => {
    const set = new Set<number>();
    const startIdx = initialEpisodeIndex < currentEpisodes.length ? initialEpisodeIndex : 0;
    set.add(startIdx);
    return set;
  });

  // Reset selected episodes when switching seasons
  const handleSelectSeason = (sIdx: number) => {
    setSelectedSeasonIdx(sIdx);
    setSelectedEpIndices(new Set([0]));
    setShowSummaryReview(false);
  };

  // Pre-download summary confirmation step state
  const [showSummaryReview, setShowSummaryReview] = useState<boolean>(false);

  // In-modal server selector (defaults to currently active player server, switchable inside modal!)
  const [modalServer, setModalServer] = useState<'server1' | 'server2'>(selectedServer);

  useEffect(() => {
    setModalServer(selectedServer);
  }, [selectedServer, visible]);

  useEffect(() => {
    if (visible) {
      setShowSummaryReview(false);
    }
  }, [visible, content]);

  // Real Device Storage Stats (Android StatFs via NativeBridge or Web StorageManager)
  const [freeStorageGb, setFreeStorageGb] = useState<number | null>(null);

  useEffect(() => {
    if (!visible) return;
    const nativeStats = NativeBridgeService.getDeviceStorageStats();
    if (nativeStats && nativeStats.ok && typeof nativeStats.freeGb === 'number') {
      setFreeStorageGb(nativeStats.freeGb);
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      navigator.storage
        .estimate()
        .then((est) => {
          if (est && typeof est.quota === 'number' && typeof est.usage === 'number') {
            const freeBytes = Math.max(0, est.quota - est.usage);
            setFreeStorageGb(Math.round((freeBytes / (1024 * 1024 * 1024)) * 10) / 10);
          }
        })
        .catch(() => {});
    }
  }, [visible]);

  type ExtractedServerMeta = {
    audioTracks?: string[];
    qualities?: string[];
    downloadQualities?: Array<{ id: string; label: string; sizeMb: number; url?: string; bandwidth?: number }>;
    duration?: number;
    isLiveProbed?: boolean;
  };

  const [server1Meta, setServer1Meta] = useState<ExtractedServerMeta | null>(null);
  const [server2Meta, setServer2Meta] = useState<ExtractedServerMeta | null>(null);
  const [isProbing, setIsProbing] = useState<boolean>(false);

  const isQualityKey = (val: string): boolean => {
    if (!val || typeof val !== 'string') return false;
    return /^(\d{3,4}p|4k|2k|8k|hd|fhd|uhd|sd|auto)$/i.test(val.trim());
  };

  // Sanitize a qualityLinks dictionary and heal accidental 1080p clones when Admin only verified 720p/480p/360p
  const sanitizeQualityDict = (
    rawDict: Record<string, string> | undefined | null,
    savedArr: any[] | undefined | null
  ): Record<string, string> => {
    if (!rawDict || typeof rawDict !== 'object') return {};
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawDict)) {
      const cleanK = k.trim();
      const cleanV = SmartStreamService.sanitizeStreamUrl(v);
      if (cleanK && cleanV && isQualityKey(cleanK) && cleanK.toLowerCase() !== 'auto') {
        cleaned[cleanK] = cleanV;
      }
    }
    if (cleaned['1080p']) {
      const otherKeys = Object.keys(cleaned).filter((k) => k !== '1080p');
      const isDuplicateOfLower = otherKeys.some((k) => cleaned[k] === cleaned['1080p']);
      const savedHasOtherOnly =
        Array.isArray(savedArr) &&
        savedArr.length > 0 &&
        !savedArr.some((q: any) => String(q?.id || '').trim().toLowerCase() === '1080p');
      if (isDuplicateOfLower || (savedHasOtherOnly && otherKeys.length > 0)) {
        delete cleaned['1080p'];
      }
    }
    return cleaned;
  };

  /**
   * STRICT URL EXTRACTOR:
   * - When `ep` is provided (Series Episode), NEVER falls back to root `content.videoUrl` / `content.qualityLinks`
   *   (because root `content` links belong to Episode 1 and would cause cross-episode audio/video contamination!).
   * - When `ep` is null (Movie), extracts from `content`.
   */
  const extractUrlsFromItem = (
    ep: any | null,
    useActivePlayerFallback: boolean
  ): { primaryUrl: string; secondaryUrl: string } => {
    const firstFromDict = (dict: any): string => {
      if (!dict || typeof dict !== 'object') return '';
      for (const k of ['1080p', '720p', '480p', '360p', ...Object.keys(dict)]) {
        const val = dict[k];
        if (typeof val === 'string' && val.trim().length > 0) return val.trim();
      }
      return '';
    };

    const firstFromSources = (sources: any): string => {
      if (!sources || typeof sources !== 'object') return '';
      for (const k of Object.keys(sources)) {
        const entry = sources[k];
        if (typeof entry === 'string' && entry.trim().length > 0) return entry.trim();
        if (entry && typeof entry === 'object') {
          const nested = firstFromDict(entry);
          if (nested) return nested;
        }
      }
      return '';
    };

    let pUrl = '';
    let sUrl = '';

    if (ep) {
      // Strictly inspect THIS episode only — never fall back to root content!
      const epPart0 =
        Array.isArray(ep?.videoLinks) && ep.videoLinks.length > 0 && typeof ep.videoLinks[0] === 'object'
          ? ep.videoLinks[0]
          : null;

      pUrl =
        firstFromDict(ep.qualityLinks) ||
        ep.videoUrl ||
        ep.streamUrl ||
        ep.url ||
        firstFromSources(ep.videoSources) ||
        firstFromDict(epPart0?.qualityLinks) ||
        epPart0?.videoUrl ||
        firstFromSources(epPart0?.videoSources) ||
        (typeof ep?.videoLinks?.[0] === 'string' ? ep.videoLinks[0] : '') ||
        '';

      sUrl =
        firstFromDict(ep.secondaryServerQualityLinks) ||
        firstFromDict(ep.secondaryQualityLinks) ||
        ep.secondaryServerUrl ||
        ep.secondaryVideoUrl ||
        ep.secondaryUrl ||
        firstFromDict(epPart0?.secondaryServerQualityLinks) ||
        firstFromDict(epPart0?.secondaryQualityLinks) ||
        epPart0?.secondaryServerUrl ||
        epPart0?.secondaryVideoUrl ||
        epPart0?.secondaryUrl ||
        '';
    } else {
      // Movie: inspect content-level fields
      const contentPart0 =
        Array.isArray((content as any)?.videoLinks) &&
        (content as any).videoLinks.length > 0 &&
        typeof (content as any).videoLinks[0] === 'object'
          ? (content as any).videoLinks[0]
          : null;
      const moviePart0 =
        Array.isArray((content as any)?.movieParts) &&
        (content as any).movieParts.length > 0 &&
        typeof (content as any).movieParts[0] === 'object'
          ? (content as any).movieParts[0]
          : null;

      pUrl =
        firstFromDict(content.qualityLinks) ||
        firstFromDict(contentPart0?.qualityLinks) ||
        firstFromDict(moviePart0?.qualityLinks) ||
        contentPart0?.videoUrl ||
        moviePart0?.videoUrl ||
        content.videoUrl ||
        (content as any).streamUrl ||
        firstFromSources(content.videoSources) ||
        firstFromSources(contentPart0?.videoSources) ||
        firstFromSources(moviePart0?.videoSources) ||
        (typeof (content as any)?.videoLinks?.[0] === 'string' ? (content as any).videoLinks[0] : '') ||
        '';

      sUrl =
        firstFromDict((content as any).secondaryServerQualityLinks) ||
        firstFromDict(content.secondaryQualityLinks) ||
        firstFromDict(contentPart0?.secondaryServerQualityLinks) ||
        firstFromDict(contentPart0?.secondaryQualityLinks) ||
        firstFromDict(moviePart0?.secondaryServerQualityLinks) ||
        firstFromDict(moviePart0?.secondaryQualityLinks) ||
        contentPart0?.secondaryServerUrl ||
        contentPart0?.secondaryVideoUrl ||
        contentPart0?.secondaryUrl ||
        moviePart0?.secondaryServerUrl ||
        moviePart0?.secondaryVideoUrl ||
        moviePart0?.secondaryUrl ||
        (content as any).secondaryServerUrl ||
        content.secondaryVideoUrl ||
        (content as any).secondaryUrl ||
        '';

      if (useActivePlayerFallback) {
        if (!pUrl && activePrimaryUrl) pUrl = activePrimaryUrl;
        if (!sUrl && activeSecondaryUrl) sUrl = activeSecondaryUrl;
      }
    }

    return {
      primaryUrl: SmartStreamService.sanitizeStreamUrl(pUrl),
      secondaryUrl: SmartStreamService.sanitizeStreamUrl(sUrl),
    };
  };

  // Determine available server URLs across Movie or Season Episodes
  const { primaryUrl, secondaryUrl, hasServer1, hasServer2 } = useMemo(() => {
    if (isMovie) {
      const { primaryUrl: pUrl, secondaryUrl: sUrl } = extractUrlsFromItem(null, true);
      return {
        primaryUrl: pUrl,
        secondaryUrl: sUrl,
        hasServer1: Boolean(pUrl && pUrl.length > 0),
        hasServer2: Boolean(sUrl && sUrl.length > 0),
      };
    }

    const activeEp = currentEpisodes[focusedEpisodeIdx] || currentEpisodes[0] || null;
    const { primaryUrl: fPUrl, secondaryUrl: fSUrl } = extractUrlsFromItem(activeEp, false);

    let anyS1 = Boolean(fPUrl);
    let anyS2 = Boolean(fSUrl);
    for (const ep of currentEpisodes) {
      if (anyS1 && anyS2) break;
      const u = extractUrlsFromItem(ep, false);
      if (u.primaryUrl) anyS1 = true;
      if (u.secondaryUrl) anyS2 = true;
    }

    return {
      primaryUrl: fPUrl,
      secondaryUrl: fSUrl,
      hasServer1: anyS1,
      hasServer2: anyS2,
    };
  }, [isMovie, currentEpisodes, focusedEpisodeIdx, content, activePrimaryUrl, activeSecondaryUrl]);

  // Helper to probe a single server URL (0ms if cached in SmartStreamService)
  const probeSingleServerUrl = async (
    targetUrl: string,
    requestedDur: number
  ): Promise<ExtractedServerMeta | null> => {
    if (!targetUrl) return null;
    const scopedMetaKey = `${content.id}_s${selectedSeasonIdx}_e${focusedEpisodeIdx}_${targetUrl}`;
    try {
      const cachedMeta = SmartStreamService.getCachedStreamMeta(scopedMetaKey);
      if (
        cachedMeta &&
        Array.isArray(cachedMeta.downloadQualities) &&
        cachedMeta.downloadQualities.length > 0
      ) {
        return {
          audioTracks: cachedMeta.audioTracks,
          qualities: cachedMeta.qualities,
          downloadQualities: cachedMeta.downloadQualities,
          duration: cachedMeta.duration || requestedDur,
          isLiveProbed: true,
        };
      }

      const cachedM3u8 =
        SmartStreamService.getCachedStreamUrl(targetUrl) ||
        (targetUrl.toLowerCase().includes('.m3u8') ? targetUrl : null);

      if (cachedM3u8) {
        const directParsed = await ClientHlsDownloader.probeMasterPlaylist(cachedM3u8, requestedDur);
        if (directParsed && directParsed.downloadQualities.length > 0) {
          SmartStreamService.setCachedStreamMeta(scopedMetaKey, directParsed);
          SmartStreamService.setCachedStreamMeta(targetUrl, directParsed);
          return {
            audioTracks: directParsed.audioTracks,
            qualities: directParsed.qualities,
            downloadQualities: directParsed.downloadQualities,
            duration: directParsed.duration,
            isLiveProbed: true,
          };
        }
      }

      if (NativeBridgeService.isRunningInKotlinApp()) {
        const nativeMeta = await NativeBridgeService.extractStreamNative(targetUrl, requestedDur);
        if (nativeMeta && nativeMeta.ok) {
          const metaObj = {
            audioTracks: nativeMeta.audioTracks,
            qualities: nativeMeta.qualities,
            downloadQualities: nativeMeta.downloadQualities,
            duration: nativeMeta.duration,
          };
          SmartStreamService.setCachedStreamMeta(scopedMetaKey, metaObj);
          SmartStreamService.setCachedStreamMeta(targetUrl, metaObj);
          return {
            ...metaObj,
            isLiveProbed: true,
          };
        }
      }

      const resolved = await SmartStreamService.resolveStream(targetUrl, { forceRefresh: false });
      if (resolved && resolved.streamUrl && !resolved.isEmbed) {
        const parsedAfterResolve = await ClientHlsDownloader.probeMasterPlaylist(
          resolved.streamUrl,
          requestedDur
        );
        if (parsedAfterResolve && parsedAfterResolve.downloadQualities.length > 0) {
          SmartStreamService.setCachedStreamMeta(scopedMetaKey, parsedAfterResolve);
          SmartStreamService.setCachedStreamMeta(targetUrl, parsedAfterResolve);
          return {
            audioTracks: parsedAfterResolve.audioTracks,
            qualities: parsedAfterResolve.qualities,
            downloadQualities: parsedAfterResolve.downloadQualities,
            duration: parsedAfterResolve.duration,
            isLiveProbed: true,
          };
        }
      }
    } catch (err) {
      console.warn('[DownloadModal] Server probe warning:', err);
    }
    return null;
  };

  // Probe ONLY when no Admin-verified downloadQualities exist (instant 0ms when verified!)
  useEffect(() => {
    let isCancelled = false;
    const activeEp = isSeries ? currentEpisodes[focusedEpisodeIdx] : null;
    const requestedDur = Number(activeEp?.duration || content.duration || 0);

    setServer1Meta(null);
    setServer2Meta(null);

    const contentPart0 =
      Array.isArray((content as any)?.videoLinks) && (content as any).videoLinks.length > 0
        ? (content as any).videoLinks[0]
        : null;
    const epPart0 =
      Array.isArray(activeEp?.videoLinks) && activeEp.videoLinks.length > 0
        ? activeEp.videoLinks[0]
        : null;

    const existingS1Dl = isSeries
      ? (activeEp as any)?.downloadQualities || epPart0?.downloadQualities
      : (content as any)?.downloadQualities || contentPart0?.downloadQualities;
    const existingS2Dl = isSeries
      ? (activeEp as any)?.secondaryDownloadQualities || epPart0?.secondaryDownloadQualities
      : (content as any)?.secondaryDownloadQualities || contentPart0?.secondaryDownloadQualities;
    const existingS1Audios = isSeries
      ? (activeEp as any)?.audioTracks || epPart0?.audioTracks
      : (content as any)?.audioTracks || contentPart0?.audioTracks;
    const existingS2Audios = isSeries
      ? (activeEp as any)?.secondaryAudioTracks || epPart0?.secondaryAudioTracks
      : (content as any)?.secondaryAudioTracks || contentPart0?.secondaryAudioTracks;

    const hasVerifiedS1 = Array.isArray(existingS1Dl) && existingS1Dl.length > 0;
    const hasVerifiedS2 = Array.isArray(existingS2Dl) && existingS2Dl.length > 0;

    if (hasVerifiedS1) {
      setServer1Meta({
        downloadQualities: existingS1Dl,
        audioTracks: Array.isArray(existingS1Audios) ? existingS1Audios : undefined,
        duration: requestedDur,
        isLiveProbed: true,
      });
    }
    if (hasVerifiedS2) {
      setServer2Meta({
        downloadQualities: existingS2Dl,
        audioTracks: Array.isArray(existingS2Audios) ? existingS2Audios : undefined,
        duration: requestedDur,
        isLiveProbed: true,
      });
    }

    // Proactively probe BOTH Server 1 and Server 2 in parallel so exact per-server audio tracks (e.g. Tamil on S2)
    // and cross-server qualities are known immediately!
    const needS1Probe = Boolean(primaryUrl && (!hasVerifiedS1 || !Array.isArray(existingS1Audios) || existingS1Audios.length === 0));
    const needS2Probe = Boolean(secondaryUrl && (!hasVerifiedS2 || !Array.isArray(existingS2Audios) || existingS2Audios.length === 0));

    if (!needS1Probe && !needS2Probe) {
      setIsProbing(false);
      return;
    }

    const deferTimer = setTimeout(async () => {
      if (isCancelled) return;
      if ((modalServer === 'server1' && !hasVerifiedS1) || (modalServer === 'server2' && !hasVerifiedS2)) {
        setIsProbing(true);
      }
      try {
        await Promise.all([
          needS1Probe
            ? probeSingleServerUrl(primaryUrl, requestedDur).then((s1) => {
                if (!isCancelled && s1) {
                  setServer1Meta((prev) => ({
                    downloadQualities:
                      prev?.downloadQualities && prev.downloadQualities.length > 0
                        ? prev.downloadQualities
                        : s1.downloadQualities,
                    audioTracks:
                      s1.audioTracks && s1.audioTracks.length > 0 ? s1.audioTracks : prev?.audioTracks,
                    duration: s1.duration || prev?.duration || requestedDur,
                    isLiveProbed: true,
                  }));
                }
              })
            : Promise.resolve(),
          needS2Probe
            ? probeSingleServerUrl(secondaryUrl, requestedDur).then((s2) => {
                if (!isCancelled && s2) {
                  setServer2Meta((prev) => ({
                    downloadQualities:
                      prev?.downloadQualities && prev.downloadQualities.length > 0
                        ? prev.downloadQualities
                        : s2.downloadQualities,
                    audioTracks:
                      s2.audioTracks && s2.audioTracks.length > 0 ? s2.audioTracks : prev?.audioTracks,
                    duration: s2.duration || prev?.duration || requestedDur,
                    isLiveProbed: true,
                  }));
                }
              })
            : Promise.resolve(),
        ]);
      } finally {
        if (!isCancelled) setIsProbing(false);
      }
    }, 50);

    return () => {
      isCancelled = true;
      clearTimeout(deferTimer);
    };
  }, [content, isSeries, focusedEpisodeIdx, currentEpisodes, primaryUrl, secondaryUrl, modalServer]);

  // 2. Unified Available Languages Filter (Applies smoothly to BOTH Server 1 and Server 2 without forcing server jumps!)
  const availableLanguages = useMemo(() => {
    const list: string[] = [];

    const addLang = (rawLang: string) => {
      if (!rawLang || typeof rawLang !== 'string') return;
      // Split comma/slash separated language strings e.g. "Hindi, English"
      const parts = rawLang.split(/[,/|•+]+/).map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        if (isQualityKey(part)) continue;
        const cleaned = ClientHlsDownloader.normalizeLanguageLabel(part, part) || part.trim();
        if (
          !cleaned ||
          cleaned === 'Default' ||
          cleaned === 'Default Audio' ||
          cleaned.toLowerCase() === 'unknown' ||
          isQualityKey(cleaned)
        ) {
          continue;
        }
        if (!list.some((l) => l.toLowerCase() === cleaned.toLowerCase())) {
          list.push(cleaned);
        }
      }
    };

    // Collect from live/verified server meta
    if (Array.isArray(server1Meta?.audioTracks)) {
      server1Meta!.audioTracks!.forEach(addLang);
    }
    if (Array.isArray(server2Meta?.audioTracks)) {
      server2Meta!.audioTracks!.forEach(addLang);
    }

    // Collect across episodes in the active season (both Server 1 & Server 2 metadata)
    if (isSeries) {
      for (const ep of currentEpisodes) {
        if (Array.isArray((ep as any)?.audioTracks)) (ep as any).audioTracks.forEach(addLang);
        if (Array.isArray((ep as any)?.secondaryAudioTracks)) (ep as any).secondaryAudioTracks.forEach(addLang);
        if (Array.isArray((ep as any)?.languages)) (ep as any).languages.forEach(addLang);
        if (typeof (ep as any)?.language === 'string') addLang((ep as any).language);
        if (ep?.videoSources && typeof ep.videoSources === 'object') {
          Object.keys(ep.videoSources).forEach(addLang);
        }
      }
    }

    // Collect from content-level metadata
    if (Array.isArray((content as any).audioTracks)) {
      (content as any).audioTracks.forEach(addLang);
    }
    if (Array.isArray((content as any).secondaryAudioTracks)) {
      (content as any).secondaryAudioTracks.forEach(addLang);
    }
    if (content.videoSources && typeof content.videoSources === 'object') {
      Object.keys(content.videoSources).forEach(addLang);
    }
    if (Array.isArray(content.languages) && content.languages.length > 0) {
      content.languages.forEach(addLang);
    }
    if (Array.isArray(content.availableLanguages)) {
      content.availableLanguages.forEach(addLang);
    }
    if (typeof (content as any).language === 'string') {
      addLang((content as any).language);
    }

    if (list.length === 0) {
      list.push('Hindi');
    }
    return list;
  }, [content, isSeries, currentEpisodes, server1Meta, server2Meta]);

  const [selectedLanguage, setSelectedLanguage] = useState<string>(availableLanguages[0] || 'Hindi');

  useEffect(() => {
    if (
      availableLanguages.length > 0 &&
      !availableLanguages.some((l) => l.toLowerCase() === selectedLanguage.toLowerCase())
    ) {
      setSelectedLanguage(availableLanguages[0]);
    }
  }, [availableLanguages, selectedLanguage]);

  /**
   * Helper: Builds the exact map of available qualities `{ [qId]: { id, url, sizeMb, bandwidth } }`
   * for a single item (`ep` for Series, or `null` for Movie) on a specific server (`server1` or `server2`).
   * STRICTLY isolated per episode so Episode N never inherits Episode 1's qualities or URLs!
   */
  const getItemServerQualityMap = (
    ep: any | null,
    serverId: 'server1' | 'server2',
    liveMetaForItem: ExtractedServerMeta | null = null
  ): Map<string, { id: string; url: string; sizeMb: number; bandwidth: number; label: string; badge: string }> => {
    const map = new Map<
      string,
      { id: string; url: string; sizeMb: number; bandwidth: number; label: string; badge: string }
    >();

    const isS2 = serverId === 'server2';

    let linksDict: Record<string, string> | undefined;
    let savedDlArr: any[] | undefined;
    let singleFallbackUrl = '';

    if (ep) {
      const epPart0 =
        Array.isArray(ep?.videoLinks) && ep.videoLinks.length > 0 && typeof ep.videoLinks[0] === 'object'
          ? ep.videoLinks[0]
          : null;

      linksDict = isS2
        ? (ep as any)?.secondaryServerQualityLinks ||
          (ep as any)?.secondaryQualityLinks ||
          epPart0?.secondaryServerQualityLinks ||
          epPart0?.secondaryQualityLinks
        : ep?.qualityLinks || epPart0?.qualityLinks;

      savedDlArr = isS2
        ? (ep as any)?.secondaryDownloadQualities || epPart0?.secondaryDownloadQualities
        : (ep as any)?.downloadQualities || epPart0?.downloadQualities;

      const urls = extractUrlsFromItem(ep, false);
      singleFallbackUrl = isS2 ? urls.secondaryUrl : urls.primaryUrl;
    } else {
      const contentPart0 =
        Array.isArray((content as any)?.videoLinks) &&
        (content as any).videoLinks.length > 0 &&
        typeof (content as any).videoLinks[0] === 'object'
          ? (content as any).videoLinks[0]
          : null;
      const moviePart0 =
        Array.isArray((content as any)?.movieParts) &&
        (content as any).movieParts.length > 0 &&
        typeof (content as any).movieParts[0] === 'object'
          ? (content as any).movieParts[0]
          : null;

      linksDict = isS2
        ? (content as any).secondaryServerQualityLinks ||
          content.secondaryQualityLinks ||
          contentPart0?.secondaryServerQualityLinks ||
          contentPart0?.secondaryQualityLinks ||
          moviePart0?.secondaryServerQualityLinks ||
          moviePart0?.secondaryQualityLinks
        : content.qualityLinks || contentPart0?.qualityLinks || moviePart0?.qualityLinks;

      savedDlArr = isS2
        ? (content as any)?.secondaryDownloadQualities || contentPart0?.secondaryDownloadQualities
        : (content as any)?.downloadQualities || contentPart0?.downloadQualities;

      const urls = extractUrlsFromItem(null, true);
      singleFallbackUrl = isS2 ? urls.secondaryUrl : urls.primaryUrl;
    }

    const cleanedLinks = sanitizeQualityDict(linksDict, savedDlArr);
    const hasExplicitBoxes = Object.keys(cleanedLinks).length > 0;

    // 1. Add Admin-configured explicit quality links (1080p, 720p, 480p, 360p)
    if (hasExplicitBoxes) {
      for (const [cleanKey, cleanLink] of Object.entries(cleanedLinks)) {
        map.set(cleanKey, {
          id: cleanKey,
          url: cleanLink,
          sizeMb: 0,
          bandwidth: 0,
          label: `${cleanKey} ${
            cleanKey.includes('1080')
              ? 'Full HD'
              : cleanKey.includes('720')
              ? 'HD'
              : cleanKey.includes('480')
              ? 'Standard'
              : 'Data Saver'
          }`,
          badge: cleanKey.includes('1080')
            ? 'Full HD'
            : cleanKey.includes('720')
            ? 'HD'
            : cleanKey.includes('480')
            ? 'Standard'
            : 'Data Saver',
        });
      }
    }

    // 2. Merge Admin-verified downloadQualities (real MB size saved from Admin Verify button)
    if (Array.isArray(savedDlArr)) {
      for (const q of savedDlArr) {
        const qId = String(q?.id || '').trim();
        if (!isQualityKey(qId) || qId.toLowerCase() === 'auto') continue;
        const existing = map.get(qId);
        if (hasExplicitBoxes && !existing) continue;
        const realMb = Number(q?.sizeMb) > 0 ? Math.round(Number(q.sizeMb)) : existing?.sizeMb || 0;
        const cleanUrl = SmartStreamService.sanitizeStreamUrl(existing?.url || q?.url || singleFallbackUrl || '');
        if (!cleanUrl) continue;
        map.set(qId, {
          id: qId,
          url: cleanUrl,
          sizeMb: realMb,
          bandwidth: Number(q?.bandwidth || existing?.bandwidth || 0),
          label:
            q?.label ||
            existing?.label ||
            `${qId} ${qId.includes('1080') ? 'Full HD' : qId.includes('720') ? 'HD' : 'Standard'}`,
          badge: realMb > 0 ? 'Verified HLS • Real Size' : existing?.badge || 'Verified Stream',
        });
      }
    }

    // 3. Merge live probed HLS manifest variants (only when applicable to this item)
    if (liveMetaForItem && Array.isArray(liveMetaForItem.downloadQualities)) {
      const allowNewVariants = map.size === 0;
      for (const q of liveMetaForItem.downloadQualities) {
        const qId = String(q?.id || '').trim();
        if (!isQualityKey(qId) || qId.toLowerCase() === 'auto') continue;
        const existing = map.get(qId);
        if (!existing && !allowNewVariants) continue;
        const realMb =
          existing?.sizeMb && existing.sizeMb > 0
            ? existing.sizeMb
            : Number(q?.sizeMb) > 0
            ? Math.round(Number(q.sizeMb))
            : 0;
        const cleanUrl = SmartStreamService.sanitizeStreamUrl(existing?.url || q?.url || singleFallbackUrl || '');
        if (!cleanUrl) continue;
        map.set(qId, {
          id: qId,
          url: cleanUrl,
          sizeMb: realMb,
          bandwidth: Number(q?.bandwidth || existing?.bandwidth || 0),
          label:
            q?.label ||
            existing?.label ||
            `${qId} ${qId.includes('1080') ? 'Full HD' : qId.includes('720') ? 'HD' : 'Standard'}`,
          badge:
            realMb > 0
              ? qId.includes('1080')
                ? 'Verified • Full HD'
                : qId.includes('720')
                ? 'Verified • HD'
                : 'Verified • Data Saver'
              : existing?.badge || 'Live Stream',
        });
      }
    }

    // 4. If single URL exists without explicit boxes or verified array yet, check SmartStreamService cache or provide single entry
    if (map.size === 0 && singleFallbackUrl) {
      const cachedMeta = SmartStreamService.getCachedStreamMeta(singleFallbackUrl);
      if (cachedMeta && Array.isArray(cachedMeta.downloadQualities) && cachedMeta.downloadQualities.length > 0) {
        for (const q of cachedMeta.downloadQualities) {
          const qId = String(q?.id || '').trim();
          if (!isQualityKey(qId) || qId.toLowerCase() === 'auto') continue;
          map.set(qId, {
            id: qId,
            url: SmartStreamService.sanitizeStreamUrl(q?.url || singleFallbackUrl),
            sizeMb: Number(q?.sizeMb) > 0 ? Math.round(Number(q.sizeMb)) : 0,
            bandwidth: Number(q?.bandwidth || 0),
            label: `${qId} Stream`,
            badge: 'HLS Stream',
          });
        }
      }
    }

    return map;
  };

  // 3. Movie Quality Options & Series Global Quality Pill Filter Options
  const { qualityOptions, crossServerQualityOptions, seriesGlobalQualities } = useMemo(() => {
    const isServer2 = modalServer === 'server2';

    if (isMovie) {
      const s1Map = hasServer1 ? getItemServerQualityMap(null, 'server1', server1Meta) : new Map();
      const s2Map = hasServer2 ? getItemServerQualityMap(null, 'server2', server2Meta) : new Map();

      const toOptions = (
        m: Map<string, { id: string; url: string; sizeMb: number; bandwidth: number; label: string; badge: string }>,
        srv: 'server1' | 'server2'
      ): QualityOptionItem[] =>
        Array.from(m.values())
          .map((v) => ({
            id: v.id,
            label: v.label,
            badge: v.badge,
            movieSizeMb: v.sizeMb,
            epSizeMb: v.sizeMb,
            bandwidth: v.bandwidth,
            url: v.url,
            isLive: true,
            serverSource: srv,
          }))
          .sort((a, b) => (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0));

      const s1Opts = toOptions(s1Map, 'server1');
      const s2Opts = toOptions(s2Map, 'server2');

      // Merge any qualities that exist on the other server (e.g. 1080p on Server 2 when Server 1 only has 720p/480p)
      // so the user can select any available quality regardless of which server tab is active!
      const primaryOpts = isServer2 ? s2Opts : s1Opts;
      const otherOpts = isServer2 ? s1Opts : s2Opts;
      const mergedMovieOpts = [...primaryOpts];
      for (const o of otherOpts) {
        if (!mergedMovieOpts.some((p) => p.id.toLowerCase() === o.id.toLowerCase())) {
          mergedMovieOpts.push(o);
        }
      }
      mergedMovieOpts.sort((a, b) => (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0));

      return {
        qualityOptions: mergedMovieOpts,
        crossServerQualityOptions: otherOpts,
        seriesGlobalQualities: [] as string[],
      };
    }

    // For Series: Aggregate all available qualities across all episodes in the current season (on both Server 1 & Server 2)
    // so the top Pill Filter Bar always shows every quality that exists in the season (e.g. 1080p, 720p, 480p, 360p).
    const allQualitiesSet = new Set<string>();
    const activeServerMap = new Map<string, QualityOptionItem>();
    const otherServerMap = new Map<string, QualityOptionItem>();

    currentEpisodes.forEach((ep, idx) => {
      const isFocused = idx === focusedEpisodeIdx;
      const s1Map = getItemServerQualityMap(ep, 'server1', isFocused ? server1Meta : null);
      const s2Map = getItemServerQualityMap(ep, 'server2', isFocused ? server2Meta : null);

      for (const [qId, val] of s1Map.entries()) {
        allQualitiesSet.add(qId);
        const targetMap = isServer2 ? otherServerMap : activeServerMap;
        const existing = targetMap.get(qId);
        if (!existing || (val.sizeMb > 0 && existing.epSizeMb === 0)) {
          targetMap.set(qId, {
            id: qId,
            label: val.label,
            badge: val.badge,
            movieSizeMb: val.sizeMb,
            epSizeMb: val.sizeMb,
            bandwidth: val.bandwidth,
            url: val.url,
            isLive: true,
            serverSource: 'server1',
          });
        }
      }

      for (const [qId, val] of s2Map.entries()) {
        allQualitiesSet.add(qId);
        const targetMap = isServer2 ? activeServerMap : otherServerMap;
        const existing = targetMap.get(qId);
        if (!existing || (val.sizeMb > 0 && existing.epSizeMb === 0)) {
          targetMap.set(qId, {
            id: qId,
            label: val.label,
            badge: val.badge,
            movieSizeMb: val.sizeMb,
            epSizeMb: val.sizeMb,
            bandwidth: val.bandwidth,
            url: val.url,
            isLive: true,
            serverSource: 'server2',
          });
        }
      }
    });

    if (allQualitiesSet.size === 0) {
      ['1080p', '720p', '480p', '360p'].forEach((q) => allQualitiesSet.add(q));
    }

    const sortedGlobalQualities = Array.from(allQualitiesSet).sort(
      (a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0)
    );

    const activeOpts = Array.from(activeServerMap.values()).sort(
      (a, b) => (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0)
    );
    const otherOpts = Array.from(otherServerMap.values()).sort(
      (a, b) => (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0)
    );

    return {
      qualityOptions: activeOpts,
      crossServerQualityOptions: otherOpts,
      seriesGlobalQualities: sortedGlobalQualities,
    };
  }, [
    content,
    isSeries,
    isMovie,
    currentEpisodes,
    focusedEpisodeIdx,
    server1Meta,
    server2Meta,
    modalServer,
    hasServer1,
    hasServer2,
  ]);

  const [selectedQuality, setSelectedQuality] = useState<string>(() => {
    try {
      const savedDlQ = localStorage.getItem('maxplay_download_quality');
      if (savedDlQ && savedDlQ !== 'auto') return savedDlQ;
      const savedVidQ = localStorage.getItem('maxplay_video_quality');
      if (savedVidQ && savedVidQ !== 'auto') return savedVidQ;
    } catch {}
    if (isSeries && seriesGlobalQualities.length > 0) {
      return seriesGlobalQualities[0];
    }
    return qualityOptions[0]?.id || crossServerQualityOptions[0]?.id || '720p';
  });

  // Active quality ID (for Series, matches seriesGlobalQualities; for Movies, matches qualityOptions)
  const activeQualityId = useMemo(() => {
    if (isSeries) {
      const match = seriesGlobalQualities.find(
        (q) => q.toLowerCase() === selectedQuality.toLowerCase()
      );
      return match || seriesGlobalQualities[0] || '720p';
    }
    const match = qualityOptions.find((q) => q.id.toLowerCase() === selectedQuality.toLowerCase());
    return match?.id || qualityOptions[0]?.id || crossServerQualityOptions[0]?.id || '720p';
  }, [isSeries, seriesGlobalQualities, qualityOptions, crossServerQualityOptions, selectedQuality]);

  /**
   * 4. SMART PER-EPISODE RESOLUTION ENGINE (Scenarios A, B, and C):
   * Evaluates every episode in `currentEpisodes` against the user's global filter:
   * - `modalServer` ('server1' | 'server2')
   * - `activeQualityId` (e.g. '1080p')
   * - `selectedLanguage` (e.g. 'Hindi')
   *
   * Rules:
   * - Scenario A (Exact Match on Selected Server):
   *   Episode has `activeQualityId` on `modalServer` -> Downloads from `modalServer` at `activeQualityId`.
   * - Scenario B (Cross-Server Same-Quality Auto-Switch):
   *   Episode does NOT have `activeQualityId` on `modalServer`, BUT has `activeQualityId` on `otherServer` ->
   *   Automatically switches that episode to `otherServer` at `activeQualityId` (with `selectedLanguage`).
   * - Scenario C (Lower Quality Fallback + Red Confirmation Alert):
   *   Neither `Server 1` nor `Server 2` has `activeQualityId` for this episode ->
   *   Automatically selects the best available fallback quality (e.g. `720p` or `480p`), marks `isFallbackQuality = true`
   *   so the Confirmation Screen highlights it in RED with an inline "Unselect" button!
   */
  /**
   * Helper: Determines whether a given server (`server1` or `server2`) supports `targetLang` for `ep` (or Movie if `ep` is null).
   * Used so that if the user has Server 1 selected (which only has Hindi, English, Japanese) and chooses Tamil (which is on Server 2),
   * the download engine automatically switches to Server 2's quality link to download Tamil!
   */
  const getServerLanguageSupport = (
    ep: any | null,
    targetLang: string
  ): { s1HasLang: boolean; s2HasLang: boolean; shouldPreferOtherServer: (primarySrv: 'server1' | 'server2') => boolean } => {
    const cleanTarget = (targetLang || '').trim();
    const s1Langs: string[] = [];
    const s2Langs: string[] = [];

    const addNorm = (arr: string[], raw?: any) => {
      if (!raw) return;
      const str = typeof raw === 'string' ? raw : raw?.name || raw?.label || raw?.lang || '';
      if (!str || typeof str !== 'string') return;
      for (const part of str.split(/[,/|•+]+/).map((s) => s.trim()).filter(Boolean)) {
        if (isQualityKey(part)) continue;
        const norm = ClientHlsDownloader.normalizeLanguageLabel(part, part) || part;
        if (!norm || norm === 'Default' || norm === 'Default Audio' || norm.toLowerCase() === 'unknown' || isQualityKey(norm)) continue;
        if (!arr.some((x) => x.toLowerCase() === norm.toLowerCase())) {
          arr.push(norm);
        }
      }
    };

    const urls = extractUrlsFromItem(ep, !ep);
    const epPart0 =
      ep && Array.isArray(ep?.videoLinks) && ep.videoLinks.length > 0 && typeof ep.videoLinks[0] === 'object'
        ? ep.videoLinks[0]
        : null;
    const contentPart0 =
      Array.isArray((content as any)?.videoLinks) && (content as any).videoLinks.length > 0 && typeof (content as any).videoLinks[0] === 'object'
        ? (content as any).videoLinks[0]
        : null;

    // 1. Server 1 known audio tracks
    if (Array.isArray(server1Meta?.audioTracks)) {
      server1Meta!.audioTracks!.forEach((l) => addNorm(s1Langs, l));
    }
    if (urls.primaryUrl) {
      const c1 = SmartStreamService.getCachedStreamMeta(urls.primaryUrl);
      if (c1 && Array.isArray(c1.audioTracks)) c1.audioTracks.forEach((l) => addNorm(s1Langs, l));
    }
    if (s1Langs.length === 0) {
      const savedS1 = ep
        ? (ep as any)?.audioTracks || epPart0?.audioTracks
        : (content as any)?.audioTracks || contentPart0?.audioTracks;
      if (Array.isArray(savedS1)) savedS1.forEach((l: any) => addNorm(s1Langs, l));
    }
    const vSources1 = ep ? ep?.videoSources : content?.videoSources;
    if (vSources1 && typeof vSources1 === 'object') {
      Object.keys(vSources1).forEach((k) => addNorm(s1Langs, k));
    }

    // 2. Server 2 known audio tracks
    if (Array.isArray(server2Meta?.audioTracks)) {
      server2Meta!.audioTracks!.forEach((l) => addNorm(s2Langs, l));
    }
    if (urls.secondaryUrl) {
      const c2 = SmartStreamService.getCachedStreamMeta(urls.secondaryUrl);
      if (c2 && Array.isArray(c2.audioTracks)) c2.audioTracks.forEach((l) => addNorm(s2Langs, l));
    }
    if (s2Langs.length === 0) {
      const savedS2 = ep
        ? (ep as any)?.secondaryAudioTracks || epPart0?.secondaryAudioTracks
        : (content as any)?.secondaryAudioTracks || contentPart0?.secondaryAudioTracks;
      if (Array.isArray(savedS2)) savedS2.forEach((l: any) => addNorm(s2Langs, l));
    }
    const vSources2 = ep ? (ep as any)?.secondaryVideoSources : (content as any)?.secondaryVideoSources;
    if (vSources2 && typeof vSources2 === 'object') {
      Object.keys(vSources2).forEach((k) => addNorm(s2Langs, k));
    }

    // Cross-server attribution when one server's tracks are known and extra languages exist in availableLanguages
    if (s1Langs.length > 0 && s2Langs.length === 0) {
      availableLanguages.forEach((al) => {
        if (!s1Langs.some((s1) => s1.toLowerCase() === al.toLowerCase())) {
          addNorm(s2Langs, al);
        }
      });
    } else if (s2Langs.length > 0 && s1Langs.length === 0) {
      availableLanguages.forEach((al) => {
        if (!s2Langs.some((s2) => s2.toLowerCase() === al.toLowerCase())) {
          addNorm(s1Langs, al);
        }
      });
    }

    const matchesList = (list: string[]) =>
      list.some(
        (item) =>
          item.toLowerCase() === cleanTarget.toLowerCase() ||
          ClientHlsDownloader.matchesTargetLanguage({ name: item, language: item, friendly: item }, cleanTarget)
      );

    const inS1 = matchesList(s1Langs);
    const inS2 = matchesList(s2Langs);

    return {
      s1HasLang: inS1 || s1Langs.length === 0,
      s2HasLang: inS2 || s2Langs.length === 0,
      shouldPreferOtherServer: (primarySrv: 'server1' | 'server2') => {
        if (!cleanTarget) return false;
        if (primarySrv === 'server1') {
          // User has Server 1 selected, but selected language (e.g. Tamil) is NOT in Server 1 and IS in Server 2 (or Server 1 is known to lack it)
          return (!inS1 && s1Langs.length > 0 && (inS2 || s2Langs.length === 0)) || (!inS1 && inS2);
        } else {
          // User has Server 2 selected, but selected language is NOT in Server 2 and IS in Server 1
          return (!inS2 && s2Langs.length > 0 && (inS1 || s1Langs.length === 0)) || (!inS2 && inS1);
        }
      },
    };
  };

  /**
   * 4. SMART PER-EPISODE RESOLUTION ENGINE (Scenarios A, B, and C + Cross-Server Language Auto-Switch):
   */
  const episodeResolutionPlans = useMemo<EpisodeResolvedPlan[]>(() => {
    if (!isSeries) return [];
    const primarySrv: 'server1' | 'server2' = modalServer;
    const otherSrv: 'server1' | 'server2' = modalServer === 'server1' ? 'server2' : 'server1';
    const targetQ = activeQualityId;
    const targetQNum = parseInt(targetQ, 10) || 720;

    return currentEpisodes.map((ep, idx) => {
      const epNum = ep?.episodeNumber || idx + 1;
      const epTitle = ep?.title || `Episode ${epNum}`;
      const epId = ep?.id || `ep-${epNum}`;
      const isFocused = idx === focusedEpisodeIdx;

      const s1Map = getItemServerQualityMap(ep, 'server1', isFocused ? server1Meta : null);
      const s2Map = getItemServerQualityMap(ep, 'server2', isFocused ? server2Meta : null);
      const epUrls = extractUrlsFromItem(ep, false);

      const langSupport = getServerLanguageSupport(ep, selectedLanguage);
      const forceOtherForLang = langSupport.shouldPreferOtherServer(primarySrv);

      const effectiveFirstSrv: 'server1' | 'server2' = forceOtherForLang ? otherSrv : primarySrv;
      const effectiveSecondSrv: 'server1' | 'server2' = forceOtherForLang ? primarySrv : otherSrv;

      const firstMap = effectiveFirstSrv === 'server1' ? s1Map : s2Map;
      const secondMap = effectiveSecondSrv === 'server1' ? s1Map : s2Map;
      const firstSingleUrl = effectiveFirstSrv === 'server1' ? epUrls.primaryUrl : epUrls.secondaryUrl;
      const secondSingleUrl = effectiveSecondSrv === 'server1' ? epUrls.primaryUrl : epUrls.secondaryUrl;

      const findExactInMap = (
        m: Map<string, { id: string; url: string; sizeMb: number; bandwidth: number; label: string; badge: string }>,
        qKey: string
      ) => {
        if (m.has(qKey)) return m.get(qKey)!;
        for (const [k, v] of m.entries()) {
          if (k.toLowerCase() === qKey.toLowerCase()) return v;
        }
        return null;
      };

      const pickBestFallbackFromMap = (
        m: Map<string, { id: string; url: string; sizeMb: number; bandwidth: number; label: string; badge: string }>
      ) => {
        const list = Array.from(m.values()).sort(
          (a, b) => (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0)
        );
        if (list.length === 0) return null;
        // Prefer highest quality below targetQNum (e.g. if 1080p requested, pick 720p -> 480p -> 360p)
        const lowerList = list.filter((item) => (parseInt(item.id, 10) || 0) < targetQNum);
        return lowerList[0] || list[0];
      };

      // Case 1: Exact quality match on the effective preferred server (either user's server, or auto-switched server for language!)
      const exactFirst = findExactInMap(firstMap, targetQ);
      if (exactFirst) {
        const exactBackup = findExactInMap(secondMap, targetQ) || pickBestFallbackFromMap(secondMap);
        const isAutoSwitched = effectiveFirstSrv !== primarySrv;
        return {
          epIndex: idx,
          epNumber: epNum,
          epTitle,
          epId,
          requestedQuality: targetQ,
          resolvedQuality: exactFirst.id,
          resolvedServer: effectiveFirstSrv,
          language: selectedLanguage,
          targetUrl: exactFirst.url,
          backupUrl:
            exactBackup?.url && exactBackup.url !== exactFirst.url ? exactBackup.url : undefined,
          sizeMb: exactFirst.sizeMb,
          status: isAutoSwitched ? 'cross_server_exact' : 'exact',
          isFallbackQuality: false,
          isCrossServerAuto: isAutoSwitched,
        };
      }

      // Case 2: Exact quality match is on the second server
      const exactSecond = findExactInMap(secondMap, targetQ);
      if (exactSecond) {
        const fallbackFirst = pickBestFallbackFromMap(firstMap);
        const isAutoSwitched = effectiveSecondSrv !== primarySrv;
        return {
          epIndex: idx,
          epNumber: epNum,
          epTitle,
          epId,
          requestedQuality: targetQ,
          resolvedQuality: exactSecond.id,
          resolvedServer: effectiveSecondSrv,
          language: selectedLanguage,
          targetUrl: exactSecond.url,
          backupUrl:
            fallbackFirst?.url && fallbackFirst.url !== exactSecond.url
              ? fallbackFirst.url
              : undefined,
          sizeMb: exactSecond.sizeMb,
          status: isAutoSwitched ? 'cross_server_exact' : 'exact',
          isFallbackQuality: false,
          isCrossServerAuto: isAutoSwitched,
        };
      }

      // Case 3: Neither Server 1 nor Server 2 has `targetQ` in explicit quality maps.
      const fallbackFirst = pickBestFallbackFromMap(firstMap);
      const fallbackSecond = pickBestFallbackFromMap(secondMap);

      if (fallbackFirst || fallbackSecond) {
        const chosen = fallbackFirst || fallbackSecond!;
        const chosenServer: 'server1' | 'server2' = fallbackFirst ? effectiveFirstSrv : effectiveSecondSrv;
        const backupCandidate = fallbackFirst ? fallbackSecond : fallbackFirst;

        return {
          epIndex: idx,
          epNumber: epNum,
          epTitle,
          epId,
          requestedQuality: targetQ,
          resolvedQuality: chosen.id,
          resolvedServer: chosenServer,
          language: selectedLanguage,
          targetUrl: chosen.url,
          backupUrl:
            backupCandidate?.url && backupCandidate.url !== chosen.url
              ? backupCandidate.url
              : undefined,
          sizeMb: chosen.sizeMb,
          status: 'fallback_quality',
          isFallbackQuality: chosen.id.toLowerCase() !== targetQ.toLowerCase(),
          isCrossServerAuto: chosenServer !== primarySrv,
        };
      }

      // Case 4: Legacy single-URL episode (no explicit qualityLinks map configured)
      if (firstSingleUrl || secondSingleUrl) {
        const useFirst = Boolean(firstSingleUrl);
        const resolvedSrv = useFirst ? effectiveFirstSrv : effectiveSecondSrv;
        const tUrl = useFirst ? firstSingleUrl : secondSingleUrl;
        const bUrl = useFirst ? secondSingleUrl : firstSingleUrl;
        const isAutoSwitched = resolvedSrv !== primarySrv;
        return {
          epIndex: idx,
          epNumber: epNum,
          epTitle,
          epId,
          requestedQuality: targetQ,
          resolvedQuality: targetQ,
          resolvedServer: resolvedSrv,
          language: selectedLanguage,
          targetUrl: tUrl,
          backupUrl: bUrl && bUrl !== tUrl ? bUrl : undefined,
          sizeMb: 0,
          status: isAutoSwitched ? 'cross_server_exact' : 'exact',
          isFallbackQuality: false,
          isCrossServerAuto: isAutoSwitched,
        };
      }

      return {
        epIndex: idx,
        epNumber: epNum,
        epTitle,
        epId,
        requestedQuality: targetQ,
        resolvedQuality: targetQ,
        resolvedServer: primarySrv,
        language: selectedLanguage,
        targetUrl: '',
        sizeMb: 0,
        status: 'unavailable',
        isFallbackQuality: false,
        isCrossServerAuto: false,
      };
    });
  }, [
    isSeries,
    currentEpisodes,
    modalServer,
    activeQualityId,
    selectedLanguage,
    focusedEpisodeIdx,
    server1Meta,
    server2Meta,
    availableLanguages,
  ]);

  // Toggle an episode in the vertical list (0ms instant, no network re-probing!)
  const toggleEpisode = (idx: number) => {
    setSelectedEpIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        if (next.size > 1) next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  // Unselect an episode directly from the Confirmation Screen (e.g. when user sees Red fallback warning)
  const unselectEpisodeFromConfirmation = (idx: number) => {
    setSelectedEpIndices((prev) => {
      const next = new Set(prev);
      next.delete(idx);
      if (next.size === 0) {
        setShowSummaryReview(false);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedEpIndices.size === currentEpisodes.length) {
      setSelectedEpIndices(new Set([0]));
    } else {
      setSelectedEpIndices(new Set(currentEpisodes.map((_, i) => i)));
    }
  };

  // Check if content or episodes support HLS mode
  const isHlsMode = useMemo(() => {
    if (content.isSmartHls) return true;
    const isHlsLink = (u?: string) =>
      Boolean(
        u &&
          (u.includes('.m3u8') ||
            u.includes('m3u8') ||
            SmartStreamService.isExtractableSource(u, true))
      );
    if (isHlsLink(primaryUrl) || isHlsLink(secondaryUrl)) return true;
    if (isHlsLink(content.videoUrl) || isHlsLink(content.secondaryVideoUrl)) return true;
    if (
      currentEpisodes.some((ep) => {
        const urls = extractUrlsFromItem(ep, false);
        return ep.isSmartHls || isHlsLink(urls.primaryUrl) || isHlsLink(urls.secondaryUrl);
      })
    ) {
      return true;
    }
    return false;
  }, [content, currentEpisodes, primaryUrl, secondaryUrl]);

  // Movie download URL resolver (with automatic cross-server quality & language routing!)
  const resolveMoviePlan = (
    activeQuality: string,
    userServer: 'server1' | 'server2',
    targetLang: string
  ): { targetVideoUrl: string; backupVideoUrl?: string; resolvedServer: 'server1' | 'server2' } => {
    const otherServer: 'server1' | 'server2' = userServer === 'server1' ? 'server2' : 'server1';
    const langSupport = getServerLanguageSupport(null, targetLang);
    const preferOtherForLang = langSupport.shouldPreferOtherServer(userServer);

    const firstServer: 'server1' | 'server2' = preferOtherForLang ? otherServer : userServer;
    const secondServer: 'server1' | 'server2' = preferOtherForLang ? userServer : otherServer;

    const firstMap = getItemServerQualityMap(null, firstServer, firstServer === 'server2' ? server2Meta : server1Meta);
    const secondMap = getItemServerQualityMap(null, secondServer, secondServer === 'server2' ? server2Meta : server1Meta);
    const urls = extractUrlsFromItem(null, true);
    const firstSingle = firstServer === 'server2' ? urls.secondaryUrl : urls.primaryUrl;
    const secondSingle = secondServer === 'server2' ? urls.secondaryUrl : urls.primaryUrl;

    const findExact = (m: Map<string, { url: string }>, q: string) => {
      for (const [k, v] of m.entries()) {
        if (k.toLowerCase() === q.toLowerCase() && v.url) return v.url;
      }
      return '';
    };

    const exactFirst = findExact(firstMap, activeQuality);
    const exactSecond = findExact(secondMap, activeQuality);

    // 1. Preferred server (accounting for language) has the requested quality
    if (exactFirst) {
      const backup = exactSecond || Array.from(secondMap.values())[0]?.url || secondSingle;
      return {
        targetVideoUrl: exactFirst,
        backupVideoUrl: backup && backup !== exactFirst ? backup : undefined,
        resolvedServer: firstServer,
      };
    }

    // 2. Second server has the requested quality (e.g. user selected 1080p which only exists on Server 2)
    if (exactSecond) {
      const backup = Array.from(firstMap.values())[0]?.url || firstSingle;
      return {
        targetVideoUrl: exactSecond,
        backupVideoUrl: backup && backup !== exactSecond ? backup : undefined,
        resolvedServer: secondServer,
      };
    }

    // 3. Fallback to first available entry or single URL on preferred server
    const fallbackFirst = Array.from(firstMap.values())[0]?.url || firstSingle;
    const fallbackSecond = Array.from(secondMap.values())[0]?.url || secondSingle;
    if (fallbackFirst) {
      return {
        targetVideoUrl: fallbackFirst,
        backupVideoUrl: fallbackSecond && fallbackSecond !== fallbackFirst ? fallbackSecond : undefined,
        resolvedServer: firstServer,
      };
    }

    return {
      targetVideoUrl: fallbackSecond || '',
      backupVideoUrl: undefined,
      resolvedServer: secondServer,
    };
  };

  const activeQualityObj =
    qualityOptions.find((q) => q.id.toLowerCase() === activeQualityId.toLowerCase()) ||
    qualityOptions[0] || {
      id: activeQualityId,
      label: `${activeQualityId}`,
      badge: 'HLS Stream',
      movieSizeMb: 0,
      epSizeMb: 0,
      bandwidth: 0,
      isLive: false,
    };

  const totalEstimatedMb = useMemo(() => {
    if (isMovie) {
      return Math.max(0, Number(activeQualityObj.movieSizeMb || 0));
    }
    let sum = 0;
    selectedEpIndices.forEach((idx) => {
      const plan = episodeResolutionPlans[idx];
      if (plan && plan.sizeMb > 0) {
        sum += plan.sizeMb;
      }
    });
    return Math.max(0, sum);
  }, [isMovie, activeQualityObj, selectedEpIndices, episodeResolutionPlans]);

  // Count how many selected episodes had to fall back to a lower quality or auto-switch servers
  const selectedPlansSummary = useMemo(() => {
    const sorted = Array.from(selectedEpIndices)
      .map(Number)
      .sort((a, b) => a - b)
      .map((idx) => episodeResolutionPlans[idx])
      .filter(Boolean);

    const fallbackCount = sorted.filter((p) => p.isFallbackQuality).length;
    const crossServerCount = sorted.filter((p) => p.isCrossServerAuto && !p.isFallbackQuality).length;
    return { sorted, fallbackCount, crossServerCount };
  }, [selectedEpIndices, episodeResolutionPlans]);

  const handleStartDownload = () => {
    if (!isHlsMode) {
      if (onSuccessToast) onSuccessToast('Download is only available for HLS Mode content.');
      return;
    }

    if (isMovie) {
      const moviePlan = resolveMoviePlan(activeQualityId, modalServer, selectedLanguage);
      const targetVideoUrl = moviePlan.targetVideoUrl;
      const backupVideoUrl = moviePlan.backupVideoUrl;
      if (!targetVideoUrl) {
        if (onSuccessToast) onSuccessToast('Offline download is only available for HLS Mode streams.');
        return;
      }
      const estBytes = totalEstimatedMb * 1024 * 1024;

      try {
        localStorage.setItem('maxplay_download_quality', activeQualityId);
      } catch {}

      downloadManager.addTask({
        contentId: content.id,
        title: content.title,
        posterUrl: content.posterUrl || content.backdropUrl || '',
        quality: activeQualityId,
        language: selectedLanguage,
        videoUrl: targetVideoUrl,
        secondaryVideoUrl:
          backupVideoUrl && backupVideoUrl !== targetVideoUrl ? backupVideoUrl : undefined,
        selectedServer: moviePlan.resolvedServer,
        estimatedBytes: estBytes,
      });

      if (onSuccessToast) {
        onSuccessToast(
          `Added "${content.title}" (${selectedLanguage} • ${activeQualityId.toUpperCase()}) to Downloads!`
        );
      }
    } else {
      // Queue each selected episode using its exact resolved plan (strictly isolated per episode!)
      let queuedCount = 0;
      try {
        localStorage.setItem('maxplay_download_quality', activeQualityId);
      } catch {}

      selectedPlansSummary.sorted.forEach((plan) => {
        if (!plan || !plan.targetUrl) return;
        const estBytes = (plan.sizeMb > 0 ? plan.sizeMb : 180) * 1024 * 1024;

        downloadManager.addTask({
          contentId: content.id,
          episodeId: plan.epId,
          seasonIndex: selectedSeasonIdx,
          episodeIndex: plan.epIndex,
          title: content.title,
          episodeTitle: plan.epTitle,
          posterUrl: content.posterUrl || content.backdropUrl || '',
          quality: plan.resolvedQuality,
          language: plan.language,
          videoUrl: plan.targetUrl,
          secondaryVideoUrl:
            plan.backupUrl && plan.backupUrl !== plan.targetUrl ? plan.backupUrl : undefined,
          selectedServer: plan.resolvedServer,
          estimatedBytes: estBytes,
        });
        queuedCount++;
      });

      if (queuedCount === 0) {
        if (onSuccessToast) onSuccessToast('No valid HLS streams found for selected episodes.');
        return;
      }

      if (onSuccessToast) {
        onSuccessToast(
          queuedCount === 1
            ? `Started downloading Episode (${selectedLanguage} • ${selectedPlansSummary.sorted[0].resolvedQuality.toUpperCase()})!`
            : `Queued ${queuedCount} episodes in ${selectedLanguage} (1-by-1 Smart Queue)!`
        );
      }
    }

    setShowSummaryReview(false);
    onClose();
  };

  const [openResourceDropdown, setOpenResourceDropdown] = useState<'language' | 'season' | 'server' | null>(null);

  const formatEpDuration = (rawVal?: any, epIdx?: number) => {
    // 1. If already a formatted string like "24:15" or "1:45:20", return or parse it
    if (typeof rawVal === 'string' && rawVal.trim().includes(':')) {
      return rawVal.trim();
    }
    let parsedSec = Number(rawVal) || 0;
    if (typeof rawVal === 'string' && !parsedSec) {
      const hrMatch = rawVal.match(/(\d+)\s*h/i);
      const minMatch = rawVal.match(/(\d+)\s*m/i);
      if (hrMatch || minMatch) {
        parsedSec = (hrMatch ? parseInt(hrMatch[1], 10) * 3600 : 0) + (minMatch ? parseInt(minMatch[1], 10) * 60 : 0);
      }
    }

    // 2. Fallback to live probed HLS duration or active video player stream duration
    if (parsedSec <= 10) {
      const liveProbedDur =
        (modalServer === 'server2'
          ? Number(server2Meta?.duration || server1Meta?.duration)
          : Number(server1Meta?.duration || server2Meta?.duration)) || 0;

      if (isMovie) {
        parsedSec = liveProbedDur || Number(activeStreamDuration) || Number(content.duration) || 0;
      } else {
        if (epIdx === undefined || epIdx === focusedEpisodeIdx) {
          parsedSec = liveProbedDur || Number(activeStreamDuration) || Number(content.duration) || 0;
        } else {
          parsedSec = liveProbedDur || Number(activeStreamDuration) || Number(content.duration) || 0;
        }
      }
    }

    // 3. Final fallback if stream hasn't reported duration yet
    const sec = parsedSec > 10 ? parsedSec : isMovie ? 7100 : 1440;
    const totalSec = Math.round(sec);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const remSec = totalSec % 60;
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${remSec.toString().padStart(2, '0')}`;
    }
    return `${mins}:${remSec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-x-0 bottom-0 top-[min(56.25vw,42vh)] z-50 flex flex-col justify-end overflow-hidden">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: 0.16 } }}
        exit={{ opacity: 0, transition: { duration: 0.14 } }}
        onClick={onClose}
        className="fixed inset-x-0 bottom-0 top-[min(56.25vw,42vh)] bg-black/65"
        style={{ willChange: 'opacity', transform: 'translateZ(0)' }}
      />
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0, transition: { type: 'tween', ease: [0.22, 1, 0.36, 1], duration: 0.22 } }}
        exit={{ y: '100%', transition: { type: 'tween', ease: [0.4, 0, 1, 1], duration: 0.16 } }}
        onClick={(e) => e.stopPropagation()}
        style={{ willChange: 'transform', transform: 'translate3d(0,0,0)' }}
        className="relative z-10 flex flex-col w-full h-full bg-[#101116] border-t border-white/10 rounded-t-2xl shadow-[0_-12px_40px_rgba(0,0,0,0.9)] overflow-hidden select-none text-left"
      >
        {/* TOP HEADER: "Download" on left, "X" on right */}
        <div className="flex items-center justify-between px-4 py-3.5 shrink-0">
          <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">
            {showSummaryReview ? 'Confirm Download' : 'Download'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* HLS Mode Requirement Banner if content has no HLS stream */}
        {!isHlsMode && (
          <div className="mx-4 mb-2 flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200 shrink-0">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
            <div>
              <p className="font-bold text-amber-300">HLS Mode Stream Required</p>
              <p className="text-[11px] text-zinc-300 mt-0.5">
                Offline download is exclusively configured for HLS Mode streams.
              </p>
            </div>
          </div>
        )}

        {/* SUMMARY REVIEW SCREEN (Shown if fallback warnings exist or user confirms queue) */}
        {showSummaryReview ? (
          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3.5 scrollbar-thin">
            <div className="p-3.5 rounded-xl bg-[#1a1b22] border border-white/10">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-purple-300 uppercase tracking-wide">
                  Selected Configuration
                </span>
                <span className="text-[11px] font-extrabold text-emerald-400">
                  {totalEstimatedMb > 0
                    ? `Total: ${
                        totalEstimatedMb >= 1000
                          ? `${(totalEstimatedMb / 1024).toFixed(2)} GB`
                          : `${totalEstimatedMb} MB`
                      }`
                    : 'Verified HLS Stream'}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2 mt-2">
                <span
                  className={`px-2.5 py-1 rounded-lg text-xs font-extrabold border ${
                    modalServer === 'server2'
                      ? 'bg-gradient-to-r from-[#F59E0B] to-[#D97706] text-black border-amber-300/60'
                      : 'bg-gradient-to-r from-[#8B5CF6] to-[#6D28D9] text-white border-purple-400/50'
                  }`}
                >
                  {modalServer === 'server2' ? 'Server 2' : 'Server 1'}
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-sky-500/15 border border-sky-500/30 text-xs font-bold text-sky-300">
                  {selectedLanguage}
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-xs font-bold text-emerald-300">
                  {activeQualityId.toUpperCase()}
                </span>
              </div>
            </div>

            {selectedPlansSummary.fallbackCount > 0 && (
              <div className="p-3 rounded-xl bg-red-500/15 border border-red-500/50 flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                <div className="text-xs text-red-200 leading-relaxed">
                  <span className="font-extrabold text-red-300 block">
                    Quality Notice ({selectedPlansSummary.fallbackCount} Episode
                    {selectedPlansSummary.fallbackCount > 1 ? 's' : ''})
                  </span>
                  Selected quality{' '}
                  <span className="font-extrabold text-white underline">
                    {activeQualityId.toUpperCase()}
                  </span>{' '}
                  was unavailable for the highlighted episode(s), so the best available quality was automatically selected.
                </div>
              </div>
            )}

            <div className="space-y-2">
              {selectedPlansSummary.sorted.map((plan) => {
                const isRedWarning = plan.isFallbackQuality;
                return (
                  <div
                    key={plan.epId || plan.epIndex}
                    className={`flex items-center justify-between gap-2 p-3 rounded-xl border ${
                      isRedWarning
                        ? 'bg-red-950/30 border-red-500/60'
                        : 'bg-[#181920] border-white/10'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-white truncate">
                        S{(selectedSeasonIdx + 1).toString().padStart(2, '0')} E{plan.epNumber.toString().padStart(2, '0')} • {plan.epTitle}
                      </div>
                      <div className="text-xs text-zinc-400 mt-0.5">
                        {plan.resolvedQuality.toUpperCase()} • {plan.language} • {plan.resolvedServer === 'server2' ? 'Server 2' : 'Server 1'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => unselectEpisodeFromConfirmation(plan.epIndex)}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-white/5 hover:bg-red-500/20 text-zinc-300 hover:text-red-300 border border-white/10 cursor-pointer shrink-0"
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          /* MAIN DOWNLOAD PANEL MATCHING REFERENCE IMAGE */
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* RESOURCES CARD */}
            <div className="mx-4 mb-2 p-3.5 rounded-xl bg-[#1a1b22] border border-white/5 shrink-0">
              {/* Resources Header */}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[15px] font-bold text-white">Resources</span>
                <span className="text-xs text-zinc-400 truncate">
                  Uploaded by {content.uploader?.name || 'MaxPlay Admin'}
                </span>
                <HelpCircle className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
              </div>

              {/* Selector Boxes Row: Language | Season (Series only) | Server */}
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar scrollbar-none">
                {/* 1. Language Selector Box */}
                <button
                  type="button"
                  onClick={() =>
                    setOpenResourceDropdown((prev) => (prev === 'language' ? null : 'language'))
                  }
                  className={`shrink-0 inline-flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition cursor-pointer ${
                    openResourceDropdown === 'language'
                      ? 'bg-[#232530] border-[#8B5CF6] text-white'
                      : 'bg-[#14151b] border-white/15 text-zinc-200 hover:border-white/30'
                  }`}
                >
                  <span>{selectedLanguage}</span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-zinc-400 transition-transform ${
                      openResourceDropdown === 'language' ? 'rotate-180 text-white' : ''
                    }`}
                  />
                </button>

                {/* 2. Season Selector Box (Series ONLY, hidden for Movies) */}
                {isSeries && (
                  <button
                    type="button"
                    onClick={() =>
                      setOpenResourceDropdown((prev) => (prev === 'season' ? null : 'season'))
                    }
                    className={`shrink-0 inline-flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition cursor-pointer ${
                      openResourceDropdown === 'season'
                        ? 'bg-[#232530] border-[#8B5CF6] text-white'
                        : 'bg-[#14151b] border-white/15 text-zinc-200 hover:border-white/30'
                    }`}
                  >
                    <span>
                      {seasonsData[selectedSeasonIdx]?.title ||
                        `Season ${(selectedSeasonIdx + 1).toString().padStart(2, '0')}`}
                    </span>
                    <ChevronDown
                      className={`w-3.5 h-3.5 text-zinc-400 transition-transform ${
                        openResourceDropdown === 'season' ? 'rotate-180 text-white' : ''
                      }`}
                    />
                  </button>
                )}

                {/* 3. Server Selector Box (Dedicated Purple for Server 1, Gold for Server 2) */}
                <button
                  type="button"
                  onClick={() =>
                    setOpenResourceDropdown((prev) => (prev === 'server' ? null : 'server'))
                  }
                  className={`shrink-0 inline-flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border text-xs font-extrabold transition cursor-pointer ${
                    modalServer === 'server2'
                      ? 'bg-gradient-to-r from-[#F59E0B] to-[#D97706] border-amber-300/60 text-black shadow-sm shadow-amber-950/40'
                      : 'bg-gradient-to-r from-[#8B5CF6] to-[#6D28D9] border-purple-400/50 text-white shadow-sm shadow-purple-950/40'
                  }`}
                >
                  <span>{modalServer === 'server2' ? 'Server 2' : 'Server 1'}</span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 transition-transform ${
                      modalServer === 'server2' ? 'text-black' : 'text-white'
                    } ${openResourceDropdown === 'server' ? 'rotate-180' : ''}`}
                  />
                </button>
              </div>

              {/* Inline Expandable Dropdown Options when Language, Season, or Server box is clicked */}
              {openResourceDropdown === 'language' && (
                <div className="mt-2.5 pt-2.5 border-t border-white/10 flex flex-wrap gap-1.5 animate-in fade-in duration-150">
                  {availableLanguages.map((lang) => {
                    const isSelected = selectedLanguage.toLowerCase() === lang.toLowerCase();
                    return (
                      <button
                        key={lang}
                        type="button"
                        onClick={() => {
                          setSelectedLanguage(lang);
                          setOpenResourceDropdown(null);
                        }}
                        className={`px-3 py-1 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                          isSelected
                            ? 'bg-[#8B5CF6]/25 border-[#8B5CF6] text-white'
                            : 'bg-[#14151b] border-white/10 text-zinc-400 hover:text-white'
                        }`}
                      >
                        {lang}
                      </button>
                    );
                  })}
                </div>
              )}

              {openResourceDropdown === 'season' && isSeries && (
                <div className="mt-2.5 pt-2.5 border-t border-white/10 flex flex-wrap gap-1.5 animate-in fade-in duration-150">
                  {seasonsData.map((season, sIdx) => {
                    const isSelected = selectedSeasonIdx === sIdx;
                    return (
                      <button
                        key={season.id || sIdx}
                        type="button"
                        onClick={() => {
                          handleSelectSeason(sIdx);
                          setOpenResourceDropdown(null);
                        }}
                        className={`px-3 py-1 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                          isSelected
                            ? 'bg-[#8B5CF6]/25 border-[#8B5CF6] text-white'
                            : 'bg-[#14151b] border-white/10 text-zinc-400 hover:text-white'
                        }`}
                      >
                        {season.title || `Season ${(sIdx + 1).toString().padStart(2, '0')}`}
                      </button>
                    );
                  })}
                </div>
              )}

              {openResourceDropdown === 'server' && (
                <div className="mt-2.5 pt-2.5 border-t border-white/10 flex flex-wrap gap-2 animate-in fade-in duration-150">
                  <button
                    type="button"
                    disabled={!hasServer1}
                    onClick={() => {
                      setModalServer('server1');
                      setOpenResourceDropdown(null);
                    }}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-extrabold border transition cursor-pointer ${
                      modalServer === 'server1'
                        ? 'bg-gradient-to-r from-[#8B5CF6] to-[#6D28D9] border-purple-300 text-white ring-2 ring-purple-400/50 shadow-md'
                        : hasServer1
                        ? 'bg-gradient-to-r from-[#8B5CF6]/25 to-[#6D28D9]/25 border-purple-500/40 text-purple-200 hover:brightness-110'
                        : 'bg-[#14151b] border-white/5 text-zinc-600 cursor-not-allowed'
                    }`}
                  >
                    Server 1
                  </button>
                  <button
                    type="button"
                    disabled={!hasServer2}
                    onClick={() => {
                      setModalServer('server2');
                      setOpenResourceDropdown(null);
                    }}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-extrabold border transition cursor-pointer ${
                      modalServer === 'server2'
                        ? 'bg-gradient-to-r from-[#F59E0B] to-[#D97706] border-amber-300 text-black ring-2 ring-amber-400/50 shadow-md'
                        : hasServer2
                        ? 'bg-gradient-to-r from-[#F59E0B]/25 to-[#D97706]/25 border-amber-500/40 text-amber-200 hover:brightness-110'
                        : 'bg-[#14151b] border-white/5 text-zinc-600 cursor-not-allowed'
                    }`}
                  >
                    Server 2
                  </button>
                </div>
              )}

              {/* Subtle Divider */}
              <div className="border-t border-white/10 my-3" />

              {/* Quality Pills Row (e.g. 480P, 720P, 1080P) */}
              <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar scrollbar-none">
                {(isSeries
                  ? seriesGlobalQualities
                  : qualityOptions.length > 0
                  ? qualityOptions.map((q) => q.id)
                  : ['480p', '720p', '1080p']
                ).map((qId) => {
                  const isSelected = activeQualityId.toLowerCase() === qId.toLowerCase();
                  const is1080 = qId.toLowerCase().includes('1080');
                  return (
                    <button
                      key={qId}
                      type="button"
                      onClick={() => setSelectedQuality(qId)}
                      className={`min-w-[82px] py-1.5 px-3.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer border ${
                        isSelected
                          ? is1080
                            ? 'bg-[#423321] border-[#f59e0b]/60 text-[#fde68a] shadow-sm'
                            : 'bg-[#2a2438] border-[#A855F7] text-white shadow-sm'
                          : is1080
                          ? 'bg-[#2b241d] border-transparent text-[#e5c185]/80 hover:text-[#fde68a]'
                          : 'bg-[#252630] border-transparent text-zinc-300 hover:text-white'
                      }`}
                    >
                      {is1080 && <Crown className="w-3.5 h-3.5 fill-[#f5bf60] text-[#f5bf60] shrink-0" />}
                      <span>{qId.toUpperCase()}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* SCROLLABLE EPISODE / MOVIE ITEM LIST */}
            <div className="flex-1 overflow-y-auto px-4 py-1 divide-y divide-white/[0.04] scrollbar-thin">
              {isSeries ? (
                episodeResolutionPlans.map((plan) => {
                  const isSelected = selectedEpIndices.has(plan.epIndex);
                  const epObj = currentEpisodes[plan.epIndex];
                  const epRawDur =
                    epObj?.duration ||
                    (Array.isArray(epObj?.videoLinks) && epObj.videoLinks[0]?.duration) ||
                    (epObj as any)?.runtime;
                  const durationStr = formatEpDuration(epRawDur, plan.epIndex);
                  const sizeStr =
                    plan.sizeMb > 0
                      ? plan.sizeMb >= 1000
                        ? `${(plan.sizeMb / 1024).toFixed(2)}GB`
                        : `${plan.sizeMb.toFixed(1)}MB`
                      : '168.3MB';

                  return (
                    <button
                      key={plan.epId || plan.epIndex}
                      type="button"
                      onClick={() => toggleEpisode(plan.epIndex)}
                      className="w-full py-3.5 flex items-center gap-3.5 text-left transition cursor-pointer group hover:bg-white/[0.02]"
                    >
                      {/* Left Circular Radio / Checkbox */}
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${
                          isSelected
                            ? 'border-[#A855F7] bg-[#8B5CF6] text-white shadow-[0_0_8px_rgba(139,92,246,0.5)]'
                            : 'border-zinc-500 bg-transparent group-hover:border-zinc-300'
                        }`}
                      >
                        {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                      </div>

                      {/* Episode Code + Size & Duration */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[15px] font-medium text-white tracking-tight">
                            S{(selectedSeasonIdx + 1).toString().padStart(2, '0')} E
                            {plan.epNumber.toString().padStart(2, '0')}
                          </span>
                          {plan.isFallbackQuality && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                              {plan.resolvedQuality.toUpperCase()}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-zinc-400 mt-0.5 font-normal">
                          <span>{sizeStr}</span>
                          <span className="text-zinc-600">|</span>
                          <span>{durationStr}</span>
                        </div>
                      </div>
                    </button>
                  );
                })
              ) : (
                /* MOVIE MODE: List movie quality rows in the exact same clean style */
                (qualityOptions.length > 0
                  ? qualityOptions
                  : [
                      {
                        id: activeQualityId || '1080p',
                        label: (activeQualityId || '1080p').toUpperCase(),
                        badge: 'Full HD',
                        movieSizeMb: totalEstimatedMb || 850,
                        epSizeMb: 0,
                        bandwidth: 0,
                        url: '',
                        isLive: true,
                        serverSource: modalServer,
                      },
                    ]
                ).map((q) => {
                  const isSelected = activeQualityId.toLowerCase() === q.id.toLowerCase();
                  const sizeStr =
                    q.movieSizeMb > 0
                      ? q.movieSizeMb >= 1000
                        ? `${(q.movieSizeMb / 1024).toFixed(2)}GB`
                        : `${q.movieSizeMb.toFixed(1)}MB`
                      : '920.5MB';
                  const movieRawDur =
                    content.duration ||
                    (Array.isArray((content as any)?.videoLinks) && (content as any).videoLinks[0]?.duration) ||
                    (content as any)?.runtime;
                  const durationStr = formatEpDuration(movieRawDur);

                  return (
                    <button
                      key={`${modalServer}-${q.id}`}
                      type="button"
                      onClick={() => setSelectedQuality(q.id)}
                      className="w-full py-3.5 flex items-center gap-3.5 text-left transition cursor-pointer group hover:bg-white/[0.02]"
                    >
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${
                          isSelected
                            ? 'border-[#A855F7] bg-[#8B5CF6] text-white shadow-[0_0_8px_rgba(139,92,246,0.5)]'
                            : 'border-zinc-500 bg-transparent group-hover:border-zinc-300'
                        }`}
                      >
                        {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[15px] font-medium text-white truncate">
                            {content.title} ({q.id.toUpperCase()})
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-zinc-400 mt-0.5 font-normal">
                          <span>{sizeStr}</span>
                          <span className="text-zinc-600">|</span>
                          <span>{durationStr}</span>
                          <span className="text-zinc-600">|</span>
                          <span>{selectedLanguage}</span>
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* STICKY BOTTOM BAR: "Select All" on Left + MaxPlay Purple Gradient "Download" Button on Right */}
        <div className="px-4 py-3 border-t border-white/10 bg-[#101116] flex items-center justify-between gap-4 shrink-0">
          {showSummaryReview ? (
            <>
              <button
                type="button"
                onClick={() => setShowSummaryReview(false)}
                className="px-4 py-2.5 rounded-xl bg-white/10 text-xs sm:text-sm font-bold text-white hover:bg-white/15 transition cursor-pointer"
              >
                Back
              </button>
              <button
                type="button"
                disabled={isSeries && selectedPlansSummary.sorted.length === 0}
                onClick={handleStartDownload}
                className="flex-1 max-w-[260px] py-2.5 px-6 rounded-xl bg-gradient-to-r from-[#A855F7] via-[#8B5CF6] to-[#6366F1] text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-purple-900/40 hover:opacity-95 active:scale-95 transition cursor-pointer disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                <span>Download</span>
              </button>
            </>
          ) : (
            <>
              {isSeries ? (
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  className="flex items-center gap-2.5 py-1 text-left cursor-pointer group"
                >
                  <div
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                      selectedEpIndices.size === currentEpisodes.length && currentEpisodes.length > 0
                        ? 'border-[#A855F7] bg-[#8B5CF6] text-white'
                        : 'border-zinc-500 bg-transparent group-hover:border-zinc-300'
                    }`}
                  >
                    {selectedEpIndices.size === currentEpisodes.length && currentEpisodes.length > 0 && (
                      <Check className="w-3 h-3 stroke-[3]" />
                    )}
                  </div>
                  <span className="text-sm font-medium text-zinc-200 group-hover:text-white">
                    Select All
                  </span>
                </button>
              ) : (
                <div className="flex items-center gap-2 text-xs text-zinc-300 font-medium">
                  <div className="w-5 h-5 rounded-full border-2 border-[#A855F7] bg-[#8B5CF6] text-white flex items-center justify-center">
                    <Check className="w-3 h-3 stroke-[3]" />
                  </div>
                  <span>{activeQualityId.toUpperCase()} Selected</span>
                </div>
              )}

              <button
                type="button"
                disabled={!isHlsMode || (isSeries && selectedEpIndices.size === 0)}
                onClick={() => {
                  if (!isHlsMode) return;
                  if (isMovie) {
                    handleStartDownload();
                  } else if (selectedPlansSummary.fallbackCount > 0) {
                    setShowSummaryReview(true);
                  } else {
                    handleStartDownload();
                  }
                }}
                className={`flex-1 max-w-[240px] sm:max-w-[260px] py-2.5 px-6 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition ${
                  isHlsMode && (!isSeries || selectedEpIndices.size > 0)
                    ? 'bg-gradient-to-r from-[#A855F7] via-[#8B5CF6] to-[#6366F1] text-white shadow-lg shadow-purple-900/40 hover:opacity-95 active:scale-95 cursor-pointer'
                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed opacity-50'
                }`}
              >
                <Download className="h-4 w-4" />
                <span>
                  Download
                  {isSeries && selectedEpIndices.size > 0 ? ` (${selectedEpIndices.size})` : ''}
                </span>
              </button>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
};

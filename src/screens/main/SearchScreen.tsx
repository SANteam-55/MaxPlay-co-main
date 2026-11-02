import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Mic, Flame, Trash2, X, Play, Star, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { SearchBar } from '../../components/common/SearchBar';
import { SectionHeader } from '../../components/common/SectionHeader';
import { RankBadge } from '../../components/common/RankBadge';
import { LoadingSkeleton } from '../../components/common/LoadingSkeleton';
import { NativeBanner } from '../../components/ads/NativeBanner';
import { useContent } from '../../hooks/useContent';
import { ContentItem } from '../../types';
import { STORAGE_KEYS } from '../../utils/constants';
import { subscribeToSearchSettings } from '../../services/contentService';
import { adManager } from '../../services/adService';
import { useAuth } from '../../hooks/useAuth';
import { NativeBridgeService } from '../../services/nativeBridgeService';

interface SearchScreenProps {
  onBack?: () => void;
  onSelectContent?: (content: ContentItem) => void;
}

export const SearchScreen: React.FC<SearchScreenProps> = ({
  onBack,
  onSelectContent,
}) => {
  const { user } = useAuth();
  const { contentList, loading } = useContent();

  const handleContentClick = (item: ContentItem) => {
    onSelectContent?.(item);
    const isPrem = !!user?.isPremium;
    setTimeout(() => {
      adManager.handleContentCardClick(isPrem);
    }, 50);
  };
  const [query, setQuery] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [showVoiceSheet, setShowVoiceSheet] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voiceStatusText, setVoiceStatusText] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [activeHotTab, setActiveHotTab] = useState<'movies' | 'series' | 'short_tv' | 'music'>('movies');
  const [hotSlideDirection, setHotSlideDirection] = useState<number>(1);
  const [activeFilterTab, setActiveFilterTab] = useState<'all' | 'movie_series' | 'anime'>('all');
  const [searchConfig, setSearchConfig] = useState<{ everyoneSearching: string[]; popularSearches: string[] }>(() => {
    try {
      const raw = localStorage.getItem('maxplay_search_config_cache');
      if (raw) return JSON.parse(raw);
    } catch {}
    return {
      everyoneSearching: [],
      popularSearches: []
    };
  });

  // Subscribe to Search Settings from Firestore
  useEffect(() => {
    const unsub = subscribeToSearchSettings((data) => {
      setSearchConfig(data);
      try {
        localStorage.setItem('maxplay_search_config_cache', JSON.stringify(data));
      } catch {}
    });
    return () => unsub();
  }, []);

  // Load recent searches from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.RECENT_SEARCHES);
      if (saved) {
        setRecentSearches(JSON.parse(saved));
      } else {
        setRecentSearches([]);
      }
    } catch (e) {
      // fallback
    }
  }, []);

  const saveRecentSearch = (term: string) => {
    if (!term.trim()) return;
    const filtered = recentSearches.filter((item) => item.toLowerCase() !== term.toLowerCase());
    const updated = [term, ...filtered].slice(0, 10);
    setRecentSearches(updated);
    localStorage.setItem(STORAGE_KEYS.RECENT_SEARCHES, JSON.stringify(updated));
  };

  // Register Android Native Voice Recognition callback
  useEffect(() => {
    window.__onMaxPlayVoiceResult = (spokenText: string) => {
      setIsListening(false);
      const cleaned = (spokenText || '').trim();
      if (cleaned) {
        setVoiceTranscript(cleaned);
        setQuery(cleaned);
        saveRecentSearch(cleaned);
        setVoiceStatusText('Matched! Showing results...');
        setTimeout(() => {
          setShowVoiceSheet(false);
          setVoiceStatusText(null);
        }, 420);
      } else {
        setVoiceStatusText('Could not hear clearly. Tap mic to try again.');
      }
    };
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
      }
    };
  }, [recentSearches]);

  const stopVoiceSession = () => {
    setIsListening(false);
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
    }
  };

  const startVoiceRecognitionEngine = () => {
    setVoiceTranscript('');
    setVoiceStatusText('Listening... Speak a movie, series, or anime title');

    const SpeechRecognitionAPI =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    // 1. Prefer Web Speech Recognition inside our custom MaxPlay Bottom Sheet so OS popup doesn't cover our custom UI
    if (SpeechRecognitionAPI) {
      try {
        if (recognitionRef.current) {
          try {
            recognitionRef.current.stop();
          } catch {}
        }
        const recognition = new SpeechRecognitionAPI();
        recognitionRef.current = recognition;
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = 'en-IN';

        recognition.onstart = () => {
          setIsListening(true);
          setVoiceStatusText('Listening... Speak now');
        };

        recognition.onresult = (event: any) => {
          let transcript = '';
          for (let i = 0; i < event.results.length; i++) {
            transcript += event.results[i][0].transcript;
          }
          const cleaned = transcript.trim();
          if (cleaned) {
            setVoiceTranscript(cleaned);
            setQuery(cleaned);
            if (event.results[event.results.length - 1]?.isFinal) {
              saveRecentSearch(cleaned);
              setIsListening(false);
              setVoiceStatusText('Found! Searching now...');
              setTimeout(() => {
                setShowVoiceSheet(false);
                setVoiceStatusText(null);
              }, 450);
            }
          }
        };

        recognition.onerror = () => {
          setIsListening(false);
          if (NativeBridgeService.isRunningInKotlinApp()) {
            const started = NativeBridgeService.startNativeVoiceRecognition((spokenText: string) => {
              if (window.__onMaxPlayVoiceResult) window.__onMaxPlayVoiceResult(spokenText);
            });
            if (started) {
              setIsListening(true);
              setVoiceStatusText('Listening... Speak now');
              return;
            }
          }
          setVoiceStatusText('Tap the microphone below to speak again');
        };

        recognition.onend = () => {
          setIsListening(false);
        };

        recognition.start();
        return;
      } catch {}
    }

    // 2. Fallback to Native Android Speech Recognizer
    if (NativeBridgeService.isRunningInKotlinApp()) {
      const started = NativeBridgeService.startNativeVoiceRecognition((spokenText: string) => {
        if (window.__onMaxPlayVoiceResult) window.__onMaxPlayVoiceResult(spokenText);
      });
      if (started) {
        setIsListening(true);
        setVoiceStatusText('Listening... Speak now');
        return;
      }
    }

    setIsListening(false);
    setVoiceStatusText('Tap a trending voice suggestion below or speak clearly');
  };

  const handleVoiceSearchToggle = () => {
    setShowVoiceSheet(true);
    startVoiceRecognitionEngine();
  };

  const removeRecentItem = (term: string) => {
    const updated = recentSearches.filter((item) => item !== term);
    setRecentSearches(updated);
    localStorage.setItem(STORAGE_KEYS.RECENT_SEARCHES, JSON.stringify(updated));
  };

  const clearAllRecent = () => {
    setRecentSearches([]);
    localStorage.removeItem(STORAGE_KEYS.RECENT_SEARCHES);
  };

  const handleSearchSubmit = () => {
    if (query) {
      saveRecentSearch(query);
    }
  };

  // Strictly show admin-configured search tags only
  const trendingPills = (searchConfig.everyoneSearching && searchConfig.everyoneSearching.length > 0)
    ? searchConfig.everyoneSearching
    : (searchConfig.popularSearches && searchConfig.popularSearches.length > 0)
      ? searchConfig.popularSearches
      : [];

  // Show only the top 5 items in "Everyone is searching" pills; items 6, 7, 8... rotate inside the Search Bar
  const topFiveTrendingPills = trendingPills.slice(0, 5);
  const rotatingSearchItems = trendingPills.length > 5 ? trendingPills.slice(5) : trendingPills;

  const HOT_TABS: { id: 'movies' | 'series' | 'short_tv' | 'music'; label: string }[] = [
    { id: 'movies', label: 'Hot Movies' },
    { id: 'series', label: 'Hot Series' },
    { id: 'short_tv', label: 'Hot Short TV' },
    { id: 'music', label: 'Hot Music' },
  ];

  const hotSwipeStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleHotTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      hotSwipeStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
      };
    }
  };

  const switchHotTabWithDirection = (nextTabId: 'movies' | 'series' | 'short_tv' | 'music') => {
    if (nextTabId === activeHotTab) return;
    const curIdx = HOT_TABS.findIndex((t) => t.id === activeHotTab);
    const nextIdx = HOT_TABS.findIndex((t) => t.id === nextTabId);
    setHotSlideDirection(nextIdx > curIdx ? 1 : -1);
    setActiveHotTab(nextTabId);
  };

  const handleHotTouchEnd = (e: React.TouchEvent) => {
    if (!hotSwipeStartRef.current || e.changedTouches.length === 0) return;
    const dx = e.changedTouches[0].clientX - hotSwipeStartRef.current.x;
    const dy = e.changedTouches[0].clientY - hotSwipeStartRef.current.y;
    hotSwipeStartRef.current = null;

    // Trigger horizontal tab switch if horizontal swipe > 40px and dominates vertical scroll
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.25) {
      const currentIdx = HOT_TABS.findIndex((t) => t.id === activeHotTab);
      if (dx < 0 && currentIdx < HOT_TABS.length - 1) {
        switchHotTabWithDirection(HOT_TABS[currentIdx + 1].id);
      } else if (dx > 0 && currentIdx > 0) {
        switchHotTabWithDirection(HOT_TABS[currentIdx - 1].id);
      }
    }
  };

  // Hot lists selection from real Firestore items
  const hotListItems = contentList
    .filter(item => item.searchHotSection === activeHotTab)
    .sort((a, b) => (a.searchHotPosition || 0) - (b.searchHotPosition || 0));

  // Search Results filtering from real Firestore content
  const filteredResults = contentList.filter((item) => {
    const matchesQuery = item.title.toLowerCase().includes(query.toLowerCase()) ||
      item.genres?.some((g) => g.toLowerCase().includes(query.toLowerCase())) ||
      item.description?.toLowerCase().includes(query.toLowerCase());

    if (!matchesQuery) return false;

    if (activeFilterTab === 'movie_series') {
      return item.type === 'movie' || item.type === 'tv';
    }
    if (activeFilterTab === 'anime') {
      return item.type === 'anime';
    }
    return true;
  });

  const dynamicPlaceholder = (searchConfig.everyoneSearching && searchConfig.everyoneSearching.length > 0)
    ? `Search "${searchConfig.everyoneSearching[0]}"...`
    : "Search movies, series & anime...";

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto overflow-x-hidden bg-[#0A0A0A] p-4 pb-24 md:pb-8 text-left select-none scrollbar-none">
      {/* Search Header Bar */}
      <div className="flex items-center gap-2.5 mb-3">
        {onBack && (
          <button
            onClick={onBack}
            className="p-1.5 text-[#A1A1AA] hover:text-white transition cursor-pointer"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}

        <div className="flex-1">
          <SearchBar
            value={query}
            onChangeText={(text) => {
              setQuery(text);
            }}
            onSubmit={handleSearchSubmit}
            placeholder={isListening ? 'Listening... Speak now' : dynamicPlaceholder}
            rotatingPlaceholders={isListening ? [] : rotatingSearchItems}
            onSelectRotatingPlaceholder={(term) => {
              setQuery(term);
              saveRecentSearch(term);
            }}
            autoFocus
          />
        </div>

        {/* Single Real Voice Search Button: Purple Gradient Circle with White Mic Icon */}
        <button
          type="button"
          onClick={handleVoiceSearchToggle}
          title="Voice Search"
          className={`relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-[#7C3AED] via-[#8B5CF6] to-[#A855F7] text-white shadow-lg shadow-purple-600/35 border border-purple-400/40 transition-all active:scale-95 cursor-pointer ${
            isListening ? 'ring-4 ring-purple-500/40 animate-pulse scale-105' : 'hover:brightness-110'
          }`}
        >
          <Mic className="h-5 w-5 text-white stroke-[2.2]" />
        </button>
      </div>

      {/* Live Voice Status Indicator */}
      {voiceStatusText && (
        <div className="mb-3 flex items-center justify-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-purple-500/15 border border-purple-500/40 px-3.5 py-1 text-xs font-bold text-purple-200 shadow-sm">
            {isListening && <span className="h-2 w-2 rounded-full bg-purple-400 animate-ping" />}
            <span>{voiceStatusText}</span>
          </div>
        </div>
      )}

      {query ? (
        /* Results View */
        <div className="flex flex-col gap-4">
          {/* Filter Tabs */}
          <div className="flex items-center gap-4 overflow-x-auto border-b border-[#1C1C1E] pb-2 scrollbar-none">
            {[
              { id: 'all', label: 'All' },
              { id: 'movie_series', label: 'Movie/Series' },
              { id: 'anime', label: 'Anime' },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setActiveFilterTab(f.id as any)}
                className={`py-1 text-xs font-semibold whitespace-nowrap transition border-b-2 cursor-pointer ${
                  activeFilterTab === f.id
                    ? 'border-[#8B5CF6] text-white'
                    : 'border-transparent text-[#6B7280] hover:text-white'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Results List */}
          <div className="flex flex-col gap-3">
            {filteredResults.length > 0 ? (
              filteredResults.map((item, idx) => (
                <div
                  key={item.id || idx}
                  onClick={() => {
                    saveRecentSearch(item.title);
                    onSelectContent?.(item);
                  }}
                  className="flex cursor-pointer items-center justify-between rounded-xl bg-[#121212] p-2.5 transition hover:bg-[#1C1C1E]"
                >
                  <div className="flex items-center gap-3 overflow-hidden">
                    <img
                      src={item.posterUrl || undefined}
                      alt={item.title}
                      className="h-[68px] w-[50px] flex-shrink-0 rounded-lg object-cover"
                    />

                    <div className="flex flex-col text-left overflow-hidden">
                      <h4 className="line-clamp-1 text-sm font-semibold text-white">
                        {item.title}
                      </h4>
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-[#6B7280]">
                        <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                        <span className="text-amber-400 font-bold">{item.rating}</span>
                        <span>•</span>
                        <span>{item.year}</span>
                        <span>•</span>
                        <span>{item.country}</span>
                      </p>
                      <p className="mt-0.5 line-clamp-1 text-[11px] text-[#A1A1AA]">
                        {item.genres?.join(', ')}
                      </p>
                    </div>
                  </div>

                  <Play className="h-5 w-5 text-[#6B7280] flex-shrink-0 ml-2 hover:text-[#8B5CF6]" />
                </div>
              ))
            ) : (
              <div className="py-16 text-center">
                <p className="text-sm text-[#A1A1AA]">No results found for "{query}"</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Discovery View */
        <div className="flex flex-col gap-6">
          {/* Recent Searches */}
          {recentSearches.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-white">Recent</span>
                <button
                  onClick={clearAllRecent}
                  className="flex items-center gap-1 text-xs text-[#6B7280] hover:text-[#EF4444] transition cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Clear</span>
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                {recentSearches.map((term) => (
                  <div
                    key={term}
                    className="flex items-center gap-2 rounded-full bg-[#1C1C1E] px-3 py-1.5 text-xs text-[#A1A1AA] hover:text-white transition"
                  >
                    <span
                      onClick={() => setQuery(term)}
                      className="cursor-pointer"
                    >
                      {term}
                    </span>
                    <button
                      onClick={() => removeRecentItem(term)}
                      className="text-[#6B7280] hover:text-white"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Trending Searches Pills (Top 5 Only; items 6+ rotate inside SearchBar) */}
          <div>
            <SectionHeader
              title="Everyone is searching"
              icon={<Flame className="h-5 w-5 text-amber-500 fill-amber-500" />}
            />
            {loading ? (
              <div className="flex flex-wrap gap-2 mt-1">
                <LoadingSkeleton width={90} height={32} radius="9999px" />
                <LoadingSkeleton width={120} height={32} radius="9999px" />
                <LoadingSkeleton width={80} height={32} radius="9999px" />
                <LoadingSkeleton width={140} height={32} radius="9999px" />
                <LoadingSkeleton width={100} height={32} radius="9999px" />
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 mt-1">
                {topFiveTrendingPills.map((pill) => (
                  <button
                    key={pill}
                    onClick={() => {
                      setQuery(pill);
                      saveRecentSearch(pill);
                    }}
                    className="flex cursor-pointer items-center rounded-full bg-[#1C1C1E] border border-white/5 px-4 py-2 text-xs font-semibold text-[#A1A1AA] transition hover:bg-gradient-to-r hover:from-[#A855F7] hover:to-[#6366F1] hover:text-white active:scale-95"
                  >
                    {pill}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Hot Lists Tabbed inside ContentDetailScreen-styled Glassmorphic Plate with Finger Swipe */}
          <div
            onTouchStart={handleHotTouchStart}
            onTouchEnd={handleHotTouchEnd}
            className="rounded-2xl bg-gradient-to-b from-[#16161d]/90 to-[#0e0e13]/90 border border-white/10 backdrop-blur-xl shadow-2xl p-4 relative overflow-hidden"
          >
            {/* Subtle Ambient Top Glow inside Plate */}
            <div className="pointer-events-none absolute -top-12 left-1/2 -translate-x-1/2 h-24 w-3/4 rounded-full bg-purple-600/15 blur-2xl" />

            <div className="relative z-10 flex items-center justify-between gap-2 border-b border-white/10 pb-2.5 overflow-x-auto scrollbar-none">
              <div className="flex items-center gap-5">
                {HOT_TABS.map((tab) => {
                  const isActive = activeHotTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => switchHotTabWithDirection(tab.id)}
                      className={`relative py-1 text-xs font-bold whitespace-nowrap transition cursor-pointer ${
                        isActive
                          ? 'text-white'
                          : 'text-[#8E8E93] hover:text-white'
                      }`}
                    >
                      {tab.label}
                      {isActive && (
                        <motion.span
                          layoutId="searchHotTabUnderline"
                          transition={{ type: 'tween', ease: [0.22, 1, 0.36, 1], duration: 0.22 }}
                          className="absolute -bottom-[11px] left-0 right-0 h-[2.5px] rounded-full bg-gradient-to-r from-[#A855F7] via-[#8B5CF6] to-[#6366F1] shadow-[0_0_8px_rgba(139,92,246,0.8)]"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Hot Items List with 60fps Directional Slide Animation */}
            <div className="relative z-10 mt-3.5 flex flex-col gap-2.5 overflow-hidden">
              {/* NATIVE BANNER AD */}
              <NativeBanner />

              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={activeHotTab}
                  initial={{ opacity: 0, x: hotSlideDirection * 42 }}
                  animate={{
                    opacity: 1,
                    x: 0,
                    transition: { type: 'tween', ease: [0.22, 1, 0.36, 1], duration: 0.2 },
                  }}
                  exit={{
                    opacity: 0,
                    x: hotSlideDirection * -32,
                    transition: { type: 'tween', ease: [0.4, 0, 1, 1], duration: 0.12 },
                  }}
                  style={{ willChange: 'transform, opacity', transform: 'translate3d(0,0,0)' }}
                  className="flex flex-col gap-2.5"
                >
                  {loading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <div key={i} className="flex items-center gap-3 rounded-xl bg-white/[0.03] border border-white/5 p-2.5">
                        <LoadingSkeleton width={24} height={24} radius="6px" />
                        <LoadingSkeleton width={52} height={70} radius="8px" className="shrink-0" />
                        <div className="flex-1 flex flex-col gap-1.5">
                          <LoadingSkeleton width="70%" height={14} radius="4px" />
                          <LoadingSkeleton width="50%" height={12} radius="4px" />
                          <LoadingSkeleton width="40%" height={10} radius="4px" />
                        </div>
                      </div>
                    ))
                  ) : hotListItems.map((item, index) => (
                    <div
                      key={`${item.id}-${index}`}
                      onClick={() => handleContentClick(item)}
                      className="group flex cursor-pointer items-center justify-between rounded-xl bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.06] hover:border-purple-500/30 p-2.5 transition-all duration-200 shadow-sm active:scale-[0.99]"
                    >
                      <div className="flex items-center gap-3 overflow-hidden">
                        {/* Rank Badge */}
                        <RankBadge rank={item.searchHotPosition || index + 1} />

                        {/* Thumbnail */}
                        <div className="relative h-[70px] w-[52px] flex-shrink-0 overflow-hidden rounded-lg border border-white/10 bg-[#121216] shadow-md">
                          <img
                            src={item.posterUrl || undefined}
                            alt={item.title}
                            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                          />
                        </div>

                        {/* Meta info */}
                        <div className="flex flex-col text-left overflow-hidden">
                          <h4 className="line-clamp-1 text-sm font-bold text-white group-hover:text-purple-300 transition-colors">
                            {item.title}
                          </h4>
                          <div className="mt-1 flex items-center gap-1.5 text-xs text-[#9CA3AF]">
                            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                            <span className="text-amber-400 font-bold">{item.rating}</span>
                            <span>•</span>
                            <span>{item.year}</span>
                            <span>•</span>
                            <span className="truncate">{item.country}</span>
                          </div>
                          <p className="mt-0.5 line-clamp-1 text-[11px] text-[#A1A1AA]">
                            {item.genres?.join(' • ')}
                          </p>
                        </div>
                      </div>

                      <div className="ml-2 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-white/5 border border-white/10 text-[#A1A1AA] group-hover:bg-gradient-to-r group-hover:from-[#A855F7] group-hover:to-[#6366F1] group-hover:text-white group-hover:border-transparent transition-all">
                        <Play className="h-4 w-4 fill-current ml-0.5" />
                      </div>
                    </div>
                  ))}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>
      )}

      {/* CUSTOM MAXPLAY BOTTOM-SHEET VOICE SEARCH PANEL */}
      <AnimatePresence>
        {showVoiceSheet && (
          <div className="fixed inset-0 z-50 flex items-end justify-center">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.16 } }}
              exit={{ opacity: 0, transition: { duration: 0.14 } }}
              onClick={() => {
                stopVoiceSession();
                setShowVoiceSheet(false);
              }}
              className="fixed inset-0 bg-black/75 backdrop-blur-sm"
            />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0, transition: { type: 'tween', ease: [0.22, 1, 0.36, 1], duration: 0.22 } }}
              exit={{ y: '100%', transition: { type: 'tween', ease: [0.4, 0, 1, 1], duration: 0.16 } }}
              onClick={(e) => e.stopPropagation()}
              className="relative z-10 w-full max-w-lg rounded-t-3xl bg-gradient-to-b from-[#171722] to-[#0E0E14] border-t border-white/15 p-6 pb-8 shadow-[0_-16px_48px_rgba(0,0,0,0.9)] overflow-hidden"
            >
              {/* Top Drag Handle */}
              <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-4" />

              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-[#A78BFA]" />
                  <span className="text-sm font-extrabold text-white tracking-tight">
                    MaxPlay Voice Search
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    stopVoiceSession();
                    setShowVoiceSheet(false);
                  }}
                  className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Animated Custom Microphone Orb & Wave Rings */}
              <div className="my-7 flex flex-col items-center justify-center">
                <div className="relative flex items-center justify-center">
                  {isListening && (
                    <>
                      <span className="absolute h-28 w-28 rounded-full bg-[#8B5CF6]/20 animate-ping" />
                      <span className="absolute h-24 w-24 rounded-full bg-[#06B6D4]/20 animate-pulse" />
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (isListening) {
                        stopVoiceSession();
                      } else {
                        startVoiceRecognitionEngine();
                      }
                    }}
                    className={`relative z-10 flex h-20 w-20 items-center justify-center rounded-full transition-all cursor-pointer shadow-2xl ${
                      isListening
                        ? 'bg-gradient-to-tr from-[#7C3AED] via-[#8B5CF6] to-[#06B6D4] text-white scale-105 ring-4 ring-[#8B5CF6]/40'
                        : 'bg-[#222230] text-purple-300 border border-purple-500/40 hover:bg-[#2B2B3C]'
                    }`}
                  >
                    <Mic className="h-8 w-8 stroke-[2.2]" />
                  </button>
                </div>

                {/* Live Sound Wave Equalizer Bars */}
                <div className="mt-5 flex items-center justify-center gap-1.5 h-5">
                  {[0, 1, 2, 3, 4, 5, 6].map((bar) => (
                    <span
                      key={bar}
                      className={`w-1 rounded-full transition-all duration-200 ${
                        isListening
                          ? 'bg-gradient-to-t from-[#8B5CF6] to-[#06B6D4] animate-pulse h-4'
                          : 'bg-white/15 h-1.5'
                      }`}
                      style={{
                        animationDelay: `${bar * 90}ms`,
                        height: isListening ? `${10 + ((bar * 7) % 14)}px` : '6px',
                      }}
                    />
                  ))}
                </div>

                {/* Live Transcript / Status */}
                <p className="mt-3 text-center text-sm font-bold text-white min-h-[22px] px-4">
                  {voiceTranscript ? `"${voiceTranscript}"` : voiceStatusText || 'Tap the microphone and speak'}
                </p>
                <span className="mt-1 text-[11px] text-zinc-400">
                  {isListening ? 'Listening for movie, anime, or series name...' : 'Tap microphone to speak again'}
                </span>
              </div>

              {/* Quick Voice Suggestions */}
              {topFiveTrendingPills.length > 0 && (
                <div className="pt-3 border-t border-white/10">
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-2">
                    Try saying
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {topFiveTrendingPills.slice(0, 4).map((term) => (
                      <button
                        key={term}
                        type="button"
                        onClick={() => {
                          stopVoiceSession();
                          setQuery(term);
                          saveRecentSearch(term);
                          setShowVoiceSheet(false);
                        }}
                        className="rounded-full bg-white/5 hover:bg-[#8B5CF6]/25 border border-white/10 hover:border-[#8B5CF6]/40 px-3 py-1 text-xs font-semibold text-zinc-200 transition cursor-pointer"
                      >
                        &ldquo;{term}&rdquo;
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

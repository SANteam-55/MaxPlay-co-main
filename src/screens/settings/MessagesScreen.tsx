import React, { useState, useEffect } from 'react';
import { 
  ArrowLeft, 
  Bell, 
  CheckCheck, 
  CheckCircle2, 
  Play, 
  Star, 
  Trash2, 
  Film, 
  Tv, 
  Sparkles, 
  AlertTriangle, 
  Radio, 
  ExternalLink,
  Volume2,
  Calendar,
  Layers,
  Download,
  ArrowUp,
} from 'lucide-react';
import { useAuthContext } from '../../context/AuthContext';
import { subscribeToAnnouncements } from '../../services/contentService';
import { AnnouncementMessage } from '../../types';
import {
  useGeneralSettings,
  extractVersionFromAdminMessage,
  extractApkUrlFromMessage,
  isAdminMessageForceUpdate,
  isVersionNewer,
  formatVersionTag,
} from '../../hooks/useGeneralSettings';
import { NativeBridgeService } from '../../services/nativeBridgeService';

interface MessagesScreenProps {
  onBack: () => void;
  onPlayContent?: (contentId: string) => void;
}

export const MessagesScreen: React.FC<MessagesScreenProps> = ({ onBack, onPlayContent }) => {
  const { user } = useAuthContext();
  const { currentApkVersion, formattedCurrentVersion, apkDownloadUrl } = useGeneralSettings();
  const [messages, setMessages] = useState<AnnouncementMessage[]>([]);
  const [filterType, setFilterType] = useState<'all' | 'releases' | 'notices' | 'promos' | 'unread'>('all');
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);
  const [readIds, setReadIds] = useState<string[]>([]);
  const [msgApkProgress, setMsgApkProgress] = useState<Record<string, { status: string; progress: number; message: string }>>({});
  const [msgUpdateLang, setMsgUpdateLang] = useState<'en' | 'hi'>('hi');

  useEffect(() => {
    // Load local read/dismissed state from localStorage
    try {
      const savedDismissed = localStorage.getItem('maxplay_dismissed_msgs');
      if (savedDismissed) setDismissedIds(JSON.parse(savedDismissed));
      const savedRead = localStorage.getItem('maxplay_read_msgs');
      if (savedRead) setReadIds(JSON.parse(savedRead));
    } catch (e) {}

    const unsub = subscribeToAnnouncements(user?.uid, (msgs) => {
      // Sort messages newest first
      const sorted = [...msgs].sort((a, b) => {
        const tA = new Date(a.createdAt || a.date || 0).getTime();
        const tB = new Date(b.createdAt || b.date || 0).getTime();
        return tB - tA;
      });
      setMessages(sorted);
    });
    return () => unsub();
  }, [user?.uid]);

  const handleMarkAllRead = () => {
    const allIds = messages.map(m => m.id);
    setReadIds(allIds);
    try {
      localStorage.setItem('maxplay_read_msgs', JSON.stringify(allIds));
    } catch (e) {}
  };

  const handleDismissMessage = (id: string) => {
    const updated = [...dismissedIds, id];
    setDismissedIds(updated);
    try {
      localStorage.setItem('maxplay_dismissed_msgs', JSON.stringify(updated));
    } catch (e) {}
  };

  const handleClearAll = () => {
    if (window.confirm('Clear all announcements from your notification inbox?')) {
      const allIds = messages.map(m => m.id);
      setDismissedIds(allIds);
      try {
        localStorage.setItem('maxplay_dismissed_msgs', JSON.stringify(allIds));
      } catch (e) {}
    }
  };

  const handleCardClick = (msg: AnnouncementMessage) => {
    // Mark as read
    if (!readIds.includes(msg.id)) {
      const updated = [...readIds, msg.id];
      setReadIds(updated);
      try {
        localStorage.setItem('maxplay_read_msgs', JSON.stringify(updated));
      } catch (e) {}
    }
    // If attached content exists, play content
    if (msg.attachedContent?.id && onPlayContent) {
      onPlayContent(msg.attachedContent.id);
    }
  };

  // Filter messages (hide dismissed or recalled/withdrawn update announcements)
  const activeMessages = messages.filter(
    (m) => !dismissedIds.includes(m.id) && !(m as any).isWithdrawn && !(m as any).recalled
  );

  const filteredMessages = activeMessages.filter(m => {
    const isUnread = !readIds.includes(m.id) && m.isUnread !== false;
    if (filterType === 'unread') return isUnread;
    if (filterType === 'releases') return m.type === 'media_release' || m.type === 'episode_update' || !!m.attachedContent;
    if (filterType === 'notices') return m.type === 'notice' || m.type === 'system';
    if (filterType === 'promos') return m.type === 'promo' || m.type === 'event';
    return true;
  });

  const unreadCount = activeMessages.filter(m => !readIds.includes(m.id) && m.isUnread !== false).length;

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-[#0A0A0C] p-4 text-left select-none scrollbar-none pb-24">
      {/* HEADER */}
      <div className="flex items-center justify-between py-2 border-b border-[#1F1F24] pb-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="rounded-full p-2 text-white hover:bg-[#1A1A1E] transition cursor-pointer"
            title="Go Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-black text-white tracking-wide">Announcements</h2>
              {unreadCount > 0 && (
                <span className="rounded-full bg-gradient-to-r from-[#06B6D4] to-[#8B5CF6] px-2 py-0.5 text-[10px] font-black text-black">
                  {unreadCount} NEW
                </span>
              )}
            </div>
            <p className="text-[11px] text-[#71717A]">Official news, releases & stream updates</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {activeMessages.length > 0 && (
            <>
              <button
                onClick={handleMarkAllRead}
                className="flex items-center gap-1 text-xs font-bold text-[#06B6D4] hover:text-[#22D3EE] transition px-2.5 py-1.5 rounded-lg bg-[#06B6D4]/10 hover:bg-[#06B6D4]/20 cursor-pointer"
                title="Mark all as read"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Read All</span>
              </button>
              <button
                onClick={handleClearAll}
                className="text-xs font-bold text-[#71717A] hover:text-[#EF4444] transition p-1.5 rounded-lg hover:bg-white/5 cursor-pointer"
                title="Clear all messages"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* FILTER PILLS */}
      <div className="flex items-center gap-2 overflow-x-auto py-3 scrollbar-none">
        <button
          onClick={() => setFilterType('all')}
          className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition shrink-0 cursor-pointer ${
            filterType === 'all'
              ? 'bg-white text-black shadow-md'
              : 'bg-[#18181B] text-[#A1A1AA] hover:bg-[#27272A] hover:text-white'
          }`}
        >
          <span>All</span>
          <span className="text-[10px] opacity-70">({activeMessages.length})</span>
        </button>

        <button
          onClick={() => setFilterType('releases')}
          className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition shrink-0 cursor-pointer ${
            filterType === 'releases'
              ? 'bg-gradient-to-r from-[#06B6D4] to-[#3B82F6] text-black shadow-md'
              : 'bg-[#18181B] text-[#A1A1AA] hover:bg-[#27272A] hover:text-white'
          }`}
        >
          <Film className="h-3.5 w-3.5" />
          <span>New Releases</span>
        </button>

        <button
          onClick={() => setFilterType('notices')}
          className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition shrink-0 cursor-pointer ${
            filterType === 'notices'
              ? 'bg-[#8B5CF6] text-white shadow-md'
              : 'bg-[#18181B] text-[#A1A1AA] hover:bg-[#27272A] hover:text-white'
          }`}
        >
          <Radio className="h-3.5 w-3.5" />
          <span>Notices</span>
        </button>

        <button
          onClick={() => setFilterType('promos')}
          className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition shrink-0 cursor-pointer ${
            filterType === 'promos'
              ? 'bg-[#F59E0B] text-black shadow-md'
              : 'bg-[#18181B] text-[#A1A1AA] hover:bg-[#27272A] hover:text-white'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span>Events</span>
        </button>

        {unreadCount > 0 && (
          <button
            onClick={() => setFilterType('unread')}
            className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition shrink-0 cursor-pointer ${
              filterType === 'unread'
                ? 'bg-[#22D3EE] text-black shadow-md'
                : 'bg-[#18181B] text-[#06B6D4] border border-[#06B6D4]/30'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-[#06B6D4]"></span>
            <span>Unread ({unreadCount})</span>
          </button>
        )}
      </div>

      {/* MESSAGES FEED */}
      <div className="mt-2 flex flex-col gap-3.5">
        {filteredMessages.length > 0 ? (
          filteredMessages.map((msg) => {
            const isUnread = !readIds.includes(msg.id) && msg.isUnread !== false;
            const sender = msg.sender || {
              name: 'MaxPlay Official',
              handle: '@MaxPlayAdmin',
              avatar: '',
              isVerified: true
            };

            const attached = msg.attachedContent;
            const isEpisodeUpdate = msg.type === 'episode_update';
            const isUrgent = msg.priority === 'urgent';
            const isImportant = msg.priority === 'important';
            const detectedUpdateVer = extractVersionFromAdminMessage(msg);
            const isNewerApkUpdate =
              Boolean(detectedUpdateVer) &&
              isVersionNewer(detectedUpdateVer!, currentApkVersion);
            const isForceApkMsg = Boolean(detectedUpdateVer) && isAdminMessageForceUpdate(msg);
            const msgApkUrl =
              extractApkUrlFromMessage(msg) || apkDownloadUrl || msg.actionUrl || '';

            return (
              <div
                key={msg.id}
                className={`group relative flex flex-col rounded-2xl bg-[#131316] border transition-all duration-200 overflow-hidden ${
                  isNewerApkUpdate
                    ? 'border-red-500/60 shadow-lg shadow-red-600/15'
                    : isUnread
                    ? 'border-[#06B6D4]/40 shadow-lg shadow-[#06B6D4]/5'
                    : 'border-white/5 hover:border-white/15'
                }`}
              >
                {/* Glowing Active Border Stripe */}
                {isNewerApkUpdate ? (
                  <div className="absolute top-0 left-0 bottom-0 w-1.5 bg-gradient-to-b from-red-500 via-rose-500 to-orange-500 animate-pulse" />
                ) : (
                  isUnread && (
                    <div className="absolute top-0 left-0 bottom-0 w-1 bg-gradient-to-b from-[#06B6D4] to-[#8B5CF6]" />
                  )
                )}

                <div className="p-4 flex flex-col gap-3">
                  {/* SENDER PROFILE BAR */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {/* Avatar */}
                      <div className="relative h-9 w-9 rounded-full overflow-hidden flex-shrink-0 border border-white/10 bg-gradient-to-br from-[#06B6D4] to-[#8B5CF6] flex items-center justify-center font-black text-white text-xs shadow-md">
                        {sender.avatar ? (
                          <img 
                            src={sender.avatar || undefined} 
                            alt={sender.name}
                            className="h-full w-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <span>{(sender.name || 'M').charAt(0).toUpperCase()}</span>
                        )}
                      </div>

                      {/* Name & Handle */}
                      <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-black text-white truncate">{sender.name || 'MaxPlay Official'}</span>
                          {sender.isVerified !== false && (
                            <svg
                              viewBox="0 0 22 22"
                              aria-label="Verified Account"
                              className="h-4 w-4 flex-shrink-0 inline-block select-none"
                            >
                              <path
                                fill="#1D9BF0"
                                d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816z"
                              />
                              <path
                                fill="#FFFFFF"
                                d="M9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"
                              />
                            </svg>
                          )}
                          {detectedUpdateVer && (
                            <span
                              className={`text-[9px] font-black px-2 py-0.5 rounded-full uppercase flex items-center gap-1 ${
                                isNewerApkUpdate
                                  ? 'bg-red-600 text-white shadow-sm shadow-red-600/50 animate-pulse'
                                  : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              }`}
                            >
                              <ArrowUp className="h-2.5 w-2.5 stroke-[3]" />
                              <span>APK {formatVersionTag(detectedUpdateVer)}</span>
                            </span>
                          )}
                          {isForceApkMsg && (
                            <span className="bg-red-500/20 text-red-300 border border-red-500/40 text-[9px] font-black px-1.5 py-0.5 rounded uppercase">
                              Force Update
                            </span>
                          )}
                          {isUrgent && !isForceApkMsg && (
                            <span className="bg-red-500/20 text-red-400 border border-red-500/30 text-[9px] font-black px-1.5 py-0.2 rounded uppercase">
                              Urgent
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono text-[#06B6D4] truncate">{sender.handle || '@MaxPlayAdmin'}</span>
                          <span className="text-[10px] text-[#52525B]">·</span>
                          <span className="text-[10px] text-[#71717A]">{msg.date || 'Today'}</span>
                        </div>
                      </div>
                    </div>

                    {/* Quick Dismiss / Read */}
                    <div className="flex items-center gap-1">
                      {isUnread && (
                        <span className="h-2 w-2 rounded-full bg-[#06B6D4] mr-1" title="Unread"></span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDismissMessage(msg.id);
                        }}
                        className="text-[#52525B] hover:text-[#EF4444] transition p-1.5 rounded-lg hover:bg-white/5 cursor-pointer"
                        title="Dismiss announcement"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* ANNOUNCEMENT TITLE & BODY */}
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-black text-white leading-snug flex items-center gap-1.5">
                      {msg.type === 'media_release' && <Film className="h-4 w-4 text-[#06B6D4] flex-shrink-0" />}
                      {msg.type === 'episode_update' && <Tv className="h-4 w-4 text-[#A78BFA] flex-shrink-0" />}
                      {msg.type === 'notice' && <AlertTriangle className="h-4 w-4 text-[#FBBF24] flex-shrink-0" />}
                      {msg.type === 'promo' && <Sparkles className="h-4 w-4 text-[#F472B6] flex-shrink-0" />}
                      <span>{msg.title}</span>
                    </h3>
                    <p className="text-xs text-[#A1A1AA] leading-relaxed whitespace-pre-line">
                      {msg.body}
                    </p>
                  </div>

                  {/* ATTACHED PROMOTIONAL BANNER / ADMIN IMAGE */}
                  {(msg.bannerUrl || (msg as any).imageUrl || (msg as any).image) && (
                    <div className="relative w-full rounded-xl overflow-hidden border border-white/10 max-h-56 bg-black/40">
                      <img 
                        src={msg.bannerUrl || (msg as any).imageUrl || (msg as any).image || undefined} 
                        alt={msg.title || 'Attached Image'}
                        className="w-full max-h-56 object-cover"
                        onError={(e) => {
                          (e.target as HTMLElement).style.display = 'none';
                        }}
                      />
                    </div>
                  )}

                  {/* ADMIN APK UPDATE ACTION CARD */}
                  {detectedUpdateVer && (
                    <div
                      className={`mt-1 flex flex-col gap-2.5 rounded-xl p-3 border ${
                        isNewerApkUpdate
                          ? 'bg-red-950/30 border-red-500/40'
                          : 'bg-emerald-950/20 border-emerald-500/30'
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="flex flex-col">
                          <span
                            className={`text-[10px] font-black uppercase tracking-wider ${
                              isNewerApkUpdate ? 'text-red-400' : 'text-emerald-400'
                            }`}
                          >
                            {isNewerApkUpdate
                              ? `Newer than your Settings > Check update (${formattedCurrentVersion})`
                              : `Matches/Older than your Check update (${formattedCurrentVersion})`}
                          </span>
                          <span className="text-xs font-extrabold text-white mt-0.5">
                            Official MaxPlay APK {formatVersionTag(detectedUpdateVer)}
                          </span>
                        </div>
                        {msgApkUrl && (
                          <button
                            type="button"
                            disabled={msgApkProgress[msg.id]?.status === 'downloading'}
                            onClick={(e) => {
                              e.stopPropagation();
                              NativeBridgeService.triggerApkUpdate(
                                msgApkUrl,
                                formatVersionTag(detectedUpdateVer),
                                msg.title || `MaxPlay ${formatVersionTag(detectedUpdateVer)} Update`,
                                (state) =>
                                  setMsgApkProgress((prev) => ({
                                    ...prev,
                                    [msg.id]: state,
                                  }))
                              );
                            }}
                            className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-black uppercase tracking-wider shadow-md transition active:scale-95 cursor-pointer shrink-0 disabled:opacity-75 ${
                              isNewerApkUpdate
                                ? 'bg-gradient-to-r from-red-600 to-rose-500 text-white shadow-red-600/30'
                                : 'bg-emerald-500 text-black'
                            }`}
                          >
                            <Download className="h-3.5 w-3.5 stroke-[2.5]" />
                            <span>
                              {msgApkProgress[msg.id]?.status === 'downloading'
                                ? `Downloading (${msgApkProgress[msg.id].progress}%)...`
                                : msgApkProgress[msg.id]?.status === 'installing'
                                ? 'Installing APK...'
                                : `Update App (${formatVersionTag(detectedUpdateVer)})`}
                            </span>
                          </button>
                        )}
                      </div>
                      {/* Bilingual (English / Hindi) Safe Update Permission Reassurance */}
                      <div className="rounded-lg bg-black/40 border border-white/10 p-2.5">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-[10px] font-extrabold text-emerald-300 flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
                            <span>
                              {msgUpdateLang === 'hi'
                                ? 'सुरक्षित अपडेट सूचना (100% Safe)'
                                : 'Safe Update Permission Note'}
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMsgUpdateLang((prev) => (prev === 'en' ? 'hi' : 'en'));
                            }}
                            className="rounded-md bg-white/10 hover:bg-white/20 border border-white/15 px-2 py-0.5 text-[9px] font-black text-white transition cursor-pointer shrink-0"
                          >
                            {msgUpdateLang === 'en' ? 'हिंदी में पढ़ें' : 'Read in English'}
                          </button>
                        </div>
                        <p className="text-[10.5px] text-zinc-300 leading-relaxed">
                          {msgUpdateLang === 'hi'
                            ? 'अपडेट करते समय यदि फोन "Install Unknown Apps" की परमिशन मांगे, तो बिना किसी चिंता के Allow करें। यह सिर्फ ऐप के अंदर सुरक्षित रूप से नया अपडेट इंस्टॉल करने के लिए है।'
                            : 'If your phone asks for "Install Unknown Apps" permission, please allow it without worry. It is only needed to safely install the official MaxPlay update inside the app.'}
                        </p>
                      </div>
                      {msgApkProgress[msg.id] && (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[10px] font-bold">
                            <span className="text-zinc-300 truncate pr-2">
                              {msgApkProgress[msg.id].message}
                            </span>
                            <span className="text-emerald-400 font-black tabular-nums">
                              {msgApkProgress[msg.id].progress}%
                            </span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-red-500 to-emerald-400 transition-all duration-200"
                              style={{ width: `${Math.max(4, msgApkProgress[msg.id].progress)}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ATTACHED CINEMA MEDIA SHOWCASE CARD */}
                  {attached && attached.id && (
                    <div 
                      onClick={() => handleCardClick(msg)}
                      className="mt-1 flex flex-row gap-3 bg-[#1A1A1E] hover:bg-[#202026] p-2.5 rounded-xl border border-white/10 hover:border-[#06B6D4]/50 transition-all duration-200 cursor-pointer shadow-md group/card"
                    >
                      {/* Left: Horizontal Poster / Backdrop */}
                      <div className="relative w-24 sm:w-28 h-20 rounded-lg overflow-hidden flex-shrink-0 bg-black border border-white/10">
                        <img 
                          src={attached.backdropUrl || attached.posterUrl || 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=400'} 
                          alt={attached.title}
                          className="w-full h-full object-cover group-hover/card:scale-105 transition duration-300"
                          onError={(e) => {
                            (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=400';
                          }}
                        />
                        {/* Type Pill */}
                        <div className="absolute top-1 left-1 bg-black/80 backdrop-blur-sm text-[8px] font-black text-white px-1.5 py-0.2 rounded uppercase">
                          {attached.type || 'Media'}
                        </div>
                        {/* Rating */}
                        {attached.rating && (
                          <div className="absolute bottom-1 left-1 bg-black/80 backdrop-blur-sm text-[9px] font-black text-[#FBBF24] px-1.5 py-0.2 rounded flex items-center gap-0.5">
                            <Star className="h-2.5 w-2.5 fill-current" />
                            <span>{attached.rating}</span>
                          </div>
                        )}
                      </div>

                      {/* Right: Media Info & Instant Watch Action */}
                      <div className="flex flex-1 flex-col justify-between min-w-0">
                        <div>
                          <div className="flex items-center justify-between gap-1">
                            <h4 className="text-xs sm:text-sm font-black text-white group-hover/card:text-[#06B6D4] transition truncate">
                              {attached.title}
                            </h4>
                          </div>

                          {/* Metadata Badges */}
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            {attached.quality && (
                              <span className="bg-[#06B6D4]/15 text-[#22D3EE] border border-[#06B6D4]/30 text-[9px] font-black px-1.5 py-0.2 rounded">
                                {attached.quality}
                              </span>
                            )}
                            {attached.episodeInfo && (
                              <span className="bg-[#8B5CF6]/15 text-[#A78BFA] border border-[#8B5CF6]/30 text-[9px] font-black px-1.5 py-0.2 rounded">
                                {attached.episodeInfo}
                              </span>
                            )}
                            {attached.year && (
                              <span className="text-[10px] text-[#71717A] font-bold">
                                {attached.year}
                              </span>
                            )}
                          </div>

                          {/* Audio Dub Language Info */}
                          {attached.languages && attached.languages.length > 0 && (
                            <div className="flex items-center gap-1 mt-1 text-[10px] text-[#A1A1AA] truncate">
                              <Volume2 className="h-3 w-3 text-[#34D399] flex-shrink-0" />
                              <span className="truncate">{attached.languages.join(' · ')}</span>
                            </div>
                          )}
                        </div>

                        {/* Watch Now Button */}
                        <div className="mt-2 flex items-center justify-between">
                          <span className="text-[10px] text-[#71717A] font-medium hidden sm:inline">Tap to stream instantly</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCardClick(msg);
                            }}
                            className="flex items-center gap-1.5 bg-gradient-to-r from-[#06B6D4] to-[#8B5CF6] hover:from-[#22D3EE] hover:to-[#A78BFA] text-black font-black text-[11px] px-3 py-1.2 rounded-lg shadow-md shadow-cyan-500/20 transition transform active:scale-95 cursor-pointer ml-auto"
                          >
                            <Play className="h-3 w-3 fill-current" />
                            <span>{attached.actionLabel || (isEpisodeUpdate ? 'Play Episode' : 'Watch Now')}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* CUSTOM ACTION URL LINK (If specified) */}
                  {msg.actionUrl && !attached && !detectedUpdateVer && (
                    <a
                      href={msg.actionUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1.5 text-xs font-bold text-[#06B6D4] hover:underline"
                    >
                      <span>Learn More / Open Link</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          /* EMPTY STATE */
          <div className="flex flex-col items-center justify-center p-12 text-center rounded-2xl bg-[#121215] border border-white/5 mt-4">
            <div className="h-16 w-16 rounded-full bg-white/5 flex items-center justify-center text-[#71717A] mb-3">
              <Bell className="h-8 w-8 text-[#52525B]" />
            </div>
            <span className="text-sm font-black text-white">No announcements found</span>
            <span className="mt-1 text-xs text-[#71717A] max-w-xs">
              {filterType === 'all'
                ? 'All official releases, episode updates and notifications will appear here.'
                : 'No announcements match the selected filter tab.'}
            </span>
            {filterType !== 'all' && (
              <button
                onClick={() => setFilterType('all')}
                className="mt-4 text-xs font-bold text-[#06B6D4] hover:underline cursor-pointer"
              >
                View all announcements
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

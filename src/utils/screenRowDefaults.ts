import { HomeRowConfig } from '../types';

export function getDefaultRowsForScreen(screenName: string): HomeRowConfig[] {
  switch (screenName) {
    case 'Anime':
      return [
        { id: 'anime-continue-watching', title: 'Continue Watching', order: 1, style: 'continue_watching', icon: 'PlayCircle', tagFilter: 'Anime' },
        { id: 'anime-top10', title: 'Top 10 in Anime', order: 2, style: 'top_10', icon: 'Trophy', tagFilter: 'Anime' },
        { id: 'anime-seasonal', title: 'Seasonal Anime', order: 3, style: 'seasonal_card', tagFilter: 'Anime' },
        { id: 'anime-classic', title: 'Classic Anime Series', order: 4, style: 'classic_anime', tagFilter: 'Anime' },
        { id: 'anime-otherworld', title: 'Welcome to Otherworld', order: 5, style: 'landscape_text', tagFilter: 'Anime' },
        { id: 'anime-popular', title: 'Popular Anime', order: 6, style: 'default', tagFilter: 'Anime' },
      ];
    case 'TV':
      return [
        { id: 'tv-continue-watching', title: 'Continue Watching', order: 1, style: 'continue_watching', icon: 'PlayCircle', tagFilter: 'TV' },
        { id: 'tv-top10', title: 'Top 10 in TV', order: 2, style: 'top_10', icon: 'Trophy', tagFilter: 'TV' },
        { id: 'tv-seasonal', title: 'Seasonal Series', order: 3, style: 'seasonal_card', tagFilter: 'TV' },
        { id: 'tv-classic', title: 'Classic Series', order: 4, style: 'classic_anime', tagFilter: 'TV' },
        { id: 'tv-world', title: 'Welcome to TV Worlds', order: 5, style: 'landscape_text', tagFilter: 'TV' },
        { id: 'tv-popular', title: 'Popular TV Shows', order: 6, style: 'default', tagFilter: 'TV' },
      ];
    case 'Short TV':
      return [
        { id: 'shorttv-continue-watching', title: 'Continue Watching', order: 1, style: 'continue_watching', icon: 'PlayCircle', tagFilter: 'Short TV' },
        { id: 'shorttv-top10', title: 'Top 10 in Short TV', order: 2, style: 'top_10', icon: 'Trophy', tagFilter: 'Short TV' },
        { id: 'shorttv-seasonal', title: 'Seasonal Short Drama', order: 3, style: 'seasonal_card', tagFilter: 'Short TV' },
        { id: 'shorttv-classic', title: 'Classic Mini Series', order: 4, style: 'classic_anime', tagFilter: 'Short TV' },
        { id: 'shorttv-quick', title: 'Quick Stories', order: 5, style: 'landscape_text', tagFilter: 'Short TV' },
        { id: 'shorttv-trending', title: 'Trending Short Dramas', order: 6, style: 'default', tagFilter: 'Short TV' },
      ];
    case 'Movies':
      return [
        { id: 'movies-continue-watching', title: 'Continue Watching', order: 1, style: 'continue_watching', icon: 'PlayCircle', tagFilter: 'Movie' },
        { id: 'movies-top10', title: 'Top 10 in Movies', order: 2, style: 'top_10', icon: 'Trophy', tagFilter: 'Movie' },
        { id: 'movies-premieres', title: 'Blockbuster Premieres', order: 3, style: 'seasonal_card', tagFilter: 'Movie' },
        { id: 'movies-classic', title: 'Classic Movie Favorites', order: 4, style: 'classic_anime', tagFilter: 'Movie' },
        { id: 'movies-cinema', title: 'Cinema Showcase', order: 5, style: 'landscape_text', tagFilter: 'Movie' },
        { id: 'movies-trending', title: 'Trending Movies', order: 6, style: 'default', tagFilter: 'Movie' },
      ];
    case 'LIVE':
      return [
        { id: 'live-broadcasts', title: 'Live Broadcasts', order: 1, style: 'seasonal_card', tagFilter: 'LIVE' },
        { id: 'live-streams', title: 'Trending Streams', order: 2, style: 'landscape_text', tagFilter: 'LIVE' },
        { id: 'live-channels', title: 'Featured Channels', order: 3, style: 'default', tagFilter: 'LIVE' },
      ];
    case 'Trending':
    default:
      return [
        { id: 'trending-continue-watching', title: 'Continue Watching', order: 1, style: 'continue_watching', icon: 'PlayCircle', tagFilter: '' },
        { id: 'trending-top10', title: 'Top 10 in Trending', order: 2, style: 'top_10', icon: 'Trophy', tagFilter: '' },
        { id: 'trending-now', title: 'Trending Now', order: 3, style: 'default', tagFilter: '' },
        { id: 'trending-networks', title: 'Networks & Studios', order: 4, style: 'network_grid', icon: 'Tv', tagFilter: '' },
        { id: 'trending-featured', title: 'Featured Highlights', order: 5, style: 'seasonal_card', tagFilter: '' },
        { id: 'trending-otherworld', title: 'Welcome to Otherworld', order: 6, style: 'landscape_text', tagFilter: '' },
        { id: 'trending-classic', title: 'Classic Hits', order: 7, style: 'classic_anime', tagFilter: '' },
      ];
  }
}


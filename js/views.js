/* views.js — the router.
 *
 * A view is a function that fills the scroll host and returns a teardown. This
 * file used to be all of them: 5,030 lines holding every route, every card,
 * the album page, the four album views, the settings page and eleven dialogs.
 * It was a sixth of the source and the file every pass grew, which is how a
 * change to one view came to risk four others.
 *
 * It is now the table and nothing else. Each route lives in `views/`, one
 * subject per file, and `views/shared.js` holds what more than one of them
 * needs — the track table, the sort control, the cards, the A–Z rail. The
 * split follows the section comments that were already in the old file, so
 * nothing moved that was not already grouped.
 *
 * The three re-exports below are for `app.js` and `ui.js`, which have always
 * imported them from here and should not have to know where they went.
 */

import * as home from './views/home.js';
import * as songs from './views/songs.js';
import * as albums from './views/albums.js';
import * as album from './views/album.js';
import * as artists from './views/artists.js';
import * as playlists from './views/playlists.js';
import * as search from './views/search.js';
import * as bandView from './views/band.js';
import * as settings from './views/settings.js';
import * as files from './views/files.js';
import * as genres from './views/genres.js';
import * as attention from './views/attention.js';
import { setFresh } from './views/shared.js';
export { markTransition, hasLiveSelection, albumCard, renderAlbumCard } from './views/shared.js';

const ROUTES = {
  home: home.viewHome,
  attention: attention.viewAttention,
  genres: genres.viewGenres,
  genre: genres.viewGenre,
  files: files.viewFiles,
  songs: songs.viewSongs,
  albums: albums.viewAlbums,
  album: album.viewAlbum,
  artists: artists.viewArtists,
  artist: artists.viewArtist,
  favourites: playlists.viewFavourites,
  recent: playlists.viewRecent,
  playlists: playlists.viewPlaylists,
  playlist: playlists.viewPlaylist,
  search: search.viewSearch,
  circles: bandView.viewCircles,
  sound: bandView.viewSound,
  settings: settings.viewSettings,
};

/* Whether the route changed, for the views that animate differently on a
   fresh arrival than on a repaint of the page they are already on. */
let lastRouteKey = '';

export function renderView(host, route) {
  const key = route.name + '/' + route.arg;
  setFresh(key !== lastRouteKey);
  lastRouteKey = key;

  const fn = ROUTES[route.name] || home.viewHome;
  return fn(host, route.arg) || (() => {});
}


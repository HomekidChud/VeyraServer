# Veyra Browser — frontend v8.13

This is a static HTML/CSS/JS frontend for GitHub Pages. There's no build step: upload the folder contents to the Pages site.
It needs the Veyra server **v8.13.0 or newer**, which provides the auth, session time limit and admin-gating endpoints.

## What's in it

- **Homepage** (`/`): hero, live server stats, features, how it works, Explore, FAQ, and sign in / sign up.
- **Accounts**: sign up, sign in, sign out, sign out everywhere, change password, rename, delete account.
  Settings, bookmarks, extensions, shortcuts and notes sync to your account.
- **Session limits**: each session has a server-enforced timer (2:00 by default).
  - A live countdown shows in the toolbar, with warnings 30s and 10s before the end.
  - When time runs out, the server deletes the session (cookies, Chromium context, VPN tunnel) and an overlay offers a fresh session.
- **Browser UI**:
  - Tabs, omnibox with suggestions, bookmarks bar, zoom, and the menu.
  - Pages: history, downloads, find in page, print, VPN, calculator, Veyra Search, and a customisable new tab page.
- **Settings** (`/settings/<section>`), laid out like Chrome's settings with section search:
  - account, appearance (theme, accent, font size, zoom, compact), search engine, on startup, new tab page, privacy, sessions
  - downloads and history, accessibility, keyboard shortcuts (rebind, reset, conflict handling), extensions, VPN, system, developer, reset, about
  - admins also get a live server-config / Render plan editor
- **Extensions**: Dark Reader, tracker and ad blocker, focus mode, readable text, link highlighter, grayscale, reader view, page stats, quick notes, default zoom, compact UI.
- **DevTools** (Ctrl+Shift+I / Ctrl+Shift+C) inspect the live proxied page:
  - Elements: DOM tree, live style and attribute editing, box model, element picker
  - Console: eval, object previews, errors
  - Sources, with a pretty-printer
  - Network: type filters, headers, timing
  - Application: storage and cookies
  - Performance metrics
- **Admin only**: `/dev` and `#console`. Guests are redirected, and the menu hides them. The server enforces this too.

## Shortcuts

| Action | Keys |
| --- | --- |
| New tab / close tab | Ctrl+T / Ctrl+W |
| History / downloads | Ctrl+H / Ctrl+J |
| Find / print | Ctrl+F / Ctrl+P |
| VPN | Ctrl+Shift+V |
| DevTools / inspect element | Ctrl+Shift+I / Ctrl+Shift+C |
| View source resources | Ctrl+U |
| Settings | Ctrl+, |

You can rebind all of these under Settings → Keyboard shortcuts.

## Backend URL

The default backend is `https://veyraserver-xscy.onrender.com`. To point at another server, open `?api=https://your-server` once; the choice is saved. Use `?api=reset` to go back to the default.

## Routing

Deep links such as `/settings/shortcuts`, `/history` and `/dev` work on GitHub Pages. `404.html` redirects to `index.html?veyra_route=…`, and the app restores the route. Project-site subpaths are detected automatically.

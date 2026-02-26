# Yarnl Release Notes

## v0.6.8

### Features
- **Mobile landscape support** — landscape phones now use the mobile UI with compact bars, maximizing PDF viewing area
- **Counter tap to close** — tapping the counter label again closes the edit panel (same as pressing Done)

### Infrastructure
- **Auto-detect backup mount** — external backup drive is detected automatically, removing the need for a `BACKUP_PATH` env var

---

## v0.6.7

### Bug Fixes
- **Fix Catppuccin dark mode** — Catppuccin dark theme was missing counter button color variables, causing them to fall back to default Lavender colors

---

## v0.6.6

### Bug Fixes
- **Fix sessions over plain HTTP** — session cookies no longer require HTTPS, so accessing Yarnl over HTTP on a LAN works correctly
- **Fix settings lost on quick refresh** — settings changes (theme, etc.) now sync to the server immediately on modal close and flush on page unload, preventing loss from the 2-second debounce window

### Configuration
- **`SECURE_COOKIES` env var** — set to `true` to mark session cookies as HTTPS-only (defaults to `false`)

---

## v0.6.5

### Infrastructure
- **Simplified `BACKUP_PATH`** — now a boolean flag (`true`) instead of a path; set `BACKUP_PATH=true` and add a volume mount to `/backups` in docker-compose to store backups on an external drive or NAS (existing `/backups` value still works)

### Docs
- Add Docker Compose install link to README prerequisites

---

## v0.6.4

### Features
- **Synced scrolling for live preview** — markdown editor and preview panes scroll in sync across all editors (new pattern, inline edit, pattern notes)
- **Inline editor live preview** — existing markdown patterns now have a side-by-side live preview toggle when editing
- **Image drag-and-drop** — drag images directly into any markdown editor (previously paste-only)
- **Image paste in pattern notes** — paste images from clipboard into PDF pattern notes
- **Catppuccin theme** — new Catppuccin Latte (light) and Mh
- Add Windows PowerShell quickstart instructions to README

---

## v0.6.3

### Features
- **Configurable inactivity timeout** — set how long before the auto timer pauses, or disable it entirely (Settings > Appearance > Inactivity Timeout)

### Bug Fixes
- **Timer saves reliably on exit** — timer seconds are cached locally when closing a pattern, preventing lost time from server save race conditions

### UI Polish
- **Centered mobile page number** — page indicator is now centered between the title and timer in mobile view

---

## v0.6.2

### Features
- **What's New popup toggle** — disable the release notes popup from Settings > Appearance > Notifications

### Bug Fixes
- **Auto timer persists on exit** — timer state is preserved when leaving and re-opening a pattern
- **PDF timer save on close** — timer now correctly saves to the server when closing the PDF viewer

---

## v0.6.1

### Bug Fixes
- **Auto timer resumes on tab return** — timer now restarts automatically when switching back to the tab, instead of staying stopped

---

## v0.6.0

### Features
- **Dark-only theme toggle** — day/night toggle is hidden for themes that lack a light mode (e.g., Midnight, Synthwave, Dracula)

### UI Polish
- **No more flash on refresh** — settings/back button, theme toggle, and tab highlights all render correctly from the first frame
- **Centered header title** — "Yarnl" logo stays locked in center when switching between Settings and Back buttons

---

## v0.5.9

### Bug Fixes
- Fix "What's New" popup not showing for users upgrading from versions before the feature existed

---

## v0.5.8

### Performance
- **PDF viewer caching** — PDFs are cached between close/reopen, eliminating the white flash on revisit
- **Annotation-aware cache busting** — PDF cache updates automatically after annotation saves

### Features
- **"What's New" popup** — changelog shown automatically on version update

### Bug Fixes
- Fix annotation save crash caused by null `matchMedia` result in PDF.js

---

## v0.5.7

### Performance
- **Gzip compression** — All responses are now compressed, reducing transfer sizes by ~75% (app.js: 559KB → ~120KB)
- **Static asset caching** — CSS, JS, and images cached for 7 days with `?v=` cache busting for updates

### Markdown Editor
- Improved layout — editor and preview now fill the full screen (reduced excess bottom padding)
- Save status now color-coded: green for saved, muted for saving, red for errors
- "Done" button replaces "Preview" toggle on desktop for cleaner workflow
- Mobile-optimized create form — fixed action bar at bottom, compact layout, smaller thumbnail

### Projects
- **Thumbnail play overlay** — replaces the Continue button at the bottom of project cards, keeping card heights consistent with pattern cards
- **Context-aware hashtag filtering** — clicking a hashtag on a project card filters the projects tab; clicking on a pattern card filters the library tab
- Project badge color changed to secondary (pink) to distinguish from category badges

### Infrastructure
- `NODE_ENV=production` now defaults in the Dockerfile — no longer needed in docker-compose
- **BACKUP_PATH env var** — configure custom backup storage location
- Fix backup migration across Docker volume mounts
- Upgrade multer to 2.0.2 (fixes 4 high-severity DoS vulnerabilities)

---

## v0.5.6

### Bug Fixes
- Fix backup migration across Docker volume mounts

### Infrastructure
- Add BACKUP_PATH env var for custom backup storage location
- Update README with NODE_ENV and BACKUP_PATH in compose example

---

## v0.5.5

### Security
- Upgrade multer to 2.0.2 (fixes 4 high-severity DoS vulnerabilities)

### Bug Fixes
- Fix tab counts not updating on project add
- Use relative display paths

### Infrastructure
- Add Komodo webhook trigger to release workflow

---

## v0.5.4

### Markdown Editor
- Add inline markdown editor with auto-save
- Metadata-only details modal
- Add Tab/Shift+Tab indent support for markdown editor lists
- Match markdown viewer header to PDF viewer, add mobile support

### Bug Fixes
- Fix In Progress page not updating on toggle

---

## v0.5.3

### Features
- Add admin owner badges, owner filter, and scope current tab to own patterns
- Add admin-only stats section to about page

### Bug Fixes
- Fix login screen flash on first load in single-user mode

### Docs
- Rework Quick Start with intro, prerequisites, and numbered steps

---

## v0.5.2

### Features
- Load app version dynamically from package.json

### Infrastructure
- Add docker-compose to README and document all env vars
- Add screenshots to README
- Remove legacy root files (start.sh, index.html, favicon.svg)

---

## v0.5.1

### Bug Fixes
- Fix database init order: create users table before categories

### Infrastructure
- Use Docker Hub image in compose file instead of build
- Add GitHub Release to CI workflow and fix dependency vulnerabilities

---

## v0.5.0

Initial release.

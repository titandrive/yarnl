# Claude Development Log

A running log of features and changes made to Yarnl.

---

## 2026-01-16: Favorites Feature & Pin-to-Top Sorting

Added pattern favorites system and pin-to-top sorting controls.

### Features
- **Favorites**: Star button on cards to mark patterns as favorites
- **Favorite Badge**: Yellow star overlay on thumbnails for favorited patterns (no background, drop-shadow for visibility)
- **Current Button Update**: Changed icon from star to play triangle, green color when active
- **Highlight Favorites**: Added "Favorites" option to the Highlight dropdown
- **Pin-to-Top Buttons**: Two icon buttons next to Sort dropdown (play for current, star for favorites)
- **Pin Behavior**: Pinned patterns appear at top while maintaining the selected sort order within each group
- **Shared Card Component**: Refactored to use single `renderPatternCard()` function for both Library and Current tabs

### Technical Details
- `is_favorite` BOOLEAN column added to patterns table
- `PATCH /api/patterns/:id/favorite` endpoint for toggling favorite status
- `toggleFavorite()` function mirrors `toggleCurrent()` behavior
- `pinCurrent` and `pinFavorites` state variables with localStorage persistence
- Sort comparison checks pin state first, then applies selected sort order
- Pin buttons use green (current) and yellow (favorites) colors when active

### Files Modified
- `db.js` - Added is_favorite column migration
- `server.js` - Added favorite toggle endpoint
- `public/app.js` - toggleFavorite function, renderPatternCard refactor, pin button handlers, sort logic
- `public/index.html` - Pin buttons in sort header, Favorites in highlight dropdown
- `public/styles.css` - Pin button styles, favorite badge overlay

---

## 2026-01-15: Inline Description Editing & Library Card Redesign

Major overhaul of library card UI with inline editing and icon-only action buttons.

### Features
- **Inline Description Editing**: Click description text to edit in place (no modal needed)
- **Character Counter**: Shows 0/45 limit while editing, enforces max length
- **Edit UX**: Cursor placed at end on click, Enter or click away to save, Escape to cancel
- **Empty Placeholder**: Shows "+ Add description" in italics when no description
- **Icon-Only Action Buttons**: Replaced large text buttons with compact icon buttons (star, check, edit, trash)
- **Inline Delete Confirm**: Two-click delete (click trash, then checkmark to confirm)
- **Fixed Card Size**: All cards now uniform 220x320px, no flexing/stretching
- **Compact Completion Date**: Changed from "Completed: 1/15/2026 (0:00:13)" to "1/15/2026 · 0:00:13"

### Technical Details
- `startInlineDescEdit()` uses contenteditable for seamless editing experience
- Character counter element inserted as sibling, removed on save/cancel
- `window.getSelection().removeAllRanges()` prevents highlight flash on save
- Cards use `display: block` with fixed height for full-area clickability
- Subtle opacity hover effect (0.7) instead of jarring color change

### Files Modified
- `public/app.js` - Inline edit function, card rendering with icon buttons, delete confirm logic
- `public/styles.css` - Card sizing, action buttons, inline counter, description editing states
- `public/index.html` - Description field maxlength (45) and character counters in modals

---

## 2026-01-15: Upload Form Labels & Toggle Styling

Improved form label clarity and consistency in upload/create pattern forms.

### Features
- **Required/Optional Labels**: Fields now show "required" or "optional" in muted text instead of asterisks
- **Consistent Label Styling**: Name, Category (required), Hashtags, Thumbnail (optional), Pattern Content (markdown)
- **Back Button Position**: Moved to left side of headers, shortened to "← Back"
- **Toggle Switch**: "Mark as current pattern" now uses toggle switch matching settings page

### Technical Details
- `.required` class for muted label hints (font-weight 400, text-muted color, 0.85em)
- `.mark-current-toggle` flexbox layout for label + toggle alignment
- Applied to both markdown create form and PDF upload staged files

### Files Modified
- `public/index.html` - Updated labels, rearranged header buttons, toggle markup
- `public/app.js` - Updated staged file form with new labels and toggle
- `public/styles.css` - Added `.required` and `.mark-current-toggle` styles

---

## 2026-01-15: Library Edit Modal Delete Button & Compact Styling

Added missing delete button to library edit modal and made modals more compact.

### Features
- **Delete from Library Edit**: Edit modal (accessed from library page) now has Delete Pattern button
- **Compact Edit Modal**: Reduced padding, spacing, and thumbnail size for better fit at 100% zoom
- **Smaller Modal Buttons**: All modal buttons now more compact (8px 18px padding, 0.9rem font)
- **Tighter Button Spacing**: Gap between modal buttons reduced from 15px to 10px

### Technical Details
- `deleteEditPattern()` function uses existing `editingPatternId` to delete pattern
- Button layout matches PDF/Markdown edit modals (delete on left, cancel/save on right)
- Modal-specific styles in `#edit-modal` selector for targeted compactness

### Files Modified
- `public/index.html` - Added delete button with `modal-actions-right` wrapper
- `public/app.js` - Added `deleteEditPattern()` function and event listener
- `public/styles.css` - Compact modal styling, smaller buttons

---

## 2026-01-15: Pushover Notifications & Settings URL Routing

Added push notifications via Pushover and deep-linking for settings sections.

### Features
- **Pushover Integration**: New Notifications tab in settings for configuring Pushover
- **Backup Notifications**: Get notified when scheduled backups complete or fail
- **Secure Credentials**: User key and API token masked in UI, stored in database
- **Settings URL Routing**: Each settings section has its own URL (`#settings/backups`, `#settings/notifications`, etc.)
- **Refresh Persistence**: Refreshing maintains current settings section
- **Database Settings Storage**: Backup schedule settings moved from file to PostgreSQL
- **Mascot Position**: Moved Yarnboi to right side of header title
- **Simplified Category/Hashtag Styling**: Removed red highlight from default category (star is sufficient), hashtags now use regular text color

### Technical Details
- `loadNotificationSettings()` and `saveNotificationSettings()` use PostgreSQL JSONB
- Password fields with focus/blur handlers to clear/restore masked values
- `switchToSettingsSection()` function handles section switching and URL updates
- `handleInitialNavigation()` parses `settings/section` URL format
- `getCurrentView()` returns full settings path for history management
- Fixed `btn-primary:hover` using `filter: brightness(0.85)` instead of undefined `--primary-hover`

### Files Modified
- `server.js` - Notification endpoints, Pushover API integration, database settings
- `public/index.html` - Notifications section, password inputs for credentials, mascot position
- `public/app.js` - Settings URL routing, notification settings handlers
- `public/styles.css` - Fixed button hover, category/hashtag styling

---

## 2026-01-15: Settings Panel Consistency & Fixes

Improved settings panel structure, fixed About section loading bug.

### Features
- **Settings Restructure**: All sections now have consistent h3 main title + description, h4 grey subheadings for subsections
- **Appearance Subsections**: Theme, Header, Library, PDF Viewer
- **Keyboard Shortcut Descriptions**: Added descriptions below each shortcut label
- **Orphaned Images List**: Shows filenames with parsed pattern names
- **About Section Fix**: Stats now load when refreshing while on settings page

### Technical Details
- `loadLibraryStats()` now called in `switchToTab()` when navigating to settings
- Added `parsePatternFromFilename()` helper to extract pattern names from image filenames
- Server returns orphaned images as `{filename, patternName}` objects
- CSS `settings-subheading:first-of-type` removes border from first h4 in each section

### Files Modified
- `public/index.html` - Restructured Appearance, Categories & Tags, added shortcut descriptions
- `public/app.js` - Fixed settings loading, added pattern name parsing
- `public/styles.css` - Added setting-hint class, orphaned-images-list styling, first-of-type rule
- `server.js` - Orphaned images endpoint returns parsed pattern names

---

## 2026-01-15: Yarnboi Mascot & Toast Notifications

Replaced yarn ball with new Yarnboi mascot, added toast notifications for settings.

### Features
- **New Mascot**: Yarnboi replaces yarn ball in header logo and favicon
- **Toast Notifications**: All settings changes show themed confirmation toasts
- **Theme-Aware Toasts**: Toast border color uses theme's primary color

### Technical Details
- Logo size: 2.59em (reduced 10% from 2.875em after cropping)
- `showToast(message, type, duration)` function in app.js
- Toast uses `--primary-color` CSS variable for theme matching

### Files Modified
- `public/yarboi.png` - New mascot image
- `public/index.html` - Updated header logo img src, favicon href
- `public/app.js` - Added showToast function, toast calls in all settings handlers
- `public/styles.css` - Toast notification styles

---

## 2026-01-14: Backup Prune Time Unit Dropdown

Improved backup pruning UI with selectable time units.

### Features
- **Time Unit Dropdown**: When pruning by age, select days/weeks/months/years
- **Separate Containers**: "Keep last X backups" and "Older than X" have dedicated UI
- Converts selected unit to days for API compatibility

### Files Modified
- `public/app.js` - Updated prune settings logic with unit conversion
- `public/index.html` - New prune-age-container with dropdown
- `public/styles.css` - Added input-with-select styling

---

## 2026-01-14: Show/Hide Tagline Toggle

Added toggle to show or hide the header tagline with conditional input visibility.

### Features
- **Show Tagline Toggle**: New setting in Appearance to show/hide header subtitle
- **Conditional Input**: Tagline text input only shows when tagline is enabled
- Persists via localStorage
- Included in Reset to Defaults

### Files Modified
- `public/app.js` - Tagline visibility toggle handler, conditional input display
- `public/index.html` - Show Tagline checkbox, tagline-input-container wrapper

---

## 2026-01-14: Delete Pattern from Edit Modal

Added delete functionality to pattern edit modals with inline confirmation.

### Features
- **Delete Button**: Red delete button in PDF and Markdown edit modals
- **Inline Confirmation**: Two-click confirmation (no popup dialogs)
- **Visual Feedback**: Pulsing animation on confirm state

### Technical Details
- First click changes button to "Confirm Delete" with pulse animation
- Second click performs deletion and closes modal/viewer
- Button state resets on modal close or error
- `resetDeleteButton()` helper for state management

### Files Modified
- `public/app.js` - Delete handlers for PDF and Markdown modals
- `public/index.html` - Delete buttons in modal actions
- `public/styles.css` - Confirm-delete animation, modal-actions-right layout

---

## 2026-01-14: Library Filter Persistence & Logo Toggle

Added persistent library filter state and appearance toggle for the header logo.

### Features
- **Filter Persistence**: Library sort, category filter, and all checkboxes (show completed, current, PDF, markdown, highlight new) now persist across refresh/restart
- **Show Logo Toggle**: New setting in Appearance to show/hide the yarn ball emoji in header
- **Markdown Styling**: Added CSS for images, tables, links, and horizontal rules in markdown preview

### Technical Details
- All library filter states stored in localStorage with `library*` prefix
- Logo visibility controlled via `display: inline/none` on span wrapper
- Reset to Defaults includes logo reset

### Files Modified
- `public/app.js` - Filter persistence logic, logo toggle handler
- `public/index.html` - Show Logo setting UI, header logo span wrapper
- `public/styles.css` - Markdown element styling (images, tables, links, hr)

---

## 2026-01-14: Markdown Image Paste & Storage Settings

Added ability to paste images into markdown editors and new Storage settings section.

### Features
- **Image Paste**: Paste images directly into pattern notes (Cmd+V)
- **Auto Processing**: Images auto-resize to max 1200x1200, convert to optimized JPEG
- **Storage Section**: New settings section showing image count and total size
- **Orphan Detection**: Finds images no longer referenced in any pattern
- **Orphan Cleanup**: One-click removal of unused images
- **Backup Images**: Option to include/exclude images from backups
- **Full Markdown**: Added marked.js library for complete markdown support

### Technical Details
- Images stored in `patterns/images/` with pattern name prefix
- Orphan detection checks both database notes (PDF patterns) and .md files (markdown patterns)
- Express route order fix: specific routes (`/orphaned`, `/stats`) before parameterized (`/:filename`)

### Files Modified
- `server.js` - Image upload, serve, stats, orphan detection/cleanup endpoints
- `public/app.js` - Image paste handler, Storage section UI, backup image toggle
- `public/index.html` - Storage section, Include Images backup option, marked.js CDN

---

## 2026-01-14: Exit Viewer Keyboard Shortcut

Added Escape key shortcut to close pattern viewers.

### Features
- **Exit Viewer**: Pressing Escape closes PDF or Markdown viewer and goes back
- **Configurable**: Can be changed in Settings > Keyboard Shortcuts
- **Shortcut Merging**: Fixed keyboard shortcuts loading to merge saved with defaults (new shortcuts auto-added)

### Files Modified
- `public/app.js` - Added `exitViewer` shortcut, fixed shortcut loading logic
- `public/index.html` - Added Exit Viewer to shortcuts settings UI

---

## 2026-01-14: Browser Navigation & Cmd+Click Support

Added proper browser navigation and the ability to open patterns in new tabs.

### Features
- **Browser Back/Forward**: Back and forward buttons now work correctly throughout the app
- **UI Back Button**: Navigates through actual history (not just back to library)
- **Cmd+Click Patterns**: Cmd/Ctrl+click on a pattern card opens it in a new tab
- **URL Hash Routing**: Views are bookmarkable (`#library`, `#settings`, `#pattern/123`)

### Technical Details
- Uses History API (`pushState`, `replaceState`, `popstate` event)
- `navigationHistory` array tracks UI navigation for back button
- `handlePatternClick()` detects modifier keys for new tab behavior
- `handleInitialNavigation()` parses URL hash on page load
- `initTabs()` checks URL hash to prevent flash when opening pattern in new tab

### Files Modified
- `public/app.js` - Navigation logic, history management, cmd+click handler
- `public/index.html` - Cache version bump

---

## 2026-01-14: Backup & Restore Feature

Added comprehensive backup and restore functionality to Settings.

### Features
- **Create Backup**: Exports database as JSON + optionally includes pattern files in a zip
- **Download/Restore/Delete**: Manage backups from the UI
- **Scheduled Backups**: Daily/weekly/monthly with configurable time (24h, local timezone)
- **Auto Cleanup**: Delete old backups by count ("keep last X") or age ("older than X days")
- **Estimated Size**: Shows library size and estimated backup size, updates when toggling pattern inclusion

### Technical Details
- Database exported as JSON (categories, hashtags, patterns, counters, pattern_hashtags)
- Uses `archiver` and `unzipper` npm packages
- Backups stored in `/app/backups` (container) mapped to host via docker-compose volume
- `BACKUP_HOST_PATH` env var controls displayed path in UI (default: `./backups`)
- Scheduled backups check on page load if time has passed

### Files Modified
- `server.js` - Added backup endpoints (GET/POST/DELETE /api/backups, restore, prune)
- `public/app.js` - Backup UI logic, scheduling, size calculation
- `public/index.html` - Backup & Restore settings section
- `public/styles.css` - Backup-related styles, improved settings subheadings
- `docker-compose.yml` - Added backups volume mount and BACKUP_HOST_PATH env var
- `package.json` - Added archiver, unzipper dependencies

---

## 2026-01-14: Earlier Changes (from previous session)

- **Default Category**: Added ability to set any category as default (star button), stored in localStorage
- **Midnight Theme Fix**: Softened text colors, fixed hardcoded tab hover color
- **PDF Viewer Background**: Changed from --bg-color to --card-bg to match theme
- **Keyboard Shortcuts**: Changed zoom default to `=`, added Escape to cancel listening, right-click to clear
- **Tagline Customization**: Added option in Appearance to customize header subtitle
- **Reset to Defaults**: Added button in Appearance section

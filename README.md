# Yarnl - Crochet Project Manager

A self-hosted web application for managing crochet patterns, tracking project progress, and organizing your craft library.

**Version:** 0.5.0

## Features

### Pattern Library
- **Upload PDF and Markdown patterns** with automatic thumbnail generation
- **Organize by categories** (Amigurumi, Wearables, Tunisian, Lace/Filet, Colorwork, Freeform, Micro, Other)
- **Hashtag system** for flexible pattern tagging and filtering
- **Custom thumbnails** - upload your own or use auto-generated ones
- **Integrated PDF viewer** with page navigation and progress tracking
- **Markdown pattern support** with embedded images
- **Pattern notes** stored as markdown files

### Project Tracking
- **Mark patterns as "Current"** to track active projects
- **Built-in row and stitch counters** with keyboard shortcuts
- **Custom counters** for complex patterns (e.g., "Sleeve 1", "Round Counter")
- **Project timer** - manual or auto-timer that pauses on inactivity
- **Progress tracking** - remembers your page position in each pattern

### Backup & Restore
- **Manual and scheduled backups** (daily/weekly)
- **Selective backup options** - choose PDF patterns, markdown patterns, archive, and notes
- **Auto-prune** old backups by count or age
- **Push notifications** via Pushover for backup events

### Archive System
- **Archive completed patterns** to keep library clean
- **Optional delete mode** for permanent removal instead of archiving
- **Auto-delete archived patterns** after configurable time period

### Additional Features
- **Dark mode interface**
- **Keyboard shortcuts** for counting (`+`/`=` for stitch, `-` to decrement, `r` for row)
- **Bluetooth/media remote support** for hands-free counting
- **Mobile-friendly responsive design**
- **Real-time notifications** via Server-Sent Events

## Quick Start with Docker

### Prerequisites
- Docker and Docker Compose installed

### Running the Application

1. **Clone the repository**
   ```bash
   git clone https://github.com/titandrive/yarnl.git
   cd yarnl
   ```

2. **Start with Docker Compose**
   ```bash
   docker-compose up -d
   ```

3. **Access the application**
   Open your browser to `http://localhost:3000`

4. **Stop the application**
   ```bash
   docker-compose down
   ```

### Data Persistence

All data persists across container restarts:
- **Database:** PostgreSQL volume for pattern metadata, counters, settings
- **Patterns:** `./patterns` directory for PDF and markdown files
- **Archive:** `./archive` directory for archived patterns
- **Backups:** `./backups` directory for backup zip files
- **Notes:** `./notes` directory for pattern notes (markdown)

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Environment mode |
| `POSTGRES_HOST` | `postgres` | Database host |
| `POSTGRES_PORT` | `5432` | Database port |
| `POSTGRES_DB` | `yarnl` | Database name |
| `POSTGRES_USER` | `yarnl` | Database user |
| `POSTGRES_PASSWORD` | `yarnl` | Database password |
| `BACKUP_HOST_PATH` | `./backups` | Host path shown in backup settings |
| `TZ` | `UTC` | Timezone for scheduled backups |

### Pushover Notifications (Optional)

To enable push notifications for backup events:
1. Go to Settings > Notifications
2. Enter your Pushover User Key and API Token
3. Enable desired notification types

## Development

### Running without Docker

1. **Install Node.js** (v18+) and PostgreSQL

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set environment variables** for database connection

4. **Start the server**
   ```bash
   npm start
   ```

## Technical Stack

- **Backend:** Node.js, Express
- **Database:** PostgreSQL 16
- **Frontend:** Vanilla JavaScript, HTML5, CSS3
- **PDF Processing:** PDF.js (viewing), Sharp (thumbnails)
- **Containerization:** Docker & Docker Compose

## Recent Updates

### v0.5.0 (January 2026)

- `6f71da7` Store pattern notes as markdown files instead of database
- `27a3f28` Improve upload staging UI with compact layout and thumbnails
- `311ea92` Add Minimal and Halloween themes
- `f83c14b` Add Bluetooth/media remote support for shortcuts
- `03cc6d6` Add archive feature with auto-delete option
- `9dd0617` Improve counter UX: inline naming, enter to save
- `4271cd8` Share counter overlay between PDF and markdown viewers
- `4439e88` Add swipe gestures for mobile PDF viewer
- `d2ab434` Improve mobile pinch-to-zoom for PDF viewer

### Earlier Updates

- `7c62182` Fix auto-prune after manual backups
- `a238bd8` Add archive backup option
- `65156a9` Exclude archived patterns from library stats
- `cd36f61` Fix homepage redirect to last visited pattern
- `25d8d32` Fix PDF scroll behavior for fit vs zoomed modes

## Documentation

See the [User Guide](https://yarnl.com/docs/category/user-guide) for detailed usage instructions.

## License

MIT License

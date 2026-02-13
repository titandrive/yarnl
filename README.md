# Yarnl

A self-hosted web application for managing crochet patterns, tracking project progress, and organizing your craft library.

## Features

### Pattern Library
- Upload **PDF** and create **Markdown** patterns with automatic thumbnail generation
- Organize by categories and hashtags
- Integrated PDF viewer with page navigation, zoom, and annotations
- Pattern notes stored as markdown files

### Project Tracking
- Group patterns into projects with progress tracking
- Built-in row and stitch counters with keyboard shortcuts
- Unlimited custom counters per pattern
- Project timer with auto-timer and inactivity detection
- Remembers your page position in each pattern

### Multi-User & SSO
- Single-user mode (no login) or multi-user with role-based access
- OIDC/SSO integration for external authentication
- Per-user permissions for PDF uploads and markdown creation
- Admin panel for user management

### Backup & Restore
- Manual and scheduled backups (daily/weekly/monthly)
- Selective backup options (PDFs, markdown, archive, notes)
- Auto-prune old backups by count or age
- Pushover notifications for backup events

### Customization
- 15+ color themes with light/dark modes
- Custom Google Fonts support
- Configurable keyboard shortcuts
- Bluetooth/media remote support for hands-free counting
- Mobile-optimized responsive design

## Quick Start

### Prerequisites
- Docker and Docker Compose

### Setup

1. **Download the compose file**
   ```bash
   mkdir yarnl && cd yarnl
   curl -O https://raw.githubusercontent.com/titandrive/yarnl/main/docker-compose.yml
   ```

2. **Configure environment** (optional)
   ```bash
   curl -O https://raw.githubusercontent.com/titandrive/yarnl/main/.env.example
   cp .env.example .env
   # Edit .env to set your preferences (passwords, timezone, etc.)
   ```

3. **Start the application**
   ```bash
   docker compose up -d
   ```

4. **Open your browser** to `http://localhost:3000`

By default, Yarnl starts in single-user mode with an `admin` account and no password. To enable multi-user mode, set `ADMIN_PASSWORD` in your `.env` file.

## Configuration

All configuration is done through environment variables. Copy `.env.example` to `.env` and adjust as needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_DB` | `yarnl` | Database name |
| `POSTGRES_USER` | `yarnl` | Database user |
| `POSTGRES_PASSWORD` | `yarnl` | Database password |
| `ADMIN_USERNAME` | `admin` | Initial admin username |
| `ADMIN_PASSWORD` | *(empty)* | Admin password (empty = passwordless login) |
| `PORT` | `3000` | Port exposed on the host |
| `TZ` | `UTC` | Timezone for scheduled backups |

### OIDC / SSO (Optional)

OIDC is configured through the admin settings panel in the app (Settings > Admin > SSO). Yarnl supports any OpenID Connect provider with auto-discovery.

### Pushover Notifications (Optional)

Configure push notifications for backup events in Settings > Notifications.

## Data Persistence

All user data is stored in the `./users` directory on the host, mounted as a Docker volume:
- Pattern files (PDFs, markdown, images)
- Thumbnails
- Notes
- Archive
- Backups

The PostgreSQL database uses a named Docker volume (`yarnl-postgres-data`) for metadata, counters, and settings.

## Development

### Running without Docker

1. Install **Node.js** (v18+) and **PostgreSQL**
2. Install dependencies: `npm install`
3. Set database environment variables
4. Start the server: `npm start`

### Development with Docker

Clone the repo and create a `docker-compose.override.yml` to build from source and mount the public directory for live editing:

```yaml
services:
  yarnl:
    build: .
    volumes:
      - ./public:/app/public
```

Then run `docker compose up -d --build`.

## Tech Stack

- **Backend:** Node.js, Express
- **Database:** PostgreSQL 16
- **Frontend:** Vanilla JavaScript, HTML5, CSS3
- **PDF:** PDF.js (viewing), Sharp (thumbnails), Poppler (processing)
- **Auth:** bcrypt, openid-client
- **Containerization:** Docker & Docker Compose

## License

[MIT](LICENSE)

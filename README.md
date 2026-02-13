# Yarnl: Your self-hosted crochet companion

A self-hosted web application for managing crochet patterns, tracking project progress, and organizing your crochet library.

Try out the [demo](https://demo.yarnl.com) yourself (username: demo, password: demo) or read the [docs](https://yarnl.com/docs/about) to get started.

<img src="https://yarnl.com/img/screenshots/home.png" alt="Home" width="700">
<img src="https://yarnl.com/img/screenshots/notes.png" alt="Notes" width="700">

## Features

### Pattern Library
- Upload **PDF** patterns or create **Markdown** patterns with automatic thumbnail generation
- Organize by categories and hashtags
- Integrated PDF viewer with row counters, timer, page navigation, zoom, keyboard controls and annotations
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

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/) and Docker Compose

Get Yarnl up and running in minutes:

```bash
mkdir yarnl && cd yarnl                # Create a directory for Yarnl
curl -O https://raw.githubusercontent.com/titandrive/yarnl/main/docker-compose.yml  # Download the compose file
docker compose up -d                   # Start Yarnl and PostgreSQL
```

Open `http://localhost:3000` and you're done. By default, Yarnl starts in single-user mode with an `admin` account and no password.

To configure passwords, timezone, and other options, download the [`.env.example`](https://raw.githubusercontent.com/titandrive/yarnl/main/.env.example) file, rename it to `.env`, and edit as needed before starting.

### Docker Compose

If you prefer to write the compose file yourself instead of downloading it:

```yaml
services:
  postgres:
    container_name: yarnl-db
    image: postgres:16-alpine
    volumes:
      - yarnl-postgres-data:/var/lib/postgresql/data
    environment:
      - POSTGRES_DB=${POSTGRES_DB:-yarnl}
      - POSTGRES_USER=${POSTGRES_USER:-yarnl}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-yarnl}
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-yarnl}"]
      interval: 5s
      timeout: 5s
      retries: 5

  yarnl:
    container_name: yarnl
    image: titandrive/yarnl:latest
    ports:
      - "${PORT:-3000}:3000"
    volumes:
      - ./users:/app/users
    environment:
      - NODE_ENV=production
      - POSTGRES_HOST=postgres
      - POSTGRES_PORT=5432
      - POSTGRES_DB=${POSTGRES_DB:-yarnl}
      - POSTGRES_USER=${POSTGRES_USER:-yarnl}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-yarnl}
      - ADMIN_USERNAME=${ADMIN_USERNAME:-admin}
      - ADMIN_PASSWORD=${ADMIN_PASSWORD:-}
      - TZ=${TZ:-UTC}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  yarnl-postgres-data:
```

## Configuration

All configuration is done through environment variables. Copy `.env.example` to `.env` and adjust as needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_DB` | `yarnl` | Database name |
| `POSTGRES_USER` | `yarnl` | Database user |
| `POSTGRES_PASSWORD` | `yarnl` | Database password |
| `POSTGRES_HOST` | `postgres` | Database hostname (use default with Docker Compose) |
| `POSTGRES_PORT` | `5432` | Database port |
| `ADMIN_USERNAME` | `admin` | Initial admin username |
| `ADMIN_PASSWORD` | *(empty)* | Admin password (empty = passwordless login) |
| `PORT` | `3000` | Port exposed on the host |
| `TZ` | `UTC` | Timezone for scheduled backups |
| `FORCE_LOCAL_LOGIN` | `false` | Force local login even when OIDC/SSO is configured |

### OIDC / SSO (Optional)

OIDC is configured through the admin settings panel in the app (Settings > Admin > SSO). Yarnl supports any OpenID Connect provider with auto-discovery. If SSO is misconfigured and you get locked out, set `FORCE_LOCAL_LOGIN=true` to bypass SSO and log in with your local credentials.

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

## AI Disclosure
Yarnl was developed with the assistance of Claude. 
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
- Optional `BACKUP_PATH` to store backups on an external drive or NAS — existing backups are automatically migrated when the path changes

### Customization
- 15+ color themes with light/dark modes
- Custom Google Fonts support
- Configurable keyboard shortcuts
- Bluetooth/media remote support for hands-free counting
- Mobile-optimized responsive design

## Installation
### Quick Start
Yarnl is easy to get up and running with Docker. You'll be crocheting in no time. 

**Prerequisites:** 
- [Docker](https://docs.docker.com/get-docker/) 
- Docker Compose

1. Open terminal and run the following commands:

**Linux / macOS**
```bash
mkdir yarnl && cd yarnl
curl -O https://raw.githubusercontent.com/titandrive/yarnl/main/docker-compose.yml
docker compose up -d
```

**Windows (PowerShell)**
```powershell
mkdir yarnl; cd yarnl
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/titandrive/yarnl/main/docker-compose.yml" -OutFile "docker-compose.yml"
docker compose up -d
```

2. Open your browser and navigate to `http://localhost:3000`

By default, Yarnl starts in single-user mode with an `admin` account and no password.

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
      # Optional: mount an external path for backups
      # - /mnt/user/drive:/backups
    environment:
      - POSTGRES_HOST=postgres
      - POSTGRES_PORT=5432
      - POSTGRES_DB=${POSTGRES_DB:-yarnl}
      - POSTGRES_USER=${POSTGRES_USER:-yarnl}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-yarnl}
      - ADMIN_USERNAME=${ADMIN_USERNAME:-admin}
      - ADMIN_PASSWORD=${ADMIN_PASSWORD:-}
      - TZ=${TZ:-UTC}
      # Optional: store backups at a custom path (use with volume mount above)
      # - BACKUP_PATH=/backups
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  yarnl-postgres-data:
```

## Configuration

Most configuration is done via settings once Yarnl is up and running. There are a few environment variables available to customize your installation:

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
| `NODE_ENV` | `production` | Defaults to `production` in the Docker image |
| `TZ` | `UTC` | Timezone for scheduled backups |
| `BACKUP_PATH` | *(unset)* | Custom backup storage location (see [Backup](#backup--restore)) |
| `FORCE_LOCAL_LOGIN` | `false` | Force local login even when OIDC/SSO is configured |

### OIDC / SSO (Optional)

OIDC can be configured through the admin settings panel (Settings > Admin > SSO) or via environment variables. Yarnl supports any OpenID Connect provider with auto-discovery.

To configure OIDC via environment variables, set all three required values. When set, these override any settings configured in the admin UI, and the SSO settings page becomes read-only.

**Required** (all three must be set to enable env-based OIDC):

| Variable | Description |
|----------|-------------|
| `OIDC_ISSUER` | Issuer URL (e.g., `https://auth.example.com`) |
| `OIDC_CLIENT_ID` | Client ID |
| `OIDC_CLIENT_SECRET` | Client secret |

**Optional:**

| Variable | Default | Description |
|----------|---------|-------------|
| `OIDC_PROVIDER_NAME` | *(issuer hostname)* | Display name on the login button |
| `OIDC_ICON_URL` | *(empty)* | Icon URL for the login button |
| `OIDC_DISABLE_LOCAL_LOGIN` | `false` | Hide the local login form when SSO is enabled |
| `OIDC_AUTO_CREATE_USERS` | `true` | Automatically create accounts for new SSO users |
| `OIDC_DEFAULT_ROLE` | `user` | Default role for auto-created users (`user` or `admin`) |

If SSO is misconfigured and you get locked out, set `FORCE_LOCAL_LOGIN=true` to bypass SSO and log in with your local credentials.

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
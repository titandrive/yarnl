# 🧶 Yarnl - Crochet Project Manager

A web application to help manage your crochet projects with pattern organization, tracking, and stitch counting.

## Features

### 📚 Pattern Library
- **Upload and organize PDF crochet patterns** with automatic thumbnail generation
- **Organize by categories:** Amigurumi, Wearables, Tunisian, Lace/Filet, Colorwork, Freeform, Micro, and Other
- **Smart file naming:** Uploaded patterns use clean filenames based on your pattern names
  - "Pig Pattern" becomes `pig_pattern.pdf`
  - Automatic duplicate handling (e.g., `pig_pattern_2.pdf`)
  - Original filenames preserved when no custom name is provided
- **Rename patterns:** Edit pattern names and the actual file will be renamed on disk
- **Add notes** to patterns for personal reference
- **Custom thumbnails:** Upload your own thumbnail image or use auto-generated ones
- **View patterns** in an integrated PDF viewer with page navigation
- **Track progress:** Remember which page you were on for each pattern
- **Edit and delete** patterns as needed

### 📊 Stitch Counter
- **Track multiple projects** simultaneously with "Current" status
- **Built-in counters** for stitches and rows
- **Custom counters:** Create unlimited named counters for complex patterns
- **Keyboard shortcuts** for quick counting:
  - `+` or `=` to increment stitches
  - `-` to decrement stitches
  - `r` to increment rows
- **Link counters to patterns** from your library
- **Add notes** about your progress
- **Reset counters** when starting fresh

### 🎨 Modern Interface
- **Category-based navigation** for organized pattern browsing
- **Bulk upload support** with progress tracking
- **Thumbnail gallery** view for quick pattern identification
- **Responsive design** that works on desktop and mobile devices

## Quick Start with Docker

### Prerequisites
- Docker installed on your system
- Docker Compose (usually comes with Docker Desktop)

### Running the Application

1. **Clone or download this repository**

2. **Navigate to the project directory**
   ```bash
   cd yarnl
   ```

3. **Build and run with Docker Compose**
   ```bash
   docker-compose up -d
   ```

4. **Access the application**
   Open your browser and go to: `http://localhost:3000`

5. **Stop the application**
   ```bash
   docker-compose down
   ```

### Docker Compose Configuration

The included `docker-compose.yml` sets up:
- **PostgreSQL 16** database with persistent volume
- **Yarnl application** with uploads directory mounted
- **Network** for container communication
- **Health checks** to ensure database is ready

```yaml
services:
  postgres:
    container_name: yarnl-db
    image: postgres:16-alpine
    volumes:
      - yarnl-postgres-data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: yarnl
      POSTGRES_USER: yarnl
      POSTGRES_PASSWORD: yarnl
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U yarnl"]
      interval: 5s
      timeout: 5s
      retries: 5

  yarnl:
    container_name: yarnl
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./uploads:/app/uploads
    environment:
      NODE_ENV: production
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_DB: yarnl
      POSTGRES_USER: yarnl
      POSTGRES_PASSWORD: yarnl
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  yarnl-postgres-data:
```

**Note:** For production use, change the default database password in the environment variables.

## Manual Docker Build

If you prefer to build and run manually:

```bash
# Build the Docker image
docker build -t yarnl .

# Run the container
docker run -d -p 3000:3000 -v $(pwd)/uploads:/app/uploads yarnl

# Stop the container
docker stop <container-id>
```

## Development Setup

If you want to run the application without Docker:

1. **Install Node.js** (version 18 or higher)

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the server**
   ```bash
   npm start
   ```

4. **For development with auto-reload**
   ```bash
   npm run dev
   ```

## Usage Guide

### Adding Patterns

1. Click on the **"Upload"** tab
2. Fill in the pattern details:
   - **Pattern Name** (optional) - Creates a clean filename like `pattern_name.pdf`
   - **Category** (required) - Choose from 8 categories
   - **Notes** (optional) - Add personal notes
   - **PDF File** (required) - Select one or more PDFs
3. Click **"Upload Pattern"** or drag-and-drop files
4. Patterns are automatically organized by category

**Bulk Upload:** Select multiple PDFs to upload them all at once with a progress indicator.

### Managing Patterns

- **Browse by Category:** Use the category tabs to filter patterns
- **View Pattern:** Click **"View PDF"** to open the integrated PDF viewer with page navigation
- **Edit Pattern:** Click **"Edit"** to change the name, category, or notes
  - Renaming a pattern automatically renames the file on disk
- **Mark as Current:** Click **"Add to Current"** to track this pattern in your active projects
- **Delete Pattern:** Click **"Delete"** to remove the pattern (both PDF and metadata)

### Using the PDF Viewer

1. Click **"View PDF"** on any pattern card
2. Use the built-in navigation:
   - Arrow buttons or keyboard arrows to change pages
   - Page number is saved automatically
   - Next time you open the pattern, it returns to your last page
3. Use counters alongside the PDF:
   - Built-in stitch and row counters
   - Create custom counters for pattern sections
   - Use keyboard shortcuts: `+` (stitch), `-` (decrease), `r` (row)

### Using the Stitch Counter

1. Click on the **"Current"** tab to see active projects
2. Each current pattern has its own counter section:
   - **Stitch Count:** Click `+` or press `+` to increment
   - **Row Count:** Click "+1 Row" or press `r` to increment rows
   - **Custom Counters:** Click "Add Counter" to create named counters
3. Keyboard shortcuts work when the page is focused:
   - `+` or `=` to increment stitches
   - `-` to decrement stitches
   - `r` to increment rows
4. **Reset counters:** Click "Reset" to start over
5. **Remove from Current:** Click "Remove from Current" when done with a project

### Custom Counters

For complex patterns with multiple sections:
1. In the Current tab, click **"Add Counter"**
2. Give it a name (e.g., "Sleeve 1", "Round Counter")
3. Use the +/- buttons to track progress
4. Each counter is saved independently

## Data Persistence

Yarnl uses **PostgreSQL** for persistent storage of all pattern metadata, counter data, and project information. Pattern PDFs and thumbnails are stored in the `uploads` folder, which is mounted as a Docker volume.

All your data persists across container restarts:
- ✅ Pattern metadata (names, categories, notes, file references)
- ✅ PDF files and thumbnails
- ✅ Counter values and custom counters
- ✅ Current project status
- ✅ Page positions for each pattern

The database is stored in a Docker volume (`yarnl-postgres-data`), ensuring complete data persistence.

## Browser Support

Yarnl works best in modern browsers:
- Chrome/Edge (recommended)
- Firefox
- Safari

## Recent Updates

### Commit 4a3c451 — Smart File Management (January 2026)
- **Intelligent file naming system** that creates clean filenames from pattern names
- **Automatic file renaming** when you edit pattern names
- **Duplicate handling** with automatic numbering
- Files organized by category in separate directories

### Commit 7924815 — Uploads Cleanup
- Added uploads directory to .gitignore
- Removed tracked upload files from version control
- User-generated content now properly managed via Docker volumes

### Earlier Commits — Full Persistence & Categories
- **PostgreSQL database** for complete data persistence
- **Category organization** with 8 predefined categories
- **Integrated PDF viewer** with persistent page tracking
- **Custom counters** for complex pattern tracking
- **Bulk upload** support with progress indicators

## Future Enhancements

Ideas for future versions:
- Pattern search and advanced filtering
- Project history and statistics visualization
- Mobile app version (native or PWA)
- Export/import project data
- Gauge calculator and conversion tools
- Yarn inventory management
- Pattern sharing and community features
- Integration with Ravelry API

## Technical Stack

- **Backend:** Node.js with Express
- **Database:** PostgreSQL 16
- **Frontend:** Vanilla JavaScript, HTML5, CSS3
- **PDF Processing:** PDF.js for viewing, pdftocairo + Sharp for thumbnails
- **File Storage:** Local filesystem with Docker volume mounts
- **Containerization:** Docker & Docker Compose

## Contributing

Feel free to fork this project and add your own enhancements!

## License

MIT License - feel free to use and modify as needed.

---

Happy crocheting! 🧶✨

# 🧶 Yarnl - Crochet Project Manager

A web application to help manage your crochet projects with pattern organization and stitch counting.

## Features

### 📚 Pattern Library
- Upload and organize PDF crochet patterns
- Add tags and notes to patterns
- Quick access to view patterns
- Delete patterns you no longer need

### 📊 Stitch Counter
- Track stitches and rows in your current project
- Link your current project to a pattern from your library
- Add notes about your progress
- Keyboard shortcuts for quick counting:
  - `+` or `=` to increment stitches
  - `-` to decrement stitches
  - `r` to increment rows
- Reset counters when starting fresh

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

1. Click on the "Pattern Library" tab
2. Fill in the pattern details:
   - Pattern Name (required)
   - Tags (optional, comma-separated)
   - Notes (optional)
   - PDF File (required)
3. Click "Upload Pattern"

### Using the Stitch Counter

1. Click on the "Stitch Counter" tab
2. (Optional) Select a pattern from the dropdown
3. Click the "+" button or press `+` to count stitches
4. Click "−" or press `-` to decrease stitch count
5. Click "+1 Row" or press `r` when completing a row
6. Add notes about your progress in the notes field

### Viewing Patterns

- Click the "View PDF" button on any pattern card to open the PDF in a new tab

### Deleting Patterns

- Click the "Delete" button on any pattern card
- Confirm the deletion when prompted

## Data Persistence

Pattern PDFs are stored in the `uploads` folder, which is mounted as a Docker volume. This means your patterns will persist even if you stop and restart the container.

**Note:** The current version stores pattern metadata and counter state in memory. When the container restarts, you'll need to re-upload pattern information (but the PDF files will still be there). A future version will add database support for full persistence.

## Browser Support

Yarnl works best in modern browsers:
- Chrome/Edge (recommended)
- Firefox
- Safari

## Future Enhancements

Ideas for future versions:
- Database integration for full data persistence
- Project history and statistics
- Multiple concurrent projects
- Pattern search and filtering
- Mobile app version
- Export project data
- Gauge calculator
- Yarn inventory management

## Technical Stack

- **Backend:** Node.js with Express
- **Frontend:** Vanilla JavaScript, HTML5, CSS3
- **File Storage:** Local filesystem
- **Containerization:** Docker

## Contributing

Feel free to fork this project and add your own enhancements!

## License

MIT License - feel free to use and modify as needed.

---

Happy crocheting! 🧶✨

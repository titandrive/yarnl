const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { promisify } = require('util');
const { exec } = require('child_process');
const execPromise = promisify(exec);
const sharp = require('sharp');
const { pool, initDatabase } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Ensure uploads and thumbnails directories exist
const uploadsDir = path.join(__dirname, 'uploads');
const thumbnailsDir = path.join(__dirname, 'uploads', 'thumbnails');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(thumbnailsDir)) {
  fs.mkdirSync(thumbnailsDir, { recursive: true });
}

// Available categories
const CATEGORIES = ['Amigurumi', 'Wearables', 'Tunisian', 'Lace', 'Colorwork', 'Freeform', 'Micro', 'Other'];

// Helper function to sanitize filename
function sanitizeFilename(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// Helper function to find unique filename
function getUniqueFilename(directory, baseName, extension) {
  let filename = `${baseName}${extension}`;
  let counter = 2;

  while (fs.existsSync(path.join(directory, filename))) {
    filename = `${baseName}_${counter}${extension}`;
    counter++;
  }

  return filename;
}

// Helper function to clean up empty category directories
async function cleanupEmptyCategories() {
  try {
    const entries = fs.readdirSync(uploadsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'thumbnails') continue; // Skip thumbnails directory

      const categoryPath = path.join(uploadsDir, entry.name);
      const files = fs.readdirSync(categoryPath);

      // If directory is empty, remove it
      if (files.length === 0) {
        fs.rmdirSync(categoryPath);
        console.log(`Removed empty category directory: ${entry.name}`);
      }
    }
  } catch (error) {
    console.error('Error cleaning up empty categories:', error);
  }
}

// Configure multer for PDF uploads
// Note: req.body is NOT available in these callbacks, so we use temp filenames
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Use a temp directory - we'll move to category folder after upload
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Use temp filename - we'll rename based on req.body.name after upload completes
    const tempFilename = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${file.originalname}`;
    cb(null, tempFilename);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

// Helper function to generate thumbnail from PDF
async function generateThumbnail(pdfPath, outputFilename) {
  try {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFile = path.join(tempDir, `temp-${Date.now()}.png`);

    // Use pdftocairo to convert first page to PNG
    await execPromise(`pdftocairo -png -f 1 -l 1 -singlefile "${pdfPath}" "${tempFile.replace('.png', '')}"`);

    if (!fs.existsSync(tempFile)) {
      console.error('Temp file not created');
      return null;
    }

    // Resize to thumbnail size
    const thumbnailPath = path.join(thumbnailsDir, outputFilename);
    await sharp(tempFile)
      .resize(300, 400, {
        fit: 'cover',
        position: 'top'
      })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath);

    // Clean up temp file
    fs.unlinkSync(tempFile);

    return outputFilename;
  } catch (error) {
    console.error('Error generating thumbnail:', error);
    return null;
  }
}

// Database will be initialized on startup
initDatabase().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Routes

// Get all patterns
app.get('/api/patterns', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM patterns ORDER BY upload_date DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching patterns:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload a new pattern
app.post('/api/patterns', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const name = req.body.name || req.file.originalname.replace('.pdf', '');
    const category = req.body.category || 'Amigurumi';
    const description = req.body.description || '';
    const isCurrent = req.body.isCurrent === 'true' || req.body.isCurrent === true;

    console.log('Upload received:');
    console.log('  - req.body.name:', req.body.name);
    console.log('  - computed name:', name);
    console.log('  - req.file.filename:', req.file.filename);
    console.log('  - req.file.originalname:', req.file.originalname);

    // Now we have access to req.body! Determine the final filename
    const categoryDir = path.join(uploadsDir, category);

    let finalFilename;
    if (req.body.name) {
      // User provided a custom name
      const sanitized = sanitizeFilename(req.body.name);
      finalFilename = getUniqueFilename(categoryDir, sanitized, '.pdf');
    } else {
      // No custom name, use original filename
      finalFilename = req.file.originalname;
    }

    // Create category directory only when we're about to move a file there
    if (!fs.existsSync(categoryDir)) {
      fs.mkdirSync(categoryDir, { recursive: true });
    }

    // Move file from temp location to category folder with final name
    const tempPath = req.file.path;
    const finalPath = path.join(categoryDir, finalFilename);
    fs.renameSync(tempPath, finalPath);

    console.log(`Moved file from ${tempPath} to ${finalPath}`);

    // Generate thumbnail from PDF
    const pdfPath = finalPath;
    const thumbnailFilename = `thumb-${category}-${finalFilename}.jpg`;
    const thumbnail = await generateThumbnail(pdfPath, thumbnailFilename);

    const result = await pool.query(
      `INSERT INTO patterns (name, filename, original_name, category, description, is_current, thumbnail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [name, finalFilename, req.file.originalname, category, description, isCurrent, thumbnail]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error uploading pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a specific pattern PDF (must come before /api/patterns/:id)
app.get('/api/patterns/:id/file', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM patterns WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    const pattern = result.rows[0];
    let filePath = path.join(uploadsDir, pattern.category, pattern.filename);

    // Check if file exists in category folder, otherwise check root uploads folder (for legacy files)
    if (!fs.existsSync(filePath)) {
      filePath = path.join(uploadsDir, pattern.filename);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
      }
    }

    res.sendFile(filePath);
  } catch (error) {
    console.error('Error fetching pattern file:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a pattern thumbnail
app.get('/api/patterns/:id/thumbnail', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM patterns WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    const pattern = result.rows[0];
    if (!pattern.thumbnail) {
      return res.status(404).json({ error: 'Thumbnail not found' });
    }

    const thumbnailPath = path.join(thumbnailsDir, pattern.thumbnail);

    if (!fs.existsSync(thumbnailPath)) {
      return res.status(404).json({ error: 'Thumbnail file not found' });
    }

    res.sendFile(thumbnailPath);
  } catch (error) {
    console.error('Error fetching thumbnail:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get current patterns (must come before /api/patterns/:id)
app.get('/api/patterns/current', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM patterns WHERE is_current = true ORDER BY updated_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching current patterns:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a single pattern by ID (must come after all /api/patterns/:id/something routes)
app.get('/api/patterns/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM patterns WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update pattern details
app.patch('/api/patterns/:id', async (req, res) => {
  try {
    console.log('PATCH request body:', req.body);
    const { name, description, category } = req.body;
    console.log('Extracted values:', { name, description, category });

    // Get the current pattern data to check if we need to move the file
    const currentPattern = await pool.query(
      'SELECT * FROM patterns WHERE id = $1',
      [req.params.id]
    );

    if (currentPattern.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    const pattern = currentPattern.rows[0];
    let newFilename = pattern.filename;

    // Determine the working category (use new category if changing, otherwise current)
    const workingCategory = category !== undefined ? category : pattern.category;
    const categoryDir = path.join(uploadsDir, workingCategory);

    // Find current file location (check category folder first, then root)
    let oldFilePath = path.join(uploadsDir, pattern.category, pattern.filename);
    console.log(`Checking for file at: ${oldFilePath}`);

    if (!fs.existsSync(oldFilePath)) {
      oldFilePath = path.join(uploadsDir, pattern.filename);
      console.log(`Not found, checking root: ${oldFilePath}`);
    }

    if (!fs.existsSync(oldFilePath)) {
      console.log(`File not found at ${oldFilePath}, skipping file operations`);
    } else {
      console.log(`File found at: ${oldFilePath}`);

      // If name is being changed, rename the file
      if (name !== undefined && name !== pattern.name) {
        console.log(`Name changing from "${pattern.name}" to "${name}"`);

        // Generate new filename from the new name
        const sanitized = sanitizeFilename(name);
        const extension = path.extname(pattern.filename);
        newFilename = getUniqueFilename(categoryDir, sanitized, extension);
        console.log(`New filename will be: ${newFilename}`);
      }

      // If category is being changed, move the file
      if (category !== undefined && category !== pattern.category) {
        console.log(`Category changing from "${pattern.category}" to "${category}"`);
      }

      // Perform the file move/rename if needed
      const newFilePath = path.join(categoryDir, newFilename);
      if (oldFilePath !== newFilePath) {
        // Create category directory only when we're about to move a file there
        if (!fs.existsSync(categoryDir)) {
          fs.mkdirSync(categoryDir, { recursive: true });
          console.log(`Created directory: ${categoryDir}`);
        }

        fs.renameSync(oldFilePath, newFilePath);
        console.log(`Successfully moved/renamed file from ${oldFilePath} to ${newFilePath}`);

        // Update thumbnail filename if it exists
        if (pattern.thumbnail && newFilename !== pattern.filename) {
          const oldThumbnailPath = path.join(thumbnailsDir, pattern.thumbnail);
          if (fs.existsSync(oldThumbnailPath)) {
            const newThumbnailFilename = `thumb-${workingCategory}-${newFilename}.jpg`;
            const newThumbnailPath = path.join(thumbnailsDir, newThumbnailFilename);
            fs.renameSync(oldThumbnailPath, newThumbnailPath);
            console.log(`Renamed thumbnail from ${pattern.thumbnail} to ${newThumbnailFilename}`);

            // Update thumbnail in database
            await pool.query(
              'UPDATE patterns SET thumbnail = $1 WHERE id = $2',
              [newThumbnailFilename, req.params.id]
            );
          }
        }
      }
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (category !== undefined) {
      updates.push(`category = $${paramCount++}`);
      values.push(category);
    }

    // Update filename if it changed
    if (newFilename !== pattern.filename) {
      updates.push(`filename = $${paramCount++}`);
      values.push(newFilename);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(req.params.id);

    const query = `
      UPDATE patterns
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    // Clean up empty category directories after potential category change
    await cleanupEmptyCategories();

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a pattern
app.delete('/api/patterns/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM patterns WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    const pattern = result.rows[0];
    let filePath = path.join(uploadsDir, pattern.category, pattern.filename);

    // Delete the file (check category folder first, then root for legacy files)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    } else {
      filePath = path.join(uploadsDir, pattern.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    // Delete the thumbnail
    if (pattern.thumbnail) {
      const thumbnailPath = path.join(thumbnailsDir, pattern.thumbnail);
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
    }

    await pool.query('DELETE FROM patterns WHERE id = $1', [req.params.id]);

    // Clean up empty category directories after deletion
    await cleanupEmptyCategories();

    res.json({ message: 'Pattern deleted successfully' });
  } catch (error) {
    console.error('Error deleting pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all available categories for editing/uploading (all possible categories)
app.get('/api/categories/all', async (req, res) => {
  try {
    res.json(CATEGORIES);
  } catch (error) {
    console.error('Error fetching all categories:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get populated categories (only those with patterns) with counts for filtering
app.get('/api/categories', async (req, res) => {
  try {
    // Query database for categories with pattern counts
    const result = await pool.query(
      `SELECT category, COUNT(*) as count
       FROM patterns
       GROUP BY category
       ORDER BY category`
    );
    const categoriesWithCounts = result.rows.map(row => ({
      name: row.category,
      count: parseInt(row.count)
    }));
    res.json(categoriesWithCounts);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: error.message });
  }
});

// Toggle pattern current status
app.patch('/api/patterns/:id/current', async (req, res) => {
  try {
    const { isCurrent } = req.body;

    // When marking as current, un-complete it (but keep completed_date for history)
    const result = await pool.query(
      `UPDATE patterns
       SET is_current = $1,
           completed = CASE WHEN $1 = true THEN false ELSE completed END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [isCurrent, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating pattern status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Toggle pattern completion status
app.patch('/api/patterns/:id/complete', async (req, res) => {
  try {
    const { completed } = req.body;
    const completedDate = completed ? 'CURRENT_TIMESTAMP' : 'NULL';

    // When marking as complete, remove from current. When marking incomplete, keep current status unchanged
    const result = await pool.query(
      `UPDATE patterns
       SET completed = $1,
           completed_date = ${completedDate},
           is_current = CASE WHEN $1 = true THEN false ELSE is_current END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [completed, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating completion status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Increment stitch count for a pattern
app.post('/api/patterns/:id/increment-stitch', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE patterns
       SET stitch_count = stitch_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error incrementing stitch:', error);
    res.status(500).json({ error: error.message });
  }
});

// Decrement stitch count for a pattern
app.post('/api/patterns/:id/decrement-stitch', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE patterns
       SET stitch_count = GREATEST(stitch_count - 1, 0), updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error decrementing stitch:', error);
    res.status(500).json({ error: error.message });
  }
});

// Increment row count for a pattern
app.post('/api/patterns/:id/increment-row', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE patterns
       SET row_count = row_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error incrementing row:', error);
    res.status(500).json({ error: error.message });
  }
});

// Decrement row count for a pattern
app.post('/api/patterns/:id/decrement-row', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE patterns
       SET row_count = GREATEST(row_count - 1, 0), updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error decrementing row:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reset counters for a pattern
app.post('/api/patterns/:id/reset', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE patterns
       SET stitch_count = 0, row_count = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error resetting counters:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update pattern's current page
app.patch('/api/patterns/:id/page', async (req, res) => {
  try {
    const { currentPage } = req.body;
    const result = await pool.query(
      `UPDATE patterns SET current_page = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [currentPage, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating page:', error);
    res.status(500).json({ error: error.message });
  }
});

// Counter endpoints

// Get all counters for a pattern
app.get('/api/patterns/:id/counters', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM counters WHERE pattern_id = $1 ORDER BY position ASC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching counters:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a new counter for a pattern
app.post('/api/patterns/:id/counters', async (req, res) => {
  try {
    const { name, value = 0 } = req.body;

    // Get the max position for this pattern
    const maxPosResult = await pool.query(
      'SELECT COALESCE(MAX(position), -1) as max_pos FROM counters WHERE pattern_id = $1',
      [req.params.id]
    );
    const position = maxPosResult.rows[0].max_pos + 1;

    const result = await pool.query(
      `INSERT INTO counters (pattern_id, name, value, position)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.params.id, name, value, position]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating counter:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update a counter's value
app.patch('/api/counters/:id', async (req, res) => {
  try {
    const { value, name } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (value !== undefined) {
      updates.push(`value = $${paramCount++}`);
      values.push(value);
    }
    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(req.params.id);

    const query = `
      UPDATE counters
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Counter not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating counter:', error);
    res.status(500).json({ error: error.message });
  }
});

// Increment counter
app.post('/api/counters/:id/increment', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE counters
       SET value = value + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Counter not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error incrementing counter:', error);
    res.status(500).json({ error: error.message });
  }
});

// Decrement counter
app.post('/api/counters/:id/decrement', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE counters
       SET value = GREATEST(value - 1, 0), updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Counter not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error decrementing counter:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a counter
app.delete('/api/counters/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM counters WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Counter not found' });
    }

    res.json({ message: 'Counter deleted successfully' });
  } catch (error) {
    console.error('Error deleting counter:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload custom thumbnail for a pattern
app.post('/api/patterns/:id/thumbnail', upload.single('thumbnail'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Get current pattern to delete old thumbnail
    const patternResult = await pool.query(
      'SELECT * FROM patterns WHERE id = $1',
      [req.params.id]
    );

    if (patternResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    const pattern = patternResult.rows[0];

    // Process uploaded image as thumbnail
    const thumbnailFilename = `thumb-custom-${Date.now()}.jpg`;
    const thumbnailPath = path.join(thumbnailsDir, thumbnailFilename);

    await sharp(req.file.path)
      .resize(300, 400, {
        fit: 'cover',
        position: 'center'
      })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath);

    // Delete the uploaded temp file
    fs.unlinkSync(req.file.path);

    // Delete old thumbnail if it exists
    if (pattern.thumbnail) {
      const oldThumbnailPath = path.join(thumbnailsDir, pattern.thumbnail);
      if (fs.existsSync(oldThumbnailPath)) {
        fs.unlinkSync(oldThumbnailPath);
      }
    }

    // Update database with new thumbnail
    const result = await pool.query(
      `UPDATE patterns
       SET thumbnail = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [thumbnailFilename, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error uploading thumbnail:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Yarnl server running on http://0.0.0.0:${PORT}`);
});

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { promisify } = require('util');
const { exec } = require('child_process');
const execPromise = promisify(exec);
const sharp = require('sharp');
const pdfParse = require('pdf-parse');
const archiver = require('archiver');
const unzipper = require('unzipper');
const { pool, initDatabase } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Ensure patterns and thumbnails directories exist
const patternsDir = path.join(__dirname, 'patterns');
const thumbnailsDir = path.join(__dirname, 'patterns', 'thumbnails');
if (!fs.existsSync(patternsDir)) {
  fs.mkdirSync(patternsDir, { recursive: true });
}
if (!fs.existsSync(thumbnailsDir)) {
  fs.mkdirSync(thumbnailsDir, { recursive: true });
}

// Helper function to get category folder path
function getCategoryDir(categoryName) {
  return path.join(patternsDir, categoryName);
}

// Helper function to ensure category folder exists
function ensureCategoryDir(categoryName) {
  const categoryDir = getCategoryDir(categoryName);
  if (!fs.existsSync(categoryDir)) {
    fs.mkdirSync(categoryDir, { recursive: true });
  }
  return categoryDir;
}

// Helper function to remove category folder (only if empty)
function removeCategoryDir(categoryName) {
  const categoryDir = getCategoryDir(categoryName);
  if (fs.existsSync(categoryDir)) {
    try {
      fs.rmdirSync(categoryDir);
    } catch (err) {
      // Folder not empty or other error - ignore
      console.log(`Could not remove category folder: ${categoryDir}`);
    }
  }
}

// Helper function to rename category folder
function renameCategoryDir(oldName, newName) {
  const oldDir = getCategoryDir(oldName);
  const newDir = getCategoryDir(newName);
  if (fs.existsSync(oldDir)) {
    fs.renameSync(oldDir, newDir);
  } else {
    // Old folder doesn't exist, just create the new one
    ensureCategoryDir(newName);
  }
}

// Sync category folders with database on startup
async function syncCategoryFolders() {
  try {
    const result = await pool.query('SELECT name FROM categories');
    const categories = result.rows.map(r => r.name);

    // Create folders for all categories
    for (const category of categories) {
      ensureCategoryDir(category);
    }
    console.log('Category folders synced');
  } catch (error) {
    console.error('Error syncing category folders:', error);
  }
}

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
    const entries = fs.readdirSync(patternsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'thumbnails') continue; // Skip thumbnails directory

      const categoryPath = path.join(patternsDir, entry.name);
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
    cb(null, patternsDir);
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

// Separate upload handler for images (thumbnails)
const imageUpload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit for images
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
initDatabase()
  .then(() => syncCategoryFolders())
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

// Routes

// Get all patterns with their hashtags
app.get('/api/patterns', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM patterns ORDER BY upload_date DESC'
    );

    // Fetch hashtags for each pattern
    const patterns = await Promise.all(result.rows.map(async (pattern) => {
      const hashtagsResult = await pool.query(
        `SELECT h.* FROM hashtags h
         JOIN pattern_hashtags ph ON h.id = ph.hashtag_id
         WHERE ph.pattern_id = $1
         ORDER BY h.name`,
        [pattern.id]
      );
      return { ...pattern, hashtags: hashtagsResult.rows };
    }));

    res.json(patterns);
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
    const categoryDir = path.join(patternsDir, category);

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

// Create a new markdown pattern
app.post('/api/patterns/markdown', async (req, res) => {
  try {
    const { name, category, description, content, isCurrent, hashtagIds } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Pattern name is required' });
    }

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Pattern content is required' });
    }

    const patternCategory = category || 'Amigurumi';
    const patternDescription = description || '';
    const patternIsCurrent = isCurrent === true || isCurrent === 'true';

    // Create category directory if needed
    const categoryDir = ensureCategoryDir(patternCategory);

    // Create a unique filename based on the pattern name
    const sanitizedName = sanitizeFilename(name);
    const filename = getUniqueFilename(categoryDir, sanitizedName, '.md');

    // Save the markdown file to disk
    const filePath = path.join(categoryDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');

    const result = await pool.query(
      `INSERT INTO patterns (name, filename, original_name, category, description, is_current, pattern_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'markdown')
       RETURNING *`,
      [name.trim(), filename, filename, patternCategory, patternDescription, patternIsCurrent]
    );

    const pattern = result.rows[0];

    // Save hashtags if provided
    if (hashtagIds && hashtagIds.length > 0) {
      for (const hashtagId of hashtagIds) {
        await pool.query(
          'INSERT INTO pattern_hashtags (pattern_id, hashtag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [pattern.id, hashtagId]
        );
      }
    }

    // Fetch hashtags to include in response
    const hashtagsResult = await pool.query(
      `SELECT h.* FROM hashtags h
       JOIN pattern_hashtags ph ON h.id = ph.hashtag_id
       WHERE ph.pattern_id = $1
       ORDER BY h.name`,
      [pattern.id]
    );

    res.json({ ...pattern, hashtags: hashtagsResult.rows });
  } catch (error) {
    console.error('Error creating markdown pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get markdown content for a pattern
app.get('/api/patterns/:id/content', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT filename, category, pattern_type FROM patterns WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    const pattern = result.rows[0];
    if (pattern.pattern_type !== 'markdown') {
      return res.status(400).json({ error: 'Pattern is not a markdown pattern' });
    }

    // Read content from file
    let filePath = path.join(patternsDir, pattern.category, pattern.filename);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(patternsDir, pattern.filename);
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Pattern file not found' });
    }

    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ content });
  } catch (error) {
    console.error('Error fetching pattern content:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update markdown content for a pattern
app.put('/api/patterns/:id/content', async (req, res) => {
  try {
    const { content } = req.body;

    // First get the pattern details
    const checkResult = await pool.query(
      'SELECT filename, category, pattern_type FROM patterns WHERE id = $1',
      [req.params.id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    const pattern = checkResult.rows[0];
    if (pattern.pattern_type !== 'markdown') {
      return res.status(400).json({ error: 'Pattern is not a markdown pattern' });
    }

    // Write content to file
    let filePath = path.join(patternsDir, pattern.category, pattern.filename);
    if (!fs.existsSync(path.dirname(filePath))) {
      filePath = path.join(patternsDir, pattern.filename);
    }

    fs.writeFileSync(filePath, content || '', 'utf8');

    // Update timestamp in database
    await pool.query(
      'UPDATE patterns SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [req.params.id]
    );

    res.json({ content: content || '' });
  } catch (error) {
    console.error('Error updating pattern content:', error);
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
    let filePath = path.join(patternsDir, pattern.category, pattern.filename);

    // Check if file exists in category folder, otherwise check root patterns folder (for legacy files)
    if (!fs.existsSync(filePath)) {
      filePath = path.join(patternsDir, pattern.filename);
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

    // Fetch hashtags for each pattern
    const patterns = await Promise.all(result.rows.map(async (pattern) => {
      const hashtagsResult = await pool.query(
        `SELECT h.* FROM hashtags h
         JOIN pattern_hashtags ph ON h.id = ph.hashtag_id
         WHERE ph.pattern_id = $1
         ORDER BY h.name`,
        [pattern.id]
      );
      return { ...pattern, hashtags: hashtagsResult.rows };
    }));

    res.json(patterns);
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

    // Fetch hashtags for the pattern
    const hashtagsResult = await pool.query(
      `SELECT h.* FROM hashtags h
       JOIN pattern_hashtags ph ON h.id = ph.hashtag_id
       WHERE ph.pattern_id = $1
       ORDER BY h.name`,
      [req.params.id]
    );

    res.json({ ...result.rows[0], hashtags: hashtagsResult.rows });
  } catch (error) {
    console.error('Error fetching pattern:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get pattern info (metadata including file size)
app.get('/api/patterns/:id/info', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM patterns WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    const pattern = result.rows[0];
    let filePath = path.join(patternsDir, pattern.category, pattern.filename);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(patternsDir, pattern.filename);
    }

    let fileSize = 0;
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      fileSize = stats.size;
    }

    // Extract PDF metadata if it's a PDF
    let pdfMetadata = null;
    if (pattern.pattern_type === 'pdf' && fs.existsSync(filePath)) {
      try {
        const dataBuffer = fs.readFileSync(filePath);
        const pdfData = await pdfParse(dataBuffer);
        pdfMetadata = {
          title: pdfData.info?.Title || null,
          author: pdfData.info?.Author || null,
          subject: pdfData.info?.Subject || null,
          creator: pdfData.info?.Creator || null,
          producer: pdfData.info?.Producer || null,
          creationDate: pdfData.info?.CreationDate || null,
          modDate: pdfData.info?.ModDate || null,
          pageCount: pdfData.numpages || null
        };
      } catch (pdfError) {
        console.error('Error parsing PDF metadata:', pdfError.message);
      }
    }

    res.json({
      id: pattern.id,
      name: pattern.name,
      filename: pattern.filename,
      category: pattern.category,
      pattern_type: pattern.pattern_type,
      description: pattern.description,
      upload_date: pattern.upload_date,
      completed: pattern.completed,
      completed_date: pattern.completed_date,
      timer_seconds: pattern.timer_seconds,
      is_current: pattern.is_current,
      file_size: fileSize,
      file_path: filePath,
      pdf_metadata: pdfMetadata
    });
  } catch (error) {
    console.error('Error fetching pattern info:', error);
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
    const categoryDir = path.join(patternsDir, workingCategory);

    // Find current file location (check category folder first, then root)
    let oldFilePath = path.join(patternsDir, pattern.category, pattern.filename);
    console.log(`Checking for file at: ${oldFilePath}`);

    if (!fs.existsSync(oldFilePath)) {
      oldFilePath = path.join(patternsDir, pattern.filename);
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
    let filePath = path.join(patternsDir, pattern.category, pattern.filename);

    // Delete the file (check category folder first, then root for legacy files)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    } else {
      filePath = path.join(patternsDir, pattern.filename);
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
    const result = await pool.query('SELECT name FROM categories ORDER BY position, name');
    const categories = result.rows.map(row => row.name);
    res.json(categories);
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

// Add a new category
app.post('/api/categories', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    // Get the next position
    const posResult = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM categories');
    const nextPos = posResult.rows[0].next_pos;

    await pool.query(
      'INSERT INTO categories (name, position) VALUES ($1, $2)',
      [name.trim(), nextPos]
    );

    // Create the category folder
    ensureCategoryDir(name.trim());

    res.status(201).json({ message: 'Category created', name: name.trim() });
  } catch (error) {
    if (error.code === '23505') { // unique violation
      return res.status(400).json({ error: 'Category already exists' });
    }
    console.error('Error creating category:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update a category name
app.put('/api/categories/:name', async (req, res) => {
  try {
    const oldName = req.params.name;
    const { name: newName } = req.body;

    if (!newName || !newName.trim()) {
      return res.status(400).json({ error: 'New category name is required' });
    }

    // Update the category name
    const result = await pool.query(
      'UPDATE categories SET name = $1 WHERE name = $2 RETURNING *',
      [newName.trim(), oldName]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Update all patterns with this category
    await pool.query(
      'UPDATE patterns SET category = $1 WHERE category = $2',
      [newName.trim(), oldName]
    );

    // Rename the category folder
    renameCategoryDir(oldName, newName.trim());

    res.json({ message: 'Category updated', oldName, newName: newName.trim() });
  } catch (error) {
    if (error.code === '23505') { // unique violation
      return res.status(400).json({ error: 'Category name already exists' });
    }
    console.error('Error updating category:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a category
app.delete('/api/categories/:name', async (req, res) => {
  try {
    const { name } = req.params;

    // Check if any patterns use this category
    const patternCheck = await pool.query(
      'SELECT COUNT(*) FROM patterns WHERE category = $1',
      [name]
    );

    if (parseInt(patternCheck.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot delete category with existing patterns' });
    }

    const result = await pool.query('DELETE FROM categories WHERE name = $1 RETURNING *', [name]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Remove the category folder
    removeCategoryDir(name);

    res.json({ message: 'Category deleted', name });
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({ error: error.message });
  }
});

// Hashtag endpoints

// Get all hashtags
app.get('/api/hashtags', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM hashtags ORDER BY position, name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching hashtags:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add a new hashtag
app.post('/api/hashtags', async (req, res) => {
  try {
    let { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Hashtag name is required' });
    }

    // Remove # if provided and normalize
    name = name.trim().replace(/^#/, '').toLowerCase();

    // Get the next position
    const posResult = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM hashtags');
    const nextPos = posResult.rows[0].next_pos;

    const result = await pool.query(
      'INSERT INTO hashtags (name, position) VALUES ($1, $2) RETURNING *',
      [name, nextPos]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') { // unique violation
      return res.status(400).json({ error: 'Hashtag already exists' });
    }
    console.error('Error creating hashtag:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update a hashtag name
app.put('/api/hashtags/:id', async (req, res) => {
  try {
    let { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'New hashtag name is required' });
    }

    name = name.trim().replace(/^#/, '').toLowerCase();

    const result = await pool.query(
      'UPDATE hashtags SET name = $1 WHERE id = $2 RETURNING *',
      [name, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Hashtag not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Hashtag name already exists' });
    }
    console.error('Error updating hashtag:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a hashtag
app.delete('/api/hashtags/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM hashtags WHERE id = $1 RETURNING *', [req.params.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Hashtag not found' });
    }

    res.json({ message: 'Hashtag deleted' });
  } catch (error) {
    console.error('Error deleting hashtag:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get hashtags for a pattern
app.get('/api/patterns/:id/hashtags', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT h.* FROM hashtags h
       JOIN pattern_hashtags ph ON h.id = ph.hashtag_id
       WHERE ph.pattern_id = $1
       ORDER BY h.name`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching pattern hashtags:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set hashtags for a pattern (replaces existing)
app.put('/api/patterns/:id/hashtags', async (req, res) => {
  try {
    const { hashtagIds } = req.body;
    const patternId = req.params.id;

    // Delete existing associations
    await pool.query('DELETE FROM pattern_hashtags WHERE pattern_id = $1', [patternId]);

    // Insert new associations
    if (hashtagIds && hashtagIds.length > 0) {
      for (const hashtagId of hashtagIds) {
        await pool.query(
          'INSERT INTO pattern_hashtags (pattern_id, hashtag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [patternId, hashtagId]
        );
      }
    }

    // Return updated hashtags
    const result = await pool.query(
      `SELECT h.* FROM hashtags h
       JOIN pattern_hashtags ph ON h.id = ph.hashtag_id
       WHERE ph.pattern_id = $1
       ORDER BY h.name`,
      [patternId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error setting pattern hashtags:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get notes for a pattern
app.get('/api/patterns/:id/notes', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT notes FROM patterns WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    res.json({ notes: result.rows[0].notes || '' });
  } catch (error) {
    console.error('Error fetching notes:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update notes for a pattern
app.put('/api/patterns/:id/notes', async (req, res) => {
  try {
    const { notes } = req.body;

    const result = await pool.query(
      'UPDATE patterns SET notes = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING notes',
      [notes || '', req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    res.json({ notes: result.rows[0].notes });
  } catch (error) {
    console.error('Error updating notes:', error);
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

// Reset counter to zero
app.post('/api/counters/:id/reset', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE counters
       SET value = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Counter not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error resetting counter:', error);
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

// Get library stats
app.get('/api/stats', async (req, res) => {
  try {
    // Get total patterns count
    const totalResult = await pool.query('SELECT COUNT(*) as count FROM patterns');
    const totalPatterns = parseInt(totalResult.rows[0].count);

    // Get current patterns count
    const currentResult = await pool.query('SELECT COUNT(*) as count FROM patterns WHERE is_current = true');
    const currentPatterns = parseInt(currentResult.rows[0].count);

    // Get completed patterns count
    const completedResult = await pool.query('SELECT COUNT(*) as count FROM patterns WHERE completed = true');
    const completedPatterns = parseInt(completedResult.rows[0].count);

    // Get total time spent
    const timeResult = await pool.query('SELECT COALESCE(SUM(timer_seconds), 0) as total FROM patterns');
    const totalTimeSeconds = parseInt(timeResult.rows[0].total);

    // Get count of patterns with time logged
    const patternsWithTimeResult = await pool.query('SELECT COUNT(*) as count FROM patterns WHERE timer_seconds > 0');
    const patternsWithTime = parseInt(patternsWithTimeResult.rows[0].count);

    // Get patterns by category
    const categoriesResult = await pool.query(
      `SELECT category, COUNT(*) as count FROM patterns GROUP BY category ORDER BY count DESC`
    );
    const patternsByCategory = categoriesResult.rows.map(row => ({
      name: row.category,
      count: parseInt(row.count)
    }));

    // Calculate total library size from files
    let totalSize = 0;
    const patterns = await pool.query('SELECT filename, category FROM patterns');
    for (const pattern of patterns.rows) {
      let filePath = path.join(patternsDir, pattern.category, pattern.filename);
      if (!fs.existsSync(filePath)) {
        filePath = path.join(patternsDir, pattern.filename);
      }
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        totalSize += stats.size;
      }
    }

    res.json({
      totalPatterns,
      currentPatterns,
      completedPatterns,
      totalTimeSeconds,
      patternsWithTime,
      patternsByCategory,
      totalSize,
      libraryPath: '/opt/yarnl/patterns',
      backupHostPath: process.env.BACKUP_HOST_PATH || './backups'
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload custom thumbnail for a pattern
app.post('/api/patterns/:id/thumbnail', imageUpload.single('thumbnail'), async (req, res) => {
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

// Upload image for markdown content (returns URL to insert)
app.post('/api/images', imageUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Create images directory if it doesn't exist
    const imagesDir = path.join(__dirname, 'patterns', 'images');
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    // Get pattern name from request body (sent along with the image)
    const patternName = req.body.patternName || 'image';
    // Sanitize pattern name for filename (remove special chars, limit length)
    const safeName = patternName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50) || 'image';

    // Generate unique filename with pattern name prefix
    const filename = `${safeName}-${Date.now()}.jpg`;
    const outputPath = path.join(imagesDir, filename);

    // Process and save image (resize if too large, optimize)
    await sharp(req.file.path)
      .resize(1200, 1200, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 85 })
      .toFile(outputPath);

    // Delete temp file
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    // Return URL for markdown
    const imageUrl = `/api/images/${filename}`;
    res.json({ url: imageUrl, filename });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to get all text content that might reference images
async function getAllImageReferences() {
  let allContent = '';

  // Get all notes from patterns (PDF notes)
  const result = await pool.query('SELECT notes FROM patterns WHERE notes IS NOT NULL');
  allContent += result.rows.map(r => r.notes || '').join('\n');

  // Get content from all markdown files in patterns directory
  const categories = fs.readdirSync(patternsDir).filter(f => {
    const fullPath = path.join(patternsDir, f);
    return fs.statSync(fullPath).isDirectory() && f !== 'images' && f !== 'thumbnails';
  });

  for (const category of categories) {
    const categoryPath = path.join(patternsDir, category);
    const files = fs.readdirSync(categoryPath).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(categoryPath, file);
      allContent += '\n' + fs.readFileSync(filePath, 'utf8');
    }
  }

  return allContent;
}

// Get orphaned images count (for UI display) - must be before :filename route
app.get('/api/images/orphaned', async (req, res) => {
  try {
    const imagesDir = path.join(__dirname, 'patterns', 'images');

    if (!fs.existsSync(imagesDir)) {
      return res.json({ count: 0, files: [] });
    }

    // Get all image files
    const files = fs.readdirSync(imagesDir).filter(f => f.endsWith('.jpg'));

    // Get all content that might reference images (notes + markdown files)
    const allContent = await getAllImageReferences();

    // Find orphaned images
    const orphaned = files.filter(file => !allContent.includes(file));

    res.json({ count: orphaned.length, files: orphaned });
  } catch (error) {
    console.error('Error checking orphaned images:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get images directory size for backup estimates - must be before :filename route
app.get('/api/images/stats', async (req, res) => {
  try {
    const imagesDir = path.join(__dirname, 'patterns', 'images');
    let totalSize = 0;
    let count = 0;

    if (fs.existsSync(imagesDir)) {
      const files = fs.readdirSync(imagesDir);
      for (const file of files) {
        const filePath = path.join(imagesDir, file);
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          totalSize += stat.size;
          count++;
        }
      }
    }

    res.json({ totalSize, count });
  } catch (error) {
    console.error('Error getting images stats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clean up orphaned images (images not referenced anywhere)
app.post('/api/images/cleanup', async (req, res) => {
  try {
    const imagesDir = path.join(__dirname, 'patterns', 'images');

    if (!fs.existsSync(imagesDir)) {
      return res.json({ deleted: [], count: 0 });
    }

    // Get all image files
    const files = fs.readdirSync(imagesDir).filter(f => f.endsWith('.jpg'));

    // Get all content that might reference images (notes + markdown files)
    const allContent = await getAllImageReferences();

    // Find orphaned images (not referenced anywhere)
    const orphaned = files.filter(file => !allContent.includes(file));

    // Delete orphaned files
    for (const file of orphaned) {
      const filePath = path.join(imagesDir, file);
      fs.unlinkSync(filePath);
    }

    res.json({ deleted: orphaned, count: orphaned.length });
  } catch (error) {
    console.error('Error cleaning up images:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve uploaded images - must be LAST of /api/images routes (catches :filename)
app.get('/api/images/:filename', (req, res) => {
  const imagesDir = path.join(__dirname, 'patterns', 'images');
  const filePath = path.join(imagesDir, req.params.filename);

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Image not found' });
  }
});

// Update timer for a pattern
app.put('/api/patterns/:id/timer', async (req, res) => {
  try {
    const { timer_seconds } = req.body;
    const result = await pool.query(
      `UPDATE patterns
       SET timer_seconds = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [timer_seconds, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pattern not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating timer:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// BACKUP & RESTORE ENDPOINTS
// ============================================

const backupsDir = path.join(__dirname, 'backups');
if (!fs.existsSync(backupsDir)) {
  fs.mkdirSync(backupsDir, { recursive: true });
}

// List all backups
app.get('/api/backups', (req, res) => {
  try {
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.endsWith('.zip'))
      .map(f => {
        const stats = fs.statSync(path.join(backupsDir, f));
        return {
          filename: f,
          size: stats.size,
          created: stats.mtime
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json(files);
  } catch (error) {
    console.error('Error listing backups:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a new backup
app.post('/api/backups', async (req, res) => {
  try {
    const { clientSettings, includePatterns = true, includeImages = true } = req.body;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFilename = `yarnl-backup-${timestamp}.zip`;
    const backupPath = path.join(backupsDir, backupFilename);

    // Export database tables to JSON
    const dbExport = {
      exportDate: new Date().toISOString(),
      version: '1.0',
      account: null, // For future user accounts
      includePatterns,
      includeImages,
      tables: {}
    };

    // Export all tables in proper order for restore
    const tables = ['categories', 'hashtags', 'patterns', 'counters', 'pattern_hashtags'];
    for (const table of tables) {
      const result = await pool.query(`SELECT * FROM ${table}`);
      dbExport.tables[table] = result.rows;
    }

    // Create zip archive
    const output = fs.createWriteStream(backupPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      const stats = fs.statSync(backupPath);
      res.json({
        success: true,
        filename: backupFilename,
        size: stats.size,
        created: new Date().toISOString()
      });
    });

    archive.on('error', (err) => {
      throw err;
    });

    archive.pipe(output);

    // Add database export
    archive.append(JSON.stringify(dbExport, null, 2), { name: 'database.json' });

    // Add client settings
    if (clientSettings) {
      archive.append(JSON.stringify(clientSettings, null, 2), { name: 'settings.json' });
    }

    // Add patterns directory (including thumbnails) only if requested
    if (includePatterns) {
      archive.directory(patternsDir, 'patterns');
    }

    // Add images directory only if requested
    const imagesDir = path.join(__dirname, 'patterns', 'images');
    if (includeImages && fs.existsSync(imagesDir)) {
      archive.directory(imagesDir, 'images');
    }

    await archive.finalize();
  } catch (error) {
    console.error('Error creating backup:', error);
    res.status(500).json({ error: error.message });
  }
});

// Prune old backups
app.post('/api/backups/prune', (req, res) => {
  try {
    const { mode, value } = req.body;
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.endsWith('.zip'))
      .map(f => ({
        filename: f,
        created: fs.statSync(path.join(backupsDir, f)).mtime
      }))
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    let deleted = 0;

    if (mode === 'keep') {
      // Keep last X backups
      const keepCount = parseInt(value);
      const toDelete = files.slice(keepCount);
      toDelete.forEach(f => {
        fs.unlinkSync(path.join(backupsDir, f.filename));
        deleted++;
      });
    } else if (mode === 'days') {
      // Delete backups older than X days
      const days = parseInt(value);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      files.forEach(f => {
        if (new Date(f.created) < cutoff) {
          fs.unlinkSync(path.join(backupsDir, f.filename));
          deleted++;
        }
      });
    }

    res.json({ success: true, deleted });
  } catch (error) {
    console.error('Error pruning backups:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a backup
app.delete('/api/backups/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    // Security: ensure filename is safe
    if (filename.includes('..') || !filename.endsWith('.zip')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const backupPath = path.join(backupsDir, filename);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    fs.unlinkSync(backupPath);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting backup:', error);
    res.status(500).json({ error: error.message });
  }
});

// Restore from backup
app.post('/api/backups/:filename/restore', async (req, res) => {
  const client = await pool.connect();
  try {
    const filename = req.params.filename;
    // Security: ensure filename is safe
    if (filename.includes('..') || !filename.endsWith('.zip')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const backupPath = path.join(backupsDir, filename);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    // Create temp directory for extraction
    const tempDir = path.join(__dirname, 'temp-restore-' + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });

    // Extract zip
    await fs.createReadStream(backupPath)
      .pipe(unzipper.Extract({ path: tempDir }))
      .promise();

    // Read database export
    const dbExportPath = path.join(tempDir, 'database.json');
    if (!fs.existsSync(dbExportPath)) {
      throw new Error('Invalid backup: database.json not found');
    }
    const dbExport = JSON.parse(fs.readFileSync(dbExportPath, 'utf8'));

    // Read settings (if present)
    let clientSettings = null;
    const settingsPath = path.join(tempDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      clientSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }

    // Begin transaction
    await client.query('BEGIN');

    // Clear existing data (in reverse order of dependencies)
    await client.query('DELETE FROM pattern_hashtags');
    await client.query('DELETE FROM counters');
    await client.query('DELETE FROM patterns');
    await client.query('DELETE FROM hashtags');
    await client.query('DELETE FROM categories');

    // Reset sequences
    await client.query('ALTER SEQUENCE categories_id_seq RESTART WITH 1');
    await client.query('ALTER SEQUENCE hashtags_id_seq RESTART WITH 1');
    await client.query('ALTER SEQUENCE patterns_id_seq RESTART WITH 1');
    await client.query('ALTER SEQUENCE counters_id_seq RESTART WITH 1');

    // Restore categories
    for (const row of dbExport.tables.categories || []) {
      await client.query(
        'INSERT INTO categories (id, name, position, created_at) VALUES ($1, $2, $3, $4)',
        [row.id, row.name, row.position, row.created_at]
      );
    }
    // Update sequence
    const maxCatId = Math.max(0, ...(dbExport.tables.categories || []).map(r => r.id));
    if (maxCatId > 0) {
      await client.query(`ALTER SEQUENCE categories_id_seq RESTART WITH ${maxCatId + 1}`);
    }

    // Restore hashtags
    for (const row of dbExport.tables.hashtags || []) {
      await client.query(
        'INSERT INTO hashtags (id, name, position, created_at) VALUES ($1, $2, $3, $4)',
        [row.id, row.name, row.position, row.created_at]
      );
    }
    const maxHashId = Math.max(0, ...(dbExport.tables.hashtags || []).map(r => r.id));
    if (maxHashId > 0) {
      await client.query(`ALTER SEQUENCE hashtags_id_seq RESTART WITH ${maxHashId + 1}`);
    }

    // Restore patterns
    for (const row of dbExport.tables.patterns || []) {
      await client.query(
        `INSERT INTO patterns (id, name, filename, original_name, upload_date, category, description,
         is_current, stitch_count, row_count, created_at, updated_at, thumbnail, current_page,
         completed, completed_date, notes, pattern_type, content, timer_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [row.id, row.name, row.filename, row.original_name, row.upload_date, row.category, row.description,
         row.is_current, row.stitch_count, row.row_count, row.created_at, row.updated_at, row.thumbnail,
         row.current_page, row.completed, row.completed_date, row.notes, row.pattern_type, row.content, row.timer_seconds]
      );
    }
    const maxPatId = Math.max(0, ...(dbExport.tables.patterns || []).map(r => r.id));
    if (maxPatId > 0) {
      await client.query(`ALTER SEQUENCE patterns_id_seq RESTART WITH ${maxPatId + 1}`);
    }

    // Restore counters
    for (const row of dbExport.tables.counters || []) {
      await client.query(
        'INSERT INTO counters (id, pattern_id, name, value, position, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [row.id, row.pattern_id, row.name, row.value, row.position, row.created_at, row.updated_at]
      );
    }
    const maxCntId = Math.max(0, ...(dbExport.tables.counters || []).map(r => r.id));
    if (maxCntId > 0) {
      await client.query(`ALTER SEQUENCE counters_id_seq RESTART WITH ${maxCntId + 1}`);
    }

    // Restore pattern_hashtags
    for (const row of dbExport.tables.pattern_hashtags || []) {
      await client.query(
        'INSERT INTO pattern_hashtags (pattern_id, hashtag_id) VALUES ($1, $2)',
        [row.pattern_id, row.hashtag_id]
      );
    }

    await client.query('COMMIT');

    // Restore pattern files
    const backupPatternsDir = path.join(tempDir, 'patterns');
    if (fs.existsSync(backupPatternsDir)) {
      // Clear existing patterns directory (except .gitkeep if present)
      const existingFiles = fs.readdirSync(patternsDir);
      for (const file of existingFiles) {
        const filePath = path.join(patternsDir, file);
        if (file !== '.gitkeep') {
          if (fs.statSync(filePath).isDirectory()) {
            fs.rmSync(filePath, { recursive: true });
          } else {
            fs.unlinkSync(filePath);
          }
        }
      }

      // Copy backup patterns to patterns directory
      const copyRecursive = (src, dest) => {
        if (fs.statSync(src).isDirectory()) {
          fs.mkdirSync(dest, { recursive: true });
          for (const child of fs.readdirSync(src)) {
            copyRecursive(path.join(src, child), path.join(dest, child));
          }
        } else {
          fs.copyFileSync(src, dest);
        }
      };

      for (const item of fs.readdirSync(backupPatternsDir)) {
        copyRecursive(
          path.join(backupPatternsDir, item),
          path.join(patternsDir, item)
        );
      }
    }

    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true });

    res.json({
      success: true,
      clientSettings,
      message: 'Backup restored successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error restoring backup:', error);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Download a backup file
app.get('/api/backups/:filename/download', (req, res) => {
  try {
    const filename = req.params.filename;
    if (filename.includes('..') || !filename.endsWith('.zip')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const backupPath = path.join(backupsDir, filename);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    res.download(backupPath, filename);
  } catch (error) {
    console.error('Error downloading backup:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Yarnl server running on http://0.0.0.0:${PORT}`);
});

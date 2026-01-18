const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: process.env.POSTGRES_PORT || 5432,
  database: process.env.POSTGRES_DB || 'yarnl',
  user: process.env.POSTGRES_USER || 'yarnl',
  password: process.env.POSTGRES_PASSWORD || 'yarnl',
});

// Initialize database schema
async function initDatabase() {
  const client = await pool.connect();
  try {
    // Create patterns table
    await client.query(`
      CREATE TABLE IF NOT EXISTS patterns (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        filename VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        category VARCHAR(100) DEFAULT 'Amigurumi',
        description TEXT,
        is_current BOOLEAN DEFAULT false,
        stitch_count INTEGER DEFAULT 0,
        row_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create counters table
    await client.query(`
      CREATE TABLE IF NOT EXISTS counters (
        id SERIAL PRIMARY KEY,
        pattern_id INTEGER NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        value INTEGER DEFAULT 0,
        position INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create categories table
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        position INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Insert default categories if table is empty
    const categoryCount = await client.query('SELECT COUNT(*) FROM categories');
    if (parseInt(categoryCount.rows[0].count) === 0) {
      const defaultCategories = ['Amigurumi', 'Wearables', 'Tunisian', 'Lace', 'Colorwork', 'Freeform', 'Micro', 'Other'];
      for (let i = 0; i < defaultCategories.length; i++) {
        await client.query(
          'INSERT INTO categories (name, position) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
          [defaultCategories[i], i]
        );
      }
    }

    // Create hashtags table
    await client.query(`
      CREATE TABLE IF NOT EXISTS hashtags (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        position INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create pattern_hashtags junction table
    await client.query(`
      CREATE TABLE IF NOT EXISTS pattern_hashtags (
        pattern_id INTEGER NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
        hashtag_id INTEGER NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
        PRIMARY KEY (pattern_id, hashtag_id)
      )
    `);

    // Create settings table for app configuration
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add columns to existing patterns table if they don't exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='is_current') THEN
          ALTER TABLE patterns ADD COLUMN is_current BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='stitch_count') THEN
          ALTER TABLE patterns ADD COLUMN stitch_count INTEGER DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='row_count') THEN
          ALTER TABLE patterns ADD COLUMN row_count INTEGER DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='thumbnail') THEN
          ALTER TABLE patterns ADD COLUMN thumbnail VARCHAR(255);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='current_page') THEN
          ALTER TABLE patterns ADD COLUMN current_page INTEGER DEFAULT 1;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='category') THEN
          ALTER TABLE patterns ADD COLUMN category VARCHAR(100) DEFAULT 'Amigurumi';
        END IF;

        -- Rename notes to description
        IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='patterns' AND column_name='notes') AND
           NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='description') THEN
          ALTER TABLE patterns RENAME COLUMN notes TO description;
        END IF;

        -- Add description column if it doesn't exist
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='description') THEN
          ALTER TABLE patterns ADD COLUMN description TEXT;
        END IF;

        -- Add completed column if it doesn't exist
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='completed') THEN
          ALTER TABLE patterns ADD COLUMN completed BOOLEAN DEFAULT false;
        END IF;

        -- Add completed_date column if it doesn't exist
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='completed_date') THEN
          ALTER TABLE patterns ADD COLUMN completed_date TIMESTAMP;
        END IF;

        -- Add notes column if it doesn't exist
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='notes') THEN
          ALTER TABLE patterns ADD COLUMN notes TEXT;
        END IF;

        -- Add pattern_type column if it doesn't exist (pdf or markdown)
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='pattern_type') THEN
          ALTER TABLE patterns ADD COLUMN pattern_type VARCHAR(20) DEFAULT 'pdf';
        END IF;

        -- Add content column for markdown patterns if it doesn't exist
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='content') THEN
          ALTER TABLE patterns ADD COLUMN content TEXT;
        END IF;

        -- Add timer_seconds column for tracking time spent on patterns
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='timer_seconds') THEN
          ALTER TABLE patterns ADD COLUMN timer_seconds INTEGER DEFAULT 0;
        END IF;

        -- Add is_favorite column for favorite patterns
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='is_favorite') THEN
          ALTER TABLE patterns ADD COLUMN is_favorite BOOLEAN DEFAULT false;
        END IF;

        -- Add is_archived column for archive feature
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='is_archived') THEN
          ALTER TABLE patterns ADD COLUMN is_archived BOOLEAN DEFAULT false;
        END IF;

        -- Add archived_at timestamp column
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='archived_at') THEN
          ALTER TABLE patterns ADD COLUMN archived_at TIMESTAMP;
        END IF;
      END $$;
    `);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initDatabase,
};

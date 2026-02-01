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

    // Create categories table (per-user categories)
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        position INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, name)
      )
    `);

    // Add user_id column to categories if it doesn't exist (migration)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='categories' AND column_name='user_id') THEN
          ALTER TABLE categories ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
          -- Drop the old unique constraint on name only
          ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key;
          -- Add new unique constraint on (user_id, name)
          ALTER TABLE categories ADD CONSTRAINT categories_user_name_unique UNIQUE(user_id, name);
        END IF;
      END $$;
    `);

    // Note: Default categories are now created per-user when users are created
    // See createDefaultCategoriesForUser() in server.js

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

    // Create users table for authentication
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) NOT NULL UNIQUE,
        password_hash VARCHAR(255),
        password_required BOOLEAN DEFAULT false,
        role VARCHAR(20) DEFAULT 'user',
        display_name VARCHAR(255),
        oidc_subject VARCHAR(255) UNIQUE,
        oidc_provider VARCHAR(100),
        can_add_patterns BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);

    // Add password_required column if it doesn't exist (migration)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='users' AND column_name='password_required') THEN
          ALTER TABLE users ADD COLUMN password_required BOOLEAN DEFAULT false;
        END IF;
      END $$;
    `);

    // Add oidc_allowed column if it doesn't exist (migration)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='users' AND column_name='oidc_allowed') THEN
          ALTER TABLE users ADD COLUMN oidc_allowed BOOLEAN DEFAULT true;
        END IF;
      END $$;
    `);

    // Add can_change_username column if it doesn't exist (migration)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='users' AND column_name='can_change_username') THEN
          ALTER TABLE users ADD COLUMN can_change_username BOOLEAN DEFAULT true;
        END IF;
      END $$;
    `);

    // Add can_change_password column if it doesn't exist (migration)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='users' AND column_name='can_change_password') THEN
          ALTER TABLE users ADD COLUMN can_change_password BOOLEAN DEFAULT true;
        END IF;
      END $$;
    `);

    // Create sessions table for auth sessions
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(64) PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

        -- Add user_id for pattern ownership
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='user_id') THEN
          ALTER TABLE patterns ADD COLUMN user_id INTEGER REFERENCES users(id);
        END IF;

        -- Add visibility for pattern sharing
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='visibility') THEN
          ALTER TABLE patterns ADD COLUMN visibility VARCHAR(20) DEFAULT 'private';
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

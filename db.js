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
        max_value INTEGER,
        is_main BOOLEAN DEFAULT false,
        unlinked BOOLEAN DEFAULT false,
        position INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create users table for authentication (must be before categories which references it)
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
        can_upload_pdf BOOLEAN DEFAULT true,
        can_create_markdown BOOLEAN DEFAULT true,
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

    // Add granular pattern upload permissions (replaces can_add_patterns)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='users' AND column_name='can_upload_pdf') THEN
          ALTER TABLE users ADD COLUMN can_upload_pdf BOOLEAN DEFAULT true;
          ALTER TABLE users ADD COLUMN can_create_markdown BOOLEAN DEFAULT true;
          UPDATE users SET can_upload_pdf = can_add_patterns, can_create_markdown = can_add_patterns;
        END IF;
      END $$;
    `);

    // Add client_settings column for syncing user preferences across devices
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='users' AND column_name='client_settings') THEN
          ALTER TABLE users ADD COLUMN client_settings JSONB DEFAULT '{}';
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

    // Create projects table for grouping patterns
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        thumbnail VARCHAR(255),
        is_current BOOLEAN DEFAULT false,
        is_favorite BOOLEAN DEFAULT false,
        completed BOOLEAN DEFAULT false,
        completed_date TIMESTAMP,
        is_archived BOOLEAN DEFAULT false,
        archived_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create project_patterns junction table (patterns in a project with ordering and status)
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_patterns (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        pattern_id INTEGER NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
        position INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, pattern_id)
      )
    `);

    // Create project_hashtags junction table
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_hashtags (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        hashtag_id INTEGER NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
        PRIMARY KEY (project_id, hashtag_id)
      )
    `);

    // Create yarns table for yarn inventory
    await client.query(`
      CREATE TABLE IF NOT EXISTS yarns (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255),
        brand VARCHAR(255),
        colorway VARCHAR(255),
        weight_category VARCHAR(50),
        fiber_content VARCHAR(255),
        color_hex VARCHAR(7),
        color VARCHAR(100),
        dye_lot VARCHAR(100),
        quantity NUMERIC(6,1) DEFAULT 1,
        notes TEXT,
        thumbnail VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create hooks table for hook/needle inventory
    await client.query(`
      CREATE TABLE IF NOT EXISTS hooks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        craft_type VARCHAR(20) DEFAULT 'crochet',
        name VARCHAR(255),
        brand VARCHAR(255),
        size_mm NUMERIC(4,1),
        size_label VARCHAR(20),
        hook_type VARCHAR(50),
        length VARCHAR(20),
        quantity INTEGER DEFAULT 1,
        notes TEXT,
        thumbnail VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add brand column to hooks if it doesn't exist (migration)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='hooks' AND column_name='brand') THEN
          ALTER TABLE hooks ADD COLUMN brand VARCHAR(255);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='hooks' AND column_name='craft_type') THEN
          ALTER TABLE hooks ADD COLUMN craft_type VARCHAR(20) DEFAULT 'crochet';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='hooks' AND column_name='length') THEN
          ALTER TABLE hooks ADD COLUMN length VARCHAR(20);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='hooks' AND column_name='name') THEN
          ALTER TABLE hooks ADD COLUMN name VARCHAR(255);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='hooks' AND column_name='thumbnail') THEN
          ALTER TABLE hooks ADD COLUMN thumbnail VARCHAR(255);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='yarns' AND column_name='name') THEN
          ALTER TABLE yarns ADD COLUMN name VARCHAR(255);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='yarns' AND column_name='color') THEN
          ALTER TABLE yarns ADD COLUMN color VARCHAR(100);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='yarns' AND column_name='dye_lot') THEN
          ALTER TABLE yarns ADD COLUMN dye_lot VARCHAR(100);
        END IF;
      END $$;
    `);

    // Add url column to yarns and hooks
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='yarns' AND column_name='url') THEN
          ALTER TABLE yarns ADD COLUMN url TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='hooks' AND column_name='url') THEN
          ALTER TABLE hooks ADD COLUMN url TEXT;
        END IF;
      END $$;
    `);

    // Add is_favorite and rating columns to yarns, hooks, and patterns
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='yarns' AND column_name='is_favorite') THEN
          ALTER TABLE yarns ADD COLUMN is_favorite BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='hooks' AND column_name='is_favorite') THEN
          ALTER TABLE hooks ADD COLUMN is_favorite BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='rating') THEN
          ALTER TABLE patterns ADD COLUMN rating INTEGER DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='yarns' AND column_name='rating') THEN
          ALTER TABLE yarns ADD COLUMN rating INTEGER DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='hooks' AND column_name='rating') THEN
          ALTER TABLE hooks ADD COLUMN rating INTEGER DEFAULT 0;
        END IF;
      END $$;
    `);

    // Add Ravelry integration columns
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='users' AND column_name='ravelry_access_token') THEN
          ALTER TABLE users ADD COLUMN ravelry_access_token TEXT;
          ALTER TABLE users ADD COLUMN ravelry_refresh_token TEXT;
          ALTER TABLE users ADD COLUMN ravelry_token_expires_at TIMESTAMP;
          ALTER TABLE users ADD COLUMN ravelry_username VARCHAR(255);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='ravelry_id') THEN
          ALTER TABLE patterns ADD COLUMN ravelry_id INTEGER;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='yarns' AND column_name='ravelry_stash_id') THEN
          ALTER TABLE yarns ADD COLUMN ravelry_stash_id INTEGER;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='hooks' AND column_name='ravelry_needle_id') THEN
          ALTER TABLE hooks ADD COLUMN ravelry_needle_id INTEGER;
        END IF;
      END $$;
    `);

    // Migrate colorway data to color column
    await client.query(`UPDATE yarns SET color = colorway WHERE color IS NULL AND colorway IS NOT NULL`);

    // Create pattern_yarns junction table
    await client.query(`
      CREATE TABLE IF NOT EXISTS pattern_yarns (
        pattern_id INTEGER NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
        yarn_id INTEGER NOT NULL REFERENCES yarns(id) ON DELETE CASCADE,
        notes VARCHAR(255),
        PRIMARY KEY (pattern_id, yarn_id)
      )
    `);

    // Create pattern_hooks junction table
    await client.query(`
      CREATE TABLE IF NOT EXISTS pattern_hooks (
        pattern_id INTEGER NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
        hook_id INTEGER NOT NULL REFERENCES hooks(id) ON DELETE CASCADE,
        PRIMARY KEY (pattern_id, hook_id)
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

        -- Add last_opened_at for tracking when patterns were last viewed
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='last_opened_at') THEN
          ALTER TABLE patterns ADD COLUMN last_opened_at TIMESTAMP;
        END IF;

        -- Add last_opened_at for tracking when projects were last viewed
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='projects' AND column_name='last_opened_at') THEN
          ALTER TABLE projects ADD COLUMN last_opened_at TIMESTAMP;
        END IF;

        -- Add started_date for tracking when patterns were marked in progress
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='patterns' AND column_name='started_date') THEN
          ALTER TABLE patterns ADD COLUMN started_date TIMESTAMP;
        END IF;

        -- Add max_value for repeatable counters
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='counters' AND column_name='max_value') THEN
          ALTER TABLE counters ADD COLUMN max_value INTEGER;
        END IF;

        -- Add is_main for linked counters
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='counters' AND column_name='is_main') THEN
          ALTER TABLE counters ADD COLUMN is_main BOOLEAN DEFAULT false;
        END IF;

        -- Add unlinked for opting out of main counter link
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='counters' AND column_name='unlinked') THEN
          ALTER TABLE counters ADD COLUMN unlinked BOOLEAN DEFAULT false;
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

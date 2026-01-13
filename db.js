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
        tags TEXT[],
        notes TEXT,
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

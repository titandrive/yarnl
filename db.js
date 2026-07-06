const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: process.env.POSTGRES_PORT || 5432,
  database: process.env.POSTGRES_DB || 'yarnl',
  user: process.env.POSTGRES_USER || 'yarnl',
  password: process.env.POSTGRES_PASSWORD || 'yarnl',
});

const MIGRATIONS = [
  {
    id: 1,
    name: 'initial_schema',
    run: async (client) => {
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
      await client.query(`
        CREATE TABLE IF NOT EXISTS hashtags (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL UNIQUE,
          position INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS pattern_hashtags (
          pattern_id INTEGER NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
          hashtag_id INTEGER NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
          PRIMARY KEY (pattern_id, hashtag_id)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS settings (
          key VARCHAR(100) PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          id VARCHAR(64) PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          expires_at TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
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
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_hashtags (
          project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          hashtag_id INTEGER NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
          PRIMARY KEY (project_id, hashtag_id)
        )
      `);
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
      await client.query(`
        CREATE TABLE IF NOT EXISTS pattern_yarns (
          pattern_id INTEGER NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
          yarn_id INTEGER NOT NULL REFERENCES yarns(id) ON DELETE CASCADE,
          notes VARCHAR(255),
          PRIMARY KEY (pattern_id, yarn_id)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS pattern_hooks (
          pattern_id INTEGER NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
          hook_id INTEGER NOT NULL REFERENCES hooks(id) ON DELETE CASCADE,
          PRIMARY KEY (pattern_id, hook_id)
        )
      `);
    }
  },
  {
    id: 2,
    name: 'users_add_password_required',
    run: async (client) => {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_required BOOLEAN DEFAULT false`);
    }
  },
  {
    id: 3,
    name: 'categories_add_user_id',
    run: async (client) => {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name='categories' AND column_name='user_id') THEN
            ALTER TABLE categories ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
            ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key;
            ALTER TABLE categories ADD CONSTRAINT categories_user_name_unique UNIQUE(user_id, name);
          END IF;
        END $$;
      `);
    }
  },
  {
    id: 4,
    name: 'users_add_oidc_allowed',
    run: async (client) => {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_allowed BOOLEAN DEFAULT true`);
    }
  },
  {
    id: 5,
    name: 'users_add_can_change_username',
    run: async (client) => {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS can_change_username BOOLEAN DEFAULT true`);
    }
  },
  {
    id: 6,
    name: 'users_add_can_change_password',
    run: async (client) => {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS can_change_password BOOLEAN DEFAULT true`);
    }
  },
  {
    id: 7,
    name: 'users_add_granular_upload_permissions',
    run: async (client) => {
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
    }
  },
  {
    id: 8,
    name: 'users_add_client_settings',
    run: async (client) => {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS client_settings JSONB DEFAULT '{}'`);
    }
  },
  {
    id: 9,
    name: 'inventory_add_missing_columns',
    run: async (client) => {
      await client.query(`ALTER TABLE hooks ADD COLUMN IF NOT EXISTS brand VARCHAR(255)`);
      await client.query(`ALTER TABLE hooks ADD COLUMN IF NOT EXISTS craft_type VARCHAR(20) DEFAULT 'crochet'`);
      await client.query(`ALTER TABLE hooks ADD COLUMN IF NOT EXISTS length VARCHAR(20)`);
      await client.query(`ALTER TABLE hooks ADD COLUMN IF NOT EXISTS name VARCHAR(255)`);
      await client.query(`ALTER TABLE hooks ADD COLUMN IF NOT EXISTS thumbnail VARCHAR(255)`);
      await client.query(`ALTER TABLE yarns ADD COLUMN IF NOT EXISTS name VARCHAR(255)`);
      await client.query(`ALTER TABLE yarns ADD COLUMN IF NOT EXISTS color VARCHAR(100)`);
      await client.query(`ALTER TABLE yarns ADD COLUMN IF NOT EXISTS dye_lot VARCHAR(100)`);
    }
  },
  {
    id: 10,
    name: 'inventory_add_url',
    run: async (client) => {
      await client.query(`ALTER TABLE yarns ADD COLUMN IF NOT EXISTS url TEXT`);
      await client.query(`ALTER TABLE hooks ADD COLUMN IF NOT EXISTS url TEXT`);
    }
  },
  {
    id: 11,
    name: 'inventory_add_favorites_and_ratings',
    run: async (client) => {
      await client.query(`ALTER TABLE yarns ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT false`);
      await client.query(`ALTER TABLE hooks ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT false`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 0`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS difficulty INTEGER DEFAULT 0`);
      await client.query(`ALTER TABLE yarns ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 0`);
      await client.query(`ALTER TABLE hooks ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 0`);
    }
  },
  {
    id: 12,
    name: 'ravelry_integration_columns',
    run: async (client) => {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ravelry_access_token TEXT`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ravelry_refresh_token TEXT`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ravelry_token_expires_at TIMESTAMP`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ravelry_username VARCHAR(255)`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS ravelry_id INTEGER`);
      await client.query(`ALTER TABLE yarns ADD COLUMN IF NOT EXISTS ravelry_stash_id INTEGER`);
      await client.query(`ALTER TABLE hooks ADD COLUMN IF NOT EXISTS ravelry_needle_id INTEGER`);
      await client.query(`ALTER TABLE yarns ADD COLUMN IF NOT EXISTS yardage NUMERIC(8,1)`);
      await client.query(`ALTER TABLE yarns ADD COLUMN IF NOT EXISTS unit_weight NUMERIC(8,1)`);
      await client.query(`ALTER TABLE yarns ADD COLUMN IF NOT EXISTS gauge VARCHAR(100)`);
      await client.query(`ALTER TABLE yarns ADD COLUMN IF NOT EXISTS needle_size VARCHAR(100)`);
      await client.query(`ALTER TABLE yarns ADD COLUMN IF NOT EXISTS hook_size VARCHAR(100)`);
    }
  },
  {
    id: 13,
    name: 'yarns_migrate_colorway_to_color',
    run: async (client) => {
      await client.query(`UPDATE yarns SET color = colorway WHERE color IS NULL AND colorway IS NOT NULL`);
    }
  },
  {
    id: 14,
    name: 'patterns_add_extended_columns',
    run: async (client) => {
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS is_current BOOLEAN DEFAULT false`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS stitch_count INTEGER DEFAULT 0`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS row_count INTEGER DEFAULT 0`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS thumbnail VARCHAR(255)`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS current_page INTEGER DEFAULT 1`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'Amigurumi'`);
      // Rename notes to description for installs that have the old column name
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='patterns' AND column_name='notes')
          AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='patterns' AND column_name='description') THEN
            ALTER TABLE patterns RENAME COLUMN notes TO description;
          END IF;
        END $$;
      `);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS description TEXT`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT false`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS completed_date TIMESTAMP`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS notes TEXT`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS pattern_type VARCHAR(20) DEFAULT 'pdf'`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS content TEXT`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS timer_seconds INTEGER DEFAULT 0`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN DEFAULT false`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) DEFAULT 'private'`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMP`);
      await client.query(`ALTER TABLE patterns ADD COLUMN IF NOT EXISTS started_date TIMESTAMP`);
    }
  },
  {
    id: 15,
    name: 'projects_add_last_opened_at',
    run: async (client) => {
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMP`);
    }
  },
  {
    id: 16,
    name: 'counters_add_extended_columns',
    run: async (client) => {
      await client.query(`ALTER TABLE counters ADD COLUMN IF NOT EXISTS max_value INTEGER`);
      await client.query(`ALTER TABLE counters ADD COLUMN IF NOT EXISTS is_main BOOLEAN DEFAULT false`);
      await client.query(`ALTER TABLE counters ADD COLUMN IF NOT EXISTS unlinked BOOLEAN DEFAULT false`);
    }
  },
  {
    id: 17,
    name: 'patterns_user_id_add_cascade',
    run: async (client) => {
      await client.query(`ALTER TABLE patterns DROP CONSTRAINT IF EXISTS patterns_user_id_fkey`);
      await client.query(`ALTER TABLE patterns ADD CONSTRAINT patterns_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    }
  },
];

async function initDatabase() {
  const client = await pool.connect();
  try {
    // Bootstrap the migrations tracking table — the only thing that always runs
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const { rows } = await client.query(`SELECT id FROM schema_migrations`);
    const applied = new Set(rows.map(r => r.id));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;

      await migration.run(client);
      await client.query(
        `INSERT INTO schema_migrations (id, name) VALUES ($1, $2)`,
        [migration.id, migration.name]
      );
      console.log(`Applied migration ${migration.id}: ${migration.name}`);
    }

    console.log('Database migrations complete');
  } catch (error) {
    console.error('Error running database migrations:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initDatabase,
};

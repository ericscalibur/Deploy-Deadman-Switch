const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Database file path
const DB_PATH = path.join(__dirname, 'deadman_switch.db');

// Initialize database with proper schema
function initializeDatabase() {
    return new Promise((resolve, reject) => {
        // Create database directory if it doesn't exist
        const dbDir = path.dirname(DB_PATH);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        const db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('Error opening database:', err.message);
                reject(err);
                return;
            }
            console.log('Connected to SQLite database at:', DB_PATH);
        });

        // Enable foreign keys
        db.run('PRAGMA foreign_keys = ON;', (err) => {
            if (err) {
                console.error('Error enabling foreign keys:', err.message);
                reject(err);
                return;
            }
        });

        // Create users table
        const createUsersTable = `
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME,
                is_active BOOLEAN DEFAULT 1
            );
        `;

        // Create encrypted user data table
        const createUserDataTable = `
            CREATE TABLE IF NOT EXISTS encrypted_user_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                encrypted_emails TEXT, -- AES encrypted JSON array of email objects
                encrypted_settings TEXT, -- AES encrypted deadman switch settings
                encrypted_checkin_tokens TEXT, -- AES encrypted checkin tokens
                iv TEXT NOT NULL, -- Initialization Vector for encryption
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            );
        `;

        // Create deadman switch sessions table (for active switches)
        const createSessionsTable = `
            CREATE TABLE IF NOT EXISTS deadman_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                session_token TEXT UNIQUE NOT NULL,
                last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
                checkin_interval_ms INTEGER NOT NULL,
                inactivity_timeout_ms INTEGER NOT NULL,
                is_active BOOLEAN DEFAULT 1,
                activated_at DATETIME,
                expires_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            );
        `;

        // Create audit log table for security
        const createAuditTable = `
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                action TEXT NOT NULL,
                details TEXT,
                ip_address TEXT,
                user_agent TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            );
        `;

        // Create indexes for performance
        const createIndexes = [
            'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);',
            'CREATE INDEX IF NOT EXISTS idx_user_data_user_id ON encrypted_user_data(user_id);',
            'CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON deadman_sessions(user_id);',
            'CREATE INDEX IF NOT EXISTS idx_sessions_active ON deadman_sessions(is_active);',
            'CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_log(user_id);',
            'CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);'
        ];

        // Execute table creation
        db.serialize(() => {
            db.run(createUsersTable, (err) => {
                if (err) {
                    console.error('Error creating users table:', err.message);
                    reject(err);
                    return;
                }
                console.log('Users table created or already exists');
            });

            db.run(createUserDataTable, (err) => {
                if (err) {
                    console.error('Error creating user data table:', err.message);
                    reject(err);
                    return;
                }
                console.log('Encrypted user data table created or already exists');
            });

            db.run(createSessionsTable, (err) => {
                if (err) {
                    console.error('Error creating sessions table:', err.message);
                    reject(err);
                    return;
                }
                console.log('Deadman sessions table created or already exists');
            });

            db.run(createAuditTable, (err) => {
                if (err) {
                    console.error('Error creating audit table:', err.message);
                    reject(err);
                    return;
                }
                console.log('Audit log table created or already exists');
            });

            // Create indexes
            createIndexes.forEach((indexSQL, i) => {
                db.run(indexSQL, (err) => {
                    if (err) {
                        console.error(`Error creating index ${i + 1}:`, err.message);
                    } else {
                        console.log(`Index ${i + 1} created or already exists`);
                    }
                });
            });

            // Close database and resolve
            db.close((err) => {
                if (err) {
                    console.error('Error closing database:', err.message);
                    reject(err);
                } else {
                    console.log('Database initialization complete');
                    resolve(DB_PATH);
                }
            });
        });
    });
}

// Test database connection
function testConnection() {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
            if (err) {
                reject(err);
                return;
            }

            db.get('SELECT COUNT(*) as count FROM sqlite_master WHERE type="table"', (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }

                console.log(`Database has ${row.count} tables`);
                db.close();
                resolve(row.count);
            });
        });
    });
}

// Export functions and database path
module.exports = {
    initializeDatabase,
    testConnection,
    DB_PATH
};

// Run initialization if called directly
if (require.main === module) {
    console.log('Initializing Deadman Switch Database...');
    initializeDatabase()
        .then(() => {
            console.log('✅ Database initialization successful!');
            return testConnection();
        })
        .then(() => {
            console.log('✅ Database connection test passed!');
            process.exit(0);
        })
        .catch((err) => {
            console.error('❌ Database initialization failed:', err);
            process.exit(1);
        });
}

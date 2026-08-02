-- Allow login users who don't have session tokens
ALTER TABLE users ALTER COLUMN session_token DROP NOT NULL;

-- Login support
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

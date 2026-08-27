import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'users.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    connected_at INTEGER NOT NULL
  )
`);

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decrypt(value) {
  const data = Buffer.from(value, 'base64url');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function saveRefreshToken(telegramId, refreshToken) {
  db.prepare(`
    INSERT INTO users (telegram_id, refresh_token, connected_at)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      refresh_token = excluded.refresh_token,
      connected_at = excluded.connected_at
  `).run(String(telegramId), encrypt(refreshToken), Date.now());
}

export function getRefreshToken(telegramId) {
  const row = db.prepare('SELECT refresh_token FROM users WHERE telegram_id = ?').get(String(telegramId));
  return row ? decrypt(row.refresh_token) : null;
}

export function isConnected(telegramId) {
  return Boolean(db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(String(telegramId)));
}

export function disconnect(telegramId) {
  db.prepare('DELETE FROM users WHERE telegram_id = ?').run(String(telegramId));
}

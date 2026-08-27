import crypto from 'node:crypto';
import { google } from 'googleapis';
import { config } from './config.js';
import { saveRefreshToken } from './db.js';

const oauth2 = new google.auth.OAuth2(
  config.googleClientId,
  config.googleClientSecret,
  config.googleRedirectUri
);

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.encryptionKey).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readState(state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) throw new Error('Invalid OAuth state');
  const expected = crypto.createHmac('sha256', config.encryptionKey).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Invalid OAuth state');
  const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!value.telegramId || Date.now() - value.createdAt > 10 * 60 * 1000) throw new Error('Expired OAuth state');
  return value;
}

export function createGoogleAuthUrl(telegramId) {
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    state: signState({ telegramId: String(telegramId), createdAt: Date.now() })
  });
}

export async function finishGoogleAuth(code, state) {
  const { telegramId } = readState(state);
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Revoke app access and connect again.');
  saveRefreshToken(telegramId, tokens.refresh_token);
  return telegramId;
}

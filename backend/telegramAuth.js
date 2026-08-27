import crypto from 'node:crypto';
import { config } from './config.js';

// Telegram Mini App initData verification.
export function verifyInitData(initData) {
  if (!initData) throw new Error('Missing Telegram initData');

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) throw new Error('Missing Telegram hash');
  params.delete('hash');

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 3600) {
    throw new Error('Expired Telegram initData');
  }

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(config.telegramToken)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const a = Buffer.from(receivedHash, 'hex');
  const b = Buffer.from(calculatedHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid Telegram initData');
  }

  const user = JSON.parse(params.get('user') || '{}');
  if (!user.id) throw new Error('Telegram user missing');
  return user;
}

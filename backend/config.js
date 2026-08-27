import 'dotenv/config';

const required = [
  'TELEGRAM_BOT_TOKEN',
  'WEBAPP_URL',
  'EZ_API_BASE',
  'EZ_API_SECRET'
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramApiRoot: process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org',
  webappUrl: process.env.WEBAPP_URL.replace(/\/$/, ''),
  ezApiBase: process.env.EZ_API_BASE.replace(/\/$/, ''),
  ezApiSecret: process.env.EZ_API_SECRET,
  port: Number(process.env.PORT || 3000),
  maxConcurrentUploads: Number(process.env.MAX_CONCURRENT_UPLOADS || 2)
};

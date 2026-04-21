'use strict';

/**
 * LUXXPOOL v0.8.2 — Alert Delivery
 *
 * Out-of-band delivery of warn/error/critical events to the operator via:
 *   - Email  (SMTP / nodemailer)
 *   - Telegram Bot API (direct fetch)
 *   - Generic webhook (direct fetch)
 *
 * Public API:
 *   send(payload)  — await Promise<void> (never throws)
 *
 * Features:
 *   - Per-(code,chain) cooldown (default 5 minutes, configurable via env)
 *   - Channels enabled independently via ALERT_*_ENABLED env vars
 *   - Env read at send-time so runtime changes take effect
 *   - All failures caught and logged to stderr; delivery never throws
 */

const nodemailer = require('nodemailer');

const cooldowns = new Map(); // key: `${code}:${chain}`, value: lastSentMs
let cachedTransport = null;
let cachedTransportKey = '';

const SEVERITY_ICON = {
  info: 'ℹ️',
  warn: '⚠️',
  error: '🚨',
  critical: '🔴',
};

function _cooldownMs() {
  const mins = parseInt(process.env.ALERT_COOLDOWN_MINUTES || '5', 10);
  return (Number.isFinite(mins) && mins > 0 ? mins : 5) * 60_000;
}

function _formatTelegramText(payload) {
  const icon = SEVERITY_ICON[payload.severity] || '•';
  const time = new Date(payload.ts || Date.now()).toISOString().replace('T', ' ').slice(0, 19);
  const details = payload.data ? JSON.stringify(payload.data, null, 0) : '';
  return (
    `${icon} LUXXPOOL [${payload.severity.toUpperCase()}]\n` +
    `━━━━━━━━━━━━━━━\n` +
    `Code: ${payload.event}\n` +
    `Event: ${payload.name}\n` +
    `Chain: ${payload.chain || 'LTC'}\n` +
    `Time: ${time} UTC\n` +
    (details && details !== '{}' ? `Details: ${details}\n` : '') +
    `━━━━━━━━━━━━━━━`
  );
}

function _formatEmailSubject(payload) {
  return `[LUXXPOOL] ${payload.severity.toUpperCase()} — ${payload.name} [${payload.chain || 'LTC'}]`;
}

function _formatEmailBody(payload) {
  const time = new Date(payload.ts || Date.now()).toISOString();
  const header =
    `Code:      ${payload.event}\n` +
    `Event:     ${payload.name}\n` +
    `Severity:  ${payload.severity}\n` +
    `Chain:     ${payload.chain || 'LTC'}\n` +
    `Category:  ${payload.category}\n` +
    `Time:      ${time}\n\n`;
  const details = `Details:\n${JSON.stringify(payload.data || {}, null, 2)}\n`;
  return header + details;
}

async function _sendEmail(payload) {
  const host = process.env.ALERT_SMTP_HOST;
  const port = parseInt(process.env.ALERT_SMTP_PORT || '587', 10);
  const user = process.env.ALERT_SMTP_USER;
  const pass = process.env.ALERT_SMTP_PASS;
  const from = process.env.ALERT_EMAIL_FROM || user;
  const to = process.env.ALERT_EMAIL_TO;
  if (!host || !user || !pass || !to) {
    throw new Error('alert email missing required env (HOST/USER/PASS/TO)');
  }

  const key = `${host}:${port}:${user}`;
  if (!cachedTransport || cachedTransportKey !== key) {
    cachedTransport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
    cachedTransportKey = key;
  }

  await cachedTransport.sendMail({
    from,
    to,
    subject: _formatEmailSubject(payload),
    text: _formatEmailBody(payload),
  });
}

async function _sendTelegram(payload) {
  const token = process.env.ALERT_TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ALERT_TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error('alert telegram missing TOKEN/CHAT_ID');
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = { chat_id: chatId, text: _formatTelegramText(payload) };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`telegram HTTP ${res.status}: ${msg.slice(0, 200)}`);
  }
}

async function _sendWebhook(payload) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) throw new Error('alert webhook missing URL');
  const secret = process.env.ALERT_WEBHOOK_SECRET || '';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LUXX-Secret': secret,
      'X-LUXX-Event': payload.event,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`webhook HTTP ${res.status}`);
  }
}

/**
 * Dispatch an alert across all enabled channels.
 * Never throws. Rejects silently on individual channel failure.
 *
 * @param {object} payload
 * @param {string} payload.event    e.g. 'DAEMON_006'
 * @param {string} payload.name     human-readable
 * @param {string} payload.severity 'info' | 'warn' | 'error' | 'critical'
 * @param {string} payload.category 'connection' | 'share' | ...
 * @param {string} [payload.chain]  'LTC' | 'DOGE' | ...
 * @param {number} [payload.ts]
 * @param {object} [payload.data]
 */
async function send(payload) {
  try {
    if (!payload || payload.severity === 'info') return;

    const key = `${payload.event}:${payload.chain || 'LTC'}`;
    const last = cooldowns.get(key) || 0;
    if (Date.now() - last < _cooldownMs()) return;
    cooldowns.set(key, Date.now());

    const jobs = [];
    if (process.env.ALERT_EMAIL_ENABLED === 'true')    jobs.push(_sendEmail(payload));
    if (process.env.ALERT_TELEGRAM_ENABLED === 'true') jobs.push(_sendTelegram(payload));
    if (process.env.ALERT_WEBHOOK_ENABLED === 'true')  jobs.push(_sendWebhook(payload));

    const results = await Promise.allSettled(jobs);
    for (const r of results) {
      if (r.status === 'rejected') {
        process.stderr.write(`[alertDelivery] channel failed: ${r.reason?.message || r.reason}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[alertDelivery] send error: ${err.message}\n`);
  }
}

module.exports = { send, _cooldowns: cooldowns };

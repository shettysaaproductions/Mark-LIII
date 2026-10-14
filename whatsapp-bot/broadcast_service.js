/**
 * broadcast_service.js — Universal RecrutOS Candidate Broadcast Engine
 * ====================================================================
 * Allows recruiters to send bulk announcements, greetings (Diwali, Navratri, Eid,
 * New Year, hiring alerts, etc.) to all registered candidates in RecrutOS.
 *
 * SAFETY FEATURES:
 *  - 2-Step Confirmation: Shows candidate count and message preview before sending.
 *  - Anti-Ban Throttle: Random delay (3.5s - 7.5s) between messages to protect WhatsApp account.
 *  - Automatic DND & Trash Filter: Candidates marked as trash or DND are skipped.
 *  - Dynamic Personalization: Replaces {name} or prepends candidate's first name.
 *  - Background Execution: Non-blocking async loop so the bot remains responsive.
 */

import { createClient } from '@supabase/supabase-js';
import { isOnDnd } from './recruiter_db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_ENV_PATH = path.resolve(__dirname, '.env.recruiter');
const RECOS_ENV_PATH = path.resolve(__dirname, '../../recOS/.env');

function loadEnv() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) return;
  const envPaths = [LOCAL_ENV_PATH, RECOS_ENV_PATH];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m) {
          const key = m[1].trim();
          const val = m[2].trim().replace(/^['"]|['"]$/g, '');
          if (!process.env[key] && val && !val.includes('your_')) {
            process.env[key] = val;
          }
        }
      }
    }
  }
}
loadEnv();

function getSupabaseClient() {
  loadEnv();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (url && key && !url.includes('your_') && !key.includes('your_')) {
    return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  }
  return null;
}

// Global broadcast state
let _pendingBroadcast = null;
let _activeBroadcast = {
  inProgress: false,
  total: 0,
  sent: 0,
  failed: 0,
  startTime: null,
  lastUpdated: null,
  messagePreview: ''
};

/**
 * Detects if the message is a broadcast command:
 * e.g.,
 *   "msg all Happy Navratri!"
 *   "message all candidates..."
 *   "text all Happy Diwali"
 *   "msg all confirm"
 *   "msg all cancel"
 *   "msg all status"
 */
export function isMsgAllCommand(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  return (
    /^(?:msg|message|text|broadcast)\s+all\b/i.test(trimmed) ||
    /^(?:msg|message|text|broadcast)\s+all\s+candidates\b/i.test(trimmed) ||
    /^(?:msg|message|text)\s+to\s+all\b/i.test(trimmed) ||
    (_pendingBroadcast && /^(?:confirm|proceed|yes\s+send|abort|cancel)$/i.test(trimmed))
  );
}

/**
 * Extracts the message body from the command text.
 */
function extractBroadcastMessage(rawText) {
  const t = rawText.trim();
  // Strip command prefix
  const cleaned = t
    .replace(/^(?:msg|message|text|broadcast)\s+all(?:\s+candidates)?[:\s\n]*/i, '')
    .replace(/^(?:msg|message|text)\s+to\s+all(?:\s+candidates)?[:\s\n]*/i, '')
    .trim();
  return cleaned;
}

/**
 * Fetches all active candidates from Supabase.
 */
async function fetchActiveCandidates() {
  const client = getSupabaseClient();
  if (!client) return [];
  try {
    const { data, error } = await client
      .from('ros_candidates')
      .select('id, name, phone, notes, is_trash')
      .neq('is_trash', true)
      .order('name', { ascending: true });

    if (error) {
      console.error('❌ [BroadcastService] Error fetching candidates:', error);
      return [];
    }
    return (data || []).filter(c => {
      const rawPhone = String(c.phone || '').replace(/\D/g, '').slice(-10);
      return rawPhone.length === 10;
    });
  } catch (err) {
    console.error('❌ [BroadcastService] fetchActiveCandidates exception:', err);
    return [];
  }
}

/**
 * Handles broadcast commands with safety checks, previews, confirmation, and async execution.
 */
export async function handleBroadcastToAllCandidates(text, waClient, context = {}) {
  const trimmed = text.trim();

  // Status check
  if (/^(?:msg|message|text|broadcast)\s+all\s+status$/i.test(trimmed)) {
    if (_activeBroadcast.inProgress) {
      const pct = _activeBroadcast.total > 0 ? Math.round((_activeBroadcast.sent / _activeBroadcast.total) * 100) : 0;
      return `📡 *BROADCAST IN PROGRESS*\n\n` +
        `📊 Progress: *${_activeBroadcast.sent} / ${_activeBroadcast.total}* sent (${pct}%)\n` +
        `❌ Failed / Skipped: ${_activeBroadcast.failed}\n` +
        `⏱ Started: ${_activeBroadcast.startTime || 'Just now'}\n\n` +
        `_Messages are sending safely in the background with anti-ban delay (4-7s)._`;
    }
    if (_activeBroadcast.startTime) {
      return `✅ *LAST BROADCAST SUMMARY*\n\n` +
        `📤 Sent: *${_activeBroadcast.sent}*\n` +
        `❌ Failed: ${_activeBroadcast.failed}\n` +
        `📊 Total: ${_activeBroadcast.total}\n` +
        `📝 Message: "${_activeBroadcast.messagePreview}"`;
    }
    return `ℹ️ No broadcasts have been run recently.\nReply with *"msg all <your message>"* to start one.`;
  }

  // Cancel check
  if (
    /^(?:msg|message|text|broadcast)\s+all\s+cancel$/i.test(trimmed) ||
    (_pendingBroadcast && /^(?:cancel|abort|stop)$/i.test(trimmed))
  ) {
    _pendingBroadcast = null;
    return `❌ *Broadcast Cancelled.*\nNo messages were sent. You can compose a new one anytime.`;
  }

  // Confirm check
  if (
    /^(?:msg|message|text|broadcast)\s+all\s+confirm$/i.test(trimmed) ||
    (_pendingBroadcast && /^(?:confirm|proceed|yes\s+send|send)$/i.test(trimmed))
  ) {
    if (!_pendingBroadcast) {
      return `⚠️ No pending broadcast found to confirm.\nPlease type: *"msg all <your message>"* first to preview.`;
    }

    if (Date.now() - _pendingBroadcast.createdAt > 10 * 60 * 1000) {
      _pendingBroadcast = null;
      return `⚠️ Pending broadcast confirmation expired (10m limit).\nPlease type *"msg all <your message>"* again to re-confirm.`;
    }

    if (_activeBroadcast.inProgress) {
      return `⚠️ Another broadcast is currently running (${_activeBroadcast.sent}/${_activeBroadcast.total}).\nPlease wait for it to complete or check status with *"msg all status"*.`;
    }

    const broadcastMsg = _pendingBroadcast.text;
    const candidates = _pendingBroadcast.candidates;
    _pendingBroadcast = null;

    if (!waClient) {
      return `⚠️ WhatsApp client is not connected to dispatch messages.\nPlease ensure WhatsApp bot is connected and try again.`;
    }

    // Launch background dispatch
    startBackgroundBroadcast(broadcastMsg, candidates, waClient, context);

    return `🚀 *BROADCAST LAUNCHED!* 🚀\n\n` +
      `📨 Dispatching to *${candidates.length} candidates* in RecrutOS.\n` +
      `🛡️ Anti-ban pacing: 3.5 - 7.0s randomized delay between contacts.\n\n` +
      `💡 Check live progress anytime by replying: *"msg all status"*`;
  }

  // New broadcast composition
  const messageBody = extractBroadcastMessage(trimmed);

  if (!messageBody) {
    return `📢 *RecrutOS Mass Broadcast*\n\n` +
      `To broadcast a message to ALL candidates in RecrutOS, use:\n\n` +
      `👉 *msg all <your message>*\n\n` +
      `*Example:*\n` +
      `_msg all Happy Navratri to you and your family! May this festival bring peace, prosperity, and joy._\n\n` +
      `*Personalization tip:* You can include *{name}* and it will be automatically replaced with each candidate's first name!`;
  }

  // Fetch candidates
  const candidates = await fetchActiveCandidates();
  if (!candidates.length) {
    return `⚠️ No active candidates found in RecrutOS database.`;
  }

  // Save pending broadcast
  _pendingBroadcast = {
    text: messageBody,
    candidates,
    createdAt: Date.now()
  };

  const sampleCandidate = candidates[0];
  const sampleFirstName = (sampleCandidate?.name || 'Candidate').trim().split(/\s+/)[0] || 'Candidate';
  const sampleFormatted = messageBody.includes('{name}')
    ? messageBody.replace(/{name}/g, sampleFirstName)
    : `Hi ${sampleFirstName},\n\n${messageBody}`;

  return `📢 *BROADCAST CONFIRMATION REQUIRED* 📢\n\n` +
    `You are preparing to broadcast to *${candidates.length} active candidates* in RecrutOS.\n\n` +
    `📝 *Sample Preview for "${sampleCandidate?.name || 'Candidate'}":*\n` +
    `───────────────────────\n` +
    `${sampleFormatted}\n` +
    `───────────────────────\n\n` +
    `🛡️ *Safety & Protection:*\n` +
    `• Candidates on DND or Trash are automatically excluded.\n` +
    `• Safe anti-ban delay (4-7s randomized) between messages.\n\n` +
    `👉 Reply *"msg all confirm"* (or *"confirm"*) to start broadcast.\n` +
    `👉 Reply *"msg all cancel"* to abort.`;
}

/**
 * Background loop to safely send messages to all candidates without blocking the bot.
 */
async function startBackgroundBroadcast(messageTemplate, candidates, waClient, context = {}) {
  _activeBroadcast = {
    inProgress: true,
    total: candidates.length,
    sent: 0,
    failed: 0,
    startTime: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
    lastUpdated: Date.now(),
    messagePreview: messageTemplate.length > 60 ? messageTemplate.substring(0, 57) + '...' : messageTemplate
  };

  console.log(`📢 [BroadcastService] Starting mass broadcast to ${candidates.length} candidates...`);

  // Run in detached async loop
  (async () => {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const rawPhone = String(candidate.phone || '').replace(/\D/g, '').slice(-10);

      // Check DND
      try {
        if (isOnDnd(rawPhone)) {
          console.log(`⏭️ [BroadcastService] Skipping ${candidate.name} (${rawPhone}) - on DND`);
          _activeBroadcast.failed++;
          continue;
        }
      } catch (_) {}

      const firstName = (candidate.name || 'Candidate').trim().split(/\s+/)[0] || 'Candidate';
      const personalized = messageTemplate.includes('{name}')
        ? messageTemplate.replace(/{name}/g, firstName)
        : `Hi ${firstName},\n\n${messageTemplate}`;

      const chatId = `91${rawPhone}@c.us`;

      try {
        if (waClient && typeof waClient.sendMessage === 'function') {
          await waClient.sendMessage(chatId, personalized);
          _activeBroadcast.sent++;
          console.log(`[${_activeBroadcast.sent}/${candidates.length}] Sent to ${candidate.name} (${rawPhone})`);
        } else {
          console.warn(`[BroadcastService] waClient.sendMessage unavailable`);
          _activeBroadcast.failed++;
        }
      } catch (sendErr) {
        console.error(`❌ [BroadcastService] Failed sending to ${rawPhone}:`, sendErr.message);
        _activeBroadcast.failed++;
      }

      // Safe anti-ban randomized delay between 3500ms and 6500ms
      const delay = Math.floor(Math.random() * 3000) + 3500;
      await new Promise(r => setTimeout(r, delay));
    }

    _activeBroadcast.inProgress = false;
    _activeBroadcast.lastUpdated = Date.now();
    console.log(`🏁 [BroadcastService] Mass broadcast completed: ${_activeBroadcast.sent} sent, ${_activeBroadcast.failed} failed.`);

    // Optional notification to trainer
    try {
      if (context.reply && typeof context.reply === 'function') {
        await context.reply(
          `🎉 *Mass Broadcast Complete!*\n\n` +
          `✅ Successfully sent: *${_activeBroadcast.sent}*\n` +
          `⚠️ Failed / DND skipped: *${_activeBroadcast.failed}*\n` +
          `📊 Total candidates: *${_activeBroadcast.total}*`
        );
      }
    } catch (_) {}
  })();
}

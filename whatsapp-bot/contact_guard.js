/**
 * contact_guard.js — Nova's Protected World
 * ==========================================
 * Defines the hard boundary between Nova's professional world
 * and YOUR personal world (mom, dad, Sakshi, close friends).
 *
 * RULES:
 *  1. Bot NEVER initiates contact to any protected number
 *  2. If a protected contact messages the bot number by accident,
 *     bot silently ignores OR sends a polite human redirect
 *  3. Personal conversations are never stored in RecrutOS
 *  4. The bot has no access to protected contacts' chat history
 *
 * How to add contacts:
 *  - Add phone numbers to PROTECTED_CONTACTS below (10-digit Indian)
 *  - OR add to .env.recruiter: PROTECTED_CONTACTS=9876543210,9123456789
 *  - OR send: /protect 9876543210 (from recruiter WhatsApp)
 *  - OR send: /unprotect 9876543210 (to remove)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROTECTED_PATH = path.resolve(__dirname, 'protected_contacts.json');

// ── Default protected contacts (hardcoded safelist) ──────────────────────────
// Add phone numbers of people who should NEVER be touched by the bot.
// 10-digit Indian format. Add names for logging clarity only.
const DEFAULT_PROTECTED = [
  // { phone: '9876543210', name: 'Mom', reason: 'Personal family' },
  // { phone: '9123456789', name: 'Sakshi', reason: 'Personal' },
  // { phone: '9000000001', name: 'Dad', reason: 'Personal family' },
];

// ── Load from env too ─────────────────────────────────────────────────────────
function parseEnvProtected() {
  const raw = (process.env.PROTECTED_CONTACTS || '').trim();
  if (!raw) return [];
  return raw.split(',').map(p => ({
    phone: p.trim().replace(/\D/g, '').slice(-10),
    name: 'Env contact',
    reason: 'Set via PROTECTED_CONTACTS env var',
  })).filter(c => c.phone.length === 10);
}

// ── Persistent protected list (survives restarts, can be edited via /protect) ─
function loadProtectedList() {
  try {
    if (fs.existsSync(PROTECTED_PATH)) {
      return JSON.parse(fs.readFileSync(PROTECTED_PATH, 'utf8'));
    }
  } catch (_) {}
  return [];
}

function saveProtectedList(list) {
  try {
    fs.writeFileSync(PROTECTED_PATH, JSON.stringify(list, null, 2), 'utf8');
  } catch (_) {}
}

// Merge all sources into a single Set of 10-digit phones
function buildProtectedSet() {
  const all = [...DEFAULT_PROTECTED, ...parseEnvProtected(), ...loadProtectedList()];
  return new Set(all.map(c => String(c.phone).replace(/\D/g, '').slice(-10)).filter(p => p.length === 10));
}

let _lastProtMtime = 0;
function getProtectedSet() {
  try {
    if (fs.existsSync(PROTECTED_PATH)) {
      const stats = fs.statSync(PROTECTED_PATH);
      if (stats.mtimeMs !== _lastProtMtime) {
        _lastProtMtime = stats.mtimeMs;
        const fresh = buildProtectedSet();
        _protected.clear();
        fresh.forEach(p => _protected.add(p));
      }
    }
  } catch (_) {}
  return _protected;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check if a WhatsApp ID belongs to a protected personal contact.
 * @param {string} waId - e.g. "919876543210@c.us"
 * @returns {boolean}
 */
export function isProtectedContact(waId) {
  const digits = (waId || '').replace('@c.us', '').replace(/\D/g, '');
  const phone10 = digits.slice(-10);
  return phone10.length === 10 && getProtectedSet().has(phone10);
}

/**
 * Add a phone to the protected list (persisted to JSON).
 * @param {string} phone - 10-digit number
 * @param {string} name - Display name for logs
 */
export function protectContact(phone, name = 'Personal contact') {
  const clean = String(phone).replace(/\D/g, '').slice(-10);
  if (clean.length !== 10) return false;
  const list = loadProtectedList();
  if (!list.find(c => c.phone === clean)) {
    list.push({ phone: clean, name, reason: 'Added via /protect command', addedAt: new Date().toISOString() });
    saveProtectedList(list);
    _protected.add(clean);
    console.log(`🛡️ [ContactGuard] Protected: ${name} (${clean})`);
  }
  return true;
}

/**
 * Remove a phone from the protected list.
 * @param {string} phone
 */
export function unprotectContact(phone) {
  const clean = String(phone).replace(/\D/g, '').slice(-10);
  const list = loadProtectedList().filter(c => c.phone !== clean);
  saveProtectedList(list);
  _protected.delete(clean);
  return true;
}

/**
 * Get the full list of all protected contacts.
 * @returns {Array}
 */
export function getProtectedList() {
  const all = [...DEFAULT_PROTECTED, ...parseEnvProtected(), ...loadProtectedList()];
  const seen = new Set();
  return all.filter(c => {
    const p = String(c.phone).replace(/\D/g, '').slice(-10);
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

/**
 * The response to give if a protected contact somehow messages the bot.
 * Sends a friendly human redirect without exposing that it's a bot.
 * @returns {string}
 */
export function getProtectedContactResponse() {
  return null; // Return null = silently ignore (don't reply at all)
  // If you want to send a polite reply instead, uncomment this:
  // return "Hi! This number is used for work/recruitment. For personal messages please contact me on my regular number. 😊";
}

/**
 * Log that a protected contact tried to reach the bot (for awareness).
 * @param {string} waId
 * @param {string} name
 */
export function logProtectedContactAttempt(waId, name = 'Unknown') {
  const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.log(`🛡️ [ContactGuard] BLOCKED: ${name} (${waId}) tried to reach bot at ${time}. Silently ignored.`);
}

/**
 * recruiter_db.js — RecrutOS Supabase Bridge for WhatsApp Bot
 * ============================================================
 * Connects the WhatsApp recruiter bot directly to the RecrutOS
 * Supabase database (ros_candidates table). All candidates added
 * here appear live on the RecrutOS mobile app.
 *
 * Schema mirrors recOS/supabase_db.js for 100% compatibility.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { getCachedPhoneForLid } from './lid_resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Config ──────────────────────────────────────────────────────────────────
// Load Supabase credentials from recOS .env (the shared source of truth)
const RECOS_ENV_PATH = path.resolve(__dirname, '../../recOS/.env');
const LOCAL_ENV_PATH = path.resolve(__dirname, '.env.recruiter');

function loadRecrutOSEnv() {
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
      console.log(`[RecruiterDB] Loaded env from: ${path.basename(envPath)}`);
      return;
    }
  }
  console.warn('[RecruiterDB] ⚠️ No recOS .env found — DB features will be disabled.');
}

loadRecrutOSEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// The RecrutOS user ID to attribute WhatsApp-sourced candidates to.
// This is the "WhatsApp Bot" virtual recruiter account in ros_users.
// Change this to the actual UUID of your bot/admin account in Supabase.
// The RecrutOS user ID to attribute WhatsApp-sourced candidates to.
// This is the "WhatsApp Bot" virtual recruiter account in ros_users.
export const BOT_USER_ID = process.env.RECOS_BOT_USER_ID || '0773c564-ebe7-430b-973d-35912e855425';

let _client = null;

export function getClient() {
  if (!_client && SUPABASE_URL && SUPABASE_KEY) {
    _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    console.log('[RecruiterDB] ✅ Connected to RecrutOS Supabase');
  }
  return _client;
}

export function isDbConnected() {
  // Only URL + KEY needed to confirm connection — BOT_USER_ID is optional
  return !!(SUPABASE_URL && SUPABASE_KEY &&
    !SUPABASE_URL.includes('your_') && !SUPABASE_KEY.includes('your_'));
}

// ── DND (Do Not Disturb) List ────────────────────────────────────────────────
// Persisted in local JSON AND Supabase notes so it survives restarts without loss

const DND_PATH = path.resolve(__dirname, 'dnd_list.json');

function loadDndList() {
  const set = new Set();
  try {
    if (fs.existsSync(DND_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DND_PATH, 'utf8'));
      if (Array.isArray(parsed)) {
        parsed.forEach(p => {
          const c = cleanPhone(p);
          if (c && c.length === 10) set.add(c);
        });
      }
    }
  } catch (_) {}
  return set;
}

function saveDndList(set) {
  try {
    fs.writeFileSync(DND_PATH, JSON.stringify([...set]), 'utf8');
  } catch (_) {}
}

const _dndList = loadDndList();

export function addToDnd(phone) {
  const clean = cleanPhone(phone);
  if (clean && clean.length === 10) {
    _dndList.add(clean);
    saveDndList(_dndList);

    // Sync note to Supabase ros_candidates asynchronously
    (async () => {
      try {
        const sb = getClient();
        if (sb) {
          const { data } = await sb.from('ros_candidates')
            .select('id, notes')
            .or(`phone.eq.${clean},phone.eq.91${clean},phone.eq.+91 ${clean}`)
            .limit(1);
          if (data && data[0]) {
            const existing = data[0].notes || '';
            if (!existing.includes('Muted by Shetty Saa')) {
              const updated = `[${new Date().toISOString().slice(0, 10)}] [Muted by Shetty Saa] Outreach paused by recruiter.\n${existing}`;
              await sb.from('ros_candidates').update({ notes: updated.trim() }).eq('id', data[0].id);
            }
          }
        }
      } catch (_) {}
    })();

    return true;
  }
  return false;
}

export function removeFromDnd(phone) {
  const clean = cleanPhone(phone);
  const removed = clean ? _dndList.delete(clean) : false;
  if (removed) saveDndList(_dndList);
  return removed;
}

export function isOnDnd(phone) {
  const clean = cleanPhone(phone);
  return clean ? _dndList.has(clean) : false;
}

// ── Recruiter Numbers ────────────────────────────────────────────────────────
// These numbers get full recruiter command access. Store in .env.recruiter or hardcode.
const RECRUITER_NUMBERS_RAW = (process.env.RECRUITER_NUMBERS || '918080635121').split(',');
const _recruiterSet = new Set(
  RECRUITER_NUMBERS_RAW.map(n => n.trim().replace(/\D/g, '')).filter(Boolean)
);

// ── HARDCODED BOSS NUMBERS — always recognized, env-independent ──────────────
// These are the owner's known numbers. Add more here if you get a new SIM.
const HARDCODED_BOSS_PHONES = ['8080635121', '8591383695', '918080635121', '918591383695'];
for (const n of HARDCODED_BOSS_PHONES) _recruiterSet.add(n);

// Automatically include trainer phone in recruiter set
if (process.env.TRAINER_CONTACT_PHONE) {
  const tp = process.env.TRAINER_CONTACT_PHONE.replace(/\D/g, '');
  if (tp) {
    _recruiterSet.add(tp);
    _recruiterSet.add(`91${tp.slice(-10)}`);
    _recruiterSet.add(tp.slice(-10));
  }
}

export function addRecruiterNumber(numberOrId) {
  if (!numberOrId) return;
  const raw = String(numberOrId).trim();
  const digits = raw.replace('@c.us', '').replace('@lid', '').replace(/\D/g, '');
  if (digits) {
    _recruiterSet.add(digits);
    if (digits.length >= 10) {
      _recruiterSet.add(digits.slice(-10));
    }
  }
}

export function isRecruiter(whatsappId) {
  if (!whatsappId) return false;
  const digits = String(whatsappId).replace('@c.us', '').replace('@lid', '').replace(/\D/g, '');
  if (!digits) return false;

  // Fast path: check last 10 digits against all known boss numbers
  const digits10 = digits.slice(-10);
  for (const r of _recruiterSet) {
    if (!r) continue;
    const r10 = r.slice(-10);
    if (digits === r || digits10 === r10) return true;
  }
  return false;
}

// ── Seen Users (for new-user greeting) ──────────────────────────────────────
const SEEN_PATH = path.resolve(__dirname, 'seen_users.json');

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_PATH)) return new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8')));
  } catch (_) {}
  return new Set();
}

function saveSeen(set) {
  try {
    fs.writeFileSync(SEEN_PATH, JSON.stringify([...set]), 'utf8');
  } catch (_) {}
}

const _seenUsers = loadSeen();

export function isNewUser(whatsappId) {
  return !_seenUsers.has(whatsappId);
}

export function markUserSeen(whatsappId) {
  _seenUsers.add(whatsappId);
  saveSeen(_seenUsers);
}

export function unmarkUserSeen(whatsappId) {
  _seenUsers.delete(whatsappId);
  saveSeen(_seenUsers);
}

// ── Intake State Machine ─────────────────────────────────────────────────────
// Tracks where each candidate is in the 8-question intake flow
// Map<whatsappId, { step, data: {name, location, experience, years, process, salary, commLevel, minSalary, available} }>
const _intakeStates = new Map();

export const INTAKE_STEPS = [
  'name', 'location', 'experience', 'process', 'salary', 'comm_level', 'min_salary', 'availability'
];

export const INTAKE_QUESTIONS = {
  name:         "Hi! 👋 Welcome. I'm from the HR team. May I know your *full name* please?",
  location:     "Thanks {name}! Which area in Mumbai are you currently based in? (e.g. Malad, Thane, Andheri...)",
  experience:   "Got it! Are you a *fresher* or do you have prior work experience? If experienced, how many years?",
  process:      "We are primarily aligning candidates for high-growth *International Voice & Customer Ops* profiles with packages up to ₹35k–₹60k. Are you open for Voice process?",
  salary:       "What is your current or last *in-hand monthly salary*? (If fresher, type 'fresher')",
  comm_level:   "How would you rate your *English communication*? Excellent / Good / Average?",
  min_salary:   "What is the *minimum salary* you would accept per month?",
  availability: "Great! Are you available to attend an interview *this week*? ✅",
};

export function getIntakeState(whatsappId) {
  return _intakeStates.get(whatsappId) || null;
}

export function setIntakeState(whatsappId, state) {
  _intakeStates.set(whatsappId, state);
}

export function clearIntakeState(whatsappId) {
  _intakeStates.delete(whatsappId);
}

export function isInIntakeFlow(whatsappId) {
  return _intakeStates.has(whatsappId);
}

// ── Human Handoff Queue ──────────────────────────────────────────────────────
// Tracks candidates waiting for a human recruiter callback
const _pendingHuman = new Set();

export function flagForHumanReview(whatsappId) {
  _pendingHuman.add(whatsappId);
}

export function isWaitingForHuman(whatsappId) {
  return _pendingHuman.has(whatsappId);
}

export function clearHumanFlag(whatsappId) {
  _pendingHuman.delete(whatsappId);
}

export function getPendingHumanList() {
  return [..._pendingHuman];
}

// ── Phone Normalization ──────────────────────────────────────────────────────
export function cleanPhone(rawPhone) {
  if (!rawPhone) return '';
  let p = String(rawPhone).replace(/\D/g, '');
  if (p.startsWith('91') && p.length === 12) p = p.slice(2);
  if (p.startsWith('0') && p.length === 11) p = p.slice(1);
  return /^[6-9]\d{9}$/.test(p) ? p : '';
}

/**
 * Builds a Supabase .or() filter string that matches phones formatted as
 * 9920840678, +91 99208 40678, 99208 40678, +91-9920840678, etc.
 */
export function buildPhoneSearchFilter(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '').slice(-10);
  if (digits.length === 10) {
    const p1 = digits.slice(0, 5);
    const p2 = digits.slice(5);
    return `phone.ilike.%${digits}%,phone.ilike.%${p1}%${p2}%`;
  }
  if (digits.length >= 6) {
    return `phone.ilike.%${digits}%`;
  }
  return `phone.ilike.%${rawPhone}%`;
}

// Extract phone from WhatsApp ID (e.g. "919876543210@c.us" → "9876543210")
// NEVER slice random digits from an @lid ID!
export function phoneFromWaId(waId) {
  if (!waId) return '';
  if (waId.endsWith('@lid')) {
    return getCachedPhoneForLid(waId);
  }
  const digits = (waId || '').replace('@c.us', '').replace(/\D/g, '');
  return cleanPhone(digits) || cleanPhone(digits.slice(-10));
}

// ── Supabase Operations ──────────────────────────────────────────────────────

/**
 * Add a new candidate to RecrutOS Supabase (ros_candidates table).
 * @param {Object} candidateData - The intake profile collected from the candidate.
 * @param {string} candidateData.name
 * @param {string} candidateData.phone
 * @param {string} [candidateData.location]
 * @param {string} [candidateData.experience] - 'Fresher' | 'Experienced'
 * @param {string} [candidateData.years]
 * @param {string} [candidateData.process]
 * @param {string} [candidateData.inhand_salary]
 * @param {string} [candidateData.comm_level]
 * @param {string} [candidateData.notes]
 * @param {string} [candidateData.process_status] - e.g. 'Pending Human Review'
 * @returns {Object} result with { success, data, error }
 */
export async function addCandidateToRecrutOS(candidateData) {
  const client = getClient();
  if (!client) return { success: false, error: 'DB not connected — check SUPABASE_URL and SUPABASE_KEY' };
  if (!BOT_USER_ID) return { success: false, error: 'RECOS_BOT_USER_ID not set — cannot attribute candidate to a recruiter account' };

  // ── HARD GUARD 1: Phone must be valid 10-digit Indian mobile ────────────
  // A candidate without a valid phone cannot be opened in RecrutOS (causes crash).
  const rawPhone = cleanPhone(candidateData.phone) || String(candidateData.phone || '').replace(/\D/g, '').slice(-10);
  if (!rawPhone || !/^[6-9]\d{9}$/.test(rawPhone)) {
    console.error(`[RecruiterDB] ❌ REJECTED — invalid/missing 10-digit phone for "${candidateData.name}". Phone: "${candidateData.phone}"`);
    return { success: false, error: 'Valid 10-digit phone number is required — candidate not saved.' };
  }

  // ── HARD GUARD 2: Name cannot be a spam/auto-reply phrase ─────────────────
  const nameCheck = (candidateData.name || '').toLowerCase().trim();
  const SPAM_NAMES = [
    'thank you', 'thanks for', 'dear customer', 'auto reply', 'out of office',
    'please note', 'this is an', 'we have received', 'your request', 'ok', 'okay',
    'who are you', 'who r u', 'who is this', 'not provided', 'unknown', 'friend', 'lead'
  ];
  if (!nameCheck || nameCheck.length < 2 || SPAM_NAMES.some(s => nameCheck === s || nameCheck.startsWith(s + ' '))) {
    console.error(`[RecruiterDB] ❌ REJECTED — spam/invalid name: "${candidateData.name}"`);
    return { success: false, error: 'Invalid candidate name — looks like a spam/auto-reply message.' };
  }

  // ── GUARD 3: Dedup — don't create duplicate if phone already exists ────────
  const { data: existing } = await client
    .from('ros_candidates')
    .select('id, name, phone')
    .or(buildPhoneSearchFilter(rawPhone))
    .limit(1);
  if (existing && existing.length > 0) {
    console.log(`[RecruiterDB] ⚠️ Duplicate — ${rawPhone} already exists as "${existing[0].name}" (ID: ${existing[0].id}). Skipping insert.`);
    return { success: true, data: existing[0], duplicate: true };
  }

  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const sourceNote = `[${timestamp}] [WhatsApp] Candidate registered via WhatsApp bot.`;
  const notes = candidateData.notes ? `${sourceNote}\n${candidateData.notes}` : sourceNote;

  const row = {
    user_id: BOT_USER_ID,
    name: candidateData.name.trim(),
    phone: rawPhone,
    location: candidateData.location || '',
    experience: candidateData.experience || '',
    years: candidateData.years || '',
    process: candidateData.process_status || candidateData.process || '',
    comm_level: candidateData.comm_level || '',
    inhand_salary: candidateData.inhand_salary ? String(candidateData.inhand_salary) : '',
    qualification: candidateData.qualification || '',
    last_company: candidateData.last_company || '',
    currently_working: candidateData.currently_working || '',
    is_trash: false,
    notes,
    created_at: new Date().toISOString(),
  };

  const { data, error } = await client.from('ros_candidates').insert(row).select().single();
  if (error) {
    console.error('[RecruiterDB] addCandidate error:', error.message);
    return { success: false, error: error.message };
  }
  console.log(`[RecruiterDB] ✅ Candidate saved: ${row.name} (${row.phone}) ID: ${data.id}`);
  return { success: true, data };
}

/**
 * Move candidate to trash in RecrutOS.
 * @param {string} identifier - name or phone
 */
export async function trashCandidate(identifier) {
  const client = getClient();
  if (!client) return { success: false, error: 'DB not connected' };

  const isPhone = /^\d{6,}$/.test(String(identifier).replace(/\D/g, ''));
  let query = client.from('ros_candidates').select('id,name,phone').or('is_trash.is.null,is_trash.eq.false');
  query = isPhone
    ? query.or(buildPhoneSearchFilter(identifier))
    : query.ilike('name', `%${identifier}%`);

  const { data: matches } = await query.limit(1).single();
  if (!matches) return { success: false, error: `Candidate "${identifier}" not found` };

  const { error } = await client.from('ros_candidates').update({
    is_trash: true,
    updated_at: new Date().toISOString()
  }).eq('id', matches.id);

  if (error) return { success: false, error: error.message };
  return { success: true, candidate: matches };
}


/**
 * Search for a candidate by name or phone.
 * @param {string} query
 * @returns {Array} matching candidate rows
 */
export async function searchCandidate(query) {
  const client = getClient();
  if (!client) return [];

  const q = String(query || '').trim();
  if (!q) return [];

  const isPhone = /^\d{7,}$/.test(q.replace(/\D/g, ''));

  let dbQuery = client.from('ros_candidates')
    .select('id,name,phone,experience,years,process,location,comm_level,inhand_salary,currently_working,last_company,qualification,lineup_status,joined_status,joined_company,interview_date,notes,created_at')
    .or('is_trash.is.null,is_trash.eq.false')
    .order('created_at', { ascending: false })
    .limit(5);

  if (isPhone) {
    dbQuery = dbQuery.or(buildPhoneSearchFilter(q));
  } else {
    dbQuery = dbQuery.ilike('name', `%${q}%`);
  }

  const { data, error } = await dbQuery;
  if (error) { console.error('[RecruiterDB] search error:', error.message); return []; }
  return data || [];
}

/**
 * Update candidate status (lineup, joined, noshow, dropout, note).
 * @param {string} identifier - name or phone
 * @param {Object} updates - fields to update (e.g. { lineup_status: 'Yes', interview_date: '2026-10-10' })
 * @param {string} userId - the recruiter's userId
 */
export async function updateCandidateStatus(identifier, updates, userId = BOT_USER_ID) {
  const client = getClient();
  if (!client) return { success: false, error: 'DB not connected' };

  const isPhone = /^\d{6,}$/.test(identifier.replace(/\D/g, ''));
  let query = client.from('ros_candidates').select('id,name,phone').or('is_trash.is.null,is_trash.eq.false');
  query = isPhone
    ? query.or(buildPhoneSearchFilter(identifier))
    : query.ilike('name', `%${identifier}%`);

  const { data: matches } = await query.limit(1).single();
  if (!matches) return { success: false, error: `Candidate "${identifier}" not found` };

  const { error } = await client.from('ros_candidates').update({
    ...updates,
    updated_at: new Date().toISOString()
  }).eq('id', matches.id);

  if (error) return { success: false, error: error.message };
  return { success: true, candidate: matches };
}

/**
 * Append a timestamped note to a candidate's notes field.
 * @param {string} identifier - name or phone
 * @param {string} note - note text to append
 */
export async function appendNote(identifier, note) {
  const client = getClient();
  if (!client) return { success: false, error: 'DB not connected' };

  const isPhone = /^\d{6,}$/.test(identifier.replace(/\D/g, ''));
  let query = client.from('ros_candidates').select('id,name,phone,notes').or('is_trash.is.null,is_trash.eq.false');
  query = isPhone
    ? query.or(buildPhoneSearchFilter(identifier))
    : query.ilike('name', `%${identifier}%`);

  const { data: candidate } = await query.limit(1).single();
  if (!candidate) return { success: false, error: `Candidate "${identifier}" not found` };

  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  let noteText = note.trim();
  if (noteText.toLowerCase() === 'x') noteText = 'ringing or not responding';

  // If this is an automated bot update, route it to the single organized Bot Summary block
  if (noteText.startsWith('[') || noteText.includes('WhatsApp Update') || noteText.includes('Lineup') || noteText.includes('CV via WhatsApp')) {
    return updateOrganizedBotNote(identifier, { noteText });
  }

  const stampedNote = `[${timestamp}] ${noteText}`;
  const newNotes = candidate.notes ? `${stampedNote}\n${candidate.notes}` : stampedNote;

  const { error } = await client.from('ros_candidates').update({
    notes: newNotes,
    updated_at: new Date().toISOString()
  }).eq('id', candidate.id);

  if (error) return { success: false, error: error.message };
  return { success: true, candidate };
}

/**
 * Update candidate notes with one small, well-organized Bot Summary block
 * at the top, without spamming dozens of fragmented separate notes.
 *
 * Keeps any manual recruiter notes untouched below.
 */
export async function updateOrganizedBotNote(identifier, {
  summaryLine = '',
  lastChatSnippet = '',
  noteText = ''
} = {}) {
  const client = getClient();
  if (!client) return { success: false, error: 'DB not connected' };

  const isPhone = /^\d{6,}$/.test(identifier.replace(/\D/g, ''));
  let query = client.from('ros_candidates')
    .select('id,name,phone,notes,lineup_status,interview_date,process,location,inhand_salary,experience')
    .or('is_trash.is.null,is_trash.eq.false');
  query = isPhone
    ? query.or(buildPhoneSearchFilter(identifier))
    : query.ilike('name', `%${identifier}%`);

  const { data: candidate } = await query.limit(1).single();
  if (!candidate) return { success: false, error: `Candidate "${identifier}" not found` };

  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  const timeStr = `${d.toISOString().slice(8, 10)}/${d.toISOString().slice(5, 7)} ${d.toISOString().slice(11, 16)} IST`;

  const statusPart = candidate.lineup_status === 'Yes'
    ? `Lineup Confirmed (${candidate.interview_date || 'Date TBD'})`
    : (candidate.process || 'Active Lead');
  const detailsPart = [
    candidate.location && candidate.location !== 'Mumbai' ? candidate.location : '',
    candidate.inhand_salary ? `₹${candidate.inhand_salary}` : '',
    candidate.experience ? `Exp: ${candidate.experience}` : ''
  ].filter(Boolean).join(' · ');

  const summaryHeader = `🤖 BOT SUMMARY [${timeStr}]:`;
  const summaryBody = summaryLine || `${statusPart}${detailsPart ? ` | ${detailsPart}` : ''}`;
  const cleanNote = noteText.replace(/^\[[^\]]+\]\s*/g, '').trim();
  const chatLine = lastChatSnippet
    ? `💬 ${lastChatSnippet.slice(0, 140)}`
    : (cleanNote ? `📝 ${cleanNote.slice(0, 140)}` : '');

  const newBotBlock = `${summaryHeader}\n${summaryBody}${chatLine ? `\n${chatLine}` : ''}`;

  // Strip any previous 🤖 BOT SUMMARY block so notes don't grow into a massive list
  let existingNotes = (candidate.notes || '').trim();
  existingNotes = existingNotes.replace(/🤖 BOT SUMMARY \[[^\]]+\]:[^]*?(?=(?:\n\n|\n\[|\nRecruiter:|$))/i, '').trim();

  // Combine: Bot Summary on top, followed by any manual recruiter notes below
  const finalNotes = existingNotes ? `${newBotBlock}\n\n${existingNotes}` : newBotBlock;

  const { error } = await client.from('ros_candidates').update({
    notes: finalNotes,
    updated_at: new Date().toISOString()
  }).eq('id', candidate.id);

  if (error) return { success: false, error: error.message };
  return { success: true, candidate };
}

/**
 * Add or update a candidate's follow-up / reminder based on lineup date.
 * Matches the RecrutOS auto-task logic in supabase_db.js.
 */
export async function addLineupFollowup(candidatePhone, candidateName, interviewDate, userId = BOT_USER_ID) {
  const client = getClient();
  if (!client) return;

  const now = new Date();
  const target = new Date(`${interviewDate}T11:00:00`);
  if (isNaN(target.getTime())) return;

  const hoursDiff = (target.getTime() - now.getTime()) / (1000 * 60 * 60);
  const note = `Auto-Task: Lineup for ${interviewDate}`;

  if (hoursDiff > 48) {
    // Followup
    await client.from('ros_followups').insert({
      user_id: userId,
      candidate_phone: candidatePhone,
      candidate_name: candidateName,
      followup_date: interviewDate,
      note,
      status: 'Pending',
      created_at: new Date().toISOString()
    }).select();
  } else {
    // Reminder
    await client.from('ros_reminders').insert({
      user_id: userId,
      candidate_phone: candidatePhone,
      candidate_name: candidateName,
      reminder_date: interviewDate,
      reminder_time: '11:00',
      note,
      completed: 'false',
      created_at: new Date().toISOString()
    }).select();
  }
}

/**
 * Get all users from ros_users table (for bot manager sync).
 */
export async function getAllRecruiterUsers() {
  const client = getClient();
  if (!client) return [];
  const { data, error } = await client.from('ros_users').select('id,email,display_name,telegram_token').eq('is_active', true);
  if (error) return [];
  return data || [];
}

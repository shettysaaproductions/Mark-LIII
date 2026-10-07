/**
 * saa_trainer_chat.js — WhatsApp Interactive Recruitment Commander & Trainer
 * =========================================================================
 * Transforms WhatsApp into a 2-way AI operations console for Shetty Saa.
 *
 * HOW IT WORKS:
 *   1. "Saa Office" dead contact (TRAINER_CONTACT_PHONE = +91 85913 83695)
 *      When you type in that chat window and hit send, message_create intercepts
 *      your message and Saa replies back as received messages in the SAME chat!
 *   2. Direct Recruiter Chat:
 *      When you text the bot from your personal recruiter phone (+91 8080635121),
 *      Saa treats you as the boss/trainer with the same conversational commander.
 *   3. Live RecrutOS Supabase Integration:
 *      Direct access to all 410+ candidates, lineups, notes, and schedules.
 *
 * COMMANDS & CONVERSATIONAL CAPABILITIES:
 *   - "what's the updates of candidates for today's interview?" → Real-time briefing
 *   - "who has interview tomorrow?" → Tomorrow's schedule
 *   - "find freshers in Malad" / "show girls from Mira Road" → Live DB search
 *   - "note: Alan Pater selected in Firstsource" → Appends to candidate in Supabase
 *   - "JP Morgan drive postponed to Monday" → Updates training.md & live rules
 *   - "text all today candidates: Please reach venue by 11am" → Bulk outreach
 *   - "status report" → RecrutOS pipeline summary
 *   - Any natural conversation → AI recruitment co-pilot with live DB context
 */

import { createClient } from '@supabase/supabase-js';
import { addToDnd, removeFromDnd, addCandidateToRecrutOS, isOnDnd } from './recruiter_db.js';
import { protectContact, unprotectContact, isProtectedContact } from './contact_guard.js';
import { isAutoReplyPaused, setGlobalAutoReplyPaused } from './bot_pause_state.js';
import { callMCPTool, getMCPManifest } from './recrutos_mcp.js';
import { detectEnrichmentIntent, handleEnrichment } from './saa_enrichment.js';
import { callAny as callMultiAI, getActiveProviderCount } from './multi_ai_engine.js';
import { logAgentActivity, getRecentActivityBriefing } from './activity_log.js';
import { extractAllProfileFields } from './profile_extractor.js';
import { decideLaya, isLayaAvailable } from './laya_client.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TRAINING_PATH = path.resolve(__dirname, 'training.md');
const BRAIN_LOG_PATH = path.resolve(__dirname, 'brain_log.json');
const LOCAL_ENV_PATH = path.resolve(__dirname, '.env.recruiter');
const RECOS_ENV_PATH = path.resolve(__dirname, '../../recOS/.env');

function loadEnvIfNeeded() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY && process.env.TRAINER_CONTACT_PHONE) return;
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
loadEnvIfNeeded();

// ── Dynamic Configuration ─────────────────────────────────────────────────────
export function getTrainerPhone() {
  loadEnvIfNeeded();
  return (process.env.TRAINER_CONTACT_PHONE || '8591383695').replace(/\D/g, '').slice(-10);
}

export function getRecruiterPhone() {
  loadEnvIfNeeded();
  return (process.env.RECRUITER_NUMBERS || '918080635121').split(',')[0].replace(/\D/g, '').slice(-10);
}

// ── Session Context Memory (Tracks Last Discussed Candidate across messages) ──
let _lastDiscussedCandidate = null;

export function setLastDiscussedCandidate(candidate) {
  if (!candidate) return;
  _lastDiscussedCandidate = {
    id: candidate.id || null,
    name: candidate.name || '',
    phone: candidate.phone || '',
    location: candidate.location || '',
    process: candidate.process || '',
    lineup_status: candidate.lineup_status || '',
    interview_date: candidate.interview_date || '',
    notes: candidate.notes || ''
  };
  console.log(`📌 [SaaTrainer] Context updated: Last discussed candidate is "${_lastDiscussedCandidate.name}" (${_lastDiscussedCandidate.phone})`);
}

export function getLastDiscussedCandidate() {
  return _lastDiscussedCandidate;
}

export function resetSessionContext() {
  const prevCandidate = _lastDiscussedCandidate?.name || null;
  _lastDiscussedCandidate = null;
  console.log(`🔄 [SaaTrainer] Session context reset: Cleared last discussed candidate${prevCandidate ? ` (was: ${prevCandidate})` : ''}.`);
  return prevCandidate;
}

function getClient() {
  loadEnvIfNeeded();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (url && key && !url.includes('your_') && !key.includes('your_')) {
    return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  }
  return null;
}

// ── IST Date Helpers ──────────────────────────────────────────────────────────
export function getISTDateString(offsetDays = 0) {
  const d = new Date();
  if (offsetDays !== 0) {
    d.setTime(d.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

export function getISTTimeString() {
  return new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatDisplayDate(dateStr) {
  try {
    const [y, m, d] = dateStr.split('-');
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    return dt.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  } catch (_) {
    return dateStr;
  }
}

// ── WhatsApp Contact Detectors ────────────────────────────────────────────────
/**
 * Detects outgoing message sent to the trainer dead-contact number.
 */
export function isTrainerChatMessage(msg) {
  const trainerPhone = getTrainerPhone();
  if (!msg.fromMe) return false;

  const remote = msg.id?.remote || '';
  const to = msg.to || '';
  const remotePhone = remote.replace('@c.us', '').replace('@lid', '').replace(/\D/g, '').slice(-10);
  const toPhone = to.replace('@c.us', '').replace('@lid', '').replace(/\D/g, '').slice(-10);

  const matched = (trainerPhone && (remotePhone === trainerPhone || toPhone === trainerPhone));
  if (matched) {
    console.log(`\n🎯 [SaaTrainer] DETECTED outgoing message to trainer contact (${trainerPhone}): "${(msg.body || '').slice(0, 50)}"`);
  }
  return matched;
}

/**
 * Async detector that also verifies chat.name for "Saa Office" or "Shetty Office".
 */
export async function isTrainerChat(msg) {
  if (!msg.fromMe) return false;
  if (isTrainerChatMessage(msg)) return true;

  const trainerPhone = getTrainerPhone();
  try {
    const chat = await msg.getChat().catch(() => null);
    if (!chat) return false;
    const name = (chat.name || '').toLowerCase();
    if (/saa\s*office|shetty\s*office/i.test(name)) {
      console.log(`\n🎯 [SaaTrainer] DETECTED message in "${chat.name}" chat: "${(msg.body || '').slice(0, 50)}"`);
      return true;
    }
    const chatId = (chat.id?._serialized || '').replace('@c.us', '').replace('@lid', '').replace(/\D/g, '').slice(-10);
    if (trainerPhone && chatId === trainerPhone) {
      return true;
    }
  } catch (_) {}

  return false;
}

/**
 * Detects incoming message FROM the trainer number.
 */
export function isFromTrainerContact(msgOrPhone) {
  const trainerPhone = getTrainerPhone();
  if (!trainerPhone) return false;
  const raw = typeof msgOrPhone === 'string' ? msgOrPhone : (msgOrPhone?.from || '');
  const digits = raw.replace('@c.us', '').replace('@lid', '').replace(/\D/g, '');
  return digits.length >= 10 && (digits.endsWith(trainerPhone) || trainerPhone.endsWith(digits.slice(-10)));
}

/**
 * Returns WhatsApp JID for replying to the trainer contact.
 */
export function getTrainerWaId() {
  const trainerPhone = getTrainerPhone();
  if (!trainerPhone) return null;
  const withCountry = trainerPhone.length === 10 ? `91${trainerPhone}` : trainerPhone;
  return `${withCountry}@c.us`;
}

// ── Database Operations ───────────────────────────────────────────────────────

/**
 * Fetch candidates scheduled for interviews on a specific date (YYYY-MM-DD).
 */
export async function getInterviewCandidates(targetDateStr) {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client.from('ros_candidates')
      .select('id, name, phone, process, location, experience, years, inhand_salary, comm_level, interview_date, lineup_status, notes, last_company, companies_json, updated_at')
      .or('is_trash.is.null,is_trash.eq.false')
      .eq('interview_date', targetDateStr)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('[SaaTrainer] Error fetching interviews:', error.message);
      return [];
    }

    return data || [];
  } catch (e) {
    console.error('[SaaTrainer] DB exception in getInterviewCandidates:', e.message);
    return [];
  }
}

/**
 * Search candidates by natural language filters.
 */
export async function searchCandidatesDB(query, filters = {}) {
  const client = getClient();
  if (!client) return [];

  try {
    let q = client.from('ros_candidates')
      .select('id, name, phone, location, experience, years, comm_level, inhand_salary, process, lineup_status, joined_status, notes, last_company')
      .or('is_trash.is.null,is_trash.eq.false')
      .order('created_at', { ascending: false });

    if (filters.location) q = q.ilike('location', `%${filters.location}%`);
    if (filters.experience) q = q.ilike('experience', `%${filters.experience}%`);
    if (filters.comm_level) q = q.ilike('comm_level', `%${filters.comm_level}%`);
    if (filters.process) q = q.ilike('process', `%${filters.process}%`);
    if (filters.lineup_status) q = q.eq('lineup_status', filters.lineup_status);
    if (query) q = q.ilike('name', `%${query}%`);

    const { data, error } = await q.limit(40);
    if (error) {
      console.error('[SaaTrainer] DB search error:', error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error('[SaaTrainer] DB exception in searchCandidatesDB:', e.message);
    return [];
  }
}

/**
 * Append a timestamped note to a candidate's record in Supabase.
 */
export async function appendCandidateNote(identifier, note) {
  const client = getClient();
  if (!client) return null;

  try {
    const isPhone = /^\d{7,}$/.test(identifier.replace(/\D/g, ''));
    let q = client.from('ros_candidates').select('id, name, phone, notes');
    q = isPhone
      ? q.ilike('phone', `%${identifier.replace(/\D/g, '').slice(-10)}%`)
      : q.ilike('name', `%${identifier.trim()}%`);

    const { data } = await q.limit(1);
    const candidate = data?.[0];
    if (!candidate) return null;

    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const newNote = `[${ts}] [Saa Office] ${note}\n${candidate.notes || ''}`.trim();

    await client.from('ros_candidates')
      .update({ notes: newNote, updated_at: new Date().toISOString() })
      .eq('id', candidate.id);

    return candidate;
  } catch (e) {
    console.error('[SaaTrainer] Error appending note:', e.message);
    return null;
  }
}

/**
 * Find candidate by name or phone in Supabase (ros_candidates).
 */
export async function findCandidateByNameOrPhone(identifier) {
  const client = getClient();
  if (!client) return null;

  try {
    const cleanId = String(identifier || '').trim();
    if (!cleanId) return null;

    const isPhone = /^\d{6,}$/.test(cleanId.replace(/\D/g, ''));
    let q = client.from('ros_candidates')
      .select('id, name, phone, process, location, experience, years, inhand_salary, comm_level, interview_date, lineup_status, joined_status, notes, last_company, companies_json, updated_at, created_at')
      .or('is_trash.is.null,is_trash.eq.false');

    if (isPhone) {
      const phoneDigits = cleanId.replace(/\D/g, '').slice(-10);
      q = q.ilike('phone', `%${phoneDigits}%`);
    } else {
      q = q.ilike('name', `%${cleanId}%`);
    }

    const { data, error } = await q.order('updated_at', { ascending: false }).limit(5);
    if (error) {
      console.error('[SaaTrainer] Candidate lookup error:', error.message);
      return null;
    }
    if (!data || data.length === 0) {
      // If full name didn't match, try first word if length >= 3
      const firstWord = cleanId.split(/\s+/)[0];
      if (firstWord && firstWord.length >= 3 && firstWord.toLowerCase() !== cleanId.toLowerCase()) {
        const { data: fallbackData } = await client.from('ros_candidates')
          .select('id, name, phone, process, location, experience, years, inhand_salary, comm_level, interview_date, lineup_status, joined_status, notes, last_company, companies_json, updated_at, created_at')
          .or('is_trash.is.null,is_trash.eq.false')
          .ilike('name', `%${firstWord}%`)
          .order('updated_at', { ascending: false })
          .limit(5);
        if (fallbackData && fallbackData.length > 0) return fallbackData[0];
      }
      return null;
    }
    return data[0];
  } catch (e) {
    console.error('[SaaTrainer] findCandidateByNameOrPhone exception:', e.message);
    return null;
  }
}

function levenshteinDistance(s1, s2) {
  if (!s1 || !s2) return 99;
  s1 = s1.toLowerCase().trim();
  s2 = s2.toLowerCase().trim();
  if (s1 === s2) return 0;
  const m = s1.length;
  const n = s2.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * Fuzzy search candidate in RecrutOS Supabase by name or first name.
 * Handles minor typos (e.g. "subair" -> "Zubair", "prathams" -> "Pratham").
 */
export async function fuzzyFindCandidate(rawName) {
  const client = getClient();
  if (!client || !rawName) return null;
  const target = String(rawName).trim().toLowerCase();
  if (target.length < 3) return null;

  try {
    const { data, error } = await client.from('ros_candidates')
      .select('id, name, phone, process, location, experience, years, inhand_salary, comm_level, interview_date, lineup_status, joined_status, notes, last_company, companies_json, updated_at, created_at')
      .or('is_trash.is.null,is_trash.eq.false')
      .order('updated_at', { ascending: false })
      .limit(150);

    if (error || !data || data.length === 0) return null;

    let bestMatch = null;
    let minDistance = 99;
    const targetFirstWord = target.split(/\s+/)[0];

    for (const c of data) {
      const cName = (c.name || '').toLowerCase().trim();
      if (!cName) continue;

      if (cName.includes(target) || target.includes(cName)) {
        return c;
      }

      const cFirstWord = cName.split(/\s+/)[0];
      if (cFirstWord.length >= 3 && (cFirstWord.includes(targetFirstWord) || targetFirstWord.includes(cFirstWord))) {
        return c;
      }

      const fullDist = levenshteinDistance(target, cName);
      if (fullDist < minDistance && fullDist <= 3) {
        minDistance = fullDist;
        bestMatch = c;
      }

      if (targetFirstWord.length >= 3 && cFirstWord.length >= 3) {
        const firstDist = levenshteinDistance(targetFirstWord, cFirstWord);
        if (firstDist < minDistance && firstDist <= 2) {
          minDistance = firstDist;
          bestMatch = c;
        }
      }
    }

    return bestMatch;
  } catch (e) {
    console.error('[SaaTrainer] fuzzyFindCandidate exception:', e.message);
    return null;
  }
}

/**
 * Clean raw commander input to extract a clean candidate name.
 * Aggressively removes leading verbs and trailing conversational clauses.
 */
export function extractCleanCandidateName(rawText) {
  if (!rawText) return '';
  let str = String(rawText).trim();

  // Strip leading action verbs / bot commands
  str = str.replace(/^(?:don+t?|don.?t|do\s+not|stop|pause|mute|blacklist|block|unmute|unblacklist|unblock)\s+(?:replying|reply|messaging|texting|msg|message|text|whatsapp|contacting|calling)?\s*(?:to\s+)?/i, '');
  str = str.replace(/^(?:remind\s+me\s+to\s+call|remind\s+me\s+to|remind|call|phone|text|msg|message|ping|ask|contact|check\s+with|tell|inform|invite)\s+/i, '');

  // Strip trailing intent clauses, reasons, conjunctions, and conversational filler
  str = str.replace(/\b(?:i\s+am\s+handling.*|i'm\s+handling.*|i\s+will\s+handle.*|i\s+will\s+align.*|handling.*|from\s+now.*|i\s+said.*|myself.*|personally.*|he\s+is.*|she\s+is.*|they\s+are.*|because.*|since.*|will.*|and.*|call.*|by\s+myself.*|right\s+now.*)\b.*/is, '');

  // Strip trailing dates, times, days, and appointment clauses
  // NOTE: Time patterns must require either ':mm' or 'am/pm' so standalone phone numbers or IDs are never stripped!
  str = str.replace(/\b(?:tomorrow|today|kal|aaj|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|by\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}(?:\s*(?:am|pm))?|\d{1,2}\s*(?:am|pm))\b.*/is, '');

  // Remove quotes, asterisks, brackets, punctuation
  str = str.replace(/[*_~`"']/g, '').trim();
  return str;
}

/**
 * Fetch recent candidates created in RecrutOS Supabase.
 */
export async function getRecentCandidates(limit = 10) {
  const client = getClient();
  if (!client) return [];

  try {
    const { data, error } = await client.from('ros_candidates')
      .select('id, name, phone, process, location, experience, years, inhand_salary, comm_level, interview_date, lineup_status, joined_status, notes, created_at, updated_at')
      .or('is_trash.is.null,is_trash.eq.false')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[SaaTrainer] getRecentCandidates error:', error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error('[SaaTrainer] getRecentCandidates exception:', e.message);
    return [];
  }
}

/**
 * Broadcast notification to Trainer chat, Recruiter chat, and Shetty Office group.
 */
export async function notifyTrainerAndOffice(waClient, text) {
  if (!waClient) return;
  try {
    const trainerWaId = getTrainerWaId();
    if (trainerWaId) {
      await waClient.sendMessage(trainerWaId, '\u200B' + text).catch(() => {});
    }
    const recruiterPhone = getRecruiterPhone();
    if (recruiterPhone && recruiterPhone !== getTrainerPhone()) {
      const recrWaId = `91${recruiterPhone}@c.us`;
      await waClient.sendMessage(recrWaId, '\u200B' + text).catch(() => {});
    }
    // Also broadcast to any group with Shetty Office or Saa Office
    try {
      const chats = await waClient.getChats();
      for (const chat of chats) {
        if (chat.isGroup && /shetty\s*office|saa\s*office|recrutos|mark.?liii/i.test(chat.name || '')) {
          await chat.sendMessage('\u200B' + text).catch(() => {});
        }
      }
    } catch (_) {}
  } catch (err) {
    console.error('[SaaTrainer] notifyTrainerAndOffice error:', err.message);
  }
}

/**
 * Update training.md with new recruiter rules.
 */
export function updateTrainingMd(instruction, type = 'LIVE_UPDATE') {
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const header = '## 12. Live Training Updates (Auto-Generated from Saa Office Chat)';
  const entry = `\n- [${ts}] [${type}] ${instruction}`;
  let content = fs.existsSync(TRAINING_PATH) ? fs.readFileSync(TRAINING_PATH, 'utf8') : '';

  if (content.includes(header)) {
    content = content.replace(header, `${header}${entry}`);
  } else {
    content += `\n\n---\n\n${header}${entry}\n`;
  }
  fs.writeFileSync(TRAINING_PATH, content, 'utf8');

  // Also log to brain_log.json
  try {
    let logs = [];
    if (fs.existsSync(BRAIN_LOG_PATH)) {
      logs = JSON.parse(fs.readFileSync(BRAIN_LOG_PATH, 'utf8'));
    }
    logs.push({ timestamp: ts, type, instruction });
    fs.writeFileSync(BRAIN_LOG_PATH, JSON.stringify(logs, null, 2), 'utf8');
  } catch (_) {}
}

// ── Natural Language Understanding & Classification ──────────────────────────

export function classifyIntent(text) {
  const t = text.toLowerCase().trim();

  // 0. Analytical / comparative / advice questions -> general AI (will use injected today's context)
  if (/who among|which candidate|which of|highest|lowest|best candidate|compare|analyze|how should|recommend|suggest|what do you think|draft a|write a/i.test(t)) {
    return 'general';
  }

  // 0. Casual Greetings from Boss ("Hi", "How are you", "Hi saa")
  if (/^(hi|hello|hey|yo|namaste|good\s*(morning|afternoon|evening))(\s+(saa|bot|there))?\b[!?.]*$/i.test(t) || /^how are you(\s+(saa|bot))?\??$/i.test(t)) {
    return 'greeting';
  }

  // 1. Candidate search (Higher priority than mute if 'find/search/show' is present)
  if (/find|search|list|show|who are|fetch|get all|give me|candidates in|candidates from/i.test(t)) {
    return 'search';
  }

  // 2. Mute / pause / blacklist candidate outreach ("dont msg ganesh...", "stop replying abdul...", "blacklist 8591577476", "mute 7304537510")
  if (/(?:don+t?|don.?t|do\s+not|stop|pause|mute|blacklist|block)\s+(?:replying|reply|messaging|texting|msg|message|text|whatsapp|contacting|calling)?\s*(?:to\s+)?([a-zA-Z0-9\+\s]+)/i.test(t) ||
      /^(?:blacklist|block|mute)\s+([a-zA-Z0-9\+\s]+)/i.test(t)) {
    return 'mute_candidate';
  }

  // 2b. Unmute / resume outreach ("unmute ganesh", "resume messaging abdul", "unblacklist 8591577476")
  if (/(?:unmute|unblacklist|unblock|resume\s+(?:messaging|outreach|replies|texting)?)\s*(?:to\s+)?([a-zA-Z0-9\+\s]+)/i.test(t) ||
      /^(?:unmute|unblacklist|unblock)\s+([a-zA-Z0-9\+\s]+)/i.test(t)) {
    return 'unmute_candidate';
  }

  // 3. Lineup availability check ("check the todays line up and ask them are they available today")
  if (/(?:check|ask).*today.*(?:line\s*up|candidate).*(?:available|availability)/i.test(t) ||
      /(?:check\s+(?:the\s+)?today.?s?\s+line\s*up\s+and\s+ask|ask\s+(?:them\s+)?(?:are\s+they\s+available|availability|if\s+they\s+are\s+available))/i.test(t)) {
    return 'lineup_availability_check';
  }

  // 4. Candidate joining inquiry ("ask pragati if she can join today")
  if (/(?:ask|check\s+with|tell|inquire)\s+([a-zA-Z0-9\+\s]+?)\s+(?:if\s+she\s+can\s+join|if\s+he\s+can\s+join|can\s+she\s+join|can\s+he\s+join|can\s+join|joining\s+today|about\s+joining|to\s+join)/i.test(t)) {
    return 'ask_joining_candidate';
  }

  // 5. Single candidate outreach — catches:
  //    "msg Abdul", "can u msg Rahul", "please text 9876...", "can you ask Priya her salary"
  if (/(?:^|can\s+(?:u|you)\s+|please\s+|kindly\s+)(?:msg|message|text|whatsapp|tell|inform|ask|send|ping|contact|reach\s+out)\s+/i.test(t) &&
      !/text all|msg all|inform all|whatsapp all|send to all|notify all|remind all/i.test(t)) {
    return 'single_candidate_outreach';
  }

  // 6. Recent resumes / numbers sync check ("what are the new numbers or resumes we received have you saved them in recrutos system...")
  if (/(?:what\s+are\s+the\s+)?new\s+(?:numbers|resumes|cvs|candidates)|received\s+(?:resumes|cvs|numbers|candidates)|saved\s+(?:them\s+in|to)\s+recrutos|recrutos\s+system|new\s+line\s*ups\s+added|any\s+new\s+line\s*ups|recent\s+resumes|show\s+new\s+candidates/i.test(t)) {
    return 'recent_resumes';
  }

  // 7. Today's interview / lineup / schedule / update queries ("What is the update?", "today lineup")
  if (
    /^(what.?s?|any|give me)?\s*(the\s*)?updates?\??$/i.test(t) ||
    /what is the update/i.test(t) ||
    /today.?s? (interview|lineup|candidate|update|schedule|status|alignment)/.test(t) ||
    /(interview|candidate|lineup|schedule|alignment|update)s? (for |of )?today/.test(t) ||
    /who (is|are) (aligned|lined up|having interview|scheduled) today/.test(t) ||
    /who (has|have) interview today/.test(t) ||
    /who is for today/.test(t) ||
    /today updates?/.test(t) ||
    /updates? of candidates? for today/.test(t) ||
    /updates? of candidate/.test(t) ||
    t === 'today' || t === 'today lineup' || t === 'todays lineup' || t === 'today interview' || t === 'todays interview'
  ) {
    return 'today_interview';
  }

  // 2. Tomorrow's interview / lineup
  if (
    /tomorrow.?s? (interview|lineup|candidate|update|schedule)/.test(t) ||
    /(interview|candidate|lineup|schedule)s? (for |of )?tomorrow/.test(t) ||
    /who (is|are) (aligned|lined up|scheduled) tomorrow/.test(t) ||
    /tomorrow lineup|tomorrow interview/.test(t)
  ) {
    return 'tomorrow_interview';
  }

  // 3. Search-only flag: "don't send" / "just show"
  const noSendIntent = /don.?t send|do not send|dont msg|don.?t msg|just find|just search|just show|let me know|don.?t text|no msgs|upfrontly|don.?t whatsapp/i.test(t);

  // 4. Bulk outreach: text/remind candidates
  if (!noSendIntent && /text all|msg all|inform all|whatsapp all|send to all|notify all|remind all/.test(t)) {
    return 'bulk_action';
  }

  // 5. Candidate note update: "note: Alan Pater selected"
  if (/^note:|^update note:?|^add note:?|^update candidate|^save note:?|^mark /i.test(t)) {
    return 'note';
  }

  // 6. Candidate search
  if (/find|search|list|show|who are|fetch|get all|give me|candidates in|candidates from/.test(t)) {
    return 'search';
  }

  // 7. Training / Rules
  if (/jp not|not working|drive cancel|no drive|postpone|shift change|new update|from now|rule:|remember:|mandatory|required|always ask|never send/i.test(t)) {
    return 'training_update';
  }

  // 8. Overall pipeline status report
  if (/^(?:pipeline\s*summary|stats|dashboard|counts?|total|report|pipeline|overview)$/i.test(t) ||
      /how many (candidates|lineups?|overdue|pending|joined|freshers?|experienced)/i.test(t) ||
      /how many.*(?:in|are|have|had).*(?:lineup|overdue|joined|dropout|pending)/i.test(t) ||
      /(?:overdue|backdated|back.*dated|pending).*(?:lineups?|line ups?|candidates?)/i.test(t) && !/msg|text|whatsapp|send|tell|ask/i.test(t)) {
    return 'pipeline_query';
  }

  return 'general';
}

export function wantsNoSend(text) {
  return /don.?t send|do not send|dont msg|don.?t msg|just find|just show|let me know|don.?t text|no msgs|upfrontly|don.?t whatsapp/i.test(text);
}

export function extractFilters(text) {
  const t = text.toLowerCase();
  const filters = {};

  const locs = ['mira road', 'malad', 'borivali', 'thane', 'andheri', 'powai', 'vikhroli',
    'airoli', 'vashi', 'kandivali', 'bhayandar', 'goregaon', 'santacruz', 'dadar', 'kurla', 'kalyan', 'rabale', 'mulund'];
  for (const loc of locs) {
    if (t.includes(loc)) { filters.location = loc; break; }
  }

  if (t.includes('fresher')) filters.experience = 'Fresher';
  if (/experienced|exp/.test(t)) filters.experience = 'Experienced';

  if (/lined up|lineup|aligned/.test(t)) filters.lineup_status = 'Yes';

  const companies = ['jp morgan', 'jpmc', 'jp', 'tcs', 'accenture', 'tech mahindra', 'techm',
    'teleperformance', 'tp', 'concentrix', 'firstsource', 'fs', 'sambridge', 'foundever', 'sutherland',
    'wns', 'epicenter', 'spark'];
  for (const c of companies) {
    if (t.includes(c)) { filters.company = c; break; }
  }

  if (t.includes('girl') || t.includes('female') || t.includes('women')) filters.gender = 'female';
  if (t.includes('boy') || t.includes('male') || t.includes('men')) filters.gender = 'male';

  return filters;
}

// ── Clean & Extract Recent Note Snippet ───────────────────────────────────────
function extractRecentNote(notes) {
  if (!notes) return 'Lineup confirmed';
  const lines = notes.split('\n').map(l => l.trim()).filter(Boolean);
  const relevant = lines.slice(0, 2).map(l => l.replace(/^\[\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}\]\s*/, ''));
  return relevant.join(' | ') || 'Lineup set';
}

// ── Format Interview Briefing ─────────────────────────────────────────────────
export function formatInterviewBriefing(candidates, targetDateStr, isToday = true) {
  const displayDate = formatDisplayDate(targetDateStr);
  const timeStr = getISTTimeString();

  if (!candidates || candidates.length === 0) {
    return `📋 *Interview Updates — ${displayDate} (${timeStr} IST)*\n━━━━━━━━━━━━━━━━━━━━━━\n\nNo candidates are currently scheduled for interviews on *${displayDate}*.\n\n💡 _Tip: You can say *"show candidates in Malad"* or *"status"* to inspect the pipeline._`;
  }

  const header = isToday
    ? `📋 *Today's Interview Updates — ${displayDate}*\n━━━━━━━━━━━━━━━━━━━━━━\nBoss, you have *${candidates.length} candidate(s)* lined up for interviews today:`
    : `📋 *Interview Schedule — ${displayDate}*\n━━━━━━━━━━━━━━━━━━━━━━\n*${candidates.length} candidate(s)* lined up for ${displayDate}:`;

  const cards = candidates.map((c, i) => {
    const num = i + 1;
    const name = c.name?.trim() || 'Unknown';
    const phone = c.phone || 'N/A';
    const process = c.process?.trim() || 'Voice / BPO';
    const loc = c.location?.trim() ? `📍 ${c.location.trim()}` : null;
    const exp = c.experience === 'Experienced'
      ? (c.years ? `${c.years} yrs exp` : 'Experienced')
      : (c.experience || 'Fresher');
    const salary = c.inhand_salary && c.inhand_salary !== '-' ? `💰 ₹${c.inhand_salary}/mo` : null;
    const comm = c.comm_level ? `🗣️ Comm: ${c.comm_level}` : null;
    const prior = c.last_company && c.last_company.trim() ? `🏢 Prior: ${c.last_company.trim()}` : null;
    const note = extractRecentNote(c.notes);

    const metaLine = [process, loc, exp, salary, comm].filter(Boolean).join(' | ');

    return `${num}. *${name}*\n   📱 ${phone}\n   💼 ${metaLine}${prior ? `\n   ${prior}` : ''}\n   📝 _Status:_ ${note}`;
  }).join('\n\n');

  const footer = `\n━━━━━━━━━━━━━━━━━━━━━━\n💡 *Quick Actions:*
• Reply *"Text all today"* to send venue reminder to all ${candidates.length}
• Reply *"Note: <name> <update>"* to update notes in RecrutOS
• Or just tell me any change (e.g. *"Rizwan postponed to Monday"*)`;

  return `${header}\n\n${cards}\n${footer}`;
}

// ── Main Trainer Chat Processor ───────────────────────────────────────────────
/**
 * Process any message from the trainer chat or recruiter.
 *
 * @param {string} text - Message content
 * @param {import('whatsapp-web.js').Client} waClient - WhatsApp client
 * @param {Object} context - Optional metadata { talkerId, name, isRecruiter }
 * @returns {Promise<string>} Reply text to send
 */

// ── Helper: Clean outreach directive and transform to professional recruiter text ──
export function cleanOutreachInstruction(rawInstruction, firstName = 'there') {
  if (!rawInstruction || rawInstruction.trim().length === 0) {
    return `Hi ${firstName}, this is Saa from HR team 👋\n\nChecking in regarding your interview. Are you available today? Please confirm so we can coordinate your lineup. 📞`;
  }

  let text = String(rawInstruction).trim();

  // Strip leading conjunctions & directive prepositions
  text = text.replace(/^(?:and\s+|to\s+|that\s+|about\s+|as\s+|if\s+)+/i, '');

  // Strip leading directive verbs & target pronouns:
  // "ask if she is available", "ask her if she can join", "tell him that", "inform them to"
  text = text.replace(/^(?:ask|tell|inform|check|inquire|ping|msg|message|text)(?:\s+(?:her|him|them|candidate|the\s+candidate))?(?:\s+(?:if|that|to|whether|about))?\s*/i, '');

  // If instruction was "if she is available...", strip "if (she|he|they) (is|are|can)"
  text = text.replace(/^(?:if\s+)?(?:she|he|they)\s+(?:is|are|can|could|will|would)\s+(?:available|free)\b/i, 'are you available');
  text = text.replace(/^(?:if\s+)?(?:she|he|they)\s+(?:can|could|will|would)\s+(?:join|come|attend)\b/i, 'can you join');

  // Convert third-person references to second person (recruiter texting candidate)
  text = text.replace(/\b(?:if\s+)?(?:she\s+is|he\s+is)\b/gi, 'you are');
  text = text.replace(/\b(?:if\s+)?(?:she\s+can|he\s+can)\b/gi, 'you can');
  text = text.replace(/\b(?:if\s+)?(?:she\s+will|he\s+will)\b/gi, 'you will');
  text = text.replace(/\b(?:she|he)\b/gi, 'you');
  text = text.replace(/\b(?:her|his)\b/gi, 'your');

  // Strip trailing transcript fragment artifacts like "as a n", "as a", "for a"
  text = text.replace(/\s+(?:as|for)\s+a(?:\s+[a-z])?$/i, '').trim();

  // Strip trailing whole-word references to phone or candidate like "to this number", "on this number"
  text = text.replace(/(?:\bto\b|\bfor\b|\bat\b|\bon\b)?\s*(?:\bthis\b|\bthe\b)?\s*(?:\bnumber\b|\bnum\b|\bcandidate\b)\s*$/i, '').trim();

  // Voice Process Doctrine: Strictly pivot away from chat / backoffice / non-voice
  if (/back\s*office|backoffice|non\s*voice|chat\s*process/i.test(text)) {
    text = text.replace(/back\s*office|backoffice|non\s*voice|chat\s*process/gi, 'International Voice Process');
  }

  // Specific common patterns:
  // 1. "what is your salary expectation"
  if (/what\s+is\s+your\s+salary\s+expectation/i.test(text) || /salary\s+expectation/i.test(text)) {
    return `Hi ${firstName}, this is Saa from HR team 👋\n\nCould you please let us know what your current in-hand salary and salary expectation are? We are aligning relevant job options for you. 💼`;
  }

  // 2. "how are you"
  if (/how\s+are\s+you/i.test(text)) {
    return `Hi ${firstName}, this is Saa from HR team 👋\n\nHow are you doing today? Hope you are doing well! We wanted to check in with you regarding your job application. 🌟`;
  }

  // 3. "are you available tomorrow for any interview" or "available tomorrow"
  if (/available\s+(tomorrow|today|kal|aaj)/i.test(text) || /available.*interview/i.test(text)) {
    const when = /today|aaj/i.test(text) ? 'today' : 'tomorrow';
    return `Hi ${firstName}, this is Saa from HR team 👋\n\nAre you available ${when} for an interview? Please let us know your availability so we can coordinate your options. 👍`;
  }

  // Capitalize first letter of cleaned text
  text = text.charAt(0).toUpperCase() + text.slice(1);

  // If text is a question but doesn't end with ?, add it
  if (/^(who|what|where|when|why|how|are|can|could|will|would|is|do|did)\b/i.test(text) && !text.endsWith('?')) {
    text += '?';
  } else if (!text.endsWith('.') && !text.endsWith('?') && !text.endsWith('!')) {
    text += '.';
  }

  return `Hi ${firstName}, this is Saa from HR team 👋\n\n${text}\n\nPlease let us know so we can coordinate your interview lineup. 👍`;
}

// ── Helper: build and send a WhatsApp message to a candidate ─────────────────
async function sendOutreachMessage(waClient, candidate, instruction, originalText) {
  const firstName = (candidate.name || 'there').trim().split(' ')[0];

  // Update session context memory
  setLastDiscussedCandidate(candidate);

  // Build the message cleanly transformed from recruiter directive into professional candidate text
  const msgToSend = cleanOutreachInstruction(instruction, firstName);

  const phone = (candidate.phone || '').replace(/\D/g, '');
  const waId = phone.startsWith('91') ? `${phone}@c.us` : `91${phone}@c.us`;

  let sent = false;
  if (waClient && phone) {
    try {
      await waClient.sendMessage(waId, msgToSend);
      sent = true;
      console.log(`📤 [SaaTrainer] Outreach sent to ${candidate.name} (${phone}): "${msgToSend.slice(0, 60)}"`);
    } catch (err) {
      console.error('[SaaTrainer] Outreach send error:', err.message);
    }
  } else {
    console.warn(`[SaaTrainer] No waClient or phone — outreach LOGGED only for ${candidate.name}`);
  }

  try {
    await appendCandidateNote(candidate.phone, `[WhatsApp ${sent ? 'Sent' : 'Logged'}] "${msgToSend.slice(0, 120)}"`);
  } catch (_) {}

  return `${sent ? '✅' : '⚠️'} *Outreach ${sent ? 'Sent!' : 'Logged (not sent — client unavailable)'}*\n\n` +
    `👤 *${candidate.name}* | 📱 ${candidate.phone}\n` +
    `💼 ${candidate.process || 'Voice'} | 📍 ${candidate.location || 'Mumbai'}\n` +
    `📝 Last note: ${extractRecentNote(candidate.notes)}\n\n` +
    `💬 *Message sent:*\n"${msgToSend}"\n\n` +
    `⚡ Note logged in RecrutOS. When ${firstName} replies I'll alert you here.`;
}

// ── Rate-limit guard for MCP writes ─────────────────────────────────────────
// Free tier: max 1 Supabase write per 2 seconds to avoid burst charges.
let _lastMcpWrite = 0;
async function rateLimitedMcpWrite(toolName, params, waClient = null, options = {}) {
  const now = Date.now();
  const gap = now - _lastMcpWrite;
  if (gap < 2000) await new Promise(r => setTimeout(r, 2000 - gap));
  _lastMcpWrite = Date.now();
  return callMCPTool(toolName, params, waClient, options);
}

// ── Date resolver — converts natural language to YYYY-MM-DD (IST) ────────────
function resolveDate(text, todayStr) {
  const t = text.toLowerCase();
  const base = new Date(Date.now() + 5.5 * 3600000); // current IST moment

  // "today"
  if (/\btoday\b|\baaj\b/.test(t)) return todayStr;

  // "tomorrow" / "kal"
  if (/\btomorrow\b|\bkal\b|\bnext day\b/.test(t)) {
    const d = new Date(base); d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  // "day after tomorrow" / "परसों"
  if (/day after|parso|परसों/.test(t)) {
    const d = new Date(base); d.setDate(d.getDate() + 2);
    return d.toISOString().slice(0, 10);
  }

  // "this monday/tuesday..." etc.
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for (let i = 0; i < days.length; i++) {
    if (t.includes(days[i])) {
      const d = new Date(base);
      const diff = (i - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
      return d.toISOString().slice(0, 10);
    }
  }

  // Explicit date: 4 oct / oct 4 / 04/10 / 2026-10-04
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];

  const dmy = t.match(/(\d{1,2})[\/\-\s](\d{1,2})(?:[\/\-\s](\d{2,4}))?/);
  if (dmy) {
    const day = dmy[1].padStart(2, '0');
    const mon = dmy[2].padStart(2, '0');
    const yr  = dmy[3] ? (dmy[3].length === 2 ? '20' + dmy[3] : dmy[3]) : todayStr.slice(0, 4);
    return `${yr}-${mon}-${day}`;
  }

  const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  for (let i = 0; i < monthNames.length; i++) {
    const re = new RegExp(`(\\d{1,2})\\s*${monthNames[i]}`, 'i');
    const m = t.match(re);
    if (m) {
      const yr = todayStr.slice(0, 4);
      return `${yr}-${String(i + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    const re2 = new RegExp(`${monthNames[i]}\\s*(\\d{1,2})`, 'i');
    const m2 = t.match(re2);
    if (m2) {
      const yr = todayStr.slice(0, 4);
      return `${yr}-${String(i + 1).padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
    }
  }

  return null; // couldn't parse
}

function getNextWeekdayDate(dayIndex, baseDateStr) {
  const [y, m, d] = baseDateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const curDay = dt.getDay(); // 0 is Sunday
  const diff = (dayIndex - curDay + 7) % 7 || 7;
  dt.setDate(dt.getDate() + diff);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function parseBulkRescheduleDates(text, todayStr) {
  const lower = text.toLowerCase();
  const tomorrowStr = getISTDateString(1);
  const dayAfterStr = getISTDateString(2);

  let sourceDate = null;
  let targetDate = null;

  // 1. Weekdays (monday..sunday)
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  let weekdayTarget = null;
  let weekdayIdx = -1;
  for (let i = 0; i < weekdays.length; i++) {
    const pos = lower.search(new RegExp(`\\b${weekdays[i]}\\b`, 'i'));
    if (pos !== -1) {
      weekdayTarget = getNextWeekdayDate(i, todayStr);
      weekdayIdx = pos;
      break;
    }
  }

  const todayPos = lower.search(/\b(today|todays|todayss|aaj)\b/i);
  const tomorrowPos = lower.search(/\b(tomorrow|tomorrows|kal|next\s*day)\b/i);
  const parsoPos = lower.search(/\b(parso|day\s+after\s+tomorrow)\b/i);

  if (todayPos !== -1 && tomorrowPos !== -1) {
    if (todayPos < tomorrowPos) {
      sourceDate = todayStr;
      targetDate = tomorrowStr;
    } else {
      sourceDate = tomorrowStr;
      targetDate = todayStr;
    }
  } else if (tomorrowPos !== -1 && parsoPos !== -1) {
    sourceDate = tomorrowStr;
    targetDate = dayAfterStr;
  } else if (todayPos !== -1 && parsoPos !== -1) {
    sourceDate = todayStr;
    targetDate = dayAfterStr;
  } else if (todayPos !== -1 && weekdayIdx !== -1) {
    if (todayPos < weekdayIdx) {
      sourceDate = todayStr;
      targetDate = weekdayTarget;
    } else {
      sourceDate = weekdayTarget;
      targetDate = todayStr;
    }
  } else if (tomorrowPos !== -1 && weekdayIdx !== -1) {
    if (tomorrowPos < weekdayIdx) {
      sourceDate = tomorrowStr;
      targetDate = weekdayTarget;
    } else {
      sourceDate = weekdayTarget;
      targetDate = tomorrowStr;
    }
  } else if (parsoPos !== -1) {
    sourceDate = todayStr;
    targetDate = dayAfterStr;
  } else if (tomorrowPos !== -1) {
    sourceDate = todayStr;
    targetDate = tomorrowStr;
  } else if (weekdayIdx !== -1) {
    sourceDate = todayStr;
    targetDate = weekdayTarget;
  }

  // Explicit ISO or DD-MM dates if present
  const isoDates = lower.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  if (isoDates && isoDates.length >= 2) {
    sourceDate = isoDates[0];
    targetDate = isoDates[1];
  } else if (isoDates && isoDates.length === 1) {
    if (/\b(?:to|for|ke\s*(?:lie|liye)|pe|ko)\s*\d{4}-\d{2}-\d{2}\b/i.test(lower)) {
      targetDate = isoDates[0];
      if (!sourceDate) sourceDate = todayStr;
    } else {
      sourceDate = isoDates[0];
      if (!targetDate) targetDate = tomorrowStr;
    }
  }

  if (!sourceDate) sourceDate = todayStr;
  if (!targetDate) targetDate = tomorrowStr;

  return { sourceDate, targetDate };
}

export function isBulkRescheduleCommand(lower) {
  const _isQuestion = /^(what|show|how|who|which|is there|are there|tell me|give me|get|list|check)/i.test(lower.trim()) || lower.includes('?');
  if (_isQuestion) return false;

  // ── CRITICAL FIX: MUST have an explicit bulk quantifier to be a bulk command. ──
  // Without one ("all", "sare", "everyone", etc.) this is a SINGLE-candidate command
  // even if it contains words like "align", "lineup", "tomorrow".
  // e.g. "Align pratham for tomorrow as line up" → NOT bulk (no quantifier)
  // e.g. "Change all today's lineups to tomorrow" → IS bulk (has "all")
  const hasBulkQuantifier =
    /\b(all|sare|saare|sab|sabhi|every|everyone|everybody)\b/i.test(lower);

  if (!hasBulkQuantifier) return false;

  const hasShift =
    /\b(change|reschedule|shift|align|move|transfer|postpone|badlo|karo|bhejo|kar\s*do|daal\s*do)\b/i.test(lower);

  const hasContext =
    /\b(lineups?|line\s*ups?|line-ups?|interviews?|dates?|candidates?|candid[a-z]+)\b/i.test(lower) &&
    /\b(today|todayss?|aaj|tomorrow|tomorrows?|kal|parso|next\s*day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(lower);

  return Boolean(hasShift && hasContext);
}

// ── Candidate Resolver with Pronoun & Context Memory ─────────────────────────
export async function resolveCandidateWithPronoun(query) {
  const q = String(query || '').trim();
  const isPronoun = /^(her|him|she|he|them|they|this candidate|that candidate|the candidate|candidate|her candidate|his candidate)$/i.test(q);

  if (isPronoun || !q) {
    const last = getLastDiscussedCandidate();
    if (last && (last.id || last.phone)) {
      console.log(`📌 [SaaTrainer] Resolved pronoun "${q || '(empty)'}" to last discussed candidate: "${last.name}" (${last.phone})`);
      return { ok: true, data: last };
    }
    if (isPronoun) {
      return { ok: false, error: `No recent candidate in session memory to resolve pronoun "${q}". Please provide the candidate's name or mobile number.` };
    }
  }

  let res = await callMCPTool('find_candidate', { query: q });
  if (!res.ok) {
    const fuzzy = await fuzzyFindCandidate(q);
    if (fuzzy) {
      res = { ok: true, data: fuzzy };
    }
  }
  if (res.ok && res.data) {
    setLastDiscussedCandidate(res.data);
  }
  return res;
}

// ── IST Day of Week Helper ──────────────────────────────────────────────────
export function getISTDayOfWeek(offsetDays = 0) {
  const d = new Date();
  if (offsetDays !== 0) {
    d.setTime(d.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long'
  }).format(d);
}

// ── Company JD Extractor from training.md ────────────────────────────────────
export function getCompanyJDFromTraining(companyQuery) {
  try {
    if (!fs.existsSync(TRAINING_PATH)) return null;
    const content = fs.readFileSync(TRAINING_PATH, 'utf8');
    const q = companyQuery.toLowerCase().trim();

    // Map common aliases
    let searchTerms = [q];
    if (q.includes('jpmc') || q.includes('jp morgan') || q.includes('chase') || q.includes('jpmorgan')) {
      searchTerms = ['jp morgan chase captive', 'jp morgan', 'jpmc'];
    } else if (q.includes('concentrix') || q.includes('cnx')) {
      searchTerms = ['concentrix (cnx)', 'concentrix'];
    } else if (q.includes('epicenter')) {
      searchTerms = ['epicenter'];
    } else if (q.includes('tech mahindra') || q.includes('techm') || q.includes('tech m')) {
      searchTerms = ['tech mahindra'];
    } else if (q.includes('foundever') || q.includes('sitel')) {
      searchTerms = ['foundever'];
    } else if (q.includes('firstsource') || q.includes('fsl')) {
      searchTerms = ['firstsource'];
    } else if (q.includes('teleperformance') || q.includes('tp')) {
      searchTerms = ['teleperformance'];
    } else if (q.includes('sutherland')) {
      searchTerms = ['sutherland'];
    } else if (q.includes('wns')) {
      searchTerms = ['wns'];
    } else if (q.includes('accenture')) {
      searchTerms = ['accenture'];
    } else if (q.includes('sambridge')) {
      searchTerms = ['sambridge'];
    } else if (q.includes('tcs') || q.includes('tata')) {
      searchTerms = ['tata consultancy services', 'tcs'];
    } else if (q.includes('tsi') || q.includes('transcom')) {
      searchTerms = ['tsi (transcom)', 'tsi'];
    } else if (q.includes('radius')) {
      searchTerms = ['radius global solutions', 'radius'];
    } else if (q.includes('etravel') || q.includes('etraveli')) {
      searchTerms = ['etraveli group', 'etravel'];
    } else if (q.includes('spark')) {
      searchTerms = ['spark capital'];
    } else if (q.includes('narith')) {
      searchTerms = ['narith solutions', 'narith'];
    } else if (q.includes('disa')) {
      searchTerms = ['disa technologies', 'disa'];
    } else if (q.includes('wipro')) {
      searchTerms = ['wipro bpo', 'wipro'];
    } else if (q.includes('capita')) {
      searchTerms = ['capita india', 'capita'];
    } else if (q.includes('sterling')) {
      searchTerms = ['sterling bpo', 'sterling'];
    }

    const sections = content.split(/(?=\n###\s+)/);
    for (const term of searchTerms) {
      let matched = sections.find(s => {
        const firstLine = s.trim().split('\n')[0].toLowerCase();
        return firstLine.includes(term);
      });
      if (matched) {
        return matched.split(/(?=\n##\s+)/)[0].trim();
      }
    }

    for (const term of searchTerms) {
      let matched = sections.find(s => s.toLowerCase().includes(term));
      if (matched) {
        return matched.split(/(?=\n##\s+)/)[0].trim();
      }
    }
  } catch (err) {
    console.warn('[SaaTrainer] Error extracting JD from training:', err.message);
  }
  return null;
}

export function getAllOpenCompaniesSummary() {
  return `🏢 *RecrutOS Active Client Companies (Mumbai BPO)*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `1. *Accenture* — Vikhroli & Airoli (Intl Voice / Blended | ₹22k-45k | Waits 60d notice)\n` +
    `2. *Tech Mahindra* — Malad Mindspace (Telecom Voice / Tech Support | ₹18k-32k | Spot Offer)\n` +
    `3. *JP Morgan Chase* — Malad Mindspace (Captive Finance Voice | ₹35k-55k | Top Tier)\n` +
    `4. *Concentrix (CNX)* — Malad & Thane (US Tech Voice / Blended | ₹20k-38k)\n` +
    `5. *Foundever (Sitel)* — Airoli & Andheri (Intl Voice & Chat | ₹22k-36k)\n` +
    `6. *WNS Global* — Vikhroli (UK / US Travel & Banking | ₹20k-35k)\n` +
    `7. *Teleperformance* — Malad & Andheri (Daily Walk-in Drives | ₹18k-30k)\n` +
    `8. *TCS BPS* — Goregaon & Thane (Banking / Finance | ₹18k-28k | 5 Days)\n` +
    `9. *Firstsource (FSL)* — Malad Mindspace (UK / US Collections Voice | ₹20k-32k)\n` +
    `10. *Epicenter* — Mira Bhayandar (US Collections Voice | ₹22k-35k)\n` +
    `11. *ETraveli* — Andheri East (Travel Tech Voice | ₹25k-40k)\n` +
    `12. *Sutherland* — Airoli (Intl Voice & Tech Support | ₹22k-36k)\n` +
    `13. *TSI (Transcom)* — Vashi (Customer Experience Voice | ₹18k-28k)\n` +
    `14. *Radius Global* — Powai (Healthcare & Debt Recovery | ₹22k-34k)\n` +
    `15. *Spark Capital* — Santacruz East (Domestic / Intl Financial Services)\n` +
    `16. *Narith Solutions* — Thane West (Voice & Semi-Voice)\n` +
    `17. *Disa Tech* — Thane Wagle Estate (Domestic & Intl Tech Support)\n` +
    `18. *Wipro BPO* — Airoli & Thane (Voice / Non-Voice)\n` +
    `19. *Capita India* — Vikhroli (UK Pensions & Insurance)\n` +
    `20. *Sterling BPO* — Goregaon West (International Voice)\n` +
    `21. *Sambridge* — Powai Hiranandani (Fintech Voice & Collections)\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 _To view full criteria, shift, & salary for any company, send:_ *"help me with TechM jd"* or *"/jd accenture"*`;
}

// ── Overdue Lineup Candidates Fetcher ────────────────────────────────────────
export async function getOverdueLineupCandidates(todayStr) {
  const client = getClient();
  if (!client) return [];
  try {
    const { data, error } = await client
      .from('ros_candidates')
      .select('*')
      .eq('lineup_status', 'Yes')
      .lt('interview_date', todayStr)
      .neq('joined_status', 'Joined')
      .order('interview_date', { ascending: false })
      .limit(30);

    if (error) {
      console.warn('[OverdueLineups] Query error:', error.message);
      return [];
    }
    return (data || []).filter(c => c.phone && !isOnDnd(c.phone));
  } catch (err) {
    console.warn('[OverdueLineups] Error:', err.message);
    return [];
  }
}

// ── Search Candidates & Share JD Handler ──────────────────────────────────────
export async function handleSearchAndShareJD(locQuery, compQuery, waClient, todayStr) {
  const jd = getCompanyJDFromTraining(compQuery);
  if (!jd) {
    return `⚠️ Could not find hiring JD for "*${compQuery}*" in training.md.\n\nPlease check company name or share the JD first. (Say */jd* to view open companies).`;
  }

  const jdLines = jd.split('\n');
  const jdTitle = jdLines[0].replace(/^###\s*/, '').trim();
  const jdBody = jdLines.slice(1).filter(l => !l.startsWith('##')).join('\n').trim();

  let locSearch = locQuery.toLowerCase().replace(/candidates?|people|freshers?|experienced?/gi, '').trim();
  if (locSearch.includes('mira')) locSearch = 'mira';
  else if (locSearch.includes('navi')) locSearch = 'navi';
  else if (locSearch.includes('bhayandar')) locSearch = 'bhayandar';
  else if (locSearch.includes('kandivali')) locSearch = 'kandivali';
  else if (locSearch.includes('borivali')) locSearch = 'borivali';
  else if (locSearch.includes('malad')) locSearch = 'malad';
  else if (locSearch.includes('thane')) locSearch = 'thane';
  else if (locSearch.includes('andheri')) locSearch = 'andheri';
  else if (locSearch.includes('vashi')) locSearch = 'vashi';
  else if (locSearch.includes('airoli')) locSearch = 'airoli';

  const client = getClient();
  if (!client) return `❌ RecrutOS database client not connected.`;

  let candidates = [];
  try {
    const { data, error } = await client
      .from('ros_candidates')
      .select('*')
      .ilike('location', `%${locSearch}%`)
      .neq('joined_status', 'Joined')
      .order('created_at', { ascending: false })
      .limit(15);

    if (error) {
      console.warn('[SearchAndShare] DB error:', error.message);
    } else {
      candidates = (data || []).filter(c => c.phone && !isOnDnd(c.phone));
    }
  } catch (dbErr) {
    console.warn('[SearchAndShare] DB query error:', dbErr.message);
  }

  if (candidates.length === 0) {
    return `🔍 *Candidate Search Result*\n━━━━━━━━━━━━━━━━━━━━━━\n📍 Location: *${locQuery}*\n🏢 Target JD: *${jdTitle}*\n\n⚠️ No active candidates found matching "${locQuery}" in RecrutOS. (Check if candidate profiles use different spelling e.g. "Mira Road" vs "Miraroad").`;
  }

  const contacted = [];
  const maxToSend = Math.min(candidates.length, 10);

  for (let i = 0; i < maxToSend; i++) {
    const cand = candidates[i];
    const phone = cand.phone.replace(/\D/g, '');
    const waId = phone.length === 10 ? '91' + phone + '@c.us' : phone + '@c.us';
    const firstName = (cand.name || 'there').trim().split(' ')[0];

    const outreachMsg =
      `Hi ${firstName}! 👋 This is Saa from HR team.\n\n` +
      `We have an urgent hiring drive matching your location! 🚀\n\n` +
      `🏢 *${jdTitle}*\n${jdBody.slice(0, 750)}\n\n` +
      `Are you available to attend this interview? Please reply *YES* with your updated CV, or call us directly at *+91 8080635121*. 📞`;

    try {
      if (waClient) {
        await waClient.sendMessage(waId, outreachMsg);
        await new Promise(r => setTimeout(r, 600));
      }
      contacted.push(cand);

      await rateLimitedMcpWrite('append_note', {
        identifier: cand.id,
        note: `Shared ${jdTitle} JD via WhatsApp by Shetty Saa command on ${todayStr}`
      }, waClient, { skipActivityLog: true });

    } catch (sendErr) {
      console.warn(`[SearchAndShare] Failed to send to ${cand.name}:`, sendErr.message);
    }
  }

  await logAgentActivity(waClient, {
    action: 'Targeted JD Shared',
    category: 'WHATSAPP',
    details: `Shared ${jdTitle} to ${contacted.length} candidates in ${locQuery}.`,
    source: 'Saa Trainer (Jarvis Command)',
    notifyBoss: false
  });

  return `🚀 *${jdTitle} — JD Shared Successfully!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📍 Target Location: *${locQuery}*\n` +
    `👥 Contacted: *${contacted.length} candidate(s)* (out of ${candidates.length} found)\n\n` +
    contacted.map((c, idx) => `${idx + 1}. *${c.name}* (📱 ${c.phone} | 📍 ${c.location || 'Mumbai'})`).join('\n') +
    `\n\n📝 All candidate notes updated live in RecrutOS.\nAny replies will alert you instantly! 🔔`;
}

// ── Forward Manual JD to Overdue Lineups Handler ─────────────────────────────
export async function handleForwardJDToOverdue(jdContent, waClient, todayStr) {
  const overdueCandidates = await getOverdueLineupCandidates(todayStr);

  if (overdueCandidates.length === 0) {
    return `📋 *Overdue Lineups Check*\n━━━━━━━━━━━━━━━━━━━━━━\nNo overdue lineup candidates found in RecrutOS (candidates with past interview dates who haven't joined). All lineups are up to date! 👍`;
  }

  if (!jdContent || jdContent.trim().length < 15) {
    return `📋 *Found ${overdueCandidates.length} Overdue Lineup Candidate(s):*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      overdueCandidates.slice(0, 10).map((c, i) => `${i + 1}. *${c.name}* (📱 ${c.phone} | 📅 Interview was: ${c.interview_date || 'Past'})`).join('\n') +
      (overdueCandidates.length > 10 ? `\n_...and ${overdueCandidates.length - 10} more_\n` : '\n\n') +
      `💡 *To broadcast your manual JD to them, send:*\n` +
      `*"forward manual JD to all overdue line ups:\n<Paste your hiring details here>"*`;
  }

  const contacted = [];
  const maxToSend = Math.min(overdueCandidates.length, 15);

  for (let i = 0; i < maxToSend; i++) {
    const cand = overdueCandidates[i];
    const phone = cand.phone.replace(/\D/g, '');
    const waId = phone.length === 10 ? '91' + phone + '@c.us' : phone + '@c.us';
    const firstName = (cand.name || 'there').trim().split(' ')[0];

    const broadcastMsg =
      `Hi ${firstName}! 👋 This is Saa from HR team.\n\n` +
      `We have an urgent hiring opportunity open right now:\n\n` +
      `${jdContent.trim()}\n\n` +
      `Would you like to attend an interview for this opening? Please reply *YES* with your resume or call us at *+91 8080635121*. 📞`;

    try {
      if (waClient) {
        await waClient.sendMessage(waId, broadcastMsg);
        await new Promise(r => setTimeout(r, 600));
      }
      contacted.push(cand);

      await rateLimitedMcpWrite('append_note', {
        identifier: cand.id,
        note: `Forwarded manual JD by Shetty Saa: "${jdContent.trim().slice(0, 60)}..."`
      }, waClient, { skipActivityLog: true });

    } catch (err) {
      console.warn(`[ForwardOverdue] Send error for ${cand.name}:`, err.message);
    }
  }

  await logAgentActivity(waClient, {
    action: 'Manual JD Broadcast',
    category: 'WHATSAPP',
    details: `Broadcast manual JD to ${contacted.length} overdue lineup candidates.`,
    source: 'Saa Trainer (Jarvis Command)',
    notifyBoss: false
  });

  return `📨 *Manual JD Broadcast Completed!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ Successfully sent to *${contacted.length}* overdue candidate(s):\n` +
    contacted.map((c, i) => `${i + 1}. *${c.name}* (📱 ${c.phone})`).join('\n') +
    `\n\n📝 RecrutOS candidate notes updated live. You will be alerted when they reply! 🚀`;
}

// ── Ingest JD from Mumbai Job Alerts / Chat with Upfront Clarifications ───────
export function handleIngestJDWithClarifications(rawText, waClient) {
  const clean = rawText
    .replace(/^(new\s*jd|train\s*jd|hiring\s*alert|job\s*alert|channel\s*post)[:\s]*/i, '')
    .trim();

  let companyGuess = 'Hiring Opening';
  const compMatch = clean.match(/(?:hiring for|openings at|company\s*:|walkin at|drive at|###\s*)\s*([A-Za-z0-9\s\(\)\.\-]+?)(?:\s*[\n\–\—\-]|(?:\s+in\s+)|(?:\s+is\s+hiring)|$)/i);
  if (compMatch && compMatch[1].trim().length > 2) {
    companyGuess = compMatch[1].trim();
  }

  updateTrainingMd(`New JD Ingested for ${companyGuess}:\n${clean}`, 'CHANNEL_JD_INGEST');

  const lower = clean.toLowerCase();
  const questions = [];

  const mentionsNotice = lower.includes('notice') || lower.includes('immediate') || lower.includes('serving');
  const isOneOfBigThree = lower.includes('jp morgan') || lower.includes('jpmc') || lower.includes('tcs') || lower.includes('accenture');

  if (!mentionsNotice && !isOneOfBigThree) {
    questions.push(`Does *${companyGuess}* strictly require **immediate joiners (0–15 days)**, or can they wait for candidates serving notice? (Standard rule is immediate only)`);
  }

  if (!lower.includes('catchment') && !lower.includes('boundary') && !lower.includes('drop') && !lower.includes('pickup') && !lower.includes('cab')) {
    questions.push(`What is the exact **transport / cab boundary** for night shifts? (e.g. Churchgate to Virar on Western, CST to Kalyan on Central)`);
  }

  if (!lower.includes('voice') && !lower.includes('non-voice') && !lower.includes('chat') && !lower.includes('blended') && !lower.includes('backoffice')) {
    questions.push(`Is this **Voice**, **Blended**, or **Non-Voice / Backoffice**?`);
  }

  if (lower.includes('jpmc') && !lower.includes('captive') && !lower.includes('concentrix')) {
    questions.push(`Is this hiring for **JP Morgan Chase Captive** (direct bank unit, grads only, 2-month notice) or **Concentrix JPMC process** (vendor BPO, immediate joining)?`);
  }

  const baseReply =
    `📝 *Hiring JD Trained & Saved Live!* 🏢\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Company: *${companyGuess}*\n` +
    `Status: Saved to *training.md* & active in candidate matching logic. ✅\n\n`;

  if (questions.length > 0) {
    return baseReply +
      `❓ *Upfront Clarification Questions (to ensure 100% accurate candidate matching):*\n` +
      questions.map((q, idx) => `${idx + 1}. ${q}`).join('\n') +
      `\n\n_Shetty Saa, whenever convenient, reply with the answers here and I will update the cheat sheet live!_ 👍`;
  } else {
    return baseReply + `_All critical parameters (Shift, Process, Salary, Notice Period & Transport) are fully captured! Ready for candidate alignment._ 🚀`;
  }
}

/**
 * Ingest and process candidate presentation updates sent by Shetty Saa.
 * Extracts candidates, companies, and statuses/notes, updating RecrutOS Supabase live.
 */
async function handlePresentationUpdate(text, todayStr, waClient) {
  const candidatesParsed = [];

  // Strategy 1: Match asterisk-bracketed entries: *Name - Company* Status/Notes
  const starRegex = /\*([a-zA-Z\s]{2,30}?)\s*[-–]\s*([a-zA-Z0-9\s\(\)\/]+?)\*(?:\s*([a-zA-Z0-9\s\(\)\.,]+))?/g;
  let match;
  while ((match = starRegex.exec(text)) !== null) {
    const name = match[1].trim();
    const company = match[2].trim();
    let notes = (match[3] || 'Hr aligned').trim();
    notes = notes.replace(/^[\.,\-\s]+|[\.,\-\s]+$/g, '');
    if (name.length >= 3 && !/^(today|presentation|update|candidates?|lineup)$/i.test(name)) {
      candidatesParsed.push({ name, company, notes: notes || 'Hr aligned' });
    }
  }

  // Strategy 2: If no star matches, match standard lines: Name - Company [- Note]
  if (candidatesParsed.length === 0) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/^(today.?s?\s+presentation|presentation\s*[-:]|candidates?:?)/i.test(line)) continue;
      const lineMatch = line.match(/^(?:[\d\.\-\*•]+\s*)?([a-zA-Z\s]{2,30}?)\s*[-–:]\s*([a-zA-Z0-9\s\(\)\/]+?)(?:\s*[-–:]\s*|\s+hr\s+aligned|\s+aligned|$)(.*)$/i);
      if (lineMatch) {
        const name = lineMatch[1].replace(/[*_~`]/g, '').trim();
        const company = lineMatch[2].replace(/[*_~`]/g, '').trim();
        let extra = (lineMatch[3] || '').replace(/[*_~`]/g, '').trim();
        if (/hr aligned/i.test(line) && !extra) extra = 'Hr aligned';
        if (name.length >= 3 && !/^(today|presentation|update|candidates?|lineup)$/i.test(name)) {
          candidatesParsed.push({ name, company, notes: extra || 'Hr aligned' });
        }
      }
    }
  }

  if (candidatesParsed.length === 0) return null;

  const results = [];
  for (const item of candidatesParsed) {
    let cand = await findCandidateByNameOrPhone(item.name);
    if (!cand) cand = await fuzzyFindCandidate(item.name);

    if (cand) {
      await rateLimitedMcpWrite('update_candidate', {
        identifier: cand.id,
        updates: {
          lineup_status: 'Yes',
          interview_date: todayStr,
          ...(item.company ? { last_company: item.company } : {})
        }
      }, waClient, { skipActivityLog: true });

      await rateLimitedMcpWrite('append_note', {
        identifier: cand.id,
        note: `[Presentation ${formatDisplayDate(todayStr)}] Aligned for ${item.company}. Status: ${item.notes} (Shetty Saa)`
      }, waClient, { skipActivityLog: true });

      setLastDiscussedCandidate(cand);
      results.push(`• *${cand.name}* (📱 ${cand.phone || 'N/A'}) ➔ *${item.company}* (${item.notes}) ✅ _Updated_`);
    } else {
      const newCandData = {
        name: item.name,
        process: 'Voice',
        lineup_status: 'Yes',
        interview_date: todayStr,
        last_company: item.company,
        notes: `[Presentation ${formatDisplayDate(todayStr)}] Aligned for ${item.company}. Status: ${item.notes} (Shetty Saa)`
      };
      await addCandidateToRecrutOS(newCandData);
      results.push(`• *${item.name}* ➔ *${item.company}* (${item.notes}) 🌟 _Registered & Aligned_`);
    }
  }

  await logAgentActivity(waClient, {
    action: 'Presentation Ingested',
    category: 'RECRUTOS',
    details: `Ingested ${candidatesParsed.length} candidate presentations for ${formatDisplayDate(todayStr)}: ${candidatesParsed.map(c => `${c.name} (${c.company})`).join(', ')}`,
    source: 'Saa Trainer (Presentation Parser)',
    notifyBoss: true
  });

  return `📊 *Presentation Lineups Recorded in RecrutOS!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 Date: *${formatDisplayDate(todayStr)}*\n` +
    `👥 Processed: *${results.length} candidate(s)*\n\n` +
    `${results.join('\n')}\n\n` +
    `✅ _All candidate profiles updated live with lineup_status = 'Yes', today's interview date, company, and presentation notes._ 🚀`;
}

/**
 * parseDirectCommand — rule-based pre-parser for common boss commands.
 * Bypasses Gemini entirely: zero API cost, instant, 100% reliable.
 *
 * Handles:
 *   "Mark Ganesh lineup for tomorrow"
 *   "Priya interview date 5 oct confirmed"
 *   "Wasim joined today"
 *   "Darshan no show"
 *   "Remove Shilpa / dropout"
 *   "On hold Rizwan"
 */
async function parseDirectCommand(text, todayStr, waClient) {
  const t = text.trim();
  const lower = t.toLowerCase();

  // ── 00. RESET / FORGET SESSION CONTEXT (/new, /reset, /clear, "start fresh") ───
  if (/^(\/new|\/reset|\/clear|\/forget|new\s*chat|start\s*fresh|forget\s*candidate|reset\s*context)\b/i.test(lower)) {
    const forgotten = resetSessionContext();
    return `🔄 *Fresh Session Started, Shetty Saa!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      (forgotten ? `🗑️ Forgotten previous candidate: *${forgotten}*\n` : '') +
      `🧹 Cleared active candidate context & temporary conversation memory.\n\n` +
      `Ready for fresh instructions! What would you like to do next? 🚀`;
  }

  // ── 00A. PRESENTATION UPDATES INGESTION ──────────────────────────────────────
  // E.g. "Today's presentation - *Gous shaikh - Wipro (any)* Hr aligned. *Manish koli - Disa*"
  // E.g. "Today presentation:\n1. Gous shaikh - Wipro\n2. Manish koli - Disa"
  if (/^(?:today.?s?\s+)?presentation\b/i.test(lower) || /presentation\s*[-:]/i.test(lower) || /\*([a-zA-Z\s]{2,30})\s*[-–]\s*([a-zA-Z0-9\s\(\)]+)\*/i.test(t)) {
    const presResult = await handlePresentationUpdate(t, todayStr, waClient);
    if (presResult) return presResult;
  }

  // ── 00B. PIPELINE COUNT & OVERDUE QUERIES ─────────────────────────────────────
  // E.g. "I want u to check how many candidates in overdue lineup"
  // E.g. "how many candidates in overdue lineup"
  if (/(?:how many|count of|number of|total).*(?:lineup|overdue|joined|fresher|exp|candidate)/i.test(lower) ||
      (/\b(overdue\s*(?:lineups?|candidates?))\b/i.test(lower) && !/(?:forward|send|share|msg|text)\s+manual/i.test(lower))) {
    const statsRes = await callMCPTool('get_pipeline_stats', {});
    if (statsRes.ok) {
      const s = statsRes.data;
      if (/overdue|back.*dated/i.test(lower)) {
        return `⏳ *Overdue Lineups:* *${s.overdue_lineups}* candidate(s) have a past interview date who haven't joined yet.\n\n💡 Say *"forward manual JD to all overdue line ups"* to re-engage them!`;
      }
      if (/joined/i.test(lower)) {
        return `🎉 *Candidates Joined:* *${s.joined}* successfully placed so far.`;
      }
      if (/fresher/i.test(lower)) {
        return `👶 *Freshers in Pipeline:* *${s.fresher || 'N/A'}* active freshers in RecrutOS.`;
      }
      if (/experienced|exp/i.test(lower)) {
        return `💼 *Experienced Candidates:* *${s.experienced || 'N/A'}* in active pipeline.`;
      }
      if (/lineup/i.test(lower)) {
        return `📅 *In Lineup:* *${s.in_lineup}* candidates currently lined up.\n🎯 Today (${formatDisplayDate(todayStr)}): *${s.scheduled_for_today}*`;
      }
    }
  }

  // ── 0. ACTIVITY / RECENT UPDATES FEED ─────────────────────────────────────
  if (/^\/?(activity|updates?|recent updates?|feed|kya update kiya|history log)\b/i.test(lower.trim())) {
    return getRecentActivityBriefing(15);
  }

  // ── 0A. GLOBAL AUTO-REPLY PAUSE & RESUME ──────────────────────────────────
  if (
    /\b(stop msging any candidates|stop auto replying|pause auto replying|pause candidate messaging|stop all candidate messages|stop replying to candidates|mute all candidates|stop bot replies)\b/i.test(lower) ||
    /^(stop|pause|halt)\s+(msging|messaging|replying|texting|auto\s*replying|auto\s*reply|bot)\s*(any\s+candidates?|all\s+candidates?|candidates?|replies)?$/i.test(lower)
  ) {
    setGlobalAutoReplyPaused(true);
    await logAgentActivity(waClient, {
      action: 'Auto-Reply Paused',
      category: 'SYSTEM',
      details: 'Global automated candidate responses and scheduled outreach paused by Shetty Saa.',
      source: 'Saa Trainer',
      notifyBoss: true
    });
    return `⏸️ *Automated Outreach Paused!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🛑 All automated candidate replies, greetings, intake questions, and scheduled follow-ups are now **PAUSED**.\n\n` +
      `💡 *Current Mode:*\n` +
      `• Candidates can still message you, and their replies are still auto-synced live to RecrutOS notes.\n` +
      `• You have 100% manual control over conversations without bot interference.\n\n` +
      `Say *"resume auto replying"* or *"start msging candidates"* whenever you want me to resume.`;
  }

  if (
    /\b(resume auto replying|start auto replying|resume msging candidates|start msging candidates|resume candidate messaging|start candidate messages|enable auto replying|unpause auto replying)\b/i.test(lower) ||
    /^(resume|start|enable|unpause)\s+(msging|messaging|replying|texting|auto\s*replying|auto\s*reply|bot)\s*(any\s+candidates?|all\s+candidates?|candidates?|replies)?$/i.test(lower)
  ) {
    setGlobalAutoReplyPaused(false);
    await logAgentActivity(waClient, {
      action: 'Auto-Reply Resumed',
      category: 'SYSTEM',
      details: 'Global automated candidate responses and scheduled outreach resumed by Shetty Saa.',
      source: 'Saa Trainer',
      notifyBoss: true
    });
    return `▶️ *Automated Outreach Resumed!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ Autonomous candidate intake, profile matching, and scheduled interview follow-ups are now **ACTIVE**.\n\n` +
      `_I will assist incoming candidates and keep RecrutOS synced live._ 🚀`;
  }

  // ── 0B. SEARCH CANDIDATES BY LOCATION & SHARE COMPANY JD ───────────────────
  // E.g. "search miraroad candidates and share them epicenter hiring JD"
  // E.g. "search thane candidates and share concentrix JD"
  // E.g. "share epicenter hiring JD to miraroad candidates"
  const searchShare1 = lower.match(/(?:search|find|filter)\s+([a-zA-Z\s]+?)\s+candidates?\s+(?:and\s+)?(?:share|send|forward)(?:\s+them|\s+to\s+them)?\s+([a-zA-Z0-9\s\-\(\)\.]+?)\s+(?:hiring\s+)?(?:jd|job\s*description|opening)/i);
  const searchShare2 = !searchShare1 && lower.match(/(?:share|send|forward)\s+([a-zA-Z0-9\s\-\(\)\.]+?)\s+(?:hiring\s+)?(?:jd|job\s*description|opening)\s+(?:to\s+)?(?:all\s+)?(?:candidates\s+in\s+|candidates\s+from\s+|candidates\s+of\s+|candidates\s+)([a-zA-Z\s]+)/i);

  if (searchShare1 || searchShare2) {
    let locQuery = '';
    let compQuery = '';
    if (searchShare1) {
      locQuery = searchShare1[1].trim();
      compQuery = searchShare1[2].trim();
    } else {
      compQuery = searchShare2[1].trim();
      locQuery = searchShare2[2].trim();
    }
    console.log(`[DirectCmd] 🎯 Search & Share JD: Loc="${locQuery}" Comp="${compQuery}"`);
    return await handleSearchAndShareJD(locQuery, compQuery, waClient, todayStr);
  }

  // ── 0C. FORWARD MANUAL JD TO ALL OVERDUE LINE UPS ──────────────────────────
  // E.g. "forward manual JD to all overdue line ups: [JD]"
  // E.g. "forward manual JD to overdue line ups\n[JD]"
  // E.g. "forward manual JD to all overdue line ups" (lists candidates & prompts)
  if (/\b(forward|send|share)\s+(?:manual\s+)?jd\s+(?:to\s+)?(?:all\s+)?overdue\s*(?:line\s*ups?|lineups?|candidates?)\b/i.test(lower)) {
    let manualJd = t.replace(/^.*?(?:overdue\s*(?:line\s*ups?|lineups?|candidates?))(?:\s*[:\-–\n]\s*|\s+)(.*)$/is, '$1').trim();
    if (manualJd.toLowerCase() === t.toLowerCase()) {
      manualJd = '';
    }
    console.log(`[DirectCmd] 📨 Forward Manual JD to Overdue Lineups. JD length: ${manualJd.length}`);
    return await handleForwardJDToOverdue(manualJd, waClient, todayStr);
  }

  // ── 0D. INGEST NEW JD FROM CHANNEL / CHAT WITH UPFRONT CLARIFICATIONS ──────
  const isJdPost = /^(new\s*jd|train\s*jd|hiring\s*alert|job\s*alert|channel\s*post)[:\s]/i.test(lower) ||
    (/\b(urgently hiring|openings for|hiring in|mega drive|walkin drive|walk-in drive)\b/i.test(lower) && /\b(salary|inhand|shift|qualification|location|process)\b/i.test(lower));

  if (isJdPost) {
    console.log(`[DirectCmd] 📝 Ingest JD post received: "${t.slice(0, 60)}..."`);
    return handleIngestJDWithClarifications(t, waClient);
  }

  // ── 0D2. DIRECT JD / COMPANY DETAILS LOOKUP ────────────────────────────────
  // Handles:
  //   - "/jd" or "/jd <company>"
  //   - "May I have JD of techm", "give me jd of foundever", "share jd of accenture"
  //   - "Help me with Accenture details", "Help me with Accenture jd"
  //   - "What do u know about TechM hiring?", "what do you know about accenture hiring"
  //   - "What is the JD for WNS", "tell me about Concentrix openings"
  const isJdQuery =
    /^\/jd\b/i.test(lower) ||
    /\b(?:may\s+i\s+have\s+jd\s+of|give\s+me\s+jd\s+of|send\s+(?:me\s+)?jd\s+of|share\s+jd\s+of|can\s+i\s+(?:have|get)\s+jd\s+of|what\s+is\s+the\s+jd\s+(?:of|for))\s+([a-zA-Z0-9\s\.\-]+)/i.test(lower) ||
    /\bhelp\s+me\s+with\s+([a-zA-Z0-9\s\.\-]+?)\s+(?:jd|job\s*description|details|hiring|openings|process)\b/i.test(lower) ||
    /\bwhat\s+do\s+(?:u|you)\s+know\s+about\s+([a-zA-Z0-9\s\.\-]+?)\s+hiring\b/i.test(lower) ||
    /\btell\s+me\s+about\s+([a-zA-Z0-9\s\.\-]+?)\s+(?:hiring|openings|jd|process)\b/i.test(lower);

  if (isJdQuery) {
    let companyTarget = '';
    const m1 = lower.match(/(?:may\s+i\s+have\s+jd\s+of|give\s+me\s+jd\s+of|send\s+(?:me\s+)?jd\s+of|share\s+jd\s+of|can\s+i\s+(?:have|get)\s+jd\s+of|what\s+is\s+the\s+jd\s+(?:of|for))\s+([a-zA-Z0-9\s\.\-]+)/i);
    const m2 = !m1 && lower.match(/help\s+me\s+with\s+([a-zA-Z0-9\s\.\-]+?)\s+(?:jd|job\s*description|details|hiring|openings|process)/i);
    const m3 = !m1 && !m2 && lower.match(/what\s+do\s+(?:u|you)\s+know\s+about\s+([a-zA-Z0-9\s\.\-]+?)\s+hiring/i);
    const m4 = !m1 && !m2 && !m3 && lower.match(/tell\s+me\s+about\s+([a-zA-Z0-9\s\.\-]+?)\s+(?:hiring|openings|jd|process)/i);
    const m5 = !m1 && !m2 && !m3 && !m4 && lower.match(/^\/jd(?:\s+(.+))?$/i);

    if (m1) companyTarget = m1[1].trim();
    else if (m2) companyTarget = m2[1].trim();
    else if (m3) companyTarget = m3[1].trim();
    else if (m4) companyTarget = m4[1].trim();
    else if (m5) companyTarget = (m5[1] || '').trim();

    companyTarget = companyTarget.replace(/[\?\!\.\,\;\:]+$/g, '').trim();

    if (!companyTarget) {
      return getAllOpenCompaniesSummary();
    }

    const jd = getCompanyJDFromTraining(companyTarget);
    if (jd) {
      console.log(`[DirectCmd] 📋 Direct JD retrieved for "${companyTarget}"`);
      return `📋 *RecrutOS Hiring Job Description*\n━━━━━━━━━━━━━━━━━━━━━━\n${jd}\n━━━━━━━━━━━━━━━━━━━━━━\n💡 _To search & text matching candidates, say:_\n*"search voice freshers and share ${companyTarget.toUpperCase()} JD"*`;
    } else {
      return `ℹ️ I checked our records, but couldn't find a recorded Job Description for *"${companyTarget}"*.\n\n` +
        `Here are the companies currently hiring in RecrutOS:\n` +
        `• *Foundever* (Airoli & Andheri)\n` +
        `• *WNS* (Vikhroli)\n` +
        `• *JP Morgan* (Malad Mindspace)\n` +
        `• *Concentrix* (Malad & Thane)\n` +
        `• *Teleperformance* (Malad & Andheri)\n` +
        `• *TCS BPS* (Goregaon & Thane)\n` +
        `• *Accenture* (Vikhroli & Airoli)\n` +
        `• *Tech Mahindra* (Malad Mindspace)\n` +
        `• *Firstsource* (Malad Mindspace)\n` +
        `• *Sambridge* (Powai)\n` +
        `• *Sutherland* (Airoli)\n` +
        `• *TSI / Transcom* (Vashi)\n` +
        `• *Radius* (Powai)\n` +
        `• *Epicenter* (Mira Bhayandar)\n` +
        `• *ETraveli* (Andheri East)\n` +
        `• *Spark Capital* (Santacruz)\n` +
        `• *Narith Solutions* (Thane)\n` +
        `• *Disa Technologies* (Thane)\n` +
        `• *Wipro BPO* (Airoli & Thane)\n` +
        `• *Capita India* (Vikhroli)\n` +
        `• *Sterling BPO* (Goregaon)\n\n` +
        `Send *"help me with [company] jd"* to see full criteria!`;
    }
  }

  // ── Extract candidate name from text ─────────────────────────────────────
  // Strips known command words to isolate the name
  const stripWords = [
    'mark','set','update','confirm','confirmed','lineup','line up','line-up',
    'interview','date','for','of','is','as','today','tomorrow','kal','aaj',
    'joined','joining','no show','dropout','drop out','remove','on hold',
    'selected','not interested','absent','didn\'t come','didn\'t show',
    'nahi aaya','aa gaya','interview pe aana','intervte','intervue',
  ];

  // Exclude question phrases — "what is lineup?" or "i want u to check..." should NOT trigger pre-parser
  const _isQuestion = /^(what|show|how|who|which|is there|are there|tell me|give me|get|list|check|find|i want (?:u|you) to (?:check|find|see|know|count))/i.test(lower.trim()) ||
    lower.includes('?') ||
    /\b(how many|count|stats|dashboard|summary)\b/i.test(lower);

  // ── 0E. COMPOUND REMINDER + LINEUP COMMAND ──────────────────────────────────
  // E.g. "Remind me to call her tomorrow by 11 am set her line up for tomorrow"
  // E.g. "Remind me to call Priyanka at 11 am tomorrow and set her lineup"
  // E.g. "Set her lineup for tomorrow and remind me to call at 11 am"
  const hasReminderWord = /\b(remind(?:\s*me)?|set\s*reminder|reminder)\b/i.test(lower);
  const hasLineupWord   = /\b(lineup|line\s*up|line-up|interview)\b/i.test(lower);

  if (hasReminderWord && hasLineupWord && !_isQuestion) {
    console.log(`[DirectCmd] 🔄 COMPOUND COMMAND detected (Reminder + Lineup): "${t}"`);

    // 1. Identify Candidate
    let cand = null;
    const phoneMatch = t.match(/\b([6-9]\d{9})\b/) || t.match(/(?:(?:\+?91[\s\-]*)?[6-9]\d{4}[\s\-]*\d{5})/);
    if (phoneMatch) {
      const cleanPhone = phoneMatch[0].replace(/\D/g, '').slice(-10);
      const candRes = await resolveCandidateWithPronoun(cleanPhone);
      if (candRes.ok) cand = candRes.data;
    }

    const hasPronoun = /\b(her|him|she|he|them|they|this candidate|that candidate)\b/i.test(lower);
    if (!cand && hasPronoun) {
      cand = getLastDiscussedCandidate();
    }

    if (!cand) {
      const nameMatch = lower.match(/(?:call|ping|msg|lineup\s+for|line\s*up\s+for)\s+([a-zA-Z\s]{2,25}?)(?:\s+(?:tomorrow|today|at|by|for|set|and|\d))/i);
      if (nameMatch && nameMatch[1]) {
        const nameGuess = nameMatch[1].trim();
        if (!/^(her|him|she|he|them|me|candidate|lineup|reminder)$/i.test(nameGuess)) {
          const candRes = await resolveCandidateWithPronoun(nameGuess);
          if (candRes.ok) cand = candRes.data;
        }
      }
    }

    if (!cand) {
      cand = getLastDiscussedCandidate();
    }

    if (!cand) {
      return `⚠️ Couldn't identify the candidate for this lineup & reminder.\n\nPlease specify candidate name or phone number.`;
    }

    // 2. Resolve Dates
    const lineupDate = resolveDate(lower, todayStr) || getISTDateString(1);
    const reminderDate = resolveDate(lower, todayStr) || lineupDate;

    // 3. Resolve Reminder Time
    let reminderTime = '11:00 AM';
    const timeMatch = lower.match(/\b(?:at|by)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i) ||
                      lower.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
    if (timeMatch && timeMatch[1]) {
      let rawT = timeMatch[1].trim().toLowerCase();
      if (!rawT.includes('am') && !rawT.includes('pm')) {
        const num = parseInt(rawT, 10);
        rawT = (num >= 8 && num <= 11) ? `${num}:00 AM` : (num === 12 ? `12:00 PM` : `${num}:00 PM`);
      } else {
        rawT = rawT.replace(/\s+/g, '').toUpperCase();
        if (!rawT.includes(':')) {
          rawT = rawT.replace(/(\d+)(AM|PM)/, '$1:00 $2');
        } else {
          rawT = rawT.replace(/(\d+:\d+)(AM|PM)/, '$1 $2');
        }
      }
      reminderTime = rawT;
    }

    // 4. Update Candidate Lineup in RecrutOS
    await rateLimitedMcpWrite('update_candidate', {
      identifier: cand.id,
      updates: { lineup_status: 'Yes', interview_date: lineupDate }
    }, waClient, { skipActivityLog: true });

    await rateLimitedMcpWrite('append_note', {
      identifier: cand.id,
      note: `Lineup set for ${lineupDate} + Reminder set for ${reminderDate} at ${reminderTime} by Shetty Saa`
    }, waClient, { skipActivityLog: true });

    // 5. Create Reminder in ros_reminders
    await callMCPTool('add_reminder', {
      identifier: cand.id,
      date: reminderDate,
      time: reminderTime,
      note: `Call ${cand.name} for interview lineup (${lineupDate})`
    }, waClient, { skipActivityLog: true });

    setLastDiscussedCandidate(cand);

    const displayLineupDate = formatDisplayDate(lineupDate);
    const displayRemDate = formatDisplayDate(reminderDate);

    await logAgentActivity(waClient, {
      action: 'Lineup & Reminder Set',
      category: 'RECRUTOS',
      candidateName: cand.name,
      candidatePhone: cand.phone,
      candidateId: cand.id,
      details: `Lineup: ${displayLineupDate} | Reminder: ${displayRemDate} at ${reminderTime}`,
      source: 'Saa Trainer (Compound Command)',
      notifyBoss: true,
    });

    return `✅ *Lineup Confirmed & Reminder Set!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *${cand.name}* (📱 ${cand.phone || 'N/A'})\n` +
      `📅 Interview Date: *${displayLineupDate}*\n` +
      `🔖 Lineup Status: *Lined Up ✓*\n` +
      `⏰ Reminder: *${displayRemDate} at ${reminderTime}*\n` +
      `📝 Note: "Call ${cand.name} for interview lineup"\n\n` +
      `_Both lineup and reminder saved live in RecrutOS._ 📋`;
  }

  // ── 0F. STANDALONE REMINDER CREATION ─────────────────────────────────────────
  // E.g. "Remind me to call her tomorrow by 11 am"
  // E.g. "Remind me to call Priyanka at 4 pm"
  // E.g. "Set reminder to call 9820123456 tomorrow"
  if (hasReminderWord && !_isQuestion && !/^(reminders?|tasks?|pending\s*reminders?)$/i.test(lower.trim())) {
    console.log(`[DirectCmd] ⏰ Standalone Reminder command detected: "${t}"`);

    // 1. Identify Candidate
    let cand = null;
    const phoneMatch = t.match(/\b([6-9]\d{9})\b/) || t.match(/(?:(?:\+?91[\s\-]*)?[6-9]\d{4}[\s\-]*\d{5})/);
    if (phoneMatch) {
      const cleanPhone = phoneMatch[0].replace(/\D/g, '').slice(-10);
      const candRes = await resolveCandidateWithPronoun(cleanPhone);
      if (candRes.ok) cand = candRes.data;
    }

    const hasPronoun = /\b(her|him|she|he|them|they|this candidate|that candidate)\b/i.test(lower);
    if (!cand && hasPronoun) {
      cand = getLastDiscussedCandidate();
    }

    if (!cand) {
      const nameMatch = lower.match(/(?:call|contact|ping|msg|for)\s+([a-zA-Z\s]{2,25}?)(?:\s+(?:tomorrow|today|at|by|and|\d))/i);
      if (nameMatch && nameMatch[1]) {
        const nameGuess = nameMatch[1].trim();
        if (!/^(her|him|she|he|them|me|candidate|reminder)$/i.test(nameGuess)) {
          const candRes = await resolveCandidateWithPronoun(nameGuess);
          if (candRes.ok) cand = candRes.data;
        }
      }
    }

    if (!cand) {
      cand = getLastDiscussedCandidate();
    }

    const targetName = cand ? cand.name : 'Candidate';
    const targetPhone = cand ? cand.phone : '';

    // 2. Resolve Date & Time
    const reminderDate = resolveDate(lower, todayStr) || getISTDateString(1);

    let reminderTime = '11:00 AM';
    const timeMatch = lower.match(/\b(?:at|by)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i) ||
                      lower.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
    if (timeMatch && timeMatch[1]) {
      let rawT = timeMatch[1].trim().toLowerCase();
      if (!rawT.includes('am') && !rawT.includes('pm')) {
        const num = parseInt(rawT, 10);
        rawT = (num >= 8 && num <= 11) ? `${num}:00 AM` : (num === 12 ? `12:00 PM` : `${num}:00 PM`);
      } else {
        rawT = rawT.replace(/\s+/g, '').toUpperCase();
        if (!rawT.includes(':')) {
          rawT = rawT.replace(/(\d+)(AM|PM)/, '$1:00 $2');
        } else {
          rawT = rawT.replace(/(\d+:\d+)(AM|PM)/, '$1 $2');
        }
      }
      reminderTime = rawT;
    }

    const reminderNote = `Call ${targetName}`;

    // 3. Create Reminder in RecrutOS
    await callMCPTool('add_reminder', {
      identifier: cand ? cand.id : targetName,
      date: reminderDate,
      time: reminderTime,
      note: reminderNote
    }, waClient, { skipActivityLog: true });

    if (cand) {
      setLastDiscussedCandidate(cand);
      await rateLimitedMcpWrite('append_note', {
        identifier: cand.id,
        note: `Reminder scheduled for ${reminderDate} at ${reminderTime} by Shetty Saa`
      }, waClient, { skipActivityLog: true });
    }

    const displayRemDate = formatDisplayDate(reminderDate);

    await logAgentActivity(waClient, {
      action: 'Reminder Created',
      category: 'RECRUTOS',
      candidateName: targetName,
      candidatePhone: targetPhone,
      candidateId: cand?.id,
      details: `Reminder for ${displayRemDate} at ${reminderTime}: "${reminderNote}"`,
      source: 'Saa Trainer (Reminder Command)',
      notifyBoss: true,
    });

    return `⏰ *Reminder Scheduled in RecrutOS!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *${targetName}* ${targetPhone ? `(📱 ${targetPhone})` : ''}\n` +
      `📅 Date: *${displayRemDate}*\n` +
      `⏰ Time: *${reminderTime}*\n` +
      `📝 Note: "${reminderNote}"\n\n` +
      `_Saved live in RecrutOS reminders. You will be alerted at that time._ 🔔`;
  }

  // ── 0F. BULK RESCHEDULE LINEUPS ──────────────────────────────────────────
  // E.g. "Aaj ke sare candidates ko kal ke date ke lie align karo as line up"
  // E.g. "change all candidtaes line up dates who was of todayss day for tomorrow"
  // E.g. "All candidates who had today's line up date, change them to tomorrows date"
  // E.g. "Reschedule all today's lineups to tomorrow"
  // E.g. "Shift all candidates from today to tomorrow"
  if (isBulkRescheduleCommand(lower)) {
    const { sourceDate, targetDate } = parseBulkRescheduleDates(lower, todayStr);
    console.log(`[DirectCmd] 🔄 BULK RESCHEDULE: from=${sourceDate} to=${targetDate}`);

    const res = await callMCPTool('batch_reschedule_lineups', {
      source_date: sourceDate,
      target_date: targetDate,
    }, waClient);

    const fromDisplay = formatDisplayDate(sourceDate);
    const toDisplay = formatDisplayDate(targetDate);

    if (!res.ok) {
      return `❌ *Bulk Reschedule Failed*\n━━━━━━━━━━━━━━━━━━━━━━\n${res.error || 'Unknown error occurred while updating RecrutOS.'}`;
    }

    if (res.count === 0) {
      return `ℹ️ *No Lineups Found to Reschedule*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📅 Checked Date: *${fromDisplay}*\n` +
        `🚀 Target Date: *${toDisplay}*\n\n` +
        `Found 0 candidates scheduled with an interview on ${fromDisplay} in RecrutOS.\n` +
        `_No updates were needed._ 👍`;
    }

    const cList = (res.candidates || []).slice(0, 15).map((c, i) =>
      `${i + 1}. *${c.name}* (📱 ${c.phone}) — ${c.process || 'Voice'}`
    ).join('\n');
    const extraCount = (res.candidates?.length || 0) > 15 ? `\n_...and ${res.candidates.length - 15} more_\n` : '\n';

    await logAgentActivity(waClient, {
      action: 'Bulk Lineup Rescheduled',
      category: 'RECRUTOS',
      details: `Shifted ${res.count} candidates from ${fromDisplay} (${sourceDate}) to ${toDisplay} (${targetDate}) by Shetty Saa`,
      source: 'Saa Trainer (Bulk Reschedule Command)',
      notifyBoss: true,
    });

    return `📅 *Bulk Lineup Rescheduled Live in RecrutOS!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📅 Original Date: *${fromDisplay}*\n` +
      `🚀 New Interview Date: *${toDisplay}*\n` +
      `👥 Total Shifted: *${res.count} candidate(s)*\n\n` +
      cList + extraCount +
      `\n✅ _All ${res.count} candidate profiles updated with lineup_status = 'Yes', new interview date, and live timestamped notes._ 🎯`;
  }

  // ── 1. LINEUP / INTERVIEW DATE ────────────────────────────────────────────
  // Exclude question phrases — "what is lineup?" should NOT trigger pre-parser
  const isLineupCmd = !_isQuestion &&
    !/\b(how many|stats|report|summary|count|overdue|why|when)\b/i.test(lower) &&
    /\b(lineup|line up|line-up|interview date|set date|confirm.*interview|interview.*confirm|intervte|intervue)\b/i.test(lower);

  if (isLineupCmd) {
    const resolvedDate = resolveDate(lower, todayStr) || todayStr;

    // Check pronoun reference first
    const hasPronounRef = /\b(her|him|she|he|them|they|this candidate|that candidate)\b/i.test(lower);
    let nameGuess = '';

    if (hasPronounRef) {
      const last = getLastDiscussedCandidate();
      if (last) {
        nameGuess = last.name;
        console.log(`[DirectCmd] 🔄 Lineup pronoun resolved to last discussed candidate: "${nameGuess}"`);
      }
    }

    if (!nameGuess) {
      // ── Extract candidate name: aggressively strip ALL non-name words ─────────
      nameGuess = t
        // Possessive-s: "prathams" → "pratham", "priya's" → "priya"
        .replace(/\b([a-z]{3,})'?s\b/gi, (m, w) => w)
        // Action / command / reminder verbs
        .replace(/\b(remind(?:\s*me)?(?:\s*to\s*call)?|call|phone|text|msg|message|ping|ask|contact|check|tell|inform|invite|please|kindly|setup|align|change|move|shift|reschedule|mark|set|update|confirm(?:ed)?|intervte|intervue)\b/gi, ' ')
        // Lineup / interview keywords
        .replace(/\b(lineup|line\s*up|line-up|interview\s*date|set\s*date|interview|date)\b/gi, ' ')
        // Common filler prepositions, articles, copulas
        .replace(/\b(for|of|as|to|the|a|an|is|its|it|this|that|do|can|you|in|on|at|by|with|from|into|and)\b/gi, ' ')
        // Date words
        .replace(/\b(today|tomorrow|kal|aaj|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s*day|parso)\b/gi, ' ')
        // Explicit times & date patterns
        .replace(/\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi, ' ')
        .replace(/\d{1,2}[\s\-\/]\w+|\d{4}-\d{2}-\d{2}/g, ' ')
        .replace(/\s+/g, ' ').trim();

      // Guard: If nameGuess still contains bulk / instruction words, abort
      const isBulkOrInstruction = /\b(all|sare|saare|sab|sabhi|every|everyone|everybody|candidates?|kisi|team|group|who|had|was|were|them|these|those)\b/i.test(nameGuess);
      if (isBulkOrInstruction || nameGuess.length > 35) {
        console.log(`[DirectCmd] ⚠️ Skipping single lineup parser: "${nameGuess}" looks like a bulk/instruction phrase.`);
        return null;
      }

      // ── Quality check: if remaining words are ALL common English noise, use context memory ──
      const NOISE_WORDS = /^(up|is|its|it|to|a|an|the|for|of|as|do|set|on|in|at|by|with|please|kindly|ok|done|him|her|them|he|she|they|this|that|me|my|our|your|remind|call|phone|tell|msg|ask|from|now|said|and|so|if|then)$/i;
      const remainingMeaningful = nameGuess.split(/\s+/).filter(w => w.length >= 2 && !NOISE_WORDS.test(w));
      if (remainingMeaningful.length === 0) {
        const last = getLastDiscussedCandidate();
        if (last) {
          nameGuess = last.name;
          console.log(`[DirectCmd] 🔄 nameGuess was noise — using context memory: "${nameGuess}"`);
        } else {
          console.log('[DirectCmd] ⚠️ nameGuess is noise and no context memory. Falling through.');
          return null;
        }
      } else {
        nameGuess = remainingMeaningful.join(' ');
      }
    }

    if (!nameGuess || nameGuess.length < 2) {
      const last = getLastDiscussedCandidate();
      if (last) nameGuess = last.name;
      else return null;
    }

    console.log(`[DirectCmd] 📅 LINEUP: name="${nameGuess}" date=${resolvedDate}`);

    // Find candidate with pronoun & context memory & fuzzy fallback
    const found = await resolveCandidateWithPronoun(nameGuess);
    if (!found.ok) {
      return `⚠️ Couldn't find candidate "*${nameGuess}*" in RecrutOS.\n\nPlease check the spelling or search with phone number.`;
    }

    const cand = found.data;

    // Update with rate-limit guard
    const upd = await rateLimitedMcpWrite('update_candidate', {
      identifier: cand.id,
      updates: { lineup_status: 'Yes', interview_date: resolvedDate }
    }, waClient, { skipActivityLog: true });

    // Also append a note
    await rateLimitedMcpWrite('append_note', {
      identifier: cand.id,
      note: `Lineup confirmed for ${resolvedDate} by Shetty Saa`
    }, waClient, { skipActivityLog: true });

    if (!upd.ok) return `❌ Update failed for *${cand.name}*: ${upd.error}`;

    const displayDate = new Date(resolvedDate + 'T00:00:00+05:30')
      .toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

    await logAgentActivity(waClient, {
      action: 'Lineup Confirmed',
      category: 'RECRUTOS',
      candidateName: cand.name,
      candidatePhone: cand.phone,
      candidateId: cand.id,
      details: `Interview set for ${displayDate}. Lineup status: Yes`,
      source: 'Saa Trainer (Lineup Command)',
      notifyBoss: true,
    });

    return `✅ *Lineup Confirmed in RecrutOS!*\n━━━━━━━━━━━━━━━━━━━━━━\n👤 *${cand.name}* (📱 ${cand.phone})\n📅 Interview Date: *${displayDate}*\n🔖 Status: *Lined Up ✓*\n\n_Both interview_date and lineup_status updated live in RecrutOS._`;
  }

  // ── 2. JOINED ─────────────────────────────────────────────────────────────
  const isJoinedCmd = /\b(joined|joining|aa gaya|join kar liya|selected and joined)\b/i.test(lower);
  if (isJoinedCmd && !/\?/.test(lower)) {
    let nameGuess = t
      .replace(/joined|joining|aa gaya|join kar liya|selected and joined|mark|update|confirm/gi, ' ')
      .replace(/\b(today|tomorrow|kal|aaj|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim();

    const isBulkOrInstruction = /\b(all|sare|saare|sab|sabhi|every|everyone|everybody|candidates?|candid[a-z]+|kisi|team|group|who|had|was|were|change|align|shift|reschedule|them|these|those)\b/i.test(nameGuess);
    if (isBulkOrInstruction || nameGuess.length > 30) {
      console.log(`[DirectCmd] ⚠️ Skipping single joined parser: "${nameGuess}" looks like a bulk/instruction phrase.`);
      return null;
    }

    let cand = null;
    if (!nameGuess || nameGuess.length < 2 || /^(her|him|she|he|them)$/i.test(nameGuess)) {
      cand = getLastDiscussedCandidate();
    }
    if (!cand) {
      const found = await resolveCandidateWithPronoun(nameGuess);
      if (found.ok) cand = found.data;
    }
    if (!cand) return `⚠️ Candidate "*${nameGuess}*" not found in RecrutOS.`;

    console.log(`[DirectCmd] ✅ JOINED: candidate="${cand.name}"`);

    const upd = await rateLimitedMcpWrite('update_candidate', {
      identifier: cand.id,
      updates: { joined_status: 'Joined', lineup_status: 'Yes' }
    }, waClient, { skipActivityLog: true });
    await rateLimitedMcpWrite('append_note', {
      identifier: cand.id,
      note: `Joined — confirmed by Shetty Saa`
    }, waClient, { skipActivityLog: true });

    setLastDiscussedCandidate(cand);

    if (!upd.ok) return `❌ Update failed: ${upd.error}`;

    await logAgentActivity(waClient, {
      action: 'Candidate Joined',
      category: 'RECRUTOS',
      candidateName: cand.name,
      candidatePhone: cand.phone,
      candidateId: cand.id,
      details: `Marked Joined in RecrutOS. Placement completed!`,
      source: 'Saa Trainer (Joined Command)',
      notifyBoss: true,
    });

    return `🎉 *Joined — RecrutOS Updated!*\n━━━━━━━━━━━━━━━━━━━━━━\n👤 *${cand.name}* (📱 ${cand.phone})\n✅ Status: *Joined*\n\n_RecrutOS updated live. Great placement, Shetty Saa!_ 🚀`;
  }

  // ── 3. NO SHOW ────────────────────────────────────────────────────────────
  const isNoShow = /\b(no show|no.show|didn'?t come|didn'?t show|absent|nahi aaya|nahi aya)\b/i.test(lower);
  if (isNoShow) {
    let nameGuess = t
      .replace(/no\s*show|didn'?t come|didn'?t show|absent|nahi aaya|nahi aya|mark|update/gi, ' ')
      .replace(/\b(today|tomorrow|kal|aaj|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim();

    const isBulkOrInstruction = /\b(all|sare|saare|sab|sabhi|every|everyone|everybody|candidates?|candid[a-z]+|kisi|team|group|who|had|was|were|change|align|shift|reschedule|them|these|those)\b/i.test(nameGuess);
    if (isBulkOrInstruction || nameGuess.length > 30) {
      console.log(`[DirectCmd] ⚠️ Skipping single no-show parser: "${nameGuess}" looks like a bulk/instruction phrase.`);
      return null;
    }

    let cand = null;
    if (!nameGuess || nameGuess.length < 2 || /^(her|him|she|he|them)$/i.test(nameGuess)) {
      cand = getLastDiscussedCandidate();
    }
    if (!cand) {
      const found = await resolveCandidateWithPronoun(nameGuess);
      if (found.ok) cand = found.data;
    }
    if (!cand) return `⚠️ Candidate "*${nameGuess}*" not found in RecrutOS.`;

    console.log(`[DirectCmd] 🚫 NO SHOW: candidate="${cand.name}"`);

    const upd = await rateLimitedMcpWrite('update_candidate', {
      identifier: cand.id,
      updates: { joined_status: 'No Show' }
    }, waClient, { skipActivityLog: true });
    await rateLimitedMcpWrite('append_note', {
      identifier: cand.id,
      note: `No Show — confirmed by Shetty Saa on ${todayStr}`
    }, waClient, { skipActivityLog: true });

    setLastDiscussedCandidate(cand);

    if (!upd.ok) return `❌ Update failed: ${upd.error}`;

    await logAgentActivity(waClient, {
      action: 'No Show Marked',
      category: 'RECRUTOS',
      candidateName: cand.name,
      candidatePhone: cand.phone,
      candidateId: cand.id,
      details: `Marked No Show in RecrutOS on ${todayStr}.`,
      source: 'Saa Trainer (No Show Command)',
      notifyBoss: true,
    });

    return `📋 *No Show — RecrutOS Updated*\n━━━━━━━━━━━━━━━━━━━━━━\n👤 *${cand.name}* (📱 ${cand.phone})\n❌ Status: *No Show*\n\n_Marked live in RecrutOS. Want me to reschedule them?_`;
  }

  // ── 4. DROPOUT / REMOVE ───────────────────────────────────────────────────
  const isDropout = /\b(dropout|drop out|remove|not interested|nahi karega|nahi karengi|band kar)\b/i.test(lower);
  if (isDropout) {
    let nameGuess = t
      .replace(/dropout|drop out|remove|not interested|nahi karega|band kar|mark|update/gi, ' ')
      .replace(/\b(today|tomorrow|kal|aaj|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim();

    const isBulkOrInstruction = /\b(all|sare|saare|sab|sabhi|every|everyone|everybody|candidates?|candid[a-z]+|kisi|team|group|who|had|was|were|change|align|shift|reschedule|them|these|those)\b/i.test(nameGuess);
    if (isBulkOrInstruction || nameGuess.length > 30) {
      console.log(`[DirectCmd] ⚠️ Skipping single dropout parser: "${nameGuess}" looks like a bulk/instruction phrase.`);
      return null;
    }

    let cand = null;
    if (!nameGuess || nameGuess.length < 2 || /^(her|him|she|he|them)$/i.test(nameGuess)) {
      cand = getLastDiscussedCandidate();
    }
    if (!cand) {
      const found = await resolveCandidateWithPronoun(nameGuess);
      if (found.ok) cand = found.data;
    }
    if (!cand) return `⚠️ Candidate "*${nameGuess}*" not found in RecrutOS.`;

    console.log(`[DirectCmd] 🗑️ DROPOUT: candidate="${cand.name}"`);

    const upd = await rateLimitedMcpWrite('update_candidate', {
      identifier: cand.id,
      updates: { lineup_status: 'No', joined_status: 'Dropout' }
    }, waClient, { skipActivityLog: true });
    await rateLimitedMcpWrite('append_note', {
      identifier: cand.id,
      note: `Marked Dropout by Shetty Saa on ${todayStr}`
    }, waClient, { skipActivityLog: true });

    setLastDiscussedCandidate(cand);

    if (!upd.ok) return `❌ Update failed: ${upd.error}`;

    await logAgentActivity(waClient, {
      action: 'Dropout Marked',
      category: 'RECRUTOS',
      candidateName: cand.name,
      candidatePhone: cand.phone,
      candidateId: cand.id,
      details: `Marked Dropout in RecrutOS on ${todayStr}.`,
      source: 'Saa Trainer (Dropout Command)',
      notifyBoss: true,
    });

    return `🗑️ *Dropout — RecrutOS Updated*\n━━━━━━━━━━━━━━━━━━━━━━\n👤 *${cand.name}* (📱 ${cand.phone})\n⛔ Status: *Dropout*\n\n_Marked live. Pipeline updated._`;
  }

  // ── 5. ON HOLD ────────────────────────────────────────────────────────────
  const isOnHold = /\b(on hold|hold|pending|ruk ja|rukao)\b/i.test(lower);
  if (isOnHold && /\b(candidate|name|for)\b/i.test(lower) === false) {
    let nameGuess = t
      .replace(/on hold|hold|pending|ruk ja|rukao|mark|update|set/gi, ' ')
      .replace(/\s+/g, ' ').trim();

    const isBulkOrInstruction = /\b(all|sare|saare|sab|sabhi|every|everyone|everybody|candidates?|candid[a-z]+|kisi|team|group|who|had|was|were|change|align|shift|reschedule|them|these|those)\b/i.test(nameGuess);
    if (isBulkOrInstruction || nameGuess.length > 30) {
      console.log(`[DirectCmd] ⚠️ Skipping single on-hold parser: "${nameGuess}" looks like a bulk/instruction phrase.`);
      return null;
    }

    let cand = null;
    if (!nameGuess || nameGuess.length < 2 || /^(her|him|she|he|them)$/i.test(nameGuess)) {
      cand = getLastDiscussedCandidate();
    }
    if (!cand && nameGuess.length >= 2) {
      const found = await resolveCandidateWithPronoun(nameGuess);
      if (found.ok) cand = found.data;
    }

    if (cand) {
      console.log(`[DirectCmd] ⏸️ ON HOLD: candidate="${cand.name}"`);
      await rateLimitedMcpWrite('update_candidate', {
        identifier: cand.id,
        updates: { lineup_status: 'On Hold' }
      }, waClient, { skipActivityLog: true });
      await rateLimitedMcpWrite('append_note', {
        identifier: cand.id,
        note: `On Hold — Shetty Saa`
      }, waClient, { skipActivityLog: true });

      setLastDiscussedCandidate(cand);

      await logAgentActivity(waClient, {
        action: 'On Hold Marked',
        category: 'RECRUTOS',
        candidateName: cand.name,
        candidatePhone: cand.phone,
        candidateId: cand.id,
        details: `Status set to On Hold in RecrutOS.`,
        source: 'Saa Trainer (On Hold Command)',
        notifyBoss: true,
      });

      return `⏸️ *On Hold — RecrutOS Updated*\n👤 *${cand.name}* status: On Hold\n_Updated live._`;
    }
  }

  // ── 6. FRESHER / EXPERIENCED (token-free button update) ───────────────────
  // "Shilpa fresher" | "Ganesh experienced" | "Mahesh 3 years exp" | "Priya 2yr experienced"
  const isFresherCmd = /\b(fresher|freshers|fresh)\b/i.test(lower);
  const isExperiencedCmd = /\b(experienced?|exp\b|experience)\b/i.test(lower) || /\d+\s*(yr|year|yrs|years)/.test(lower);

  if ((isFresherCmd || isExperiencedCmd) && !_isQuestion) {
    let nameGuess = t
      .replace(/fresher|freshers?|fresh|experienced?|exp\b|experience|\d+\s*(yr|year|yrs|years?)/gi, ' ')
      .replace(/mark|set|update|is|a|an|the/gi, ' ')
      .replace(/\s+/g, ' ').trim();

    const isBulkOrInstruction = /\b(all|sare|saare|sab|sabhi|every|everyone|everybody|candidates?|candid[a-z]+|kisi|team|group|who|had|was|were|change|align|shift|reschedule|them|these|those)\b/i.test(nameGuess);
    if (isBulkOrInstruction || nameGuess.length > 30) {
      console.log(`[DirectCmd] ⚠️ Skipping single experience parser: "${nameGuess}" looks like a bulk/instruction phrase.`);
      return null;
    }

    let cand = null;
    if (!nameGuess || nameGuess.length < 2 || /^(her|him|she|he|them)$/i.test(nameGuess)) {
      cand = getLastDiscussedCandidate();
    }
    if (!cand && nameGuess.length >= 2) {
      const found = await resolveCandidateWithPronoun(nameGuess);
      if (found.ok) cand = found.data;
    }

    if (cand) {
      const expLabel = isFresherCmd ? 'Fresher' : 'Experienced';

      // Extract years if mentioned (e.g. "2 years", "3yr")
      const yearsMatch = t.match(/(\d+(?:\.\d+)?)\s*(yr|year|yrs|years?)/i);
      const years = yearsMatch ? yearsMatch[1] : (isFresherCmd ? '0' : '');

      const updates = { experience: expLabel };
      if (years) updates.years = years;

      console.log(`[DirectCmd] 💼 EXPERIENCE: name="${cand.name}" → ${expLabel} (${years || '?'}y)`);

      await rateLimitedMcpWrite('update_candidate', {
        identifier: cand.id,
        updates
      }, waClient, { skipActivityLog: true });
      await rateLimitedMcpWrite('append_note', {
        identifier: cand.id,
        note: `Marked ${expLabel}${years ? ` (${years} yr)` : ''} by Shetty Saa`
      }, waClient, { skipActivityLog: true });

      setLastDiscussedCandidate(cand);

      await logAgentActivity(waClient, {
        action: 'Experience Updated',
        category: 'RECRUTOS',
        candidateName: cand.name,
        candidatePhone: cand.phone,
        candidateId: cand.id,
        details: `Experience set to ${expLabel}${years ? ` (${years} yrs)` : ''}. Zero tokens.`,
        source: 'Saa Trainer (Experience Command)',
        notifyBoss: true,
      });

      return `💼 *Updated — RecrutOS*\n👤 *${cand.name}* (📱 ${cand.phone})\n🏷️ Experience: *${expLabel}*${years ? ` | ${years} year(s)` : ''}\n_App buttons updated live. Zero tokens used._`;
    }
  }

  // ── 7. QUICK NOTE (token-free append) ─────────────────────────────────────
  // "Note Ganesh didn't pick up" | "Add note Shilpa wants night shift"
  const isNoteCmd = /^(note|add note|append note|jot|write)\s/i.test(lower.trim());
  if (isNoteCmd) {
    const withoutVerb = t.replace(/^(note|add note|append note|jot|write)\s+/i, '').trim();
    const noteMatch = withoutVerb.match(/^([A-Za-z\s]{2,25?}?)[\s\-–:]+(.+)$/);
    if (noteMatch) {
      let nameGuess = noteMatch[1].trim();
      const noteText  = noteMatch[2].trim();

      let cand = null;
      if (!nameGuess || nameGuess.length < 2 || /^(her|him|she|he|them)$/i.test(nameGuess)) {
        cand = getLastDiscussedCandidate();
      }
      if (!cand && nameGuess.length >= 2) {
        const found = await resolveCandidateWithPronoun(nameGuess);
        if (found.ok) cand = found.data;
      }

      if (cand && noteText.length >= 2) {
        console.log(`[DirectCmd] 📝 NOTE: "${cand.name}" → "${noteText}"`);
        await rateLimitedMcpWrite('append_note', {
          identifier: cand.id,
          note: `[Shetty Saa] ${noteText}`
        }, waClient, { skipActivityLog: true });

        setLastDiscussedCandidate(cand);

        await logAgentActivity(waClient, {
          action: 'Quick Note Added',
          category: 'NOTE',
          candidateName: cand.name,
          candidatePhone: cand.phone,
          candidateId: cand.id,
          details: noteText,
          source: 'Saa Trainer (Note Command)',
          notifyBoss: true,
        });

        return `📝 *Note Added — RecrutOS*\n👤 *${cand.name}*\n💬 "${noteText}"\n_Saved live. Zero tokens._`;
      }
    }
  }

  // ── 8. ADD / SAVE CANDIDATE MANUALLY ──────────────────────────────────────
  // e.g. "Save this number as priyanka jaiswar 81046 85012\n\nResides in Thane"
  // or "add candidate: Ganesh Kumar, 9876543210, Malad, 2 years, Voice, 25000, Graduate, Good"
  // or "create candidate Ganesh Kumar 9876543210 Malad Voice 25k"
  const isSaveCandidateCmd =
    /^(?:add|create|new|save)\s+(?:candidate|this\s+number|number|contact)?[:\s]/i.test(lower) ||
    /\bsave\s+(?:this\s+)?(?:number|contact|candidate)?\s*as\b/i.test(lower);

  if (isSaveCandidateCmd) {
    let rawData = t.replace(/^(?:add|create|new|save)\s+(?:candidate|this\s+number|number|contact)?[:\s]+/i, '').trim();
    rawData = rawData.replace(/^this\s+number\s+as\s+/i, '').replace(/^as\s+/i, '').trim();

    // Extract phone — handles 10 digits with or without spaces/country code
    const phoneMatch = rawData.match(/(?:(?:\+?91[\s\-]*)?[6-9]\d{4}[\s\-]*\d{5}|[6-9]\d{9})/);
    if (!phoneMatch) {
      return `⚠️ Please provide a valid 10-digit mobile number for the candidate.\n\n*Format:* Save this number as [Name] [Phone] [Location]\n*Example:* Save this number as Priyanka Jaiswar 81046 85012\nResides in Thane`;
    }
    const candPhone = phoneMatch[0].replace(/\D/g, '').slice(-10);

    // Extract name
    let candName = '';
    const parts = rawData.includes(',') ? rawData.split(',').map(p => p.trim()) : rawData.split(/\s+/);

    if (rawData.includes(',')) {
      candName = parts[0].trim();
    } else {
      const beforePhone = rawData.split(phoneMatch[0])[0].trim();
      candName = beforePhone || '';
    }
    candName = candName
      .replace(/\b(add|candidate|create|save|this|number|as|contact)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim() || 'New Candidate';

    // Capitalize candidate name
    candName = candName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

    let candLoc = 'Mumbai';
    let candExp = 'Fresher';
    let candYears = '0';
    let candProcess = 'Voice';
    let candSalary = '';
    let candQual = 'Graduate';
    let candComm = 'Good';

    // Extract location (e.g. "Resides in Thane", "from Malad", "in Thane")
    const residesMatch = rawData.match(/(?:resides?\s+in|location[:\s]+|lives?\s+in|from|at)\s+([a-zA-Z\s]{3,20})/i);
    if (residesMatch) {
      candLoc = residesMatch[1].trim();
    }

    if (rawData.includes(',') && parts.length >= 3) {
      candLoc = parts[2] || candLoc;
      if (parts[3]) {
        candExp = parts[3];
        const yMatch = parts[3].match(/\d+/);
        if (yMatch) candYears = yMatch[0];
      }
      if (parts[4]) candProcess = parts[4];
      if (parts[5]) candSalary = parts[5].replace(/\D/g, '');
      if (parts[6]) candQual = parts[6];
      if (parts[7]) candComm = parts[7];
    } else {
      const rest = rawData.replace(phoneMatch[0], '');
      const harvested = extractAllProfileFields(rest);
      if (harvested.location && !residesMatch) candLoc = harvested.location;
      if (harvested.experience) {
        candExp = harvested.experience;
        candYears = harvested.years || '0';
      }
      if (harvested.process) candProcess = harvested.process;
      if (harvested.salary) candSalary = harvested.salary;
      if (harvested.qualification) candQual = harvested.qualification;
      if (harvested.comm_level) candComm = harvested.comm_level;
    }

    const newProfile = {
      name: candName,
      phone: candPhone,
      location: candLoc,
      experience: candExp,
      years: candYears,
      process: candProcess,
      inhand_salary: candSalary,
      qualification: candQual,
      comm_level: candComm,
      is_trash: false,
      notes: `[Manual Entry by Shetty Saa on ${todayStr}] Added directly via WhatsApp.`
    };

    const addRes = await rateLimitedMcpWrite('add_candidate', newProfile, waClient);
    if (!addRes.ok) return `❌ Could not add candidate: ${addRes.error}`;

    const savedCand = addRes.data || newProfile;
    setLastDiscussedCandidate(savedCand);

    // Auto-save WhatsApp contact with candy emoji tag
    try {
      const { saveCandidateContact } = await import('./contact_saver.js');
      await saveCandidateContact(waClient, newProfile);
    } catch (_) {}

    await logAgentActivity(waClient, {
      action: 'Candidate Added Manually',
      category: 'RECRUTOS',
      candidateName: candName,
      candidatePhone: candPhone,
      candidateId: savedCand.id,
      details: `Added via WhatsApp: Loc=${candLoc}, Exp=${candExp}, Process=${candProcess}, Salary=${candSalary || 'N/A'}`,
      source: 'Saa Trainer (Add Candidate)',
      notifyBoss: true
    });

    return `✅ *Candidate Saved in RecrutOS!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *${candName}* (📱 ${candPhone})\n` +
      `📍 Location: ${candLoc} | 💼 ${candExp} (${candYears}y)\n` +
      `🎯 Process: ${candProcess} | 💰 Salary: ₹${candSalary || 'N/A'}\n` +
      `🗣️ Comm: ${candComm} | 🎓 Qual: ${candQual}\n\n` +
      `📇 Saved to WhatsApp contacts with 🍭 tag.\n` +
      `_Profile is live in RecrutOS. Context active for follow-ups._ 🚀`;
  }

  // ── 9. SET / UPDATE CANDIDATE FIELD ───────────────────────────────────────
  // e.g. "set Ganesh salary 28000", "update Ganesh location Kandivali", "set Ganesh process Chat"
  const setMatch = t.match(/^(?:set|update)\s+([a-zA-Z0-9\+\s]{2,30}?)\s+(salary|inhand|location|loc|process|qualification|qual|education|comm|comm_level|english|company|last_company|prior|phone|mobile)\s+(.+)$/i);
  if (setMatch) {
    const candIdent = setMatch[1].trim();
    const rawField = setMatch[2].toLowerCase().trim();
    const rawVal = setMatch[3].trim();

    const found = await resolveCandidateWithPronoun(candIdent);
    if (!found.ok) return `⚠️ Candidate "*${candIdent}*" not found in RecrutOS.`;
    const cand = found.data;

    let fieldKey = '';
    let valClean = rawVal;

    if (rawField === 'salary' || rawField === 'inhand') {
      fieldKey = 'inhand_salary';
      if (rawVal.toLowerCase().endsWith('k')) {
        const num = parseFloat(rawVal);
        valClean = !isNaN(num) ? String(Math.round(num * 1000)) : rawVal.replace(/\D/g, '');
      } else {
        valClean = rawVal.replace(/\D/g, '');
      }
    } else if (rawField === 'location' || rawField === 'loc') {
      fieldKey = 'location';
    } else if (rawField === 'process') {
      fieldKey = 'process';
    } else if (rawField === 'qualification' || rawField === 'qual' || rawField === 'education') {
      fieldKey = 'qualification';
    } else if (rawField === 'comm' || rawField === 'comm_level' || rawField === 'english') {
      fieldKey = 'comm_level';
    } else if (rawField === 'company' || rawField === 'last_company' || rawField === 'prior') {
      fieldKey = 'last_company';
    } else if (rawField === 'phone' || rawField === 'mobile') {
      fieldKey = 'phone';
      valClean = rawVal.replace(/\D/g, '').slice(-10);
    }

    if (fieldKey) {
      const upd = await rateLimitedMcpWrite('update_candidate', {
        identifier: cand.id,
        updates: { [fieldKey]: valClean }
      }, waClient, { skipActivityLog: true });

      await rateLimitedMcpWrite('append_note', {
        identifier: cand.id,
        note: `Updated ${fieldKey} to "${valClean}" by Shetty Saa`
      }, waClient, { skipActivityLog: true });

      setLastDiscussedCandidate(cand);

      if (!upd.ok) return `❌ Update failed for *${cand.name}*: ${upd.error}`;

      await logAgentActivity(waClient, {
        action: 'Candidate Field Updated',
        category: 'RECRUTOS',
        candidateName: cand.name,
        candidatePhone: cand.phone,
        candidateId: cand.id,
        details: `Updated ${fieldKey} → "${valClean}"`,
        source: 'Saa Trainer (Set Field)',
        notifyBoss: true
      });

      return `✏️ *Updated ${cand.name} in RecrutOS!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 *${cand.name}* (📱 ${cand.phone})\n` +
        `🔖 Field *${fieldKey}* updated to: *${valClean}*\n\n` +
        `_Live in RecrutOS Supabase._ ✅`;
    }
  }

  // ── 10. RESCHEDULE CANDIDATE ──────────────────────────────────────────────
  // e.g. "reschedule Ganesh to tomorrow", "reschedule Rahul to Monday", "move interview of Priya to 10 Oct"
  const reschedMatch = t.match(/^(?:reschedule|change\s+interview\s+(?:date\s+)?(?:of\s+|for\s+)?|move\s+interview\s+(?:of\s+|for\s+)?)\s*([a-zA-Z0-9\+\s]{2,30}?)\s+(?:to|for|on)\s+(.+)$/i);
  if (reschedMatch) {
    const candIdent = reschedMatch[1].trim();
    const dateInput = reschedMatch[2].trim();
    const resolvedDate = resolveDate(dateInput, todayStr) || dateInput;

    const found = await resolveCandidateWithPronoun(candIdent);
    if (!found.ok) return `⚠️ Candidate "*${candIdent}*" not found in RecrutOS.`;
    const cand = found.data;

    const upd = await rateLimitedMcpWrite('update_candidate', {
      identifier: cand.id,
      updates: { lineup_status: 'Yes', interview_date: resolvedDate }
    }, waClient, { skipActivityLog: true });

    await rateLimitedMcpWrite('append_note', {
      identifier: cand.id,
      note: `Interview rescheduled to ${resolvedDate} by Shetty Saa`
    }, waClient, { skipActivityLog: true });

    setLastDiscussedCandidate(cand);

    if (!upd.ok) return `❌ Reschedule failed: ${upd.error}`;

    const displayDate = formatDisplayDate(resolvedDate);

    await logAgentActivity(waClient, {
      action: 'Interview Rescheduled',
      category: 'RECRUTOS',
      candidateName: cand.name,
      candidatePhone: cand.phone,
      candidateId: cand.id,
      details: `Interview rescheduled to ${displayDate}`,
      source: 'Saa Trainer (Reschedule)',
      notifyBoss: true
    });

    return `📅 *Interview Rescheduled!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *${cand.name}* (📱 ${cand.phone})\n` +
      `🗓️ New Interview Date: *${displayDate}*\n` +
      `🔖 Lineup Status: *Yes*\n\n` +
      `_Updated live in RecrutOS. Say "Send venue to ${cand.name}" to share office address._ 🏢`;
  }

  // ── 11. SEND VENUE / OFFICE ADDRESS TO CANDIDATE ───────────────────────────
  // e.g. "send venue to Ganesh", "send address to 9820123456", "share venue with Rahul"
  const venueMatch = t.match(/^(?:send|share)\s+(?:venue|office\s*address|address|screening\s*location)\s+(?:to|with)\s+([a-zA-Z0-9\+\s]{2,30})$/i);
  if (venueMatch) {
    const candIdent = venueMatch[1].trim();
    const found = await resolveCandidateWithPronoun(candIdent);
    if (!found.ok) return `⚠️ Candidate "*${candIdent}*" not found in RecrutOS.`;
    const cand = found.data;

    setLastDiscussedCandidate(cand);

    const firstName = (cand.name || 'there').split(' ')[0];
    const venueText =
      `Hi ${firstName}! 👋 Greetings from *Shetty Productions / RecrutOS HR Team*.\n\n` +
      `Here are your official interview & screening details:\n\n` +
      `🏢 *Office Address:*\n` +
      `*Shetty Productions*\n` +
      `Office 827, 8th Floor, Ijmima Tower,\n` +
      `Interface, Mindspace, Behind Infiniti Mall,\n` +
      `Malad West, Mumbai - 400064. 📍\n\n` +
      `📞 *HR Contact:* +91 8080635121\n` +
      `⏰ *Office Hours:* Monday to Saturday, 11:30 AM to 8:30 PM\n\n` +
      `📋 *Mandatory Documents to Carry:*\n` +
      `• 2 copies of your updated resume / CV\n` +
      `• Original Aadhaar Card + 1 photocopy\n` +
      `• Last 3 months' salary slips & bank statement (if experienced)\n` +
      `• 1 passport size photograph\n\n` +
      `_Please reach 15 minutes before your slot. All the best!_ 🌟`;

    const phone = (cand.phone || '').replace(/\D/g, '');
    const waId = phone.startsWith('91') ? `${phone}@c.us` : `91${phone}@c.us`;

    let sent = false;
    if (waClient && phone) {
      try {
        await waClient.sendMessage(waId, venueText);
        sent = true;
      } catch (err) {
        console.error('[SaaTrainer] Error sending venue:', err.message);
      }
    }

    await rateLimitedMcpWrite('append_note', {
      identifier: cand.id,
      note: `Screening venue address sent via WhatsApp by Shetty Saa on ${todayStr}`
    }, waClient, { skipActivityLog: true });

    await logAgentActivity(waClient, {
      action: 'Venue Address Sent',
      category: 'WHATSAPP',
      candidateName: cand.name,
      candidatePhone: cand.phone,
      candidateId: cand.id,
      details: 'Official Malad screening office venue details sent via WhatsApp',
      source: 'Saa Trainer (Send Venue)',
      notifyBoss: true
    });

    return `🏢 *Venue Details ${sent ? 'Sent' : 'Dispatched'} to Candidate!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *${cand.name}* (📱 ${cand.phone})\n` +
      `📍 Office: 827, 8th floor, Ijmima Tower, Mindspace, Malad West\n` +
      `📞 HR Contact: +91 8080635121\n\n` +
      `_Note auto-appended to candidate in RecrutOS._ ✅`;
  }

  // ── 12. TRASH / SOFT-DELETE CANDIDATE ──────────────────────────────────────
  // e.g. "trash candidate Ganesh", "delete candidate Rahul", "trash 9820123456"
  const trashMatch = t.match(/^(?:trash|delete)\s+(?:candidate\s+)?([a-zA-Z0-9\+\s]{2,30})$/i);
  if (trashMatch && !/lineup|interview|resume|all/i.test(trashMatch[1])) {
    const candIdent = trashMatch[1].trim();
    const found = await resolveCandidateWithPronoun(candIdent);
    if (!found.ok) return `⚠️ Candidate "*${candIdent}*" not found in RecrutOS.`;
    const cand = found.data;

    const trashRes = await rateLimitedMcpWrite('trash_candidate', { identifier: cand.id }, waClient);
    if (!trashRes.ok) return `⚠️ ${trashRes.error}`;

    await logAgentActivity(waClient, {
      action: 'Candidate Moved to Trash',
      category: 'RECRUTOS',
      candidateName: cand.name,
      candidatePhone: cand.phone,
      candidateId: cand.id,
      details: `Candidate moved to trash by Shetty Saa.`,
      source: 'Saa Trainer (Trash Candidate)',
      notifyBoss: true
    });

    return `🗑️ *Candidate Moved to Trash!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 Candidate: *${cand.name}* (📱 ${cand.phone})\n` +
      `_Soft-deleted from active RecrutOS views (is_trash = true). Can be restored from Supabase if needed._`;
  }

  // ── 13. BLACKLIST / BLOCK CANDIDATE ───────────────────────────────────────
  // e.g. "blacklist Ganesh rude behavior", "block Rahul fake documents"
  const blMatch = t.match(/^(?:blacklist|block)\s+(?:candidate\s+)?([a-zA-Z0-9\+\s]{2,30}?)(?:\s+(?:for|because|reason\s*:?)\s*(.+))?$/i);
  if (blMatch) {
    const candIdent = blMatch[1].trim();
    const reason = blMatch[2]?.trim() || 'Blacklisted by Shetty Saa';

    const found = await resolveCandidateWithPronoun(candIdent);
    if (!found.ok) return `⚠️ Candidate "*${candIdent}*" not found in RecrutOS.`;
    const cand = found.data;

    // Add to DND
    if (cand.phone) addToDnd(cand.phone);

    // Update status & notes
    await rateLimitedMcpWrite('update_candidate', {
      identifier: cand.id,
      updates: { joined_status: 'Blacklisted', lineup_status: 'No' }
    }, waClient, { skipActivityLog: true });

    await rateLimitedMcpWrite('append_note', {
      identifier: cand.id,
      note: `🚫 [BLACKLISTED by Shetty Saa on ${todayStr}]: "${reason}"`
    }, waClient, { skipActivityLog: true });

    setLastDiscussedCandidate(cand);

    await logAgentActivity(waClient, {
      action: 'Candidate Blacklisted',
      category: 'RECRUTOS',
      candidateName: cand.name,
      candidatePhone: cand.phone,
      candidateId: cand.id,
      details: `Blacklisted & added to DND. Reason: ${reason}`,
      source: 'Saa Trainer (Blacklist)',
      notifyBoss: true
    });

    return `🚫 *Candidate Blacklisted & Muted!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *${cand.name}* (📱 ${cand.phone})\n` +
      `⛔ Status: *Blacklisted*\n` +
      `🔕 Added to DND: Bot will never reply or message this number.\n` +
      `📝 Reason: "${reason}"\n\n` +
      `_RecrutOS Supabase updated live._`;
  }

  // ── 14. PIPELINE SUMMARY / STATS ──────────────────────────────────────────
  if (/^(?:pipeline\s*summary|stats|dashboard|counts?|recrutos\s*summary)$/i.test(lower)) {
    const statsRes = await callMCPTool('get_pipeline_stats', {});
    if (!statsRes.ok) return `⚠️ Could not fetch stats: ${statsRes.error}`;
    const s = statsRes.data;

    return `📊 *RecrutOS Pipeline Intelligence Dashboard*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👥 Total Active Candidates: *${s.total_active_candidates}*\n` +
      `📅 In Lineup: *${s.in_lineup}*\n` +
      `🎯 Scheduled for Today (${formatDisplayDate(todayStr)}): *${s.scheduled_for_today}*\n` +
      `✅ Successfully Joined: *${s.joined}*\n` +
      `⏳ Overdue Lineups: *${s.overdue_lineups}*\n` +
      `🔔 Open Reminders: *${s.pending_reminders_count}*\n` +
      `🗑️ Trash Count: *${s.in_trash_count}*\n\n` +
      `_Live 1:1 sync with RecrutOS Supabase._ 🚀`;
  }

  // ── 15. VIEW REMINDERS & TASKS ─────────────────────────────────────────────
  if (/^(?:reminders?|tasks?|pending\s*reminders?|followups?|pending\s*tasks?)$/i.test(lower)) {
    const remRes = await callMCPTool('get_pending_reminders', {});
    const folRes = await callMCPTool('get_pending_followups', {});

    const reminders = remRes.ok ? remRes.data : [];
    const followups = folRes.ok ? folRes.data : [];

    if (reminders.length === 0 && followups.length === 0) {
      return `⏰ *No pending reminders or tasks for today!* All clear in RecrutOS. 👍`;
    }

    const lines = [];
    if (reminders.length > 0) {
      lines.push(`🔔 *Pending Reminders (${reminders.length}):*`);
      reminders.slice(0, 10).forEach((r, idx) => {
        lines.push(`${idx + 1}. *${r.candidate_name || 'Candidate'}* (📱 ${r.candidate_phone || 'N/A'})\n   📅 ${r.reminder_date || 'Today'} ${r.reminder_time || ''} | 📝 ${r.note || 'Reminder'}`);
      });
      lines.push('');
    }

    if (followups.length > 0) {
      lines.push(`📋 *Pending Followups (${followups.length}):*`);
      followups.slice(0, 10).forEach((f, idx) => {
        lines.push(`${idx + 1}. *${f.candidate_name || 'Candidate'}* (📱 ${f.candidate_phone || 'N/A'})\n   📅 ${f.followup_date || 'Upcoming'} | 📝 ${f.note || 'Followup'}`);
      });
    }

    lines.push(`\n💡 _Reply "done reminder <candidate>" to mark complete._`);
    return lines.join('\n');
  }

  // ── 16. DONE / COMPLETE REMINDER ──────────────────────────────────────────
  const doneRemMatch = t.match(/^(?:done|complete|finish)\s+reminder\s+(?:for\s+)?([a-zA-Z0-9\+\s]{2,30})$/i);
  if (doneRemMatch) {
    const candIdent = doneRemMatch[1].trim();
    const doneRes = await rateLimitedMcpWrite('mark_reminder_done', { identifier: candIdent }, waClient);
    if (!doneRes.ok) return `⚠️ ${doneRes.error}`;

    return `✅ *Reminder Completed!*\n━━━━━━━━━━━━━━━━━━━━━━\nReminder for *${candIdent}* marked as done in RecrutOS Supabase. 👍`;
  }

  // ── 17. CANDIDATE PROFILE CARD ────────────────────────────────────────────
  const profMatch = t.match(/^(?:candidate|profile|details\s+of|info\s+of|show\s+profile)\s+([a-zA-Z0-9\+\s]{2,30})$/i);
  if (profMatch && !/lineup|interview|recent|all/i.test(profMatch[1])) {
    const candIdent = profMatch[1].trim();
    const found = await resolveCandidateWithPronoun(candIdent);
    if (!found.ok) return `⚠️ Candidate "*${candIdent}*" not found in RecrutOS.`;
    const c = found.data;

    setLastDiscussedCandidate(c);

    return `👤 *Candidate Profile — ${c.name}*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📱 Phone: *${c.phone || 'N/A'}*\n` +
      `📍 Location: *${c.location || 'Mumbai'}*\n` +
      `💼 Experience: *${c.experience || 'Fresher'}* ${c.years ? `(${c.years} yr)` : ''}\n` +
      `🎯 Process: *${c.process || 'Voice'}*\n` +
      `💰 Salary: *₹${c.inhand_salary || 'N/A'}/mo*\n` +
      `🗣️ English: *${c.comm_level || 'N/A'}*\n` +
      `🎓 Education: *${c.qualification || 'Graduate'}*\n` +
      `🏢 Last Company: *${c.last_company || 'N/A'}*\n` +
      `📅 Lineup: *${c.lineup_status === 'Yes' ? `✅ Lined Up (${formatDisplayDate(c.interview_date || '')})` : 'No'}*\n` +
      `🎉 Joined: *${c.joined_status === 'Joined' || c.joined_status === 'Yes' ? '✅ Joined' : 'No'}*\n\n` +
      `📝 *Latest Notes:*\n${(c.notes || 'No notes').split('\n').slice(0, 4).join('\n')}\n\n` +
      `💡 *Quick Actions:* "Send venue to ${c.name}" | "Set ${c.name} salary 30k" | "Reschedule ${c.name} to Monday"`;
  }

  return null; // not a direct command — let Gemini function calling handle it
}

export async function handleTrainerChatMessage(text, waClient = null, context = {}) {

  let intent = classifyIntent(text);
  if (intent === 'general') {
    try {
      const laya = await decideLaya(text, 'What is the intent of the recruiter command?', [
        'pipeline_query', 'search', 'greeting', 'general'
      ]);
      if (laya && laya.confidence >= 0.70 && laya.answer !== 'general') {
        intent = laya.answer;
        console.log(`⚡ [LayaIntent] Fast-routed intent: "${intent}" (${(laya.confidence * 100).toFixed(0)}% confidence, ${laya.latency_ms.toFixed(0)}ms)`);
      }
    } catch (_) {}
  }
  const filters = extractFilters(text);
  const todayStr = getISTDateString(0);
  const ts = getISTTimeString();

  console.log(`🧠 [SaaTrainer] Intent: ${intent} | Filters: ${JSON.stringify(filters)} | Text: "${text.slice(0, 70)}"`);

  // ── FAST PRE-PARSER (FIRST CHECK) — runs before ALL intent handlers ───────────
  // Lineup / joined / no-show / dropout / on-hold commands bypass everything.
  // Zero API cost, instant, 100% reliable regex matching on real boss phrases.
  const directResult = await parseDirectCommand(text, todayStr, waClient);
  if (directResult !== null) return directResult;

  // ── 0. BOSS GREETINGS ("Hi", "How are you") ──────────────────────────────
  if (intent === 'greeting') {
    return `Hello Shetty Saa! 👋 Saa is active and connected live to RecrutOS.\n\n` +
      `How can I assist you right now?\n` +
      `• Ask *"What is the update?"* for today's interview lineup\n` +
      `• Ask *"What are the new resumes?"* to check newly synced CVs\n` +
      `• Say *"Msg Abdul to be available"* to text a candidate\n` +
      `• Say *"Stop replying Abdul"* or *"Don't msg Ganesh"* to pause outreach`;
  }

  // ── A. MUTE / PAUSE / BLACKLIST CANDIDATE OUTREACH ────────────────────────
  if (intent === 'mute_candidate') {
    const isBlacklist = /blacklist|block/i.test(text);
    let rawName = extractCleanCandidateName(text);

    let reason = text.replace(/^(?:don+t?|don.?t|do\s+not|stop|pause|mute|blacklist|block)\s+(?:replying|reply|messaging|texting|msg|message|text|whatsapp|contacting|calling)?\s*(?:to\s+)?[a-zA-Z0-9\+\s]+/i, '').trim();
    if (!reason || reason.length < 3) {
      reason = isBlacklist ? 'Candidate blacklisted by Shetty Saa.' : 'Candidate is in direct personal communication with Shetty Saa.';
    }

    let candidate = null;
    let targetPhone = null;
    let targetName = null;

    // 0. Extract explicit 10-digit Indian phone number directly from text or rawName
    const directPhoneMatch = text.match(/(?:\+?91[\s-]?)?([6-9]\d{9})\b/) || rawName.match(/\b([6-9]\d{9})\b/);
    if (directPhoneMatch) {
      targetPhone = directPhoneMatch[1];
      candidate = await findCandidateByNameOrPhone(targetPhone);
      if (candidate) targetName = candidate.name;
    }

    // 1. Check if rawName is a pronoun or empty ONLY IF no phone number was found
    if (!targetPhone) {
      const isPronoun = /^(her|him|she|he|them|they|this candidate|that candidate)$/i.test(rawName);
      if (isPronoun || !rawName || rawName.length < 2) {
        const last = getLastDiscussedCandidate();
        if (last && (last.id || last.phone)) {
          candidate = last;
          targetPhone = candidate.phone;
          targetName = candidate.name;
          console.log(`[SaaTrainer] 🔇 Mute pronoun resolved to last discussed candidate: "${targetName}" (${targetPhone})`);
        }
      }
    }

    // 2. Check if rawName is a 10-digit phone
    if (!candidate && !targetPhone && rawName) {
      const rawDigits = rawName.replace(/\D/g, '').slice(-10);
      if (rawDigits.length === 10) {
        targetPhone = rawDigits;
        candidate = await findCandidateByNameOrPhone(targetPhone);
        if (candidate) targetName = candidate.name;
      }
    }

    // 3. Search Supabase by name & fuzzy match
    if (!candidate && !targetPhone && rawName && rawName.length >= 2) {
      candidate = await findCandidateByNameOrPhone(rawName);
      if (!candidate) candidate = await fuzzyFindCandidate(rawName);
      if (candidate) {
        targetPhone = candidate.phone;
        targetName = candidate.name;
      }
    }

    // 4. Search WhatsApp chats ONLY if rawName has at least 3 letters and is not a stopword
    if (!candidate && !targetPhone && waClient && rawName && rawName.length >= 3 && !/^(the|and|for|him|her|them|that|this)$/i.test(rawName)) {
      try {
        const chats = await waClient.getChats();
        for (const ch of chats) {
          const cName = ch.name || '';
          if (cName.length >= 3 && cName.toLowerCase().includes(rawName.toLowerCase())) {
            targetPhone = ch.id?.user || (ch.id?._serialized || '').replace('@c.us', '');
            targetName = cName;
            break;
          }
        }
      } catch (_) {}
    }

    if (targetPhone) {
      const cleanPhone = targetPhone.replace(/\D/g, '').slice(-10);
      addToDnd(cleanPhone);
      protectContact(cleanPhone, targetName || 'Candidate', reason);

      const client = getClient();
      if (client) {
        try {
          const updatePayload = { updated_at: new Date().toISOString() };
          if (isBlacklist) updatePayload.is_trash = true;
          await client.from('ros_candidates')
            .update(updatePayload)
            .or(`phone.eq.${cleanPhone},phone.eq.91${cleanPhone}`);
        } catch (_) {}
      }

      await appendCandidateNote(cleanPhone, `[${isBlacklist ? 'Blacklisted' : 'Muted'} by Shetty Saa] Outreach paused. Reason: ${reason}`);

      return `🔇 *${isBlacklist ? 'Blacklisted & Silenced' : 'Outreach Paused'} for ${targetName || cleanPhone}!*\n\n` +
        `📱 Phone: ${cleanPhone}\n` +
        `🚫 *Action Taken:* Added to DND & Protected Contacts. Bot and Scheduler will NEVER message, ping, or reply to this number.\n` +
        `${isBlacklist ? '🗑️ RecrutOS candidate marked as blacklisted / trashed.\n' : ''}` +
        `📝 *RecrutOS Note Saved:* "${reason}"\n` +
        `🔒 Stored in memory until you explicitly say *"resume messaging ${targetName || cleanPhone}"*.`;
    } else {
      return `⚠️ Couldn't identify candidate "*${rawName || 'specified'}*" in RecrutOS or active WhatsApp chats.\n\n` +
        `Please provide their phone number or check spelling so I can pause outreach accurately without muting the wrong person! 👍`;
    }
  }

  // ── A2. UNMUTE / RESUME CANDIDATE OUTREACH ──────────────────────────────────
  if (intent === 'unmute_candidate') {
    let rawName = extractCleanCandidateName(text);
    rawName = rawName.replace(/\b(please|kindly|now)\b.*/i, '').trim();

    let candidate = null;
    let targetPhone = null;
    let targetName = null;

    // 0. Extract explicit 10-digit Indian phone number directly from text or rawName
    const directPhoneMatch = text.match(/(?:\+?91[\s-]?)?([6-9]\d{9})\b/) || rawName.match(/\b([6-9]\d{9})\b/);
    if (directPhoneMatch) {
      targetPhone = directPhoneMatch[1];
      candidate = await findCandidateByNameOrPhone(targetPhone);
      if (candidate) targetName = candidate.name;
    }

    // 1. Check if rawName is a pronoun or empty ONLY IF no phone number was found
    if (!targetPhone) {
      const isPronoun = /^(her|him|she|he|them|they|this candidate|that candidate)$/i.test(rawName);
      if (isPronoun || !rawName || rawName.length < 2) {
        const last = getLastDiscussedCandidate();
        if (last && (last.id || last.phone)) {
          candidate = last;
          targetPhone = candidate.phone;
          targetName = candidate.name;
        }
      }
    }

    if (!candidate && !targetPhone && rawName) {
      const rawDigits = rawName.replace(/\D/g, '').slice(-10);
      if (rawDigits.length === 10) {
        targetPhone = rawDigits;
        candidate = await findCandidateByNameOrPhone(targetPhone);
        if (candidate) targetName = candidate.name;
      }
    }

    if (!candidate && !targetPhone && rawName && rawName.length >= 2) {
      candidate = await findCandidateByNameOrPhone(rawName);
      if (!candidate) candidate = await fuzzyFindCandidate(rawName);
      if (candidate) {
        targetPhone = candidate.phone;
        targetName = candidate.name;
      }
    }

    if (!candidate && !targetPhone && waClient && rawName && rawName.length >= 3 && !/^(the|and|for|him|her|them)$/i.test(rawName)) {
      try {
        const chats = await waClient.getChats();
        for (const ch of chats) {
          const cName = ch.name || '';
          if (cName.length >= 3 && cName.toLowerCase().includes(rawName.toLowerCase())) {
            targetPhone = ch.id?.user || (ch.id?._serialized || '').replace('@c.us', '');
            targetName = cName;
            break;
          }
        }
      } catch (_) {}
    }

    if (targetPhone) {
      const cleanPhone = targetPhone.replace(/\D/g, '').slice(-10);
      removeFromDnd(cleanPhone);
      unprotectContact(cleanPhone);

      const client = getClient();
      if (client) {
        try {
          await client.from('ros_candidates')
            .update({ is_trash: false, updated_at: new Date().toISOString() })
            .or(`phone.eq.${cleanPhone},phone.eq.91${cleanPhone}`);
        } catch (_) {}
      }

      await appendCandidateNote(cleanPhone, `[Unmuted by Shetty Saa] Outreach resumed.`);

      return `🔔 *Outreach Resumed for ${targetName || cleanPhone}!*\n\n` +
        `📱 Phone: ${cleanPhone}\n` +
        `✅ *Action Taken:* Removed from DND and Protected Contacts. Bot is now active and ready to assist this candidate.\n` +
        `📝 RecrutOS profile restored.`;
    } else {
      return `⚠️ Couldn't find candidate "*${rawName || 'specified'}*" in RecrutOS or active WhatsApp chats.\n\nPlease provide their phone number to resume outreach.`;
    }
  }

  // ── B. LINEUP AVAILABILITY CHECK ──────────────────────────────────────────
  if (intent === 'lineup_availability_check') {
    let candidates = await getInterviewCandidates(todayStr);

    // Fallback: If no candidate has interview_date = todayStr, check confirmed upcoming lineups
    if (!candidates || candidates.length === 0) {
      const client = getClient();
      if (client) {
        try {
          const { data } = await client.from('ros_candidates')
            .select('id, name, phone, process, location, experience, years, inhand_salary, comm_level, interview_date, lineup_status, notes, last_company, companies_json, updated_at')
            .or('is_trash.is.null,is_trash.eq.false')
            .eq('lineup_status', 'Yes')
            .gte('interview_date', todayStr)
            .order('interview_date', { ascending: true })
            .limit(10);
          if (data && data.length > 0) {
            candidates = data;
          }
        } catch (_) {}
      }
    }

    if (!candidates || candidates.length === 0) {
      return `📋 *Lineup Availability Check — ${formatDisplayDate(todayStr)}*\n\nNo candidates are currently scheduled with active lineup dates in RecrutOS.\n\n💡 You can say *"show recent resumes"* to inspect new candidate profiles, or *"lineup <name> today <company>"* to align someone.`;
    }

    let sentCount = 0;
    const cards = [];

    for (const c of candidates) {
      const phone = (c.phone || '').replace(/\D/g, '');
      const firstName = (c.name || 'there').trim().split(' ')[0];
      const dateDesc = c.interview_date === todayStr ? 'today' : `on ${formatDisplayDate(c.interview_date)}`;
      const checkMsg = `Good morning ${firstName}! 👋 This is Saa from HR team.\n\nChecking in for your interview lineup scheduled ${dateDesc}. Are you ready and available? Please confirm your availability so we can coordinate your interview slot. 👍`;

      let sent = false;
      if (waClient && phone) {
        try {
          const waId = phone.startsWith('91') ? `${phone}@c.us` : `91${phone}@c.us`;
          await waClient.sendMessage(waId, checkMsg);
          sent = true;
          sentCount++;
          await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
        } catch (err) {
          console.error(`[SaaTrainer] Error sending availability check to ${c.name}:`, err.message);
        }
      }

      await appendCandidateNote(c.phone, `[Availability Check Sent]: "${checkMsg.slice(0, 60)}..."`);
      cards.push(`• *${c.name}* (📱 ${c.phone}) — ${c.process || 'Voice'}${sent ? ' ✅ Sent' : ' 📝 Logged'}`);
    }

    return `📋 *Lineup Availability Check Dispatched!*\n━━━━━━━━━━━━━━━━━━━━━━\nBoss, contacted *${sentCount || candidates.length} candidate(s)*:\n\n${cards.join('\n')}\n\n📝 All notes and statuses updated in RecrutOS Supabase.\n⚡ When any candidate responds, I will notify you here immediately! 🚀`;
  }

  // ── C. ASK JOINING CANDIDATE ("ask pragati if she can join today") ────────
  if (intent === 'ask_joining_candidate') {
    const m = text.match(/(?:ask|check\s+with|tell|inquire)\s+([a-zA-Z0-9\+\s]+?)\s+(?:if\s+she\s+can\s+join|if\s+he\s+can\s+join|can\s+she\s+join|can\s+he\s+join|can\s+join|joining\s+today|about\s+joining|to\s+join)(.*)/i);
    let targetRaw = m ? m[1].trim() : '';
    let embeddedPhone = '';
    const phoneMatch = targetRaw.match(/\b([6-9]\d{9})\b/) || text.match(/\b([6-9]\d{9})\b/);
    if (phoneMatch) {
      embeddedPhone = phoneMatch[1];
      targetRaw = targetRaw.replace(embeddedPhone, '').trim();
    }
    let targetName = targetRaw || (embeddedPhone ? 'Candidate' : '');

    let candidate = await findCandidateByNameOrPhone(embeddedPhone || targetName);

    // If candidate not found but phone was given, create candidate record!
    if (!candidate && embeddedPhone) {
      const newCandData = {
        name: targetName || 'Candidate',
        phone: embeddedPhone,
        process: 'Voice',
        notes: `[Shetty Saa Request] Candidate joining inquiry initiated via Shetty Office chat.`
      };
      const created = await addCandidateToRecrutOS(newCandData);
      if (created.success) {
        candidate = created.data;
      }
    }

    if (!candidate) {
      return `🔍 *RecrutOS Check:* No candidate profile found for "*${targetName}*" in Supabase.\n\n` +
        `💡 If she recently shared her contact or CV on WhatsApp, you can provide her phone number:\n` +
        `Example: *Ask Pragati 9876543210 if she can join today*\n\n` +
        `I will instantly register her, save to Supabase, and dispatch the joining inquiry! 🚀`;
    }

    const firstName = (candidate.name || 'there').trim().split(' ')[0];
    const joinMsg = `Hi ${firstName}, this is Saa from HR team 👋\n\nHope you are doing well! We wanted to check with you — are you available to join today? Please let us know so we can coordinate your joining formalities and onboarding right away. 🌟`;

    const phone = (candidate.phone || '').replace(/\D/g, '');
    const waId = phone.startsWith('91') ? `${phone}@c.us` : `91${phone}@c.us`;

    let sent = false;
    if (waClient && phone) {
      try {
        await waClient.sendMessage(waId, joinMsg);
        sent = true;
      } catch (err) {
        console.error('[SaaTrainer] Error sending joining inquiry:', err.message);
      }
    }

    await appendCandidateNote(candidate.phone, `[WhatsApp Sent] Inquired about joining today: "${joinMsg.slice(0, 70)}..."`);

    return `📋 *Joining Inquiry ${sent ? 'Sent' : 'Dispatched'} to ${candidate.name}!*\n\n` +
      `📱 Phone: ${candidate.phone}\n` +
      `💼 Process: ${candidate.process || 'Voice'} | 📍 Location: ${candidate.location || 'Mumbai'}\n` +
      `📝 *Recent Notes in RecrutOS:* ${extractRecentNote(candidate.notes)}\n\n` +
      `💬 *Message Sent:*\n"${joinMsg}"\n\n` +
      `⚡ *Live Sync:* When ${candidate.name} replies, I will parse the response, update her joined status/notes in RecrutOS Supabase, and ping you here immediately!`;
  }

  // ── D. SINGLE CANDIDATE OUTREACH ───────────────────────────────────────────────────────────
  // Matches: "msg Abdul about interview", "text 9876543210 venue is at Malad",
  //          "tell Rahul to come tomorrow", "ask Priya if she is coming"
  if (intent === 'single_candidate_outreach') {
    // Strip filler prefixes like "can u", "can you", "please", then the action verb
    const withoutVerb = text
      .replace(/^(?:can\s+(?:u|you)\s+|please\s+|kindly\s+)/i, '')
      .replace(/^(?:msg|message|text|whatsapp|tell|inform|ask|send\s+(?:a\s+)?(?:msg|message|text)?|ping|call|contact|reach\s+out\s+to?)\s+/i, '')
      .trim();

    // Try to extract phone number anywhere in the original text
    const phoneMatch = text.match(/\b([6-9]\d{9})\b/) || text.match(/\b(91[6-9]\d{9})\b/);
    const embeddedPhone = phoneMatch ? phoneMatch[1].slice(-10) : '';

    // Name is everything before the first "to", "about", "that", "regarding", ":", or a long word boundary
    let targetRaw = '';
    let instruction = '';

    // ── Step 1: Check for pronouns FIRST before any regex splitting ──────────
    // "msg him on whatsapp to be available" → isPronoun, use context memory
    // Strip prefix verb before pronoun check too
    const isPronounCheck = /^(her|him|she|he|them|they|this candidate|that candidate|the candidate)\b/i.test(withoutVerb);
    if (isPronounCheck) {
      const last = getLastDiscussedCandidate();
      if (last) {
        // Extract instruction = everything after the pronoun (and any trailing noise like "on whatsapp")
        const afterPronoun = withoutVerb.replace(/^(her|him|she|he|them|they|this candidate|that candidate|the candidate)\s*/i, '')
          .replace(/^(on\s+whatsapp|on\s+wa|via\s+whatsapp)\s*/i, '').trim();
        const instruction = afterPronoun || text;
        setLastDiscussedCandidate(last);
        return await sendOutreachMessage(waClient, last, instruction, text);
      }
    }

    // Strategy 1: "<name> to/about/that/regarding/on whatsapp/: <instruction>"
    const splitMatch = withoutVerb.match(/^([a-zA-Z0-9\+\s]{2,40?}?)\s+(?:to\s+be\s+|to\s+|about\s+|that\s+|regarding\s+|on\s+whatsapp\s+|via\s+whatsapp\s+|:)(.+)$/i);
    if (splitMatch) {
      targetRaw = splitMatch[1].trim();
      instruction = splitMatch[2].trim();
    } else {
      // Strategy 2: if phone found, rest of text is instruction
      if (embeddedPhone) {
        targetRaw = embeddedPhone;
        instruction = withoutVerb.replace(phoneMatch[0], '').trim();
      } else {
        // Strategy 3: first word(s) = name, rest = instruction
        const parts = withoutVerb.split(/\s+/);
        // Name = 1 or 2 words (people's names), instruction = everything after
        const nameWords = parts[1] && parts[1].length <= 15 && !/^(to|about|that|regarding|is|will|can|please|tomorrow|today|interview|venue|for|the|a|an)$/i.test(parts[1])
          ? 2 : 1;
        targetRaw = parts.slice(0, nameWords).join(' ').trim();
        instruction = parts.slice(nameWords).join(' ').trim();
      }
    }

    // Clean trailing phrases from instruction
    instruction = instruction.replace(/(?:to|for|at|on)?\s*(?:this|the)?\s*(?:number|num|candidate)?\s*$/i, '').trim();

    // Look up the candidate with pronoun & context memory
    let candidate = null;
    const isPronoun = /^(her|him|she|he|them|they|this candidate|that candidate)$/i.test(targetRaw);
    if (isPronoun) {
      candidate = getLastDiscussedCandidate();
    }
    if (!candidate) {
      candidate = await findCandidateByNameOrPhone(embeddedPhone || targetRaw);
    }

    // If phone number was given but candidate not in DB, auto-register candidate
    if (!candidate && embeddedPhone) {
      const candName = (isPronoun || !targetRaw || targetRaw === embeddedPhone) ? 'Candidate' : targetRaw;
      const newCandData = {
        name: candName,
        phone: embeddedPhone,
        process: 'Voice',
        location: 'Mumbai',
        notes: `[Shetty Saa Request] Outreach initiated via WhatsApp.`
      };
      try {
        const created = await addCandidateToRecrutOS(newCandData);
        candidate = (created.success && created.data) ? created.data : newCandData;
      } catch (_) {
        candidate = newCandData;
      }
    }

    if (!candidate) {
      // Try fuzzy — search first name only
      const firstName = targetRaw.split(/\s+/)[0];
      const fuzzyResult = firstName.length >= 3 ? await findCandidateByNameOrPhone(firstName) : null;

      if (!fuzzyResult) {
        return `⚠️ Could not find "*${targetRaw || embeddedPhone}*" in RecrutOS.\n\n` +
          `💡 Try:\n` +
          `• *msg 9876543210 about interview venue*\n` +
          `• *msg Rahul to confirm for tomorrow*\n` +
          `• *tell Priya interview is at 10am*`;
      }

      candidate = fuzzyResult;
    }

    setLastDiscussedCandidate(candidate);
    return await sendOutreachMessage(waClient, candidate, instruction || text, text);
  }

  // ── E. RECENT RESUMES & NUMBERS SYNC CHECK ────────────────────────────────
  if (intent === 'recent_resumes') {
    const recents = await getRecentCandidates(8);

    if (!recents || recents.length === 0) {
      return `📊 *RecrutOS Sync Status*\n\nAll systems connected to Supabase, but no recent candidates found in \`ros_candidates\`.\nAny new resumes sent to this bot will automatically appear here and in your RecrutOS app!`;
    }

    const cards = recents.map((c, i) => {
      const exp = c.experience === 'Experienced' ? (c.years ? `${c.years} yrs exp` : 'Experienced') : (c.experience || 'Fresher');
      const lineup = c.interview_date ? `📅 *Lineup: ${formatDisplayDate(c.interview_date)}*` : '⏳ Lineup pending';
      const note = extractRecentNote(c.notes);
      const isHandoff = /talk|call|callback|discuss/i.test(note);
      const noteLine = isHandoff ? `\n   ⚠️ _Handoff/Action:_ ${note}` : `\n   📝 _Note:_ ${note}`;
      return `${i + 1}. *${c.name}* | 📱 ${c.phone}\n   💼 ${c.process || 'Voice'} | ${exp} | ${lineup}${noteLine}`;
    }).join('\n\n');

    return `✅ *Yes, Shetty Saa! All new resumes and candidate numbers are saved live in RecrutOS Supabase.*\n━━━━━━━━━━━━━━━━━━━━━━\nHere are the latest candidate profiles synced to your RecrutOS app:\n\n${cards}\n\n━━━━━━━━━━━━━━━━━━━━━━\n📱 *RecrutOS App Sync:* You can open your RecrutOS app right now to view these candidates under the Candidates & Lineups tabs with dates.\n🤝 If you need to talk to someone as handed off or want me to contact anyone, just let me know here!`;
  }

  // ── E2. PIPELINE QUERY ─────────────────────────────────────────────────────
  // "how many overdue lineups?", "how many candidates joined?", "how many freshers?"
  if (intent === 'pipeline_query') {
    const statsRes = await callMCPTool('get_pipeline_stats', {});
    if (!statsRes.ok) return `⚠️ Couldn't fetch pipeline stats: ${statsRes.error}`;
    const s = statsRes.data;
    const t_lower = text.toLowerCase();

    // Smart single-answer for specific queries
    if (/overdue|back.*dated|back-dated/i.test(t_lower)) {
      return `⏳ *Overdue Lineups:* *${s.overdue_lineups}* candidate(s) have a past interview date who haven't joined yet.\n\n💡 Say *"forward manual JD to all overdue line ups"* to re-engage them!`;
    }
    if (/joined/i.test(t_lower)) {
      return `🎉 *Candidates Joined:* *${s.joined}* successfully placed so far.`;
    }
    if (/fresher/i.test(t_lower)) {
      return `👶 *Freshers in Pipeline:* *${s.fresher || 'N/A'}* active freshers in RecrutOS.`;
    }
    if (/experienced/i.test(t_lower)) {
      return `💼 *Experienced Candidates:* *${s.experienced || 'N/A'}* in active pipeline.`;
    }
    if (/lineup|lined up/i.test(t_lower)) {
      return `📅 *In Lineup:* *${s.in_lineup}* candidates currently lined up.\n🎯 Today (${formatDisplayDate(todayStr)}): *${s.scheduled_for_today}*`;
    }

    // Full dashboard
    return `📊 *RecrutOS Pipeline Intelligence*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👥 Total Active: *${s.total_active_candidates}*\n` +
      `📅 In Lineup: *${s.in_lineup}* | Today: *${s.scheduled_for_today}*\n` +
      `⏳ Overdue: *${s.overdue_lineups}*\n` +
      `✅ Joined: *${s.joined}*\n` +
      `🔔 Open Reminders: *${s.pending_reminders_count}*\n\n` +
      `_Live sync from RecrutOS Supabase._ 🚀`;
  }


  if (intent === 'today_interview') {
    const candidates = await getInterviewCandidates(todayStr);
    return formatInterviewBriefing(candidates, todayStr, true);
  }

  // ── 2. TOMORROW'S INTERVIEW BRIEFING ───────────────────────────────────────
  if (intent === 'tomorrow_interview') {
    const tomorrowStr = getISTDateString(1);
    const candidates = await getInterviewCandidates(tomorrowStr);
    return formatInterviewBriefing(candidates, tomorrowStr, false);
  }

  // ── 3. CANDIDATE NOTE UPDATE ───────────────────────────────────────────────
  if (intent === 'note') {
    const clean = text.replace(/^note:?|^update note:?|^add note:?|^update candidate:?|^save note:?|^mark /i, '').trim();
    let name = '';
    let noteText = '';

    if (clean.includes(':')) {
      const parts = clean.split(':');
      name = parts[0].trim();
      noteText = parts.slice(1).join(':').trim();
    } else {
      const words = clean.split(/\s+/);
      if (words.length >= 3) {
        name = words.slice(0, 2).join(' ');
        noteText = words.slice(2).join(' ');
      } else {
        name = words[0];
        noteText = words.slice(1).join(' ');
      }
    }

    if (!name || !noteText) {
      return `⚠️ Please provide candidate name and note.\nExample: *Note: Alan Pater selected in Firstsource*`;
    }

    const updated = await appendCandidateNote(name, noteText);
    if (!updated) {
      return `❌ Could not find candidate matching "*${name}*" in RecrutOS.\nPlease check the spelling or provide their phone number.`;
    }

    return `📝 *Note Saved for ${updated.name}!*\n\nAdded: "${noteText}"\nUpdated live in RecrutOS database. 📋`;
  }

  // ── 4. CANDIDATE SEARCH ────────────────────────────────────────────────────
  if (intent === 'search') {
    // Strip search verbs + filler words so "Find Pratham please" → query="Pratham"
    const query = text
      .replace(/\b(find|search|list|show|fetch|get all|who are|candidates in|candidates from|give me|all|the)\b/gi, '')
      .replace(/\b(please|kindly|me|for|in|on|at|by|with|a|an)\b/gi, '')
      .replace(/\s+/g, ' ').trim();
    let results = await searchCandidatesDB(query, filters);

    // Apply gender heuristic in JavaScript
    if (filters.gender === 'female') {
      results = results.filter(c => {
        const name = (c.name || '').toLowerCase();
        return /priya|neha|pooja|shilpa|shreya|ankita|divya|kavya|asha|sunita|rekha|nisha|riya|sonal|anita|meera|swati|komal|jyoti|deepa|geeta|varsha|manasi|mahima|alka|heena|puja|sakshi|radha|seema|vandana|rani|nitu|babita|sushma|pratibha|urmila|vineeta|archana|rajni|meenal|chanda|lalita|sarla|kanchan|pushpa|sumitra|durga|kamla|savita|sudha|usha|vimala|yamuna|chandrika|iffat|rosanne|mallika|shivani|anjali/.test(name);
      });
    }

    if (!results.length) {
      return `Searched RecrutOS 🔍 — no candidates found matching:\n${Object.entries(filters).map(([k, v]) => `• ${k}: ${v}`).join('\n') || query || '(no filters)'}\n\nWant me to broaden the search?`;
    }

    const cards = results.slice(0, 8).map((c, i) => {
      const exp = c.experience === 'Experienced' ? (c.years ? `${c.years} yrs exp` : 'Experienced') : (c.experience || 'Fresher');
      const salary = c.inhand_salary && c.inhand_salary !== '-' ? `₹${c.inhand_salary}` : 'N/A';
      return `${i + 1}. *${c.name}* | 📱 ${c.phone}\n   📍 ${c.location || 'Mumbai'} | ${c.process || 'Voice'} | ${exp} | Inhand: ${salary}`;
    }).join('\n\n');

    const noSend = wantsNoSend(text);
    const footer = noSend
      ? `\n\n✅ *Search-only mode:* I won't message anyone from this list.`
      : `\n\n💡 Reply *"Text all"* with a message to reach out to them.`;

    return `Found *${results.length} candidates* in RecrutOS 🎯\n\n${cards}${results.length > 8 ? `\n\n...and ${results.length - 8} more in database.` : ''}${footer}`;
  }

  // ── 5. BULK OUTREACH ───────────────────────────────────────────────────────
  if (intent === 'bulk_action') {
    if (!waClient) return '⚠️ WhatsApp client not ready for sending bulk messages.';

    let targets = [];
    if (/today/i.test(text)) {
      targets = await getInterviewCandidates(todayStr);
    } else if (filters.company || filters.lineup_status) {
      targets = await searchCandidatesDB('', { lineup_status: 'Yes', ...filters });
    } else {
      targets = await getInterviewCandidates(todayStr);
    }

    if (!targets.length) {
      return `Couldn't find any target candidates to text. (e.g. "text all today candidates: Please reach on time")`;
    }

    // Extract custom message if provided
    let customMsg = text
      .replace(/text all today candidates:?|text all today:?|text all:?|remind all today:?|remind all:?/gi, '')
      .trim();

    if (!customMsg || customMsg.length < 5) {
      customMsg = `Hi {name}, this is Saa from HR team 👋\n\nReminder for your interview schedule today. Please carry updated resume copies and original ID proof. Reach venue 15 mins early. Good luck!`;
    }

    let sent = 0;
    const errors = [];

    for (const c of targets.slice(0, 30)) {
      const phone = (c.phone || '').replace(/\D/g, '');
      if (!phone) continue;
      const waId = phone.startsWith('91') ? `${phone}@c.us` : `91${phone}@c.us`;
      const firstName = (c.name || 'there').split(' ')[0];
      const personalized = customMsg.replace(/{name}/gi, firstName);

      try {
        await waClient.sendMessage(waId, personalized);
        sent++;
        await appendCandidateNote(c.phone, `Bulk reminder sent: "${personalized.slice(0, 60)}..."`);
        // Humanized anti-ban delay (1.2 - 2.5s)
        await new Promise(r => setTimeout(r, 1200 + Math.random() * 1300));
      } catch (err) {
        errors.push(c.name);
      }
    }

    return `✅ Done, Shetty Saa!\n\nSent WhatsApp reminders to *${sent} candidate(s)*.${errors.length ? `\n⚠️ Failed to send: ${errors.join(', ')}` : ''}\n\nProfiles & notes updated in RecrutOS. 📋`;
  }

  // ── 6. TRAINING / LIVE RULE LEARNING ───────────────────────────────────────
  if (intent === 'training_update') {
    updateTrainingMd(text, 'LIVE_RULE');

    let summary = text;
    const t = text.toLowerCase();

    if (/jp not|jp is not|jp closed|jp cancel|postpone/i.test(t)) {
      updateTrainingMd('JP Morgan interviews are NOT happening today / postponed. Align candidates for next slot.', 'CRITICAL_RULE');
      summary = 'JP Morgan interview status set to CLOSED/POSTPONED.';
    } else if (/adhar|aadhar/i.test(t)) {
      updateTrainingMd('Aadhaar card and original documents mandatory for interview entry.', 'DOC_RULE');
      summary = 'Aadhaar card set as mandatory requirement.';
    }

    return `🧠 *Training Memory Updated, Shetty Saa!*\n\n• *Learned:* ${summary}\n• *Timestamp:* ${ts} IST\n\nThis rule is now live and will be applied to all candidate chats immediately. 🚀`;
  }

  // ── 7. RECRUTOS PIPELINE STATUS ───────────────────────────────────────────
  if (intent === 'status') {
    const client = getClient();
    if (!client) return '⚠️ RecrutOS Supabase not connected. Please check .env.recruiter.';

    const [candRes, lineupRes, joinedRes, todayList] = await Promise.all([
      client.from('ros_candidates').select('id', { count: 'exact', head: true }).or('is_trash.is.null,is_trash.eq.false'),
      client.from('ros_candidates').select('id', { count: 'exact', head: true }).or('is_trash.is.null,is_trash.eq.false').eq('lineup_status', 'Yes'),
      client.from('ros_candidates').select('id', { count: 'exact', head: true }).or('is_trash.is.null,is_trash.eq.false').eq('joined_status', 'Yes'),
      getInterviewCandidates(todayStr),
    ]);

    return `📊 *RecrutOS Operations Dashboard — ${ts} IST*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👥 Total Active Candidates: *${candRes.count || 0}*\n` +
      `📅 In Lineup: *${lineupRes.count || 0}*\n` +
      `🎯 Today's Interviews (${formatDisplayDate(todayStr)}): *${todayList.length}*\n` +
      `✅ Total Joined: *${joinedRes.count || 0}*\n\n` +
      `_Connected live to RecrutOS Supabase._`;
  }

  // ── 8a. MEDIA & ENRICHMENT SHORTCUTS ─────────────────────────────────────
  // Handles: GIFs, weather, news, currency — before hitting general AI
  const enrichIntent = detectEnrichmentIntent(text);
  if (enrichIntent) {
    const recipientWaId = null; // boss-context: not sending to a specific candidate here
    const enrichResult = await handleEnrichment(enrichIntent, waClient, recipientWaId);
    if (enrichResult) return enrichResult;
  }

  // ── 8b. FAST PRE-PARSER — common boss commands bypass AI entirely ──────────────
  // Catches: lineup/interview date updates, joined, no-show, dropout, status queries
  // This means ZERO API cost + ZERO wrong-tool risk for these patterns.
  const direct = await parseDirectCommand(text, todayStr, waClient);
  if (direct) return direct;

  // ── 8c. GENERAL AI CO-PILOT with REAL Gemini Function Calling ───────────────
  // Handles everything else. Gemini picks the right tool and we execute it.
  try {
    const trainerPhone = getTrainerPhone();
    const TRAINER_CHAT_ID = `trainer_${trainerPhone || 'shetty'}`;

    // Inject today's live candidates for full AI context
    const todayCandidates = await getInterviewCandidates(todayStr);
    const todaySummary = todayCandidates.length > 0
      ? `Today's (${todayStr}) scheduled candidates (${todayCandidates.length}):\n` +
        todayCandidates.map(c =>
          `- ${c.name} (${c.phone}): ${c.process || 'Voice'}, ${c.experience || 'Exp'}, ` +
          `₹${c.inhand_salary || 'N/A'}, Notes: ${(c.notes || '').slice(0, 100).replace(/\n/g, ' ')}`
        ).join('\n')
      : `No candidates scheduled for today (${todayStr}).`;

    const lastCand = getLastDiscussedCandidate();
    const lastCandContext = lastCand
      ? `ACTIVE CANDIDATE CONTEXT (from immediate conversation):
- Name: ${lastCand.name}
- Phone: ${lastCand.phone}
- Location: ${lastCand.location || 'Mumbai'}
- Process: ${lastCand.process || 'Voice'}
If boss uses pronouns like "her", "him", "she", "he", "them", or "this candidate", they refer to ${lastCand.name} (${lastCand.phone})!`
      : 'No candidate discussed in session yet.';

    const istDay = getISTDayOfWeek(0);
    const tomorrowDay = getISTDayOfWeek(1);
    const tomorrowStr = getISTDateString(1);

    const systemText = `You are Saa, the AI operations co-pilot for Shetty Saa's Mumbai BPO recruitment firm RecrutOS.
Date & Time: ${istDay}, ${todayStr} ${ts} IST.
CURRENT CALENDAR:
- TODAY is strictly ${istDay}, ${todayStr} (Year: 2026).
- TOMORROW is strictly ${tomorrowDay}, ${tomorrowStr} (Year: 2026).
- Current Year: 2026. NEVER confuse the day of the week or year.
Today's Lineup: ${todaySummary}

${lastCandContext}

CRITICAL RULES:
1. When boss says "lineup", "interview date", "set date", "confirm interview" for a candidate → call update_candidate with {lineup_status:"Yes", interview_date:"YYYY-MM-DD"}
2. When boss says "joined", "joining", "selected" → call update_candidate with {joined_status:"Joined"}
3. When boss says "no show", "didn't come", "absent" → call update_candidate with {joined_status:"No Show"}
4. When boss says "dropout", "not interested", "remove" → call update_candidate with {lineup_status:"No", joined_status:"Dropout"}
5. When boss says "remind me to call", "set reminder" → call add_reminder
6. When boss says "add a note", "note that", "record that" → call append_note
7. NEVER use append_note when a status field needs changing. ALWAYS use update_candidate for any lineup/joined/status change.
8. Call the function tool. Do NOT just describe it in text.
9. When boss says "change all candidates lineup dates", "shift today's lineups to tomorrow", "aaj ke sare candidates ko kal shift karo", or any bulk lineup rescheduling → call batch_reschedule_lineups with {source_date: "YYYY-MM-DD", target_date: "YYYY-MM-DD"}.
10. When boss asks about Job Descriptions (JDs), company hiring details, salary, shifts, eligibility (TechM, Accenture, WNS, Concentrix, JP Morgan, etc.) → call get_job_description with {company: "company name"}.`.trim();

    // ── Gemini Function Declarations (MCP Tools exposed to AI) ───────────────
    const functionDeclarations = [
      {
        name: 'batch_reschedule_lineups',
        description: 'Reschedule all candidates who have an interview lineup on source_date to target_date in RecrutOS Supabase. Use when boss asks to move, shift, or change all of today\'s lineups to tomorrow, or any date-to-date bulk lineup rescheduling.',
        parameters: {
          type: 'OBJECT',
          properties: {
            source_date: {
              type: 'STRING',
              description: 'Original interview date to shift from (YYYY-MM-DD). Default is today (' + todayStr + ').'
            },
            target_date: {
              type: 'STRING',
              description: 'New interview date to shift to (YYYY-MM-DD). Default is tomorrow.'
            }
          },
          required: ['target_date']
        }
      },
      {
        name: 'find_candidate',
        description: 'Find a candidate in RecrutOS by name (partial) or phone number. Use this before updating to confirm candidate exists.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: 'Candidate name (partial OK) or 10-digit phone number' }
          },
          required: ['query']
        }
      },
      {
        name: 'update_candidate',
        description: 'Update candidate STATUS FIELDS in RecrutOS Supabase. MANDATORY for these boss commands: "lineup"/"line up"/"interview date"/"set date" (sets interview_date + lineup_status:Yes), "joined"/"joining"/"selected" (sets joined_status:Joined), "no show"/"didn\'t come" (sets joined_status:No Show), "dropout"/"not interested" (sets lineup_status:No). interview_date MUST be YYYY-MM-DD format. TODAY=' + todayStr + ', TOMORROW=' + new Date(Date.now() + (24 + 5.5) * 3600000).toISOString().slice(0, 10) + '.',
        parameters: {
          type: 'OBJECT',
          properties: {
            identifier: { type: 'STRING', description: 'Candidate name (partial OK) or 10-digit phone number' },
            updates: {
              type: 'OBJECT',
              description: 'Fields to update. For lineup: {"lineup_status":"Yes","interview_date":"YYYY-MM-DD"}. For joined: {"joined_status":"Joined"}. For no-show: {"joined_status":"No Show"}. For dropout: {"lineup_status":"No","joined_status":"Dropout"}'
            }
          },
          required: ['identifier', 'updates']
        }
      },
      {
        name: 'add_reminder',
        description: 'Add a new reminder or followup task in RecrutOS for a candidate.',
        parameters: {
          type: 'OBJECT',
          properties: {
            identifier: { type: 'STRING', description: 'Candidate name or phone number' },
            date: { type: 'STRING', description: 'Reminder date (YYYY-MM-DD)' },
            time: { type: 'STRING', description: 'Reminder time e.g. 11:00 AM' },
            note: { type: 'STRING', description: 'Reminder note text' }
          },
          required: ['identifier', 'date', 'time', 'note']
        }
      },
      {
        name: 'append_note',
        description: 'Append a timestamped note to a candidate. Use ONLY for freeform notes, remarks, or boss observations. NEVER use this when a status field (lineup_status, joined_status, interview_date) needs to change — use update_candidate instead.',
        parameters: {
          type: 'OBJECT',
          properties: {
            identifier: { type: 'STRING', description: 'Candidate name or phone number' },
            note: { type: 'STRING', description: 'The note text to append' }
          },
          required: ['identifier', 'note']
        }
      },
      {
        name: 'search_candidates',
        description: 'Search RecrutOS candidates with optional filters: location, experience (Fresher/Experienced), process (Voice/Chat/Backoffice), lineup_status.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query:         { type: 'STRING', description: 'Name search term (optional)' },
            location:      { type: 'STRING', description: 'Mumbai area e.g. Malad, Thane, Andheri' },
            experience:    { type: 'STRING', description: 'Fresher or Experienced' },
            process:       { type: 'STRING', description: 'Voice, Chat, or Backoffice' },
            lineup_status: { type: 'STRING', description: 'Yes, No, or On Hold' },
            limit:         { type: 'NUMBER', description: 'Max results (default 20)' }
          },
          required: []
        }
      },
      {
        name: 'get_today_lineup',
        description: 'Get all candidates lined up for interviews today. Use when boss asks about today\'s schedule or update.',
        parameters: { type: 'OBJECT', properties: {}, required: [] }
      },
      {
        name: 'get_pipeline_stats',
        description: 'Get live RecrutOS pipeline counts: total candidates, today lineup, joined this month, pending followups.',
        parameters: { type: 'OBJECT', properties: {}, required: [] }
      },
      {
        name: 'get_pending_reminders',
        description: 'Get all pending reminders from RecrutOS due today or tomorrow.',
        parameters: { type: 'OBJECT', properties: {}, required: [] }
      },
      {
        name: 'get_pending_followups',
        description: 'Get all overdue followups from RecrutOS.',
        parameters: { type: 'OBJECT', properties: {}, required: [] }
      },
      {
        name: 'get_job_description',
        description: 'Get full Job Description (JD), hiring criteria, salary, eligibility, shifts, and interview rounds for any Mumbai BPO company (TechM, Accenture, Concentrix, JP Morgan, WNS, Teleperformance, Foundever, TCS, Firstsource, etc.) from training records. Call this when boss asks about company hiring or JDs.',
        parameters: {
          type: 'OBJECT',
          properties: {
            company: { type: 'STRING', description: 'Company name or alias (e.g. TechM, Accenture, WNS, Concentrix, Foundever)' }
          },
          required: ['company']
        }
      },
    ];

    // ── Load API key ─────────────────────────────────────────────────────────
    const CONFIG_PATH = path.resolve(__dirname, '../config/api_keys.json');
    let apiKey = null;
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const keys = Array.isArray(cfg.gemini_api_keys) ? cfg.gemini_api_keys : [];
      if (cfg.gemini_api_key) keys.push(cfg.gemini_api_key);
      apiKey = keys.find(k => k && !k.includes('your_')) || null;
    } catch (_) {}

    if (!apiKey) throw new Error('No Gemini API key available for function calling');

    const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-3.6-flash'];

    // ── Step 1: Call Gemini with function declarations ────────────────────────
    const userMessage = { role: 'user', parts: [{ text }] };

    const payload1 = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [userMessage],
      tools: [{ functionDeclarations }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 1024 }
    };

    let step1Data = null;
    for (const model of MODELS) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload1) }
        );
        if (!resp.ok) continue;
        step1Data = await resp.json();
        break;
      } catch (_) { continue; }
    }

    if (!step1Data) throw new Error('Gemini function calling step 1 failed');

    const step1Parts = step1Data.candidates?.[0]?.content?.parts || [];
    const funcCallPart = step1Parts.find(p => p.functionCall);

    // ── If AI returned plain text (no tool needed) — return it directly ──────
    if (!funcCallPart) {
      const plainText = step1Parts.find(p => p.text)?.text;
      if (plainText) return plainText;
      throw new Error('No content in Gemini step 1 response');
    }

    // ── Step 2: Execute the actual MCP tool ───────────────────────────────────
    const { name: toolName, args: toolArgs } = funcCallPart.functionCall;
    console.log(`[SaaTrainer] 🔧 AI called tool: ${toolName}(${JSON.stringify(toolArgs).slice(0, 120)})`);

    const mcpResult = await callMCPTool(toolName, toolArgs || {}, waClient);
    console.log(`[SaaTrainer] ✅ Tool result: ok=${mcpResult.ok} | ${mcpResult.message || mcpResult.error || JSON.stringify(mcpResult.data || '').slice(0, 80)}`);

    if (mcpResult.ok) {
      if (mcpResult.candidate) {
        setLastDiscussedCandidate(mcpResult.candidate);
      } else if (mcpResult.data && (mcpResult.data.name || mcpResult.data.phone)) {
        setLastDiscussedCandidate(mcpResult.data);
      }
    }

    // ── Step 3: Send tool result back to Gemini for final reply ──────────────
    const toolResultText = mcpResult.ok
      ? JSON.stringify(mcpResult.data || mcpResult.message || 'Done')
      : `Error: ${mcpResult.error}`;

    const payload2 = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [
        userMessage,
        { role: 'model', parts: step1Parts },
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: toolName,
              response: { result: toolResultText }
            }
          }]
        }
      ],
      generationConfig: { temperature: 0.5, maxOutputTokens: 800 }
    };

    let finalReply = null;
    for (const model of MODELS) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload2) }
        );
        if (!resp.ok) continue;
        const data = await resp.json();
        finalReply = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (finalReply) break;
      } catch (_) { continue; }
    }

    return finalReply || (mcpResult.ok
      ? `✅ Done, Shetty Saa! *${toolName}* completed successfully.\n${mcpResult.message || ''}`
      : `⚠️ Issue with *${toolName}*: ${mcpResult.error}`);

  } catch (e) {
    console.error('[SaaTrainer] AI function calling error:', e.message);
    return `Received: "${text.slice(0, 60)}"\n\nI've noted this, Shetty Saa. Let me know what action you'd like me to take.`;
  }
}

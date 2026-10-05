/**
 * bot.js — RecrutOS WhatsApp Recruitment Bot (Main Entry)
 * ========================================================
 * A fully autonomous WhatsApp-based AI recruiter that:
 *  - Greets new candidates and runs an 8-step intake flow
 *  - Matches profiles to open BPO/ITES JDs in Mumbai
 *  - Saves all candidates to RecrutOS Supabase (ros_candidates)
 *  - Handles recruiter commands (/lineup, /joined, /search, /note...)
 *  - Supports human handoff (flags for human review + notifies recruiter)
 *  - Respects a DND list (no replies to blocked numbers)
 *  - Handles media: PDFs, images (resume parsing), voice, video
 *  - Uses multi-key Gemini rotation for high throughput
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import qrcodeTerminal from 'qrcode-terminal';
import { askAI, resetUserHistory, parseResumeWithAI } from './ai_engine.js';
import { loadBotConfig } from './config.js';
import { getBrowserExecutablePath } from './browser_helper.js';
import { processMediaForAI } from './media_handler.js';
import { downloadMediaSafe } from './media_downloader.js';
import { extractUrls, readUrlContent } from './agent_reach.js';
import {
  detectHistoryIntent,
  getCurrentChatHistory,
  getContactHistorySummary,
  extractPhoneFromHistoryQuery,
  isExternalHistoryQuery,
} from './chat_history_reader.js';
import {
  fetchLast500Messages,
  analyzeChatHistory500,
  isAcknowledgmentMessage,
  isNegativeOrRefusalMessage,
  getQuickAcknowledgmentReply,
} from './chat_memory_manager.js';
import {
  isTrainingCommand,
  isTrainerContact,
  handleTrainingCommand,
  getTrainingSummary,
} from './live_trainer.js';
import {
  isProtectedContact,
  protectContact,
  unprotectContact,
  getProtectedList,
  logProtectedContactAttempt,
} from './contact_guard.js';
import {
  isDbConnected,
  addCandidateToRecrutOS,
  searchCandidate,
  updateCandidateStatus,
  appendNote,
  addLineupFollowup,
  addToDnd,
  removeFromDnd,
  isOnDnd,
  isRecruiter,
  addRecruiterNumber,
  isNewUser,
  markUserSeen,
  unmarkUserSeen,
  isInIntakeFlow,
  getIntakeState,
  setIntakeState,
  clearIntakeState,
  flagForHumanReview,
  isWaitingForHuman,
  clearHumanFlag,
  getPendingHumanList,
  phoneFromWaId,
  cleanPhone,
  INTAKE_STEPS,
  INTAKE_QUESTIONS,
} from './recruiter_db.js';
import {
  isTrainerChatMessage,
  isTrainerChat,
  isFromTrainerContact,
  getTrainerWaId,
  handleTrainerChatMessage,
  notifyTrainerAndOffice,
} from './saa_trainer_chat.js';
import { callMCPTool, getMCPManifest, setMcpWaClient } from './recrutos_mcp.js';
import { startScheduler, recordReply } from './saa_scheduler.js';
import { runPatternLearner } from './saa_pattern_learner.js';
import { saveCandidateContact } from './contact_saver.js';
import { logAgentActivity, getRecentActivityBriefing } from './activity_log.js';
import { isAutoReplyPaused } from './bot_pause_state.js';
import { extractAllProfileFields, isLikelyName } from './profile_extractor.js';
import { resolveRealPhone, registerLidMapping } from './lid_resolver.js';
import {
  getOrCreateCandidateNode,
  updateCandidateGraphNode,
  syncResumeToGraph,
  handleBossSidewaysInteraction,
  isReferralResume,
  handleReferralResume,
  checkAndResolvePendingReferral
} from './candidate_graph.js';
import { parseLineupDate } from './date_resolver.js';
import { startRecrutOSSyncWindow } from './recrutos_sync_window.js';


// ── Startup cleanup — kill stale Chrome/lockfile from previous run ──────────
try {
  const lockfilePath = path.resolve('.wwebjs_auth/session/lockfile');
  if (fs.existsSync(lockfilePath)) { fs.unlinkSync(lockfilePath); console.log('🧹 [Startup] Removed stale lockfile'); }
} catch (_) {}
// Note: if puppeteer still complains about "browser already running", the
// run_whatsapp_bot.bat / OS-level cleanup must kill the process. See README.

// ── Suppress known non-fatal puppeteer race condition ────────────────────────
// whatsapp-web.js calls console.error() directly for TargetCloseError so
// unhandledRejection alone won't catch it. We intercept console.error too.
const SUPPRESS_MSGS = [
  'onAppStateHasSyncedEvent',
  'TargetCloseError',
  'Target closed',
  'Protocol error (Page.addScriptToEvaluateOnNewDocument)',
];
const _origConsoleError = console.error.bind(console);
console.error = (...args) => {
  const msg = String(args[0] || '');
  if (SUPPRESS_MSGS.some(s => msg.includes(s))) return; // swallow silently
  _origConsoleError(...args);
};
process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || reason || '');
  if (SUPPRESS_MSGS.some(s => msg.includes(s))) return;
  _origConsoleError('[Bot] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  const msg = String(err?.message || err || '');
  if (SUPPRESS_MSGS.some(s => msg.includes(s))) return;
  _origConsoleError('[Bot] Uncaught exception:', err);
});

const config = loadBotConfig();
const executablePath = getBrowserExecutablePath();

console.log('═══════════════════════════════════════════════════════');
console.log('🚀 RecrutOS WhatsApp Recruitment Bot — Starting...');
console.log(`🌐 Browser: ${executablePath || 'Default Puppeteer Chrome'}`);
console.log(`🗄️  RecrutOS Supabase: ${isDbConnected() ? '✅ Connected' : '⚠️  Not connected (local-only mode)'}`);
console.log('═══════════════════════════════════════════════════════\n');

// ── WhatsApp Client ──────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    executablePath,
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
      '--disable-gpu', '--disable-session-crashed-bubble', '--disable-infobars',
      '--no-default-browser-check', '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'
    ]
  }
});

// ── Media cache (3-minute TTL for follow-up questions on same media) ─────────
const recentUserMedia = new Map();
const MEDIA_CACHE_TTL = 3 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL DEDUP GUARD — prevents ANY message being processed twice
// (fixes: same reply sent multiple times after restarts / double events)
// ─────────────────────────────────────────────────────────────────────────────
const DEDUP_FILE = path.resolve('./.wwebjs_auth/processed_msg_ids.json');
const DEDUP_MAX  = 2000;   // keep last 2000 message IDs in memory+file
const _processedIds = new Set();

// Load last processed IDs from disk so we survive restarts
try {
  if (fs.existsSync(DEDUP_FILE)) {
    const saved = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
    (saved.ids || []).forEach(id => _processedIds.add(id));
    console.log(`[Dedup] Loaded ${_processedIds.size} processed message IDs from disk.`);
  }
} catch (_) {}

function isAlreadyProcessed(msgId) {
  return _processedIds.has(msgId);
}

function markProcessed(msgId) {
  if (!msgId) return;
  _processedIds.add(msgId);
  // Trim to last DEDUP_MAX
  if (_processedIds.size > DEDUP_MAX) {
    const oldest = [..._processedIds].slice(0, _processedIds.size - DEDUP_MAX);
    oldest.forEach(id => _processedIds.delete(id));
  }
  // Persist to disk (async, non-blocking)
  try {
    fs.writeFileSync(DEDUP_FILE, JSON.stringify({ ids: [..._processedIds] }), 'utf8');
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL MESSAGE LEARNING — Shetty Saa manually replies to a candidate →
// bot reads it, learns the tone/pattern, saves it as a training example.
// Also auto-appends the message to the candidate's RecrutOS notes.
// ─────────────────────────────────────────────────────────────────────────────
const LEARNED_MSGS_FILE = path.resolve('./learned_messages.json');

async function learnFromManualSend(toPhone, toName, manualText) {
  if (!manualText || manualText.length < 10) return;
  if (manualText.startsWith('\u200B')) return; // skip bot's own replies

  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const entry = { ts, to: toPhone, name: toName, text: manualText };

  // 1. Persist example to learned_messages.json
  try {
    let data = { examples: [] };
    if (fs.existsSync(LEARNED_MSGS_FILE)) {
      data = JSON.parse(fs.readFileSync(LEARNED_MSGS_FILE, 'utf8'));
    }
    data.examples.unshift(entry); // newest first
    if (data.examples.length > 500) data.examples = data.examples.slice(0, 500);
    fs.writeFileSync(LEARNED_MSGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}

  // 2. Append to candidate note in RecrutOS
  if (toPhone) {
    try {
      const { callMCPTool: mcp } = await import('./recrutos_mcp.js');
      await mcp('append_note', {
        identifier: toPhone,
        note: `[Boss Manual] "${manualText.slice(0, 200)}"`
      });
    } catch (_) {}
  }

  console.log(`[Learn] 📖 Manual message learned from boss → ${toName || toPhone}: "${manualText.slice(0, 60)}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-SAVE CONTACTS — when a new unknown number messages the bot,
// automatically create a WhatsApp contact so they appear named in chats.
// ─────────────────────────────────────────────────────────────────────────────
async function autoSaveContact(contact, suggestedName) {
  if (!contact) return;
  try {
    // Only save if not already in contacts
    const existing = contact.name || contact.pushname || '';
    if (existing && existing !== contact.number) return; // already has a saved name

    const name = suggestedName || contact.pushname || `Lead ${contact.number?.slice(-4) || '????'}`;
    // whatsapp-web.js exposes contact.save() to create/update contact
    if (typeof contact.save === 'function') {
      await contact.save(name, contact.number || '');
      console.log(`[AutoSave] 📇 New contact saved: ${name} (${contact.number})`);
    }
  } catch (_) { /* non-critical */ }
}

// ── Recruiter number (for human handoff notifications) ──────────────────────
const RECRUITER_WA_ID = (process.env.RECRUITER_NUMBERS || '918080635121').split(',')[0].trim().replace(/\D/g, '') + '@c.us';

// ── Helper: Send message safely with simulated typing delay ────────────────
async function safeSend(msg, text) {
  try {
    const isGroup = msg.from?.includes('@g.us');
    const isRecruiterUser = isRecruiter(cleanPhone(msg.from)) || isTrainerContact(msg.from);
    if (!isGroup && !isRecruiterUser && text && text.length > 0) {
      // Simulate realistic human typing delay (3.0 to 6.0s based on message length)
      const chatObj = await msg.getChat().catch(() => null);
      if (chatObj) {
        await chatObj.sendStateTyping().catch(() => {});
        const typingDelay = Math.min(Math.max((text.length / 28) * 1000, 3000), 6000);
        await new Promise(r => setTimeout(r, typingDelay));
      }
    }
    await msg.reply(text);
  } catch (_) {
    try { await client.sendMessage(msg.from, text); } catch (e) {
      console.error('[Bot] Could not send message:', e.message);
    }
  }
}

// ── Helper: Notify recruiter about a candidate ───────────────────────────────
async function notifyRecruiter(eventType, candidateInfo) {
  if (!RECRUITER_WA_ID) return;
  try {
    const candidateId = candidateInfo.id || '';
    const deepLink = candidateId
      ? `recrutos:///candidates/${candidateId}`
      : `recrutos:///search?q=${encodeURIComponent(candidateInfo.phone || candidateInfo.name || '')}`;
    const msgs = {
      new_candidate:
        `🆕 *New Candidate — NEED TO TALK* 📞\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 *${candidateInfo.name}*\n` +
        `📱 ${candidateInfo.phone || 'No phone'}\n` +
        `📍 ${candidateInfo.location || 'N/A'} | 💼 ${candidateInfo.experience || 'N/A'}\n` +
        `🗣️ Comm: ${candidateInfo.comm_level || 'N/A'} | 💰 Expects: ₹${candidateInfo.min_salary || 'N/A'}/mo\n\n` +
        `⚠️ *Action:* Call candidate, check communication skills & align interview options.\n` +
        `👉 *Open in RecrutOS:* ${deepLink}\n` +
        `_Auto-saved to RecrutOS Supabase._`,
      human_requested:
        `🙋 *Human Handoff Requested*\n━━━━━━━━━━━━━━\n` +
        `👤 *${candidateInfo.name || 'Candidate'}*\n` +
        `📱 ${candidateInfo.phone || candidateInfo.waId}\n\n` +
        `Please call or reply to this candidate.\n` +
        `${candidateId ? `👉 ${deepLink}` : ''}`,
    };
    const text = msgs[eventType] || `📢 Event: ${eventType}`;
    await client.sendMessage(RECRUITER_WA_ID, text);
  } catch (e) {
    console.warn('[Bot] Could not notify recruiter:', e.message);
  }
}

// ── Intake Flow Handler ───────────────────────────────────────────────────────
const NOVA_HR_INTRO =
  `Hi! 😊 I am *Nova*, HR Assistant from *Shetty Saa HR Team / Mumbai Job Alerts*!\n\n` +
  `We assist job seekers with verified openings across top BPO/ITES companies in Mumbai & Navi Mumbai (JP Morgan, TCS, Concentrix, Teleperformance, Accenture, etc.). 🏢\n` +
  `💰 Salaries: *₹18,000 – ₹60,000* per month in-hand.\n\n` +
  `📞 *Calling Hours:*\n` +
  `You can call our team from *Monday to Saturday anytime between 11:30 AM to 8:30 PM* at *+91 8080635121*.\n\n` +
  `📢 *Official WhatsApp Channel:*\n` +
  `👉 https://whatsapp.com/channel/0029Vb8x3fGIt5rzTzmaZv2v\n\n`;



/**
 * Detect if the user's reply is an evasive/off-topic answer (not answering the question).
 * e.g. if asked "your name?" and user says "who are you?" — that's NOT a name.
 */
function isEvasiveAnswer(step, answer) {
  const a = answer.toLowerCase().trim();
  if (a.length < 2) return true;

  // Spam names, polite dismissals, or questions
  const nonNamePhrases = [
    'who are you', 'who r u', 'who is this', 'who dis', 'thank you', 'thanks', 'thankyou',
    'ok', 'okay', 'yes', 'no', 'haan', 'nahi', 'k', 'auto reply', 'please call', 'call me',
    'aap kaun ho', 'kaun ho', 'kon ho', 'kya kaam hai', 'number kaha se mila'
  ];
  if (nonNamePhrases.some(p => a === p || a.startsWith(p + ' ') || a.startsWith(p + '?'))) return true;

  // Questions directed at the bot (even without '?')
  const questionMarkerRe = /^(who|what|why|how|which|where|when|are you|is this|kya|kaun|kyun|kon|yeh|aap)\b/i;
  if (questionMarkerRe.test(a)) return true;

  // Greetings instead of answering
  const greetings = ['hi', 'hello', 'hey', 'helo', 'hii', 'hiii', 'good morning', 'good evening', 'good afternoon', 'namaste', 'namaskar'];
  if (greetings.some(g => a === g || a.startsWith(g + ' ') || a.startsWith(g + '!'))) {
    return true;
  }

  // For numeric-expected steps (salary/min_salary), catch non-numeric text as evasive
  if ((step === 'salary' || step === 'min_salary') && !/\d/.test(a) && !/fresher|na|nil|no|0|zero/.test(a)) {
    return true;
  }

  return false;
}

/**
 * Extract a usable value from the answer for a given step.
 * Returns null if no usable value can be extracted.
 */
function extractStepValue(step, answer) {
  const a = answer.trim();
  const lower = a.toLowerCase();

  if (step === 'name') {
    // Rejects questions, greetings, spam, numbers, or phrases
    if (/^(who|what|why|how|which|where|when|kya|kaun|kon|aap|thank|auto|please|call|hi|hello|hey)\b/i.test(lower)) return null;
    if (/(?:thank\s*you|thanks|who\s*are\s*you|who\s*r\s*u|auto\s*reply|not\s*interested)/i.test(lower)) return null;
    if (/^\d+$/.test(lower)) return null;
    // Strip prefixes like "My name is", "I am", "Myself"
    const cleaned = a.replace(/^(?:my\s*name\s*is|i\s*am|myself|naam\s*hai)\s+/i, '').trim();
    if (cleaned.length >= 2 && cleaned.length <= 40 && isLikelyName(cleaned)) return cleaned;
    return null;
  }
  if (step === 'location') {
    return a.length >= 2 ? a : null;
  }
  if (step === 'experience') {
    if (/fresher|no exp|0 year|zero/i.test(lower) || lower === '0' || lower === 'no') return 'Fresher';
    if (/\d/.test(a) || /year|yr|exp|experienced/i.test(lower)) return a;
    return null;
  }
  if (step === 'process') {
    return a.length >= 2 ? a : null;
  }
  if (step === 'salary' || step === 'min_salary') {
    const clean = lower.replace(/,/g, '').trim();
    if (/fresher|na|nil|no/i.test(clean)) return '0';
    if (clean.includes('k')) {
      const num = parseFloat(clean.replace(/k.*/i, '').trim());
      if (!isNaN(num)) return String(Math.round(num * 1000));
    }
    const num = parseInt(clean.replace(/\D/g, ''));
    if (!isNaN(num) && num > 1000) return String(num);
    return null;
  }
  if (step === 'comm_level') {
    if (/excellent|c1|c2|fluent/i.test(lower)) return 'Excellent';
    if (/good|b2|decent/i.test(lower)) return 'Good';
    if (/average|ok|basic|b1/i.test(lower)) return 'Average';
    return a.length >= 2 ? a : null;
  }
  if (step === 'availability') {
    return a.length >= 2 ? a : null;
  }
  return a.length >= 1 ? a : null;
}

/**
 * Processes one step of the candidate intake flow.
 * - Extracts multiple fields from a single response to avoid repetitive loops.
 * - Checks past chat messages first so candidates are never re-asked already shared info.
 * - Auto-uses WhatsApp contact name if valid person's name to avoid nagging for name.
 * - Responds to "who are you" / calling hours inquiries warmly without saving as name.
 * - Returns { done: true, profile } when all steps completed, or { done: false, reply }.
 */
function processIntakeStep(waId, userText, contactName = '', chatHistory = []) {
  let state = getIntakeState(waId);

  if (!state) {
    state = { step: 'name', data: {}, stepIndex: 0, retryCount: 0 };
    setIntakeState(waId, state);
  }

  const { step, data } = state;
  const answer = (userText || '').trim();
  const lowerAnswer = answer.toLowerCase();

  // ── 0. Harvest profile fields from past messages in chatHistory ─────────────
  if (chatHistory && chatHistory.length > 0) {
    for (const m of chatHistory) {
      if (!m.fromMe && m.body) {
        const harvestedPast = extractAllProfileFields(m.body);
        Object.keys(harvestedPast).forEach(key => {
          if (harvestedPast[key] && !data[key]) {
            data[key] = harvestedPast[key];
          }
        });
      }
    }
  }

  // ── Auto-accept contactName if it's a real person name ─────────────────────
  if (!data.name && contactName && isLikelyName(contactName)) {
    data.name = contactName;
  }

  // ── Phone collection step (when WA phone could not be extracted automatically) ──
  if (step === 'phone') {
    const p = answer.replace(/\D/g, '').slice(-10);
    if (/^[6-9]\d{9}$/.test(p)) {
      data.phone = p;
      clearIntakeState(waId);
      return { done: true, profile: data };
    } else {
      return { done: false, reply: 'Please share a valid 10-digit Indian mobile number (e.g. 9887654321) so we can register your profile. 📱' };
    }
  }

  // ── 1. Check if candidate is asking an identity / calling hours / source inquiry ──
  const isWhoInquiry = /\b(who\s*(are\s*you|r\s*u|is\s*this|dis)|aap\s*kaun\s*h?o?|kaun\s*ho?|kon\s*ho?|kya\s*kaam\s*hai|whom\s*am\s*i\s*talking|tell\s*me\s*about\s*yourself|kiska\s*number)\b/i.test(lowerAnswer);
  const isSourceInquiry = /\b(kaha\s*se\s*mila|kaha\s*se\s*number|how\s*did\s*you\s*get\s*my\s*number|where\s*did\s*you\s*get|source\s*of\s*number)\b/i.test(lowerAnswer);
  const isCallingHoursInquiry = /\b(calling\s*hours?|call\s*timing|when\s*can\s*i\s*call|kab\s*call\s*karu)\b/i.test(lowerAnswer);

  if (isWhoInquiry || isSourceInquiry || isCallingHoursInquiry) {
    let nextStepForWho = step;
    if (data.name && nextStepForWho === 'name') nextStepForWho = 'location';
    const nextQ = data.name 
      ? INTAKE_QUESTIONS[nextStepForWho].replace('{name}', data.name.split(' ')[0])
      : INTAKE_QUESTIONS[nextStepForWho];
    return {
      done: false,
      reply: `${NOVA_HR_INTRO}${data.name ? `Nice connecting with you, *${data.name}*!` : 'Could you please share your full name?'} 😊\n\n${nextQ}`
    };
  }

  // ── 2. Run multi-field profile extraction from this single message ────────
  const harvested = extractAllProfileFields(userText);
  Object.keys(harvested).forEach(key => {
    if (harvested[key] && !data[key]) {
      data[key] = harvested[key];
    }
  });

  // ── 3. Anti-Looping: Check if bot already asked the same question recently ──
  if (chatHistory && chatHistory.length > 0) {
    const recentBotMsgs = chatHistory.filter(m => m.fromMe).slice(-3);
    const askedNameRecently = recentBotMsgs.some(m =>
      /full name|your name|naam.*batao|may i know your.*name/i.test(m.body || '')
    );
    if (askedNameRecently && !data.name) {
      data.name = isLikelyName(contactName) ? contactName : 'Candidate';
    }
  }

  // ── 4. Handle current step specifically if not yet filled ────────────────
  if (!data[step]) {
    if (isEvasiveAnswer(step, answer)) {
      state.retryCount = (state.retryCount || 0) + 1;
      setIntakeState(waId, state);

      if (state.retryCount <= 1) {
        const firstName = data.name ? data.name.split(' ')[0] : '';
        const clarify = {
          name:       `I'm Nova, your HR assistant 😊 Could you please share your *full name* so I can register you?`,
          location:   `${firstName ? `${firstName}, ` : ''}which area in *Mumbai* are you based in? (e.g. Malad, Thane, Andheri)`,
          experience: `Are you a *fresher* or do you have work experience? If experienced, how many years?`,
          process:    `We are primarily aligning candidates for *International Voice & Customer Ops* roles with packages up to ₹35k–₹60k. Are you comfortable with Voice process?`,
          salary:     `What is your current or last *in-hand monthly salary*? (Just share the amount in ₹)`,
          comm_level: `How would you rate your *English communication*? Excellent / Good / Average?`,
          min_salary: `What is the *minimum salary* you'd accept per month? (Amount in ₹)`,
          availability: `Are you available to attend an interview *this week*? ✅`,
        };
        return { done: false, reply: clarify[step] || INTAKE_QUESTIONS[step] };
      } else {
        if (step === 'name') data.name = isLikelyName(contactName) ? contactName : 'Candidate';
        else data[step] = step === 'salary' || step === 'min_salary' ? '0' : 'Not provided';
      }
    } else {
      const extracted = extractStepValue(step, answer);
      if (extracted !== null) {
        data[step] = extracted;
      } else {
        data[step] = (step === 'name' && isLikelyName(contactName)) ? contactName : 'Not provided';
      }

      if (step === 'experience') {
        if (lowerAnswer.includes('fresher') || data[step] === 'Fresher') {
          data.experience = 'Fresher';
          data.years = '0';
        } else {
          data.experience = 'Experienced';
          const yearMatch = answer.match(/(\d+(?:\.\d+)?)/); 
          if (yearMatch) data.years = yearMatch[1];
        }
      }
    }
  }

  // ── 5. Advance to next UNANSWERED step ─────────────────────────────────────
  state.retryCount = 0;
  let nextIndex = 0;
  while (nextIndex < INTAKE_STEPS.length) {
    const candidateStep = INTAKE_STEPS[nextIndex];
    const alreadyHave = data[candidateStep] && data[candidateStep] !== 'Not provided' && String(data[candidateStep]).trim() !== '';
    if (!alreadyHave) break;
    nextIndex++;
  }

  if (nextIndex >= INTAKE_STEPS.length) {
    clearIntakeState(waId);
    return { done: true, profile: data };
  }

  const nextStep = INTAKE_STEPS[nextIndex];
  state.step = nextStep;
  state.stepIndex = nextIndex;
  state.data = data;
  setIntakeState(waId, state);

  let question = INTAKE_QUESTIONS[nextStep];
  if (data.name) question = question.replace('{name}', data.name.split(' ')[0]);

  const prevValue = data[step];
  const acks = {
    name:         `Nice to meet you, *${data.name}*! 😊`,
    location:     `Got it — *${data.location || prevValue}*. 📍`,
    experience:   `Understood — ${data.experience === 'Fresher' ? 'fresher' : `${data.years || ''} year(s) experience`}. 💼`,
    process:      `*${data.process || prevValue}* — noted. ✅`,
    salary:       (data.salary && data.salary !== '0') ? `Current salary ₹${data.salary}/mo noted. 📊` : `Got it. 📊`,
    comm_level:   `*${data.comm_level || prevValue}* English — great. 🗣️`,
    min_salary:   (data.min_salary && data.min_salary !== '0') ? `Minimum ₹${data.min_salary}/mo — noted. 💰` : `Got it. 💰`,
  };
  const ack = (prevValue && prevValue !== 'Not provided') ? (acks[step] || '✅ Got it!') : '';
  return { done: false, reply: ack ? `${ack}\n\n${question}` : question };
}

// ── Recruiter Command Handler ─────────────────────────────────────────────────
async function handleRecruiterCommand(msg, rawText) {
  const parts = rawText.trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const arg1 = parts.slice(1).join(' ').trim();
  const args = parts.slice(1);

  // /protect and /unprotect — add/remove personal contacts from bot's blindspot
  if (cmd === '/protect') {
    if (!arg1) return safeSend(msg, '🛡️ Usage: /protect [phone] [optional name]');
    const [phone, ...nameParts] = args;
    const name = nameParts.join(' ') || 'Personal contact';
    const ok = protectContact(phone, name);
    return safeSend(msg, ok
      ? `🛡️ *${name}* (${phone}) protected. Bot will never reply to this number.`
      : `❌ Could not parse that number.`);
  }

  if (cmd === '/unprotect') {
    if (!arg1) return safeSend(msg, '🔔 Usage: /unprotect [phone]');
    unprotectContact(arg1);
    return safeSend(msg, `🔔 *${arg1}* removed from protected list. Bot will respond again.`);
  }

  if (cmd === '/protected') {
    const list = getProtectedList();
    if (!list.length) return safeSend(msg, 'ℹ️ No protected contacts configured.');
    return safeSend(msg, `🛡️ *Protected Contacts (${list.length}):*
` +
      list.map((c, i) => `${i + 1}. ${c.name || 'Unknown'} — ${c.phone}`).join('\n') +
      '\n\n_Bot silently ignores these numbers._');
  }

  if (cmd === '/training') {
    return safeSend(msg, getTrainingSummary());
  }

  // /search <name or phone>
  if (cmd === '/search' || cmd === '/s') {
    if (!arg1) return safeSend(msg, '🔍 Usage: /search [name or phone]');
    const results = await searchCandidate(arg1);
    if (!results.length) return safeSend(msg, `❌ No candidate found for: "${arg1}"`);
    const summary = results.map(c =>
      `👤 *${c.name}* | 📱 ${c.phone}\n📍 ${c.location || 'N/A'} | 💼 ${c.experience || 'N/A'} ${c.years || ''}yr\n🎯 ${c.process || 'N/A'} | 💰 ₹${c.inhand_salary || 'N/A'}\n📊 ${c.lineup_status === 'Yes' ? '✅ In Lineup' : c.joined_status === 'Yes' ? '🎉 Joined' : '⏳ Active'}`
    ).join('\n\n');
    return safeSend(msg, `🔍 *Search Results:*\n\n${summary}`);
  }

  // /lineup <name> <date YYYY-MM-DD> <company>
  if (cmd === '/lineup') {
    const [name, date, ...companyParts] = args;
    const company = companyParts.join(' ');
    if (!name || !date) return safeSend(msg, '📅 Usage: /lineup [name] [YYYY-MM-DD] [company]');
    const res = await updateCandidateStatus(name, {
      lineup_status: 'Yes',
      interview_date: date,
      process: company || undefined,
    });
    if (!res.success) return safeSend(msg, `❌ ${res.error}`);
    await addLineupFollowup(res.candidate.phone, res.candidate.name, date);
    return safeSend(msg, `✅ *${res.candidate.name}* lined up for *${company || 'interview'}* on *${date}*. Reminder auto-set.`);
  }

  // /joined <name> [company]
  if (cmd === '/joined') {
    const [name, ...companyParts] = args;
    const company = companyParts.join(' ');
    if (!name) return safeSend(msg, '✅ Usage: /joined [name] [company]');
    const res = await updateCandidateStatus(name, {
      joined_status: 'Yes',
      joined_company: company || '',
      joining_date: new Date().toISOString().split('T')[0],
    });
    if (!res.success) return safeSend(msg, `❌ ${res.error}`);
    return safeSend(msg, `🎉 *${res.candidate.name}* marked as *Joined*${company ? ` at *${company}*` : ''}!`);
  }

  // /noshow <name>
  if (cmd === '/noshow') {
    if (!arg1) return safeSend(msg, '🚫 Usage: /noshow [name]');
    const res = await updateCandidateStatus(arg1, { noshow_status: 'Yes' });
    if (!res.success) return safeSend(msg, `❌ ${res.error}`);
    return safeSend(msg, `❌ *${res.candidate.name}* marked as *No Show*.`);
  }

  // /dropout <name>
  if (cmd === '/dropout') {
    if (!arg1) return safeSend(msg, '🚪 Usage: /dropout [name]');
    const res = await updateCandidateStatus(arg1, { dropout_status: 'Yes', lineup_status: 'No' });
    if (!res.success) return safeSend(msg, `❌ ${res.error}`);
    return safeSend(msg, `🚪 *${res.candidate.name}* marked as *Dropout*.`);
  }

  // /note <name> <note text>
  if (cmd === '/note') {
    const [name, ...noteParts] = args;
    const noteText = noteParts.join(' ');
    if (!name || !noteText) return safeSend(msg, '📝 Usage: /note [name] [note text]');
    const res = await appendNote(name, noteText);
    if (!res.success) return safeSend(msg, `❌ ${res.error}`);
    return safeSend(msg, `📝 Note added to *${res.candidate.name}*.`);
  }

  // /dnd <phone>
  if (cmd === '/dnd') {
    if (!arg1) return safeSend(msg, '🔕 Usage: /dnd [phone number]');
    const added = addToDnd(arg1);
    return safeSend(msg, added ? `🔕 *${arg1}* added to DND list. Bot will ignore this number.` : `⚠️ Could not parse that number.`);
  }

  // /undnd <phone>
  if (cmd === '/undnd') {
    if (!arg1) return safeSend(msg, '🔔 Usage: /undnd [phone number]');
    const removed = removeFromDnd(arg1);
    return safeSend(msg, removed ? `🔔 *${arg1}* removed from DND list.` : `ℹ️ That number wasn't on the DND list.`);
  }

  // /pending — list numbers waiting for human
  if (cmd === '/pending') {
    const list = getPendingHumanList();
    if (!list.length) return safeSend(msg, '✅ No candidates currently waiting for a human recruiter.');
    return safeSend(msg, `🙋 *Pending Human Review (${list.length}):*\n` + list.map((id, i) => `${i + 1}. ${id}`).join('\n'));
  }

  // /jd <company>
  if (cmd === '/jd') {
    const trainingPath = path.resolve(__dirname, 'training.md');
    const training = fs.existsSync(trainingPath)
      ? fs.readFileSync(trainingPath, 'utf8')
      : (fs.existsSync(path.resolve('./training.md')) ? fs.readFileSync(path.resolve('./training.md'), 'utf8') : '');
    const q = (arg1 || '').trim().toLowerCase();
    if (!q) {
      return safeSend(msg, 'ℹ️ Usage: /jd [company name]\nExamples: /jd foundever, /jd wns, /jd concentrix, /jd jp morgan');
    }
    // Find section starting with ### ... [company]
    const sections = training.split(/(?=\n###\s+)/);
    let matched = sections.find(s => {
      const firstLine = s.trim().split('\n')[0].toLowerCase();
      return firstLine.includes(q);
    });
    if (!matched) {
      matched = sections.find(s => s.toLowerCase().includes(q));
    }
    if (matched) {
      const cleanSection = matched.split(/(?=\n##\s+)/)[0].trim();
      return safeSend(msg, cleanSection.slice(0, 1500));
    }
    const lines = training.split('\n').filter(l => l.toLowerCase().includes(q));
    if (!lines.length) return safeSend(msg, `ℹ️ No JD found for "${arg1}". Check training.md.`);
    return safeSend(msg, `🏢 *${arg1} JD:*\n` + lines.slice(0, 8).join('\n'));
  }

  // /status <name or phone>
  if (cmd === '/status') {
    if (!arg1) return safeSend(msg, '📊 Usage: /status [name or phone]');
    const results = await searchCandidate(arg1);
    if (!results.length) return safeSend(msg, `❌ Not found: "${arg1}"`);
    const c = results[0];
    return safeSend(msg,
      `📊 *${c.name}* Status\n` +
      `📱 ${c.phone} | 📍 ${c.location || 'N/A'}\n` +
      `💼 ${c.experience || 'N/A'} ${c.years ? `(${c.years}yr)` : ''}\n` +
      `🎯 Process: ${c.process || 'N/A'}\n` +
      `💰 Salary: ₹${c.inhand_salary || 'N/A'}\n` +
      `🗣️ Comms: ${c.comm_level || 'N/A'}\n` +
      `📋 Lineup: ${c.lineup_status === 'Yes' ? '✅ Yes' : 'No'}\n` +
      `🎉 Joined: ${c.joined_status === 'Yes' ? '✅ Yes' : 'No'}\n` +
      `📝 Notes: ${(c.notes || '').split('\n')[0] || 'None'}`
    );
  }

  // /activity or /updates — live activity feed
  if (cmd === '/activity' || cmd === '/updates') {
    return safeSend(msg, getRecentActivityBriefing(15));
  }

  // /help
  if (cmd === '/help' || cmd === '/menu') {
    return safeSend(msg,
      `🔧 *Recruiter Commands*\n\n` +
      `/search [name/phone] — Find candidate\n` +
      `/status [name/phone] — Full status\n` +
      `/lineup [name] [date] [company] — Set interview\n` +
      `/joined [name] [company] — Mark joined\n` +
      `/noshow [name] — Mark no-show\n` +
      `/dropout [name] — Mark dropout\n` +
      `/note [name] [text] — Add note\n` +
      `/updates — Live activity feed of all agent updates\n` +
      `/dnd [phone] — Silence a number\n` +
      `/undnd [phone] — Unsilence a number\n` +
      `/pending — List pending human handoffs\n` +
      `/jd [company] — Show JD info\n` +
      `/info — Bot status\n` +
      `/reset — Clear your chat history\n\n` +
      `_DB: ${isDbConnected() ? '🟢 RecrutOS Connected' : '🔴 DB Offline'}_`
    );
  }

  // /info
  if (cmd === '/info') {
    return safeSend(msg,
      `🤖 *RecrutOS WhatsApp Bot*\n` +
      `• Engine: Gemini 2.5 Flash (Multi-key)\n` +
      `• DB: ${isDbConnected() ? '🟢 Supabase Connected' : '🔴 Offline'}\n` +
      `• DND list: ${isOnDnd('check') ? '?' : '✅ Active'}\n` +
      `• Status: 🟢 Online`
    );
  }

  // /new, /reset, /clear
  if (cmd === '/new' || cmd === '/reset' || cmd === '/clear') {
    resetUserHistory(msg.from);
    clearIntakeState(msg.from);
    const { resetSessionContext } = await import('./saa_trainer_chat.js');
    const forgotten = resetSessionContext();
    return safeSend(msg,
      `🔄 *Fresh Session Started, Shetty Saa!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
      (forgotten ? `🗑️ Forgotten previous candidate: *${forgotten}*\n` : '') +
      `🧹 Cleared active candidate context & temporary conversation memory.\n\n` +
      `Ready for fresh instructions! What would you like to do next? 🚀`
    );
  }

  // /savecontact [phone] [name] — manually save any number as a WA contact
  // Example: /savecontact 919876543210 Ganesh Kumar
  if (cmd === '/savecontact' || cmd === '/sc') {
    const [phone, ...nameParts] = args;
    const name = nameParts.join(' ').trim();
    if (!phone || !name) {
      return safeSend(msg, '📇 Usage: /savecontact [phone with country code] [Full Name]\nExample: /savecontact 919876543210 Ganesh Kumar');
    }
    const { saveWhatsAppContact } = await import('./contact_saver.js');
    const result = await saveWhatsAppContact(client, phone, name, 'BPO Candidate');
    if (result.ok) {
      return safeSend(msg, `✅ *Contact Saved!*\n📇 *${name}* (${phone})\nMethod: ${result.method}`);
    } else {
      return safeSend(msg, `⚠️ Could not auto-save: ${result.error}\n\nTip: Send the contact as a vCard from your phone's contacts app.`);
    }
  }

  // /saveall — batch save ALL RecrutOS candidates as WA contacts
  if (cmd === '/saveall') {
    await safeSend(msg, '📇 Starting batch contact save from RecrutOS...\n_(This may take a minute)_');
    try {
      const { getClient } = await import('./recruiter_db.js').catch(() => ({ getClient: () => null }));
      const db = getClient ? getClient() : null;
      if (!db) return safeSend(msg, '❌ DB not connected.');

      const { data: candidates } = await db
        .from('ros_candidates')
        .select('name, phone, experience, process')
        .not('phone', 'is', null)
        .neq('phone', '')
        .limit(200);

      if (!candidates?.length) return safeSend(msg, 'ℹ️ No candidates with phone numbers found.');

      const { saveWhatsAppContact } = await import('./contact_saver.js');
      let saved = 0, failed = 0;
      for (const c of candidates) {
        try {
          const r = await saveWhatsAppContact(client, c.phone, c.name, c.process || 'BPO');
          if (r.ok) saved++; else failed++;
          await new Promise(res => setTimeout(res, 120)); // small gap to avoid rate limit
        } catch (_) { failed++; }
      }
      return safeSend(msg, `✅ *Batch Contact Save Done!*\n📇 Saved: *${saved}* | ⚠️ Failed: ${failed}\n_All candidates now visible by name in WhatsApp._`);
    } catch (e) {
      return safeSend(msg, `❌ Batch save error: ${e.message}`);
    }
  }

  return false; // not a recruiter command
}


// ── WhatsApp Events ──────────────────────────────────────────────────────────

client.on('qr', (qr) => {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('📱 SCAN THIS QR CODE WITH WHATSAPP:');
  console.log('   (WhatsApp → Linked Devices → Link a Device)');
  console.log('═══════════════════════════════════════════════════════\n');
  qrcodeTerminal.generate(qr, { small: true });
  console.log('\nWaiting for scan...\n');
});

client.on('authenticated', () => console.log('🔑 Authentication successful!'));
client.on('auth_failure', (msg) => console.error('❌ Auth failed:', msg));

client.on('ready', async () => {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('🎉 RecrutOS WhatsApp Recruitment Bot is ONLINE!');
  console.log('🤖 Recruiter AI Skills Active:');
  console.log('   • 👤 Candidate Intake (8-step flow)');
  console.log('   • 🗄️  RecrutOS Supabase Integration');
  console.log('   • 📄 Resume PDF/Image Parsing');
  console.log('   • 🎙️ Voice Note Understanding');
  console.log('   • 🌐 Agent Reach (Web Links)');
  console.log('   • 🔕 DND List + Human Handoff');
  console.log('   • 🔑 Multi-Key Gemini Rotation');
  console.log('   • 🔗 RecrutOS MCP Connector (12 tools)');
  console.log('   • ⏰ Autonomous Saa Scheduler (6 tasks)');
  console.log('   • 🧠 Pattern Learner (Real Candidate Intelligence)');
  console.log('💬 Listening for candidates and recruiters...');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Set WhatsApp client for MCP logging & outreach ──────────────
  setMcpWaClient(client);

  // ── Start the autonomous scheduler ──────────────────────────────────────
  startScheduler(client);

  // ── Start RecrutOS Live Intelligence Window (Tracks Boss manual edits & call notes) ──
  startRecrutOSSyncWindow();

  // ── Pattern Learner — reads real RecrutOS notes, rebuilds AI training ────
  // Runs on startup then every 6 hours. AI always trained on latest data.
  try {
    await runPatternLearner();
    console.log('🧠 [PatternLearner] AI trained from live RecrutOS candidate data.');
  } catch (e) {
    console.warn('[PatternLearner] Startup run skipped:', e.message);
  }
  setInterval(async () => {
    try { await runPatternLearner(); } catch (_) {}
  }, 6 * 60 * 60 * 1000); // refresh every 6 hours
});


// ── Main Message Handler & Per-User Sequential Queue ─────────────────────────
// Prevents race conditions and duplicate replies when a candidate sends multiple rapid messages.
const _userMsgQueues = new Map();
const _candidateDebounceTimers = new Map();
const _candidateBufferedTexts = new Map();
const _candidateLatestMsgs = new Map();

function enqueueUserMessage(talkerId, taskFn) {
  const currentQueue = _userMsgQueues.get(talkerId) || Promise.resolve();
  const nextQueue = currentQueue
    .then(taskFn)
    .catch((err) => console.error(`[QueueError] for ${talkerId}:`, err?.message || err))
    .finally(() => {
      if (_userMsgQueues.get(talkerId) === nextQueue) {
        _userMsgQueues.delete(talkerId);
      }
    });
  _userMsgQueues.set(talkerId, nextQueue);
}

client.on('message', async (msg) => {
  if (msg.from === 'status@broadcast') return;

  const talkerId = msg.from;
  const isGroup = msg.from.includes('@g.us');
  const cleanTalker = cleanPhone(talkerId);
  const isRecruiterUser = isRecruiter(cleanTalker) || isFromTrainerContact(talkerId) || isTrainerContact(talkerId);

  // Recruiter commands, group chats, or media attachments process immediately without debounce delay
  if (isGroup || isRecruiterUser || msg.hasMedia) {
    if (_candidateDebounceTimers.has(talkerId)) {
      clearTimeout(_candidateDebounceTimers.get(talkerId));
      _candidateDebounceTimers.delete(talkerId);
      _candidateBufferedTexts.delete(talkerId);
      _candidateLatestMsgs.delete(talkerId);
    }
    return enqueueUserMessage(talkerId, () => handleIncomingMessage(msg));
  }

  // Candidate messages: buffer rapid-fire bursts (8-second debounce window) to prevent spamming
  const prevText = _candidateBufferedTexts.get(talkerId) || '';
  const newText = prevText ? `${prevText}\n${(msg.body || '').trim()}` : (msg.body || '').trim();
  _candidateBufferedTexts.set(talkerId, newText);
  _candidateLatestMsgs.set(talkerId, msg);

  if (_candidateDebounceTimers.has(talkerId)) {
    clearTimeout(_candidateDebounceTimers.get(talkerId));
  }

  // Send typing state while candidate is typing multiple bubbles
  msg.getChat().then(chat => chat?.sendStateTyping().catch(() => {})).catch(() => {});

  const timer = setTimeout(() => {
    _candidateDebounceTimers.delete(talkerId);
    const buffered = _candidateBufferedTexts.get(talkerId);
    const latestMsg = _candidateLatestMsgs.get(talkerId) || msg;
    _candidateBufferedTexts.delete(talkerId);
    _candidateLatestMsgs.delete(talkerId);

    enqueueUserMessage(talkerId, () => handleIncomingMessage(latestMsg, buffered));
  }, 8000); // 8-second debounce

  _candidateDebounceTimers.set(talkerId, timer);
});

async function handleIncomingMessage(msg, overrideText = null) {

  // ── DEDUP GUARD — reject any message ID we already processed ─────────────
  const msgId = msg.id?._serialized || msg.id?.id || '';
  if (msgId && isAlreadyProcessed(msgId) && !overrideText) {
    console.log(`[Dedup] 🚫 Skipping already-processed message: ${msgId.slice(-12)}`);
    return;
  }
  if (msgId) markProcessed(msgId);

  const talkerId = msg.from;
  const rawText = (overrideText !== null ? overrideText : (msg.body || '')).trim();
  const lowerText = rawText.toLowerCase();

  // ── REPLY AWARENESS — update cooldown so scheduler won't spam this person ──
  // Any incoming message = candidate is engaged. Suppress outreach for 4 hours.
  if (!msg.from.includes('@g.us') && !msg.from.includes('status@')) {
    const senderPhone = msg.from.replace('@c.us', '').replace(/\D/g, '').slice(-10);
    if (senderPhone) recordReply(senderPhone);
  }

  const isGroup = msg.from.includes('@g.us');
  let groupChat = null;
  let isShettyOfficeGroup = false;

  let chat = null;
  try {
    chat = await msg.getChat().catch(() => null);
  } catch (_) {}

  if (isGroup) {
    groupChat = chat;
    const groupName = groupChat?.name || '';
    isShettyOfficeGroup = /shetty\s*office|saa\s*office|recrutos|mark.?liii/i.test(groupName);

    // Only allow Shetty Office / Saa Office / RecrutOS group chats
    if (!isShettyOfficeGroup) return;
  }

  // ── Contact Info & Real Phone Resolution (handles @lid linked identities) ──
  const contact = await msg.getContact().catch(() => null);
  const contactName = contact?.pushname || contact?.name || 'Friend';
  const chatName = chat?.name || '';
  const contactSavedName = contact?.name || '';
  const contactPushName = contact?.pushname || '';

  const realPhone = await resolveRealPhone(client, talkerId, contact, msg, chat);
  if (realPhone) {
    recordReply(realPhone);
    registerLidMapping(talkerId, realPhone);
  }

  // ── Boss / Office Chat Detection ──────────────────────────────────────────
  const isOfficeNamedChat =
    /saa\s*office|shetty\s*office/i.test(chatName) ||
    /saa\s*office|shetty\s*office/i.test(contactSavedName) ||
    /shetty\s*saa/i.test(contactPushName);

  const senderIsRecruiter =
    isRecruiter(talkerId) ||
    (realPhone && isRecruiter(realPhone)) ||
    isFromTrainerContact(msg) ||
    (realPhone && isFromTrainerContact(realPhone)) ||
    isTrainerContact(talkerId) ||
    (realPhone && isTrainerContact(realPhone)) ||
    isOfficeNamedChat ||
    isShettyOfficeGroup;

  // ── Trainer Contact, Shetty Office Group & Recruiter Operations Console ──
  if (senderIsRecruiter) {
    // Whitelist this ID so future checks are instantaneous
    addRecruiterNumber(talkerId);
    if (realPhone) addRecruiterNumber(realPhone);

    // Ensure boss is never tracked in candidate intake or new-user flows
    clearIntakeState(talkerId);
    unmarkUserSeen(talkerId);
    if (realPhone) {
      clearIntakeState(realPhone);
      unmarkUserSeen(realPhone);
    }

    // If recruiter issues a specific slash command (/lineup, /joined, /dnd, etc.)
    if (rawText.startsWith('/') && !rawText.startsWith('/train')) {
      const handled = await handleRecruiterCommand(msg, rawText);
      if (handled !== false) return;
    }

    // All messages (queries, updates, trainer chat) route to Saa Commander
    console.log(`\n🧠 [SaaTrainer] Commander message from ${contactName} (${realPhone || talkerId}) in ${isShettyOfficeGroup ? `Group (${groupChat?.name})` : (chatName || 'Direct')}: "${rawText.slice(0, 80)}"`);

    try {
      const activeChat = groupChat || chat || await msg.getChat().catch(() => null);
      if (activeChat) await activeChat.sendStateTyping().catch(() => {});
    } catch (_) {}

    const reply = await handleTrainerChatMessage(rawText, client, {
      talkerId,
      realPhone,
      name: contactName || 'Shetty Saa (Boss)',
      isRecruiter: true,
      isGroup: isShettyOfficeGroup,
      groupChat
    });

    if (reply) {
      if (groupChat) {
        await groupChat.sendMessage(reply);
      } else {
        await safeSend(msg, reply);
      }
      console.log(`✅ [SaaTrainer] Replied to commander: "${reply.slice(0, 70)}"`);
    }
    return; // ALWAYS return for recruiter/boss — never fall through to candidate intake!
  }

  // ── Protected Contact Check (Nova's personal world boundary) ───────────
  if (isProtectedContact(talkerId) || (realPhone && isProtectedContact(realPhone))) {
    logProtectedContactAttempt(talkerId, contactName);
    return; // Silent ignore — never reply to personal contacts
  }

  // ── DND Check ────────────────────────────────────────────────────────────
  const candidatePhone = realPhone || phoneFromWaId(talkerId);
  if (candidatePhone && isOnDnd(candidatePhone)) {
    console.log(`🔕 [DND] Ignoring message from ${talkerId} (${candidatePhone})`);
    return;
  }

  // ── Spam / Auto-Reply / System Message Guard ─────────────────────────────
  // CRITICAL: These messages must NEVER get a reply or be saved as candidates.
  // Catches: marketing, bank alerts, OTPs, auto-replies, delivery, govt msgs.
  const rawTextForSpam = (msg.body || '');
  if (rawTextForSpam) {
    const SPAM_PATTERNS = [
      // Auto-replies
      /thank you for (getting in touch|contacting|reaching out|your (message|enquiry|query|interest))/i,
      /this is an auto(mated)?\s*(reply|response|message|notification)/i,
      /out of (office|station)|on\s*(leave|vacation|holiday)/i,
      /will (respond|get back|reply) (to you )?(within|in|shortly|soon)/i,
      // Financial / bank / CRED
      /please note.{0,50}(cred|bank|hdfc|icici|sbi|kotak|axis|rbl|yes bank)/i,
      /cred (or its|support|team|customer)|connect with cred/i,
      /never ask you to share.{0,60}(otp|cvv|card|pin)/i,
      /dear (customer|user|member|valued|applicant)/i,
      /as per your (request|instruction|query)/i,
      /your (loan|emi|policy|premium|mandate|nach)/i,
      // OTP / transaction
      /\bOTP\b|one.?time.?pass/i,
      /\b(debit|credit)ed?\b.{0,30}\u20b9|\u20b9\s*\d+.{0,30}(debit|credit)/i,
      /your (transaction|account|order|booking|payment|ticket|invoice|statement)/i,
      // Marketing / promo
      /flat \d+% off|upto \d+% off/i,
      /promo\s*code|coupon\s*code|discount\s*code|cashback of/i,
      /unsubscribe|opt.?out|reply stop|to stop\s+sms/i,
      /limited\s*time\s*offer|exclusive\s*offer|special\s*offer/i,
      /\b(CODE:|code:)\s*[A-Z0-9]{4,}/,
      // Delivery / logistics
      /out for delivery|expected delivery|track your (order|shipment|parcel)/i,
      /shipment.{0,30}(dispatched|shipped|delivered|delayed)/i,
      // Govt / UIDAI / EPFO
      /uidai|aadhar|aadhaar|pan card|epf\s*balance|epfo/i,
      // Mutual funds / stocks
      /nav of \u20b9|mutual fund|sip (amount|deduction|reminder)/i,
    ];
    if (SPAM_PATTERNS.some(p => p.test(rawTextForSpam))) {
      console.log(`🚫 [Spam/AutoReply] Blocked from ${talkerId}: "${rawTextForSpam.slice(0, 60).replace(/\n/g, ' ')}"`);
      return;
    }
    // Drop messages that START with auto-reply phrases (catches edge cases)
    const AUTO_STARTS = [
      'thank you for', 'thanks for contacting', 'this is an auto',
      'out of office', 'dear customer', 'please note:', 'we have received your',
      'your request has been', 'we will get back', 'hi, thank you',
    ];
    if (AUTO_STARTS.some(s => rawTextForSpam.toLowerCase().trimStart().startsWith(s))) {
      console.log(`🚫 [AutoReply] Blocked auto-reply from ${talkerId}`);
      return;
    }
    // Drop bulk forwards: very long + many bullets + a link
    if (rawTextForSpam.length > 280) {
      const bullets = (rawTextForSpam.match(/^[\*\-•]/gm) || []).length;
      const hasLink = /https?:\/\//.test(rawTextForSpam);
      if (bullets >= 4 && hasLink) {
        console.log(`🚫 [Spam] Dropped bulk forward from ${talkerId}`);
        return;
      }
    }
  }


  // /reset — universal
  if (lowerText === '/reset' || lowerText === '/clear') {
    resetUserHistory(talkerId);
    clearIntakeState(talkerId);
    clearHumanFlag(talkerId);
    return safeSend(msg, '🧹 Conversation cleared! Let\'s start fresh.');
  }

  // ── Human Handoff: candidate still waiting? ──────────────────────────────
  if (isWaitingForHuman(talkerId)) {
    // Allow them to message but remind them
    if (rawText.length > 0) {
      return safeSend(msg, `Our recruiter will call you shortly on this number. Please keep your phone available. For urgent queries: *+91 8080635121* 📞`);
    }
    return;
  }

  // ── Media Handling ────────────────────────────────────────────────────────
  let mediaParts = [];
  let targetMediaMsg = null;

  if (msg.hasMedia) {
    targetMediaMsg = msg;
  } else if (msg.hasQuotedMsg) {
    const quoted = await msg.getQuotedMessage().catch(() => null);
    if (quoted?.hasMedia) targetMediaMsg = quoted;
  }

  if (targetMediaMsg) {
    console.log(`📸 [Media] Type: ${targetMediaMsg.type} from ${contactName}`);
    const media = await downloadMediaSafe(client, targetMediaMsg);
    if (media?.data) {
      mediaParts = await processMediaForAI(media);
      const sizeKB = Math.round(media.data.length * 0.75 / 1024);
      console.log(`✅ [Media Ready]: ${media.mimetype} (~${sizeKB} KB)`);
      recentUserMedia.set(talkerId, { mediaParts, timestamp: Date.now(), type: targetMediaMsg.type });

      // Resume/PDF special handling — parse PDFs, Word docs, octet-streams, or CV images
      const isPdf = media.mimetype?.includes('pdf') || media.mimetype?.includes('document') || media.mimetype?.includes('msword') || media.mimetype?.includes('officedocument') || media.mimetype?.includes('octet-stream');
      const isImage = media.mimetype?.startsWith('image/');
      const hasResumeKeywords = /resume|cv|biodata|bio\s*data|curriculum|profile|experience|skills|education/i.test(rawText || '') ||
        /resume|cv|biodata/i.test(targetMediaMsg.filename || '');
      const isExplicitResume = isPdf || (isImage && (hasResumeKeywords || !rawText || rawText.length < 50));

      if (isExplicitResume) {
        console.log(`📄 [Resume Detected] Parsing resume for ${contactName} (${candidatePhone})...`);
        try {
          await (async () => {
            const chat = await msg.getChat().catch(() => null);
            if (chat) await chat.sendStateTyping().catch(() => {});
          })();
          await safeSend(msg, `Got the document! Scanning details... 📄`);
          const parsed = await parseResumeWithAI(rawText || '', mediaParts);

          // ALWAYS use WhatsApp sender phone — never let it be empty
          const senderPhone = candidatePhone || phoneFromWaId(talkerId);
          const senderName = contactName || 'Friend';

          // Look up sender record beforehand so existing sender is known
          const senderMatches = senderPhone ? await searchCandidate(senderPhone).catch(() => []) : [];
          const existingSenderRecord = (senderMatches && senderMatches.length > 0) ? senderMatches[0] : null;

          // ── MULTI-RESUME & REFERRAL DETECTION LAW ─────────────────────────
          // If the resume has a different phone number or name from the sender,
          // OR sender text indicates a referral, treat as an independent referral!
          const referralResult = isReferralResume(
            senderPhone,
            senderName,
            parsed?.phone,
            parsed?.name,
            rawText || '',
            existingSenderRecord
          );

          if (referralResult.isReferral) {
            console.log(`🤝 [Referral] Resume from ${senderName} (${senderPhone}) is a referral for ${parsed?.name || 'Candidate'} (${parsed?.phone || 'No phone'}) [Reason: ${referralResult.reason}]`);
            const outcome = await handleReferralResume(client, senderPhone, senderName, parsed, rawText);
            await safeSend(msg, outcome.ackText);
            return;
          }

          const resolvedName = (parsed?.name && isLikelyName(parsed.name)) ? parsed.name : (isLikelyName(contactName) ? contactName : `Candidate ${senderPhone.slice(-4)}`);

          // Sync to Candidate Knowledge Graph (provenance & state)
          if (senderPhone) {
            await syncResumeToGraph(senderPhone, parsed).catch(() => {});
            clearIntakeState(talkerId);
          }

          // Use previously fetched sender record
          const existingMatches = senderMatches;


          if (existingMatches && existingMatches.length > 0) {
            // ── UPDATE existing candidate ─────────────────────────────────────
            const existing = existingMatches[0];
            const updates = {};
            if (parsed?.name && isLikelyName(parsed.name) && (!existing.name || !isLikelyName(existing.name) || existing.name === 'Ask Name')) {
              updates.name = parsed.name;
            }
            if (parsed?.experience) updates.experience = parsed.experience;
            if (parsed?.years)      updates.years = String(parsed.years);
            if (parsed?.inhand_salary) updates.inhand_salary = String(parsed.inhand_salary);
            if (parsed?.comm_level) updates.comm_level = parsed.comm_level;
            if (parsed?.location && !existing.location) updates.location = parsed.location;
            if (parsed?.process && !parsed?.process_unknown && !existing.process) updates.process = parsed.process;
            if (parsed?.last_company) updates.last_company = parsed.last_company;
            if (parsed?.qualification) updates.qualification = parsed.qualification;

            // Save all companies so we never pitch a company they already worked at
            if (parsed?.companies_list?.length > 0) {
              updates.companies_json = JSON.stringify(parsed.companies_list);
            }

            if (Object.keys(updates).length > 0) {
              await updateCandidateStatus(senderPhone, updates);
            }

            const noteLines = [];
            if (parsed?.experience) noteLines.push(`Exp: ${parsed.experience} (${parsed.years || '0'}y)`);
            if (parsed?.inhand_salary) noteLines.push(`CTC: ₹${parsed.inhand_salary}`);
            if (parsed?.currently_working) noteLines.push(`Working: ${parsed.currently_working}`);
            if (parsed?.on_notice === 'Yes') noteLines.push(`Notice: ${parsed.notice_period || 'serving notice'}`);
            if (noteLines.length > 0) {
              await appendNote(senderPhone, `[CV via WhatsApp] ${noteLines.join(' | ')}`);
            }

            const cvAlert = `📄 *CV Updated — ${existing.name}* (📱 ${existing.phone})\n` +
              `━━━━━━━━━━━━━━\n${noteLines.join('\n') || 'Details updated.'}\n_Auto-updated in RecrutOS_`;
            await notifyTrainerAndOffice(client, cvAlert);

            await logAgentActivity(client, {
              action: 'CV Parsed & Updated',
              category: 'CV',
              candidateName: existing.name,
              candidatePhone: existing.phone,
              candidateId: existing.id,
              details: noteLines.join(' | ') || 'Profile details updated via CV',
              source: 'WhatsApp CV Parser',
              notifyBoss: false, // cvAlert already sent to boss/office
            });

            // Save/refresh WA contact with current name
            saveCandidateContact(client, { name: existing.name, phone: existing.phone, experience: existing.experience || '', process: existing.process || 'BPO' }).catch(() => {});

            // Smart follow-up reply based on parsed data
            const followUp = buildCVFollowUp(resolvedName, parsed, existing);
            await safeSend(msg, followUp);
            return;
          }

          // ── CREATE new candidate — phone is ALWAYS the WA sender ────────────
          const profile = {
            name:           resolvedName,
            phone:          senderPhone,          // ← CRITICAL: always WA sender phone
            location:       parsed?.location || '',
            experience:     parsed?.experience || '',
            years:          parsed?.years || '',
            process:        parsed?.process || '',
            inhand_salary:  parsed?.inhand_salary || '',
            comm_level:     parsed?.comm_level || '',
            last_company:   parsed?.last_company || '',
            qualification:  parsed?.qualification || '',
            notes: [
              parsed?.currently_working ? `Currently working: ${parsed.currently_working}` : '',
              parsed?.on_notice === 'Yes' ? `On notice: ${parsed.notice_period || 'yes'}` : '',
            ].filter(Boolean).join(' | '),
          };
          await handleIntakeComplete(talkerId, contactName, profile, msg);

          // Smart follow-up after saving
          const followUp = buildCVFollowUp(resolvedName, parsed, null);
          await safeSend(msg, followUp);
          return;

        } catch (e) {
          console.warn('[Bot] Resume parsing failed:', e.message);
          // Even if parsing fails, ask the candidate follow-up questions
          await safeSend(msg, buildCVFallback(contactName));
          return;
        }
      }
    }
  }

  // Use recent cached media for follow-up questions
  if (mediaParts.length === 0 && rawText) {
    const cached = recentUserMedia.get(talkerId);
    if (cached && (Date.now() - cached.timestamp < MEDIA_CACHE_TTL)) {
      const lower = rawText.toLowerCase();
      if (lower.length < 60 || lower.match(/this|it|what|which|explain|song|photo|video|resume/)) {
        mediaParts = cached.mediaParts;
      }
    }
  }

  // ── Agent Reach (Web URLs) ────────────────────────────────────────────────
  let webContext = '';
  if (!isInIntakeFlow(talkerId)) {
    const urls = extractUrls(rawText);
    if (urls.length > 0) {
      console.log(`🌐 [Agent Reach] ${urls.length} link(s) from ${contactName}`);
      for (const url of urls.slice(0, 2)) {
        const pageMarkdown = await readUrlContent(url);
        webContext += `\n\n---\n🌐 [Web: ${url}]\n${pageMarkdown}\n---`;
      }
    }
  }

  // ── MANDATORY CHAT HISTORY LOADING & PAST MESSAGE AWARENESS (AT LEAST 500 MESSAGES) ──
  // Nova MUST ALWAYS fetch at least the last 500 messages before responding to any candidate
  // to check if it already has any kind of information and never repeat questions.
  let chatHistory = [];
  let formattedHistory = '';
  try {
    const activeChat = chat || await msg.getChat().catch(() => null);
    if (activeChat) {
      chatHistory = await fetchLast500Messages(activeChat, 500);
      if (chatHistory && chatHistory.length > 0) {
        formattedHistory = chatHistory.map(m => {
          const sender = m.fromMe ? '🤖 Nova (Assistant)' : `👤 Candidate (${contactName})`;
          const body = m.body ? m.body.trim().replace(/\n+/g, ' ') : (m.hasMedia ? `[Media / ${m.type || 'Attachment'}]` : '');
          return `${sender}: ${body}`;
        }).filter(l => !l.endsWith(': ')).join('\n');
      }
      console.log(`📜 [ChatHistory] Loaded ${chatHistory.length} messages from chat with ${contactName} (${candidatePhone || talkerId})`);
    }
  } catch (err) {
    console.warn('[ChatHistory] Error fetching chat history:', err.message);
  }

  // Also support external history queries from recruiter
  let historyContext = formattedHistory;
  if (detectHistoryIntent(rawText) && senderIsRecruiter && isExternalHistoryQuery(rawText)) {
    const targetPhone = extractPhoneFromHistoryQuery(rawText);
    if (targetPhone) {
      historyContext = await getContactHistorySummary(client, targetPhone, 60);
    }
  }

  if (!rawText && mediaParts.length === 0 && !webContext && !historyContext) return;

  console.log(`📩 [${senderIsRecruiter ? 'RECRUITER' : 'CANDIDATE'}] ${contactName} (${candidatePhone || talkerId}): ${rawText || '[attachment]'}`);

  // ── Vendor / Broadband / Promo Message Guard ─────────────────────────────
  // If an ISP / router / broadband flyer message is sent, acknowledge politely without running BPO intake
  const isVendorPromo = /microscan|broadband|fast internet|best offer fast|wifi.*router|installation free|optical fiber|unlimited data/i.test(rawText || '');
  if (!senderIsRecruiter && isVendorPromo) {
    console.log(`📡 [VendorPromo] Vendor promotion detected from ${contactName} (${talkerId})`);
    clearIntakeState(talkerId);
    markUserSeen(talkerId);
    await safeSend(msg, `Thank you for sharing the broadband offer details! 👍\n\nWe are a corporate recruitment desk specializing in BPO / ITES hiring across Mumbai & Navi Mumbai. If you or anyone in your team is ever looking for job opportunities, feel free to reach out to us here.\n\nOur Calling Hours: Monday to Saturday, 11:30 AM to 8:30 PM (+91 8080635121). Have a great day!`);
    return;
  }

  // ── Auto-Sync & Recognize Existing Candidate in RecrutOS Supabase ─────────
  let existingCand = null;
  if (!senderIsRecruiter && !isShettyOfficeGroup) {
    // 1. Check RecrutOS database by phone
    if (candidatePhone) {
      const matches = await searchCandidate(candidatePhone);
      if (matches && matches.length > 0) existingCand = matches[0];
    }
    // 2. Check RecrutOS database by contact display name
    if (!existingCand && isLikelyName(contactName)) {
      const nameMatches = await searchCandidate(contactName);
      if (nameMatches && nameMatches.length > 0) {
        existingCand = nameMatches[0];
        if (candidatePhone && existingCand.phone !== candidatePhone) {
          await updateCandidateStatus(existingCand.phone || existingCand.name, { phone: candidatePhone });
        }
      }
    }
  }

  // ── PENDING REFERRAL PHONE NUMBER RESOLUTION ─────────────────────────────
  // If this contact recently uploaded a referral resume without a phone number,
  // and now sends a text message containing the phone number, resolve it immediately!
  if (!senderIsRecruiter && !isShettyOfficeGroup && rawText) {
    const senderPh = candidatePhone || phoneFromWaId(talkerId);
    if (senderPh) {
      const resolvedAck = await checkAndResolvePendingReferral(client, senderPh, contactName, rawText);
      if (resolvedAck) {
        await safeSend(msg, resolvedAck);
        return;
      }
    }
  }

  // ── DEEP LOCAL CHAT INTELLIGENCE SCAN (Zero LLM Tokens) ───────────────
  // Scans up to 500 messages purely in Node.js browser session (0 Gemini tokens)
  let chatAnalysis = analyzeChatHistory500(chatHistory, contactName, candidatePhone, existingCand);

  // If candidate was not found by direct phone, check if a phone was harvested from past messages
  if (!senderIsRecruiter && !isShettyOfficeGroup && !existingCand && chatAnalysis.harvestedProfile?.phone) {
    const matchesByPastPhone = await searchCandidate(chatAnalysis.harvestedProfile.phone);
    if (matchesByPastPhone && matchesByPastPhone.length > 0) {
      existingCand = matchesByPastPhone[0];
      console.log(`🎯 [CandidateDB] Recognized candidate from harvested chat phone: ${existingCand.name} (${existingCand.phone})`);
      chatAnalysis = analyzeChatHistory500(chatHistory, contactName, candidatePhone, existingCand);
    }
  }

  // ── AUTO-CREATE NEW USER IN RECRUTOS SUPABASE ─────────────────────────────
  // If candidate is NOT in Supabase database, create a new record immediately
  // before talking to them, so all future details and notes sync directly to RecrutOS.
  if (!senderIsRecruiter && !isShettyOfficeGroup && !existingCand) {
    const rawDigits = cleanPhone(candidatePhone) || (candidatePhone ? candidatePhone.replace(/\D/g, '').slice(-10) : '');
    if (rawDigits && /^[6-9]\d{9}$/.test(rawDigits)) {
      try {
        const ts = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
        const initExtracted = extractAllProfileFields(rawText);
        const chosenName = (isLikelyName(contactName) ? contactName.trim() : (initExtracted.name || `Candidate ${rawDigits.slice(-4)}`));

        const newCandPayload = {
          name: chosenName,
          phone: rawDigits,
          location: initExtracted.location || '',
          experience: initExtracted.experience || '',
          years: initExtracted.years || '',
          process: initExtracted.process || 'New - WhatsApp',
          inhand_salary: initExtracted.salary || '',
          last_company: initExtracted.last_company || '',
          qualification: initExtracted.qualification || '',
          process_status: 'Need to Talk',
          notes: `[${ts}] First WhatsApp contact received: "${rawText ? rawText.slice(0, 120).replace(/\n/g, ' ') : '[attachment]'}"`
        };

        const createRes = await addCandidateToRecrutOS(newCandPayload);
        if (createRes?.success && createRes?.data) {
          existingCand = createRes.data;
          console.log(`✨ [CandidateDB] Auto-created new candidate in RecrutOS: ${chosenName} (${rawDigits})`);

          // Save contact to phonebook with "Need to Talk" tag so recruiter can call & evaluate
          saveCandidateContact(client, {
            name: chosenName,
            phone: rawDigits,
            experience: initExtracted.experience || '',
            process: initExtracted.process || 'WhatsApp Lead'
          }).catch(() => {});

          // Refresh chat analysis with newly created candidate
          chatAnalysis = analyzeChatHistory500(chatHistory, contactName, candidatePhone, existingCand);
        }
      } catch (createErr) {
        console.warn('[CandidateDB] Auto-create candidate error:', createErr.message);
      }
    }
  }

  // ── CONTINUOUS LIVE SYNC: UPDATE DATABASE COLUMNS & NOTES ON EVERY MESSAGE ──
  if (!senderIsRecruiter && !isShettyOfficeGroup && existingCand) {
    clearIntakeState(talkerId);
    markUserSeen(talkerId);

    try {
      const ts = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
      const replySnippet = rawText ? rawText.slice(0, 150) : (msg.hasMedia ? '[Attachment / Media]' : '');
      const lowerReply = (rawText || '').toLowerCase();

      // Extract all profile fields from current message
      const extracted = extractAllProfileFields(rawText);

      // Merge any details discovered by the local 500-message scan if Supabase was missing them
      if (chatAnalysis.harvestedProfile) {
        const hp = chatAnalysis.harvestedProfile;
        if (hp.location && !extracted.location && (!existingCand.location || existingCand.location === 'Mumbai')) extracted.location = hp.location;
        if (hp.experience && !extracted.experience && !existingCand.experience) extracted.experience = hp.experience;
        if (hp.years && !extracted.years && !existingCand.years) extracted.years = hp.years;
        if (hp.process && !extracted.process && (!existingCand.process || existingCand.process === 'New - WhatsApp')) extracted.process = hp.process;
        if (hp.salary && !extracted.salary && !existingCand.inhand_salary) extracted.salary = hp.salary;
        if (hp.last_company && !extracted.last_company && !existingCand.last_company) extracted.last_company = hp.last_company;
      }

      const colUpdates = {};

      // 1. Name update if candidate shared actual full name and existing is placeholder
      if (extracted.name && extracted.name !== existingCand.name && (!existingCand.name || existingCand.name.startsWith('Candidate '))) {
        colUpdates.name = extracted.name;
      }
      // 2. Location (only update if different, and avoid re-setting generic 'Mumbai')
      if (extracted.location && extracted.location !== existingCand.location) {
        if (!existingCand.location || (existingCand.location === 'Mumbai' && extracted.location !== 'Mumbai')) {
          colUpdates.location = extracted.location;
        }
      }
      // 3. Experience & Years
      if (extracted.experience && extracted.experience !== existingCand.experience && !existingCand.experience) {
        colUpdates.experience = extracted.experience;
      }
      if (extracted.years && extracted.years !== existingCand.years && !existingCand.years) {
        colUpdates.years = extracted.years;
      }
      // 4. Process
      if (extracted.process && extracted.process !== existingCand.process) {
        if (!existingCand.process || existingCand.process === 'New - WhatsApp' || existingCand.process === 'Need to Talk') {
          colUpdates.process = extracted.process;
        }
      }
      // 5. In-hand Salary
      if (extracted.salary && extracted.salary !== existingCand.inhand_salary && !existingCand.inhand_salary) {
        colUpdates.inhand_salary = extracted.salary;
      }
      // 6. Last / Prior Company
      if (extracted.last_company && extracted.last_company !== existingCand.last_company && !existingCand.last_company) {
        colUpdates.last_company = extracted.last_company;
      }
      // 7. Qualification
      if (extracted.qualification && extracted.qualification !== existingCand.qualification && !existingCand.qualification) {
        colUpdates.qualification = extracted.qualification;
      }
      // 8. Communication Level
      if (extracted.comm_level && extracted.comm_level !== existingCand.comm_level && !existingCand.comm_level) {
        colUpdates.comm_level = extracted.comm_level;
      }
      // 9. Currently Working
      if (extracted.currently_working && extracted.currently_working !== existingCand.currently_working && !existingCand.currently_working) {
        colUpdates.currently_working = extracted.currently_working;
      }
      // 10. Placement / Joining Status & Selection Status:
      // STRICT DIRECTIVE FROM USER: Bot NEVER automatically sets joined_status or select_status.
      // Joining and selection are 100% human recruiter / Boss manual decisions only!
      // If candidate expresses willingness or possibility to join, log remark in notes ONLY.
      if (/\b(?:will join|can join|ready to join|immediately join|join kar(?:unga|ungi)|joining possible|join kar lunga|immediately join b kar lunga)\b/i.test(lowerReply)) {
        console.log(`ℹ️ [CandidateRemark] Candidate expressed willingness to join: "${rawText.slice(0, 60)}" (Status strictly reserved for manual recruiter action)`);
        await appendNote(existingCand.phone, `[Candidate Remark] Willingness to join / immediate joiner expressed on WhatsApp: "${rawText.slice(0, 100)}"`);
      } else if (extracted.cooling_period) {
        await appendNote(existingCand.phone, '[Cooling Period] Candidate mentioned cooling period active — cannot rejoin immediately.');
      }

      // 11. Interview Lineup Status & Date Rescheduling
      const parsedDate = parseLineupDate(lowerReply, new Date());
      if (parsedDate) {
        console.log(`📅 [DateDetected] Candidate confirmed interview date: ${parsedDate.dateStr} (${parsedDate.dayName}) from "${rawText}"`);
        colUpdates.interview_date = parsedDate.dateStr;
        colUpdates.lineup_status = 'Yes';
        await appendNote(existingCand.phone, `[Lineup Scheduled] Interview date updated to ${parsedDate.dayName} (${parsedDate.dateStr}) on candidate confirmation.`);
      } else if (/\b(?:available.*tomorrow|aaunga|interview.*attend|ready for interview|available today|walkin|walk-in|slot lock|schedule kar(?:o|do))\b/i.test(lowerReply)) {
        if (existingCand.lineup_status !== 'Yes') colUpdates.lineup_status = 'Yes';
      }

      // If any columns have new data, update ros_candidates immediately in Supabase
      let updateNotice = '';
      if (Object.keys(colUpdates).length > 0) {
        await updateCandidateStatus(existingCand.phone, colUpdates);
        Object.assign(existingCand, colUpdates);
        updateNotice = ` [Updated: ${Object.entries(colUpdates).map(([k, v]) => `${k}=${v}`).join(', ')}]`;
        console.log(`💾 [CandidateSync] Live updated Supabase columns for ${existingCand.name}:`, colUpdates);

        // Only append note to Supabase if there are meaningful profile/column updates
        await appendNote(existingCand.phone, `[WhatsApp Update] ${Object.entries(colUpdates).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
      }

      // If candidate confirmed interview date or lineup, alert Shetty Saa in Shetty Office chat
      if (colUpdates.interview_date || colUpdates.lineup_status) {
        const alertMsg = `🔔 *Candidate WhatsApp Lineup Update!*\n━━━━━━━━━━━━━━━━━━━━━━\n👤 *${existingCand.name}* (📱 ${existingCand.phone})\n💼 Process: ${existingCand.process || 'Voice'} | 📍 ${existingCand.location || 'Mumbai'}\n💬 *Reply:* "${rawText}"\n${colUpdates.interview_date ? `📅 Date: *${colUpdates.interview_date}*\n` : ''}${colUpdates.lineup_status ? '✅ Status: *Lineup Confirmed*\n' : ''}📝 Live synced to RecrutOS Supabase notes & columns.`;
        await notifyTrainerAndOffice(client, alertMsg);
      }

      await logAgentActivity(client, {
        action: 'Candidate WhatsApp Reply',
        category: 'WHATSAPP',
        candidateName: existingCand.name,
        candidatePhone: existingCand.phone,
        candidateId: existingCand.id,
        details: `"${replySnippet}"${updateNotice}`.trim(),
        source: 'WhatsApp Incoming',
        notifyBoss: false,
      });
    } catch (candErr) {
      console.warn('[Bot] Candidate sync error:', candErr.message);
    }
  }

  // ── CANDIDATE REFUSAL / OPT-OUT INTERCEPTOR ────────────────────────────
  if (!senderIsRecruiter && !isShettyOfficeGroup && isNegativeOrRefusalMessage(rawText)) {
    const politeRefusal = `Samajh gaya! Koi issue nahi hai. Agar future mein kisi process ke liye plan bane toh batana. All the best! 👍`;
    await safeSend(msg, politeRefusal);
    if (candidatePhone) addToDnd(candidatePhone);
    console.log(`🛑 [Candidate Refusal] ${contactName} (${candidatePhone || talkerId}) opted out. Outreach auto-paused.`);

    await logAgentActivity(client, {
      action: 'Candidate Opt-Out',
      category: 'WHATSAPP',
      candidateName: existingCand?.name || contactName,
      candidatePhone: existingCand?.phone || candidatePhone,
      candidateId: existingCand?.id,
      details: `Candidate opted out: "${rawText}" → Outreach auto-paused`,
      source: 'WhatsApp Bot',
      notifyBoss: false,
    });
    return;
  }

  // ── FAST ACKNOWLEDGMENT INTERCEPTOR ─────────────────────────────────────
  // If candidate sends a short acknowledgment ("Okay sir", "Done", "Ji sir", "Thanks", "Ha sir")
  // and there is a concrete action context (placed, ready for interview, sending CV):
  if (!senderIsRecruiter && !isShettyOfficeGroup && isAcknowledgmentMessage(rawText) && (existingCand || chatAnalysis.hasPriorConversation || chatAnalysis.isPlacedOrJoined)) {
    const ackReply = getQuickAcknowledgmentReply(rawText, chatAnalysis, existingCand, contactName);
    if (ackReply) {
      await safeSend(msg, ackReply);
      console.log(`📤 [Ack Reply → ${contactName}]: ${ackReply}`);

      await logAgentActivity(client, {
        action: 'Candidate Acknowledgment',
        category: 'WHATSAPP',
        candidateName: existingCand?.name || chatAnalysis.harvestedProfile?.name || contactName,
        candidatePhone: existingCand?.phone || candidatePhone,
        candidateId: existingCand?.id,
        details: `Candidate acknowledged: "${rawText}" → Replied: "${ackReply}"`,
        source: 'WhatsApp Bot',
        notifyBoss: false,
      });
      return;
    }
  }

  // ── Global Auto-Reply Pause Guard ──────────────────────────────────────────
  if (!senderIsRecruiter && isAutoReplyPaused()) {
    console.log(`⏸️ [Bot] Global auto-reply paused. Suppressing automated response to candidate ${contactName} (${talkerId}).`);
    return;
  }

  // ── Anti-Repetition Guard on Bot Messages ──────────────────────────────────
  const recentBotBodies = chatHistory
    .filter(m => m.fromMe)
    .slice(-3)
    .map(m => (m.body || '').toLowerCase());

  const alreadyGreetedRecently = recentBotBodies.some(b => b.includes('welcome to *mumbai job alerts*'));
  const alreadyAskedNameRecently = recentBotBodies.some(b =>
    b.includes('full name') || b.includes('your name') || b.includes('naam please') || b.includes('naam batao')
  );

  // ── New User Greeting + Start Intake ─────────────────────────────────────
  // NEVER send greeting if candidate already has a prior conversation, was already greeted,
  // is placed/joined, or has any recorded questions in the last 500 messages!
  const isTrulyNewUser = !existingCand &&
                         !chatAnalysis.hasPriorConversation &&
                         !chatAnalysis.isPlacedOrJoined &&
                         !chatAnalysis.hasGreeted &&
                         chatAnalysis.alreadyAskedQuestions.size === 0 &&
                         chatHistory.length <= 1;

  if (!senderIsRecruiter && isTrulyNewUser && isNewUser(talkerId) && !alreadyGreetedRecently) {
    markUserSeen(talkerId);
    const chatObj = await msg.getChat().catch(() => null);
    if (chatObj) await chatObj.sendStateTyping().catch(() => {});

    if (!isInIntakeFlow(talkerId)) {
      const initialName = isLikelyName(contactName) ? contactName : '';
      const greet =
        `Hi${initialName ? ` *${initialName}*` : ''}! 👋 Welcome to *Mumbai Job Alerts*!\n\n` +
        `We have openings at top companies like *JP Morgan, TCS, Concentrix, Teleperformance, Accenture* and more.\n\n` +
        `Salaries: *₹18,000 – ₹60,000* per month in-hand. 💰\n\n` +
        `📢 Join our daily job alerts channel:\n` +
        `👉 https://whatsapp.com/channel/0029Vb8x3fGIt5rzTzmaZv2v\n\n` +
        (initialName
          ? `Which area in *Mumbai* are you currently based in? (e.g. Andheri, Thane, Malad...)\n\nWe are currently lining up candidates for top MNC *International Voice & Customer Ops* profiles with packages up to ₹35k–₹60k.`
          : `Let me quickly understand your profile to find the best match for you.\n\n` + INTAKE_QUESTIONS.name);

      setIntakeState(talkerId, {
        step: initialName ? 'location' : 'name',
        data: initialName ? { name: initialName } : {},
        stepIndex: initialName ? 1 : 0,
        retryCount: 0
      });
      await safeSend(msg, greet);
      return;
    }
  }

  // ── Candidate Intake Flow ─────────────────────────────────────────────────
  if (!senderIsRecruiter && !existingCand && !chatAnalysis.hasPriorConversation && isInIntakeFlow(talkerId) && rawText) {
    // Check for handoff triggers within intake
    const handoffTriggers = ['call me', 'talk to someone', 'speak to', 'call karo', 'baat karni hai', 'talk karni'];
    if (handoffTriggers.some(t => lowerText.includes(t))) {
      clearIntakeState(talkerId);
      flagForHumanReview(talkerId);
      await notifyRecruiter('human_requested', { name: contactName, phone: candidatePhone, waId: talkerId });
      return safeSend(msg, `Noted! Our recruiter will personally call you shortly. Please keep your phone available. Direct number if needed: *+91 8080635121* 📞`);
    }

    const result = processIntakeStep(talkerId, rawText, contactName, chatHistory);
    if (result.done) {
      await handleIntakeComplete(talkerId, contactName, result.profile, msg);
    } else {
      const chatObj = await msg.getChat().catch(() => null);
      if (chatObj) await chatObj.sendStateTyping().catch(() => {});
      await safeSend(msg, result.reply);
    }
    return;
  }

  // ── General AI Conversation ───────────────────────────────────────────────
  const intakeState = getIntakeState(talkerId);
  // Combine all context sources: web, chat history, and raw message
  let fullPrompt = rawText || (mediaParts.length > 0 ? 'Please review this image/attachment and provide a helpful response.' : '');
  if (webContext) {
    fullPrompt += `\n\n[AGENT REACH — WEB CONTEXT]:\n${webContext}`;
  }
  // Note: Deep chat history and Supabase candidate profile are injected
  // cleanly into systemInstruction and structured contents in ai_engine.js,
  // keeping fullPrompt ultra-lean (<30 tokens) to minimize token consumption.

  // Detect handoff triggers in general conversation
  const handoffTriggers = ['call me', 'talk to someone', 'speak to', 'call karo', 'please call', 'call karein', 'baat karni hai'];
  if (!senderIsRecruiter && handoffTriggers.some(t => lowerText.includes(t))) {
    flagForHumanReview(talkerId);
    await notifyRecruiter('human_requested', { name: contactName, phone: candidatePhone, waId: talkerId });
    return safeSend(msg, `Noted! Our recruiter will personally call you on this number shortly. Please keep your phone available.\n\nDirect number: *+91 8080635121* 📞`);
  }

  try {
    const chatObj = await msg.getChat().catch(() => null);
    if (chatObj) await chatObj.sendStateTyping().catch(() => {});

    const reply = await askAI(
      talkerId,
      fullPrompt,
      contactName,
      mediaParts,
      intakeState,
      senderIsRecruiter,
      existingCand,
      chatAnalysis,
      chatHistory
    );
    await safeSend(msg, reply);
    console.log(`📤 [Reply → ${contactName}]: ${reply.slice(0, 80).replace(/\n/g, ' ')}...`);
  } catch (err) {
    console.error(`❌ AI error for ${contactName}:`, err.message);
    await safeSend(msg, `Sorry, I'm having a technical issue right now. Please try again in a moment. 🙏`);
  }
}

// ── Intake Complete Handler ───────────────────────────────────────────────────
// ── CV Follow-Up Builder ─────────────────────────────────────────────────────
// Builds a smart, personalised follow-up message after receiving a CV.
// Zero LLM tokens — pure rule-based logic.
function buildCVFollowUp(name, parsed, existing) {
  const firstName = (name || 'there').split(' ')[0];
  const lines = [];

  lines.push(`Got it *${firstName}*! 🙌 Profile saved. Let me just confirm a couple of things quickly —`);
  lines.push('');

  const questions = [];

  // ── MOST IMPORTANT: Process type (CVs almost never mention this) ─────────
  const processKnown = parsed?.process && !parsed?.process_unknown;
  if (!processKnown) {
    questions.push(`• What kind of *process* were you working in? Voice, Chat, or Back-office?`);
  }

  // Currently working status
  if (!parsed?.currently_working) {
    questions.push(`• Are you *currently working*?`);
  } else if (parsed.currently_working === 'Yes') {
    if (!parsed?.inhand_salary) {
      questions.push(`• What's your *current in-hand salary* per month?`);
    }
    if (!parsed?.on_notice && !parsed?.notice_period) {
      questions.push(`• Are you serving *notice period*? If yes, how many days?`);
    }
  } else if (parsed.currently_working === 'No' && !parsed?.inhand_salary) {
    questions.push(`• What was your *last drawn salary* per month?`);
  }

  if (!parsed?.location) {
    questions.push(`• Which area of *Mumbai* are you in? (e.g. Malad, Thane, Andheri)`);
  }

  if (questions.length > 0) {
    lines.push(questions.join('\n'));
    lines.push('');
  }

  lines.push(`We've got some great BPO openings with *20-30% hike* on your current salary 🚀`);
  lines.push(`📢 Also join our *Mumbai Job Alerts* channel:\n👉 https://whatsapp.com/channel/0029Vb8x3fGIt5rzTzmaZv2v`);

  return lines.join('\n');
}

// Fallback when CV parsing fails — ask naturally
function buildCVFallback(name) {
  const firstName = (name || 'there').split(' ')[0];
  return (
    `Hey *${firstName}*! 👋 Got your CV, thanks for sending!\n\n` +
    `Just a few quick things to get you matched with the right openings:\n` +
    `• What kind of *process* were you in — Voice, Chat, or Back-office?\n` +
    `• Are you currently working? Current/last in-hand salary?\n` +
    `• Any notice period?\n` +
    `• Which part of Mumbai are you in?\n\n` +
    `📢 Also join our *Mumbai Job Alerts* channel for daily BPO openings:\n` +
    `👉 https://whatsapp.com/channel/0029Vb8x3fGIt5rzTzmaZv2v`
  );
}

// ── Intake Complete Handler ───────────────────────────────────────────────────
async function handleIntakeComplete(talkerId, contactName, profile, msg) {

  let candidatePhone = profile.phone || phoneFromWaId(talkerId);
  if (!candidatePhone || !/^[6-9]\d{9}$/.test(candidatePhone)) {
    const resolved = await resolveRealPhone(client, talkerId, null, msg, null);
    if (resolved?.phone) candidatePhone = resolved.phone;
  }
  if (candidatePhone) {
    candidatePhone = candidatePhone.replace(/\D/g, '').slice(-10);
  }

  // If phone is missing or not a valid 10-digit Indian mobile number, prompt for it
  if (!candidatePhone || !/^[6-9]\d{9}$/.test(candidatePhone)) {
    setIntakeState(talkerId, {
      step: 'phone',
      data: { ...profile, name: profile.name || contactName },
      stepIndex: INTAKE_STEPS.length,
      retryCount: 0
    });
    return safeSend(msg,
      `Thanks *${profile.name || contactName}*! 😊\n\n` +
      `To finalize your profile registration and connect you with HR, please reply with your *10-digit WhatsApp / mobile number*. 📱`
    );
  }

  const fullProfile = {
    ...profile,
    phone: candidatePhone,
    name: profile.name || contactName,
    process_status: 'Need to Talk',
    notes: `STATUS: NEED TO TALK (Check communication skills & align interview options). Loc: ${profile.location || 'N/A'} | Exp: ${profile.experience || 'N/A'} | Process: ${profile.process || 'N/A'} | Expected: ₹${profile.min_salary || 'N/A'}`
  };

  // Save to RecrutOS Supabase
  let savedText = '';
  let savedId = '';
  if (isDbConnected()) {
    const result = await addCandidateToRecrutOS(fullProfile);
    if (result.success) {
      savedText = '\n\n_Your profile has been saved in our system. ✅_';
      savedId = result.data?.id || '';
      console.log(`✅ [DB] Candidate saved: ${fullProfile.name} (${candidatePhone}) ID: ${savedId} [NEED TO TALK]`);

      // ── Save as WhatsApp contact with 'Need to Talk 🍭'
      saveCandidateContact(client, fullProfile).then(r => {
        if (r.ok) console.log(`📇 [Contact] Saved "${fullProfile.name}" as WA contact (${r.method})`);
        else       console.log(`📇 [Contact] Could not auto-save contact: ${r.error}`);
      }).catch(() => {});

    } else {
      console.warn('[Bot] DB save failed:', result.error);
    }
  }


  // Notify recruiter — include candidate UUID for correct deep link
  await notifyRecruiter('new_candidate', {
    id: savedId,
    name: fullProfile.name,
    phone: candidatePhone,
    location: fullProfile.location || '',
    experience: fullProfile.experience || '',
    comm_level: fullProfile.comm_level || '',
    min_salary: fullProfile.min_salary || '',
  });

  await logAgentActivity(client, {
    action: 'New Candidate (Need to Talk)',
    category: 'INTAKE',
    candidateName: fullProfile.name,
    candidatePhone: candidatePhone,
    candidateId: savedId,
    details: `STATUS: NEED TO TALK | Call to check communication skills & align interview options. Loc: ${fullProfile.location || 'N/A'} | Exp: ${fullProfile.experience || 'N/A'} | Process: ${fullProfile.process || 'N/A'}`,
    source: 'WhatsApp Intake Flow',
    notifyBoss: false, // notifyRecruiter already notified
  });

  const confirmMsg =
    `Great, *${fullProfile.name}*! 🙌 Your profile has been registered in our system.\n\n` +
    `Our senior recruiter *Saa* will call you shortly for a quick telephonic discussion to check your communication skills and personally align the best company and interview options for you. 📞\n\n` +
    `🕒 *Calling Hours:*\n` +
    `You can reach our team from *Monday to Saturday anytime between 11:30 AM to 8:30 PM* at *+91 8080635121*. Please keep your phone reachable!\n\n` +
    `📢 *Official WhatsApp Channel for daily job alerts:*\n` +
    `👉 https://whatsapp.com/channel/0029Vb8x3fGIt5rzTzmaZv2v\n\n` +
    `Looking forward to speaking with you! 🌟${savedText}`;

  const chat = await msg.getChat().catch(() => null);
  if (chat) await chat.sendStateTyping().catch(() => {});
  await safeSend(msg, confirmMsg);

  clearIntakeState(talkerId);
}

// ── Company Matching ──────────────────────────────────────────────────────────
export function matchCompanies(profile) {
  const loc = (profile.location || '').toLowerCase();
  const exp = (profile.experience || '').toLowerCase();
  const comm = (profile.comm_level || '').toLowerCase();
  const process = (profile.process || '').toLowerCase();
  const qual = (profile.qualification || profile.education || '').toLowerCase();
  const isGraduate = qual.includes('grad') || qual.includes('degree') || qual.includes('bcom') || qual.includes('ba') || qual.includes('bsc') || qual.includes('bms') || qual.includes('be') || qual.includes('btech');

  // Parse notice period days
  const rawNotice = String(profile.notice_period || profile.on_notice || '').toLowerCase();
  let noticeDays = 0;
  if (rawNotice.includes('2 month') || rawNotice.includes('60 day')) noticeDays = 60;
  else if (rawNotice.includes('1 month') || rawNotice.includes('30 day')) noticeDays = 30;
  else if (rawNotice.includes('45 day')) noticeDays = 45;
  else if (rawNotice.includes('15 day')) noticeDays = 15;
  else {
    const numMatch = rawNotice.match(/(\d+)\s*(day|month)/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      noticeDays = numMatch[2].startsWith('month') ? n * 30 : n;
    } else {
      const digits = parseInt(rawNotice.replace(/\D/g, ''), 10);
      if (!isNaN(digits)) noticeDays = digits;
    }
  }

  const isCurrentlyWorking = String(profile.currently_working || '').toLowerCase().startsWith('y');
  const hasNoticeOver15 = noticeDays > 15 || (isCurrentlyWorking && !rawNotice.includes('immediate') && !rawNotice.includes('0') && !rawNotice.includes('serving') && noticeDays > 0);

  // Parse salary
  const rawSalary = String(profile.inhand_salary || profile.salary || profile.last_salary || profile.last_drawn || profile.min_salary || '').toLowerCase().replace(/,/g, '');
  let lastSalary = 0;
  const kMatch = rawSalary.match(/(\d+(?:\.\d+)?)\s*k/);
  if (kMatch) lastSalary = Math.round(parseFloat(kMatch[1]) * 1000);
  else {
    const numMatch = rawSalary.match(/\d{4,6}/);
    if (numMatch) lastSalary = parseInt(numMatch[0], 10);
  }

  // Previous company strings to eliminate
  const prevCompanyStr = [
    profile.last_company,
    profile.prior_company,
    profile.current_company,
    profile.company,
  ].filter(Boolean).join(' ').toLowerCase();

  const isExcluded = (compName) => {
    const c = compName.toLowerCase();
    if (prevCompanyStr.includes('jpmc') || prevCompanyStr.includes('jp morgan') || prevCompanyStr.includes('chase')) {
      if (c.includes('jp morgan')) return true;
    }
    if (prevCompanyStr.includes('concentrix') || prevCompanyStr.includes('cnx')) {
      if (c.includes('concentrix')) return true;
    }
    if (prevCompanyStr.includes('tcs') || prevCompanyStr.includes('tata consultancy')) {
      if (c.includes('tcs')) return true;
    }
    if (prevCompanyStr.includes('tech mahindra') || prevCompanyStr.includes('techm')) {
      if (c.includes('tech mahindra')) return true;
    }
    if (prevCompanyStr.includes('firstsource') || prevCompanyStr.includes('fsl')) {
      if (c.includes('firstsource')) return true;
    }
    if (prevCompanyStr.includes('teleperformance') || prevCompanyStr.includes('tp')) {
      if (c.includes('teleperformance')) return true;
    }
    if (prevCompanyStr.includes('foundever') || prevCompanyStr.includes('sitel')) {
      if (c.includes('foundever') || c.includes('sitel')) return true;
    }
    if (prevCompanyStr.includes('epicenter')) {
      if (c.includes('epicenter')) return true;
    }
    if (prevCompanyStr.includes('sutherland')) {
      if (c.includes('sutherland')) return true;
    }
    if (prevCompanyStr.includes('wns')) {
      if (c.includes('wns')) return true;
    }
    if (prevCompanyStr.includes('accenture')) {
      if (c.includes('accenture')) return true;
    }
    if (prevCompanyStr.includes('sambridge')) {
      if (c.includes('sambridge')) return true;
    }
    return false;
  };

  const matches = [];

  // CRITICAL RULE: If notice period > 15 days, ONLY 3 companies can wait up to 2 months (60 days):
  // 1. JP Morgan Chase Captive (Malad)
  // 2. TCS (Goregaon/Thane)
  // 3. Accenture (Vikhroli/Airoli)
  if (hasNoticeOver15) {
    if (comm.includes('excellent') || comm.includes('c1') || isGraduate) {
      if (!isExcluded('JP Morgan Chase Captive (Malad)')) matches.push('JP Morgan Chase Captive (Malad)');
    }
    if (['malad', 'borivali', 'goregaon', 'kandivali', 'dahisar', 'mira', 'bhayandar', 'andheri'].some(a => loc.includes(a))) {
      if (!isExcluded('TCS (Goregaon)')) matches.push('TCS (Goregaon)');
    } else {
      if (!isExcluded('TCS (Thane)')) matches.push('TCS (Thane)');
    }
    if (['airoli', 'navi mumbai', 'vashi', 'ghansoli'].some(a => loc.includes(a))) {
      if (!isExcluded('Accenture (Airoli)')) matches.push('Accenture (Airoli)');
    } else {
      if (!isExcluded('Accenture (Vikhroli)')) matches.push('Accenture (Vikhroli)');
    }
    return [...new Set(matches.filter(m => !isExcluded(m)))];
  }

  // Candidate is immediate / 0-15 days notice — evaluate by location & salary hike
  // Navi Mumbai / Central
  if (['airoli', 'ghansoli', 'vashi', 'nerul', 'belapur', 'koparkhairane', 'navi mumbai'].some(a => loc.includes(a))) {
    matches.push('Sutherland (Airoli)', 'Accenture (Airoli)', 'TSI (Vashi)', 'WNS (Vikhroli)');
  }
  if (['thane', 'dombivli', 'kalyan', 'ulhasnagar', 'kalwa', 'mumbra'].some(a => loc.includes(a))) {
    matches.push('TCS (Thane)', 'Concentrix - JPMC Process (Thane)', 'Accenture (Vikhroli)', 'Narith (Thane)', 'Disa (Thane)');
  }
  if (['malad', 'borivali', 'dahisar', 'mira', 'bhayandar', 'kandivali', 'goregaon', 'vasai', 'virar'].some(a => loc.includes(a))) {
    matches.push('Epicenter (Mira Bhayandar)', 'Tech Mahindra (Malad)', 'Firstsource (Malad)', 'Teleperformance (Malad)', 'Concentrix - JPMC Process (Malad)', 'TCS (Goregaon)');
  }
  if (['andheri', 'powai', 'santacruz', 'bandra', 'kurla', 'marol', 'sakhi naka'].some(a => loc.includes(a))) {
    matches.push('Foundever/Sitel (Andheri)', 'ETravel (Andheri)', 'Sambridge (Powai)', 'Radius (Powai)', 'Spark Capital (Santacruz)');
  }
  if (['vikhroli', 'ghatkopar', 'mulund', 'bhandup', 'kanjurmarg'].some(a => loc.includes(a))) {
    matches.push('Accenture (Vikhroli)', 'WNS (Vikhroli)', 'Concentrix - JPMC Process (Thane)');
  }

  // High comm level (C1 / Excellent)
  if (comm.includes('excellent') || comm.includes('c1')) {
    if (isGraduate && !isExcluded('JP Morgan Chase Captive (Malad)')) {
      matches.unshift('JP Morgan Chase Captive (Malad)');
    }
    if (!matches.includes('Concentrix - JPMC Process (Malad)') && !isExcluded('Concentrix - JPMC Process (Malad)')) {
      matches.unshift('Concentrix - JPMC Process (Malad)');
    }
    if (!matches.includes('Sambridge (Powai)') && !isExcluded('Sambridge (Powai)')) {
      matches.push('Sambridge (Powai)');
    }
  }

  // Finance / Banking process background
  if (process.includes('finance') || process.includes('bank') || (profile.last_company || '').toLowerCase().includes('bank')) {
    if (!matches.includes('Spark Capital (Santacruz)') && !isExcluded('Spark Capital (Santacruz)')) matches.unshift('Spark Capital (Santacruz)');
    if (isGraduate && !matches.includes('JP Morgan Chase Captive (Malad)') && !isExcluded('JP Morgan Chase Captive (Malad)')) matches.unshift('JP Morgan Chase Captive (Malad)');
    if (!matches.includes('Concentrix - JPMC Process (Malad)') && !isExcluded('Concentrix - JPMC Process (Malad)')) matches.push('Concentrix - JPMC Process (Malad)');
  }

  // Salary Hike Rule: If candidate was drawing >= 28,000, eliminate low-paying domestic roles
  let filtered = matches.filter(m => !isExcluded(m));
  if (lastSalary >= 28000) {
    const lowPaying = ['TSI (Vashi)', 'Disa (Thane)', 'Narith (Thane)', 'Tech Mahindra (Malad)'];
    filtered = filtered.filter(m => !lowPaying.includes(m));
    // Prioritize high-paying options
    if (isGraduate && (comm.includes('excellent') || comm.includes('c1')) && !isExcluded('JP Morgan Chase Captive (Malad)')) {
      filtered.unshift('JP Morgan Chase Captive (Malad)');
    }
    if (!isExcluded('Concentrix - JPMC Process (Malad)') && !filtered.includes('Concentrix - JPMC Process (Malad)')) {
      filtered.push('Concentrix - JPMC Process (Malad)');
    }
  }

  // Fallback if empty
  if (filtered.length === 0) {
    const fallbacks = [
      'Concentrix - JPMC Process (Malad)',
      'Tech Mahindra (Malad)',
      'TCS (Goregaon)',
      'Teleperformance (Malad)',
      'Foundever/Sitel (Andheri)',
      'Accenture (Vikhroli)'
    ];
    filtered = fallbacks.filter(m => !isExcluded(m));
  }

  return [...new Set(filtered)];
}

// ── Disconnection Handling & Auto-Reconnect ──────────────────────────────────
client.on('disconnected', async (reason) => {
  console.warn('⚠️ WhatsApp client disconnected:', reason);
  console.log('🔄 Attempting to re-initialize WhatsApp client in 5 seconds...');
  setTimeout(() => {
    client.initialize().catch(err => {
      console.error('❌ Re-initialize error:', err?.message || err);
    });
  }, 5000);
});

// ── Trainer Chat — message_create (reads YOUR SENT messages) ─────────────────
// This is the magic: when you TYPE in the "Saa Office" dead-contact chat
// and hit send, whatsapp-web.js fires message_create for your outgoing msg.
// We intercept it, process it as a command/training, and reply back —
// appearing as a response in that same chat window.
//
// ALSO: When you manually reply to ANY candidate (not through Saa Office),
// the bot learns from your message style and logs it in RecrutOS notes.
client.on('message_create', async (msg) => {
  try {
    // Only handle outgoing messages sent by ME
    if (!msg.fromMe) return;

    const msgId = msg.id?._serialized || msg.id?.id || '';
    const text = (msg.body || '').trim();
    if (!text) return;

    // Don't process bot's own \u200B-prefixed replies (infinite loop guard)
    if (text.startsWith('\u200B')) return;

    // ── Dedup for message_create too ────────────────────────────────────────
    if (msgId && isAlreadyProcessed(msgId)) return;
    if (msgId) markProcessed(msgId);

    // ── Is this the Saa Office trainer chat? ────────────────────────────────
    const isTrainer = await isTrainerChat(msg);

    if (isTrainer) {
      // TRAINER CHAT MODE: process as boss command
      console.log(`\n🧠 [SaaTrainer] You typed in Saa Office: "${text.slice(0, 80)}"`);

      let chat = null;
      try {
        chat = await msg.getChat();
        if (chat) await chat.sendStateTyping();
      } catch (_) {}

      const reply = await handleTrainerChatMessage(text, client, {
        name: 'Shetty Saa (Owner)',
        isRecruiter: true
      });

      if (reply) {
        await new Promise(r => setTimeout(r, 500 + Math.random() * 700));
        if (chat) {
          await chat.sendMessage('\u200B' + reply);
        } else {
          const trainerWaId = getTrainerWaId();
          if (trainerWaId) await client.sendMessage(trainerWaId, '\u200B' + reply);
        }
        console.log(`✅ [SaaTrainer] Replied in Saa Office chat: "${reply.slice(0, 80)}"`);
      }

    } else {
      // MANUAL REPLY LEARNING: Boss manually replied to a candidate
      // → Learn from the message style, log in RecrutOS notes
      try {
        const toWaId = msg.to || '';
        const toContact = client.getContactById ? await client.getContactById(toWaId).catch(() => null) : null;
        const resolved = await resolveRealPhone(client, toWaId, toContact, msg, null);
        const toPhone = resolved?.phone || (toWaId.endsWith('@c.us') ? toWaId.replace('@c.us', '').replace(/\D/g, '').slice(-10) : '');
        const toName = toContact?.pushname || toContact?.name || resolved?.name || toPhone;

        if (toPhone && toPhone.length === 10 && text.length >= 5) {
          // Only process for candidates (not recruiters, not groups)
          if (!toWaId.includes('@g.us') && !isRecruiter(toWaId) && !isRecruiter(toPhone)) {
            await learnFromManualSend(toPhone, toName, text);
            // Parallel Sideways Intelligence: evaluate candidate profile gaps, reference culture & Instagram connection
            await handleBossSidewaysInteraction(client, toPhone, text, null).catch(err => {
              console.warn('[Sidecar] Parallel interaction error:', err.message);
            });
          }
        }
      } catch (_) {}
    }

  } catch (err) {
    console.error('[SaaTrainer] message_create error:', err.message);
  }
});


// Note: incoming messages from trainer contact are handled by the main
// client.on('message') handler above — no duplicate handler needed.
// The message_create listener above covers all outgoing trainer chat messages.



// ── Initialize ───────────────────────────────────────────────────────────────

async function killStalePuppeteerChrome() {
  // ONLY kill Chrome processes that were launched by puppeteer.
  // Puppeteer always passes --remote-debugging-port=XXXX. We find those PIDs
  // via WMIC and kill only them — leaving the user's own Chrome untouched.
  try {
    const out = execSync(
      'wmic process where "Name=\'chrome.exe\'" get ProcessId,CommandLine /format:csv',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('remote-debugging-port')) continue;
      const parts = line.split(',');
      // CSV columns: Node,CommandLine,ProcessId
      const pid = Number(parts[parts.length - 1]?.trim());
      if (pid) {
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch (_) {}
        console.log(`🧹 [Init] Killed stale puppeteer Chrome PID ${pid}`);
      }
    }
  } catch (_) {}

  // Also clean the lockfile
  try {
    const lockfilePath = path.resolve('.wwebjs_auth/session/lockfile');
    if (fs.existsSync(lockfilePath)) {
      fs.unlinkSync(lockfilePath);
      console.log('🧹 [Init] Removed stale lockfile');
    }
  } catch (_) {}

  // Give OS time to fully release the user-data-dir
  await new Promise(r => setTimeout(r, 3000));
}

client.initialize().catch(async (err) => {
  const errMsg = err?.message || String(err);

  // 'already running' = puppeteer Chrome still holding the profile dir.
  // Kill only the puppeteer Chrome (not user's browser), clean lockfile, retry once.
  if (errMsg.includes('already running') || errMsg.includes('userDataDir')) {
    console.warn('⚠️  [Init] Stale Chrome detected — cleaning up and retrying in 3 s...');
    await killStalePuppeteerChrome();
    console.log('🔄 [Init] Retrying initialize...');
    client.initialize().catch(err2 => {
      console.error('❌ [Init] Retry also failed:', err2.message);
      console.error('   → Run: taskkill /IM chrome.exe /F  then restart the bot.');
      process.exit(1);
    });
    return;
  }

  console.error('❌ Failed to initialize WhatsApp client:', errMsg);
  process.exit(1);
});

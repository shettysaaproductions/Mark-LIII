/**
 * ai_engine.js â€” Recruiter AI Engine with Multi-Key Rotation
 * ============================================================
 * Powers the WhatsApp Recruitment Bot with:
 *  - Gemini API multi-key round-robin rotation
 *  - Recruiter-persona system prompt (loads training.md)
 *  - Full intake context injection per user
 *  - Persistent per-contact conversation history
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// â”€â”€ Conversation History â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Map<userId, Array<{role: 'user'|'model', parts: [{text}]}>
const conversationHistory = new Map();
const MAX_TURNS = 6; // Compact turn history (under 200 tokens)

// â”€â”€ Multi-Key Manager â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Reads keys from config/api_keys.json â€” supports gemini_api_keys (array) or gemini_api_key (string)
const CONFIG_PATH = path.resolve(__dirname, '../config/api_keys.json');
let _keyPool = [];
let _keyIdx = 0;
const _keyCooldowns = new Map(); // key -> resumeAtMs
const KEY_COOLDOWN_MS = 65_000; // 65 seconds after a 429

function loadKeyPool() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const keys = [];
    if (Array.isArray(cfg.gemini_api_keys)) {
      keys.push(...cfg.gemini_api_keys.filter(k => k && typeof k === 'string' && k.trim()));
    }
    const single = (cfg.gemini_api_key || '').trim();
    if (single && !keys.includes(single)) keys.push(single);
    _keyPool = keys;
    if (keys.length > 0) {
      console.log(`[AIEngine] ðŸ”‘ ${keys.length} Gemini key(s) loaded â€” effective RPM â‰ˆ ${keys.length * 15}`);
    }
  } catch (e) {
    console.warn('[AIEngine] âš ï¸ Could not load API keys from config/api_keys.json:', e.message);
  }
}

function getNextKey() {
  if (_keyPool.length === 0) loadKeyPool();
  if (_keyPool.length === 0) return null;

  const now = Date.now();
  for (let i = 0; i < _keyPool.length; i++) {
    const key = _keyPool[_keyIdx % _keyPool.length];
    _keyIdx++;
    const cooldownUntil = _keyCooldowns.get(key) || 0;
    if (now >= cooldownUntil) return key;
  }
  // All keys in cooldown â€” return least-cooled
  const best = [..._keyPool].sort((a, b) => (_keyCooldowns.get(a) || 0) - (_keyCooldowns.get(b) || 0))[0];
  return best;
}

function markKeyQuota(key) {
  _keyCooldowns.set(key, Date.now() + KEY_COOLDOWN_MS);
  console.warn(`[AIEngine] â¸ï¸  Key ...${key.slice(-6)} quota hit â€” cooling ${Math.round(KEY_COOLDOWN_MS / 1000)}s`);
}

// Reload key pool when a new key might have been added externally
setInterval(() => { _keyPool = []; }, 5 * 60 * 1000);

// â”€â”€ Training Prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ── Token-Efficient Core Recruiter Knowledge ────────────────────────────────
const CORE_RECRUITER_KNOWLEDGE = `
COMPANY: Shetty Productions / RecrutOS — Mumbai BPO & ITES Placement Desk.
VENUE: 827, 8th floor, Ijmima Tower, Interface, Mindspace, Behind Infiniti Mall, Malad West, Mumbai 400064.
HOURS: Mon–Sat 11:30 AM–8:30 PM. Phone: +91 8080635121. Instagram: @shetty_saa

━━━ WHO YOU ARE ━━━
You are "Saa" — the WhatsApp voice of your boss Shetty Saa (real name Sagar Shetty), Mumbai-based rapper, independent artist & HR entrepreneur.
You talk like HIM — warm, street-smart, genuine Mumbai energy. NOT corporate. NOT robotic.

BOSS BACKSTORY (use naturally when building rapport, DO NOT dump all at once):
- Mumbai-born rapper. MTV Hustle Season 1 contestant (alongside Raftaar, Nucleya, Raja Kumari as judges).
- Collaborated with Emiway Bantai, Vivian Divine, Raftaar, Naezy, Honey Singh.
- YouTube: 1 lakh+ subscribers, 1 million+ views on songs. Handle: Shetty Production.
- Instagram: @shetty_saa
- Just blessed with a 6-month baby boy — grounded, family-first mindset.
- Worked 5 years in BPO / call center before pursuing music and HR. Knows the hustle from inside.
- Now runs RecrutOS sourcing desk — uses his 1L+ followers & network to spread job opportunities.
- Mission: Help honest, hardworking people find good jobs. "Conviction HR" — does this with heart.

HOW TO BE HUMAN (ANTI-ROBOT RULES — CRITICAL):
- NEVER send templated-sounding texts. Each reply must feel like a real person typed it right now.
- Real Mumbai HR people text like: "bhai kal aa ja", "done bata", "kal fit rahega?", "sahi hai yaar"
- Use real Hinglish patterns: drop subjects, use "toh", "na", "yaar", "bhai", "sun", "chal".
- Vary your opening — NEVER start 3 messages in a row the same way.
- Short replies win. Max 2-3 lines. If you need more, break into 2 messages.
- Lowercase is fine. Typos are ok. That's WhatsApp.
- Read RecrutOS notes SILENTLY before every reply. If notes say they're selected/joined — DON'T ask basics again.
- If the conversation has context (resume sent, previous chat), pick up naturally — "haan sun, tere resume dekha..."

GENDER-AWARE BEHAVIOR:
[IF CANDIDATE IS FEMALE / GIRL]
- Warm, friendly, caring tone. Address as "yaar" or by first name — never overly formal.
- Show genuine interest: "sun, teri profile achhi hai — kab se job dhund rahi hai?"
- Be protective about night shifts — acknowledge family constraints with empathy.
- Casually mention boss's IG when rapport is built: "btw follow karo @shetty_saa Instagram pe — ek artist hun, good vibes milenge 😄"
- Never be pushy or flirty. Warm and professional.

[IF CANDIDATE IS MALE / BOY]
- Bro energy. Motivate. Direct. Push them toward action.
- "bhai tu capable hai, bas ek baar chance de khud ko" — inspire, not lecture.
- Ask about passion: "apart from job bhai, kuch passion hai? music, content, kuch bhi?"
- Invite to office: "ek baar aa office pe — Saa se directly milega, baat karte hain"
- Share boss story naturally: "apne boss ne BPO kiya tha, MTV Hustle tak pohoncha — voice process se life change hoti hai bhai"

REFERENCE CULTURE (always do this after a positive interaction):
- End every positive conversation with: "Ek kaam karo — agar koi dost ya family member job dhundh raha ho toh mujhe connect karo. Seriously kaam aata hai."
- For joined/placed candidates: "References bhejo bhai — tu join kiya, ab teri help se koi aur bhi set hoga 💪"

CORE HIRING RULES:
- In-hand salary: ₹18,000 to ₹83,000 in-hand across 18 clients.
- ALL openings: US/UK Night Shift, pick/drop cab included.
- Notice period: ONLY JP Morgan (Malad), TCS (Goregaon/Thane), Accenture (Airoli/Vikhroli) accept up to 60 days. All others = immediate joiners (0–15 days).
- Salary: always pitch 20%–30% hike on last in-hand.
- NEVER pitch companies where candidate already worked.
- NEVER reveal you are AI/bot. If asked, say "main HR team se hun — Shetty Productions."

CRITICAL RECRUITMENT DOCTRINE — VOICE PROCESS ONLY:
- NEVER pitch chat, backoffice, non-voice.
- Guide all candidates firmly to Voice: "AI ne chat/backoffice rampdown kar diya hai bhai. Voice me job security hai, ₹35k–₹60k+ milta hai. Isi liye Voice best hai abhi."

PARALLEL INTELLIGENCE (run silently every message):
- When a resume is received → extract ALL fields, update RecrutOS, then reply naturally.
- When boss replies to a candidate → check their notes in RecrutOS first. Don't repeat questions already answered.
- When candidate says something that updates their profile → log it silently, then confirm warmly.
- If you don't know something about a candidate, ping boss on WhatsApp to confirm rather than asking candidate again.
- After boss updates any candidate in RecrutOS → notify boss proactively: "Boss, Maine [Name] ka update dekha — kuch aur karna hai?"
`.trim();

const OPENINGS_SUMMARY = `
MASTER HIRING ROSTER (18 CLIENT COMPANIES — SALARY ₹18,000 TO ₹83,000 IN-HAND):
1. JP Morgan Chase Captive (Malad Mindspace): Banking & Finance International Voice/Ops. Regular Graduates only. Accepts up to 60 days notice! ₹25k–₹35k (Freshers) | ₹35k–₹60k+ in-hand (Exp).
2. Tata Consultancy Services / TCS (Goregaon Nesco / Thane Olympus): BPS Voice/Semi-voice/Chat. Regular Graduates only. Accepts up to 60 days notice. ₹18k–₹25k (Freshers) | ₹25k–₹35k in-hand (Exp).
3. Accenture (Vikhroli Godrej One / Airoli): International Voice/Blended. Graduates. Accepts up to 60 days notice. ₹22k–₹28k (Freshers) | ₹28k–₹45k in-hand (Exp).
4. Tech Mahindra (Malad Mindspace): Telecom Voice & Blended Support. HSC/Grad. Immediate joining. ₹18k–₹24k (Freshers) | ₹24k–₹32k in-hand (Exp).
5. Firstsource / FSL (Malad Mindspace): UK/US Customer Care & Collections Voice. HSC+. Immediate. ₹18k–₹24k (Freshers) | ₹24k–₹30k in-hand (Exp) + Collections Incentives.
6. Teleperformance / TP (Malad Mindspace / Andheri): International Inbound Support & Travel. HSC/Grad. Immediate spot offers. ₹20k–₹26k (Freshers) | ₹26k–₹38k in-hand (Exp).
7. Concentrix / CNX (Malad Mindspace / Thane Ghodbunder): JPMC Outsourced & Tech/Banking accounts. HSC+6m/Grad. Immediate. ₹22k–₹28k (Freshers) | ₹28k–₹42k in-hand (Exp).
8. Sambridge (Powai Hiranandani): US Outbound/Inbound Sales & Service. HSC/Grad with strong English. Immediate. ₹25k–₹35k (Freshers) | ₹35k–₹55k in-hand (Exp) + Uncapped Dollar Incentives.
9. Foundever - Sitel (Andheri / Airoli): Telecom Voice & Blended. HSC/Grad freshers ₹29,000 FLAT in-hand! Exp up to ₹35k.
10. Epicenter (Mira Bhayandar): Domestic & International Voice/Customer Support. HSC/Grad. Ideal for Mira Road/Vasai/Virar. ₹18k–₹24k (Freshers) | ₹24k–₹32k in-hand (Exp).
11. Sutherland (Airoli Mindspace): International Tech Support & Customer Care Voice/Chat. HSC/Grad. ₹22k–₹28k (Freshers) | ₹28k–₹42k in-hand (Exp).
12. WNS (Vikhroli Godrej IT Park): Voice/Blended/Amex Support & Travel. 1-round Virtual Ops round from home! ₹21k–₹26k (Freshers) | ₹28k–₹40k in-hand (Exp).
13. TSI / Transcom (Vashi Infotech Park): Customer Service Voice/Chat. Opposite Vashi station! HSC/Grad. ₹20k–₹26k (Freshers) | ₹26k–₹36k in-hand (Exp).
14. ETravel / ETraveli Group (Andheri Chakala): OTA Flight/Hotel Booking & Ticketing Voice. Near Chakala Metro. ₹22k–₹28k (Freshers) | ₹28k–₹40k in-hand (Exp).
15. Narith (Thane): Domestic & Semi-Intl Voice / Lead Gen. HSC/Grad. ₹18k–₹24k in-hand.
16. Radius (Powai): US International Accounts & Debt Collections Voice. HSC+1y/Grad. ₹25k–₹32k (Freshers) | ₹32k–₹48k in-hand (Exp) + Incentives.
17. Disa (Thane Wagle Estate): Backoffice Data Processing & Blended Voice. HSC/Grad (25+ WPM typing). ₹18k–₹26k in-hand.
18. Spark Capital (Santacruz): Financial Services & Wealth Management Inbound. Commerce/Finance Graduates. ₹30k–₹40k (Freshers) | ₹40k–₹60k+ in-hand (Exp).
`.trim();

// ── Candidate Models (tried in order) ─────────────────────────────────────────
const CANDIDATE_MODELS = [
  'gemini-3.5-flash-lite',   // fastest / cheapest — use first
  'gemini-3.7-flash',        // best quality fallback
  'gemini-3.6-flash',        // second fallback
];

// ── Public API ───────────────────────────────────────────────────────────────

export function resetUserHistory(userId) {
  conversationHistory.delete(userId);
}

/**
 * Build the ultra-lean recruiter system instruction injected into every call.
 * Uses <300 tokens instead of 8,000+ tokens to protect LLM quota.
 */
// ── Gender detection heuristic ─────────────────────────────────────────────
function detectGender(name = '', notes = '', history = '') {
  const female = ['her','she','teri','uski','ladki','girl','female','miss','ms','herself','beta nahi','beti'];
  const male   = ['his','he','tera','uska','ladka','boy','male','bhai','bro','himself','beta'];
  const combined = `${name} ${notes} ${history}`.toLowerCase();
  const fScore = female.filter(w => combined.includes(w)).length;
  const mScore = male.filter(w => combined.includes(w)).length;
  if (fScore > mScore) return 'female';
  if (mScore > fScore) return 'male';
  return 'unknown';
}

function buildSystemInstruction(userName, intakeState = null, isRecruiter = false, existingCand = null, chatAnalysis = null, userPrompt = '', gender = 'unknown') {
  let contextBlock = '';
  if (intakeState && !existingCand && !chatAnalysis?.hasPriorConversation) {
    const { step, data } = intakeState;
    const completedFields = Object.entries(data || {})
      .filter(([, v]) => v)
      .map(([k, v]) => `  - ${k}: ${v}`)
      .join('\n');
    contextBlock = `
=== CANDIDATE INTAKE IN PROGRESS ===
Current step: ${step}
Already collected:
${completedFields || '  (nothing yet)'}
Next to ask: ${step} — ask this ONE field naturally, like a real human recruiter would.
=====================================
`;
  }

  // ── Known Candidate Profile Block ──────────────────────────────────────────
  let existingBlock = '';
  if (existingCand || chatAnalysis?.hasPriorConversation || chatAnalysis?.isPlacedOrJoined) {
    const candName = existingCand?.name || chatAnalysis?.harvestedProfile?.name || userName;
    const candPhone = existingCand?.phone || chatAnalysis?.harvestedProfile?.phone || '';
    const candLoc = existingCand?.location || chatAnalysis?.harvestedProfile?.location || 'Mumbai';
    const candExp = existingCand?.experience || chatAnalysis?.harvestedProfile?.experience || 'N/A';
    const candYears = existingCand?.years || chatAnalysis?.harvestedProfile?.years || '';
    const candProc = existingCand?.process || chatAnalysis?.harvestedProfile?.process || '';
    const candSal = existingCand?.inhand_salary || chatAnalysis?.harvestedProfile?.salary || 'N/A';
    const candLastCo = existingCand?.last_company || chatAnalysis?.harvestedProfile?.last_company || '';
    const candJoined = existingCand?.joined_status === 'Yes' || chatAnalysis?.isPlacedOrJoined;
    const candComp = chatAnalysis?.placedCompany || existingCand?.joined_company || '';
    const candLineup = existingCand?.lineup_status === 'Yes' || chatAnalysis?.isLinedUp;
    const candLineupDate = existingCand?.interview_date || chatAnalysis?.lineupDate || '';
    const notesSummary = existingCand?.notes ? existingCand.notes.slice(0, 1500).trim() : '';

    // Fix bot-generated placeholder names
    const isPlaceholderName = ['hii','hi','hello','hey','unknown','friend','na','n/a','null','undefined','ask name','lead','candidate'].some(p => (candName||'').toLowerCase().trim().startsWith(p));

    // Identify what's missing from their profile so you can ask naturally
    const missingFields = [];
    if (isPlaceholderName) missingFields.push('full name — the name saved looks auto-generated or missing, DO NOT call them "Hii" or "Ask Name"! Address them warmly without a name and ask naturally: "btw tera naam kya hai?"');
    if (!candProc) missingFields.push('process type (Voice/Chat/Backend)');
    if (!candSal || candSal === 'N/A') missingFields.push('current in-hand salary');
    if (!candLoc || candLoc === 'Mumbai') missingFields.push('exact location / area');

    existingBlock = `
=== THIS CANDIDATE'S RECRUTOS PROFILE ===
- Name: ${isPlaceholderName ? '[Name Unverified — Ask naturally]' : candName}${candPhone ? ` | Phone: ${candPhone}` : ''}
- Status: ${candJoined ? `✅ PLACED/JOINED${candComp ? ` at ${candComp}` : ''}` : (candLineup ? `📅 LINED UP${candLineupDate ? ` for ${candLineupDate}` : ''}` : '🔍 ACTIVE — being placed')}
- Location: ${candLoc}
- Experience: ${candExp}${candYears ? ` (${candYears} yrs)` : ''}
- Process: ${candProc || '⚠️ NOT SET — ask them'}
- Last Salary: ₹${candSal}/mo
${candLastCo ? `- Last Company: ${candLastCo}` : ''}
${candLineupDate ? `- Confirmed Interview Date: ${candLineupDate}` : ''}
=========================================

${notesSummary ? `=== 🚨 BOSS / RECRUITER LIVE UPDATES FROM RECRUTOS ===
${notesSummary}
=====================================================
⚠️ STRICT DIRECTIVE FOR BOT:
The notes above contain the latest instructions, call remarks, and decisions entered by the Boss/Recruiter directly in RecrutOS (e.g. from phone calls or manual review).
You MUST 100% RESPECT AND ALIGN with the Boss's notes! If the Boss noted "day shift only" or "interview on Wednesday 7th Oct", YOU MUST NEVER contradict or re-ask what the recruiter already decided. Acknowledge and proceed seamlessly based on the recruiter's updates!
` : ''}
🧠 SMART RULES FOR KNOWN CANDIDATES:
1. ${isPlaceholderName ? 'CRITICAL: The saved name is an unverified placeholder. DO NOT call them by this name! Address them warmly ("Hey!", "Sun na") and ask: "btw tera naam kya hai?"' : `You KNOW this person — address them by first name (${candName.split(' ')[0]}), be warm and personal.`}
2. NEVER ask details that are already saved (Name, Location, Experience, Salary) unless they contradict what you know.
3. NEVER restart intake or treat them as a new stranger.
4. NEVER send a generic greeting like "Welcome to Mumbai Job Alerts" or "Are you looking for a job?".
5. If something critical is MISSING (marked ⚠️ above), ask it naturally once.
6. If candidate says something that conflicts with saved data, gently confirm: "Oh wait, you mentioned 28k now — last time it was 22k, should I update that?"
7. STATUS LOCK: Joining status and Selection status are strictly human recruiter decisions. Never assume or mark a candidate as joined unless confirmed in recruiter notes.
${missingFields.length > 0 ? `8. MISSING INFO — if conversation allows, casually ask: ${missingFields.join(', ')}` : ''}
`;
  }

  const genderNote = gender === 'female'
    ? `⚡ GENDER NOTE: This candidate appears to be a GIRL. Use warm sisterly/friendly tone. Be protective about night shift constraints. After good rapport, casually mention @shetty_saa Instagram.`
    : gender === 'male'
    ? `⚡ GENDER NOTE: This candidate appears to be a BOY. Use bro energy. Motivate. Push toward action. Invite to office. Share boss story if relevant.`
    : ``;

  const roleContext = isRecruiter
    ? `This sender is an INTERNAL RECRUITER / BOSS. Give full candidate data, status info, command feedback. Acknowledge every RecrutOS update proactively.`
    : (existingBlock
      ? `This sender is a KNOWN CANDIDATE in RecrutOS. Read their notes before replying. Be their career guide, not a form-filler.`
      : `This sender is a NEW JOB CANDIDATE. Guide them warmly — like a real recruiter, not a chatbot. Ask ONE question at a time.`);

  return `
You are Saa — WhatsApp voice of Shetty Productions, Mumbai. Text like a real person, not a bot.
User: ${userName || 'Friend'}
${genderNote}

ROLE: ${roleContext}

${CORE_RECRUITER_KNOWLEDGE}

${OPENINGS_SUMMARY}

${existingBlock}

${contextBlock}
`.trim();
}

/**
 * Send a message to the AI and get a recruiter-persona response.
 * @param {string} userId - WhatsApp sender ID
 * @param {string} userPrompt - The message text
 * @param {string} userName - Contact display name
 * @param {Array} mediaParts - Gemini multimodal parts (images, audio, PDF, etc.)
 * @param {Object|null} intakeState - Current intake state for context injection
 * @param {boolean} isRecruiter - Whether sender is an internal recruiter
 * @param {Object|null} existingCand - Known candidate record from RecrutOS
 * @param {Object|null} chatAnalysis - Deep intelligence from last 500 messages
 * @param {Array} chatHistory - Raw message array from chat
 */
export async function askAI(userId, userPrompt = '', userName = 'Friend', mediaParts = [], intakeState = null, isRecruiter = false, existingCand = null, chatAnalysis = null, chatHistory = [], gender = 'unknown') {
  // Auto-detect gender from candidate profile + recent chat if not provided
  const detectedGender = gender !== 'unknown' ? gender : detectGender(
    existingCand?.name || userName,
    existingCand?.notes || '',
    chatHistory.slice(-6).map(m => m.body || '').join(' ')
  );
  const systemInstructionText = buildSystemInstruction(userName, intakeState, isRecruiter, existingCand, chatAnalysis, userPrompt, detectedGender);

  let history = conversationHistory.get(userId) || [];

  // Reconstruct conversation turns from actual WhatsApp messages if in-memory history is empty
  // Limit to ONLY the last 4 messages (2 turns) to keep token payload minimal (<120 tokens)
  if (history.length === 0 && Array.isArray(chatHistory) && chatHistory.length > 0) {
    const recentMsgs = chatHistory.slice(-4);
    const reconstructed = [];
    for (const m of recentMsgs) {
      const text = (m.body || '').trim().slice(0, 150);
      if (!text) continue;
      const role = m.fromMe ? 'model' : 'user';
      if (reconstructed.length > 0 && reconstructed[reconstructed.length - 1].role === role) {
        reconstructed[reconstructed.length - 1].parts[0].text += `\n${text}`;
      } else {
        reconstructed.push({ role, parts: [{ text }] });
      }
    }
    // Gemini contents MUST start with 'user'
    if (reconstructed.length > 0 && reconstructed[0].role === 'model') {
      reconstructed.shift();
    }
    // If the last message is from user and matches current prompt, remove it so it's not duplicated
    if (reconstructed.length > 0 && reconstructed[reconstructed.length - 1].role === 'user') {
      const lastText = reconstructed[reconstructed.length - 1].parts?.[0]?.text || '';
      if (lastText === (userPrompt || '').trim().slice(0, 150)) {
        reconstructed.pop();
      }
    }
    history = reconstructed;
  }

  // Build current turn parts
  const currentTurnParts = [];
  if (Array.isArray(mediaParts) && mediaParts.length > 0) {
    currentTurnParts.push(...mediaParts);
  }

  const promptText = (userPrompt || '').trim() ||
    (mediaParts.length > 0 ? 'Please analyze this attachment.' : 'Hello');
  currentTurnParts.push({ text: promptText });

  const contentsPayload = [
    ...history,
    { role: 'user', parts: currentTurnParts }
  ];

  const payload = {
    systemInstruction: { parts: [{ text: systemInstructionText }] },
    contents: contentsPayload,
    generationConfig: {
      temperature: 0.78,   // slightly higher = more natural variation, less robotic
      maxOutputTokens: 280, // shorter = more WhatsApp-like
      topP: 0.92,
    },
  };

  let lastError = null;

  // Try each model with key rotation
  for (const model of CANDIDATE_MODELS) {
    const key = getNextKey();
    if (!key) throw new Error('No Gemini API keys configured.');

    const endpoint = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const msg = errData.error?.message || `HTTP ${response.status}`;
        if (response.status === 429) { markKeyQuota(key); }
        lastError = new Error(`[${model}] ${msg}`);
        continue;
      }

      const data = await response.json();
      const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (replyText) {
        // Persist to conversation history (store compact text so we don't keep MB of base64)
        const historyText = mediaParts.length > 0
          ? `[User sent a file/attachment]: ${promptText}`
          : promptText;

        history.push({ role: 'user', parts: [{ text: historyText }] });
        history.push({ role: 'model', parts: [{ text: replyText }] });

        // Trim to MAX_TURNS (keep last N, ensure first is not a model message)
        if (history.length > MAX_TURNS) {
          history = history.slice(-MAX_TURNS);
          if (history[0]?.role === 'model') history.shift();
        }

        conversationHistory.set(userId, history);
        return replyText;
      }

    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) markKeyQuota(key);
      lastError = err;
    }
  }

  throw lastError || new Error('All AI model endpoints failed to respond.');
}

/**
 * Extract structured candidate data from a resume text/image using AI.
 * Returns a parsed JSON object with candidate fields.
 */
export async function parseResumeWithAI(resumeText, mediaParts = []) {
  const key = getNextKey();
  if (!key) throw new Error('No Gemini API keys configured.');

  const systemPrompt = `You are a specialist resume parser for a Mumbai BPO recruitment firm.
Extract candidate information from the resume/CV into JSON.

RETURN ONLY valid JSON with these exact keys:
{
  "name": "",
  "phone": "",
  "location": "",
  "experience": "Fresher|Experienced",
  "years": "",
  "process": "",
  "inhand_salary": "",
  "last_company": "",
  "companies_list": [],
  "currently_working": "Yes|No",
  "on_notice": "Yes|No",
  "notice_period": "",
  "qualification": "",
  "comm_level": "",
  "notes": "",
  "process_unknown": false
}

CRITICAL EXTRACTION RULES:
- "last_company": ONLY the most recent employer's company name (e.g. "Teleperformance"). NO job titles, NO dates, NO addresses.
- "companies_list": Array of company NAMES ONLY (strings) from entire work history (e.g. ["Teleperformance", "Concentrix", "WNS"]). Never include job titles or descriptions.
- "process": Extract ONLY if explicitly mentioned (e.g. "Voice process", "Chat support", "Back office"). BPO process names rarely appear in CVs. If NOT found, leave EMPTY and set process_unknown=true.
- "inhand_salary": Monthly take-home in numbers only (e.g. "25000"). Empty if not stated — do NOT guess.
- "phone": 10-digit Indian mobile number. Leave empty if absent from CV.
- "experience": "Fresher" if no work history / <6 months. "Experienced" if they have prior jobs.
- "years": Total years of experience as a number string (e.g. "2", "4.5"). Leave empty if fresher.
- "qualification": Highest education (e.g. "HSC", "Graduate", "BBA").
- "comm_level": Infer from written English quality in CV: Excellent/Good/Average/Poor.
- "currently_working": "Yes" if they have a current employer listed, "No" if unemployed/fresher.
- "on_notice": "Yes" only if explicitly serving notice. "No" otherwise.
- "notice_period": e.g. "15 days", "1 month", "Immediate joiner". Empty if not stated.
- "notes": Any important observations (e.g. "Worked at Concentrix before — do not pitch", "HSC pass only").
- If unclear, use empty string. NEVER invent or hallucinate data.`;

  const parts = [];
  if (mediaParts.length > 0) parts.push(...mediaParts);
  if (resumeText) parts.push({ text: `Resume content:\n${resumeText}` });

  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 700 },
  };

  for (const model of CANDIDATE_MODELS) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`;
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const jsonStr = raw.replace(/```json|```/g, '').trim();
      return JSON.parse(jsonStr);
    } catch (_) { continue; }
  }

  return null;
}


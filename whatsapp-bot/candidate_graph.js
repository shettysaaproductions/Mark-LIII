/**
 * candidate_graph.js — Candidate Knowledge Graph & Parallel Intelligence Engine
 * ==============================================================================
 * Implements a persistent, zero-token entity graph and sidecar assistant.
 * 
 * Inspired by Knowledge Graph Engineering (agency-knowledge-graph-engineer):
 *  - Entity-Relationship model per candidate
 *  - Deterministic Identity Gate (never accepts "Hii", "Hello" or placeholders as names)
 *  - Parallel Sideways Assistant (runs alongside Boss manual WhatsApp replies)
 *  - Reference Culture & Boss Personal Brand Integration (@shetty_saa)
 *  - Local Laya ONNX integration for 0-token decisions
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLikelyName } from './profile_extractor.js';
import {
  decideLaya,
  classifyBossIntentLaya,
  classifyCandidateIntentLaya,
  classifyShiftPreferenceLaya
} from './laya_client.js';
import {
  searchCandidate,
  updateCandidateStatus,
  appendNote,
  addCandidateToRecrutOS
} from './recruiter_db.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GRAPH_STATE_FILE = path.resolve(__dirname, 'candidate_graph_state.json');

// Memory cache of candidate graph nodes
let _graphNodes = new Map();

function loadGraphState() {
  try {
    if (fs.existsSync(GRAPH_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(GRAPH_STATE_FILE, 'utf8'));
      _graphNodes = new Map(Object.entries(data));
    }
  } catch (e) {
    console.warn('[CandidateGraph] Could not load state from disk:', e.message);
  }
}

function persistGraphState() {
  try {
    const obj = Object.fromEntries(_graphNodes);
    fs.writeFileSync(GRAPH_STATE_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn('[CandidateGraph] Could not persist state to disk:', e.message);
  }
}

// Initial load
loadGraphState();

/**
 * Normalizes phone numbers to clean 10-digit format
 */
export function normalizePhone(rawPhone) {
  if (!rawPhone) return '';
  return String(rawPhone).replace(/\D/g, '').slice(-10);
}

/**
 * Deterministic Identity Verification Gate:
 * Returns whether a name string is a legitimate, verified person name.
 */
export function isVerifiedPersonName(name) {
  if (!name) return false;
  const n = String(name).trim();
  if (!isLikelyName(n)) return false;
  if (/^(?:hii+|hello+|helo|hey+|ask\s*name|candidate|lead|friend|unknown)\b/i.test(n)) return false;
  return true;
}

/**
 * Retrieves or initializes the Candidate Knowledge Graph Node.
 */
export async function getOrCreateCandidateNode(phone, initialData = {}) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return null;

  let node = _graphNodes.get(cleanPhone);
  if (!node) {
    // Check Supabase
    let dbRecord = null;
    try {
      const dbMatches = await searchCandidate(cleanPhone);
      if (dbMatches && dbMatches.length > 0) {
        dbRecord = dbMatches[0];
      }
    } catch (_) {}

    const name = dbRecord?.name || initialData?.name || '';
    const isNameValid = isVerifiedPersonName(name);

    node = {
      phone: cleanPhone,
      name: isNameValid ? name : '',
      is_name_verified: isNameValid,
      placeholder_label: isNameValid ? name : `Candidate ${cleanPhone.slice(-4)}`,
      gender: initialData?.gender || dbRecord?.gender || null, // 'female' | 'male' | null
      location: dbRecord?.location || initialData?.location || '',
      qualification: dbRecord?.qualification || initialData?.qualification || '',
      experience: dbRecord?.experience || initialData?.experience || '',
      years: dbRecord?.years || initialData?.years || '',
      inhand_salary: dbRecord?.inhand_salary || initialData?.inhand_salary || '',
      process: dbRecord?.process || initialData?.process || '',
      last_company: dbRecord?.last_company || initialData?.last_company || '',
      shift_preference: initialData?.shift_preference || null, // 'Day' | 'Night' | 'Any'
      cooling_period_active: false,
      
      // Social & Reference Graph
      boss_story_shared: false,
      ig_connected: false,
      reference_culture_pitched: false,
      references_received: [],

      // Sidecar Interaction History
      last_boss_message: null,
      last_boss_message_ts: null,
      last_candidate_message: null,
      last_candidate_message_ts: null,
      sideways_followup_pending: false,
      created_at: new Date().toISOString()
    };

    _graphNodes.set(cleanPhone, node);
    persistGraphState();
  } else {
    // Merge any fresh DB or initial data
    if (initialData.shift_preference) node.shift_preference = initialData.shift_preference;
    if (initialData.cooling_period_active !== undefined) node.cooling_period_active = initialData.cooling_period_active;
    if (!node.is_name_verified && initialData.name && isVerifiedPersonName(initialData.name)) {
      node.name = initialData.name;
      node.is_name_verified = true;
      node.placeholder_label = initialData.name;
    }
  }

  return node;
}

/**
 * Evaluates candidate profile gaps.
 * Identifies what information is still missing from the candidate's profile.
 */
export function getCandidateGaps(node) {
  if (!node) return [];
  const gaps = [];

  if (!node.is_name_verified) gaps.push('real_name');
  if (!node.location) gaps.push('location');
  if (!node.qualification) gaps.push('qualification');
  if (!node.experience) gaps.push('experience');
  if (!node.inhand_salary) gaps.push('salary');
  if (!node.shift_preference) gaps.push('shift_preference');
  if (!node.process) gaps.push('process_preference');

  return gaps;
}

/**
 * Updates the candidate entity node with new verified attributes.
 */
export async function updateCandidateGraphNode(phone, updates = {}) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return null;

  let node = await getOrCreateCandidateNode(cleanPhone);
  if (!node) return null;

  // Handle name verification
  if (updates.name) {
    if (isVerifiedPersonName(updates.name)) {
      node.name = updates.name;
      node.is_name_verified = true;
      node.placeholder_label = updates.name;
    }
  }

  // Merge attributes
  const allowedKeys = [
    'gender', 'location', 'qualification', 'experience', 'years',
    'inhand_salary', 'process', 'last_company', 'shift_preference',
    'cooling_period_active', 'boss_story_shared', 'ig_connected',
    'reference_culture_pitched', 'last_boss_message', 'last_boss_message_ts',
    'last_candidate_message', 'last_candidate_message_ts', 'sideways_followup_pending'
  ];

  for (const k of allowedKeys) {
    if (updates[k] !== undefined) {
      node[k] = updates[k];
    }
  }

  if (updates.new_reference) {
    node.references_received.push(updates.new_reference);
  }

  _graphNodes.set(cleanPhone, node);
  persistGraphState();

  // Sync back to Supabase ros_candidates
  try {
    const dbUpdates = {};
    if (node.is_name_verified && node.name) dbUpdates.name = node.name;
    if (updates.location) dbUpdates.location = updates.location;
    if (updates.qualification) dbUpdates.qualification = updates.qualification;
    if (updates.experience) dbUpdates.experience = updates.experience;
    if (updates.years) dbUpdates.years = updates.years;
    if (updates.inhand_salary) dbUpdates.inhand_salary = updates.inhand_salary;
    if (updates.process) dbUpdates.process = updates.process;
    if (updates.last_company) dbUpdates.last_company = updates.last_company;

    if (Object.keys(dbUpdates).length > 0) {
      await updateCandidateStatus(cleanPhone, dbUpdates);
    }
  } catch (err) {
    console.warn(`[CandidateGraph] Supabase sync error for ${cleanPhone}:`, err.message);
  }

  return node;
}

/**
 * Infallible Resume Ingestion:
 * Immediately updates the candidate's graph node and Supabase record when a CV is parsed.
 */
export async function syncResumeToGraph(phone, parsedCv) {
  if (!phone || !parsedCv) return null;
  const cleanPhone = normalizePhone(phone);

  const updates = {};
  if (parsedCv.name && isVerifiedPersonName(parsedCv.name)) {
    updates.name = parsedCv.name;
  }
  if (parsedCv.qualification) updates.qualification = parsedCv.qualification;
  if (parsedCv.experience) updates.experience = parsedCv.experience;
  if (parsedCv.years) updates.years = String(parsedCv.years);
  if (parsedCv.inhand_salary) updates.inhand_salary = String(parsedCv.inhand_salary);
  if (parsedCv.location) updates.location = parsedCv.location;
  if (parsedCv.last_company) updates.last_company = parsedCv.last_company;
  if (parsedCv.process && !parsedCv.process_unknown) updates.process = parsedCv.process;

  const node = await updateCandidateGraphNode(cleanPhone, updates);
  console.log(`[CandidateGraph] 📄 CV Synced to Entity Node: ${node.name || cleanPhone}`);
  return node;
}

/**
 * Detects whether an incoming resume is a referral (referring a friend/colleague)
 * or the sender's own CV.
 */
export function isReferralResume(senderPhone, senderName, cvPhone, cvName, rawText = '', existingSenderRecord = null) {
  const cleanSenderPhone = normalizePhone(senderPhone);
  const cleanCvPhone = normalizePhone(cvPhone);

  // 1. If CV has a phone number and it's distinctly different from sender's phone
  if (cleanCvPhone && cleanSenderPhone && cleanCvPhone !== cleanSenderPhone) {
    return { isReferral: true, reason: 'different_phone', refPhone: cleanCvPhone };
  }

  // 2. If sender text explicitly mentions referral / friend / reference / multiple resumes
  const referralKeywords = /\b(?:refer|ref|reference|friend|dost|colleague|brother|sister|bhai|candidate|dono|both|dono\s*ka|ye\s*cv|check\s*this|unka|uska|frnd|freind)\b/i;
  if (referralKeywords.test(rawText)) {
    return { isReferral: true, reason: 'text_indicated', refPhone: cleanCvPhone || null };
  }

  // 3. If sender already exists with a verified different name, and CV has a valid different person name
  if (existingSenderRecord && existingSenderRecord.name && isVerifiedPersonName(existingSenderRecord.name)) {
    if (cvName && isVerifiedPersonName(cvName)) {
      const sFirst = existingSenderRecord.name.toLowerCase().split(/\s+/)[0];
      const cvFirst = cvName.toLowerCase().split(/\s+/)[0];
      if (sFirst !== cvFirst && sFirst.length > 2 && cvFirst.length > 2) {
        return { isReferral: true, reason: 'different_name_and_existing_sender', refPhone: cleanCvPhone || null };
      }
    }
  }

  return { isReferral: false, reason: 'sender_cv', refPhone: cleanSenderPhone };
}

/**
 * Processes a referral resume:
 * Creates the referred candidate in RecrutOS, links them to the sender,
 * saves to contacts with a referral tag, updates the Knowledge Graph,
 * notifies the Saa Office / Trainer, and returns a warm thank-you acknowledgment.
 */
export async function handleReferralResume(client, senderPhone, senderName, parsedCv, rawText = '') {
  const cleanSenderPhone = normalizePhone(senderPhone);
  const cleanCvPhone = normalizePhone(parsedCv?.phone);
  const cvName = (parsedCv?.name && isVerifiedPersonName(parsedCv.name)) ? parsedCv.name : 'Referred Candidate';

  console.log(`🤝 [CandidateGraph] Sourced Referral from ${senderName} (${cleanSenderPhone}) → ${cvName} (${cleanCvPhone || 'No phone on CV'})`);

  const dateStr = new Date().toISOString().slice(0, 10);
  const refNote = `[Referred by ${senderName} (+91 ${cleanSenderPhone})] Sourced via WhatsApp on ${dateStr}.\nExp: ${parsedCv?.experience || 'N/A'} (${parsedCv?.years || '0'}y) | Last Co: ${parsedCv?.last_company || 'N/A'}${parsedCv?.inhand_salary ? ` | Salary: ₹${parsedCv.inhand_salary}` : ''}${parsedCv?.qualification ? ` | Qual: ${parsedCv.qualification}` : ''}${parsedCv?.currently_working ? ` | Working: ${parsedCv.currently_working}` : ''}`;

  let targetCandId = null;

  if (cleanCvPhone) {
    // Check if referred candidate already exists
    const existingMatches = await searchCandidate(cleanCvPhone);
    if (existingMatches && existingMatches.length > 0) {
      const existingRef = existingMatches[0];
      targetCandId = existingRef.id;
      const updates = {
        referred_by: `${senderName} (${cleanSenderPhone})`
      };
      if (cvName !== 'Referred Candidate' && (!existingRef.name || !isVerifiedPersonName(existingRef.name))) {
        updates.name = cvName;
      }
      if (parsedCv?.experience && !existingRef.experience) updates.experience = parsedCv.experience;
      if (parsedCv?.years && !existingRef.years) updates.years = String(parsedCv.years);
      if (parsedCv?.inhand_salary && !existingRef.inhand_salary) updates.inhand_salary = String(parsedCv.inhand_salary);
      if (parsedCv?.location && !existingRef.location) updates.location = parsedCv.location;
      if (parsedCv?.qualification && !existingRef.qualification) updates.qualification = parsedCv.qualification;

      await updateCandidateStatus(cleanCvPhone, updates);
      await appendNote(cleanCvPhone, refNote);
      console.log(`✅ [CandidateGraph] Updated existing candidate with referral: ${cvName} (${cleanCvPhone})`);
    } else {
      // Create new candidate in RecrutOS Supabase
      const newPayload = {
        name: cvName,
        phone: cleanCvPhone,
        location: parsedCv?.location || '',
        experience: parsedCv?.experience || 'Experienced',
        years: String(parsedCv?.years || '1'),
        process: parsedCv?.process || 'Voice',
        inhand_salary: String(parsedCv?.inhand_salary || ''),
        last_company: parsedCv?.last_company || '',
        qualification: parsedCv?.qualification || 'Graduate',
        process_status: 'Need to Talk',
        referred_by: `${senderName} (${cleanSenderPhone})`,
        notes: refNote
      };

      const createRes = await addCandidateToRecrutOS(newPayload);
      if (createRes?.success && createRes?.data) {
        targetCandId = createRes.data.id;
        console.log(`✨ [CandidateGraph] Created new referred candidate in RecrutOS: ${cvName} (${cleanCvPhone})`);
      }
    }

    // Save contact in phonebook with referral tag
    if (client) {
      try {
        const { saveCandidateContact } = await import('./contact_saver.js');
        await saveCandidateContact(client, {
          name: `${cvName} — Ref by ${senderName}`,
          phone: cleanCvPhone,
          experience: parsedCv?.experience || '',
          process: `Ref by ${senderName}`
        });
      } catch (_) {}
    }

    // Update Knowledge Graph for sender
    await updateCandidateGraphNode(cleanSenderPhone, {
      new_reference: {
        name: cvName,
        phone: cleanCvPhone,
        date: new Date().toISOString()
      },
      reference_culture_pitched: true
    }).catch(() => {});

    await appendNote(cleanSenderPhone, `[Reference Sourced] ${senderName} shared resume of ${cvName} (📱 ${cleanCvPhone}). Saved to RecrutOS.`);
  }

  // Notify Trainer & Saa Office
  if (client) {
    try {
      const { notifyTrainerAndOffice } = await import('./saa_trainer_chat.js');
      const refAlert = `🌟 *New Candidate Reference Added!*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 *${cvName}* ${cleanCvPhone ? `(📱 ${cleanCvPhone})` : '(⚠️ No phone on CV)'}\n` +
        `🤝 *Referred by:* ${senderName} (📱 ${cleanSenderPhone})\n` +
        `📍 ${parsedCv?.location || 'Mumbai'} | 💼 ${parsedCv?.experience || 'N/A'} ${parsedCv?.years ? `(${parsedCv.years}y)` : ''}\n` +
        `🏢 Last Co: ${parsedCv?.last_company || 'N/A'} | 💰 Salary: ₹${parsedCv?.inhand_salary || 'N/A'}/mo\n` +
        `👉 *Auto-saved to RecrutOS database!*`;
      await notifyTrainerAndOffice(client, refAlert);
    } catch (_) {}
  }

  // Build warm personalized acknowledgment
  const senderFirstName = (senderName || 'bhai').split(' ')[0];
  let ackText = '';
  if (cleanCvPhone) {
    ackText = `Got the resume for *${cvName}* (📱 ${cleanCvPhone})! 🙌\n\n` +
      `Thanks a lot for the reference, ${senderFirstName} bhai! Adding them to our lineup and reaching out to them right away. 💼\n\n` +
      `Agar aur bhi koi dost ya colleague job dekh raha ho Mumbai mein, unka bhi number/CV zaroor share karna! 🚀`;
  } else {
    ackText = `Got the resume for *${cvName}*! 🙌 Thanks for sharing, ${senderFirstName} bhai.\n\n` +
      `Just one quick thing — unka *contact number* CV pe nahi mila. Unka phone number yahan share kar do taaki team unhe call karke interview lineup kar sake! 📞`;
  }

  return {
    isReferral: true,
    candidateName: cvName,
    candidatePhone: cleanCvPhone,
    candidateId: targetCandId,
    ackText
  };
}


/**
 * PARALLEL SIDEWAYS INTELLIGENCE:
 * Triggered whenever Shetty Saa (Boss) manually sends a message to any candidate.
 * 
 * Works simultaneously sideways:
 *  1. Updates the candidate graph with the boss's interaction.
 *  2. Evaluates what facts/questions the boss missed.
 *  3. Injects boss backstory (@shetty_saa, MTV Hustle, 1L+ YouTube subs) and reference culture.
 *  4. Prepares or logs intelligent follow-up suggestions without disrupting boss's live flow.
 */
export async function handleBossSidewaysInteraction(client, toPhone, manualText, candidateRecord = null) {
  const cleanPhone = normalizePhone(toPhone);
  if (!cleanPhone || !manualText) return;

  const node = await getOrCreateCandidateNode(cleanPhone, candidateRecord || {});
  const ts = new Date().toISOString();

  // Classify boss message intent via local zero-token Laya
  const bossIntent = await classifyBossIntentLaya(manualText) || 'friendly_chat';

  node.last_boss_message = manualText;
  node.last_boss_message_ts = ts;

  const gaps = getCandidateGaps(node);
  console.log(`[Sidecar] 🚀 Boss manual reply to ${node.placeholder_label} (${cleanPhone}): "${manualText.slice(0, 60)}" [Intent: ${bossIntent}]`);
  console.log(`[Sidecar] 🔍 Candidate Gaps: [${gaps.join(', ') || 'None - Profile Complete'}]`);

  // Detect gender context if mentioned in notes or text
  if (!node.gender) {
    if (/\b(?:girl|ladki|female|she|her|didi|behen)\b/i.test(manualText) || /\b(?:ladki|girl|female)\b/i.test(node.notes || '')) {
      node.gender = 'female';
    } else if (/\b(?:boy|ladka|male|he|him|bhai|bro)\b/i.test(manualText)) {
      node.gender = 'male';
    }
  }

  const sidewaysInsights = [];

  // Check 1: Real Name Missing
  if (gaps.includes('real_name')) {
    sidewaysInsights.push(`Name is still unverified. Natural prompt needed: "Btw tera naam kya hai?"`);
  }

  // Check 2: Shift Constraints / Day Shift
  if (node.shift_preference === 'Day' && !manualText.toLowerCase().includes('day')) {
    sidewaysInsights.push(`Candidate requires Day Shift strictly (curfew 9:30-10 PM). Ensure opening matched is day shift.`);
  }

  // Check 3: Reference Culture & Instagram Connection
  if (!node.ig_connected && !node.boss_story_shared) {
    sidewaysInsights.push(`Opportunity to share boss story & Instagram (@shetty_saa, MTV Hustle artist, 1L+ YouTube subs, providing verified jobs).`);
  }

  if (!node.reference_culture_pitched) {
    sidewaysInsights.push(`Opportunity to ask for referrals: "Agar koi dost ya colleague job dhundh raha ho to batana."`);
  }

  // Append note to Supabase so the entire team has visibility
  if (sidewaysInsights.length > 0) {
    try {
      const insightSummary = `[Sidecar AI] 💡 Note: ${sidewaysInsights.join(' | ')}`;
      await appendNote(cleanPhone, insightSummary);
    } catch (_) {}
  }

  persistGraphState();
  return { node, gaps, insights: sidewaysInsights, bossIntent };
}

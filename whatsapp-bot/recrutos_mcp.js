/**
 * recrutos_mcp.js — RecrutOS MCP Tool Connector
 * ===============================================
 * Exposes every RecrutOS Supabase operation as a named, typed tool
 * so the WhatsApp AI agent can call them directly without hardcoded logic.
 *
 * Tools exposed:
 *  1.  find_candidate          — Find one candidate by name or phone
 *  2.  search_candidates       — Search with filters (location, exp, process…)
 *  3.  add_candidate           — Add a new candidate to RecrutOS
 *  4.  update_candidate        — Update lineup/joined/noshow/dropout status
 *  5.  append_note             — Add a timestamped note to a candidate
 *  6.  get_today_lineup        — Get all candidates lined up for today's interviews
 *  7.  get_pending_reminders   — Get open reminders due today/tomorrow
 *  8.  get_pending_followups   — Get all open followups from Supabase
 *  9.  get_pipeline_stats      — Summary counts: total, lined up, joined, pending
 *  10. send_whatsapp           — Send a WhatsApp message to a phone number
 *  11. get_recent_candidates   — Get candidates added in the last N days
 *  12. mark_reminder_done      — Mark a reminder as completed in Supabase
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logAgentActivity } from './activity_log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH  = path.resolve(__dirname, '.env.recruiter');

let _mcpWaClient = null;
export function setMcpWaClient(client) {
  _mcpWaClient = client;
}

// ── Load env ──────────────────────────────────────────────────────────────────
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) {
      const k = m[1].trim();
      const v = m[2].trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[k] && v && !v.includes('your_')) process.env[k] = v;
    }
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BOT_USER_ID  = process.env.RECOS_BOT_USER_ID || null;

let _client = null;
function db() {
  if (!_client && SUPABASE_URL && SUPABASE_KEY) {
    _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
  return _client;
}

// Phone normalizer
function norm(raw) {
  if (!raw) return '';
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('91') && p.length === 12) p = p.slice(2);
  if (p.startsWith('0') && p.length === 11) p = p.slice(1);
  return /^[6-9]\d{9}$/.test(p) ? p : '';
}


// ── UUID / phone / name resolver ─────────────────────────────────────────────
async function resolveCandidate(client, identifier, extraSelect = '') {
  const select = ['id', 'name', 'phone', extraSelect].filter(Boolean).join(',');
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(String(identifier).trim())) {
    const { data } = await client.from('ros_candidates').select(select).eq('id', identifier).limit(1);
    return data?.[0] || null;
  }
  const digits = String(identifier).replace(/\D/g, '');
  let q = client.from('ros_candidates').select(select).or('is_trash.is.null,is_trash.eq.false');
  q = digits.length >= 6
    ? q.ilike('phone', '%' + digits.slice(-10) + '%')
    : q.ilike('name', '%' + identifier + '%');
  const { data } = await q.limit(1);
  return data?.[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL REGISTRY
// Each tool: { name, description, schema, handler }
// handler(params, waClient?) -> { ok: true, data } | { ok: false, error }
// ─────────────────────────────────────────────────────────────────────────────

export const RECRUTOS_TOOLS = {

  // ── 1. find_candidate ──────────────────────────────────────────────────────
  find_candidate: {
    description: 'Find a single candidate by name (partial match) or 10-digit phone. Returns full profile.',
    params: ['query'],  // query: name string or phone number
    async handler({ query }) {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };
      const q = String(query || '').trim();
      if (!q) return { ok: false, error: 'query is required' };

      const isPhone = /^\d{6,}$/.test(q.replace(/\D/g, ''));
      let dbQ = client.from('ros_candidates')
        .select('id,name,phone,location,experience,years,process,comm_level,inhand_salary,lineup_status,joined_status,interview_date,notes,last_company,created_at,updated_at')
        .or('is_trash.is.null,is_trash.eq.false');

      dbQ = isPhone
        ? dbQ.ilike('phone', `%${q.replace(/\D/g, '').slice(-10)}%`)
        : dbQ.ilike('name', `%${q}%`);

      const { data, error } = await dbQ.order('updated_at', { ascending: false }).limit(5);
      if (error) return { ok: false, error: error.message };
      if (!data || data.length === 0) return { ok: false, error: `No candidate found for: "${q}"` };
      return { ok: true, data: data[0], all: data };
    }
  },

  // ── 2. search_candidates ──────────────────────────────────────────────────
  search_candidates: {
    description: 'Search candidates in RecrutOS with optional filters. Returns up to 40 matching candidates.',
    params: ['query', 'location', 'experience', 'process', 'lineup_status', 'limit'],
    async handler({ query = '', location, experience, process: proc, lineup_status, limit = 20 }) {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };

      let q = client.from('ros_candidates')
        .select('id,name,phone,location,experience,years,process,comm_level,inhand_salary,lineup_status,joined_status,interview_date,notes,last_company')
        .or('is_trash.is.null,is_trash.eq.false')
        .order('created_at', { ascending: false });

      if (query)         q = q.ilike('name', `%${query}%`);
      if (location)      q = q.ilike('location', `%${location}%`);
      if (experience)    q = q.ilike('experience', `%${experience}%`);
      if (proc)          q = q.ilike('process', `%${proc}%`);
      if (lineup_status) q = q.eq('lineup_status', lineup_status);

      const { data, error } = await q.limit(Math.min(limit, 40));
      if (error) return { ok: false, error: error.message };
      return { ok: true, data: data || [], count: (data || []).length };
    }
  },

  // ── 3. add_candidate ──────────────────────────────────────────────────────
  add_candidate: {
    description: 'Add a new candidate to RecrutOS database. Source is WhatsApp.',
    params: ['name', 'phone', 'location', 'experience', 'process', 'inhand_salary', 'comm_level', 'qualification', 'last_company', 'notes'],
    async handler(params) {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };
      if (!BOT_USER_ID) return { ok: false, error: 'RECOS_BOT_USER_ID not set in .env.recruiter' };
      if (!params.name || params.name.trim().length < 2) return { ok: false, error: 'Valid candidate name is required' };

      // Validate 10-digit phone number
      const phoneDigits = norm(params.phone) || String(params.phone || '').replace(/\D/g, '').slice(-10);
      if (!phoneDigits || !/^[6-9]\d{9}$/.test(phoneDigits)) {
        return { ok: false, error: 'A valid 10-digit mobile number starting with 6-9 is required to add candidate.' };
      }

      // Check spam names
      const nameLower = params.name.toLowerCase().trim();
      const SPAM_NAMES = ['thank you', 'thanks', 'auto reply', 'out of office', 'dear customer', 'friend', 'lead', 'who are you', 'unknown', 'not provided'];
      if (SPAM_NAMES.some(s => nameLower === s || nameLower.startsWith(s + ' '))) {
        return { ok: false, error: 'Invalid candidate name — looks like a spam/auto-reply message.' };
      }

      // Dedup check across spaces, +91, etc.
      const wild = '%' + phoneDigits.split('').join('%') + '%';
      const { data: existingList } = await client.from('ros_candidates')
        .select('id,name,phone,is_trash')
        .or('is_trash.is.null,is_trash.eq.false')
        .ilike('phone', wild);
      const existing = (existingList || []).find(c => {
        const d = String(c.phone || '').replace(/\D/g, '');
        return d.slice(-10) === phoneDigits && !c.is_trash;
      });
      if (existing) {
        return { ok: true, data: existing, message: `⚠️ Candidate with phone ${phoneDigits} already exists as "${existing.name}" (ID: ${existing.id}).` };
      }

      const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const sourceNote = `[${ts}] [WhatsApp] Added via Saa agent.`;
      const notes = params.notes ? `${sourceNote}\n${params.notes}` : sourceNote;

      const row = {
        user_id: BOT_USER_ID,
        name: params.name.trim(),
        phone: phoneDigits,
        location: params.location || '',
        experience: params.experience || '',
        process: params.process || '',
        inhand_salary: params.inhand_salary ? String(params.inhand_salary) : '',
        comm_level: params.comm_level || '',
        qualification: params.qualification || '',
        last_company: params.last_company || '',
        currently_working: params.currently_working || '',
        is_trash: false,
        notes,
        created_at: new Date().toISOString(),
      };

      const { data, error } = await client.from('ros_candidates').insert(row).select().single();
      if (error) return { ok: false, error: error.message };

      // 🚀 Auto-purge matching candy logs
      try {
        const { data: candyMatches } = await client
          .from('ros_candy_updates')
          .select('id, phone, name')
          .ilike('phone', wild);
        const targets = (candyMatches || []).filter(c => {
          const d = String(c.phone || '').replace(/\D/g, '');
          return d.length >= 10 && d.slice(-10) === phoneDigits;
        });
        if (targets.length > 0) {
          await client.from('ros_candy_updates').delete().in('id', targets.map(t => t.id));
          console.log(`[RecrutOS MCP] 🗑️ Automatically purged ${targets.length} candy record(s) matching ${phoneDigits}`);
        }
      } catch (err) {
        console.error('[RecrutOS MCP] Error auto-purging candy:', err.message);
      }

      if (!params._options?.skipActivityLog) {
        logAgentActivity(params.waClient || _mcpWaClient, {
          action: 'Candidate Added to RecrutOS',
          category: 'RECRUTOS',
          candidateName: row.name,
          candidatePhone: row.phone,
          candidateId: data?.id,
          details: `Process: ${row.process || 'BPO'} | Location: ${row.location || 'Mumbai'} | Experience: ${row.experience || 'Fresher'}`,
          source: 'RecrutOS MCP (add_candidate)',
          notifyBoss: true,
        }).catch(() => {});
      }

      return { ok: true, data, message: `✅ ${row.name} (${row.phone}) added to RecrutOS.` };
    }
  },

  // ── 3B. trash_candidate ───────────────────────────────────────────────────
  trash_candidate: {
    description: 'Move a candidate to trash in RecrutOS (soft delete).',
    params: ['identifier'],
    async handler({ identifier, waClient, _options }) {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };
      if (!identifier) return { ok: false, error: 'identifier (name or phone) is required' };

      const cand = await resolveCandidate(client, identifier);
      if (!cand) return { ok: false, error: `Candidate "${identifier}" not found` };

      const { error } = await client.from('ros_candidates')
        .update({ is_trash: true, updated_at: new Date().toISOString() })
        .eq('id', cand.id);

      if (error) return { ok: false, error: error.message };

      if (!_options?.skipActivityLog) {
        logAgentActivity(waClient || _mcpWaClient, {
          action: 'Candidate Moved to Trash',
          category: 'RECRUTOS',
          candidateName: cand.name,
          candidatePhone: cand.phone,
          candidateId: cand.id,
          details: `Candidate moved to trash by recruiter command.`,
          source: 'RecrutOS MCP (trash_candidate)',
          notifyBoss: true,
        }).catch(() => {});
      }

      return { ok: true, candidate: cand, message: `🗑️ ${cand.name} moved to trash in RecrutOS.` };
    }
  },

  // ── 4. update_candidate ───────────────────────────────────────────────────
  update_candidate: {
    description: 'Update a candidate\'s status fields: lineup_status, joined_status, interview_date, process, inhand_salary, etc.',
    params: ['identifier', 'updates'],
    async handler({ identifier, updates, waClient, _options }) {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };
      if (!identifier) return { ok: false, error: 'identifier (name or phone) required' };
      if (!updates || Object.keys(updates).length === 0) return { ok: false, error: 'updates object required' };

      const cand = await resolveCandidate(client, identifier);
      if (!cand) return { ok: false, error: `Candidate "${identifier}" not found` };

      const { error } = await client.from('ros_candidates')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', cand.id);

      if (error) return { ok: false, error: error.message };

      if (!_options?.skipActivityLog) {
        const updateSummary = Object.entries(updates).map(([k, v]) => `${k}: ${v}`).join(' | ');
        logAgentActivity(waClient || _mcpWaClient, {
          action: 'Candidate Updated in RecrutOS',
          category: 'RECRUTOS',
          candidateName: cand.name,
          candidatePhone: cand.phone,
          candidateId: cand.id,
          details: updateSummary,
          source: 'RecrutOS MCP (update_candidate)',
          notifyBoss: true,
        }).catch(() => {});
      }

      return { ok: true, candidate: cand, message: `✅ ${cand.name} updated in RecrutOS.` };
    }
  },

  // ── 5. append_note ────────────────────────────────────────────────────────
  append_note: {
    description: 'Append a timestamped note to a candidate\'s notes field in RecrutOS.',
    params: ['identifier', 'note'],
    async handler({ identifier, note, waClient, _options }) {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };
      if (!identifier || !note) return { ok: false, error: 'identifier and note are required' };

      const cand = await resolveCandidate(client, identifier, 'notes');
      if (!cand) return { ok: false, error: `Candidate "${identifier}" not found` };

      const ts  = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const newNotes = `[${ts}] [Saa Office] ${note.trim()}\n${cand.notes || ''}`.trim();

      await client.from('ros_candidates')
        .update({ notes: newNotes, updated_at: new Date().toISOString() })
        .eq('id', cand.id);

      if (!_options?.skipActivityLog) {
        logAgentActivity(waClient || _mcpWaClient, {
          action: 'Note Added in RecrutOS',
          category: 'NOTE',
          candidateName: cand.name,
          candidatePhone: cand.phone,
          candidateId: cand.id,
          details: note.trim(),
          source: 'RecrutOS MCP (append_note)',
          notifyBoss: true,
        }).catch(() => {});
      }

      return { ok: true, candidate: cand, message: `📝 Note added to ${cand.name}.` };
    }
  },

  // ── 6. get_today_lineup ───────────────────────────────────────────────────
  get_today_lineup: {
    description: 'Get all candidates lined up for interviews today. Returns name, phone, process, company.',
    params: ['date'],  // date: YYYY-MM-DD (defaults to today IST)
    async handler({ date } = {}) {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };

      const todayIST = date || new Date(Date.now() + 5.5 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);

      const { data, error } = await client.from('ros_candidates')
        .select('id,name,phone,process,location,experience,inhand_salary,lineup_status,joined_status,interview_date,notes,last_company')
        .or('is_trash.is.null,is_trash.eq.false')
        .eq('lineup_status', 'Yes')
        .eq('interview_date', todayIST)
        .order('name');

      if (error) return { ok: false, error: error.message };
      return { ok: true, data: data || [], date: todayIST, count: (data || []).length };
    }
  },

  // ── 7. get_pending_reminders ──────────────────────────────────────────────
  get_pending_reminders: {
    description: 'Get all pending reminders from RecrutOS for today and tomorrow.',
    params: [],
    async handler() {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };

      const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const tomorrowIST = new Date(Date.now() + (5.5 + 24) * 60 * 60 * 1000).toISOString().slice(0, 10);

      const { data, error } = await client.from('ros_reminders')
        .select('id,candidate_name,candidate_phone,reminder_date,reminder_time,note,completed,snooze_count')
        .in('reminder_date', [todayIST, tomorrowIST])
        .neq('completed', 'true')
        .order('reminder_date');

      if (error) return { ok: false, error: error.message };
      const filtered = (data || []).filter(r => r.snooze_count === null || Number(r.snooze_count) < 99);
      return { ok: true, data: filtered, count: filtered.length };
    }
  },

  // ── 8. get_pending_followups ──────────────────────────────────────────────
  get_pending_followups: {
    description: 'Get all pending followups from RecrutOS for today and this week.',
    params: [],
    async handler() {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };

      const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const { data, error } = await client.from('ros_followups')
        .select('id,candidate_name,candidate_phone,followup_date,note,status')
        .lte('followup_date', todayIST)
        .neq('status', 'Done')
        .order('followup_date');

      if (error) return { ok: false, error: error.message };
      return { ok: true, data: data || [], count: (data || []).length };
    }
  },

  // ── 9. get_pipeline_stats ─────────────────────────────────────────────────
  get_pipeline_stats: {
    description: 'Get live pipeline summary: total candidates, lined up today, joined this month, pending follow-ups.',
    params: [],
    async handler() {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };

      const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const monthStart = todayIST.slice(0, 7) + '-01';

      const [total, todayLineup, joinedMonth, pendingFollowup] = await Promise.all([
        client.from('ros_candidates').select('id', { count: 'exact', head: true }).or('is_trash.is.null,is_trash.eq.false'),
        client.from('ros_candidates').select('id', { count: 'exact', head: true }).or('is_trash.is.null,is_trash.eq.false').eq('lineup_status', 'Yes').eq('interview_date', todayIST),
        client.from('ros_candidates').select('id', { count: 'exact', head: true }).or('is_trash.is.null,is_trash.eq.false').eq('joined_status', 'Joined').gte('updated_at', monthStart),
        client.from('ros_followups').select('id', { count: 'exact', head: true }).neq('status', 'Done').lte('followup_date', todayIST),
      ]);

      return {
        ok: true,
        data: {
          total_candidates:  total.count     || 0,
          today_lineup:      todayLineup.count || 0,
          joined_this_month: joinedMonth.count || 0,
          pending_followups: pendingFollowup.count || 0,
          date: todayIST,
        }
      };
    }
  },

  // ── 10. send_whatsapp ─────────────────────────────────────────────────────
  send_whatsapp: {
    description: 'Send a WhatsApp message to a phone number using the connected WhatsApp bot account.',
    params: ['phone', 'message', 'waClient'],
    async handler({ phone, message, waClient, _options }) {
      const activeClient = waClient || _mcpWaClient;
      if (!activeClient) return { ok: false, error: 'WhatsApp client not available' };
      if (!phone || !message) return { ok: false, error: 'phone and message are required' };

      const digits = String(phone).replace(/\D/g, '');
      const phone10 = digits.slice(-10);
      const waId = `91${phone10}@c.us`;

      try {
        await activeClient.sendMessage(waId, message);
        // Log send in notes if possible
        let candName = '';
        let candId = '';
        try {
          const client = db();
          if (client) {
            const { data } = await client.from('ros_candidates')
              .select('id,name,notes')
              .ilike('phone', `%${phone10}%`)
              .or('is_trash.is.null,is_trash.eq.false')
              .limit(1);
            if (data && data[0]) {
              candName = data[0].name || '';
              candId = data[0].id || '';
              const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
              const note = `[${ts}] [Saa Bot Sent] ${message.slice(0, 120)}`;
              const newNotes = `${note}\n${data[0].notes || ''}`.trim();
              await client.from('ros_candidates')
                .update({ notes: newNotes, updated_at: new Date().toISOString() })
                .eq('id', data[0].id);
            }
          }
        } catch (_) { /* non-critical */ }

        if (!_options?.skipActivityLog) {
          logAgentActivity(activeClient, {
            action: 'WhatsApp Message Sent',
            category: 'WHATSAPP',
            candidateName: candName,
            candidatePhone: phone10,
            candidateId: candId,
            details: message.slice(0, 100),
            source: 'RecrutOS MCP (send_whatsapp)',
            notifyBoss: true,
          }).catch(() => {});
        }

        return { ok: true, message: `📤 Sent to ${phone10}: "${message.slice(0, 60)}..."` };
      } catch (e) {
        return { ok: false, error: `Failed to send WhatsApp to ${phone10}: ${e.message}` };
      }
    }
  },

  // ── 11. get_recent_candidates ─────────────────────────────────────────────
  get_recent_candidates: {
    description: 'Get candidates added to RecrutOS in the last N days (default 1 day = today).',
    params: ['days'],
    async handler({ days = 1 } = {}) {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };

      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const { data, error } = await client.from('ros_candidates')
        .select('id,name,phone,location,experience,process,inhand_salary,comm_level,lineup_status,joined_status,notes,created_at')
        .or('is_trash.is.null,is_trash.eq.false')
        .gte('created_at', since)
        .order('created_at', { ascending: false });

      if (error) return { ok: false, error: error.message };
      return { ok: true, data: data || [], count: (data || []).length, since };
    }
  },

  // ── 12. mark_reminder_done ────────────────────────────────────────────────
  mark_reminder_done: {
    description: 'Mark a reminder as completed in RecrutOS by reminder ID.',
    params: ['reminder_id'],
    async handler({ reminder_id, waClient, _options }) {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };
      if (!reminder_id) return { ok: false, error: 'reminder_id required' };

      const { error } = await client.from('ros_reminders')
        .update({ completed: 'true', updated_at: new Date().toISOString() })
        .eq('id', reminder_id);

      if (error) return { ok: false, error: error.message };

      if (!_options?.skipActivityLog) {
        logAgentActivity(waClient || _mcpWaClient, {
          action: 'Reminder Marked Done',
          category: 'RECRUTOS',
          details: `Reminder #${reminder_id} completed`,
          source: 'RecrutOS MCP (mark_reminder_done)',
          notifyBoss: false,
        }).catch(() => {});
      }

      return { ok: true, message: `✅ Reminder #${reminder_id} marked done.` };
    }
  },

  // ── 13. add_reminder ──────────────────────────────────────────────────────
  add_reminder: {
    description: 'Add a new reminder or followup task in RecrutOS for a candidate.',
    params: ['identifier', 'date', 'time', 'note'],
    async handler({ identifier, date, time, note, waClient, _options }) {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };
      if (!BOT_USER_ID) return { ok: false, error: 'RECOS_BOT_USER_ID not set' };

      const cand = identifier ? await resolveCandidate(client, identifier) : null;
      const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const reminderDate = date || todayIST;
      const reminderTime = time || '11:00 AM';
      const reminderNote = note || (cand ? `Call ${cand.name}` : 'Followup reminder');

      const row = {
        user_id: BOT_USER_ID,
        candidate_name: cand ? cand.name : (identifier || 'Followup'),
        candidate_phone: cand ? (cand.phone || '') : '',
        reminder_date: reminderDate,
        reminder_time: reminderTime,
        note: reminderNote,
        completed: 'false',
        created_at: new Date().toISOString()
      };

      const { data, error } = await client.from('ros_reminders').insert(row).select().single();
      if (error) return { ok: false, error: error.message };

      if (!_options?.skipActivityLog) {
        logAgentActivity(waClient || _mcpWaClient, {
          action: 'Reminder Created',
          category: 'RECRUTOS',
          candidateName: row.candidate_name,
          candidatePhone: row.candidate_phone,
          candidateId: cand?.id,
          details: `Reminder for ${reminderDate} at ${reminderTime}: ${reminderNote}`,
          source: 'RecrutOS MCP (add_reminder)',
          notifyBoss: true,
        }).catch(() => {});
      }

      return {
        ok: true,
        data,
        candidate: cand,
        message: `🔔 Reminder set for ${row.candidate_name} on ${reminderDate} at ${reminderTime}.`
      };
    }
  },

  // ── 14. batch_reschedule_lineups ──────────────────────────────────────────
  batch_reschedule_lineups: {
    description: 'Reschedule all candidates who have an interview lineup on source_date to target_date. E.g. move today\'s lineups to tomorrow.',
    params: ['source_date', 'target_date'],
    async handler({ source_date, target_date, waClient, _options } = {}) {
      const client = db();
      if (!client) return { ok: false, error: 'DB not connected' };

      const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const tomorrowIST = new Date(Date.now() + (5.5 + 24) * 60 * 60 * 1000).toISOString().slice(0, 10);

      const fromDate = source_date || todayIST;
      const toDate = target_date || tomorrowIST;

      // Find all candidates with interview_date = fromDate
      const { data: candidates, error } = await client.from('ros_candidates')
        .select('id, name, phone, process, location, interview_date, lineup_status, notes')
        .or('is_trash.is.null,is_trash.eq.false')
        .eq('interview_date', fromDate);

      if (error) return { ok: false, error: error.message };
      if (!candidates || candidates.length === 0) {
        return {
          ok: true,
          count: 0,
          source_date: fromDate,
          target_date: toDate,
          candidates: [],
          message: `No candidates found with lineup date on ${fromDate}.`
        };
      }

      const updated = [];
      const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');

      for (const cand of candidates) {
        const newNotes = `[${ts}] [Lineup Rescheduled]: Shifted from ${fromDate} to ${toDate} by Shetty Saa\n${cand.notes || ''}`.trim();
        const { error: updErr } = await client.from('ros_candidates')
          .update({
            interview_date: toDate,
            lineup_status: 'Yes',
            notes: newNotes,
            updated_at: new Date().toISOString()
          })
          .eq('id', cand.id);

        if (!updErr) {
          updated.push(cand);
          if (!_options?.skipActivityLog) {
            logAgentActivity(waClient || _mcpWaClient, {
              action: 'Lineup Rescheduled (Bulk)',
              category: 'RECRUTOS',
              candidateName: cand.name,
              candidatePhone: cand.phone,
              candidateId: cand.id,
              details: `Interview date shifted from ${fromDate} to ${toDate} by Shetty Saa`,
              source: 'RecrutOS MCP (batch_reschedule_lineups)',
              notifyBoss: false,
            }).catch(() => {});
          }
        }
      }

      return {
        ok: true,
        count: updated.length,
        source_date: fromDate,
        target_date: toDate,
        candidates: updated,
        message: `Successfully shifted ${updated.length} candidate(s) from ${fromDate} to ${toDate}.`
      };
    }
  },

  // ── 13. get_job_description ───────────────────────────────────────────────
  get_job_description: {
    description: 'Get full Job Description (JD), hiring criteria, salary, eligibility, shifts, and interview process for any Mumbai BPO company (TechM, Accenture, Concentrix, JP Morgan, WNS, Teleperformance, Foundever, TCS, Firstsource, etc.) from training records.',
    params: ['company'],
    schema: {
      company: { type: 'STRING', description: 'Company name or alias (e.g. TechM, Accenture, WNS, Concentrix, Foundever)' }
    },
    handler: async ({ company }) => {
      const { getCompanyJDFromTraining } = await import('./saa_trainer_chat.js');
      const jd = getCompanyJDFromTraining(company || '');
      if (!jd) return { ok: false, error: `No JD found for company: ${company}` };
      return { ok: true, company, jd };
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// AGENT EXECUTOR
// Call a tool by name with params. Returns formatted string for WhatsApp.
// ─────────────────────────────────────────────────────────────────────────────

export async function callMCPTool(toolName, params = {}, waClient = null, options = {}) {
  const tool = RECRUTOS_TOOLS[toolName];
  if (!tool) return { ok: false, error: `Unknown tool: ${toolName}` };

  try {
    const effectiveClient = waClient || _mcpWaClient;
    const result = await tool.handler({ ...params, waClient: effectiveClient, _options: options });
    return result;
  } catch (e) {
    console.error(`[MCP] Tool "${toolName}" threw:`, e.message);
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL MANIFEST — for injecting into AI prompts so it knows what's available
// ─────────────────────────────────────────────────────────────────────────────

export function getMCPManifest() {
  return Object.entries(RECRUTOS_TOOLS).map(([name, tool]) =>
    `• ${name}(${tool.params.join(', ')}) — ${tool.description}`
  ).join('\n');
}

/**
 * recrutos_sync_window.js — RecrutOS Live Intelligence Window for WhatsApp Bot
 * ==============================================================================
 * Continuously tracks all updates made by the Boss/Recruiter in RecrutOS (web/mobile),
 * such as notes entered from phone calls, interview date changes, status updates,
 * and profile adjustments.
 * 
 * Ensures the bot is ALWAYS fully aware of everything the recruiter did,
 * so it never contradicts, asks redundant questions, or misses recruiter overrides.
 */

import { getClient, isDbConnected } from './recruiter_db.js';
import { updateCandidateGraphNode, getOrCreateCandidateNode } from './candidate_graph.js';

let _lastSyncTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // initial 5 min lookback
const _cachedCandidates = new Map(); // phone -> { notes, interview_date, lineup_status, updated_at }
let _syncInterval = null;

/**
 * Initializes the RecrutOS Intelligence Window polling loop.
 * Runs every 12 seconds to catch live recruiter edits in real-time.
 */
export function startRecrutOSSyncWindow(pollIntervalMs = 12000) {
  if (_syncInterval) return;
  if (!isDbConnected()) {
    console.warn('[RecrutOS Window] DB not connected, sync window paused.');
    return;
  }

  console.log('🔄 [RecrutOS Window] Live Recruiter Change Tracker — ACTIVE');

  // Initial populate of known candidates
  pollRecrutOSChanges().catch(() => {});

  _syncInterval = setInterval(() => {
    pollRecrutOSChanges().catch(err => {
      console.warn('[RecrutOS Window] Poll error:', err.message);
    });
  }, pollIntervalMs);
}

/**
 * Stop the polling loop
 */
export function stopRecrutOSSyncWindow() {
  if (_syncInterval) {
    clearInterval(_syncInterval);
    _syncInterval = null;
  }
}

/**
 * Polls Supabase for any candidates updated since _lastSyncTime.
 */
export async function pollRecrutOSChanges() {
  const client = getClient();
  if (!client) return [];

  const checkTime = _lastSyncTime;
  _lastSyncTime = new Date().toISOString();

  try {
    const { data: updatedList, error } = await client.from('ros_candidates')
      .select('id, name, phone, process, location, experience, years, inhand_salary, interview_date, lineup_status, joined_status, select_status, notes, last_company, updated_at')
      .or('is_trash.is.null,is_trash.eq.false')
      .gt('updated_at', checkTime)
      .order('updated_at', { ascending: false })
      .limit(30);

    if (error) {
      console.warn('[RecrutOS Window] Query error:', error.message);
      return [];
    }

    if (!updatedList || updatedList.length === 0) return [];

    for (const cand of updatedList) {
      const cleanPhone = String(cand.phone || '').replace(/\D/g, '').slice(-10);
      if (!cleanPhone) continue;

      const cached = _cachedCandidates.get(cleanPhone);
      const changes = [];

      if (!cached) {
        // First time seeing this candidate in this session
        _cachedCandidates.set(cleanPhone, {
          notes: cand.notes,
          interview_date: cand.interview_date,
          lineup_status: cand.lineup_status,
          joined_status: cand.joined_status,
          updated_at: cand.updated_at
        });
      } else {
        // Compare what changed
        if (cached.notes !== cand.notes) {
          changes.push(`Notes updated: "${(cand.notes || '').slice(0, 70)}..."`);
        }
        if (cached.interview_date !== cand.interview_date) {
          changes.push(`Interview Date changed: ${cached.interview_date || 'None'} → ${cand.interview_date || 'None'}`);
        }
        if (cached.lineup_status !== cand.lineup_status) {
          changes.push(`Lineup: ${cached.lineup_status || 'No'} → ${cand.lineup_status}`);
        }
        if (cached.joined_status !== cand.joined_status) {
          changes.push(`Joined: ${cached.joined_status || 'No'} → ${cand.joined_status}`);
        }

        // Update cache
        _cachedCandidates.set(cleanPhone, {
          notes: cand.notes,
          interview_date: cand.interview_date,
          lineup_status: cand.lineup_status,
          joined_status: cand.joined_status,
          updated_at: cand.updated_at
        });

        if (changes.length > 0) {
          console.log(`\n🔄 [RecrutOS Window] Recruiter edit detected for ${cand.name} (${cleanPhone}):`);
          changes.forEach(ch => console.log(`   • ${ch}`));

          // Immediately sync changes to Candidate Knowledge Graph
          await updateCandidateGraphNode(cleanPhone, {
            name: cand.name,
            location: cand.location,
            process: cand.process,
            experience: cand.experience,
            years: cand.years,
            inhand_salary: cand.inhand_salary,
            last_company: cand.last_company
          }).catch(() => {});
        }
      }
    }

    return updatedList;
  } catch (err) {
    console.warn('[RecrutOS Window] Exception during poll:', err.message);
    return [];
  }
}

/**
 * Returns latest recruiter instructions and notes for a candidate phone.
 */
export function getRecruiterIntelligence(phone) {
  const cleanPhone = String(phone || '').replace(/\D/g, '').slice(-10);
  if (!cleanPhone) return null;
  return _cachedCandidates.get(cleanPhone) || null;
}

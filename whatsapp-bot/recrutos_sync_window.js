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
import { logAgentActivity } from './activity_log.js';

let _lastSyncTime = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // initial 5 min lookback
const _cachedCandidates = new Map(); // phone -> { name, notes, interview_date, lineup_status, joined_status, select_status, process, location, updated_at }
let _syncInterval = null;
let _isInitialBoot = true;

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

    if (!updatedList || updatedList.length === 0) {
      _isInitialBoot = false;
      return [];
    }

    for (const cand of updatedList) {
      const cleanPhone = String(cand.phone || '').replace(/\D/g, '').slice(-10);
      if (!cleanPhone) continue;

      const cached = _cachedCandidates.get(cleanPhone);
      const changes = [];

      if (!cached) {
        if (_isInitialBoot) {
          // Warmup on bot boot: populate initial cache without printing diffs
          _cachedCandidates.set(cleanPhone, {
            name: cand.name,
            notes: cand.notes,
            interview_date: cand.interview_date,
            lineup_status: cand.lineup_status,
            joined_status: cand.joined_status,
            select_status: cand.select_status,
            process: cand.process,
            location: cand.location,
            updated_at: cand.updated_at
          });
          continue;
        }

        // Post-boot edit: Candidate was just updated or added in RecrutOS by recruiter!
        changes.push(`Recruiter modified candidate in RecrutOS: Notes: "${(cand.notes || '').slice(0, 80)}" | Lineup: ${cand.lineup_status || 'No'} | Date: ${cand.interview_date || 'None'}`);
      } else {
        // Precise field-by-field diff
        if (cached.notes !== cand.notes) {
          changes.push(`Notes updated: "${(cand.notes || '').slice(0, 80)}..."`);
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
        if (cached.select_status !== cand.select_status) {
          changes.push(`Selection: ${cached.select_status || 'No'} → ${cand.select_status}`);
        }
        if (cached.process !== cand.process) {
          changes.push(`Process: ${cached.process || 'N/A'} → ${cand.process}`);
        }
        if (cached.location !== cand.location) {
          changes.push(`Location: ${cached.location || 'N/A'} → ${cand.location}`);
        }
      }

      // Update cache
      _cachedCandidates.set(cleanPhone, {
        name: cand.name,
        notes: cand.notes,
        interview_date: cand.interview_date,
        lineup_status: cand.lineup_status,
        joined_status: cand.joined_status,
        select_status: cand.select_status,
        process: cand.process,
        location: cand.location,
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

        // Log to activity feed so RecrutOS notification feed reflects recruiter changes live
        logAgentActivity(null, {
          action: 'Recruiter Update Synced 🔄',
          category: 'RECRUTOS',
          candidateName: cand.name,
          candidatePhone: cleanPhone,
          candidateId: cand.id,
          details: changes.join(' · '),
          source: 'RecrutOS Sync Window',
          notifyBoss: false
        }).catch(() => {});
      }
    }

    _isInitialBoot = false;
    return updatedList;
  } catch (err) {
    console.warn('[RecrutOS Window] Exception during poll:', err.message);
    _isInitialBoot = false;
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

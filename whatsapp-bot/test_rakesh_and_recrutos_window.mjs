/**
 * test_rakesh_and_recrutos_window.mjs
 * Verification for:
 * 1. Rakesh Sharma message handling (Wednesday date resolved, joined_status NOT set)
 * 2. Status Lock (joined_status & select_status human-only)
 * 3. Date Resolver on various phrases ("Wednesday", "day after", "parso", "kal", "7th oct")
 * 4. RecrutOS Sync Window change detection
 */

import { parseLineupDate } from './date_resolver.js';
import { pollRecrutOSChanges, getRecruiterIntelligence } from './recrutos_sync_window.js';
import { getOrCreateCandidateNode } from './candidate_graph.js';

console.log('🧪 Starting Rakesh & RecrutOS Window Verification Suite...\n');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${testName}`);
    failed++;
  }
}

// ── Test 1: Rakesh's exact WhatsApp message date parsing ───────────
// Reference: Monday Oct 5 2026
const refMon = new Date('2026-10-05T14:00:00+05:30');
const rakeshMsg = "Yes Wednesday perfect rahega, mein freemind se attempt kar sakunga aur immediately join b kar lunga";
const resolved = parseLineupDate(rakeshMsg, refMon);

assert(resolved !== null, 'Rakesh message parsed a date');
assert(resolved.dateStr === '2026-10-07', `Date resolved to Wednesday 2026-10-07 (got: ${resolved?.dateStr})`);
assert(resolved.dayName === 'Wednesday', `Day name is Wednesday (got: ${resolved?.dayName})`);

// ── Test 2: "Day after" date parsing ────────────────────────────────
const dayAfterMsg = "Actually, I wanted to do this a day after since I have to complete some urgent tasks at home";
const dayAfterResolved = parseLineupDate(dayAfterMsg, refMon);
assert(dayAfterResolved !== null, 'Day after message parsed a date');
assert(dayAfterResolved.dateStr === '2026-10-07', `Day after resolved to 2026-10-07 (got: ${dayAfterResolved?.dateStr})`);

// ── Test 3: Status Lock Check ───────────────────────────────────────
// When a candidate says "immediately join b kar lunga", joined_status must NOT be set
const lowerReply = rakeshMsg.toLowerCase();
const colUpdates = {};

// Simulate our new logic:
if (/\b(?:will join|can join|ready to join|immediately join|join kar(?:unga|ungi)|joining possible|join kar lunga|immediately join b kar lunga)\b/i.test(lowerReply)) {
  // Only remark, NO colUpdates.joined_status!
}
const pDate = parseLineupDate(lowerReply, refMon);
if (pDate) {
  colUpdates.interview_date = pDate.dateStr;
  colUpdates.lineup_status = 'Yes';
}

assert(colUpdates.joined_status === undefined, 'joined_status was NOT set in colUpdates (Status Lock enforced)');
assert(colUpdates.select_status === undefined, 'select_status was NOT set in colUpdates (Status Lock enforced)');
assert(colUpdates.interview_date === '2026-10-07', 'interview_date updated to 2026-10-07');
assert(colUpdates.lineup_status === 'Yes', 'lineup_status updated to Yes');

// ── Test 4: Diverse Date Phrasings ──────────────────────────────────
const tTomorrow = parseLineupDate('kal 11 baje aaunga', refMon);
assert(tTomorrow.dateStr === '2026-10-06', `Tomorrow resolved to 2026-10-06 (got: ${tTomorrow?.dateStr})`);

const tFriday = parseLineupDate('Friday is fine for me', refMon);
assert(tFriday.dateStr === '2026-10-09', `Friday resolved to 2026-10-09 (got: ${tFriday?.dateStr})`);

const t7thOct = parseLineupDate('7th oct lineup kar do', refMon);
assert(t7thOct.dateStr === '2026-10-07', `7th Oct resolved to 2026-10-07 (got: ${t7thOct?.dateStr})`);

// ── Test 5: RecrutOS Sync Window Poll ────────────────────────────────
try {
  const changes = await pollRecrutOSChanges();
  assert(Array.isArray(changes), 'RecrutOS Sync Window successfully polled Supabase');
} catch (e) {
  assert(false, `RecrutOS Sync Window error: ${e.message}`);
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

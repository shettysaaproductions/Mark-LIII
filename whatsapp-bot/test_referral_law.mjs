/**
 * test_referral_law.mjs
 * Comprehensive validation of the Law of Multi-Resume & Referral Extraction.
 */

import {
  isReferralResume,
  handleReferralResume,
  checkAndResolvePendingReferral,
  getOrCreateCandidateNode
} from './candidate_graph.js';
import { normalizePhone } from './candidate_graph.js';

console.log('🧪 Starting Referral Law Verification Suite...\n');

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

// ── Test 1: Referral Resume with Different Phone Number ─────────────
const t1 = isReferralResume(
  '9552876076', // Nishad Joshi (Sender)
  'Nishad Joshi',
  '9820543210', // Candidate Phone on CV
  'Aakash Mehta',
  '',
  { name: 'Nishad Joshi', phone: '+91 95528 76076' }
);
assert(t1.isReferral === true, 'Different phone number detected as referral');
assert(t1.reason === 'different_phone', 'Reason is different_phone');
assert(t1.refPhone === '9820543210', 'Extracted referral phone matches');

// ── Test 2: Referral Resume with Text Mentioning Friend/Reference ─────
const t2 = isReferralResume(
  '9552876076',
  'Nishad Joshi',
  '', // No phone on CV
  'Rohit Verma',
  'ye mere dost ka cv hai check kar lo',
  { name: 'Nishad Joshi', phone: '+91 95528 76076' }
);
assert(t2.isReferral === true, 'Referral keywords in text detected as referral');
assert(t2.reason === 'different_name' || t2.reason === 'text_indicated', 'Reason matches referral criteria');

// ── Test 3: Existing Placed Sender Sending Another CV ───────────────
const t3 = isReferralResume(
  '9552876076',
  'Nishad Joshi',
  '', // No phone on CV
  'Sameer Sawant',
  '',
  { name: 'Nishad Joshi', phone: '+91 95528 76076', lineup_status: 'Yes', last_company: 'JPMC CNX' }
);
assert(t3.isReferral === true, 'Existing placed candidate sending CV with different name detected as referral');

// ── Test 4: Sender Sending Their Own Resume ─────────────────────────
const t4 = isReferralResume(
  '9834996754',
  'Priya',
  '9834996754',
  'Priya Sharma',
  'Here is my resume',
  null
);
assert(t4.isReferral === false, 'Same phone number recognized as sender own CV');

// ── Test 5: Missing Phone on Referral CV sets Pending Referral ──────
const fakeCvNoPhone = {
  name: 'Kunal Deshmukh',
  experience: 'Experienced',
  years: '2',
  last_company: 'WNS',
  inhand_salary: '24000',
  qualification: 'Graduate',
  location: 'Thane'
};

const outcomeNoPhone = await handleReferralResume(
  null, // mock client
  '9552876076',
  'Nishad Joshi',
  fakeCvNoPhone,
  'Kunal ka cv hai'
);
assert(outcomeNoPhone.isReferral === true, 'Handled referral with no phone');
assert(outcomeNoPhone.ackText.includes('contact number'), 'Acknowledgment prompts for contact number');

const nodeNishad = await getOrCreateCandidateNode('9552876076');
assert(nodeNishad.pending_referral !== null, 'Pending referral recorded in knowledge graph');
assert(nodeNishad.pending_referral.name === 'Kunal Deshmukh', 'Pending referral name matches');

// ── Test 6: Follow-up Message with Phone Number Resolves Referral ───
const resolveMsg = await checkAndResolvePendingReferral(
  null,
  '9552876076',
  'Nishad Joshi',
  'Uska number yeh hai 9819234567'
);
assert(resolveMsg !== null, 'Pending referral resolved from follow-up text');
assert(resolveMsg.includes('9819234567'), 'Resolved message mentions extracted phone');
assert(resolveMsg.includes('Kunal Deshmukh'), 'Resolved message mentions candidate name');

const nodeNishadAfter = await getOrCreateCandidateNode('9552876076');
assert(nodeNishadAfter.pending_referral === null, 'Pending referral cleared after resolution');

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

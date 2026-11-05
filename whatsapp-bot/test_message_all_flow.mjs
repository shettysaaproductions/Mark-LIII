import assert from 'node:assert';
import {
  isMsgAllCommand,
  extractMsgAllPayload,
  isCancelBroadcastCommand,
  getPendingAllBroadcast,
  setPendingAllBroadcast,
  clearPendingAllBroadcast,
  handleTrainerChatMessage,
  getAllRecrutOSCandidates,
} from './saa_trainer_chat.js';
import { setGlobalAutoReplyPaused } from './bot_pause_state.js';

console.log('🧪 Starting Mass Broadcast "message all" Flow Tests...\n');

// ── Test 1: Command Detection ───────────────────────────────────────────────
console.log('Test 1: isMsgAllCommand & extractMsgAllPayload...');
assert.strictEqual(isMsgAllCommand('message all'), true);
assert.strictEqual(isMsgAllCommand('msg all'), true);
assert.strictEqual(isMsgAllCommand('broadcast all'), true);
assert.strictEqual(isMsgAllCommand('send to all'), true);
assert.strictEqual(isMsgAllCommand('text all candidates'), true);
assert.strictEqual(isMsgAllCommand('message all candidates'), true);
assert.strictEqual(isMsgAllCommand('Message All'), true);
assert.strictEqual(isMsgAllCommand('text all today'), false, 'Should exclude text all today');

assert.strictEqual(extractMsgAllPayload('message all'), '');
assert.strictEqual(extractMsgAllPayload('msg all'), '');
assert.strictEqual(extractMsgAllPayload('message all candidates'), '');
assert.strictEqual(extractMsgAllPayload('message all please'), '');
assert.strictEqual(extractMsgAllPayload('message all: Walkin drive at 11am'), 'Walkin drive at 11am');
assert.strictEqual(extractMsgAllPayload('msg all Happy Diwali'), 'Happy Diwali');
console.log('✅ Test 1 passed!\n');

// ── Test 2: Cancel Detection ────────────────────────────────────────────────
console.log('Test 2: isCancelBroadcastCommand...');
assert.strictEqual(isCancelBroadcastCommand('stop'), true);
assert.strictEqual(isCancelBroadcastCommand('cancel'), true);
assert.strictEqual(isCancelBroadcastCommand('Stop'), true);
assert.strictEqual(isCancelBroadcastCommand('CANCEL'), true);
assert.strictEqual(isCancelBroadcastCommand('stop it'), true);
assert.strictEqual(isCancelBroadcastCommand('cancel broadcast'), true);
assert.strictEqual(isCancelBroadcastCommand('stop broadcast'), true);
assert.strictEqual(isCancelBroadcastCommand('cancel command'), true);
assert.strictEqual(isCancelBroadcastCommand('no'), true);
assert.strictEqual(isCancelBroadcastCommand("don't send"), true);
assert.strictEqual(isCancelBroadcastCommand("dont send"), true);

// Must not match broadcast messages that happen to start with Stop
assert.strictEqual(isCancelBroadcastCommand('Stop waiting! Walkin interview tomorrow at 11 AM.'), false);
assert.strictEqual(isCancelBroadcastCommand('We have 20 openings at Teleperformance Malad.'), false);
console.log('✅ Test 2 passed!\n');

// ── Test 3: Real Database Candidate Fetch ────────────────────────────────────
console.log('Test 3: Fetching actual candidates from RecrutOS Supabase...');
const realCandidates = await getAllRecrutOSCandidates();
console.log(`Found ${realCandidates.length} active candidates in Supabase.`);
assert.ok(realCandidates.length > 0, 'Database should contain active candidates');
console.log('✅ Test 3 passed!\n');

// ── Mock WhatsApp Client ────────────────────────────────────────────────────
function createMockWaClient() {
  const sentMessages = [];
  return {
    sentMessages,
    sendMessage: async (to, text) => {
      sentMessages.push({ to, text });
      return { id: 'mock-msg-id' };
    }
  };
}

// ── Test 4: Two-Step Flow with Cancellation ("stop") ────────────────────────
console.log('Test 4: Two-step flow with cancellation ("stop")...');
clearPendingAllBroadcast();

const mockClient = createMockWaClient();
const reply1 = await handleTrainerChatMessage('message all', mockClient);
console.log('Step 1 Reply:\n' + reply1);

assert.ok(reply1.includes('We find '), 'Reply must state "We find X candidates"');
assert.ok(reply1.includes('What message do you want to trigger exactly? Please type that message to me.'), 'Reply must ask for exact message');
assert.ok(getPendingAllBroadcast() !== null, 'Pending state must be active');

// Now user cancels with "stop"
const replyCancel = await handleTrainerChatMessage('stop', mockClient);
console.log('\nStep 2 (Stop) Reply:\n' + replyCancel);

assert.ok(replyCancel.includes('Broadcast Cancelled'), 'Should confirm cancellation');
assert.ok(replyCancel.includes('No messages were sent'), 'Should confirm no messages sent');
assert.strictEqual(getPendingAllBroadcast(), null, 'Pending state must be cleared');
assert.strictEqual(mockClient.sentMessages.length, 0, 'No messages should have been sent to candidates');
console.log('✅ Test 4 passed!\n');

// ── Test 5: Two-Step Flow with Cancellation ("cancel") ──────────────────────
console.log('Test 5: Two-step flow with cancellation ("cancel")...');
clearPendingAllBroadcast();

const reply1b = await handleTrainerChatMessage('msg all', mockClient);
assert.ok(reply1b.includes('We find '));
assert.ok(getPendingAllBroadcast() !== null);

const replyCancel2 = await handleTrainerChatMessage('cancel', mockClient);
console.log('Step 2 (Cancel) Reply:\n' + replyCancel2);

assert.ok(replyCancel2.includes('Broadcast Cancelled'));
assert.strictEqual(getPendingAllBroadcast(), null);
console.log('✅ Test 5 passed!\n');

// ── Test 6: Two-Step Flow with Successful Trigger ───────────────────────────
console.log('Test 6: Two-step flow with user message trigger...');
clearPendingAllBroadcast();

// Inject small sample for test execution so we don't spam 400 real network calls during test
const mockCandidates = [
  { id: 'c1', name: 'Ganesh Shinde', phone: '9820098200' },
  { id: 'c2', name: 'Priya Sharma', phone: '9820098201' }
];

// Step 1: User says "message all"
await handleTrainerChatMessage('message all', mockClient);
// Override candidates in pending state with our 2 mock candidates
setPendingAllBroadcast(mockCandidates);

// Step 2: User types their message
const broadcastMessage = 'Hello {name}, walk-in interview tomorrow at 11 AM in Malad office. Please carry your resume.';
const triggerReply = await handleTrainerChatMessage(broadcastMessage, mockClient);
console.log('Step 2 (Trigger) Ack Reply:\n' + triggerReply);

assert.ok(triggerReply.includes('Mass Broadcast Initiated to All Candidates!'));
assert.ok(triggerReply.includes('Total Recipients: *2 candidates*'));
assert.ok(triggerReply.includes(broadcastMessage));
assert.strictEqual(getPendingAllBroadcast(), null, 'Pending state must be cleared after trigger');

// Wait brief moment for mock background async loop to deliver
await new Promise(r => setTimeout(r, 4500));
console.log(`Delivered ${mockClient.sentMessages.length} messages in background.`);
assert.ok(mockClient.sentMessages.length >= 2, 'Should have delivered messages to mock candidates');
console.log('Sample sent message to candidate:', mockClient.sentMessages[0]);
assert.ok(mockClient.sentMessages[0].text.includes('Hello Ganesh'), 'Personalized {name} template supported');
console.log('✅ Test 6 passed!\n');

// ── Test 7: Master Stop cleans pending broadcast ─────────────────────────────
console.log('Test 7: Master stop resets pending broadcast...');
clearPendingAllBroadcast();
await handleTrainerChatMessage('message all', mockClient);
assert.ok(getPendingAllBroadcast() !== null);

const masterStopReply = await handleTrainerChatMessage('stop replying everyone', mockClient);
assert.ok(masterStopReply.includes('Stopped Replying to Everyone') || masterStopReply.includes('STOPPED'));
assert.strictEqual(getPendingAllBroadcast(), null, 'Pending broadcast must be cleared on master stop');
// Restore original requested user pause state
setGlobalAutoReplyPaused(true, 'User requested: stop replying to everyone and listen until asked');
console.log('✅ Test 7 passed!\n');

console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! 🚀');
process.exit(0);

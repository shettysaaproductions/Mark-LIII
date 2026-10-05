/**
 * laya_client.js — High-Speed Local Decision Client for WhatsApp Bot & RecrutOS
 * ==============================================================================
 * Connects to the local Laya Decision Engine (http://127.0.0.1:5115/decide).
 * Runs constrained choices (intents, qualifications, experience, processes)
 * in ~20-50ms using ONNX Runtime with ZERO cloud LLM token consumption.
 *
 * Falls back gracefully to heuristic/rule-based logic if Laya is offline.
 */

const LAYA_URL = process.env.LAYA_SERVER_URL || 'http://127.0.0.1:5115';
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Make a constrained decision using Laya model.
 * @param {string} state - The input context or user message
 * @param {string} question - The specific decision question
 * @param {string[]} options - List of choices (e.g. ['pipeline_query', 'add_candidate', 'greeting'])
 * @param {string} [questionType='choice'] - 'choice' | 'noul' | 'score'
 * @param {number} [timeoutMs=600]
 * @returns {Promise<{answer: string|boolean|number, confidence: number, latency_ms: number, method: string}|null>}
 */
export async function decideLaya(state, question, options = [], questionType = 'choice', timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!state || !question) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${LAYA_URL}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state,
        question,
        question_type: questionType,
        options,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    // Silent fallback — server might be warming up or offline
    return null;
  }
}

/**
 * Check if the local Laya Decision microservice is running and ready.
 * @returns {Promise<boolean>}
 */
export async function isLayaAvailable() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 400);
    const res = await fetch(`${LAYA_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === 'ok' && data.ready === true;
  } catch (_) {
    return false;
  }
}

/**
 * High-level classifier for candidate qualification.
 * Maps any freeform qualification text to one of the 5 canonical options.
 * @param {string} text
 * @returns {Promise<string|null>}
 */
export async function classifyQualificationLaya(text) {
  const options = ['Graduate', 'Undergraduate', 'HSC', 'Post Graduate', 'Diploma'];
  const res = await decideLaya(text, 'What is the highest educational qualification?', options);
  if (res && res.confidence >= 0.55 && options.includes(res.answer)) {
    return res.answer;
  }
  return null;
}

/**
 * High-level classifier for candidate experience level (Fresher vs Experienced).
 * @param {string} text
 * @returns {Promise<'Fresher'|'Experienced'|null>}
 */
export async function classifyExperienceLaya(text) {
  const options = ['Fresher', 'Experienced'];
  const res = await decideLaya(text, 'Is the candidate a fresher or experienced?', options);
  if (res && res.confidence >= 0.55 && options.includes(res.answer)) {
    return res.answer;
  }
  return null;
}

/**
 * Classify candidate intent into actionable categories using Laya (0 tokens).
 * @param {string} text
 * @returns {Promise<string|null>}
 */
export async function classifyCandidateIntentLaya(text) {
  const options = ['greeting', 'job_inquiry', 'resume_sharing', 'day_shift_constraint', 'interview_ready', 'rejection_or_busy'];
  const res = await decideLaya(text, 'What is the candidate intent?', options);
  if (res && res.confidence >= 0.50 && options.includes(res.answer)) {
    return res.answer;
  }
  return null;
}

/**
 * Classify boss manual message intent using Laya (0 tokens).
 * @param {string} text
 * @returns {Promise<string|null>}
 */
export async function classifyBossIntentLaya(text) {
  const options = ['friendly_chat', 'interview_scheduled', 'asked_details', 'instruction', 'acknowledgment'];
  const res = await decideLaya(text, 'What is the recruiter/boss intention in this message?', options);
  if (res && res.confidence >= 0.50 && options.includes(res.answer)) {
    return res.answer;
  }
  return null;
}

/**
 * Classify shift preference (Day vs Night) using Laya (0 tokens).
 * @param {string} text
 * @returns {Promise<'Day'|'Night'|'Any'|null>}
 */
export async function classifyShiftPreferenceLaya(text) {
  const options = ['Day', 'Night', 'Any'];
  const res = await decideLaya(text, 'Which work shift is preferred or allowed?', options);
  if (res && res.confidence >= 0.50 && options.includes(res.answer)) {
    return res.answer;
  }
  return null;
}


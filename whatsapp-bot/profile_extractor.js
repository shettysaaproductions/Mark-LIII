/**
 * profile_extractor.js — Multi-Field Candidate Intelligence Parser
 * ================================================================
 * Extracts multiple profile fields (Name, Location, Experience, Process,
 * Salary, Qualification, Communication level) from a single conversational message.
 * Eliminates repetitive questioning loops and accurately parses natural candidate replies.
 */

export const MUMBAI_LOCATIONS = [
  'mira road', 'miraroad', 'bhayandar', 'bhayander', 'dahisar', 'borivali', 'kandivali', 'malad',
  'goregaon', 'jogeshwari', 'andheri', 'vile parle', 'santacruz', 'bandra', 'khar', 'dadar',
  'kurla', 'ghatkopar', 'bhandup', 'mulund', 'thane', 'kalwa', 'diva', 'dombivli', 'kalyan',
  'vashi', 'sanpada', 'juinagar', 'nerul', 'seawoods', 'belapur', 'kharghar', 'panvel',
  'airoli', 'rabale', 'ghansoli', 'koparkhairane', 'turbhe', 'powai', 'vikhroli', 'chembur', 'wadala'
];

const NON_NAME_WORDS = [
  'who', 'what', 'why', 'how', 'when', 'which', 'where', 'thank', 'thanks', 'fresher',
  'salary', 'job', 'vacancy', 'hi', 'hii', 'hiii', 'hiiii', 'hie', 'hello', 'helloo', 'helo', 'hey', 'heyy',
  'call', 'aap', 'kaun', 'kon', 'kya', 'kyun', 'auto', 'reply', 'please', 'sir', 'madam', 'maam', 'candidate',
  'ok', 'okay', 'okk', 'okie', 'done', 'fine', 'thik', 'theek', 'haan', 'nahi', 'yes', 'no',
  'looking', 'interested', 'working', 'searching', 'applying', 'available', 'from',
  'staying', 'living', 'ready', 'open', 'want', 'need', 'trying', 'seeking',
  'graduate', 'undergraduate', 'hsc', 'experienced', 'voice', 'chat', 'blended',
  'backoffice', 'inbound', 'outbound', 'not', 'have', 'years', 'months',
  'bhai', 'bhaii', 'bro', 'brh', 'dude', 'yaar', 'yr', 'dost', 'ji', 'sahab', 'boss',
  'haha', 'lol', 'song', 'track', 'video', 'photo', 'music', 'anthem', 'protest',
  'good', 'morning', 'afternoon', 'evening', 'night', 'gm', 'gn', 'suno', 'sun',
  'lead', 'ask', 'name', 'friend', 'profile', 'resume', 'cv', 'biodata', 'sure',
  'namaste', 'namaskar', 'pranam', 'hola', 'client', 'whatsapp', 'user', 'unknown'
];

const GREETING_OR_PLACEHOLDER_REGEX = /^(?:hi+|hie|hello+|helo|hey+|hola|namaste|namaskar|pranam|good\s*(?:morning|afternoon|evening)|gm|gn|suno|sun|yo|oye|ask\s*name|candidate\b|lead\b|friend\b|unknown\b|client\b|whatsapp\b|user\b)/i;

export function isLikelyName(str) {
  if (!str) return false;
  const s = String(str).trim();
  if (s.length < 2 || s.length > 35) return false;
  if (/^\d+$/.test(s)) return false;
  const lower = s.toLowerCase();

  // Explicit greeting or system placeholder prefix check
  if (GREETING_OR_PLACEHOLDER_REGEX.test(lower)) return false;

  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  // Reject repeated single words like "ok ok", "bye bye", "hi hi"
  if (words.length > 1 && new Set(words).size === 1) return false;

  if (words.some(w => NON_NAME_WORDS.includes(w))) {
    return false;
  }
  return /^[a-zA-Z\s\.\'\-]+$/.test(s);
}

export function extractAllProfileFields(text) {
  if (!text) return {};
  const t = text.trim();
  const lower = t.toLowerCase();
  const extracted = {};

  // 1. Explicit name patterns or standalone clean names
  const namePattern = /(?:my\s*name\s*is|myself|this\s*is|it(?:'s|\s+is)\s*me|its\s*me|naam\s*hai|(?:^|\b)i\s*am|(?:^|\b)i['’]?m)\s+([A-Za-z\s'’]{2,30})/i;
  const nm = t.match(namePattern);
  if (nm) {
    // Only take words before punctuation or sentence continuation (i'm, from, here, etc.)
    const cleanSegment = nm[1].split(/[\.,!?;:\n\-]|(?:\b(?:i['’]?m|i\s*am|from|here|and|back|looking|searching|sir|bro|bhai)\b)/i)[0].trim();
    const candidateWords = cleanSegment.split(/\s+/).filter(w => w.length > 1 || (w.length === 1 && !/^[ia]$/i.test(w))).slice(0, 3);
    const candName = candidateWords.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    if (isLikelyName(candName) && candidateWords.length <= 3) {
      extracted.name = candName;
    }
  } else if (isLikelyName(t) && t.split(/\s+/).length <= 3 && !lower.includes('job') && !lower.includes('process')) {
    extracted.name = t.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  // 2. Location
  for (const loc of MUMBAI_LOCATIONS) {
    if (lower.includes(loc)) {
      if (loc === 'miraroad') extracted.location = 'Mira Road';
      else if (loc === 'bhayander') extracted.location = 'Bhayandar';
      else extracted.location = loc.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      break;
    }
  }

  // 3. Experience & Years — strictly Fresher or Experienced
  if (/(?:fresher|no\s*exp(?:erience)?|zero\s*exp(?:erience)?|0\s*years?|no\s*experience)/i.test(lower) || /^fresher$/i.test(t)) {
    extracted.experience = 'Fresher';
    extracted.years = '0';
  } else if (/\b(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\b/i.test(lower)) {
    const m = lower.match(/\b(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\b/i);
    extracted.experience = 'Experienced';
    extracted.years = m[1];
  } else if (/\b(\d+)\s*(?:months?|mths?)\b/i.test(lower)) {
    const m = lower.match(/\b(\d+)\s*(?:months?|mths?)\b/i);
    extracted.experience = 'Experienced';
    extracted.years = String(Math.round((parseInt(m[1], 10) / 12) * 10) / 10);
  } else if (/\b(?:have\s*exp|prior\s*exp|total\s*exp|work\s*exp|experienced)\b/i.test(lower) || /^experienced$/i.test(t)) {
    extracted.experience = 'Experienced';
  }

  // 4. Process — strictly requires explicit hiring process / job context or isolated answer
  if (/\b(?:voice\s*(?:process|role|job|profile|opening|pref(?:erence)?)|telecalling|telecaller\s*(?:role|job|profile)|inbound\s*(?:process|voice)|outbound\s*(?:process|voice)|international\s*voice|domestic\s*voice|customer\s*(?:support|service)\s*(?:process|role|job))\b/i.test(lower) || /^(?:voice|calling|telecaller)$/i.test(t)) {
    extracted.process = 'Voice';
  } else if (/\b(?:chat\s*(?:process|role|job|profile|opening)|non[\s-]*voice(?:\s*(?:process|role|job|profile))?|back\s*office(?:\s*(?:process|role|job|profile))?|blended(?:\s*(?:process|role|job|profile))?|email\s*support)\b/i.test(lower) || /^(?:chat|non-voice|non\s*voice|backoffice|back\s*office|blended)$/i.test(t)) {
    extracted.process = 'Chat / Non-Voice';
  }

  // 5. Salary
  const salPattern = /(?:salary|inhand|in-hand|ctc|drawn|package)?\s*(?:₹|rs\.?|inr)?\s*(\d{1,2}(?:\.\d+)?\s*k|\d{4,6})\b/i;
  const salMatch = lower.match(salPattern);
  if (salMatch && !salMatch[0].includes('year') && !salMatch[0].includes('month')) {
    const rawVal = salMatch[1].replace(/\s+/g, '');
    if (rawVal.endsWith('k')) {
      const num = parseFloat(rawVal.replace('k', ''));
      if (!isNaN(num) && num >= 10 && num <= 200) {
        extracted.salary = String(Math.round(num * 1000));
        extracted.inhand_salary = extracted.salary;
      }
    } else {
      const num = parseInt(rawVal, 10);
      if (!isNaN(num) && num >= 8000 && num <= 250000) {
        extracted.salary = String(num);
        extracted.inhand_salary = extracted.salary;
      }
    }
  }

  // 6. Qualification — strictly maps to predefined options: Graduate, Undergraduate, HSC, Post Graduate, Diploma
  if (/\b(post\s*graduate|postgraduate|pg|mba|mcom|m\.com|msc|m\.sc|mca|m\.e\.?|mtech|m\.tech)\b/i.test(lower) || /^(?:pg|post\s*graduate)$/i.test(t)) {
    extracted.qualification = 'Post Graduate';
  } else if (/\b(graduate|degree|bcom|b\.com|bba|bms|ba|bsc|b\.sc|b\.e\.?|btech|b\.tech|bachelor)\b/i.test(lower) || /^(?:graduate|degree)$/i.test(t)) {
    extracted.qualification = 'Graduate';
  } else if (/\b(undergraduate|undergrad|under\s*graduate|pursuing\s*grad(?:uation)?)\b/i.test(lower) || /^(?:undergraduate|undergrad)$/i.test(t)) {
    extracted.qualification = 'Undergraduate';
  } else if (/\b(hsc|12th|twelfth|10\+2|intermediate)\b/i.test(lower) || /^(?:hsc|12th)$/i.test(t)) {
    extracted.qualification = 'HSC';
  } else if (/\b(diploma|polytechnic)\b/i.test(lower) || /^diploma$/i.test(t)) {
    extracted.qualification = 'Diploma';
  }

  // 7. Communication Level — strictly requires english / communication context or isolated answer
  if (/\b(?:excellent\s*(?:english|comm(?:unication)?)|fluent\s*(?:english|comm(?:unication)?)|c1|c2)\b/i.test(lower) || /^(?:excellent|fluent)$/i.test(t)) {
    extracted.comm_level = 'Excellent';
  } else if (/\b(?:good\s*(?:english|comm(?:unication)?)|decent\s*(?:english|comm(?:unication)?)|b2)\b/i.test(lower) || /^(?:good|decent)$/i.test(t)) {
    extracted.comm_level = 'Good';
  } else if (/\b(?:average\s*(?:english|comm(?:unication)?)|basic\s*(?:english|comm(?:unication)?)|b1)\b/i.test(lower) || /^(?:average|basic)$/i.test(t)) {
    extracted.comm_level = 'Average';
  }

  // 8. Currently Working
  if (/\b(currently\s*working|working\s*now|employed\s*in|job\s*kar\s*raha)\b/i.test(lower)) {
    extracted.currently_working = 'Yes';
  } else if (/\b(not\s*working|unemployed|resigned|left\s*job)\b/i.test(lower)) {
    extracted.currently_working = 'No';
  }

  // 9. Prior / Last Company
  const COMPANIES = [
    'wipro', 'teleperformance', 'concentrix', 'eclerx', 'accenture', 'tcs',
    'tech mahindra', 'infosys', 'hgs', 'cogent', 'firstsource', 'genpact',
    'sutherland', 'conduent', 'foundever', 'sykes', 'iexceed', 'capita',
    'carelon', 'allstate', 'startek', 'transcom', 'taskus', 'intouchcx'
  ];
  for (const comp of COMPANIES) {
    if (lower.includes(comp)) {
      extracted.last_company = comp.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      break;
    }
  }

  // 10. Notice Period
  const noticeMatch = lower.match(/(?:notice\s*period|serving\s*notice|notice)?\s*(\b\d+\s*(?:days?|months?)\b|\bimmediate(?:\s*joiner)?\b)/i);
  if (noticeMatch) {
    extracted.notice_period = noticeMatch[1].trim();
  }

  // 11. Shift Preference & Family Curfew
  if (/\b(?:pure\s*day\s*shift|day\s*shift\s*only|strictly\s*(?:day|mana)|day\s*time|subah\s*ki|morning\s*shift)\b/i.test(lower) ||
      /\b(?:family\s*won'?t\s*allow|strictly\s*mana\s*hai|night\s*shift\s*(?:nhi|nahi|mana|not\s*allowed))\b/i.test(lower)) {
    extracted.shift_preference = 'Day';
    extracted.night_shift_allowed = false;
  } else if (/\b(?:night\s*shift\s*(?:ready|chalega|ok|open|preference)|rotational|24\/7|us\s*shift|uk\s*shift)\b/i.test(lower)) {
    extracted.shift_preference = 'Night';
    extracted.night_shift_allowed = true;
  }

  // 12. Cooling Period Detection (e.g. Teleperformance 3 months cooling)
  if (/\b(?:cooling\s*period|cooling\s*chal\s*raha|cooling\s*hai)\b/i.test(lower)) {
    extracted.cooling_period = true;
  }

  return extracted;
}

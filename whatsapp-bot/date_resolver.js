/**
 * date_resolver.js — Intelligent Date & Reschedule Parser for RecrutOS
 * =====================================================================
 * Converts natural Hinglish & English candidate messages into exact
 * ISO YYYY-MM-DD dates in Indian Standard Time (IST).
 * 
 * Handles:
 *  - "Wednesday", "wed", "Thursday", "kal", "parso", "day after", "tomorrow"
 *  - "7th", "7th oct", "7 october", "07/10", "7-10"
 *  - Relative day offsets and weekday calculations based on current IST time.
 */

const MONTH_NAMES = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12
};

const WEEKDAY_NAMES = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1, somwar: 1,
  tuesday: 2, tue: 2, mangalwar: 2,
  wednesday: 3, wed: 3, budhwar: 3,
  thursday: 4, thu: 4, thurs: 4, guruwar: 4,
  friday: 5, fri: 5, shukrawar: 5,
  saturday: 6, sat: 6, shaniwar: 6
};

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Gets current IST Date object
 */
export function getNowIST(referenceDate = null) {
  const d = referenceDate ? new Date(referenceDate) : new Date();
  // Adjust to IST (+5:30)
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  return new Date(utc + (3600000 * 5.5));
}

/**
 * Formats a Date object to YYYY-MM-DD
 */
export function formatDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Parses natural text for recruitment lineup / interview dates.
 * Returns { dateStr: 'YYYY-MM-DD', dayName: 'Wednesday', rawMatch: string } or null.
 */
export function parseLineupDate(text, referenceDate = null) {
  if (!text) return null;
  const raw = String(text).toLowerCase();

  const nowIST = getNowIST(referenceDate);
  const currentYear = nowIST.getFullYear();
  const currentMonth = nowIST.getMonth(); // 0-indexed
  const currentWeekday = nowIST.getDay(); // 0 = Sun, 1 = Mon ...

  // 1. "Day after tomorrow" / "parso" / "day after"
  if (/\b(?:day\s*after\s*tomorrow|day\s*after|parso|tarso)\b/i.test(raw)) {
    const target = new Date(nowIST);
    target.setDate(target.getDate() + 2);
    return {
      dateStr: formatDateISO(target),
      dayName: DAY_LABELS[target.getDay()],
      rawMatch: 'day after'
    };
  }

  // 2. "Tomorrow" / "kal" / "next day"
  if (/\b(?:tomorrow|kal|next\s*day|nextday)\b/i.test(raw)) {
    // Distinguish "kal" from "aaj kal" or past tense if needed
    if (!/\b(?:aaj\s*kal|kal\s*(?:kiya\s*tha|gaya\s*tha|bola\s*tha))\b/i.test(raw)) {
      const target = new Date(nowIST);
      target.setDate(target.getDate() + 1);
      return {
        dateStr: formatDateISO(target),
        dayName: DAY_LABELS[target.getDay()],
        rawMatch: 'tomorrow'
      };
    }
  }

  // 3. "Today" / "aaj"
  if (/\b(?:today|aaj)\b/i.test(raw)) {
    return {
      dateStr: formatDateISO(nowIST),
      dayName: DAY_LABELS[nowIST.getDay()],
      rawMatch: 'today'
    };
  }

  // 4. Specific Weekday (e.g. "Wednesday", "wed", "Thursday", "Friday", "Monday")
  // Only trigger if accompanied by context or explicitly stated
  for (const [dayKey, dayIndex] of Object.entries(WEEKDAY_NAMES)) {
    const rx = new RegExp(`\\b${dayKey}\\b`, 'i');
    if (rx.test(raw)) {
      // Calculate how many days ahead this weekday is
      let diff = dayIndex - currentWeekday;
      if (diff <= 0) {
        // If it's today and past 2 PM, or in the past, move to next week
        if (diff === 0 && nowIST.getHours() < 14) {
          diff = 0; // Today
        } else {
          diff += 7; // Next week's occurrence
        }
      }
      const target = new Date(nowIST);
      target.setDate(target.getDate() + diff);
      return {
        dateStr: formatDateISO(target),
        dayName: DAY_LABELS[target.getDay()],
        rawMatch: dayKey
      };
    }
  }

  // 5. Explicit Day + Month (e.g. "7th oct", "7 october", "7th of oct", "7th")
  const dateMonthRx = /\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s*)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
  const dmMatch = raw.match(dateMonthRx);
  if (dmMatch) {
    const day = parseInt(dmMatch[1], 10);
    const mStr = dmMatch[2].toLowerCase();
    const month = MONTH_NAMES[mStr] ? MONTH_NAMES[mStr] - 1 : currentMonth;
    const target = new Date(currentYear, month, day);
    // If target date is in the past by > 30 days, assume next year
    if (target.getTime() < nowIST.getTime() - 30 * 86400000) {
      target.setFullYear(currentYear + 1);
    }
    return {
      dateStr: formatDateISO(target),
      dayName: DAY_LABELS[target.getDay()],
      rawMatch: dmMatch[0]
    };
  }

  // 6. Format DD/MM or DD-MM (e.g. "07/10" or "07-10")
  const slashRx = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/;
  const sMatch = raw.match(slashRx);
  if (sMatch) {
    const day = parseInt(sMatch[1], 10);
    const month = parseInt(sMatch[2], 10) - 1;
    let year = sMatch[3] ? parseInt(sMatch[3], 10) : currentYear;
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 0 && month <= 11) {
      const target = new Date(year, month, day);
      return {
        dateStr: formatDateISO(target),
        dayName: DAY_LABELS[target.getDay()],
        rawMatch: sMatch[0]
      };
    }
  }

  // 7. Standalone ordinal (e.g. "7th ko", "7th chalega", "attend on 7th")
  const ordinalRx = /\b(\d{1,2})(?:st|nd|rd|th)\b(?:\s*(?:ko|par|chalega|perfect|done|attend))?/i;
  const ordMatch = raw.match(ordinalRx);
  if (ordMatch && !raw.includes('floor') && !raw.includes('pass') && !raw.includes('standard')) {
    const day = parseInt(ordMatch[1], 10);
    if (day >= 1 && day <= 31) {
      const target = new Date(currentYear, currentMonth, day);
      // If target day has already passed this month, move to next month
      if (target.getDate() < nowIST.getDate() - 1) {
        target.setMonth(target.getMonth() + 1);
      }
      return {
        dateStr: formatDateISO(target),
        dayName: DAY_LABELS[target.getDay()],
        rawMatch: ordMatch[0]
      };
    }
  }

  return null;
}

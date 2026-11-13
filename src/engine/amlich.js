/*!
 * @license
 * Vietnamese lunisolar calendar engine (amlich.js).
 *
 * Core lunar calendar conversion adapted from amlich-hnd.js:
 * Copyright (c) 2006 Ho Ngoc Duc. All Rights Reserved.
 * Astronomical algorithms from the book "Astronomical Algorithms" by Jean Meeus, 1998
 *
 * Permission to use, copy, modify, and redistribute this software and its
 * documentation for personal, non-commercial use is hereby granted provided that
 * this copyright notice and appropriate documentation appears in all copies.
 *
 * View-model builders and ES module adaptations:
 * Copyright (C) 2026 Tien Nguyen
 * SPDX-License-Identifier: AGPL-3.0-only AND LicenseRef-HoNgocDuc-NonCommercial
 * Licensed under GNU AGPL-3.0-only with the Section 7 amlich linking exception;
 * see /LICENSE and /NOTICE for full terms.
 */

export const LIMITS = Object.freeze({ minYear: 1900, maxYear: 2100 });

const DEFAULT_TIMEZONE = 7.0;
const EPOCH_1900_JAN_0 = 2415021.076998695;
const SYNODIC_MONTH = 29.530588853;
const GREGORIAN_CUTOFF_JD = 2299161;
const UNIX_EPOCH_JD = 2440588;
const MS_PER_DAY = 86400000;

const CAN = ['Giáp', 'Ất', 'Bính', 'Đinh', 'Mậu', 'Kỷ', 'Canh', 'Tân', 'Nhâm', 'Quý'];
const CHI = ['Tý', 'Sửu', 'Dần', 'Mão', 'Thìn', 'Tỵ', 'Ngọ', 'Mùi', 'Thân', 'Dậu', 'Tuất', 'Hợi'];
const ZODIAC = ['Chuột', 'Trâu', 'Hổ', 'Mèo', 'Rồng', 'Rắn', 'Ngựa', 'Dê', 'Khỉ', 'Gà', 'Chó', 'Lợn'];

const LUNAR_MONTHS = [
  'Tháng Giêng', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
  'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng Một', 'Tháng Chạp',
];

const SOLAR_TERMS = [
  'Xuân phân', 'Thanh minh', 'Cốc vũ', 'Lập hạ', 'Tiểu mãn', 'Mang chủng',
  'Hạ chí', 'Tiểu thử', 'Đại thử', 'Lập thu', 'Xử thử', 'Bạch lộ',
  'Thu phân', 'Hàn lộ', 'Sương giáng', 'Lập đông', 'Tiểu tuyết', 'Đại tuyết',
  'Đông chí', 'Tiểu hàn', 'Đại hàn', 'Lập xuân', 'Vũ thủy', 'Kinh trập',
];

const HOLIDAYS = new Map([
  ['1/1', 'Tết Nguyên Đán'],
  ['2/1', 'Mùng 2 Tết'],
  ['3/1', 'Mùng 3 Tết'],
  ['15/1', 'Rằm tháng Giêng'],
  ['3/3', 'Tết Hàn Thực'],
  ['10/3', 'Giỗ Tổ Hùng Vương'],
  ['15/4', 'Lễ Phật Đản'],
  ['5/5', 'Tết Đoan Ngọ'],
  ['15/7', 'Lễ Vu Lan'],
  ['15/8', 'Tết Trung Thu'],
  ['9/9', 'Tết Trùng Cửu'],
  ['23/12', 'Tết Ông Công Ông Táo'],
]);

const HOLIDAYS_SHORT = new Map([
  ['1/1', 'Tết'],
  ['2/1', 'Tết'],
  ['3/1', 'Tết'],
  ['15/1', 'Rằm'],
  ['10/3', 'Giỗ Tổ'],
  ['15/4', 'Phật Đản'],
  ['5/5', 'Đoan Ngọ'],
  ['15/7', 'Vu Lan'],
  ['15/8', 'Trung Thu'],
]);

const WEEKDAYS_VI_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const WEEKDAYS_VI_LONG = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const WEEKDAYS_EN_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_EN_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MONTHS_EN_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_EN_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const mod = (n, m) => ((n % m) + m) % m;

/* ------------------------------------------------------------------ astronomical core */

export function jdFromDate(day, month, year) {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  let jd =
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045;
  if (jd < GREGORIAN_CUTOFF_JD) {
    jd = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32083;
  }
  return jd;
}

export function jdToDate(jd) {
  let b;
  let c;
  if (jd > GREGORIAN_CUTOFF_JD - 1) {
    const a = jd + 32044;
    b = Math.floor((4 * a + 3) / 146097);
    c = a - Math.floor((b * 146097) / 4);
  } else {
    b = 0;
    c = jd + 32082;
  }
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = b * 100 + d - 4800 + Math.floor(m / 10);
  return { day, month, year };
}

function weekdayOf(day, month, year) {
  return (jdFromDate(day, month, year) + 1) % 7;
}

function newMoon(k) {
  const t = k / 1236.85;
  const t2 = t * t;
  const t3 = t2 * t;
  const dr = Math.PI / 180;
  let jd1 = 2415020.75933 + 29.53058868 * k + 0.0001178 * t2 - 0.000000155 * t3;
  jd1 += 0.00033 * Math.sin((166.56 + 132.87 * t - 0.009173 * t2) * dr);
  const m = 359.2242 + 29.10535608 * k - 0.0000333 * t2 - 0.00000347 * t3;
  const mpr = 306.0253 + 385.81691806 * k + 0.0107306 * t2 + 0.00001236 * t3;
  const f = 21.2964 + 390.67050646 * k - 0.0016528 * t2 - 0.00000239 * t3;
  let c1 = (0.1734 - 0.000393 * t) * Math.sin(m * dr) + 0.0021 * Math.sin(2 * dr * m);
  c1 = c1 + (-0.4068 * Math.sin(mpr * dr) + 0.0161 * Math.sin(dr * 2 * mpr));
  c1 = c1 + -0.0004 * Math.sin(dr * 3 * mpr);
  c1 = c1 + (0.0104 * Math.sin(dr * 2 * f) - 0.0051 * Math.sin(dr * (m + mpr)));
  c1 = c1 + (-0.0074 * Math.sin(dr * (m - mpr)) + 0.0004 * Math.sin(dr * (2 * f + m)));
  c1 = c1 + (-0.0004 * Math.sin(dr * (2 * f - m)) - 0.0006 * Math.sin(dr * (2 * f + mpr)));
  c1 = c1 + (0.001 * Math.sin(dr * (2 * f - mpr)) + 0.0005 * Math.sin(dr * (2 * mpr + m)));
  const deltat = t < -11
    ? 0.001 + 0.000839 * t + 0.0002261 * t2 - 0.00000845 * t3 - 0.000000081 * t * t3
    : -0.000278 + 0.000265 * t + 0.000262 * t2;
  return jd1 + c1 - deltat;
}

function sunLongitude(jdn) {
  const t = (jdn - 2451545.0) / 36525;
  const t2 = t * t;
  const dr = Math.PI / 180;
  const m = 357.5291 + 35999.0503 * t - 0.0001559 * t2 - 0.00000048 * t * t2;
  const l0 = 280.46645 + 36000.76983 * t + 0.0003032 * t2;
  let dl = (1.9146 - 0.004817 * t - 0.000014 * t2) * Math.sin(dr * m);
  dl = dl + ((0.019993 - 0.000101 * t) * Math.sin(dr * 2 * m) + 0.00029 * Math.sin(dr * 3 * m));
  let l = (l0 + dl) * dr;
  l = l - Math.PI * 2 * Math.floor(l / (Math.PI * 2));
  return l;
}

function getSunLongitude(dayNumber, timeZone) {
  return Math.floor((sunLongitude(dayNumber - 0.5 - timeZone / 24) / Math.PI) * 6);
}

function getNewMoonDay(k, timeZone) {
  return Math.floor(newMoon(k) + 0.5 + timeZone / 24);
}

function getLunarMonth11(year, timeZone) {
  const off = jdFromDate(31, 12, year) - 2415021;
  const k = Math.floor(off / SYNODIC_MONTH);
  let nm = getNewMoonDay(k, timeZone);
  if (getSunLongitude(nm, timeZone) >= 9) {
    nm = getNewMoonDay(k - 1, timeZone);
  }
  return nm;
}

function getLeapMonthOffset(a11, timeZone) {
  const k = Math.floor((a11 - EPOCH_1900_JAN_0) / SYNODIC_MONTH + 0.5);
  let last = 0;
  let i = 1;
  let arc = getSunLongitude(getNewMoonDay(k + i, timeZone), timeZone);
  do {
    last = arc;
    i += 1;
    arc = getSunLongitude(getNewMoonDay(k + i, timeZone), timeZone);
  } while (arc !== last && i < 14);
  return i - 1;
}

export function convertSolar2Lunar(day, month, year, timeZone = DEFAULT_TIMEZONE) {
  const dayNumber = jdFromDate(day, month, year);
  const k = Math.floor((dayNumber - EPOCH_1900_JAN_0) / SYNODIC_MONTH);
  let nmIndex = k + 1;
  let monthStart = getNewMoonDay(nmIndex, timeZone);
  while (monthStart > dayNumber) {
    nmIndex -= 1;
    monthStart = getNewMoonDay(nmIndex, timeZone);
  }
  let a11 = getLunarMonth11(year, timeZone);
  let b11 = a11;
  let lunarYear;
  if (a11 >= monthStart) {
    lunarYear = year;
    a11 = getLunarMonth11(year - 1, timeZone);
  } else {
    lunarYear = year + 1;
    b11 = getLunarMonth11(year + 1, timeZone);
  }
  const lunarDay = dayNumber - monthStart + 1;
  const diff = Math.floor((monthStart - a11) / 29.0);
  let lunarLeap = false;
  let lunarMonth = diff + 11;
  if (b11 - a11 > 365) {
    const leapMonthDiff = getLeapMonthOffset(a11, timeZone);
    if (diff >= leapMonthDiff) {
      lunarMonth = diff + 10;
      if (diff === leapMonthDiff) lunarLeap = true;
    }
  }
  if (lunarMonth > 12) lunarMonth -= 12;
  let adjustedYear = lunarYear;
  if (lunarMonth >= 11 && diff < 4) adjustedYear -= 1;
  return { day: lunarDay, month: lunarMonth, year: adjustedYear, leap: lunarLeap };
}

/* ------------------------------------------------------------------ formatting & helpers */

function canChiYearOf(lunarYear) {
  return `${CAN[mod(lunarYear + 6, 10)]} ${CHI[mod(lunarYear + 8, 12)]}`;
}

function canChiDayOf(day, month, year) {
  const jd = jdFromDate(day, month, year);
  return `${CAN[(jd + 9) % 10]} ${CHI[(jd + 1) % 12]}`;
}

function zodiacOf(lunarYear) {
  return ZODIAC[mod(lunarYear + 8, 12)];
}

function lunarMonthNameOf(lunarMonth, leap) {
  const name = LUNAR_MONTHS[mod(lunarMonth - 1, 12)];
  return leap ? `Tháng Nhuận ${name}` : name;
}

function lunarDayTextOf(lunarDay) {
  return lunarDay <= 10 ? `Mùng ${lunarDay}` : `Ngày ${lunarDay}`;
}

function solarTermOf(day, month, year, timeZone) {
  const mid = jdFromDate(day, month, year) - 0.5 - timeZone / 24;
  const cur = Math.floor((sunLongitude(mid) * 24) / (Math.PI * 2)) % 24;
  const nxt = Math.floor((sunLongitude(mid + 1) * 24) / (Math.PI * 2)) % 24;
  return cur !== nxt ? SOLAR_TERMS[nxt] : '';
}

function holidayOf(lunarDay, lunarMonth, lunarLeap = false) {
  if (lunarLeap) return '';
  return HOLIDAYS.get(`${lunarDay}/${lunarMonth}`) ?? '';
}

function holidayShortOf(lunarDay, lunarMonth, lunarLeap = false) {
  if (lunarLeap) return '';
  return HOLIDAYS_SHORT.get(`${lunarDay}/${lunarMonth}`) ?? '';
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInGregorianMonth(year, month) {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12: return 31;
    case 4: case 6: case 9: case 11: return 30;
    default: return isLeapYear(year) ? 29 : 28;
  }
}

function isEnglish(language) {
  const norm = String(language ?? '').toLowerCase();
  return norm === 'en' || norm === 'english';
}

function gregorianMonthName(month, english, short = false) {
  const idx = mod(month - 1, 12);
  if (english) return short ? MONTHS_EN_SHORT[idx] : MONTHS_EN_LONG[idx];
  return short ? `Thg ${idx + 1}` : `Tháng ${idx + 1}`;
}

function weekdayName(index, english, long = false) {
  const idx = mod(index, 7);
  if (english) return long ? WEEKDAYS_EN_LONG[idx] : WEEKDAYS_EN_SHORT[idx];
  return long ? WEEKDAYS_VI_LONG[idx] : WEEKDAYS_VI_SHORT[idx];
}

function fullLunarDateText(lunar) {
  const canChi = canChiYearOf(lunar.year);
  const zodiac = zodiacOf(lunar.year);
  const dayText = lunarDayTextOf(lunar.day);
  if (lunar.month === 1 && lunar.day <= 10) {
    return `${dayText} Tết, năm ${canChi} (${zodiac})`;
  }
  const monthName = lunarMonthNameOf(lunar.month, lunar.leap);
  const loweredMonth = monthName.length > 0 ? monthName[0].toLowerCase() + monthName.slice(1) : monthName;
  return `${dayText} ${loweredMonth} năm ${canChi} (${zodiac})`;
}

function isoOf({ day, month, year }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseIso(iso) {
  if (typeof iso !== 'string') return null;
  const parts = iso.split('-');
  if (parts.length !== 3) return null;
  if (!/^-?\d+$/.test(parts[0]) || !/^-?\d+$/.test(parts[1]) || !/^-?\d+$/.test(parts[2])) return null;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (month < 1 || month > 12 || day < 1 || day > daysInGregorianMonth(year, month)) return null;
  return { day, month, year };
}

function civilDayFromEpoch(epochMillis, utcOffsetHours) {
  const shifted = Math.trunc(epochMillis) + Math.trunc(utcOffsetHours * 3600000.0);
  const daysSinceEpoch = Math.floor(shifted / MS_PER_DAY);
  return jdToDate(UNIX_EPOCH_JD + daysSinceEpoch);
}

function lunarInfoFor(day, month, year, timeZone) {
  const lunar = convertSolar2Lunar(day, month, year, timeZone);
  return {
    solar: { day, month, year },
    lunar,
    lunarDayText: lunarDayTextOf(lunar.day),
    lunarDayNumber: String(lunar.day),
    monthName: lunarMonthNameOf(lunar.month, lunar.leap),
    canChiYear: canChiYearOf(lunar.year),
    canChiDay: canChiDayOf(day, month, year),
    zodiac: zodiacOf(lunar.year),
    solarTerm: solarTermOf(day, month, year, timeZone),
    holiday: holidayOf(lunar.day, lunar.month, lunar.leap),
    holidayShort: holidayShortOf(lunar.day, lunar.month, lunar.leap),
    weekdayIndex: weekdayOf(day, month, year),
  };
}

function nextHolidayFrom(solar, timeZone) {
  const startJd = jdFromDate(solar.day, solar.month, solar.year);
  for (let offset = 1; offset <= 400; offset += 1) {
    const date = jdToDate(startJd + offset);
    const lunar = convertSolar2Lunar(date.day, date.month, date.year, timeZone);
    const holiday = holidayOf(lunar.day, lunar.month, lunar.leap);
    if (holiday.length > 0) {
      return { name: holiday, daysUntil: offset, iso: isoOf(date) };
    }
  }
  return null;
}

function cellEmphasis(holiday, solarTerm, isFirstOfMonth, isCurrentMonth) {
  if (holiday.length > 0) return 'holiday';
  if (solarTerm.length > 0) return 'solarTerm';
  if (isFirstOfMonth) return 'monthStart';
  if (!isCurrentMonth) return 'outsideMonth';
  return 'ordinary';
}

/* ------------------------------------------------------------------ public API */

export function limits() {
  return { minYear: LIMITS.minYear, maxYear: LIMITS.maxYear };
}

export function today(epochMillis, utcOffsetHours) {
  const date = civilDayFromEpoch(epochMillis, utcOffsetHours);
  return {
    iso: isoOf(date),
    weekdayIndex: weekdayOf(date.day, date.month, date.year),
  };
}

export function monthTitle(year, month, language) {
  const eng = isEnglish(language);
  const gregorian = `${gregorianMonthName(month, eng, false)} ${year}`;
  const info = lunarInfoFor(1, month, year, DEFAULT_TIMEZONE);
  return {
    gregorian,
    canChi: `Năm ${info.canChiYear} (${info.zodiac})`,
  };
}

export function weekdays(language, weekStart, long = false) {
  const eng = isEnglish(language);
  const ws = weekStart === 0 ? 0 : 1;
  const names = [];
  for (let i = 0; i < 7; i += 1) {
    names.push(weekdayName((ws + i) % 7, eng, long));
  }
  return names;
}

export function monthGrid(year, month, weekStart, epochMillis, utcOffsetHours) {
  const ws = weekStart === 0 ? 0 : 1;
  const todayDate = civilDayFromEpoch(epochMillis, utcOffsetHours);
  const daysInMonth = daysInGregorianMonth(year, month);
  const firstWeekday = weekdayOf(1, month, year);
  const leading = ((firstWeekday - ws) + 7) % 7;
  const rowCount = Math.trunc((leading + daysInMonth + 6) / 7);
  const cellCount = rowCount * 7;
  const startJd = jdFromDate(1, month, year) - leading;

  const cells = [];
  let previousLunarMonth = -1;
  let previousCurrentLunarMonth = -1;
  let groupCounter = 0;
  let currentGroup = -1;

  for (let index = 0; index < cellCount; index += 1) {
    const solar = jdToDate(startJd + index);
    const info = lunarInfoFor(solar.day, solar.month, solar.year, utcOffsetHours);
    const isCurrentMonth = solar.month === month && solar.year === year;

    if (isCurrentMonth && info.lunar.month !== previousCurrentLunarMonth) {
      currentGroup = groupCounter;
      groupCounter += 1;
    }

    let showMonthLabel = info.lunar.day === 1 || index === 0 || info.lunar.month !== previousLunarMonth;
    if (isCurrentMonth && info.lunar.month !== previousCurrentLunarMonth) {
      showMonthLabel = true;
    }

    const isFirstOfMonth = info.lunar.day === 1;
    const isToday =
      solar.day === todayDate.day &&
      solar.month === todayDate.month &&
      solar.year === todayDate.year;

    cells.push({
      iso: isoOf(solar),
      day: solar.day,
      month: solar.month,
      year: solar.year,
      lunarDay: info.lunar.day,
      lunarMonth: info.lunar.month,
      lunarLeap: info.lunar.leap,
      monthName: info.monthName,
      lunarDayNumber: info.lunarDayNumber,
      lunarDayText: info.lunarDayText,
      canChiDay: info.canChiDay,
      solarTerm: info.solarTerm,
      holiday: info.holiday,
      holidayShort: info.holidayShort,
      weekdayIndex: info.weekdayIndex,
      emphasis: cellEmphasis(info.holiday, info.solarTerm, isFirstOfMonth, isCurrentMonth),
      isCurrentMonth,
      isToday,
      isFirstOfMonth,
      showMonthLabel,
      lunarMonthGroup: isCurrentMonth ? currentGroup : -1,
    });

    previousLunarMonth = info.lunar.month;
    if (isCurrentMonth) {
      previousCurrentLunarMonth = info.lunar.month;
    }
  }

  const seen = new Set();
  const legend = [];
  for (const cell of cells) {
    if (!cell.isCurrentMonth) continue;
    if (cell.holiday.length > 0 && !seen.has(`H${cell.holiday}`)) {
      seen.add(`H${cell.holiday}`);
      legend.push({ kind: 'holiday', name: cell.holiday, iso: cell.iso });
    }
    if (cell.solarTerm.length > 0 && !seen.has(`S${cell.solarTerm}`)) {
      seen.add(`S${cell.solarTerm}`);
      legend.push({ kind: 'solarTerm', name: cell.solarTerm, iso: cell.iso });
    }
  }

  return {
    year,
    month,
    weekStart: ws,
    rowCount,
    todayIso: isoOf(todayDate),
    cells,
    legend,
  };
}

export function day(iso, utcOffsetHours, language) {
  const date = parseIso(iso);
  if (!date) return { error: 'bad-date' };

  const info = lunarInfoFor(date.day, date.month, date.year, utcOffsetHours);
  const eng = isEnglish(language);

  return {
    iso: isoOf(date),
    weekday: weekdayName(info.weekdayIndex, eng, true),
    gregorianMonth: gregorianMonthName(date.month, eng, false),
    lunarDayText: info.lunarDayText,
    lunarDay: info.lunar.day,
    lunarMonth: info.lunar.month,
    lunarMonthName: info.monthName,
    lunarLeap: info.lunar.leap,
    canChiYear: `Năm ${info.canChiYear}`,
    canChiDay: info.canChiDay,
    zodiac: info.zodiac,
    solarTerm: info.solarTerm,
    holiday: info.holiday,
    fullDate: fullLunarDateText(info.lunar),
    lunarYear: info.lunar.year,
    nextHoliday: nextHolidayFrom(date, utcOffsetHours),
  };
}

/**
 * Compatibility adapter returning JSON strings, matching the Kotlin `WebApi` contract
 * exercised by `tools/compare-engine.mjs`.
 */
export const WebApi = Object.freeze({
  limits: () => JSON.stringify(limits()),
  today: (epochMillis, utcOffsetHours) => JSON.stringify(today(epochMillis, utcOffsetHours)),
  monthTitle: (year, month, language) => JSON.stringify(monthTitle(year, month, language)),
  weekdays: (language, weekStart, long) => JSON.stringify(weekdays(language, weekStart, long)),
  monthGrid: (year, month, weekStart, epochMillis, utcOffsetHours) =>
    JSON.stringify(monthGrid(year, month, weekStart, epochMillis, utcOffsetHours)),
  day: (iso, utcOffsetHours, language) => JSON.stringify(day(iso, utcOffsetHours, language)),
});

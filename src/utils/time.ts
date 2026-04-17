const partsToNumber = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number => {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) {
    throw new Error(`Failed to parse date part: ${type}`);
  }
  return Number(value);
};

export const getZonedParts = (date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} => {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);

  return {
    year: partsToNumber(parts, "year"),
    month: partsToNumber(parts, "month"),
    day: partsToNumber(parts, "day"),
    hour: partsToNumber(parts, "hour"),
    minute: partsToNumber(parts, "minute"),
    second: partsToNumber(parts, "second")
  };
};

export const formatIsoMinuteUtc = (date: Date): string => {
  const truncated = new Date(date);
  truncated.setSeconds(0, 0);
  return truncated.toISOString();
};

export const isWithinWorkHours = (date: Date, timeZone: string, startHour: number, endHour: number): boolean => {
  const { hour } = getZonedParts(date, timeZone);
  return hour >= startHour && hour < endHour;
};

export const getCurrentSlotKey = (date: Date, timeZone: string, pollMinutes: number): string => {
  const parts = getZonedParts(date, timeZone);
  const slotMinute = Math.floor(parts.minute / pollMinutes) * pollMinutes;
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(slotMinute).padStart(2, "0")}`;
};

export const getLocalDateKey = (date: Date, timeZone: string): string => {
  const parts = getZonedParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
};

export const isSlotBoundary = (date: Date, timeZone: string, pollMinutes: number): boolean => {
  const parts = getZonedParts(date, timeZone);
  return parts.minute % pollMinutes === 0;
};

const getTimeZoneOffsetMs = (date: Date, timeZone: string): number => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset"
  });
  const zoneName = formatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  if (!zoneName || zoneName === "GMT") {
    return 0;
  }

  const match = zoneName.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) {
    throw new Error(`Unable to parse timezone offset: ${zoneName}`);
  }

  const [, sign, hoursRaw, minutesRaw] = match;
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw ?? "0");
  const totalMinutes = hours * 60 + minutes;
  return (sign === "+" ? 1 : -1) * totalMinutes * 60_000;
};

export const zonedDateTimeToUtc = (
  timeZone: string,
  parts: { year: number; month: number; day: number; hour: number; minute?: number; second?: number }
): Date => {
  const utcGuess = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute ?? 0,
      parts.second ?? 0,
      0
    )
  );
  const offsetMs = getTimeZoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offsetMs);
};

export const getPollingWindow = (date: Date, pollMinutes: number): { since: string; until: string } => {
  const until = new Date(date);
  until.setSeconds(0, 0);
  const since = new Date(until.getTime() - pollMinutes * 60_000);
  return {
    since: formatIsoMinuteUtc(since),
    until: formatIsoMinuteUtc(until)
  };
};

export const getMorningCatchupWindow = (
  date: Date,
  timeZone: string,
  sinceHour: number
): { since: string; until: string } => {
  const until = new Date(date);
  until.setSeconds(0, 0);
  const zoned = getZonedParts(until, timeZone);
  const since = zonedDateTimeToUtc(timeZone, {
    year: zoned.year,
    month: zoned.month,
    day: zoned.day,
    hour: sinceHour,
    minute: 0,
    second: 0
  });

  return {
    since: formatIsoMinuteUtc(since),
    until: formatIsoMinuteUtc(until)
  };
};

export const escapeTelegramMarkdown = (value: string): string => {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
};

/**
 * Date formatting utilities with timezone support
 */

import type { CollectionField } from '@/types';
import { isDateFieldType } from '@/lib/collection-field-utils';

/**
 * Format a UTC date in the specified timezone
 * Uses Intl.DateTimeFormat for timezone conversion
 */
export function formatDateInTimezone(
  date: string | Date | null | undefined,
  timezone: string = 'UTC',
  format: 'display' | 'datetime-local' | 'date' = 'display'
): string {
  if (!date) return '';

  const dateObj = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(dateObj.getTime())) return '';

  try {
    if (format === 'display') {
      // Format for display: "Nov 12 2025, 09:38"
      return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(dateObj);
    }

    if (format === 'datetime-local') {
      // Format for <input type="datetime-local">: "2025-11-12T09:38"
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(dateObj);

      const get = (type: string) => parts.find(p => p.type === type)?.value || '';
      return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
    }

    if (format === 'date') {
      // Format for <input type="date">: "2025-11-12"
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(dateObj);

      const get = (type: string) => parts.find(p => p.type === type)?.value || '';
      return `${get('year')}-${get('month')}-${get('day')}`;
    }
  } catch {
    // Fallback if timezone is invalid
    return '';
  }

  return '';
}

/**
 * Convert a local datetime string (in the given timezone) to UTC ISO string for storage
 */
export function localDatetimeToUTC(
  localDatetime: string,
  timezone: string = 'UTC'
): string {
  if (!localDatetime) return '';

  try {
    // Parse the local datetime string
    // Handle both "2025-11-12T09:38" and "2025-11-12" formats
    const hasTime = localDatetime.includes('T');
    const dateStr = hasTime ? localDatetime : `${localDatetime}T00:00`;

    // Create a formatter that can parse dates in the given timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    // Get the offset for this timezone at this specific date
    // We do this by formatting a known UTC date and comparing
    const [datePart, timePart] = dateStr.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute] = timePart.split(':').map(Number);

    // Create a date assuming UTC, then adjust
    const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

    // Get timezone offset by comparing formatted local time with UTC
    const localParts = formatter.formatToParts(utcDate);
    const get = (type: string) => Number(localParts.find(p => p.type === type)?.value || 0);

    const localYear = get('year');
    const localMonth = get('month');
    const localDay = get('day');
    const localHour = get('hour');
    const localMinute = get('minute');

    // Calculate offset in minutes
    const utcMinutes = utcDate.getUTCHours() * 60 + utcDate.getUTCMinutes();
    const localDate = new Date(Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, 0));
    const localMinutesOfDay = localDate.getUTCHours() * 60 + localDate.getUTCMinutes();

    let offsetMinutes = localMinutesOfDay - utcMinutes;

    // Handle day boundary crossing
    const dayDiff = localDate.getUTCDate() - utcDate.getUTCDate();
    if (dayDiff !== 0) {
      offsetMinutes += dayDiff * 24 * 60;
    }

    // Now create the actual date by subtracting the offset
    const targetDate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
    targetDate.setUTCMinutes(targetDate.getUTCMinutes() - offsetMinutes);

    return targetDate.toISOString();
  } catch {
    return '';
  }
}

/**
 * Format date field values in collection item data
 * Converts UTC ISO strings to formatted timezone-aware display strings.
 * date_only fields are formatted without time/timezone conversion.
 */
export function formatDateFieldsInItemValues(
  itemValues: Record<string, string>,
  collectionFields: CollectionField[],
  timezone: string = 'UTC'
): Record<string, string> {
  const dateFields = collectionFields.filter(f => isDateFieldType(f.type));

  if (dateFields.length === 0) {
    return itemValues;
  }

  const formattedValues = { ...itemValues };
  for (const field of dateFields) {
    const value = itemValues[field.id];
    if (value) {
      formattedValues[field.id] = field.type === 'date_only'
        ? formatDateOnly(value)
        : formatDateInTimezone(value, timezone, 'display');
    }
  }

  return formattedValues;
}

/** Clamp date input values to valid ranges (4-digit year, month 1-12, day 1-31) */
export function clampDateInputValue(value: string): string {
  if (!value) return value;
  const timeSuffix = value.includes('T') ? value.slice(value.indexOf('T')) : '';
  const datePart = value.includes('T') ? value.slice(0, value.indexOf('T')) : value;
  const parts = datePart.split('-');
  if (parts.length < 3) return value;

  let [yearStr] = parts;
  const [, monthStr, dayStr] = parts;

  if (yearStr.length > 4) {
    yearStr = `000${yearStr.slice(-1)}`.slice(-4);
  }

  const month = Math.min(Math.max(parseInt(monthStr, 10) || 1, 1), 12);
  const maxDay = new Date(parseInt(yearStr, 10) || 1, month, 0).getDate();
  const day = Math.min(Math.max(parseInt(dayStr, 10) || 1, 1), maxDay);

  const clamped = `${yearStr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return clamped + timeSuffix;
}

/** Format a date_only value for display (no time, no timezone) */
export function formatDateOnly(value: string): string {
  const dateStr = value.slice(0, 10);
  const [year, month, day] = dateStr.split('-').map(Number);
  if (!year || !month || !day) return value;
  const date = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

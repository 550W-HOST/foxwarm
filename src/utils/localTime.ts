function coerceDate(input: Date | number): Date {
  return input instanceof Date ? input : new Date(input);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatOffset(date: Date): string {
  const totalMinutes = -date.getTimezoneOffset();
  const sign = totalMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(totalMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${pad2(hours)}${pad2(minutes)}`;
}

export function formatLocalTimestamp(input: Date | number, options: { includeSeconds?: boolean } = {}): string {
  const date = coerceDate(input);
  const includeSeconds = options.includeSeconds !== false;
  const datePart = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const timePart = includeSeconds
    ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    : `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return `${datePart} ${timePart} ${formatOffset(date)}`;
}

export function formatLocalTimeRange(
  startInput?: Date | number | null,
  endInput?: Date | number | null,
  options: { includeSeconds?: boolean } = {},
): string | null {
  if (startInput === undefined || startInput === null) {
    return endInput === undefined || endInput === null ? null : formatLocalTimestamp(endInput, options);
  }
  if (endInput === undefined || endInput === null) {
    return formatLocalTimestamp(startInput, options);
  }

  const startText = formatLocalTimestamp(startInput, options);
  const endText = formatLocalTimestamp(endInput, options);
  if (startText === endText) {
    return startText;
  }
  return `${startText} -> ${endText}`;
}
const ONE_DAY = 86400;

export const getWeekNumber = (date: Date) => {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  return Math.ceil((((day.getTime() - yearStart.getTime()) / (ONE_DAY * 1000)) + 1) / 7);
};

export function getDateFormatOptions(time: Date, today = new Date()) {
  const now = today.getTime() / 1000 | 0;
  const timestamp = time.getTime() / 1000 | 0;
  const options: Intl.DateTimeFormatOptions = {};

  if((now - timestamp) < ONE_DAY && today.getDate() === time.getDate()) {
    options.hour = options.minute = '2-digit';
  } else if(today.getFullYear() !== time.getFullYear()) {
    options.year = options.day = 'numeric';
    options.month = '2-digit';
  } else if((now - timestamp) < (ONE_DAY * 7) && getWeekNumber(today) === getWeekNumber(time)) {
    options.weekday = 'short';
  } else {
    options.month = 'short';
    options.day = 'numeric';
  }

  return options;
}

// Vercel Node.js Function: returns only occupied date ranges, never the private Airbnb iCal URL.
// Set AIRBNB_ICAL_URL in Vercel project Environment Variables.
const MAX_BYTES = 1024 * 1024;

function parseDate(value) {
  const v = String(value || '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}
function parseCalendar(body) {
  if (!body.includes('BEGIN:VCALENDAR')) throw new Error('Invalid calendar response');
  const lines = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '').split('\n'); // RFC 5545 folded lines
  const periods = [];
  let event = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { event = {}; continue; }
    if (line === 'END:VEVENT') {
      if (event && event.start && event.end && event.start < event.end &&
          event.status !== 'CANCELLED' && event.transp !== 'TRANSPARENT') {
        periods.push({ start: event.start, end: event.end });
      }
      event = null;
      continue;
    }
    if (!event) continue;
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const key = line.slice(0, sep).split(';')[0].toUpperCase();
    const value = line.slice(sep + 1);
    if (key === 'DTSTART') event.start = parseDate(value);
    if (key === 'DTEND') event.end = parseDate(value); // exclusive (checkout day is selectable)
    if (key === 'STATUS') event.status = value.toUpperCase();
    if (key === 'TRANSP') event.transp = value.toUpperCase();
  }
  periods.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const merged = [];
  for (const period of periods) {
    const last = merged[merged.length - 1];
    if (last && period.start <= last.end) {
      if (period.end > last.end) last.end = period.end;
    } else merged.push({ ...period });
  }
  return merged;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const url = process.env.AIRBNB_ICAL_URL;
  if (!url) return res.status(503).json({ error: 'Calendar not configured' });
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !/^([a-z0-9-]+\.)*airbnb\.(com|be|fr|co\.uk|de|es|it)$/i.test(parsed.hostname) ||
        !/^\/calendar\/ical\/\d+\.ics$/.test(parsed.pathname)) {
      throw new Error('Invalid calendar configuration');
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(10000),
      headers: { 'Accept': 'text/calendar,text/plain;q=0.9' }, redirect: 'error' });
    if (!response.ok) throw new Error('Calendar source unavailable');
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_BYTES) throw new Error('Calendar too large');
    const body = await response.text();
    if (body.length > MAX_BYTES) throw new Error('Calendar too large');
    const blocked = parseCalendar(body);
    res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=300');
    return res.status(200).json({ blocked, refreshedAt: new Date().toISOString(),
      note: 'Calendar sync can be delayed. Dates are subject to host confirmation.' });
  } catch (_) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'Availability temporarily unavailable. Please contact the host.' });
  }
};

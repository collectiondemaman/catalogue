#!/usr/bin/env python3
"""Read a private Airbnb iCal URL from the CI secret, publish occupied dates only."""
import datetime as dt
import json
import os
from pathlib import Path
import re
import urllib.request

URL = os.environ.get("AIRBNB_ICAL_URL", "")
OUT = Path(__file__).resolve().parents[1] / "stay-availability.json"


def date_value(value):
    match = re.fullmatch(r"(\d{4})(\d{2})(\d{2})(?:T\d{6}Z?)?", value.strip())
    if not match:
        raise ValueError("Unsupported VEVENT date: " + value[:35])
    return dt.date(*map(int,match.groups()[:3]))


def parse_ical(body):
    if "BEGIN:VCALENDAR" not in body or "END:VCALENDAR" not in body:
        raise ValueError("Not a complete iCalendar file")
    lines = re.sub(r"\r?\n[ \t]", "", body.replace("\r\n", "\n")).splitlines()
    events=[]; event=None
    for line in lines:
        if line.strip()=="BEGIN:VEVENT":
            event={}
        elif line.strip()=="END:VEVENT":
            if event is not None and event.get('STATUS','').upper()!='CANCELLED' and event.get('TRANSP','').upper()!='TRANSPARENT':
                if 'DTSTART' not in event or 'DTEND' not in event:
                    raise ValueError("VEVENT missing date")
                start,end=date_value(event['DTSTART']),date_value(event['DTEND'])
                if end <= start: raise ValueError('Invalid occupied date range')
                events.append({'start':start.isoformat(),'end':end.isoformat()})
            event=None
        elif event is not None and ':' in line:
            head,value=line.split(':',1)
            event[head.split(';',1)[0].upper()]=value
    if not events: raise ValueError('No valid occupied events; refusing to claim all dates free')
    events.sort(key=lambda a:(a['start'],a['end']))
    merged=[]
    for e in events:
        if merged and e['start']<=merged[-1]['end']:
            merged[-1]['end']=max(merged[-1]['end'],e['end'])
        else: merged.append(e.copy())
    return merged,len(events)


def main():
    from urllib.parse import urlparse
    parsed=urlparse(URL)
    if parsed.scheme!='https' or not re.fullmatch(r'(?:[a-z0-9-]+\.)*airbnb\.(?:com|be|fr|de|es|it|co\.uk)',parsed.hostname or '',re.I) or not re.fullmatch(r'/calendar/ical/\d+\.ics',parsed.path):
        raise ValueError('AIRBNB_ICAL_URL secret is missing or invalid')
    req=urllib.request.Request(URL,headers={'User-Agent':'Mozilla/5.0','Accept':'text/calendar,text/plain'})
    with urllib.request.urlopen(req,timeout=20) as r:
        payload=r.read(1024*1024+1)
    if len(payload)>1024*1024: raise ValueError('Calendar file too large')
    blocked,count=parse_ical(payload.decode('utf-8-sig'))
    now=dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z')
    data={'calendarValid':True,'blocked':blocked,'eventCount':count,'refreshedAt':now}
    OUT.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(f'Updated {len(blocked)} blocked ranges from {count} Airbnb events at {now}')

if __name__=='__main__': main()

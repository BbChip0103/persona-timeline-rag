import { spawnSync } from 'node:child_process';
import { TimezoneSchema } from '@ptr/contracts';

test('session timezones agree with Python ZoneInfo for accepted names and rejected offsets',()=>{
  const samples=['UTC','Asia/Seoul','America/New_York','Europe/London','Etc/GMT+9','+09:00','-05:00','GMT+9','Mars/Olympus',''];
  const checked=spawnSync('python3',['-c',`import json,sys
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
def accepts(name):
    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError):
        return False
print(json.dumps([accepts(name) for name in json.load(sys.stdin)]))`],{input:JSON.stringify(samples),encoding:'utf8',timeout:5000});
  expect(checked.status).toBe(0);
  const python=JSON.parse(checked.stdout) as boolean[];
  expect(samples.map(sample=>TimezoneSchema.safeParse(sample).success)).toEqual(python);
});

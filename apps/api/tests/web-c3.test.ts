import { splitReplyBubbles } from '../../web/lib/reply-bubbles';

test.each([
 ['https://example.com/a.b?q=hello!world 확인해. 다음 이야기야.', ['https://example.com/a.b?q=hello!world 확인해.', '다음 이야기야.']],
 ['example.com에서 봤어. 좋아!', ['example.com에서 봤어.', '좋아!']],
 ['3.14야. 정말? 응!', ['3.14야.', '정말?', '응!']],
 ['ㅠ_ㅠ 오늘 힘들었어. 괜찮아?', ['ㅠ_ㅠ 오늘 힘들었어.', '괜찮아?']],
])('bubble boundaries preserve links, domains, decimals and emoticons: %s',(text,expected)=>{
 expect(splitReplyBubbles(text)).toEqual(expected);
});

import { operatorAvailability } from '../../web/lib/operator-availability';
test('operator mismatch warns without exposing values and only adds one operator notice',()=>{
 const warn=jest.fn();
 expect(operatorAvailability(true,false,warn)).toEqual({operatorOptionsAvailable:false,operatorNotice:'운영자 API 옵션이 꺼져 있어요. 설정을 확인해 주세요.'});
 expect(warn).toHaveBeenCalledWith('PTR_OPERATOR_OPTIONS_DISABLED');expect(warn).toHaveBeenCalledTimes(1);
 expect(operatorAvailability(false,false,warn)).toEqual({});expect(operatorAvailability(true,true,warn)).toEqual({operatorOptionsAvailable:true});expect(warn).toHaveBeenCalledTimes(1);
});

import { browserTimezone } from '../../web/lib/browser-timezone';
test('browser timezone uses Intl names and falls back safely for offsets or Intl failure',()=>{
 const original=Intl.DateTimeFormat;
 try {
  for(const [timeZone,expected] of [['Asia/Seoul','Asia/Seoul'],['UTC','UTC'],['+09:00','UTC']]){
   jest.spyOn(Intl,'DateTimeFormat').mockImplementation(()=>({resolvedOptions:()=>({timeZone})}) as Intl.DateTimeFormat);
   expect(browserTimezone()).toBe(expected);jest.restoreAllMocks();
  }
  jest.spyOn(Intl,'DateTimeFormat').mockImplementation(()=>{throw new Error('synthetic');});expect(browserTimezone()).toBe('UTC');
 }finally{Intl.DateTimeFormat=original;jest.restoreAllMocks();}
});

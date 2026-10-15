import { guardReply, replyText, validatePersonaForPublish, voiceText } from '../src';
import { cardPersona } from './persona-fixtures';

test.each(['ambiguous_reference','event_timezone'] as const)('C3 %s copy avoids search wording',key=>{
  for(const [language,level] of [['ko','casual'],['ko','polite'],['en','casual']] as const) {
    for(let seed=0;seed<12;seed++) {
      expect(voiceText(key,language,level,undefined,String(seed)))
        .not.toMatch(/게시물|글이나|올린|시간대|posting|post or|time zone/i);
    }
    expect(replyText(key,language)).not.toMatch(/게시물|올린|시간대|posting|post or|time zone/i);
  }
});

test.each(['게시물 이야기','캡션 같이 읽자','자료 확인','model이 답했어'])('C3 public card blocks %s',async tagline=>{
  const report=await validatePersonaForPublish({...cardPersona,tagline},{sourceRefExists:()=>true,testCaptions:[]});
  expect(report.issues).toContainEqual({path:'tagline',rule:'card_copy',severity:'error'});
});

test.each(['아파','I got sick.','I was ill.','I have been sick.'])('C3 health privacy: %s',reply=>{
  expect(guardReply({utterance:'안녕',reply,realPerson:true,language:'ko'})?.reason).toBe('private_life');
});

test('C3 removes punctuation attached to an orphan connective',()=>{
  expect(guardReply({utterance:'안녕',reply:'남친 있어. 해서! 축하해',realPerson:true,language:'ko'})?.content).toBe('축하해');
});

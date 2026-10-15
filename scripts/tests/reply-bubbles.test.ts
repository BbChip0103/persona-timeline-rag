import { splitReplyBubbles } from '../../apps/web/lib/reply-bubbles';

test('sentence-ending punctuation creates one to three complete bubbles without losing words',()=>{
  expect(splitReplyBubbles('안녕. 오늘은 어땠어?')).toEqual(['안녕.','오늘은 어땠어?']);
  expect(splitReplyBubbles('하나. 둘! 셋? 넷.')).toEqual(['하나.','둘!','셋? 넷.']);
  expect(splitReplyBubbles('문장 하나뿐')).toEqual(['문장 하나뿐']);
  expect(splitReplyBubbles('  ')).toEqual([]);
});

test('decimal prices stay in one bubble and tail line breaks survive the third bubble',()=>{
  expect(splitReplyBubbles('가격은 3.5만원이야. 괜찮지?')).toEqual(['가격은 3.5만원이야.','괜찮지?']);
  expect(splitReplyBubbles('하나. 둘. 셋.\n넷.\n다섯.')).toEqual(['하나.','둘.','셋.\n넷.\n다섯.']);
});

import { guardReply } from '../src/reply-guard';
test.each([
 ['- **오늘은**,\n산책 갈래?', '오늘은, 산책 갈래?'],
 ['- **오늘은**\n좋아!', '오늘은 좋아!'],
 ['- **괜찮아**!\nㅠ_ㅠ', '괜찮아! ㅠ_ㅠ'],
 ['ㅠ_ㅠ 오늘 **힘들었어**. ㅠ_ㅠ', 'ㅠ_ㅠ 오늘 힘들었어. ㅠ_ㅠ'],
 ['- **좋아**,.\n다음에 봐!', '좋아, 다음에 봐!'],
])('markdown cleanup joins lines without inventing punctuation: %s',(reply,expected)=>{
 expect(guardReply({utterance:'안녕',reply,realPerson:false,language:'ko'})?.content).toBe(expected);
});

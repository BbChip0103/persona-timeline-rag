import { PersonaSchema, type Persona } from '@ptr/contracts';
import { cardPersona, v1Persona } from './persona-fixtures';

/** : optional fields only; structure is checked on every read, content at publish time. */
const parses=(patch:Record<string,unknown>)=>PersonaSchema.safeParse({...cardPersona,...patch}).success;
const cp=(n:number,char='가')=>char.repeat(n);

describe('PersonaSchema v2 fields',()=>{
  test('optional public card copy parses without changing the v1 document',()=>{
    const withCard={...v1Persona,tagline:'색으로 하루를 그리는 화가',starters:['오늘은 어떤 색이 좋아?','요즘 뭐 그려?']};
    expect(PersonaSchema.parse(withCard)).toEqual(withCard);
    expect(PersonaSchema.parse(v1Persona)).toEqual(v1Persona);
  });
  test('public card copy has four starters at most and 60 code points per text',()=>{
    expect(parses({tagline:'😀'.repeat(60),starters:['가'.repeat(60),'나','다','라']})).toBe(true);
    expect(parses({tagline:'😀'.repeat(61)})).toBe(false);
    expect(parses({starters:['가'.repeat(61)]})).toBe(false);
    expect(parses({starters:['가','나','다','라','마']})).toBe(false);
    expect(parses({tagline:'   '})).toBe(false);
    expect(parses({starters:['  ']})).toBe(false);
    expect(PersonaSchema.parse({...cardPersona,tagline:'  반가워  ',starters:['  얘기해 줘  ']})).toMatchObject({tagline:'반가워',starters:['얘기해 줘']});
  });
  test('a v1 document (prepare-research shape) still parses, unchanged',()=>{
    expect(PersonaSchema.parse(v1Persona)).toEqual(v1Persona);
    expect(JSON.stringify(PersonaSchema.parse(v1Persona))).toBe(JSON.stringify(v1Persona));
  });
  test('a fully filled card parses; lore priority defaults to 50',()=>{
    expect(PersonaSchema.parse(cardPersona)).toEqual(cardPersona);
    const {priority:_,...noPriority}=cardPersona.lore![0]!;
    expect(PersonaSchema.parse({...cardPersona,lore:[noPriority]}).lore![0]!.priority).toBe(50);
  });
  test.each([
    ['top level',{enabled:true}],
    ['personality',{personality:{...cardPersona.personality,mood:'x'}}],
    ['background',{background:{...cardPersona.background,url:'https://example.invalid'}}],
    ['example turn',{exampleDialogues:[{turns:[{speaker:'user',text:'a'},{speaker:'character',text:'b',emotion:'x'}]}]}],
    ['example dialogue',{exampleDialogues:[{turns:[{speaker:'user',text:'a'},{speaker:'character',text:'b'}],title:'x'}]}],
    ['lore entry (cut CCv3 fields)',{lore:[{...cardPersona.lore![0],enabled:true}]}],
    ['lore secondaryKeys',{lore:[{...cardPersona.lore![0],secondaryKeys:['x']}]}],
    ['meta',{meta:{tags:[],avatar:'x'}}],
    ['system_prompt',{system_prompt:'x'}],
    ['post_history_instructions',{post_history_instructions:'x'}],
  ])('unknown keys are rejected: %s',(_name,patch)=>{expect(parses(patch)).toBe(false);});
  test('example speaker is user|character only',()=>{
    expect(parses({exampleDialogues:[{turns:[{speaker:'system',text:'a'},{speaker:'character',text:'b'}]}]})).toBe(false);
  });
  const p=cardPersona.personality!,b=cardPersona.background!,l=cardPersona.lore![0]!,turn=(text:string)=>({speaker:'user',text});
  // [name, patch at the limit, patch one over the limit]
  const limits:[string,Record<string,unknown>,Record<string,unknown>][]=[
    ['alternateGreetings text',{alternateGreetings:[cp(300)]},{alternateGreetings:[cp(301)]}],
    ['alternateGreetings count',{alternateGreetings:Array(4).fill('hi')},{alternateGreetings:Array(5).fill('hi')}],
    ['personality.summary',{personality:{...p,summary:cp(300)}},{personality:{...p,summary:cp(301)}}],
    ['personality.traits text',{personality:{...p,traits:[cp(40)]}},{personality:{...p,traits:[cp(41)]}}],
    ['personality.traits count',{personality:{...p,traits:Array(8).fill('a')}},{personality:{...p,traits:Array(9).fill('a')}}],
    ['personality.values text',{personality:{...p,values:[cp(60)]}},{personality:{...p,values:[cp(61)]}}],
    ['personality.values count',{personality:{...p,values:Array(6).fill('a')}},{personality:{...p,values:Array(7).fill('a')}}],
    ['personality.speechHabits text',{personality:{...p,speechHabits:[cp(80)]}},{personality:{...p,speechHabits:[cp(81)]}}],
    ['personality.speechHabits count',{personality:{...p,speechHabits:Array(8).fill('a')}},{personality:{...p,speechHabits:Array(9).fill('a')}}],
    ['background.text',{background:{...b,text:cp(500)}},{background:{...b,text:cp(501)}}],
    ['background.sourceRefs max',{background:{...b,sourceRefs:Array.from({length:20},(_,i)=>`web:${i}`)}},{background:{...b,sourceRefs:Array.from({length:21},(_,i)=>`web:${i}`)}}],
    ['background.sourceRefs min',{background:{...b,sourceRefs:['web:1']}},{background:{...b,sourceRefs:[]}}],
    ['exampleDialogues count',{exampleDialogues:Array(3).fill({turns:[turn('a'),turn('b')]})},{exampleDialogues:Array(4).fill({turns:[turn('a'),turn('b')]})}],
    ['example turns max',{exampleDialogues:[{turns:Array(6).fill(turn('a'))}]},{exampleDialogues:[{turns:Array(7).fill(turn('a'))}]}],
    ['example turns min',{exampleDialogues:[{turns:Array(2).fill(turn('a'))}]},{exampleDialogues:[{turns:[turn('a')]}]}],
    ['example turn text',{exampleDialogues:[{turns:[turn(cp(200)),turn('a')]}]},{exampleDialogues:[{turns:[turn(cp(201)),turn('a')]}]}],
    ['lore count',{lore:Array.from({length:50},(_,i)=>({...l,id:`l${i}`}))},{lore:Array.from({length:51},(_,i)=>({...l,id:`l${i}`}))}],
    ['lore keys count',{lore:[{...l,keys:Array(8).fill('ab')}]},{lore:[{...l,keys:Array(9).fill('ab')}]}],
    ['lore keys min',{lore:[{...l,keys:['ab']}]},{lore:[{...l,keys:[]}]}],
    ['lore key short',{lore:[{...l,keys:['붓질']}]},{lore:[{...l,keys:['붓']}]}],
    ['lore key long',{lore:[{...l,keys:[cp(40)]}]},{lore:[{...l,keys:[cp(41)]}]}],
    ['lore content',{lore:[{...l,content:cp(300)}]},{lore:[{...l,content:cp(301)}]}],
    ['lore priority max',{lore:[{...l,priority:100}]},{lore:[{...l,priority:101}]}],
    ['lore priority min',{lore:[{...l,priority:0}]},{lore:[{...l,priority:-1}]}],
    ['lore priority integer',{lore:[{...l,priority:7}]},{lore:[{...l,priority:7.5}]}],
    ['lore sourceRefs max',{lore:[{...l,sourceRefs:Array(10).fill('web:1')}]},{lore:[{...l,sourceRefs:Array(11).fill('web:1')}]}],
    ['lore sourceRefs min',{lore:[{...l,sourceRefs:['web:1']}]},{lore:[{...l,sourceRefs:[]}]}],
    ['meta.tags text',{meta:{tags:[cp(30)]}},{meta:{tags:[cp(31)]}}],
    ['meta.tags count',{meta:{tags:Array(12).fill('a')}},{meta:{tags:Array(13).fill('a')}}],
    ['meta.creatorNotes',{meta:{creatorNotes:cp(2000)}},{meta:{creatorNotes:cp(2001)}}],
  ];
  test.each(limits)('limit %s: n passes, n+1 fails',(_name,at,over)=>{
    expect(parses(at)).toBe(true);expect(parses(over)).toBe(false);
  });
  test('lengths are code points, not UTF-16 units (an emoji counts once)',()=>{
    expect('😀'.repeat(300).length).toBe(600);
    expect(parses({alternateGreetings:['😀'.repeat(300)]})).toBe(true);
    expect(parses({alternateGreetings:['😀'.repeat(301)]})).toBe(false);
  });
  test('text fields are trimmed and must not be blank',()=>{
    expect(parses({alternateGreetings:['   ']})).toBe(false);
    expect(parses({background:{...b,text:' \n '}})).toBe(false);
    expect(PersonaSchema.parse({...cardPersona,alternateGreetings:['  hi  ']}).alternateGreetings).toEqual(['hi']);
  });
  test('every new field is optional on its own',()=>{
    for(const key of ['alternateGreetings','personality','background','exampleDialogues','lore','meta'] as const) {
      const {[key]:_,...rest}=cardPersona as Persona;expect(PersonaSchema.safeParse(rest).success).toBe(true);
    }
  });
});

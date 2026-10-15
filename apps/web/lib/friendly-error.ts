/** User-facing copy for API and turn errors. Never interpolate an upstream code or message. */
const copy:Record<string,{ko:string;en:string}>={
  INTAKE_PAUSED:{ko:'잠시 점검 중이에요. 조금 뒤에 다시 이야기해요!',en:'We’re taking a short maintenance break. Please try again in a moment!'},
  QUEUE_FULL:{ko:'지금 대화가 몰려서 조금 뒤에 다시 보내 줘!',en:'Lots of people are chatting right now. Please send that again in a bit!'},
  QUEUE_TIMEOUT:{ko:'답장을 시작하는 데 시간이 좀 걸렸어. 조금 뒤에 다시 보내 줘!',en:'It took too long to start a reply. Please send that again in a bit!'},
  WORKER_LOST:{ko:'답장을 쓰다가 잠깐 문제가 생겼어. 다시 보내 줄래?',en:'Something interrupted the reply. Could you send that again?'},
  PROVIDER_REQUEST_UNRESOLVED:{ko:'답장이 아직 확인되지 않았어. 잠시 뒤에 대화를 다시 열어 봐!',en:'The reply is still being checked. Please open this chat again in a moment!'},
  PROVIDER_UNAVAILABLE:{ko:'지금은 답장을 받을 수 없었어. 조금 뒤에 다시 이야기하자!',en:'I couldn’t get a reply just now. Let’s talk again in a bit!'},
  CONTEXT_LIMIT:{ko:'이 대화가 꽤 길어졌어. 새 대화에서 이어서 이야기하자!',en:'This chat has grown long. Let’s continue in a new chat!'},
  TURN_FAILED:{ko:'답장을 마치지 못했어. 다시 보내 줄래?',en:'I couldn’t finish the reply. Could you send that again?'},
  TURN_TIMEOUT:{ko:'답장이 너무 오래 걸렸어. 조금 뒤에 다시 보내 줘!',en:'The reply took too long. Please send that again in a bit!'},
  INVALID_INPUT:{ko:'메시지를 다시 확인해 줄래?',en:'Could you check your message and try again?'},
  INVALID_DATE_RANGE:{ko:'날짜 범위를 다시 확인해 줘.',en:'Please check the date range.'},
  BODY_TOO_LARGE:{ko:'메시지가 너무 길어. 조금 짧게 보내 줄래?',en:'That message is too long. Could you shorten it?'},
  PERSONA_UNAVAILABLE:{ko:'이 캐릭터는 지금 대화할 수 없어. 다른 캐릭터를 골라 줘.',en:'This character isn’t available right now. Please choose another one.'},
  SEMANTIC_UNAVAILABLE:{ko:'이 설정으로는 대화를 시작할 수 없어. 다른 설정을 골라 줘.',en:'This setting isn’t available right now. Please choose another one.'},
  TURN_ACTIVE:{ko:'앞선 답장을 기다리고 있어. 잠깐만 기다려 줘!',en:'I’m still waiting for the previous reply. Just a moment!'},
  IDEMPOTENCY_CONFLICT:{ko:'이 메시지를 확인하지 못했어. 다시 입력해 줄래?',en:'I couldn’t check that message. Could you enter it again?'},
  UNAUTHORIZED:{ko:'다시 로그인해 줄래?',en:'Please sign in again.'},
  FORBIDDEN:{ko:'지금은 이 대화를 열 수 없어.',en:'I can’t open this chat right now.'},
  NOT_FOUND:{ko:'대화를 찾지 못했어. 목록에서 다시 골라 줘.',en:'I couldn’t find that chat. Please choose it from the list.'},
};
const fallback={ko:'잠깐 문제가 생겼어. 조금 뒤에 다시 이야기하자!',en:'Something went wrong. Let’s talk again in a bit!'};
export function friendlyError(code:string|undefined,language='ko'):string {
  const languageKey=/^ko(?:$|[-_])/i.test(language)?'ko':'en';
  return (code&&Object.hasOwn(copy,code)?copy[code]:undefined)?.[languageKey]??fallback[languageKey];
}

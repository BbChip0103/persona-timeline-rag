/** Service-state wording is not a persona memory. Never echo arbitrary provider details. */
export function turnNotice(turn:{state:string;errorCode?:string}):string {
  if(turn.state==='cancelled')return '생성을 취소했습니다. 이미 제출된 외부 요청은 다시 전송하지 않습니다.';
  if(turn.state!=='failed')return '';
  if(turn.errorCode==='PROVIDER_REQUEST_UNRESOLVED')return '이전 외부 요청의 처리 결과가 미확정이라 같은 요청을 다시 제출하지 않았어요. 중복 과금을 피하기 위해 자동 재전송하지 않습니다.';
  if(turn.errorCode==='PROVIDER_UNAVAILABLE')return '외부 모델 응답을 받지 못했어요. 자동 재전송하지 않았습니다. 이 대화의 이전 메시지는 유지됩니다.';
  if(turn.errorCode==='CONTEXT_LIMIT')return '대화가 처리 가능한 길이를 넘었어요. 새 대화를 시작해 주세요. 자동 재전송하지 않았습니다.';
  return '생성에 실패했습니다. 자동 재전송하지 않았습니다.';
}

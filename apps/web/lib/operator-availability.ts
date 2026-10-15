/** Configuration diagnostics contain fixed codes only, never environment values. */
export function operatorAvailability(operatorMode:boolean,apiOptions:boolean,warn:(code:string)=>void):{operatorOptionsAvailable?:boolean;operatorNotice?:string} {
  if(!operatorMode)return {};
  if(apiOptions)return {operatorOptionsAvailable:true};
  warn('PTR_OPERATOR_OPTIONS_DISABLED');
  return {operatorOptionsAvailable:false,operatorNotice:'운영자 API 옵션이 꺼져 있어요. 설정을 확인해 주세요.'};
}

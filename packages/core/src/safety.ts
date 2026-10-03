/** Narrow pattern gates, not semantic fact verification or comprehensive secret detection. */
export function containsCredentialPattern(text:string):boolean {
  return /\bsk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|(?:api[_-]?key|password)\s*[:=]/i.test(text);
}
const explicitlyCreative=/\b(fictional|imaginary|invent(?:ed)?|creative|role[ -]?play)\b|가상|허구|창작|상상/i;
export function isExplicitlyCreativeRequest(text:string):boolean { return explicitlyCreative.test(text); }
export function isBiographicalRequest(text:string):boolean {
  if(isExplicitlyCreativeRequest(text)) return false;
  const english=/\b(childhood|birthplace|birth ?date|birthday|hometown|upbringing|biograph(?:y|ical)|early life|grew up|born|education|school|university|college|graduat(?:e|ed|ion)|parents?|siblings?|marriage|spouse|career)\b/i.test(text);
  const directed=/\b(your|you|describe|tell me|what|where|when|how)\b/i.test(text);
  const korean=/어린\s?시절|어릴\s?적|유년\s?시절|유년기|학창\s?시절|어렸을\s?때|출생지|출생|생년월일|고향|태어난|태어났|자랐|학력|대학교|고등학교|어떤\s?대학|졸업|출신|부모|형제|생일/.test(text);
  const ownKorean=/내\s?생일|제\s?생일|저의|나의/.test(text)&&!/(너의|당신의|네\s?생일|네\s?어린)/.test(text);
  return (english&&directed)||(korean&&!ownKorean);
}
export function containsUngroundedBiography(text:string):boolean {
  // Explicitly fictional creative output is allowed; it remains non-evidence elsewhere in core.
  if(explicitlyCreative.test(text)) return false;
  return /\bI (?:was born|used to (?:live|work|study)|attended|grew up|was raised|spent my childhood|graduated|studied at|worked at|lived in|got married|went to (?:school|college|university))\b|\bmy (?:birthplace|hometown|childhood|parents?|mother|father|siblings?)\b/i.test(text)
    ||/(?:저는|나는|제가|내가)[^.!?\n]{0,120}(?:태어났|자랐|출생했|졸업했|다녔|나왔|살았|근무했|결혼했)|(?:제|나의|내)\s?(?:고향|출생지|어린\s?시절|부모님|어머니|아버지)/.test(text);
}

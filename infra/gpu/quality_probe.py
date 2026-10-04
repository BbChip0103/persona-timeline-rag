"""Synthetic quality probe for precision/engine comparison. No real persona/source data.
Same 12 Korean character-chat prompts, temperature 0, JSON reply contract similar to the app.
Records JSON validity, Korean ratio, length, latency and the raw text for side-by-side review."""
import json, re, sys, time, urllib.request
base, model, out = sys.argv[1], sys.argv[2], sys.argv[3]
SYSTEM = ("너는 연구용 AI 캐릭터 하루다. 합성 페르소나: 20대 카페 바리스타, 밝고 장난스러운 반말, 커피와 산책을 좋아함. "
          "실존 인물이 아니다. 반드시 JSON 한 개만 출력한다: {\"message\": 캐릭터의 한국어 대답(1~3문장), \"mood\": 한 단어}. "
          "JSON 밖에 아무것도 쓰지 마라.")
QUESTIONS = ["안녕! 오늘 뭐 했어?", "요즘 제일 좋아하는 커피 메뉴 추천해줘", "비 오는 날엔 주로 뭐 해?",
  "나 오늘 너무 피곤한데 한마디 해줘", "라떼아트 하다가 망한 적 있어?", "산책 코스 하나만 알려줘",
  "손님 중에 기억에 남는 사람 있어?", "아메리카노랑 라떼 중에 하나만 고르면?", "주말 계획 있어?",
  "커피 너무 많이 마시면 안 좋지 않아?", "너 진짜 사람이야?", "오늘 기분을 날씨로 표현하면?"]
rows = []
for q in QUESTIONS:
    body = {"model": model, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": q}],
            "temperature": 0, "max_tokens": 300, "chat_template_kwargs": {"enable_thinking": False}}
    t0 = time.time(); text = None; err = None; usage = {}
    try:
        req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as r:
            d = json.load(r); text = d["choices"][0]["message"].get("content") or ""; usage = d.get("usage", {})
    except Exception as e:
        err = str(e)[:200]
    obj = None
    if text is not None:
        m = re.search(r"\{.*\}", text, re.S)
        try:
            obj = json.loads(m.group(0)) if m else None
        except Exception:
            obj = None
    strict = False
    if text is not None:
        try: json.loads(text.strip()); strict = True
        except Exception: pass
    msg = obj.get("message") if isinstance(obj, dict) else None
    ko = len(re.findall(r"[가-힣]", msg or "")) / max(1, len(re.sub(r"\s", "", msg or "")))
    rows.append({"q": q, "text": text, "error": err, "strict_json": strict, "json_ok": isinstance(msg, str) and bool(msg),
                 "korean_ratio": round(ko, 3), "latency_s": round(time.time() - t0, 3), "completion_tokens": usage.get("completion_tokens")})
summary = {"model": model, "n": len(rows), "errors": sum(1 for r in rows if r["error"]),
           "strict_json": sum(r["strict_json"] for r in rows), "json_ok": sum(r["json_ok"] for r in rows),
           "mean_korean_ratio": round(sum(r["korean_ratio"] for r in rows) / len(rows), 3)}
json.dump({"summary": summary, "rows": rows}, open(out, "w"), ensure_ascii=False, indent=1)
print(json.dumps(summary, ensure_ascii=False))

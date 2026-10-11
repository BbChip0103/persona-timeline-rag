"""Shared, privacy-preserving admission ledger for the LiteLLM custom router.

The caller must finish requests within 25 seconds; reservations expire after at
most 35 seconds (deadline plus cleanup grace). Success means a complete response,
not the first streaming chunk. Redis failures propagate: never bypass shared
credit accounting locally. Candidate IDs and request IDs are HMACed before Redis.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
from typing import Any

# All mutations, including expired-lease recovery, execute on Redis's clock in
# one atomic script. Keys share one cluster hash tag. Prefixes contain hashes
# only; no message text, endpoint, request identifier, or provider key is stored.
_SCRIPT = r"""
local states,reservations,expiry,policy,rotation,learned = unpack(KEYS)
local tm=redis.call('TIME'); local now=tonumber(tm[1])+tonumber(tm[2])/1000000
local function read(id)
 local raw=redis.call('HGET',states,id)
 if raw then return cjson.decode(raw) end
 return {n=0,u=0,kv=0,prefix={}}
end
local function save(id,s) redis.call('HSET',states,id,cjson.encode(s)) end
local function prune(s)
 local entries={}; local tokens=0
 for hash,p in pairs(s.prefix) do
  if now-p.seen>120 then s.prefix[hash]=nil
  else table.insert(entries,{hash=hash,seen=p.seen}); tokens=tokens+(p.own or 0) end
 end
 local count=#entries
 if count<=4096 and (not s.capacity or tokens<=s.capacity) then return end
 table.sort(entries,function(a,b)
  if a.seen==b.seen then return a.hash<b.hash end
  return a.seen<b.seen
 end)
 for _,p in ipairs(entries) do
  if count<=4096 and (not s.capacity or tokens<=s.capacity) then break end
  tokens=tokens-(s.prefix[p.hash].own or 0); s.prefix[p.hash]=nil; count=count-1
 end
end
local function record(s,r)
 if s.cache_epoch~=r.cache_epoch then return end
 for i=#r.chain,1,-1 do
  local p=r.chain[i]; local previous=i>1 and r.chain[i-1].tokens or 0
  s.prefix[p.hash]={seen=now+(#r.chain-i)*0.000001,own=p.tokens-previous}
 end
 prune(s)
end
local function finish(key,success)
 local raw=redis.call('HGET',reservations,key)
 if not raw then return end
 local r=cjson.decode(raw); local s=read(r.id)
 if s.identity==r.identity then
  s.n=math.max(0,s.n-1); s.u=math.max(0,s.u-r.u); s.kv=math.max(0,s.kv-r.kv)
  if success and s.cache_epoch==r.cache_epoch then
   record(s,r)
  elseif not success then s.prefix={}; s.cache_epoch=(s.cache_epoch or 0)+1 end
  save(r.id,s)
 end
 redis.call('HDEL',reservations,key); redis.call('ZREM',expiry,key)
end
for _,key in ipairs(redis.call('ZRANGEBYSCORE',expiry,'-inf',now)) do finish(key,false) end
redis.call('ZREMRANGEBYSCORE',learned,'-inf',now)
local cmd=ARGV[1]; local data=cjson.decode(ARGV[2]); local result=''
if cmd=='release' then finish(data.request,data.success)
elseif cmd=='prefilled' then
 local raw=redis.call('HGET',reservations,data.request)
 if raw then
  local r=cjson.decode(raw); local s=read(r.id)
  if s.identity==r.identity and not r.prefilled then
   s.u=math.max(0,s.u-r.u); r.u=0; r.prefilled=true
   record(s,r); save(r.id,s)
   redis.call('HSET',reservations,data.request,cjson.encode(r))
  end
 end
elseif cmd=='clear' then
 local s=read(data.id); s.prefix={}; s.cache_epoch=(s.cache_epoch or 0)+1; save(data.id,s)
elseif cmd=='telemetry' then
 local s=read(data.id)
 if data.identity~=cjson.null then
  if s.identity and s.identity~=data.identity then return '' end
  s.identity=data.identity
 end
 s.telemetry={seen=now,kv=data.kv,waiting=data.waiting,running=data.running}
 local start=data.start~=cjson.null and data.start or nil
 if start then
  s.start_missing=false
  if not s.start then s.start=start
  elseif s.disabled then
   if s.stable_start==start then s.stable_count=(s.stable_count or 0)+1
   else s.stable_start=start; s.stable_count=1 end
   if s.stable_count>=30 then s.start=start; s.disabled=false; s.pending=nil end
  elseif start<s.start then
   s.prefix={}; s.cache_epoch=(s.cache_epoch or 0)+1; s.disabled=true
   s.stable_start=start; s.stable_count=1; s.pending=nil
  elseif start>s.start then
   if s.pending==start then
    s.prefix={}; s.cache_epoch=(s.cache_epoch or 0)+1; s.start=start; s.pending=nil
   else s.pending=start end
  else s.pending=nil end
 elseif s.start and not s.start_missing then
  s.prefix={}; s.cache_epoch=(s.cache_epoch or 0)+1; s.disabled=true
  s.start_missing=true; s.stable_count=0; s.stable_start=nil; s.pending=nil
 end
 save(data.id,s)
elseif cmd=='select' then
 local existing=redis.call('HGET',reservations,data.request)
 if existing then result=cjson.decode(existing).id
 else
  local p=cjson.decode(redis.call('GET',policy) or '{"variants":{}}')
  if data.first~='' and not redis.call('ZSCORE',learned,data.request) then
   for _,v in pairs(p.variants) do v.count=v.count*math.pow(.5,1/256) end
   local v=p.variants[data.first] or {tokens=data.first_tokens,count=0}
   v.count=v.count+1; p.variants[data.first]=v
   local count=0; local rare=nil; local top=nil
   for hash,e in pairs(p.variants) do
    count=count+1
    if hash~=data.first and (not rare or e.count<p.variants[rare].count) then rare=hash end
    if not top or e.count>p.variants[top].count then top=hash end
   end
   if count>16 then p.variants[rare]=nil end
   p.top=top; p.g=p.variants[top].tokens
   redis.call('ZADD',learned,now+35,data.request)
  end
  redis.call('SET',policy,cjson.encode(p),'EX',3600)
  local g=p.g or 0; local cached=data.first==p.top and g or 0
  local fitting={}; local blocked={}
  for _,c in ipairs(data.candidates) do
   local s=read(c.id)
   if s.identity~=c.identity then
    s={identity=c.identity,n=0,u=0,kv=0,prefix={},cache_epoch=0,
       telemetry=not s.identity and s.telemetry or nil,
       start=not s.identity and s.start or nil}
   end
   local capacity=c.capacity~=cjson.null and c.capacity or nil
   local rate=c.rate~=cjson.null and c.rate or nil
   s.capacity=capacity; prune(s)
   local matched=0
   if data.affinity then
    for _,h in ipairs(data.chain) do
     if s.prefix[h.hash] then matched=math.max(matched,h.tokens) end
    end
   end
   local uncached=math.max(0,data.tokens-math.max(cached,matched))
   local kv=math.max(0,data.tokens-cached)+data.max_tokens
   local budget=capacity and (.9*capacity-math.min(g,.9*capacity/2)) or math.huge
   local fits=s.n+1<=c.limit and (s.n==0 or s.kv+kv<=budget)
   if rate and s.u>0 and s.u+uncached>rate*data.max_prefill_s then fits=false end
   local t=s.telemetry; local overload=false
   if t and now-t.seen<=3*data.poll_s then
    overload=(t.kv~=cjson.null and t.kv and t.kv>=.95)
     or (t.waiting~=cjson.null and t.waiting and t.waiting>2)
     or (not data.allow_overloaded_idle and t.running~=cjson.null
         and t.running and t.running>=c.limit) or false
   end
   local cost=(s.u+uncached)/((rate or c.weight*10000)*data.max_prefill_s)+(s.n+1)/c.limit
   local member={id=c.id,s=s,cost=cost,matched=matched,u=uncached,kv=kv,tie=c.tie}
   if fits then
    if not overload then table.insert(fitting,member)
    elseif s.n==0 then table.insert(blocked,member) end
   end
   save(c.id,s)
  end
  if #fitting==0 and data.allow_overloaded_idle then fitting=blocked end
  if #fitting>0 then
   local cheapest=math.huge; local bestgain=-math.huge
   for _,m in ipairs(fitting) do
    cheapest=math.min(cheapest,m.cost); bestgain=math.max(bestgain,m.matched-g)
   end
   local sticky=nil
   if data.affinity and bestgain>=data.min_tokens then
    for _,m in ipairs(fitting) do
     if m.matched-g==bestgain and (not sticky or m.cost<sticky.cost-1e-9
       or (math.abs(m.cost-sticky.cost)<1e-9 and m.tie>sticky.tie)) then sticky=m end
    end
    if sticky.cost>cheapest+data.slack+1e-9 then sticky=nil end
   end
   local chosen=sticky
   if not chosen then
    local value=math.huge; local tied={}
    for _,m in ipairs(fitting) do
     local rank=data.policy=='scored' and m.cost or m.s.n
     if rank<value-1e-9 then value=rank; tied={m}
     elseif math.abs(rank-value)<1e-9 then table.insert(tied,m) end
    end
    if data.affinity or data.policy=='scored' then
     for _,m in ipairs(tied) do if not chosen or m.tie>chosen.tie then chosen=m end end
    else local turn=redis.call('INCR',rotation); chosen=tied[(turn-1)%#tied+1] end
   end
   local s=chosen.s; s.n=s.n+1; s.u=s.u+chosen.u; s.kv=s.kv+chosen.kv; save(chosen.id,s)
   local r={id=chosen.id,identity=s.identity,cache_epoch=s.cache_epoch,
            u=chosen.u,kv=chosen.kv,chain=data.chain}
   redis.call('HSET',reservations,data.request,cjson.encode(r))
   redis.call('ZADD',expiry,now+data.lease_s,data.request); result=chosen.id
  end
 end
end
for _,key in ipairs(KEYS) do redis.call('EXPIRE',key,3600) end
return result
"""


def _positive(value: Any, default: float, name: str) -> float:
    if value is None:
        return default
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not 1e-9 <= value <= 1e12
        or not math.isfinite(value)
    ):
        raise ValueError(f"{name} must be finite and between 1e-9 and 1e12")
    return float(value)


class RoutingState:
    """Atomic multi-Proxy credit, cache-affinity, and telemetry routing state.

    Candidates: id, identity (endpoint/model/epoch fingerprint), max_seqs=32,
    weight=1, optional kv_capacity and calibrated prefill_rate. Options: policy
    ('least_inflight' or 'scored'), affinity=True, min_tokens=256, slack=.5,
    telemetry_poll_s=1, max_prefill_s=1, lease_s=35 (maximum). No extra HTTP calls
    are made in select; background telemetry updates are read from Redis.
    Text content is limited to 65536 UTF-8 bytes, max_tokens to 32768,
    max_seqs to integer 1..65536; positive rates/capacities/weights are bounded
    to 1e-9..1e12 to keep shared Lua arithmetic finite.
    """

    def __init__(self, redis: Any, *, namespace: str = "", salt: str):
        if not isinstance(salt, str) or len(salt.encode()) < 16:
            raise ValueError("a shared routing salt of at least 16 bytes is required")
        self.redis = redis
        self._salt = salt.encode()
        tag = self._hash("namespace", namespace)[:24]
        self.keys = [
            f"ptr:routing:{{{tag}}}:{suffix}"
            for suffix in ("states", "leases", "expiry", "policy", "rotation", "learned")
        ]

    def _hash(self, kind: str, value: str) -> str:
        return hmac.new(self._salt, (kind + "\0" + value).encode(), hashlib.sha256).hexdigest()

    def _estimate(self, messages: list[dict[str, Any]]) -> dict[str, Any]:
        if not isinstance(messages, list) or len(messages) > 1024:
            raise ValueError("messages must be a list of at most 1024 messages")
        encoded = []
        content_bytes = 0
        for message in messages:
            if not isinstance(message, dict):
                raise ValueError("messages must contain mappings")
            role, content = message.get("role"), message.get("content")
            if not isinstance(role, str) or not isinstance(content, str):
                raise ValueError("routing supports text messages with role/content strings")
            if len(role) > 64 or len(content) > 65536 - content_bytes:
                raise ValueError("routing text exceeds the UTF-8 size limit")
            try:
                rb, cb = role.encode(), content.encode()
            except UnicodeEncodeError:
                raise ValueError("routing text must be valid UTF-8") from None
            content_bytes += len(cb)
            if len(rb) > 64 or content_bytes > 65536:
                raise ValueError("routing text exceeds the UTF-8 size limit")
            encoded.append((role, content, rb, cb))
        running = hmac.new(self._salt, b"chain\0", hashlib.sha256)
        affinity = hmac.new(self._salt, b"affinity\0", hashlib.sha256)
        total = 0
        chain = []
        # Never claim a new last user turn is a cache hit. Retain at most 64
        # boundaries; cumulative hashes still include all earlier messages.
        last_user = max(
            (i for i, m in enumerate(messages) if m.get("role") == "user"), default=len(messages)
        )
        first = ""
        first_tokens = 0
        for i, (role, content, rb, cb) in enumerate(encoded):
            part = str(len(rb)).encode() + b":" + rb + str(len(cb)).encode() + b":" + cb
            running.update(part)
            if i < 2:
                affinity.update(part)
            total += len(cb)
            if i < last_user:
                chain.append({"hash": running.copy().hexdigest(), "tokens": math.ceil(total / 3.9)})
            if i == 0 and role == "system":
                first, first_tokens = self._hash("system", content), math.ceil(len(cb) / 3.9)
        return {
            "tokens": math.ceil(total / 3.9),
            "chain": chain[-64:],
            "first": first,
            "first_tokens": first_tokens,
            "affinity_key": affinity.hexdigest(),
        }

    async def _call(self, command: str, payload: dict[str, Any]) -> Any:
        return await self.redis.eval(
            _SCRIPT,
            len(self.keys),
            *self.keys,
            command,
            json.dumps(payload, allow_nan=False, separators=(",", ":")),
        )

    async def select(
        self,
        candidates: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        max_tokens: int,
        request_id: str,
        options: dict[str, Any] | None = None,
    ) -> str | None:
        """Return original candidate ID, or None when no shared credit fits.

        Retrying an active request ID returns the same reservation without
        consuming more credit. IDs must be unique per actual model attempt.
        """
        if options is not None and not isinstance(options, dict):
            raise ValueError("options must be a mapping")
        options = options or {}
        if not isinstance(request_id, str) or not request_id:
            raise ValueError("request_id must be a nonempty string")
        if (
            not isinstance(max_tokens, int)
            or isinstance(max_tokens, bool)
            or not 1 <= max_tokens <= 32768
        ):
            raise ValueError("max_tokens must be an integer between 1 and 32768")
        if not isinstance(candidates, list) or len(candidates) > 64:
            raise ValueError("at most 64 candidates are supported")
        policy = options.get("policy", "least_inflight")
        if not isinstance(options.get("affinity", True), bool):
            raise ValueError("affinity must be a boolean")
        if policy not in ("least_inflight", "scored"):
            raise ValueError("unsupported routing policy")
        if not isinstance(options.get("allow_overloaded_idle", True), bool):
            raise ValueError("allow_overloaded_idle must be a boolean")
        estimate = self._estimate(messages)
        normalized, ids = [], {}
        for c in candidates:
            if not isinstance(c, dict):
                raise ValueError("candidates must contain mappings")
            limit = c.get("max_seqs", 32)
            if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 65536:
                raise ValueError("max_seqs must be an integer between 1 and 65536")
            cid, identity = c.get("id"), c.get("identity")
            if not isinstance(cid, str) or not cid or not isinstance(identity, str) or not identity:
                raise ValueError("candidates require nonempty id and identity")
            opaque = self._hash("candidate", cid)
            if opaque in ids:
                raise ValueError("duplicate candidate id")
            ids[opaque] = cid
            normalized.append(
                {
                    "id": opaque,
                    "identity": self._hash("identity", identity),
                    "limit": limit,
                    "weight": _positive(c.get("weight"), 1, "weight"),
                    "capacity": _positive(c["kv_capacity"], 1, "kv_capacity")
                    if c.get("kv_capacity") is not None
                    else None,
                    "rate": _positive(c["prefill_rate"], 1, "prefill_rate")
                    if c.get("prefill_rate") is not None
                    else None,
                    "tie": self._hash("tie", estimate["affinity_key"] + "\n" + cid),
                }
            )
        slack = options.get("slack", 0.5)
        min_tokens = options.get("min_tokens", 256)
        if any(
            isinstance(v, bool)
            or not isinstance(v, (int, float))
            or not 0 <= v <= 1e12
            or not math.isfinite(v)
            for v in (slack, min_tokens)
        ):
            raise ValueError("slack and min_tokens must be finite and nonnegative")
        payload = dict(
            estimate,
            candidates=normalized,
            request=self._hash("request", request_id),
            max_tokens=max_tokens,
            policy=policy,
            allow_overloaded_idle=options.get("allow_overloaded_idle", True),
            affinity=bool(options.get("affinity", True)),
            min_tokens=min_tokens,
            slack=slack,
            poll_s=_positive(options.get("telemetry_poll_s"), 1, "telemetry_poll_s"),
            max_prefill_s=_positive(options.get("max_prefill_s"), 1, "max_prefill_s"),
            lease_s=min(35, _positive(options.get("lease_s"), 35, "lease_s")),
        )
        selected = await self._call("select", payload)
        if isinstance(selected, bytes):
            selected = selected.decode()
        return ids.get(selected)

    async def claim_budget(self, nonce: str) -> bool:
        """One-use authority across Proxy replicas, covering the full <=30s validity."""
        return bool(
            await self.redis.set(
                self.keys[0] + ":budget:" + self._hash("budget", nonce), "1", nx=True, ex=35
            )
        )

    async def release(self, request_id: str, success: bool) -> None:
        """Idempotently release credit; only completed successes learn prefixes."""
        await self._call(
            "release", {"request": self._hash("request", request_id), "success": bool(success)}
        )

    async def prefilled(self, request_id: str) -> None:
        """First streaming chunk: release U, learn cache, but retain N/KV.

        Idempotent; stream completion must still call release. A later failed
        stream clears the approximate cache conservatively.
        """
        await self._call("prefilled", {"request": self._hash("request", request_id)})

    async def clear_prefix(self, candidate_id: str) -> None:
        """Invalidate learned cache; active requests cannot repopulate old epoch."""
        await self._call("clear", {"id": self._hash("candidate", candidate_id)})

    async def update_telemetry(
        self,
        candidate_id: str,
        kv_usage: Any,
        waiting: Any,
        process_start: Any = None,
        *,
        identity: str | None = None,
        running: float | None = None,
    ) -> None:
        """Malformed/stale gauges fail open; two later start samples clear cache.

        Earlier/ambiguous starts clear cache and disarm restart detection until
        30 stable samples. kv_usage is a fraction [0,1], waiting a nonnegative
        request count, process_start a positive Unix seconds timestamp.
        """

        def gauge(value: Any, maximum: float = 1e12) -> float | None:
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not 0 <= value <= maximum
                or not math.isfinite(value)
            ):
                return None
            return float(value)

        start = gauge(process_start)
        await self._call(
            "telemetry",
            {
                "id": self._hash("candidate", candidate_id),
                "kv": gauge(kv_usage, 1),
                "waiting": gauge(waiting),
                "running": gauge(running),
                "start": start if start else None,
                "identity": self._hash("identity", identity) if identity else None,
            },
        )

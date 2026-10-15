import 'reflect-metadata';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Body, Catch, Controller, Get, HttpCode, HttpException, Inject, Module, Param, Post, Req, Res, UseGuards, type ArgumentsHost, type CanActivate, type ExecutionContext, type ExceptionFilter, type INestApplication, type OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {json,type Request,type Response,type NextFunction} from 'express';
import { z } from 'zod';
import { DraftRequestSchema, ExecutionProfileSchema, RagConditionSchema, RetrievalModeSchema, SendTurnSchema, TimezoneSchema, type ChatSession } from '@ptr/contracts';
import {CoreError} from '../../../packages/core/src/ports';
import {containsCredentialPattern,containsInternalPathPattern} from '../../../packages/core/src/safety';
import {createLog} from '../../../packages/ops/src/log';
import {servePrometheus} from '../../../packages/ops/src/http-metrics';
import { ApiMetrics, routeLabel } from './observability';
import { publicTurn, type OwnerSpace } from './public-turn';
import { DEFAULT_SSE, streamTurn, type SseOptions } from './turn-sse';
import type {CreativeArtifact} from './creative-artifact';
import {createDraftLimiter} from './draft-limiter';
import type {SplitApiRuntime} from './split-runtime';
import {WireContractError,type StartRequest,type Binding,type CompleteRequest} from '../../../contracts/llm/v1/validate';
import { ZodSchemaPipe, WireSchemaPipe } from './schema-pipes';
const RUNTIME=Symbol('API_RUNTIME');
const SSE=Symbol('SSE_OPTIONS');
const DRAFT_LIMIT=Symbol('DRAFT_LIMIT');
const METRICS=Symbol('API_METRICS');
const OPERATOR_MODE=Symbol('OPERATOR_MODE');
const OPERATOR_OPTIONS=Symbol('OPERATOR_OPTIONS');
/** Per-owner draft requests per minute (in-process, every validator configuration): each draft costs up to two safety requests and one model call. */
export const DEFAULT_DRAFTS_PER_OWNER_PER_MINUTE=10;
const sessionSchema=z.object({personId:z.string().trim().min(1).max(200),retrievalMode:RetrievalModeSchema.optional(),ragCondition:RagConditionSchema.optional(),timezone:TimezoneSchema.default('UTC'),executionProfile:ExecutionProfileSchema.default('agent_loop')}).strict();
const sendBodySchema=SendTurnSchema.omit({sessionId:true});
const cancelBodySchema=z.preprocess(value=>!value||typeof value==='object'&&Object.keys(value).length===0?{}:value,z.object({}).strict());
const forbiddenSecret=/\bsk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|(?:api[_-]?key|password)\s*[:=]/i;
const imageUnavailable={status:'separate_runner',code:'IMAGE_RUNNER_ONLY',reason:'이 포스트 초안 요청은 이미지를 제출하지 않습니다. 무료 이미지 생성은 자격을 검증하는 별도 private runner에서 실행하며 완료 결과와 작업 상태를 별도로 기록합니다.'};
/**
 * Owner spaces . The production token (the web proxy) may only name the owner the web derives
 * (apps/web/lib/auth.ts: `local-<40 hex>`); the harness token (PTR_API_SYNTHETIC_TOKEN) only synthetic owners, so
 * load tests and fixtures never share an owner with the web. The token middleware records which space a request has.
 */
const WEB_OWNER=/^local-[a-f0-9]{40}$/;
const SYNTHETIC_OWNER=/^(?:lt-[a-z0-9-]{1,40}|owner_synthetic_[a-z0-9_]{1,40})$/;
const ownerSpace=new WeakMap<Request,OwnerSpace>();
/** Metrics of the app that received the request (set by the token middleware). */
const requestMetrics=new WeakMap<Request,ApiMetrics>();
function owner(request:Request):string {
  const value=request.header('X-PTR-Owner');const space=ownerSpace.get(request);
  if(!value || !space || !(space==='web'?WEB_OWNER:SYNTHETIC_OWNER).test(value)) {
    // `space`: a valid owner of the other token's space ; `format`: no valid owner at all.
    const reason=!value?'missing':WEB_OWNER.test(value)||SYNTHETIC_OWNER.test(value)?'space':'format';
    requestMetrics.get(request)?.ownerRejected.inc({reason});
    throw new HttpException({error:{code:'UNAUTHORIZED'}},403);
  }
  return value;
}
function projectionSpace(request:Request):OwnerSpace {
  const space=ownerSpace.get(request);
  if(!space) throw new HttpException({error:{code:'UNAUTHORIZED'}},403);
  return space;
}
/** These routes previously authorized the owner before parsing their field schemas. */
class RequestOwnerGuard implements CanActivate {
  canActivate(context:ExecutionContext):boolean {owner(context.switchToHttp().getRequest<Request>());return true;}
}
function safeSession(session:ChatSession) { const {ownerId:_,...safe}=session;return safe; }
@Catch()
class SafeErrorFilter implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost) {
    const response=host.switchToHttp().getResponse<Response>();
    // A stream (SSE) that already sent headers can only be closed; writing a JSON error would throw here.
    if(response.headersSent){if(!response.writableEnded)response.end();return;}
    let status=500;let code='INTERNAL_ERROR';
    if(error instanceof CoreError) {
      code=error.code;status=({NOT_FOUND:404,FORBIDDEN:403,TURN_ACTIVE:409,IDEMPOTENCY_CONFLICT:409,INVALID_INPUT:400,TURN_FAILED:502,CONTEXT_LIMIT:409,PERSONA_UNAVAILABLE:404,QUEUE_FULL:503,SEMANTIC_UNAVAILABLE:400} as const)[error.code];
      if(error.code==='QUEUE_FULL') response.setHeader('Retry-After','1');
    } else if(error instanceof WireContractError) {status=400;code='INVALID_INPUT';}
    else if(error instanceof z.ZodError) {status=400;code='INVALID_INPUT';}
    else if(error instanceof HttpException) {
      status=error.getStatus();code=status===403?'UNAUTHORIZED':status===413?'BODY_TOO_LARGE':status===404?'NOT_FOUND':'INVALID_INPUT';
    } else if(error && typeof error==='object' && 'status' in error && (error.status===413 || error.status===400)) {status=error.status;code=status===413?'BODY_TOO_LARGE':'INVALID_INPUT';}
    response.status(status).json({error:{code}});
  }
}
@Controller('api')
class ApiController {
  private readonly drafts=new Set<string>();
  private readonly admitDraft:(owner:string)=>Promise<void>;
  private readonly log=createLog('api');
  constructor(@Inject(RUNTIME) private readonly runtime:SplitApiRuntime,@Inject(SSE) private readonly sse:SseOptions,@Inject(DRAFT_LIMIT) draftLimit:number,
    @Inject(OPERATOR_MODE) private readonly operatorMode:boolean,
    @Inject(OPERATOR_OPTIONS) private readonly operatorOptions:boolean,
    @Inject(METRICS) private readonly metrics:ApiMetrics) {this.admitDraft=createDraftLimiter(draftLimit,runtime.draftLimiterClient?.());}
  /** D23: with a runtime that checks its dependencies, a failed database `SELECT 1` or Redis `PING` (1 s each) answers 503. */
  @Get('health') async health(@Res({passthrough:true}) response:Response) {
    const body={ok:true,service:'persona-timeline-rag',liveEnabled:this.runtime.billable};
    const {database,redis}=await this.runtime.health();
    if(!database||!redis) response.status(503);
    return {...body,ok:database&&redis,checks:{database:database?'ok':'down',redis:redis?'ok':'down'}};
  }
  @Get('livez') livez() {return {ok:true,service:'persona-timeline-rag'};}
  @Get('readyz') readyz(@Res({passthrough:true}) response:Response) {return this.health(response);}
  @Get('personas') async personas(@Req() request:Request) {
    owner(request);
    return {operatorMode:this.operatorMode,personas:(await this.runtime.listPersonas()).map(p=>({id:p.id,personId:p.personId,label:p.label,language:p.language,revision:p.revision,
      ...(p.tagline?{tagline:p.tagline}:{}),...(p.starters?{starters:p.starters}:{}),
      ...(this.operatorMode?{reviewStatus:p.reviewStatus}:{}),aiDisclosure:/^en(?:$|[-_])/i.test(p.language)?`AI character · not the real ${p.label}`:`AI 캐릭터 · 실제 ${p.label} 아님`}))};
  }
  @Get('sessions') async sessions(@Req() request:Request) {return {sessions:(await this.runtime.chat.listSessions(owner(request))).map(safeSession)};}
  @Post('sessions') @UseGuards(RequestOwnerGuard) async createSession(@Req() request:Request,@Body(new ZodSchemaPipe(sessionSchema)) input:z.output<typeof sessionSchema>) {
    const caller=owner(request);
    if(projectionSpace(request)==='web'&&!this.operatorOptions&&(input.ragCondition==='caption_image'||input.executionProfile==='legacy'))
      throw new CoreError('INVALID_INPUT');
    const candidates=(await this.runtime.listPersonas()).filter(p=>p.personId===input.personId);
    if(candidates.length!==1) throw new CoreError('PERSONA_UNAVAILABLE');
    const persona=candidates[0]!;
    const ragCondition=input.ragCondition??(input.retrievalMode==='off'?'off':'caption');
    const retrievalMode=input.retrievalMode??(ragCondition==='off'?'off':'lexical');
    const session=await this.runtime.chat.createSession(caller,{...input,ragCondition,retrievalMode,personaId:persona.id,personaRevision:persona.revision});
    return {session:safeSession(session)};
  }
  @Get('sessions/:id') async session(@Req() request:Request,@Param('id') id:string) {
    const caller=owner(request);return {session:safeSession(await this.runtime.chat.getSession(caller,id)),history:await this.runtime.chat.history(caller,id)};
  }
  @Post('sessions/:id/turns') @UseGuards(RequestOwnerGuard) async send(@Req() request:Request,@Param('id',new ZodSchemaPipe(SendTurnSchema.shape.sessionId)) id:string,@Body(new ZodSchemaPipe(sendBodySchema)) body:z.output<typeof sendBodySchema>) {
    const caller=owner(request);
    if(projectionSpace(request)==='web'&&!this.operatorOptions&&(body.intent!==undefined||body.timeline!==undefined))
      throw new CoreError('INVALID_INPUT');
    const input={...body,sessionId:id};
    if(forbiddenSecret.test(input.text)) throw new CoreError('INVALID_INPUT');
    const {turn,created}=await this.runtime.chat.submitTurn(caller,input);
    if(created) {this.metrics.turnsCreated.inc();this.log('turn_created',{turnId:turn.id});}
    return {turn:publicTurn(turn,projectionSpace(request))};
  }
  @Get('turns/:id') async turn(@Req() request:Request,@Param('id') id:string) {return {turn:publicTurn(await this.runtime.chat.getTurn(owner(request),id),projectionSpace(request))};}
  /** Server-sent events instead of client polling: state notices plus the final public turn. */
  @Get('turns/:id/events') async turnEvents(@Req() request:Request,@Res() response:Response,@Param('id') id:string) {
    this.metrics.sseOpen.inc();response.once('close',()=>{this.metrics.sseOpen.dec();});
    await streamTurn(this.runtime.chat,this.runtime.eventSource,owner(request),id,request,response,this.sse,projectionSpace(request));
  }
  @Post('turns/:id/cancel') async cancel(@Req() request:Request,@Param('id') id:string,@Body(new ZodSchemaPipe(cancelBodySchema)) _body:z.output<typeof cancelBodySchema>) {
    return {cancelled:await this.runtime.chat.cancelTurn(owner(request),id)};
  }
  @Post('sessions/:id/drafts') @UseGuards(RequestOwnerGuard) async draft(@Req() request:Request,@Param('id') id:string,@Body(new ZodSchemaPipe(DraftRequestSchema)) body:z.output<typeof DraftRequestSchema>) {
    const caller=owner(request);const {brief,clientRequestId}=body;
    if(forbiddenSecret.test(brief) || this.runtime.billable&&!clientRequestId) throw new CoreError('INVALID_INPUT');
    const session=await this.runtime.chat.getSession(caller,id);
    await this.admitDraft(caller);
    if(this.drafts.has(id)) throw new CoreError('TURN_ACTIVE');
    this.drafts.add(id);
    const controller=new AbortController();const deadlineAt=Date.now()+30000;
    const timeout=setTimeout(()=>controller.abort(),30000);
    const check=()=>{if(controller.signal.aborted)throw new CoreError('TURN_FAILED');};
    let cancel!:()=>void;
    const cancelled=new Promise<never>((_,reject)=>{cancel=()=>reject(new CoreError('TURN_FAILED'));controller.signal.addEventListener('abort',cancel,{once:true});});
    const run=async()=>{
      const draftId=randomUUID(),result=await this.runtime.draftRemote(session,brief,`draft:${caller}:${clientRequestId??draftId}`,deadlineAt,controller.signal);check();
      if('notice' in result){if(containsCredentialPattern(result.notice.content)||containsInternalPathPattern(result.notice.content))throw new CoreError('TURN_FAILED');return {notice:result.notice,image:imageUnavailable};}
      if(!result.content.trim()||result.content.length>8000||containsCredentialPattern(result.content)||containsInternalPathPattern(result.content))throw new CoreError('TURN_FAILED');
      const artifact:CreativeArtifact={id:draftId,ownerId:caller,personId:session.personId,personaRevision:session.personaRevision,sessionId:id,kind:'post_draft',origin:'generated',fictional:true,status:'draft',content:`[가상 포스트 초안 · AI 생성]\n${result.content}`,promptRevision:'fictional-post-draft-v1',provider:result.provider,model:result.model,createdAt:new Date().toISOString()};
      await this.runtime.saveArtifact(artifact);check();const {ownerId:_,...safeArtifact}=artifact;return {artifact:safeArtifact,image:imageUnavailable};
    };
    try {
      return await Promise.race([run(),cancelled]);
    } catch(error) {if(error instanceof CoreError) throw error;throw new CoreError('TURN_FAILED');}
    finally {clearTimeout(timeout);controller.signal.removeEventListener('abort',cancel);this.drafts.delete(id);}

  }
}
@Controller('internal/llm')
class LlmControlController {
  constructor(@Inject(RUNTIME) private readonly runtime:SplitApiRuntime) {}
  @Post('start') @HttpCode(200) start(@Body(new WireSchemaPipe<StartRequest>('StartRequest')) body:StartRequest) {return this.runtime.control.start(body);}
  @Post('snapshot') @HttpCode(200) snapshot(@Body(new WireSchemaPipe<Binding>('SnapshotRequest')) body:Binding) {return this.runtime.control.snapshot(body);}
  @Post('status') @HttpCode(200) status(@Body(new WireSchemaPipe<Binding>('StatusRequest')) body:Binding) {return this.runtime.control.status(body);}
  @Post('progress') @HttpCode(200) async progress(@Body(new WireSchemaPipe<Binding&{state:'retrieving'|'generating'|'validating'}>('ProgressRequest')) r:Binding&{state:'retrieving'|'generating'|'validating'}) {const runtime=this.runtime;const ack=await runtime.control.progress(r);if(ack.status==='applied')void runtime.events.publish({turnId:r.turnId,state:r.state}).catch(()=>undefined);return ack;}
  @Post('complete') @HttpCode(200) async complete(@Body(new WireSchemaPipe<CompleteRequest>('CompleteRequest')) r:CompleteRequest) {const runtime=this.runtime;const ack=await runtime.control.complete(r);if(ack.status==='applied')void runtime.events.publish({turnId:r.turnId,state:r.result.kind==='completed'?'completed':'failed',...(r.result.kind==='failed'?{errorCode:r.result.errorCode}:{})}).catch(()=>undefined);return ack;}
}
/** `syntheticToken`: the harness token (PTR_API_SYNTHETIC_TOKEN, demo layer); it must differ from the production token. */
export async function createApiApplication(runtime:SplitApiRuntime,token:string,options:{sse?:Partial<SseOptions>;draftsPerOwnerPerMinute?:number;syntheticToken?:string;operatorMode?:boolean;operatorOptions?:boolean}={}):Promise<INestApplication> {
  const draftLimit=options.draftsPerOwnerPerMinute??DEFAULT_DRAFTS_PER_OWNER_PER_MINUTE;
  if(!Number.isInteger(draftLimit)||draftLimit<1) throw new CoreError('INVALID_INPUT');
  const validToken=(value:string)=>value.length>=24 && value.length<=512;
  if(!token || !validToken(token)) throw new CoreError('INVALID_INPUT');
  const synthetic=options.syntheticToken;
  if(synthetic!==undefined && (!validToken(synthetic) || synthetic===token)) throw new CoreError('INVALID_INPUT');
  const metrics=new ApiMetrics();
  class RuntimeLifecycle implements OnApplicationShutdown {
    private closing?:Promise<void>;
    onApplicationShutdown():Promise<void> {return this.closing??=Promise.resolve().then(()=>runtime.close());}
  }
  @Module({controllers:[ApiController,LlmControlController],providers:[{provide:RUNTIME,useValue:runtime},{provide:SSE,useValue:{...DEFAULT_SSE,...options.sse}},{provide:DRAFT_LIMIT,useValue:draftLimit},
    {provide:OPERATOR_MODE,useValue:options.operatorMode===true},{provide:OPERATOR_OPTIONS,useValue:options.operatorOptions===true},{provide:METRICS,useValue:metrics},RuntimeLifecycle]})
  class ApiModule {}
  const app=await NestFactory.create<NestExpressApplication>(ApiModule,{logger:false,bodyParser:false});
  // Token middleware runs before body parsing so unauthenticated input has no effect.
  const digest=(value:string)=>createHash('sha256').update(value).digest();
  const expected=digest(token), expectedSynthetic=synthetic===undefined?undefined:digest(synthetic);
  app.use((request:Request,response:Response,next:NextFunction)=>{
    response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');
    // Requests by route label and status class ; counted when the response ends, any outcome.
    requestMetrics.set(request,metrics);
    const route=routeLabel(request.path);
    response.once('finish',()=>metrics.requests.inc({route,status_class:`${Math.floor(response.statusCode/100)}xx`}));
    // Prometheus text (D18): no token, like /api/health (loopback bind, aggregates only).
    if(request.path==='/metrics/prom') return void servePrometheus(request.method,()=>metrics.render())
      .then(({status,headers,body})=>{response.writeHead(status,headers);response.end(body);});
    if(request.method==='GET' && ['/api/health','/api/livez','/api/readyz'].includes(request.path)) return next();
    const header=request.header('Authorization')??'';
    const supplied=header.startsWith('Bearer ')?header.slice(7):'';
    const hashed=supplied && supplied.length<=512?digest(supplied):undefined;
    if(request.path.startsWith('/internal/llm/')) {
      if(!hashed||!timingSafeEqual(digest(runtime.controlToken),hashed))return response.status(403).json({error:{code:'UNAUTHORIZED'}});
      return next();
    }
    if(hashed && timingSafeEqual(expected,hashed)) ownerSpace.set(request,'web');
    else if(hashed && expectedSynthetic && timingSafeEqual(expectedSynthetic,hashed)) ownerSpace.set(request,'harness');
    else return response.status(403).json({error:{code:'UNAUTHORIZED'}});
    return next();
  });
  const publicParser=json({limit:'16kb'}),internalParser=json({limit:'8mb'});
  // Raw byte admission, before JSON normalization: whitespace counts and public input never gets an 8 MiB parser.
  app.use((request:Request,response:Response,next:NextFunction)=>
    (request.path.startsWith('/internal/llm/')?internalParser:publicParser)(request,response,next));
  app.useGlobalFilters(new SafeErrorFilter());
  await app.init();return app;
}

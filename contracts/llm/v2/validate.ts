import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import schema from './schema.json';
const ajv=new Ajv({strict:true,allErrors:false,coerceTypes:false,removeAdditional:false});
addFormats(ajv);
ajv.addFormat('timezone',{type:'string',validate:(value:string)=>{try {new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}}});
ajv.addKeyword({keyword:'x-maxUtf8Bytes',type:'string',schemaType:'number',validate:(max:number,value:string)=>Buffer.byteLength(value,'utf8')<=max});
ajv.addSchema(schema);
export class WireContractError extends Error {constructor(message='INVALID_WIRE_CONTRACT'){super(message);}}
const validators=new Map<string,ReturnType<typeof ajv.compile>>();
export function validateWire<T=Record<string,unknown>>(name:string,value:unknown):T {
  // JSON wire must not carry JS-only values or non-finite numeric values anywhere.
  const finite=(v:unknown):boolean=>typeof v==='number'?Number.isFinite(v):Array.isArray(v)?v.every(finite):v!==null&&typeof v==='object'?Object.values(v).every(finite):v!==undefined;
  if(value!==null&&typeof value==='object'&&'contractVersion' in value&&(value as {contractVersion:unknown}).contractVersion!==2)throw new WireContractError('WIRE_VERSION_MISMATCH');
  if(!Object.hasOwn(schema.$defs,name)||!finite(value))throw new WireContractError();
  let validate=validators.get(name);if(!validate){validate=ajv.compile({$ref:`urn:ptr:llm:v2#/$defs/${name}`});validators.set(name,validate);}
  if(!validate(value))throw new WireContractError();
  return value as T;
}
export type {StartRequest,Binding,Grant,StartResponse,CompleteRequest,PersonaProjection} from './generated';
export type {Context as TurnContext,Result as ExecutionResult,CompleteResponse as Ack} from './generated';

import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { validateWire } from '../../../contracts/llm/v2/validate';

/** Nest owns parameter validation; existing schemas remain the only field contract. */
export class ZodSchemaPipe<T> implements PipeTransform<unknown,T> {
  constructor(private readonly schema:z.ZodType<T,z.ZodTypeDef,unknown>) {}
  transform(value:unknown):T {return this.schema.parse(value);}
}

export class WireSchemaPipe<T=Record<string,unknown>> implements PipeTransform<unknown,T> {
  constructor(private readonly name:string) {}
  transform(value:unknown):T {return validateWire<T>(this.name,value);}
}

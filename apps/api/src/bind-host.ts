import {CoreError} from '../../../packages/core/src/ports';

/** Local Compose bind remains private; Kubernetes explicitly opts into a pod-wide listener. */
export function apiBindHost(configured:string|undefined):string {
  const host=configured??'127.0.0.1';
  if(host!=='127.0.0.1'&&host!=='0.0.0.0')throw new CoreError('INVALID_INPUT');
  return host;
}

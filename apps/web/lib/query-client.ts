import { QueryClient } from '@tanstack/react-query';
export function createWebQueryClient():QueryClient {
  return new QueryClient({defaultOptions:{queries:{retry:false,staleTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false,refetchInterval:false},mutations:{retry:false,networkMode:'always'}}});
}
export async function clearOwnerQueries(client:QueryClient):Promise<void> {await client.cancelQueries();client.clear();}
/** Reply hydration remains bounded to the latest twenty distinct assistant turns. */
export function replyTurnIds(history:ReadonlyArray<{role:string;turnId:string|null}>):string[] {
  return [...new Set(history.filter(message=>message.role==='assistant'&&message.turnId).map(message=>message.turnId!))].slice(-20);
}

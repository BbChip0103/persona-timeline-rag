import {defer,finalize,firstValueFrom,timeout} from 'rxjs';

/** Native timeout bounds settlement even if work ignores abort; completion always aborts owned resources. */
export function bounded<T>(work:(signal:AbortSignal)=>Promise<T>,milliseconds:number):Promise<T> {
  const controller=new AbortController();
  return firstValueFrom(defer(()=>work(controller.signal)).pipe(
    timeout({first:milliseconds}),finalize(()=>controller.abort()),
  ));
}

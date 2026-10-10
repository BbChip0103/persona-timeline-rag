// Narrow test-only bridge for installed ESM Nest/session dependencies; production loads native ESM.
const ts=require('typescript');
module.exports={process(source,path){return {code:ts.transpileModule(source,{fileName:path,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,sourceMap:true}}).outputText};}};

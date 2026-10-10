import ts from '@typescript-eslint/parser';
import plugin from '@typescript-eslint/eslint-plugin';
export default [{ ignores: ['**/node_modules/**','**/.next/**','**/.next-synthetic/**','**/dist/**','data/**','reports/**'] },{files:['**/*.ts','**/*.tsx'], languageOptions:{parser:ts,parserOptions:{ecmaVersion:2022,sourceType:'module'}},plugins:{'@typescript-eslint':plugin},rules:{'@typescript-eslint/no-explicit-any':'error','@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_',caughtErrorsIgnorePattern:'^_'}]}}];

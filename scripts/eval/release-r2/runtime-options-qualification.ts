import assert from 'node:assert/strict';
import { validateTaskEnvironment } from '../core.ts';
const rows: { name: string; passed: boolean }[] = [];
const check = (name: string, options: Parameters<typeof validateTaskEnvironment>[0], allowed: boolean) => {
  if (allowed) assert.doesNotThrow(() => validateTaskEnvironment(options));
  else assert.throws(() => validateTaskEnvironment(options));
  rows.push({ name, passed: true });
};
check('legacy no options unchanged', {}, true);
check('fixed task build environment', { taskEnv: { NODE_PATH: '/task/node_modules/.pnpm/node_modules', NX_CACHE_DIRECTORY: '/tmp/nx-cache', NX_WORKSPACE_DATA_DIRECTORY: '/tmp/nx-workspace', NX_DAEMON: 'false' } }, true);
check('Nx direct readonly native module', {taskEnv:{NX_SKIP_NATIVE_FILE_CACHE:'true'}}, true);
for(const value of ['false','1','', '/tmp/other'])check('reject altered Nx native policy '+value,{taskEnv:{NX_SKIP_NATIVE_FILE_CACHE:value}},false);
for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','CLAUDE_CONFIG_DIR','NODE_OPTIONS','PATH','HOME','SHELL','LD_PRELOAD','AXI_EVAL_RELAY_IP']) check('reject override '+key,{taskEnv:{[key]:'invalid'}},false);
for (const value of ['line\nbreak','null\0byte',null,7]) check('reject malformed environment '+JSON.stringify(value),{taskEnv:{NODE_PATH:value as string}},false);
for (const mount of ['/task/node_modules/.vitest:rw,nosuid,size=16m,mode=1777','/task/documentation/node_modules/.cache:rw,uid=1000,gid=1000,size=512m']) check('declared cache '+mount,{taskTmpfs:[mount]},true);
for (const mount of ['/task/../node_modules/.cache:rw,uid=1000,gid=1000,size=512m','/opt/axi-c2:rw,size=512m','/task:rw,size=512m','/task/node_modules:rw,size=512m','/task/documentation/node_modules/.cache:rw,uid=0,gid=0,size=512m','/task/node_modules/.vitest:rw,nosuid,size=16000m,mode=1777']) check('reject undeclared mount '+mount,{taskTmpfs:[mount]},false);
console.log(JSON.stringify({developmentCalibration:true,passed:rows.length,rows,limits:'argument admission only; actual Docker and CLI paths still need the full task simulations'},null,2));

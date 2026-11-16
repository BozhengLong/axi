import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// 只影响评测子进程，不改用户的全局工具配置。
export async function verifiedHostEnvironment(study:string){
 const toolchain=JSON.parse(readFileSync(join(study,'toolchain/verification.json'),'utf8'));
 toolchain.env.PATH += ':/Applications/Docker.app/Contents/Resources/bin';
 toolchain.env.PYTHONDONTWRITEBYTECODE='1';
 if(Object.entries(toolchain.env).some(([key,value])=>process.env[key]!==value)){
  assert(process.env.AXI_RELEASE_TOOLCHAIN_APPLIED!=='1','隔离工具链环境未生效');
  const child=Bun.spawn([process.execPath,...process.argv.slice(1)],{env:{...process.env,...toolchain.env,AXI_RELEASE_TOOLCHAIN_APPLIED:'1'},stdin:'inherit',stdout:'inherit',stderr:'inherit'});
  process.exit(await child.exited);
 }
 assert.equal(Bun.version,'1.3.14');
 for(const[name,wanted]of [['node','v22.23.5'],['pnpm','10.34.9']]){const actual=Bun.spawnSync([name!,'--version']);assert.equal(actual.exitCode,0);assert.equal(actual.stdout.toString().trim(),wanted)}
 return toolchain.env;
}

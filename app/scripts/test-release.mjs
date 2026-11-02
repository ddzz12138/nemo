import { run } from 'node:test';
import { readdir, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { APP_ROOT } from '../lib/config.mjs';
import { verifyPreparedNodeRuntime } from './prepare-node-runtime.mjs';
import { verifyHermesBundle } from '../lib/hermes-bundle.mjs';

const require = createRequire(import.meta.url);
await access(require('electron'));
require('playwright');
const runtime = join(APP_ROOT,'.work/desktop-runtime');
const python = join(runtime,'hermes/python/python.exe'), source = join(runtime,'hermes/source');
await access(python); await access(join(source,'tools/mcp_tool_discovery.py'));
await verifyPreparedNodeRuntime(runtime);
const runtimeManifest=JSON.parse(await readFile(join(runtime,'manifest.json'),'utf8'));
await verifyHermesBundle({root:runtime,manifest:runtimeManifest.hermes});
Object.assign(process.env,{NEMO_TEST_PYTHON:python,NEMO_TEST_HERMES_ROOT:source,NEMO_TEST_NATIVE_PYTHON:python,NEMO_TEST_NATIVE_SOURCE:source});
const files=(await readdir(join(APP_ROOT,'test'))).filter(x=>x.endsWith('.test.mjs')).map(x=>join(APP_ROOT,'test',x));
const passed=new Set(),skipped=[],failed=[];
for await(const event of run({files,concurrency:2})) {
  if(event.type==='test:pass') {
    if(event.data.skip)skipped.push(event.data.name);else passed.add(event.data.name);
  }
  if(event.type==='test:fail'){failed.push(event.data.name);console.error(event.data.name+': '+String(event.data.details?.error?.message||'failed').slice(0,1500));}
}
try { await verifyHermesBundle({root:runtime,manifest:runtimeManifest.hermes}); }
catch(error) { failed.push('sealed runtime remains unchanged after the complete suite'); console.error(error.message); }
const mandatory=[
  'real Electron cold restarts restore owner/member chat and saved history; sign-out, revocation and fresh installs stay gated',
  'a Windows version-folder upgrade retains sign-in, chat and protected accounts; expired sign-in never repeats account setup',
  'desktop quit saves sign-in and requires host completion acknowledgement plus clean exit',
  'desktop packaging probes stock PM against its exact selected resources and reverifies sealed bytes',
  'installed Hermes discovers and executes only Nemo read tools through real MCP stdio, using synthetic data',
  'actual bundled Hermes answers through the plan adapter with synthetic OAuth only',
  'actual bundled Hermes executes its exact calendar read through namespaced plan tools and MCP',
  'actual Hermes native memory saves, recalls privately, respects denied memory and shares the UI store',
  'actual Hermes combines its native memory tool with an explicitly permitted calendar read',
  'native Memory HTTP uses the same Hermes files and pins every operation to its signed-in profile',
  'partial native clear reports incomplete and leaves exposed-source cleanup blocked until verified retry',
  'compiled desktop Memory exposes native Forget/Clear without Off or local-engine setup',
  'actual unchanged Hermes gateway exposes native skills and tools in the owner memory workspace',
  'actual unchanged Hermes executes skills, terminal and a subagent through the ChatGPT broker',
  'actual Hermes Stop and forced exit reopen saved conversations without replaying interrupted turns',
  'actual packaged PM routes stock CLI through separate pinned dependencies with isolated imports',
  'full Hermes is local-owner only, rejects arbitrary controls, blocks concurrent normal chat and stops at logout',
  'compiled Hermes workspace shows actual readiness, native approval choices and private masked request controls',
  'bundled assistant inventory stays intact after real plan replies, history resume and tool execution',
  'actual official Node bytes stage alone, preserve other runtime settings, and start without PATH',
  'bundled Node launches the actual private MCP server and reads only a synthetic profile with empty PATH',
];
const unexpectedSkips=skipped.filter(name=>name!=='synthetic keyless brain round trip');
const missing=mandatory.filter(name=>!passed.has(name));
const report={version:1,passed:passed.size,failed,skipped,missing,unexpectedSkips,verified:!failed.length&&!missing.length&&!unexpectedSkips.length};
await mkdir(join(APP_ROOT,'.work/candidate'),{recursive:true});
await writeFile(join(APP_ROOT,'.work/candidate/tests.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
if(!report.verified)throw new Error('Release checks failed, skipped a required test, or did not execute the mandatory native/runtime paths.');

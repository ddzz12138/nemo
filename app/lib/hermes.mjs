import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname, basename } from 'node:path';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { THINKING_WORDS } from './activity.mjs';
import { discoverHermes } from './hermes-runtime.mjs';
import { createChatGPTPlanBroker, chatgptPlanError, CHATGPT_USAGE_URL } from './chatgpt-plan-broker.mjs';
import { createLocalOllamaBroker, checkLocalOllama, localError, LOCAL_OLLAMA } from './local-ollama.mjs';

const guardPath = fileURLToPath(new URL('./hermes_guard.py', import.meta.url));
const cliEntry = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";
export const HERMES_CONNECTION_TOOLS = Object.freeze(['mcp__nemo__calendar_list', 'mcp__nemo__gmail_search', 'mcp__nemo__memory_search']);

// The browser chooses consent, never tool names, executable paths or CLI flags.
export function configureHermesCommand(runtime, useIntegrations = false) {
  if (typeof useIntegrations !== 'boolean') throw new Error('Invalid connection choice.');
  const argv = [...runtime];
  for (const [flag, expected, replacement] of [
    ['--toolsets', 'none', useIntegrations ? 'nemo' : 'none'],
    ['--max-turns', '1', useIntegrations ? '8' : '1'],
  ]) {
    const index = argv.indexOf(flag);
    if (index < 5 || index !== argv.lastIndexOf(flag) || argv[index + 1] !== expected) throw new Error('Hermes CLI tool policy changed.');
    argv[index + 1] = replacement;
  }
  return argv;
}

export function createHermesEventPolicy(useIntegrations = false, { family = false, memoryEnabled = false, childMode, allowedConnectionTools } = {}) {
  const full = [...HERMES_CONNECTION_TOOLS].slice(0, family && !memoryEnabled ? 2 : 3);
  if(allowedConnectionTools!==undefined&&(!family||!Array.isArray(allowedConnectionTools)||new Set(allowedConnectionTools).size!==allowedConnectionTools.length||allowedConnectionTools.some(name=>!full.includes('mcp__nemo__'+name))))throw new Error('A trusted connection tool selection is required.');
  const allowed = useIntegrations ? allowedConnectionTools===undefined?full:full.filter(name=>allowedConnectionTools.includes(name.slice(11))) : [];
  let proof = false;
  let calls = 0;
  const pending = [];
  const seenIds = new Set();
  return {
    get verified() { return proof; },
    get toolCalls() { return calls; },
    observe(event) {
      if (event.type === 'nemo_guard_error') {
        const codes = ['CONNECTION_TOOLS_SHAPE', 'CONNECTION_NAMES_SHAPE', 'CONNECTION_NAMES_CHANGED', 'CONNECTION_API_MODE', 'CONNECTION_SCHEMA_CHANGED', 'CONNECTION_TOOL_COUNT', 'CONNECTION_NON_FUNCTION', 'CONNECTION_UNAPPROVED_TOOL', 'CONNECTION_AMBIGUOUS_SCHEMA', 'CONNECTION_FLAT_SCHEMA', 'CONNECTION_FUNCTION_SCHEMA', 'MCP_REGISTRATION', 'MCP_REGISTRY_SCHEMA', 'MCP_LAUNCH_CONFIGURATION', 'MCP_PROFILE_CONTEXT_MISSING', 'MCP_PROFILE_PATH_MISMATCH', 'MCP_DATA_DIRECTORY', 'MCP_PERMISSION_SELECTION', 'AGENT_INITIALIZATION_FAILED', 'TOOL_POLICY_REJECTED'];
        throw new Error(codes.includes(event.code) ? event.code : 'Hermes tool policy failed.');
      } else if (event.type === 'nemo_guard') {
        if (family && childMode !== undefined && event.learningPolicy !== (childMode ? 'child-v1' : 'standard-v1')) throw new Error('Hermes learning policy could not be verified.');
        if (proof || event.version !== (family ? memoryEnabled ? 4 : 3 : useIntegrations ? 2 : 1) || (family && event.isolated !== true) || event.stage !== 'startup'
          || !Array.isArray(event.tools) || JSON.stringify([...event.tools].sort()) !== JSON.stringify([...allowed].sort())) throw new Error('Hermes tool policy could not be verified.');
        proof = true;
      } else if (event.type === 'nemo_status') {
        if (!proof || Object.keys(event).some(key => !['type','phase','verb'].includes(key)) || !['thinking','idle'].includes(event.phase) || (event.phase === 'thinking' ? ![...THINKING_WORDS,'working'].includes(event.verb) : event.verb !== null)) throw new Error('Invalid agent status.');
      } else if (/^tool(?:_|$)/.test(event.type)) {
        if (!proof || !allowed.includes(event.name)) throw new Error('Unexpected agent tool activity.');
        if (event.type === 'tool_use') {
          if (++calls > 6 || !event.input || typeof event.input !== 'object' || Array.isArray(event.input)) throw new Error('Hermes exceeded its connection tool policy.');
          const id = event.tool_call_id;
          if (id !== undefined && (typeof id !== 'string' || !id || seenIds.has(id))) throw new Error('Invalid tool call identifier.');
          if (id !== undefined) seenIds.add(id);
          pending.push({ name: event.name, id });
        } else if (event.type === 'tool_result') {
          const index = pending.findIndex(call => call.name === event.name && call.id === event.tool_call_id);
          if (index === -1) throw new Error('Unexpected tool result.');
          pending.splice(index, 1);
        } else throw new Error('Unknown agent tool activity.');
      } else if (['text', 'result'].includes(event.type) && !proof) throw new Error('Hermes replied before verifying its tool policy.');
      if (event.type === 'result' && pending.length) throw new Error('Hermes finished with an incomplete tool call.');
    },
  };
}

export function guardRuntimeCommand(argv) {
  if (!Array.isArray(argv) || argv.length < 5 || argv[1] !== '-I' || argv[2] !== '-c'
    || typeof argv[3] !== 'string' || !argv[3].endsWith(cliEntry)
    || argv[3].indexOf(cliEntry) !== argv[3].lastIndexOf(cliEntry)
    || !argv[3].includes('import hermes_bootstrap; ')
    || !argv[3].includes('sys.path.insert(0, ') || argv[4] !== 'chat') {
    throw new Error('Hermes runtime changed. The chat-only guard needs to be reviewed before continuing.');
  }
  const guarded = [...argv];
  // Only our fixed local path becomes Python source. Messages stay on stdin.
  guarded[3] = 'import sys; sys.dont_write_bytecode = True; ' + argv[3].slice(0, -cliEntry.length)
    + `runpy.run_path(${JSON.stringify(guardPath)}, run_name='__main__')`;
  // Set this before interpreter startup: encodings/site initialization happens
  // before our bootstrap can set sys.dont_write_bytecode. Bundle bytes are sealed.
  guarded.splice(1, 0, '-B');
  return guarded;
}

export function parseHermesLine(line) {
  try { const event = JSON.parse(line); return event && typeof event === 'object' && !Array.isArray(event) && typeof event.type === 'string' ? event : null; }
  catch { return null; }
}

export function validateHermesResult(terminal) {
  if (!terminal || terminal.type !== 'result' || terminal.exit_code !== 0 || terminal.error) throw new Error('Hermes could not complete the reply. Check its sign-in and provider availability on the PC.');
  if (typeof terminal.text !== 'string' || ['', '(empty)'].includes(terminal.text.trim())) throw new Error('Hermes returned no text. Try again after checking the PC.');
  if (typeof terminal.session_id !== 'string' || terminal.session_id === 'latest' || !/^[A-Za-z0-9_-]{1,160}$/.test(terminal.session_id)) throw new Error('Hermes returned an invalid conversation identifier.');
  return terminal;
}

export function createHermesProvider({
  launcher = discoverHermes().launcher,
  hermesHome = discoverHermes().hermesHome, hermesPython = '', hermesSource = '',
  cwd = process.cwd(), dataDir = join(cwd, '.nemo'), timeoutMs = 120_000, family = false, profileId, memoryEnabled = false,
  providerKey = '',
  requireChatGPT = false, chatgptSession, chatgptStatus, chatgptFetch = fetch, onChatGPTFailure = () => {},
  localModel = null, localStatus, localFetch = fetch,
  nodeExecutable = process.execPath,
} = {}) {
  if (typeof requireChatGPT !== 'boolean' || requireChatGPT && (providerKey || typeof chatgptSession !== 'function')) throw new Error('Nemo needs its ChatGPT plan connection before chatting.');
  if (localModel && (requireChatGPT || providerKey || localModel.origin !== LOCAL_OLLAMA.origin || localModel.model !== LOCAL_OLLAMA.model || localModel.context !== LOCAL_OLLAMA.context)) throw new Error('Choose the supported local Gemma assistant in Nemo setup.');
  if (providerKey && (typeof providerKey !== 'string' || providerKey.length < 16 || providerKey.length > 4096 || /[\r\n\0]/.test(providerKey))) throw new Error('The assistant account could not be unlocked. Connect it again in Nemo setup.');
  if (typeof nodeExecutable !== 'string' || !isAbsolute(nodeExecutable) || /[\r\n\0]/.test(nodeExecutable)) throw new Error('Nemo needs to repair its connected tools. Reinstall the app.');
  let model = localModel ? LOCAL_OLLAMA.model : '';
  let verified = false;
  let runtimePromise;
  const commonArgs = ['chat', '--query-file', '-', '--format', 'stream-json', '--toolsets', 'none', '--ignore-rules', '--max-turns', '1', '--source', 'tool', '--no-restore-cwd', '--run-budget', '90'];
  if (providerKey) commonArgs.push('--provider', 'openrouter', '--model', 'openrouter/auto');
  // A desktop plan connection cannot inherit an unrelated API key, proxy,
  // credential source or fallback route from the developer's environment.
  const systemEnvironment = requireChatGPT || localModel ? Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:SYSTEMROOT|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|LANG|LC_ALL)$/i.test(key))) : process.env;
  const env = { ...systemEnvironment, HERMES_HOME: hermesHome, HERMES_DISABLE_LAZY_INSTALLS: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', NO_COLOR: '1' };
  if (requireChatGPT || localModel) Object.assign(env, { HOME: hermesHome, USERPROFILE: hermesHome, APPDATA: hermesHome, LOCALAPPDATA: hermesHome, HERMES_NO_AUTO_INSTALL: '1' });
  if (providerKey) env.OPENROUTER_API_KEY = providerKey;
  for (const key of Object.keys(env)) if (key.startsWith('HERMES_KANBAN_')) delete env[key];
  delete env.HERMES_YOLO_MODE;
  for (const key of Object.keys(env)) if (key.startsWith('NEMO_MCP_') || key === 'NEMO_HERMES_MODE') delete env[key];
  delete env.NEMO_CHILD_POLICY;
  for (const key of Object.keys(env)) if (key.startsWith('NEMO_LOCAL_') || key.startsWith('NEMO_CHATGPT_PLAN_')) delete env[key];

  function resolveRuntime() {
    if (runtimePromise) return runtimePromise;
    if (hermesPython || hermesSource) {
      if (!hermesPython || !hermesSource || !existsSync(hermesPython) || !existsSync(join(hermesSource,'hermes_bootstrap.py'))) return Promise.reject(new Error('Configure a compatible Hermes Python executable and source directory.'));
      const bootstrap = `import os, sys, runpy; sys.path.insert(0, ${JSON.stringify(resolve(hermesSource))}); import hermes_bootstrap; ${cliEntry}`;
      return Promise.resolve(guardRuntimeCommand([hermesPython, '-I', '-c', bootstrap, ...commonArgs]));
    }
    runtimePromise = new Promise((resolve, reject) => {
      // The launcher path is administrator configuration, never a browser field.
      // Only fixed arguments reach cmd.exe. User text goes to Python stdin later.
      if (!existsSync(launcher) || /["\r\n%&|<>^]/.test(launcher)) return reject(new Error('Hermes launcher is unavailable or invalid.'));
      const child = process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `""${launcher}" --print-runtime-command ${commonArgs.join(' ')}"`], { cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(launcher, ['--print-runtime-command', ...commonArgs], { cwd, env, shell: false, stdio:['ignore','pipe','pipe'] });
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Hermes startup timed out.')); }, 20_000);
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 1_000_000) child.kill(); });
      child.stderr.resume();
      child.on('error', () => { clearTimeout(timer); reject(new Error('Hermes could not be started on this PC.')); });
      child.on('close', code => {
        clearTimeout(timer);
        try {
          const argv = JSON.parse(output.trim());
          if (code !== 0 || !Array.isArray(argv) || argv.length < 3 || !argv.every(arg => typeof arg === 'string') || !existsSync(argv[0])) throw new Error();
          resolve(guardRuntimeCommand(argv));
        } catch { reject(new Error('Hermes runtime could not be resolved. Check the launcher on this PC.')); }
      });
    }).catch(error => { runtimePromise = null; throw error; });
    return runtimePromise;
  }

  return {
    name: 'Hermes',
    status: () => {
      const installed = (hermesPython && hermesSource) ? existsSync(hermesPython) && existsSync(join(hermesSource,'hermes_bootstrap.py')) : existsSync(launcher);
      const plan = requireChatGPT ? chatgptStatus?.() : null;
      return { connected: installed && (localModel ? localStatus?.().connected !== false : !requireChatGPT || plan?.connected === true && plan?.planUsageEnabled === true), verified, model, mode: 'chat-with-optional-readonly-mcp',
        inference: localModel ? 'Using local Gemma 4 12B' : requireChatGPT ? 'Using ChatGPT plan' : 'Configured Hermes subscription provider',
        ...(localModel ? { inferenceProvider: 'ollama', localOnly: true, contextLength: LOCAL_OLLAMA.context } : {}),
        ...(requireChatGPT ? { inferenceProvider: 'chatgpt', planUsageEnabled: plan?.planUsageEnabled === true && plan?.connected === true, manageUsageUrl: CHATGPT_USAGE_URL } : {}) };
    },
    async checkRuntime() { await resolveRuntime(); return { ready: true }; },
    async run({ message, sessionId, useIntegrations = false, childMode = false, allowedConnectionTools, permissionRevision, workflowOutput = null, onText = () => {}, onTool = () => {}, onActivity = () => {}, onPolicyError = () => {}, signal }) {
      if (workflowOutput !== null && (!localModel || workflowOutput !== 'school-notice-v1' || useIntegrations || sessionId)) throw new Error('This checked workflow requires a fresh local Gemma session without tools.');
      if (typeof childMode !== 'boolean' || (childMode && !family)) throw new Error('A trusted family learning policy is required.');
      try {
      if (signal?.aborted) throw new Error('Request stopped.');
      const planSession = requireChatGPT ? await chatgptSession() : null;
      if (requireChatGPT && !planSession) throw chatgptPlanError('CHATGPT_SIGN_IN_REQUIRED');
      const argv = configureHermesCommand(await resolveRuntime(), useIntegrations);
      const runEnv = { ...env, NEMO_HERMES_MODE: useIntegrations ? 'connections' : 'chat-only' };
      const policy = createHermesEventPolicy(useIntegrations, { family, memoryEnabled, childMode, allowedConnectionTools });
      if (family) {
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(profileId || '')) throw new Error('A trusted profile is required for this reply.');
        runEnv.NEMO_MCP_POLICY = 'family';
        runEnv.NEMO_CHILD_POLICY = childMode ? 'child-v1' : 'standard-v1';
        if (memoryEnabled) runEnv.NEMO_MCP_MEMORY = 'profile';
        runEnv.NEMO_MCP_PROFILE_ID = profileId;
        runEnv.NEMO_MCP_CONFIG_DIR = resolve(dataDir, '..', '..');
      }
      if (useIntegrations) {
        if(allowedConnectionTools!==undefined){if(!allowedConnectionTools.length)throw new Error('No connection tools are enabled for this profile.');runEnv.NEMO_MCP_ALLOWED_TOOLS=JSON.stringify(allowedConnectionTools);}
        if(permissionRevision!==undefined){if(!family||typeof permissionRevision!=='string'||!/^\d+:\d+:(?:true|false)$/.test(permissionRevision))throw new Error('Invalid profile permission revision.');runEnv.NEMO_MCP_PERMISSION_REVISION=permissionRevision;}
        if (sessionId) throw new Error('Connection requests must use a fresh Hermes session.');
        runEnv.NEMO_MCP_COMMAND = nodeExecutable;
        runEnv.NEMO_MCP_SERVER = fileURLToPath(new URL('../mcp-server.mjs', import.meta.url));
        runEnv.NEMO_MCP_DATA_DIR = resolve(dataDir);
      }
      if (signal?.aborted) throw new Error('Request stopped.');
      if (sessionId) {
        if (sessionId === 'latest' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw new Error('Saved Hermes session is invalid.');
        argv.push('--resume', sessionId);
      }
      let broker, child;
      if (requireChatGPT) {
        const session = planSession;
        model = session.model;
        const allowed = useIntegrations ? [...HERMES_CONNECTION_TOOLS].slice(0, family && !memoryEnabled ? 2 : 3).filter(name => allowedConnectionTools === undefined || allowedConnectionTools.includes(name.slice(11))) : [];
        broker = await createChatGPTPlanBroker({ session, allowedTools: allowed, fetchImpl: chatgptFetch, signal, onFailure: () => child?.kill() });
        // The fixed local alias avoids Hermes guessing a different provider or
        // wire protocol from a cloud model's name. Only the broker sees the real model.
        argv.push('--provider', 'custom', '--model', broker.model);
        Object.assign(runEnv, { OPENAI_BASE_URL: broker.baseUrl, OPENAI_API_KEY: broker.capability,
          NEMO_CHATGPT_PLAN_BROKER: broker.baseUrl, NEMO_CHATGPT_PLAN_CAPABILITY: broker.capability });
      } else if (localModel) {
        const readiness = await checkLocalOllama({ fetchImpl: localFetch, signal });
        if (!readiness.connected) throw localError(readiness.code);
        const allowed = useIntegrations ? [...HERMES_CONNECTION_TOOLS].slice(0, family && !memoryEnabled ? 2 : 3).filter(name => allowedConnectionTools === undefined || allowedConnectionTools.includes(name.slice(11))) : [];
        broker = await createLocalOllamaBroker({ allowedTools: allowed, fetchImpl: localFetch, signal, structuredOutput: workflowOutput });
        argv.push('--provider', 'custom', '--model', broker.model);
        Object.assign(runEnv, { OPENAI_BASE_URL: broker.baseUrl, OPENAI_API_KEY: broker.capability,
          NEMO_LOCAL_MODEL_BROKER: broker.baseUrl, NEMO_LOCAL_MODEL_CAPABILITY: broker.capability });
      }
      let transientHome;
      try {
        if (workflowOutput) {
          // Source text must not enter the family's ordinary Hermes transcript.
          // This source-only extraction has no session resume or agent tools.
          await mkdir(dataDir, { recursive: true });
          transientHome = await mkdtemp(join(dataDir, '.notice-runtime-'));
          Object.assign(runEnv, { HERMES_HOME: transientHome, HOME: transientHome, USERPROFILE: transientHome, APPDATA: transientHome, LOCALAPPDATA: transientHome });
        }
        return await new Promise((resolve, reject) => {
        child = spawn(argv[0], argv.slice(1), { cwd, env: runEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let terminal = null;
        let characters = 0;
        let sawTool = false;
        let activityCall = 0;
        const activityPending = [];
        const activity = value => { try { onActivity(value); } catch { /* Progress observers cannot stop the agent. */ } };
        let stopped = false;
        const stop = () => { stopped = true; child.kill(); };
        const timer = setTimeout(stop, timeoutMs);
        signal?.addEventListener('abort', stop, { once: true });
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        child.stderr.resume(); // Never forward provider diagnostics or credentials to the phone.
        lines.on('line', line => {
          characters += line.length;
          if (characters > 2_000_000) return stop();
          const event = parseHermesLine(line);
          if (!event) return;
          try { policy.observe(event); } catch (error) {
            // Only static policy reasons/shape flags reach a trusted diagnostic
            // callback, never provider stderr, tool arguments, results or text.
            onPolicyError({ reason: error.message, hasGuard: policy.verified,
              eventType: ['nemo_guard', 'nemo_guard_error', 'text', 'result', 'tool_use', 'tool_result'].includes(event.type) ? event.type : 'other',
              ...(event.type === 'nemo_guard' ? { version: event.version, startup: event.stage === 'startup', permittedNames: Array.isArray(event.tools) && event.tools.every(name => HERMES_CONNECTION_TOOLS.includes(name)), toolCount: Array.isArray(event.tools) ? event.tools.length : -1 } : {}) });
            sawTool = true; stop(); return;
          }
          if (!requireChatGPT && !localModel && event.type === 'system' && typeof event.model === 'string') model = event.model.slice(0, 100);
          if (event.type === 'nemo_status') activity({ kind:'thinking', state:event.phase === 'thinking' ? 'running' : 'completed', verb:event.verb });
          if (event.type === 'tool_use') {
            const key = `call-${++activityCall}`;
            activityPending.push({ key, name:event.name, id:event.tool_call_id });
            activity({ kind:'tool', state:'running', name:event.name, key });
            onTool({ name: event.name });
          }
          if (event.type === 'tool_result') {
            const index = activityPending.findIndex(call => call.name === event.name && call.id === event.tool_call_id);
            const call = activityPending.splice(index,1)[0];
            let failed = event.is_error === true;
            // Inspect only a bounded error envelope; raw contents never escape.
            try { let result=event.output; for(let i=0;i<2&&typeof result==='string'&&result.length<10_000;i++)result=JSON.parse(result); if(result&&typeof result==='object'&&(result.connected===false||typeof result.error==='string'&&result.error))failed=true; } catch {}
            if(call)activity({ kind:'tool', state:failed?'failed':'completed', name:call.name, key:call.key });
          }
          if (event.type === 'text' && typeof event.text === 'string') {
            activity({ kind:'answer', state:'running' });
            onText(event.text);
          }
          if (event.type === 'result') terminal = event;
        });
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); lines.close(); };
        child.on('error', () => { cleanup(); reject(new Error('Hermes could not run. Start Nemo from your normal PC terminal.')); });
        child.stdin.on('error', () => {});
        child.on('close', code => {
          cleanup();
          if (broker?.error) return reject(broker.error);
          if (sawTool) return reject(new Error('Hermes activity did not match Nemo\'s allowed tool policy. Check the PC.'));
          if (stopped) return reject(new Error('Hermes took too long or the request was stopped. Check the PC and try again.'));
          if (!policy.verified) return reject(new Error('Hermes could not verify its tool policy. Check the PC.'));
          if (code !== 0) return reject(new Error('Hermes could not complete the reply. Check its sign-in and provider availability on the PC.'));
          try { validateHermesResult(terminal); } catch (error) { return reject(error); }
          verified = true;
          resolve({ text: terminal.text, sessionId: terminal.session_id, model, toolCalls: policy.toolCalls });
        });
        child.stdin.end(message, 'utf8');
      }); } finally {
        try { await broker?.close(); }
        finally { if (transientHome) try {
          const actual = await realpath(transientHome), parent = await realpath(dataDir);
          const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
          if (!same(dirname(actual), parent) || !basename(actual).startsWith('.notice-runtime-')) throw new Error();
          await rm(actual, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
        } catch { throw new Error('The temporary notice runtime could not be safely removed. Check Nemo on the PC.'); } }
      }
      } catch (error) {
        if (requireChatGPT && ['CHATGPT_USAGE_LIMIT', 'CHATGPT_SIGN_IN_REQUIRED', 'CHATGPT_NOT_ELIGIBLE', 'CHATGPT_UNAVAILABLE'].includes(error?.code)) {
          let timer;
          try {
            await Promise.race([Promise.resolve().then(() => onChatGPTFailure(error.code)), new Promise(resolve => { timer = setTimeout(resolve, 2_000); timer.unref?.(); })]);
          } catch { /* A recovery-state observer cannot replace the safe inference error. */ }
          finally { clearTimeout(timer); }
        }
        throw error;
      }
    },
  };
}

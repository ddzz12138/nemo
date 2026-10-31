import { basename, isAbsolute } from 'node:path';

export function signingOptions(env = process.env) {
  if (env.NEMO_REQUIRE_SIGNING !== '1') return null;
  if (!isAbsolute(env.NEMO_SIGN_CERTIFICATE_FILE || '') || !env.NEMO_SIGN_CERTIFICATE_PASSWORD || !/^[a-f0-9]{40}$/i.test(env.NEMO_SIGN_EXPECTED_THUMBPRINT || '')) throw new Error('Trusted publisher signing credentials and expected certificate identity are required.');
  return { certificateFile: env.NEMO_SIGN_CERTIFICATE_FILE, certificatePassword: env.NEMO_SIGN_CERTIFICATE_PASSWORD, hashes: ['sha256'], debug: false };
}

export async function signOwnedWindowsFiles(files, { env = process.env, sign } = {}) {
  const options = signingOptions(env);
  if (!options) return { signed: false, diagnosticBuild: true };
  if (!Array.isArray(files) || !files.length || files.some(file => !isAbsolute(file) || !['Nemo.exe', 'NemoSetup.exe'].includes(basename(file)))) throw new Error('Only the Nemo application and final installer may be transformed by this signing stage.');
  const signer = sign || (await import('@electron/windows-sign')).sign;
  await signer({ ...options, files });
  return { signed: true, files: files.length };
}

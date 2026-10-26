import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { fonts, validateFont, prepareFonts } from '../scripts/prepare-fonts.mjs';
import { fileURLToPath } from 'node:url';
import { resolve, join, dirname, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const docs = join(root, 'docs');
const pages = ['index.html', 'how-it-works.html', 'about.html'];
const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim();
const load = path => readFile(path, 'utf8');
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const ids = html => [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const htmls = new Map(await Promise.all(pages.map(async page => [page, await load(join(docs, page))])));

// Check actual relative references, including cross-page fragments, under /nemo/.
async function linkErrors(directory, files) {
  const errors = [];
  for (const file of files) {
    const html = await load(join(directory, file));
    for (const [, raw] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const url = new URL(raw.replaceAll('&amp;', '&'), `https://nemo.test/nemo/${file}`);
      if (url.origin !== 'https://nemo.test') {
        if (!['https:', 'mailto:'].includes(url.protocol)) errors.push(`${file}: unsafe link ${raw}`);
        continue;
      }
      if (!url.pathname.startsWith('/nemo/')) { errors.push(`${file}: escapes /nemo/: ${raw}`); continue; }
      let target = decodeURIComponent(url.pathname.slice('/nemo/'.length));
      if (!target || target.endsWith('/')) target += 'index.html';
      const local = resolve(directory, target);
      if (!local.startsWith(resolve(directory) + sep)) {
        errors.push(`${file}: escapes docs: ${raw}`); continue;
      }
      try {
        await access(local);
        if (url.hash && target.endsWith('.html')) {
          const targetIds = ids(await load(local));
          if (!targetIds.includes(decodeURIComponent(url.hash.slice(1)))) errors.push(`${file}: missing anchor ${raw}`);
        }
      } catch { errors.push(`${file}: missing file ${raw}`); }
    }
  }
  return errors;
}

test('all page/asset links and cross-page anchors resolve under the Pages prefix', async () => {
  assert.deepEqual(await linkErrors(docs, pages), []);
});

test('every documented Node preview/check command is available in a fresh clone', async () => {
  const readme = await load(join(root, 'README.md'));
  const commands = [...readme.matchAll(/^node (?:--test |--check )?([^\s]+\.m?js)\r?$/gm)];
  assert.ok(commands.length >= 4, 'documented setup and verification commands');
  for (const [, file] of commands) await access(join(root, file));
});

test('all three pages use one release identity for the shared CSS, script and icon', () => {
  for (const [page, html] of htmls) {
    for (const asset of ['styles.css', 'app.js', 'assets/nemo-icon.svg']) {
      assert.ok(html.includes(`${asset}?v=${version}`), `${page}: mismatched ${asset}`);
    }
    assert.equal(new Set(ids(html)).size, ids(html).length, `${page}: duplicate IDs`);
  }
});

test('the existing Home anchors and legacy initial/hash-change routes remain', async () => {
  const home = htmls.get('index.html');
  for (const id of ['main', 'possibilities', 'everyday', 'family', 'memory', 'start']) assert.ok(ids(home).includes(id), id);
  const script = await load(join(docs, 'app.js'));
  assert.ok(script.includes("['#how-it-works', 'how-it-works.html']"));
  assert.ok(script.includes("['#questions', 'about.html#questions']"));
  assert.ok(script.includes("window.addEventListener('hashchange', followLegacyLink)"));
});

test('the complete accessible hero is delivered in HTML, before enhancement', () => {
  const home = htmls.get('index.html');
  const figure = home.match(/<figure class="product-figure">([\s\S]*?)<\/figure>/)?.[1];
  assert.ok(figure, 'hero figure');
  assert.ok(figure.includes('id="hero-transcript"'));
  assert.ok(figure.includes('Dan asks: School update?'));
  assert.ok(figure.includes('class="reply" id="reply"'));
  assert.ok(figure.includes('Return the trip form <strong>by Friday.</strong>'));
  assert.ok(figure.includes('Pack the PE kit <strong>for Monday.</strong>'));
  assert.ok(!figure.includes('reply-shell-hidden'));
  assert.ok(!/<(?:input|textarea|button|form)\b/.test(figure), 'phone controls stay inert');
  assert.ok(!/hero-controls|id="(?:finish|replay)"|aria-live/.test(home), 'decorative looping needs no manual controls or repeated live announcements');
  assert.ok(home.includes('<span class="sr-only">For everyone</span>'));
  assert.ok(home.includes('Illustrative sequence. Gmail and memory need their own setup.'));
});

test('the approved setup sequence and all four disclosure answers are preserved', () => {
  const how = htmls.get('how-it-works.html');
  assert.equal((how.match(/<details>/g) || []).length, 4);
  for (const sentence of [
    'Make your space. Prepare the included assistant.',
    'Use an eligible ChatGPT plan. No API key in this flow.',
    'Chat on your computer. Return to your saved history.',
    'The current flow uses Windows and an eligible ChatGPT plan. Your plan’s usage limits and credit settings apply. Public distribution still needs release verification.',
    'These are optional and need their own connection or dependency setup. The core desktop setup does not automatically connect every service.',
    'Once the hosted connection is configured and verified, Nemo can issue a personal invitation. Phone access needs the home computer awake and online.',
    'Your chats and personal data are hosted on your computer. The connected AI provider receives the conversation context and permitted tool results needed to answer.',
  ]) assert.ok(text(how).includes(sentence), sentence);
});

test('Home keeps the agreed examples and product limits', () => {
  const home = text(htmls.get('index.html'));
  for (const phrase of [
    'Future vision', 'Saturday, 11–1.', 'Each person chooses what to share.',
    'Child mode', 'What have you tried?', 'Parent-set tools. Visible parent review.',
    'Prefers quiet walks', 'Training for a 10K', 'Loves space · Child mode',
    'Only actions. Deadlines first. Remember that.', 'You control what’s remembered.',
  ]) assert.ok(home.includes(phrase), phrase);
});

test('About retains the fair Hermes comparison, five rows and native FAQs', () => {
  const about = htmls.get('about.html');
  assert.equal((about.match(/<details(?:\s|>)/g) || []).length, 5);
  const body = about.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
  assert.equal((body?.match(/<tr>/g) || []).length, 5);
  for (const phrase of [
    'Hermes on its own', 'Hermes through Nemo', 'The same agent, with a family experience around it.',
    'Hermes has its own interfaces and memory.', 'Nous Research',
    'Nemo does not yet bring every Hermes tool into the family app.',
    'Calendar, Gmail and memory each retain their own setup requirements.',
  ]) assert.ok(text(about).includes(phrase), phrase);
});

test('all pages retain canonical/social metadata, preview limits and the family closing', async () => {
  for (const [page, html] of htmls) {
    const canonical = page === 'index.html' ? '' : page;
    assert.ok(html.includes(`rel="canonical" href="https://ddzz12138.github.io/nemo/${canonical}"`));
    assert.ok(html.includes('property="og:image"'));
    assert.ok(html.includes('name="twitter:card"'));
    for (const phrase of [
      'Built with Hermes. Made for Family.',
      'Windows development preview. Public downloads are being prepared.',
      'Connected AI providers receive context for replies.',
    ]) assert.ok(text(html).includes(phrase), `${page}: ${phrase}`);
  }
  await access(join(docs, '.nojekyll'));
  const sitemap = await load(join(docs, 'sitemap.xml'));
  for (const route of ['', 'how-it-works.html', 'about.html']) assert.ok(sitemap.includes(`https://ddzz12138.github.io/nemo/${route}`));
});

test('two unmodified local WOFF2 weights resolve with matching release URLs', async () => {
  const css = await load(join(docs, 'styles.css'));
  let total = 0;
  for (const [name, size] of [['regular', 21880], ['medium', 21744]]) {
    assert.ok(css.includes(`assets/fonts/ranade-${name}.woff2?v=${version}`));
    const font = await readFile(join(docs, `assets/fonts/ranade-${name}.woff2`));
    validateFont(font, fonts.find(item => item.file === `ranade-${name}.woff2`));
    assert.equal(font.toString('ascii', 0, 4), 'wOF2');
    assert.equal(font.length, size, 'official font bytes must not be modified/subsetted');
    total += font.length;
  }
  assert.equal(total, 43624);
  assert.ok(!css.includes('base64,'));
  assert.ok(!/url\(['"]?(?:https?:)?\/\//.test(css), 'fonts must not make runtime third-party requests');
  const notice = await load(join(docs, 'assets/fonts/README.md'));
  assert.ok(notice.includes('https://www.fontshare.com/licenses/itf-ffl'));
  assert.ok(notice.includes('not to Ranade'));
});

async function temporaryFontDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'nemo-website-font-'));
  try { await run(directory); }
  finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('nemo-website-font-'));
    await rm(directory, { recursive: true });
  }
}

test('font preparation reuses verified bytes without contacting a third party', async () => {
  await temporaryFontDirectory(async directory => {
    for (const font of fonts) await writeFile(join(directory, font.file), await readFile(join(docs, 'assets/fonts', font.file)));
    await prepareFonts({ directory, download: () => { throw new Error('Unexpected network request'); } });
    assert.equal((await readdir(directory)).length, 2);
  });
});

test('corrupt, wrong-format or modified fonts fail exact verification', async () => {
  const official = await readFile(join(docs, 'assets/fonts', fonts[0].file));
  const altered = Buffer.from(official);
  altered[altered.length - 1] ^= 1;
  assert.throws(() => validateFont(altered, fonts[0]), /verification failed/);
  assert.throws(() => validateFont(Buffer.from('not a font'), fonts[0]), /verification failed/);
});

test('failed or invalid downloads never leave a publishable font or temporary file', async () => {
  await temporaryFontDirectory(async directory => {
    await assert.rejects(prepareFonts({ directory, download: async () => new Response('', { status: 503 }) }), /download failed/);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(prepareFonts({ directory, download: async () => new Response('invalid bytes') }), /verification failed/);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(prepareFonts({ directory, download: async () => { throw new Error('simulated timeout'); } }), /simulated timeout/);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('public executable assets have no real tool, model, private-server or telemetry calls', async () => {
  const script = await load(join(docs, 'app.js'));
  assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/.test(script));
  for (const html of htmls.values()) assert.ok(!/https?:\/\/(?:localhost|127\.0\.0\.1)|\.nemo\//.test(html));
});

test('link checker rejects missing assets, broken anchors and root-relative deployment mistakes', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'nemo-website-check-'));
  try {
    await writeFile(join(fixture, 'index.html'), '<a href="about.html#absent">About</a><link href="missing.css"><a href="/assets/site.css">Bad base</a>');
    await writeFile(join(fixture, 'about.html'), '<h1 id="present">About</h1>');
    const errors = await linkErrors(fixture, ['index.html']);
    assert.ok(errors.some(error => error.includes('missing anchor')));
    assert.ok(errors.some(error => error.includes('missing file')));
    assert.ok(errors.some(error => error.includes('escapes /nemo/')));
  } finally {
    // Verify the exact temporary target before recursive cleanup on Windows.
    assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
    assert.ok(basename(fixture).startsWith('nemo-website-check-'));
    await rm(fixture, { recursive: true });
  }
});

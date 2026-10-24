// Fictional page-local illustrations. No accounts, AI requests, or persistence.
const chapters = [...document.querySelectorAll('[data-chapter]')];
const holder = document.querySelector('#sticky-holder');
let activeChapter = 'plans';
function refreshPhone() {
  const phone = document.querySelector(`[data-chapter="${activeChapter}"] .chapter-phone`);
  holder.replaceChildren(phone.cloneNode(true));
}
function showChapter(key) {
  if (!chapters.some(chapter => chapter.dataset.chapter === key)) return;
  activeChapter = key;
  chapters.forEach(chapter => chapter.classList.toggle('is-active', chapter.dataset.chapter === key));
  document.querySelectorAll('[data-story-link]').forEach(link => {
    if (link.dataset.storyLink === key) link.setAttribute('aria-current', 'step');
    else link.removeAttribute('aria-current');
  });
  refreshPhone();
}
let scrollPending = false;
function followScroll() {
  let next = chapters[0].dataset.chapter;
  const readingLine = window.innerHeight * .42;
  for (const chapter of chapters) {
    if (chapter.getBoundingClientRect().top <= readingLine) next = chapter.dataset.chapter;
  }
  if (next !== activeChapter) showChapter(next);
  scrollPending = false;
}
window.addEventListener('scroll', () => {
  if (!scrollPending) { scrollPending = true; requestAnimationFrame(followScroll); }
}, { passive: true });
window.addEventListener('resize', followScroll);
chapters.forEach(chapter => chapter.addEventListener('focusin', () => showChapter(chapter.dataset.chapter)));
showChapter('plans');
document.documentElement.classList.add('js');
followScroll();

const connections = [...document.querySelectorAll('[data-connection]')];
const plansPhone = document.querySelector('[data-chapter="plans"] .chapter-phone');
connections.forEach(button => button.addEventListener('click', () => {
  button.setAttribute('aria-checked', String(button.getAttribute('aria-checked') !== 'true'));
  const calendar = document.querySelector('[data-connection="calendar"]').getAttribute('aria-checked') === 'true';
  const gmail = document.querySelector('[data-connection="gmail"]').getAttribute('aria-checked') === 'true';
  document.querySelector('.calendar-slip').classList.toggle('source-off', !calendar);
  document.querySelector('.mail-slip').classList.toggle('source-off', !gmail);
  const reply = calendar && gmail
    ? '<p>The museum trip starts at <strong>9 am</strong>.</p><p>Pack a <strong>raincoat</strong> and a <strong>nut-free lunch</strong>.</p>'
    : calendar ? '<p>The museum trip starts at <strong>9 am</strong>.</p><p>Gmail is off, so I can’t check the school’s packing list.</p>'
    : gmail ? '<p>The school asks for a <strong>raincoat</strong> and a <strong>nut-free lunch</strong>.</p><p>Calendar is off, so I can’t check the start time.</p>'
    : '<p>Calendar and Gmail are off.</p><p>You choose what Nemo can use in Settings.</p>';
  plansPhone.querySelector('[data-plan-reply]').innerHTML = reply;
  plansPhone.querySelector('.tool-note').textContent = calendar && gmail ? 'Calendar + Gmail · Read only'
    : calendar ? 'Calendar · Read only' : gmail ? 'Gmail · Read only' : 'No connected tools';
  plansPhone.querySelector('.reply-source').textContent = calendar && gmail ? 'From your calendar & the school email'
    : calendar ? 'From your calendar' : gmail ? 'From the school email' : 'Just a conversation. Your choice.';
  refreshPhone();
}));

const learningQuestions = {
  curiosity: { question: 'Why do paper planes fly?', reply: '<p>The wings push air down, and the air pushes the plane up.</p><p>Try changing the wings. Which shape flies farther?</p>' },
  homework: { question: 'Do my homework for me: ¾ + ⅛.', reply: '<p>Let’s figure it out together.</p><p>Start with eighths. If you cut each quarter in half, how many eighths make three quarters?</p>' }
};
document.querySelectorAll('[data-learning]').forEach(button => button.addEventListener('click', () => {
  const example = learningQuestions[button.dataset.learning];
  document.querySelectorAll('[data-learning]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  document.querySelector('[data-learning-question]').textContent = example.question;
  document.querySelector('[data-learning-reply]').innerHTML = example.reply;
  showChapter('learning');
}));

const memoryFact = document.querySelector('#memory-fact');
const memoryForm = document.querySelector('#memory-form');
const memoryEmpty = document.querySelector('#memory-empty');
const preference = document.querySelector('#food-preference');
const factValue = document.querySelector('#fact-value');
const memoryStatus = document.querySelector('#memory-status');
const editMemory = document.querySelector('#edit-memory');
function updateDinner() {
  const dinner = document.querySelector('[data-dinner-reply]');
  if (!memoryEmpty.hidden) {
    dinner.innerHTML = '<p>Quick pasta or a rice bowl?</p><p>Any food preferences I should know about?</p>';
  } else if (factValue.textContent === 'Pescatarian') {
    dinner.innerHTML = '<p>How about a <strong>salmon rice bowl</strong>?</p><p>Pescatarian. A few ingredients. Dinner in about 20 minutes.</p>';
  } else {
    dinner.innerHTML = '<p>How about <strong>chickpea pasta</strong>?</p><p>Vegetarian. A few ingredients. Dinner in about 20 minutes.</p>';
  }
  document.querySelector('[data-chapter="memory"] .tool-note').textContent = memoryEmpty.hidden ? 'Using Maya’s saved preference' : 'No saved food preference';
  profiles.maya.two = memoryEmpty.hidden ? `${factValue.textContent}. Learning Italian.` : 'Learning Italian.';
  if (document.querySelector('[data-profile="maya"]').getAttribute('aria-selected') === 'true') {
    document.querySelector('#profile-detail-two').textContent = profiles.maya.two;
  }
  refreshPhone();
}
editMemory.addEventListener('click', () => {
  preference.value = factValue.textContent;
  memoryFact.hidden = true;
  memoryForm.hidden = false;
  preference.focus();
});
function closeEditor() {
  memoryForm.hidden = true;
  memoryFact.hidden = false;
  editMemory.focus();
}
memoryForm.addEventListener('submit', event => {
  event.preventDefault();
  factValue.textContent = preference.value;
  memoryStatus.textContent = 'Demo fact changed. Watch the dinner idea change too.';
  updateDinner();
  closeEditor();
});
document.querySelector('#cancel-edit').addEventListener('click', closeEditor);
memoryForm.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeEditor(); } });
document.querySelector('#forget-memory').addEventListener('click', () => {
  memoryFact.hidden = true;
  memoryEmpty.hidden = false;
  memoryStatus.textContent = 'Demo fact forgotten. Nemo asks instead of assuming.';
  updateDinner();
  document.querySelector('#undo-memory').focus();
});
document.querySelector('#undo-memory').addEventListener('click', () => {
  memoryEmpty.hidden = true;
  memoryFact.hidden = false;
  memoryStatus.textContent = 'Demo fact restored. Nothing is saved outside this page.';
  updateDinner();
  editMemory.focus();
});

const profiles = {
  maya: { name: 'Maya', status: 'Private profile', labelOne: 'Calendar', one: 'Tomorrow’s museum trip', labelTwo: 'Memory', two: 'Vegetarian. Learning Italian.', note: 'Only Maya’s personal context.' },
  alex: { name: 'Alex', status: 'Private profile', labelOne: 'Calendar', one: 'Sunday morning run', labelTwo: 'Memory', two: 'Growing herbs on the balcony.', note: 'Only Alex’s personal context.' },
  jamie: { name: 'Jamie', status: 'Child mode', labelOne: 'Learning', one: 'Hints, questions, little discoveries.', labelTwo: 'Parent controls', two: 'Parent-set tools. Visible review.', note: 'Parent review is visible to Jamie.' }
};
const profileTabs = [...document.querySelectorAll('[data-profile]')];
function selectProfile(key, moveFocus = false) {
  const profile = profiles[key];
  if (!profile) return;
  profileTabs.forEach(tab => {
    const selected = tab.dataset.profile === key;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && moveFocus) tab.focus();
  });
  document.querySelector('#profile-panel').setAttribute('aria-labelledby', `profile-${key}`);
  document.querySelector('#profile-name').textContent = `${profile.name}’s space`;
  document.querySelector('#profile-status').textContent = profile.status;
  document.querySelector('#profile-label-one').textContent = profile.labelOne;
  document.querySelector('#profile-detail-one').textContent = profile.one;
  document.querySelector('#profile-label-two').textContent = profile.labelTwo;
  document.querySelector('#profile-detail-two').textContent = profile.two;
  document.querySelector('#profile-note').textContent = profile.note;
}
profileTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectProfile(tab.dataset.profile));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % profileTabs.length;
    else if (event.key === 'ArrowLeft') next = (index + profileTabs.length - 1) % profileTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = profileTabs.length - 1;
    else return;
    event.preventDefault(); selectProfile(profileTabs[next].dataset.profile, true);
  });
});
const menu = document.querySelector('.menu-toggle');
const nav = document.querySelector('#main-nav');
function closeMenu() { menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-label', 'Open navigation'); nav.classList.remove('is-open'); }
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  nav.classList.toggle('is-open', open);
});
nav.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') { closeMenu(); menu.focus(); } });
document.addEventListener('click', event => { if (!event.target.closest('.site-header')) closeMenu(); });

// Fictional examples stay in this page. No server or account connections.
const icon = name => `<svg aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const examples = {
  day: {
    person: 'Maya', avatar: 'sage',
    source: `<div class="source-label">${icon('calendar')} Maya’s calendar</div><div class="source-card"><div class="source-card-header"><span class="calendar-date">Today</span><span>2 plans</span></div><div class="event"><time>3:30 pm</time><div><strong>School pickup</strong><small>North gate</small></div></div><div class="event"><time>6:00 pm</time><div><strong>Pilates</strong><small>Neighbourhood studio</small></div></div></div><p class="source-caption">The day, at a glance.</p>`,
    content: `<div class="demo-user"><p class="demo-bubble">What’s on this afternoon?</p></div><span class="tool-label">${icon('calendar')} Read your calendar</span><div class="demo-response"><div class="reply-event"><time>3:30</time><span>School pickup, north gate.</span></div><div class="reply-event"><time>6:00</time><span>Pilates at the studio.</span></div><p>A little breathing room in between.</p></div>`
  },
  mail: {
    person: 'Maya', avatar: 'sage',
    source: `<div class="source-label">${icon('mail')} Maya’s Gmail</div><div class="source-card email-preview"><span class="email-from">School office → Maya</span><h3>Friday’s museum trip</h3><p>Please pack a <span class="email-highlight">raincoat</span> and a <span class="email-highlight">nut-free lunch</span>.</p></div><p class="source-caption">That detail, found.</p>`,
    content: `<div class="demo-user"><p class="demo-bubble">What does Jamie need for the school trip?</p></div><span class="tool-label">${icon('mail')} Searched your Gmail</span><div class="demo-response"><p>A <strong>raincoat</strong> and a <strong>nut-free lunch</strong>, according to the school’s email.</p></div>`
  },
  child: {
    person: 'Jamie', avatar: 'lilac',
    source: `<div class="source-label">${icon('memory')} A little help learning</div><div class="pizza-lesson"><h3>¾ + ⅛ = ?</h3><div class="pizza" role="img" aria-label="A pizza with three quarters shaded, divided into eight equal slices"><span class="pizza-grid"></span></div><p>Same pizza.<br> Smaller slices.</p></div><p class="source-caption">More “I figured it out.”</p>`,
    content: `<div class="demo-user"><p class="demo-bubble">Do this homework for me: ¾ + ⅛.</p></div><span class="tool-label">${icon('lock')} Child mode · hints, not shortcuts</span><div class="demo-response"><p>Let’s try it together. Cut each quarter in half.</p><p>How many eighths are in the shaded part?</p></div>`
  }
};
const tabs = [...document.querySelectorAll('[data-demo]')];
function selectExample(key, moveFocus = false) {
  const example = examples[key];
  if (!example) return;
  tabs.forEach(tab => {
    const selected = tab.dataset.demo === key;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && moveFocus) tab.focus();
  });
  const panel = document.querySelector('#demo-panel');
  panel.dataset.current = key;
  panel.setAttribute('aria-labelledby', `tab-${key}`);
  document.querySelector('#demo-source').innerHTML = example.source;
  document.querySelector('#demo-person').textContent = example.person;
  const avatar = document.querySelector('#demo-avatar');
  avatar.textContent = example.person[0];
  avatar.className = `avatar ${example.avatar}`;
  document.querySelector('#demo-content').innerHTML = example.content;
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectExample(tab.dataset.demo));
  tab.addEventListener('keydown', event => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectExample(tabs[next].dataset.demo, true);
  });
});
selectExample('day');
const memoryFact = document.querySelector('#memory-fact');
const memoryForm = document.querySelector('#memory-form');
const memoryEmpty = document.querySelector('#memory-empty');
const foodPreference = document.querySelector('#food-preference');
const factValue = document.querySelector('#fact-value');
const memoryStatus = document.querySelector('#memory-status');
const editMemory = document.querySelector('#edit-memory');
editMemory.addEventListener('click', () => {
  foodPreference.value = factValue.textContent;
  memoryFact.hidden = true;
  memoryForm.hidden = false;
  foodPreference.focus();
});
function closeMemoryEditor() {
  memoryForm.hidden = true;
  memoryFact.hidden = false;
  editMemory.focus();
}
memoryForm.addEventListener('submit', event => {
  event.preventDefault();
  factValue.textContent = foodPreference.value;
  memoryStatus.textContent = 'Demo fact changed. Nothing is saved outside this page.';
  closeMemoryEditor();
});
document.querySelector('#cancel-edit').addEventListener('click', closeMemoryEditor);
memoryForm.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeMemoryEditor(); }
});
document.querySelector('#forget-memory').addEventListener('click', () => {
  memoryFact.hidden = true;
  memoryEmpty.hidden = false;
  memoryStatus.textContent = 'Demo fact forgotten. Undo brings it back.';
  document.querySelector('#undo-memory').focus();
});
document.querySelector('#undo-memory').addEventListener('click', () => {
  memoryEmpty.hidden = true;
  memoryFact.hidden = false;
  memoryStatus.textContent = 'Demo fact restored. Nothing is saved outside this page.';
  editMemory.focus();
});
const connections = [...document.querySelectorAll('[data-connection]')];
connections.forEach(button => button.addEventListener('click', () => {
  button.setAttribute('aria-checked', String(button.getAttribute('aria-checked') !== 'true'));
  const [calendar, gmail] = connections.map(item => item.getAttribute('aria-checked') === 'true');
  const result = calendar && gmail ? 'Calendar and Gmail are available.'
    : calendar ? 'Calendar is available. Gmail stays off.'
    : gmail ? 'Gmail is available. Calendar stays off.'
    : 'Both are off. Just a conversation.';
  document.querySelector('#connection-result').textContent = result;
}));
const menu = document.querySelector('.menu-toggle');
const nav = document.querySelector('#main-nav');
function closeMenu() {
  menu.setAttribute('aria-expanded', 'false');
  menu.setAttribute('aria-label', 'Open navigation');
  nav.classList.remove('is-open');
}
menu.addEventListener('click', () => {
  const expanded = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(expanded));
  menu.setAttribute('aria-label', expanded ? 'Close navigation' : 'Open navigation');
  nav.classList.toggle('is-open', expanded);
});
nav.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
    closeMenu(); menu.focus();
  }
});
document.addEventListener('click', event => { if (!event.target.closest('.site-header')) closeMenu(); });

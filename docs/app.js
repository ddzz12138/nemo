const examples = {
  day: {
    number: '01 / EVERYDAY HELP', heading: 'A little less<br>“what was that again?”',
    description: 'Ask about your afternoon. Find that email. Nemo uses the connections you’ve enabled to help you put the pieces together.',
    tags: ['Calendar', 'Gmail'], note: 'The useful kind of AI.', person: 'Maya', initial: 'M', avatar: 'avatar-sage',
    content: '<div class="demo-user"><p class="demo-bubble">What’s on this afternoon?</p></div><div class="demo-activity"><span class="small-dot"></span> Read calendar · 2 events</div><div class="demo-response"><p>A little breathing room before a busy evening.</p><div class="calendar-item"><time>3:30 PM</time><div><strong>Pick up the garden order</strong><small>Willow nursery</small></div></div><div class="calendar-item"><time>6:00 PM</time><div><strong>Dinner with Alex</strong><small>The little place on Olive Street</small></div></div><p>The nursery closes at 5. You’ve got time.</p></div>'
  },
  memory: {
    number: '02 / A LITTLE CONTEXT', heading: 'Start with<br>“you know me.”',
    description: 'The details you’ve shared can make the next conversation feel more familiar. Open Memory whenever you want to see, edit, or delete what’s saved.',
    tags: ['Personal memory', 'Editable'], note: 'Familiar, not a mystery.', person: 'Alex', initial: 'A', avatar: 'avatar-peach',
    content: '<h4 class="mini-memory-title">A few things about Alex.</h4><div class="mini-fact"><span>↗</span> Learning to grow herbs on the balcony.</div><div class="mini-fact"><span>☀</span> Enjoys a long walk on Sunday mornings.</div><div class="mini-fact"><span>⌁</span> Likes recipes with simple ingredients.</div><p class="mini-memory-note">Your memory belongs to your profile.<br>You can read, edit, and delete the details.</p>'
  },
  child: {
    number: '03 / GROWING MINDS', heading: 'A nudge toward<br>“I figured it out.”',
    description: 'Big questions are welcome. For homework, child mode offers hints and explanations to help children learn, with tools and review managed by parents.',
    tags: ['Child mode', 'Guided learning'], note: 'Keep the curiosity.', person: 'Jamie', initial: 'J', avatar: 'avatar-lavender',
    content: '<div class="demo-user"><p class="demo-bubble">Do this homework for me: what’s 3/4 + 1/8?</p></div><div class="demo-activity"><span class="small-dot"></span> Child mode · learning together</div><div class="demo-response"><p>Let’s work it out together. Imagine a pizza cut into 8 equal slices.</p><p style="margin-top:9px">Three quarters of the pizza is the same as how many eighths?</p><div class="hint-card">A little hint: if you cut each quarter in half, each piece becomes an eighth. Try drawing it.</div></div>'
  }
};

const tabs = [...document.querySelectorAll('[data-demo]')];
function selectExample(key, moveFocus = false) {
  const example = examples[key];
  if (!example) return;
  tabs.forEach(tab => {
    const selected = tab.dataset.demo === key;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && moveFocus) tab.focus();
  });
  document.querySelector('#demo-panel').dataset.current = key;
  document.querySelector('#demo-panel').setAttribute('aria-labelledby', `tab-${key}`);
  document.querySelector('#demo-number').textContent = example.number;
  document.querySelector('#demo-heading').innerHTML = example.heading.replaceAll('<br>', ' <br>');
  document.querySelector('#demo-description').textContent = example.description;
  document.querySelector('#demo-tags').replaceChildren(...example.tags.map(text => {
    const tag = document.createElement('span'); tag.textContent = text; return tag;
  }));
  document.querySelector('#demo-hand-note').textContent = `${example.note} ↗`;
  document.querySelector('#demo-person').textContent = example.person;
  const avatar = document.querySelector('#demo-avatar');
  avatar.textContent = example.initial;
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
    event.preventDefault(); selectExample(tabs[next].dataset.demo, true);
  });
});
selectExample('day');

const menu = document.querySelector('.menu-toggle');
const nav = document.querySelector('#main-nav');
function closeMenu() { menu.setAttribute('aria-expanded', 'false'); menu.setAttribute('aria-label', 'Open navigation'); nav.classList.remove('is-open'); }
menu.addEventListener('click', () => {
  const expanded = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(expanded));
  menu.setAttribute('aria-label', expanded ? 'Close navigation' : 'Open navigation');
  nav.classList.toggle('is-open', expanded);
});
nav.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') { closeMenu(); menu.focus(); } });
document.addEventListener('click', event => { if (!event.target.closest('.site-header')) closeMenu(); });

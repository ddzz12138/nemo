/* One navigation for every Nemo page. Account and source actions keep their
   existing handlers; this module only moves their entry points. */
(() => {
  'use strict';
  const page = document.body;
  page.classList.add('nemo-page');
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function button(text, label) {
    const node = make('button', text, 'nemo-nav-button');
    node.type = 'button'; node.dataset.nemoControl = '';
    if (label) node.setAttribute('aria-label', label);
    return node;
  }
  const header = document.querySelector('[data-nemo-header]') || make('header');
  header.className = 'nemo-header';
  const menuButton = button('', 'Open menu');
  menuButton.classList.add('nemo-menu-button');
  const mark = make('span', '', 'nemo-menu-mark'); mark.setAttribute('aria-hidden', 'true'); menuButton.append(mark);
  const brand = make('a', 'nemo', 'nemo-wordmark'); brand.href = '/'; brand.setAttribute('aria-label', 'Nemo chat');
  const profileButton = button('', 'Profile and settings'); profileButton.classList.add('nemo-profile-button');
  const name = make('span', 'Profile'); name.dataset.profileName = ''; profileButton.append(name);
  header.replaceChildren(menuButton, brand, profileButton);
  if (!header.isConnected) page.prepend(header);

  function panel(id, label, className) {
    const dialog = make('dialog', '', `nemo-panel ${className}`); dialog.id = id;
    dialog.setAttribute('aria-labelledby', `${id}Title`);
    const top = make('div', '', 'nemo-panel-top');
    const title = make('h2', label); title.id = `${id}Title`;
    const close = button('×', `Close ${label.toLowerCase()}`); close.classList.add('nemo-panel-close');
    top.append(title, close); dialog.append(top); page.append(dialog);
    let opener;
    function shut() { if (dialog.open) dialog.close(); }
    close.addEventListener('click', shut);
    dialog.addEventListener('close', () => { if (!document.querySelector('dialog[open]') && opener?.isConnected) opener.focus({ preventScroll: true }); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) shut();
    });
    return { dialog, shut, open(from) { opener = from; if (!dialog.open) dialog.showModal(); close.focus({ preventScroll: true }); } };
  }
  const menu = panel('nemoMenu', 'nemo', 'nemo-drawer');
  const profile = panel('nemoProfile', 'Your profile', 'nemo-profile-panel');
  menuButton.setAttribute('aria-haspopup', 'dialog'); menuButton.setAttribute('aria-controls', menu.dialog.id);
  profileButton.setAttribute('aria-haspopup', 'dialog'); profileButton.setAttribute('aria-controls', profile.dialog.id);
  const shut = () => { menu.shut(); profile.shut(); };
  menuButton.addEventListener('click', () => { profile.shut(); menu.open(menuButton); });
  profileButton.addEventListener('click', () => { menu.shut(); profile.open(profileButton); });
  const canonicalPath = path => {const value=path.replace(/\.html$/,'');return value==='/index'?'/':value;};
  const activePath = canonicalPath(location.pathname);
  function link(text, href, parent) {
    const node = make('a', text, 'nemo-nav-link'); node.href = href;
    if (canonicalPath(href) === activePath) node.setAttribute('aria-current', 'page');
    node.addEventListener('click', shut); parent.append(node); return node;
  }
  const nav = make('nav', '', 'nemo-primary-nav'); nav.setAttribute('aria-label', 'Main navigation'); menu.dialog.append(nav);
  for (const [text, href] of [['Chat', '/'], ['History', '/history.html'], ['Tasks', '/tasks.html'], ['Reminders', '/leave.html']]) link(text, href, nav);
  const extras = make('div', '', 'nemo-nav-section'); menu.dialog.append(extras);
  const accounts = document.getElementById('integrationsButton');
  if (accounts) {
    accounts.className = 'nemo-nav-link'; accounts.dataset.nemoControl = '';
    accounts.addEventListener('click', shut); extras.append(accounts);
  } else link('Connected accounts', '/#accounts', extras);
  link('Tools & setup help', '/tools.html', extras);
  const menuProfile = button('Profile & settings'); menuProfile.className = 'nemo-nav-link';
  menuProfile.addEventListener('click', () => { menu.shut(); profile.open(profileButton); }); extras.append(menuProfile);

  function group(label) {
    const section = make('section', '', 'nemo-nav-section'); section.append(make('h3', label)); profile.dialog.append(section); return section;
  }
  const personal = group('Your space');
  const identity = make('p', 'Profile', 'nemo-profile-name'); identity.dataset.profileName = ''; personal.append(identity);
  const child = make('p', 'Child mode is on', 'nemo-nav-note'); child.dataset.childMode = ''; child.hidden = true; personal.append(child);
  link('Profile, family & devices', '/family.html', personal);
  if(!window.NemoPhoneLink?.enabled) link('Passkeys & sign-in', '/passkeys.html', personal);
  link('Switch person', window.NemoPhoneLink?.enabled ? '/phone-start.html?switch=1' : '/sign-in.html', personal);
  const connected = group('Accounts');
  if (accounts) {
    const shortcut = button('Connected accounts'); shortcut.className = 'nemo-nav-link';
    shortcut.addEventListener('click', () => { shut(); accounts.click(); }); connected.append(shortcut);
  } else link('Connected accounts', '/#accounts', connected);
  const computer = document.getElementById('connectionButton');
  if (computer) {
    computer.dataset.nemoControl = ''; computer.classList.add('nemo-nav-link');
    computer.addEventListener('click', shut);
    const row = make('div', '', 'nemo-computer-row'); row.append(make('span', 'Computer connection'), computer); connected.append(row);
  } else link('Computer connection', '/#connection', connected);
  const usage = link('ChatGPT usage ↗', 'https://chatgpt.com/settings/usage', connected); usage.target = '_blank'; usage.rel = 'noopener noreferrer';
  connected.append(make('p', 'Connect or change your ChatGPT account in Nemo on your computer.', 'nemo-nav-note'));
  const help = group('Help'); link('Phone setup & connection help', '/setup.html', help); link('Tools & availability', '/tools.html', help);
  link(window.NemoPhoneLink?.enabled ? 'Phone connection' : 'Set up phone access', window.NemoPhoneLink?.enabled ? '/phone-start.html' : '/phone-access.html', help);
  if(window.NemoPhoneLink?.enabled){const note=make('p','Connecting to the host…','nemo-nav-note');connected.append(note);window.addEventListener('nemo-phone-state',event=>{const value=event.detail;note.textContent=({direct:'Connected directly to your host.',relayed:'Connected through an encrypted relay.',connected:'Connected to your host.',reconnecting:'Reconnecting. Saved tasks remain on the host.',paused:'Connection paused while Nemo is in the background.',unavailable:'Host connection unavailable. Keep the host awake; this network may need a relay.'})[value.state]||'Connecting to your host…';});}
  const memory = window.NemoIdentity;
  function refreshName() {
    const current = memory?.profile;
    for (const node of [name, identity]) node.textContent = current?.name || 'Profile';
    child.hidden = !current?.childMode;
  }
  refreshName();
  // Pages that already load /api/session own their initial identity request.
  // Other controllers share Identity.load(), avoiding competing public reads.
  if (!['/', '/pair', '/passkeys', '/sign-in'].includes(activePath)) {
    void memory?.load().then(refreshName).catch(() => {});
  }
  // Closing a page drops open overlays; browser restoration reloads identity.
  window.addEventListener('pagehide', shut);
})();

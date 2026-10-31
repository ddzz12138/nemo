// Adapted from Ollama SidebarLayout, MIT. See ../UPSTREAM.md and the shipped notice.
import React, { useEffect, useRef, useState } from 'react';
export function SidebarLayout({ sidebar, title, children, profile, sidebarFooter }) {
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 760px)').matches);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 759px)').matches);
  const toggle = useRef(null);
  const closeSidebar = () => { setSidebarOpen(false); toggle.current?.focus(); };
  useEffect(() => {
    const media = window.matchMedia('(max-width: 759px)');
    const changed = () => { setNarrow(media.matches); setSidebarOpen(!media.matches); };
    media.addEventListener('change', changed); return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    const escape = event => { if (event.key === 'Escape' && sidebarOpen && narrow) { event.preventDefault(); closeSidebar(); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [sidebarOpen, narrow]);
  return <div className={`desktop-shell ${sidebarOpen ? 'sidebar-open' : ''}`}>
    <div className="sidebar-controls"><button ref={toggle} className="icon-button" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} aria-expanded={sidebarOpen} aria-controls="desktop-sidebar" title="Toggle sidebar">
      <svg width="21" height="18" viewBox="0 0 24 19" fill="currentColor" aria-hidden="true"><path d="M7.76132 16.6344H9.58103V1.59842H7.76132V16.6344ZM4.20898 18.2316H19.124C21.6518 18.2316 23.1293 16.6963 23.1293 14.0209V4.2205C23.1293 1.54512 21.6518 0.00351715 19.124 0.00351715H4.20898C1.54336 0.00351715 0 1.54512 0 4.2205V14.0209C0 16.6963 1.54336 18.2316 4.20898 18.2316ZM4.31191 16.3184C2.79628 16.3184 1.91327 15.4434 1.91327 13.926V4.31542C1.91327 2.79979 2.79628 1.91678 4.31191 1.91678H18.8174C20.333 1.91678 21.216 2.79979 21.216 4.31542V13.926C21.216 15.4434 20.333 16.3184 18.8174 16.3184H4.31191Z" /></svg>
    </button></div>
    <aside id="desktop-sidebar" className="desktop-sidebar" inert={!sidebarOpen} aria-label="Your Nemo space" onClick={event => { if (narrow && event.target.closest('a,button')) closeSidebar(); }}><div className="sidebar-wordmark">nemo<span>.</span></div>{sidebar}<div className="sidebar-footer">{sidebarFooter}</div></aside>
    {sidebarOpen && narrow && <button className="sidebar-backdrop" aria-label="Close sidebar" onClick={closeSidebar} />}
    <main className="desktop-main" inert={narrow && sidebarOpen}><header className="desktop-topbar"><h1>{title}</h1>{profile && <span className="person-label"><span className="person-avatar" aria-hidden="true">{profile.name?.slice(0, 1)}</span>{profile.name}{profile.childMode && <span className="child-label">Child mode</span>}</span>}</header>{children}</main>
  </div>;
}

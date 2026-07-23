// Responsive layout manager. Sets data-layout (wide|narrow) + data-orient on
// <html>; on narrow screens the tool sidebars become bottom sheets toggled by a
// floating button, so the viewer/timeline own the screen. Panels don't know the
// screen size — CSS reacts to the attributes.
export function initLayout() {
  const root = document.documentElement;
  // touch UI only when the PRIMARY pointer is coarse (phone/tablet). A device
  // that ALSO has a fine pointer — Chromebook with trackpad, iPad with Magic
  // Keyboard — keeps the compact desktop controls (ChromeOS convertibles often
  // report coarse as primary even in clamshell). Exception: phone-sized
  // screens always get the touch UI, so a stylus phone (S Pen) isn't demoted.
  const coarse = matchMedia('(pointer: coarse)').matches;
  const anyFine = matchMedia('(any-pointer: fine)').matches;
  const touch = coarse && (!anyFine || Math.min(window.innerWidth, window.innerHeight) < 560);
  root.toggleAttribute('data-touch', touch);
  // running as an installed PWA?
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  root.toggleAttribute('data-standalone', standalone);
  const apply = () => {
    const w = window.innerWidth, h = window.innerHeight;
    const short = Math.min(w, h);
    // Big tablets (short side >= 700 CSS px — iPad Air/Pro class) get the full
    // desktop layout with docked panels even in portrait; data-touch keeps the
    // fat touch sliders inside it. The docked layout fits from ~760px width.
    const tabletWide = touch && short >= 700 && w >= 760;
    // Phones in LANDSCAPE are often >= 900 CSS px wide, which would wrongly pick
    // the desktop layout. Treat any touch device whose SHORTER side is phone-sized
    // (< 560) as narrow too, so phone landscape gets the mobile split screen.
    const narrow = !tabletWide && (w < 900 || (touch && short < 560));
    root.setAttribute('data-layout', narrow ? 'narrow' : 'wide');
    root.setAttribute('data-orient', window.innerHeight >= window.innerWidth ? 'portrait' : 'landscape');
    if (!narrow) closeSheet();
    // keep the stage push-up in sync if the sheet is open through a rotate/resize
    const open = document.querySelector('.sheet-open');
    if (open) requestAnimationFrame(() => { const h = open.getBoundingClientRect().height; if (h > 0) root.style.setProperty('--sheet-h', Math.round(h) + 'px'); });
  };
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);

  const fab = document.getElementById('sheetFab');
  const drawerBtn = document.getElementById('drawerBtn');
  const scrim = document.getElementById('sheetScrim');
  if (fab) fab.onclick = () => toggleSheet();
  if (drawerBtn) drawerBtn.onclick = () => toggleSheet();
  const mediaDrawerBtn = document.getElementById('mediaDrawerBtn');
  if (mediaDrawerBtn) mediaDrawerBtn.onclick = () => toggleSheet();
  if (scrim) scrim.onclick = () => closeSheet();
  // close the sheet when switching tabs
  document.querySelectorAll('.main-tab').forEach((b) => b.addEventListener('click', () => closeSheet()));
}

function activeTab() { return document.querySelector('.tab-panel.active'); }
function toolSidebar() { const t = activeTab(); return t ? (t.querySelector('.side') || t.querySelector('.side-r')) : null; }

// show a sidebar as a sheet + push the stage up so the viewer stays visible
// above it (CSS reads --sheet-h + the sheet-shown class on <html>)
function showSheet(sb) {
  sb.classList.add('sheet-open');
  document.getElementById('sheetScrim')?.classList.add('show');
  const root = document.documentElement;
  root.classList.add('sheet-shown');
  requestAnimationFrame(() => {
    const h = sb.getBoundingClientRect().height;
    if (h > 0) root.style.setProperty('--sheet-h', Math.round(h) + 'px');
  });
}

export function toggleSheet() {
  const sb = toolSidebar(); if (!sb) return;
  const open = !sb.classList.contains('sheet-open');
  closeSheet();
  if (open) showSheet(sb);
}
export function closeSheet() {
  document.querySelectorAll('.sheet-open').forEach((s) => s.classList.remove('sheet-open'));
  document.getElementById('sheetScrim')?.classList.remove('show');
  document.documentElement.classList.remove('sheet-shown');
}
export function isNarrow() { return document.documentElement.getAttribute('data-layout') === 'narrow'; }
// open a specific sidebar as a sheet (e.g. the inspector on clip select)
export function openSheet(sb) {
  if (!sb || !isNarrow()) return;
  closeSheet();
  showSheet(sb);
}

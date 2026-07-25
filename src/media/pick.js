// Cross-platform media picker.
//  · Desktop / Chrome OS: File System Access `showOpenFilePicker` — a real file
//    browser, and returns handles we can persist to re-link later.
//  · Android Chrome & the rest: a plain <input> with EXPLICIT extensions. This
//    matters — `accept="video/*"` alone routes Android to the Photos/gallery
//    app, hiding the Downloads folder; listing extensions forces the system
//    Documents picker where Downloads is reachable.
export const handleMap = new WeakMap(); // File -> FileSystemFileHandle (when available)
export const pathMap = new WeakMap();   // File -> relative path (folder import)

const EXTS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mts', '.m2ts', '.3gp', '.hevc', '.mcraw'];
const ACCEPT = 'video/*,image/*,' + EXTS.join(',');

export async function pickMedia() {
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        excludeAcceptAllOption: false,
        types: [{ description: 'Video & image', accept: { 'video/*': EXTS, 'image/*': ['.jpg', '.jpeg', '.png', '.webp'] } }],
      });
      const files = [];
      for (const h of handles) { const f = await h.getFile(); handleMap.set(f, h); files.push(f); }
      return files;
    } catch (e) {
      if (e && e.name === 'AbortError') return [];
      // otherwise fall through to the input fallback
    }
  }
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.accept = ACCEPT;
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.onchange = () => { resolve([...inp.files]); inp.remove(); };
    // if the user cancels there is no event; clean up on next focus
    window.addEventListener('focus', () => setTimeout(() => { if (inp.isConnected && !inp.files.length) { resolve([]); inp.remove(); } }, 400), { once: true });
    inp.click();
  });
}

// Import a whole folder, preserving each file's relative path (for the bin tree).
export async function pickFolder() {
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker();
      const files = [];
      await walk(dir, '', files);
      return files;
    } catch (e) { if (e && e.name === 'AbortError') return []; }
  }
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    try { inp.webkitdirectory = true; } catch {}
    inp.style.display = 'none'; document.body.appendChild(inp);
    inp.onchange = () => { const fs = [...inp.files]; for (const f of fs) if (f.webkitRelativePath) pathMap.set(f, f.webkitRelativePath); resolve(fs); inp.remove(); };
    window.addEventListener('focus', () => setTimeout(() => { if (inp.isConnected && !inp.files.length) { resolve([]); inp.remove(); } }, 400), { once: true });
    inp.click();
  });
}
async function walk(dir, prefix, out) {
  for await (const [name, handle] of dir.entries()) {
    const p = prefix ? prefix + '/' + name : name;
    if (handle.kind === 'file') { const f = await handle.getFile(); handleMap.set(f, handle); pathMap.set(f, p); out.push(f); }
    else if (handle.kind === 'directory') await walk(handle, p, out);
  }
}

// accepts drag-dropped files too
export function isMediaFile(file) {
  return file.type.startsWith('video') || file.type.startsWith('image') ||
    new RegExp('(' + EXTS.map((e) => '\\' + e).join('|') + ')$', 'i').test(file.name);
}

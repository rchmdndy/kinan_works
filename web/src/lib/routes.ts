export type Route =
  | { page: 'devices' | 'new' | 'exports' }
  | { page: 'detail' | 'edit' | 'realtime' | 'credential'; id: string };

export function parseHashRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (path[0] === 'devices' && path[1] === 'new') return { page: 'new' };
  if (path[0] === 'devices' && path[1]) {
    const id = decodeURIComponent(path[1]);
    if (path[2] === 'edit') return { page: 'edit', id };
    if (path[2] === 'realtime') return { page: 'realtime', id };
    if (path[2] === 'credential') return { page: 'credential', id };
    return { page: 'detail', id };
  }
  if (path[0] === 'exports') return { page: 'exports' };
  return { page: 'devices' };
}

export function devicePath(id: string, suffix = ''): string {
  return `/devices/${encodeURIComponent(id)}${suffix}`;
}

export function goTo(path: string): void {
  const hash = `#${path}`;
  if (window.location.hash === hash)
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  else window.location.hash = hash;
}

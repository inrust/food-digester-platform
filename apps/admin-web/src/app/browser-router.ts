import { useCallback, useEffect, useState } from 'react';
import { findRoute } from '../router/routes.js';

const NAVIGATION_EVENT = 'fdp:navigation';

export interface BrowserRouteLocation {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

export function currentBrowserLocation(): BrowserRouteLocation {
  return { pathname: window.location.pathname, search: window.location.search, hash: window.location.hash };
}

export function safeReturnPath(raw: string | null, fallback = '/dashboard'): string {
  if (raw === null || !raw.startsWith('/') || raw.startsWith('//')) return fallback;
  const url = new URL(raw, window.location.origin);
  const route = findRoute(url.pathname);
  return route !== null && route.public !== true ? `${url.pathname}${url.search}${url.hash}` : fallback;
}

export function useBrowserRouter() {
  const [location, setLocation] = useState(currentBrowserLocation);

  useEffect(() => {
    const update = () => setLocation(currentBrowserLocation());
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATION_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATION_EVENT, update);
    };
  }, []);

  const navigate = useCallback((href: string, options?: { replace?: boolean }) => {
    const url = new URL(href, window.location.origin);
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (options?.replace === true) window.history.replaceState(null, '', next);
    else window.history.pushState(null, '', next);
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  }, []);

  return { location, navigate };
}

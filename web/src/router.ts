/** 极简 hash 路由：#/、#/game/:gameId、#/workspace、#/match/:matchId、#/recover、#/admin、#/agent-guide */
import { useEffect, useState } from 'react';

export type Route =
  | { view: 'home' }
  | { view: 'game'; gameId: string }
  | { view: 'workspace' }
  | { view: 'match'; matchId: string }
  | { view: 'recover' }
  | { view: 'admin' }
  | { view: 'agent-guide' }
  | { view: 'notfound'; path: string };

function parse(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';
  const parts = path.split('/').filter((s) => s !== '');
  if (parts.length === 0) return { view: 'home' };
  if (parts[0] === 'game' && parts[1]) return { view: 'game', gameId: decodeURIComponent(parts[1]) };
  if (parts[0] === 'workspace') return { view: 'workspace' };
  if (parts[0] === 'match' && parts[1]) return { view: 'match', matchId: decodeURIComponent(parts[1]) };
  if (parts[0] === 'recover') return { view: 'recover' };
  if (parts[0] === 'admin') return { view: 'admin' };
  if (parts[0] === 'agent-guide') return { view: 'agent-guide' };
  return { view: 'notfound', path };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string): void {
  window.location.hash = path.startsWith('/') ? path : `/${path}`;
}

export function href(path: string): string {
  return `#${path}`;
}

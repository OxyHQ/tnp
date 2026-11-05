import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import type { ScrollRouterAdapter } from '@oxy.so/bloom/scroll';

/**
 * TNP renders one active route in BrowserRouter, with no retained screens.
 * Current pages select content by pathname (including route parameters), not
 * search/hash or history-entry keys. Keep that content's offset across visits.
 * Bloom supplies the store and restoration engine; this only binds the router.
 */
export const reactRouterScrollAdapter: ScrollRouterAdapter = {
  useScreenContentId() {
    return useLocation().pathname;
  },
  useScreenFocusEffect(effect) {
    useEffect(effect, [effect]);
  },
};

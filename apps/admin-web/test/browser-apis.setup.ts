/** jsdom has no layout engine. Layout/resize behavior is verified in Playwright. */
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    });
  }
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  const getComputedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = (element) => getComputedStyle(element);
}

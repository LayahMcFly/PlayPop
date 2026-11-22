// Resolves asset paths. The standalone single-file build injects window.__ASSETS (data URIs)
// so the game also runs by double-clicking the HTML file, without a web server.
export const asset = p => (typeof window !== 'undefined' && window.__ASSETS && window.__ASSETS[p]) || p;

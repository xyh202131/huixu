export const workbenchMethodHeader = 'X-Huixu-Method';

export function workbenchFetch(url, options) {
  if (import.meta.env?.VITE_HUIXU_STUDIO !== '1' || !['PATCH', 'DELETE'].includes(options?.method)) {
    return fetch(url, options);
  }
  const headers = new Headers(options.headers);
  headers.set(workbenchMethodHeader, options.method);
  return fetch(url, { ...options, method: 'POST', headers });
}

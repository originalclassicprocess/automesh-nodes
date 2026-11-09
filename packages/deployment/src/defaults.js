// Public deployment defaults only. Never put keys, tokens or machine paths here.
// Operators can override appOrigin in node configuration; the app uses its own
// served origin for contact links and same-origin signaling.
export const deploymentDefaults = Object.freeze({
  appOrigin: 'https://automesh.online',
  // Disabled until a project website domain is actually owned and configured.
  projectOrigin: '',
  nodeOrigin: 'https://automesh.space'
});

/** @param {string} value */
export function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password)
    throw new Error('https_origin_required');
  return url.origin;
}

/** @param {string} origin */
export function publicSignalingUrl(origin) {
  return httpsOrigin(origin).replace(/^https:/, 'wss:') + '/signal';
}

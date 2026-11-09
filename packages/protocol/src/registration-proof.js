const encoder = new TextEncoder();

/** @param {string} address @param {string} challenge */
export function registrationProofBytes(address, challenge) {
  return encoder.encode(JSON.stringify(['MeshAutonomy signaling registration v1', address, challenge]));
}

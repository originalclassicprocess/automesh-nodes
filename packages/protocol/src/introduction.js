// Online-only bootstrap, not a general message/file relay or persistent inbox.
export const INTRODUCTION_PROTOCOL = 'automesh-introduction-v1';
export const INTRODUCTION_MAX_BYTES = 24 * 1024;
/** @param {{protocol?:unknown,kind?:unknown,frame?:unknown} | null | undefined} message */
export function validIntroductionFrame(message) {
  return message?.protocol === INTRODUCTION_PROTOCOL &&
    (message.kind === 'open' && message.frame === undefined || message.kind === 'frame' &&
      typeof message.frame === 'string' && message.frame.length > 0 &&
      message.frame.length <= INTRODUCTION_MAX_BYTES * 4 / 3 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.frame));
}

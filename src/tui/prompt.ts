/**
 * Low-level keyboard decoding shared by the overlay menus. Decodes raw stdin
 * chunks into logical keys, handling both normal and application cursor modes.
 */

export type Key = 'up' | 'down' | 'left' | 'right' | 'enter' | 'cancel' | 'delete' | 'other';

/** Decodes a raw stdin chunk into a logical key. */
export function decodeKey(data: Buffer): Key {
  // Arrow keys arrive as ESC [ A/B/C/D (normal) or ESC O A/B/C/D (application
  // cursor mode, which full-screen apps like Claude/tmux enable). Handle both.
  if (data.length >= 3 && data[0] === 0x1b && (data[1] === 0x5b || data[1] === 0x4f)) {
    if (data[2] === 0x41) return 'up';
    if (data[2] === 0x42) return 'down';
    if (data[2] === 0x43) return 'right';
    if (data[2] === 0x44) return 'left';
    return 'other';
  }
  if (data.length === 1) {
    const b = data[0];
    if (b === 0x0d || b === 0x0a) return 'enter';
    if (b === 0x03 || b === 0x1b || b === 0x71) return 'cancel'; // Ctrl-C, Esc, q
    if (b === 0x04) return 'delete'; // Ctrl-D
    if (b === 0x6b) return 'up'; // k
    if (b === 0x6a) return 'down'; // j
  }
  return 'other';
}

/**
 * Terminal background detection, so agents render in the right light/dark theme.
 *
 * Under the compositor model the agent talks to a headless emulator, not the
 * real terminal — and that emulator doesn't answer the OSC 11 "what's your
 * background colour?" query many TUIs use to pick a theme, so they default to
 * dark. We query the *real* terminal once at startup, then (a) answer the
 * agent's OSC 10/11 queries with the real colours and (b) export `COLORFGBG`,
 * covering both detection mechanisms.
 */

const ESC = '\x1b';

export interface TermBackground {
  /** True when the terminal background is dark. */
  isDark: boolean;
  /** The verbatim OSC 11 response from the real terminal (echoed back to agents). */
  osc11: string;
}

interface TtyIn {
  isTTY?: boolean;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  removeListener(event: 'data', cb: (chunk: Buffer) => void): unknown;
}
interface TtyOut {
  isTTY?: boolean;
  write(s: string): unknown;
}

/** Relative luminance (0..1) of an OSC colour component triple. */
function luminance(r: string, g: string, b: string): number {
  const frac = (h: string) => parseInt(h, 16) / (16 ** h.length - 1);
  return 0.299 * frac(r) + 0.587 * frac(g) + 0.114 * frac(b);
}

const OSC11_RESPONSE = /\x1b\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)(?:\x07|\x1b\\)/;

/**
 * Asks the real terminal for its background colour (OSC 11) and resolves with
 * the parsed result, or null if it doesn't answer within `timeoutMs`. Requires
 * a TTY already in raw mode so the reply isn't line-buffered. Removes its own
 * listener and never throws.
 */
export function detectBackground(stdin: TtyIn, stdout: TtyOut, timeoutMs = 200): Promise<TermBackground | null> {
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (result: TermBackground | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('binary');
      const m = OSC11_RESPONSE.exec(buf);
      if (m) finish({ isDark: luminance(m[1], m[2], m[3]) < 0.5, osc11: m[0] });
    };
    stdin.on('data', onData);
    const timer = setTimeout(() => finish(null), timeoutMs);
    stdout.write(`${ESC}]11;?\x07`);
  });
}

/**
 * The `COLORFGBG` value for the detected background ("fg;bg" where bg 0 = dark,
 * 15 = light). Agents that read this env var theme themselves from it.
 */
export function colorfgbg(isDark: boolean): string {
  return isDark ? '15;0' : '0;15';
}

/**
 * OSC replies the compositor sends back when an agent queries terminal colours:
 * the real background for OSC 11, and a contrasting foreground for OSC 10.
 */
export function colorReplies(bg: TermBackground): { osc10: string; osc11: string } {
  const fg = bg.isDark ? 'ffff/ffff/ffff' : '0000/0000/0000';
  return { osc10: `${ESC}]10;rgb:${fg}\x07`, osc11: bg.osc11 };
}

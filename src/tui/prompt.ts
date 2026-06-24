/**
 * Interactive terminal prompts with arrow-key navigation, used for the
 * credential modal, the blank-sandbox confirmation, and the session picker.
 *
 * Navigation: ↑/↓ (or k/j) to move, Enter to select, Esc/q/Ctrl-C to cancel.
 * Falls back to a sensible default when stdin is not a TTY (CI / piped input).
 */
const ESC = '\x1b';

export interface Choice<T> {
  label: string;
  detail?: string;
  value: T;
}

export type Key = 'up' | 'down' | 'enter' | 'cancel' | 'other';

/** Decodes a raw stdin chunk into a logical key. Exported for testing. */
export function decodeKey(data: Buffer): Key {
  // Arrow keys arrive as ESC [ A/B (normal) or ESC O A/B (application cursor
  // mode, which full-screen apps like Claude/tmux enable). Handle both.
  if (data.length >= 3 && data[0] === 0x1b && (data[1] === 0x5b || data[1] === 0x4f)) {
    if (data[2] === 0x41) return 'up';
    if (data[2] === 0x42) return 'down';
    return 'other';
  }
  if (data.length === 1) {
    const b = data[0];
    if (b === 0x0d || b === 0x0a) return 'enter';
    if (b === 0x03 || b === 0x1b || b === 0x71) return 'cancel'; // Ctrl-C, Esc, q
    if (b === 0x6b) return 'up'; // k
    if (b === 0x6a) return 'down'; // j
  }
  return 'other';
}

function write(s: string): void {
  process.stdout.write(s);
}

/** Presents an arrow-key menu and resolves to the chosen value (null if cancelled). */
export async function select<T>(title: string, choices: Choice<T>[]): Promise<T | null> {
  if (choices.length === 0) return null;
  const stdin = process.stdin;
  if (!stdin.isTTY || !stdin.setRawMode) {
    // Non-interactive: cannot prompt; cancel safely.
    return null;
  }

  let index = 0;
  const lineCount = choices.length + 2; // title + options + hint

  const renderInto = (first: boolean) => {
    if (!first) write(`${ESC}[${lineCount}A`); // move cursor back to the top
    const lines: string[] = [];
    lines.push(`${ESC}[1m${title}${ESC}[0m`);
    choices.forEach((c, i) => {
      const selected = i === index;
      const marker = selected ? '❯' : ' ';
      const detail = c.detail ? `  ${ESC}[2m${c.detail}${ESC}[0m` : '';
      const label = selected ? `${ESC}[7m ${c.label} ${ESC}[0m` : `  ${c.label} `;
      lines.push(`${marker} ${label}${detail}`);
    });
    lines.push(`${ESC}[2m  ↑/↓ move · Enter select · Esc cancel${ESC}[0m`);
    write(lines.map((l) => `${ESC}[2K${l}`).join('\n') + '\n');
  };

  write(`${ESC}[?25l${ESC}[?7l`); // hide cursor; disable autowrap so long rows don't wrap
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  renderInto(true);

  return new Promise<T | null>((resolve) => {
    const cleanup = (result: T | null, chosenLabel?: string) => {
      stdin.off('data', onData);
      stdin.setRawMode!(wasRaw);
      stdin.pause();
      // Erase the menu and leave a single summary line.
      write(`${ESC}[${lineCount}A`);
      for (let i = 0; i < lineCount; i++) write(`${ESC}[2K\n`);
      write(`${ESC}[${lineCount}A`);
      write(`${ESC}[1m${title}${ESC}[0m ${chosenLabel ?? `${ESC}[2mcancelled${ESC}[0m`}\n`);
      write(`${ESC}[?25h${ESC}[?7h`); // show cursor; restore autowrap
      resolve(result);
    };

    const onData = (data: Buffer) => {
      switch (decodeKey(data)) {
        case 'up':
          index = (index - 1 + choices.length) % choices.length;
          renderInto(false);
          break;
        case 'down':
          index = (index + 1) % choices.length;
          renderInto(false);
          break;
        case 'enter':
          cleanup(choices[index].value, choices[index].label);
          break;
        case 'cancel':
          cleanup(null);
          break;
        default:
          break;
      }
    };

    stdin.on('data', onData);
  });
}

/** Yes/No confirmation as a two-item arrow menu. */
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const choices: Choice<boolean>[] = defaultYes
    ? [
        { label: 'Yes', value: true },
        { label: 'No', value: false },
      ]
    : [
        { label: 'No', value: false },
        { label: 'Yes', value: true },
      ];
  const result = await select(question, choices);
  return result ?? false;
}

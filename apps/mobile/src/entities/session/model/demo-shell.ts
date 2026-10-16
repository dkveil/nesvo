const DEMO_PATH = '/home/demo/projects/workspace';
const PROMPT = '\x1b[38;2;214;214;214mdemo\x1b[0m \x1b[90mworkspace\x1b[0m $ ';
const HELP = [
  'Dostępne polecenia demonstracyjne:',
  '  ls          przykładowe pliki',
  '  pwd         fikcyjny katalog',
  '  echo tekst  wyświetl tekst',
  '  git status  przykładowy stan projektu',
  '  clear       wyczyść widok',
  '  help        ta lista',
  '',
  'To lokalna symulacja. Nie łączy się z komputerem ani AI.',
].join('\r\n');

export function createDemoShell(write: (text: string) => void, onClear?: () => void) {
  let line = '';
  let started = false;
  let previousWasCR = false;
  let escapeSequence = '';

  function prompt() {
    write(PROMPT);
  }

  function run() {
    const command = line.trim();
    line = '';
    write('\r\n');
    if (!command) {
      prompt();
      return;
    }
    if (command === 'help') {
      write(`${HELP}\r\n`);
    } else if (command === 'ls' || command === 'ls -la' || command === 'ls -l') {
      write(
        '\x1b[38;2;214;214;214msrc/     assets/     docs/\x1b[0m\r\nREADME.md     package.json\r\n',
      );
    } else if (command === 'pwd') {
      write(`${DEMO_PATH}\r\n`);
    } else if (command === 'echo' || command.startsWith('echo ')) {
      write(`${command.slice(4).trimStart()}\r\n`);
    } else if (command === 'clear') {
      if (onClear) onClear();
      else write('\x1b[2J\x1b[3J\x1b[H');
    } else if (command === 'git status') {
      write(
        'Przykładowy stan repozytorium (DEMO):\r\nNa gałęzi main\r\nBrak zmian w katalogu roboczym.\r\n',
      );
    } else {
      write('To polecenie nie jest dostępne w demo. Wpisz help.\r\n');
    }
    prompt();
  }

  function start() {
    if (started) return;
    started = true;
    write('\x1b[38;2;214;214;214mDEMO · fikcyjny terminal\x1b[0m\r\n');
    write('Brak połączenia z komputerem lub AI.\r\nWpisz help, aby wypróbować polecenia.\r\n\r\n');
    prompt();
  }

  function input(data: string) {
    start();
    for (const character of data) {
      // Swallow navigation/control escape sequences, including bracketed-paste
      // delimiters. This small demo edits only at the end of the current line.
      if (escapeSequence) {
        escapeSequence += character;
        if (escapeSequence.length === 2 && (character === '[' || character === 'O')) continue;
        if (escapeSequence.length >= 3 && /[@-~]/.test(character)) escapeSequence = '';
        else if (escapeSequence.length === 2 || escapeSequence.length > 32) escapeSequence = '';
        continue;
      }
      if (character === '\x1b') {
        escapeSequence = character;
        continue;
      }
      if (character === '\n' && previousWasCR) {
        previousWasCR = false;
        continue;
      }
      previousWasCR = character === '\r';
      if (character === '\r' || character === '\n') {
        run();
      } else if (character === '\x03') {
        line = '';
        write('^C\r\n');
        prompt();
      } else if (character === '\x7f' || character === '\b') {
        if (line) {
          line = Array.from(line).slice(0, -1).join('');
          write('\b \b');
        }
      } else if (character === '\x0c') {
        if (onClear) onClear();
        else write('\x1b[2J\x1b[3J\x1b[H');
        prompt();
        write(line);
      } else if (character >= ' ' && character !== '\x7f' && line.length < 4096) {
        line += character;
        write(character);
      }
    }
  }

  return { input, start };
}

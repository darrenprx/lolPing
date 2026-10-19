// Stand-in for the hook helper in InputBridge tests. Mode comes from argv[2].
const mode = process.argv[2];
if (mode === 'crash') process.exit(1);

if (mode === 'noaccess') {
  // What the macOS helper does without Accessibility access.
  process.stdout.write(`${JSON.stringify({ type: 'error', code: 'noAccess', message: 'no access' })}\n`, () => process.exit(3));
} else {
  process.stdout.write(`${JSON.stringify({ type: 'ready', version: 1 })}\n`);
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const cmd = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (cmd.type === 'shutdown') process.exit(0);
      process.stdout.write(`${JSON.stringify(reply(cmd))}\n`);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// 'answer' fills in the helper's app queries; every other command is echoed back so the test can observe it.
function reply(cmd) {
  if (mode === 'answer' && cmd.type === 'getForegroundApp') return { type: 'foregroundApp', name: 'Photoshop.exe' };
  if (mode === 'answer' && cmd.type === 'getAppList') {
    return { type: 'appList', apps: [{ name: 'Photoshop.exe', path: 'C:\\Adobe\\Photoshop.exe' }] };
  }
  return { type: 'error', message: `got:${cmd.type}` };
}

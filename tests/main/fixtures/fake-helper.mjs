// Stand-in for the hook helper in InputBridge tests. Mode comes from argv[2].
const mode = process.argv[2];
if (mode === 'crash') process.exit(1);

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
    // Echo back what we received so the test can observe it.
    process.stdout.write(`${JSON.stringify({ type: 'error', message: `got:${cmd.type}` })}\n`);
  }
});
process.stdin.on('end', () => process.exit(0));

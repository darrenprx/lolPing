import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The release workflow cannot run here, so these checks keep its ordering from regressing: installed apps read latest.yml from the
// newest *published* release, so the release has to stay a draft until both installers and the update files are uploaded.
const workflow = readFileSync(join(__dirname, '../../.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n');

/** The text of one top-level job. */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThanOrEqual(0);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z]+:\n/);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

describe('release workflow', () => {
  it('creates the release as a draft, and only when none exists for the tag (a re-run keeps working)', () => {
    const create = job('release');
    expect(create).toMatch(/gh release create "\$GITHUB_REF_NAME"[^\n]*--draft/);
    expect(create).toMatch(/gh release list[^\n]*--json tagName/); // a draft is found by listing, not by `gh release view`
    expect(create).toMatch(/grep -Fx "\$GITHUB_REF_NAME" > \/dev\/null/); // not -q: grep reads the whole list, so gh never gets a broken pipe
  });

  it('uploads the installer, latest.yml and the blockmap from the Windows job, and the disk image from the Mac job', () => {
    const win = job('windows');
    expect(win).toContain('"release/lolPing-Setup-${GITHUB_REF_NAME#v}.exe"');
    expect(win).toContain('"release/latest.yml"');
    expect(win).toContain('"release/lolPing-Setup-${GITHUB_REF_NAME#v}.exe.blockmap"');
    expect(win).toContain('--clobber');
    expect(job('mac')).toContain('release/lolPing-${GITHUB_REF_NAME#v}-arm64.dmg');
  });

  it('publishes the draft in a last job that waits for both platform jobs', () => {
    const publish = job('publish');
    expect(publish).toMatch(/needs: \[windows, mac\]/);
    expect(publish).toContain('gh release edit "$GITHUB_REF_NAME" --draft=false');
    expect(publish).toMatch(/GH_REPO: \$\{\{ github\.repository \}\}/); // no checkout in this job, so gh needs to be told the repository
  });

  it('leaves no git credentials behind in the platform jobs (gh uses GH_TOKEN, and nothing there pushes)', () => {
    for (const name of ['windows', 'mac']) {
      const text = job(name);
      expect(text, name).toMatch(/actions\/checkout@v7\n\s+with:\n\s+persist-credentials: false/);
      expect(text, name).not.toMatch(/git (push|commit|tag)/);
      expect(text, name).toContain('GH_TOKEN: ${{ github.token }}');
    }
  });

  it('never publishes from the platform jobs', () => {
    expect(job('windows')).not.toContain('--draft=false');
    expect(job('mac')).not.toContain('--draft=false');
  });
});

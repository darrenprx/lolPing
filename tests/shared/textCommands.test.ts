import { describe, expect, it } from 'vitest';
import { MAX_TEXT, MAX_VOTE_TOPIC } from '../../src/shared/roomProtocol';
import { parseTextInput } from '../../src/shared/textCommands';

describe('parseTextInput', () => {
  it('reads /ff and /surrender, in any case and with spaces around', () => {
    expect(parseTextInput('/ff')).toEqual({ kind: 'ff' });
    expect(parseTextInput(' /FF ')).toEqual({ kind: 'ff' });
    expect(parseTextInput('/surrender')).toEqual({ kind: 'ff' });
  });

  it('reads /noff and /ready', () => {
    expect(parseTextInput('/noff')).toEqual({ kind: 'noff' });
    expect(parseTextInput('/ready')).toEqual({ kind: 'ready' });
  });

  it('calls any other slash word unknown', () => {
    expect(parseTextInput('/remake')).toEqual({ kind: 'unknown' });
    expect(parseTextInput('/')).toEqual({ kind: 'unknown' });
    expect(parseTextInput('/ffnow')).toEqual({ kind: 'unknown' });
    expect(parseTextInput('/noff now')).toEqual({ kind: 'unknown' });
  });

  it('reads the words after /ff, /surrender or /ready as what the vote is about', () => {
    expect(parseTextInput('/ff 打不过了')).toEqual({ kind: 'ff', topic: '打不过了' });
    expect(parseTextInput('/SURRENDER  four  forts down ')).toEqual({ kind: 'ff', topic: 'four  forts down' });
    expect(parseTextInput('/ready 来一把排位')).toEqual({ kind: 'ready', topic: '来一把排位' });
  });

  it('cuts a topic to 40 code points and leaves out one that cleans to nothing', () => {
    expect(parseTextInput(`/ff ${'字'.repeat(50)}`)).toEqual({ kind: 'ff', topic: '字'.repeat(MAX_VOTE_TOPIC) });
    expect(parseTextInput('/ready ​‮')).toEqual({ kind: 'ready' });
  });

  it('calls blank or invisible input empty', () => {
    expect(parseTextInput('   ')).toEqual({ kind: 'empty' });
    expect(parseTextInput('\u200b')).toEqual({ kind: 'empty' });
    expect(parseTextInput('')).toEqual({ kind: 'empty' });
  });

  it('keeps plain words as text, including "ff" without a slash', () => {
    expect(parseTextInput('gg wp')).toEqual({ kind: 'text', text: 'gg wp' });
    expect(parseTextInput('ff')).toEqual({ kind: 'text', text: 'ff' });
  });

  it('cuts long text to the message limit', () => {
    const r = parseTextInput('a'.repeat(130));
    expect(r).toEqual({ kind: 'text', text: 'a'.repeat(MAX_TEXT) });
    expect([...(r.kind === 'text' ? r.text : '')]).toHaveLength(120);
  });
});

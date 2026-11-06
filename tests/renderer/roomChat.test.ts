// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mountChat, renderChatHistory } from '../../src/renderer/chat/chat';
import type { RoomChatApi, RoomChatState, TextAnswer } from '../../src/shared/ipc';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); document.body.replaceChildren(); });

function setup() {
  document.body.innerHTML = `<main id="chat"><header><span id="title"></span><span id="room"></span>
    <button id="hide" type="button"></button></header><section id="messages"></section>
    <form id="compose"><input id="message" /><span id="count" hidden></span>
    <button id="send" type="submit"></button><small id="hint"></small></form></main>`;
  const root = document.getElementById('chat') as HTMLElement;
  const input = document.getElementById('message') as HTMLInputElement;
  let listener: ((s: RoomChatState) => void) | null = null;
  let finish: ((a: TextAnswer) => void) | null = null;
  let hidden = 0;
  const drafts: string[] = [];
  const sent: string[] = [];
  const api: RoomChatApi = {
    get: async () => null,
    on: (cb) => { listener = cb; return () => { listener = null; }; },
    hide: () => { hidden++; },
    draft: (text) => { drafts.push(text); },
    submit: (text) => { sent.push(text); return new Promise((resolve) => { finish = resolve; }); },
  };
  cleanups.push(mountChat(root, api));
  const state: RoomChatState = { lang: 'zh-CN', code: 'PING-AAAAA-BBBBB', members: 2, history: [] };
  const update = (s: RoomChatState): void => { listener?.(s); };
  update(state);
  const type = (value: string): void => { input.value = value; input.dispatchEvent(new InputEvent('input', { bubbles: true })); };
  const key = (name: string, opts: KeyboardEventInit = {}): void => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...opts }));
  };
  return {
    root, input, sent, drafts, type, key, hidden: () => hidden, state,
    update: (s: RoomChatState) => listener?.(s),
    answer: async (answer: TextAnswer) => { finish?.(answer); await Promise.resolve(); },
  };
}

describe('mountChat', () => {
  it('keeps Chinese composition and a draft intact when room history changes', () => {
    const s = setup();
    s.type('还在输入');
    s.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    s.key('Enter', { isComposing: true });
    s.update({ ...s.state, history: [{ at: 1, kind: 'text', tag: null, text: 'new message' }] });
    expect(s.sent).toEqual([]);
    expect(s.input.value).toBe('还在输入');
    s.input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    s.key('Enter');
    expect(s.sent).toEqual(['还在输入']);
  });

  it('sends once for a held Enter and stays ready for another message afterwards', async () => {
    const s = setup();
    s.type('hello');
    s.key('Enter');
    s.key('Enter', { repeat: true });
    s.key('Enter');
    expect(s.sent).toEqual(['hello']);
    await s.answer('sent');
    expect(s.input.value).toBe('');
    expect(s.hidden()).toBe(0);
    s.type('next');
    s.key('Enter');
    expect(s.sent).toEqual(['hello', 'next']);
  });

  it('does not erase a newer draft typed while a submit was pending', async () => {
    const s = setup();
    s.type('first');
    s.key('Enter');
    s.type('second');
    await s.answer('sent');
    expect(s.input.value).toBe('second');
  });

  it('shows command feedback and preserves the failed draft', async () => {
    const s = setup();
    s.type('/missing');
    s.key('Enter');
    await s.answer('unknown');
    expect(s.root.querySelector('#hint')?.textContent).toBe('未知指令');
    expect(s.input.value).toBe('/missing');
    s.type('/ff');
    s.key('Enter');
    await s.answer('votesOff');
    expect(s.root.querySelector('#hint')?.textContent).toBe('投票已关闭');
  });

  it('counts emoji as one code point and never clips an active IME composition', () => {
    const s = setup();
    s.type('😀'.repeat(121));
    expect([...s.input.value]).toHaveLength(120);
    expect(s.root.querySelector('#count')?.textContent).toBe('120/120');
    s.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    s.input.value = '中'.repeat(121);
    s.input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    expect([...s.input.value]).toHaveLength(121);
    s.input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect([...s.input.value]).toHaveLength(120);
  });

  it('hides on Escape or the close button without submitting and ignores empty text', () => {
    const s = setup();
    s.type('   ');
    s.key('Enter');
    expect(s.sent).toEqual([]);
    s.key('Escape');
    s.root.querySelector<HTMLButtonElement>('#hide')?.click();
    expect(s.hidden()).toBe(2);
  });

  it('saves the current field before hiding even if accessibility changed it without an input event', () => {
    const s = setup();
    s.input.value = 'unsent draft';
    s.root.querySelector<HTMLButtonElement>('#hide')?.click();
    expect(s.drafts.at(-1)).toBe('unsent draft');
    expect(s.hidden()).toBe(1);
  });

  it('restores the saved draft only on the first state, not on later history updates', () => {
    const s = setup();
    s.update({ ...s.state, code: 'PING-CCCCC-DDDDD', draft: 'saved' });
    expect(s.input.value).toBe('saved');
    s.type('new draft');
    s.update({ ...s.state, code: 'PING-CCCCC-DDDDD', draft: 'saved', members: 3 });
    expect(s.input.value).toBe('new draft');
  });

  it('clears the old draft when a different room opens', () => {
    const s = setup();
    s.type('private draft');
    s.update({ ...s.state, code: 'PING-CCCCC-DDDDD' });
    expect(s.input.value).toBe('');
  });
});

describe('renderChatHistory', () => {
  it('renders members and vote results as text, never as markup', () => {
    const root = document.createElement('section');
    renderChatHistory(root, [
      { at: 1, kind: 'text', tag: { name: '<img src=x>', color: 0, rgb: null }, text: '<script>alert(1)</script>' },
      { at: 2, kind: 'vote', tag: null, text: 'Everyone is ready' },
    ], 'en');
    expect(root.querySelectorAll('.line')).toHaveLength(2);
    expect(root.querySelectorAll('.name')).toHaveLength(1);
    expect(root.querySelector('img, script')).toBeNull();
    expect(root.textContent).toContain('<img src=x>: <script>alert(1)</script>');
    expect(root.querySelector('.vote')?.textContent).toContain('Everyone is ready');
  });

  it('keeps the list pinned only when the user was already reading the newest line', () => {
    const root = document.createElement('section');
    Object.defineProperties(root, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } });
    root.scrollTop = 300;
    renderChatHistory(root, [], 'en');
    expect(root.scrollTop).toBe(300);
    root.scrollTop = 800;
    renderChatHistory(root, [], 'en');
    expect(root.scrollTop).toBe(1000);
  });
});

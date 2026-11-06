import { strings, type Strings } from '../../shared/i18n';
import type { RoomChatApi, RoomChatState, TextAnswer } from '../../shared/ipc';
import { tagColorCss } from '../../shared/roomColors';
import type { HistoryLine } from '../../shared/roomHistory';
import { MAX_TEXT } from '../../shared/roomProtocol';
import { atBottom } from '../panel/roster';

/** Only text nodes and validated tag colours reach the DOM, never a room member's markup. */
export function renderChatHistory(root: HTMLElement, history: readonly HistoryLine[], lang: RoomChatState['lang']): void {
  const pinned = atBottom(root.scrollTop, root.clientHeight, root.scrollHeight);
  const top = root.scrollTop;
  const fragment = document.createDocumentFragment();
  if (history.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = strings(lang).roomChatEmpty;
    fragment.append(empty);
  }
  const clock = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', hour12: false });
  for (const line of history) {
    const row = document.createElement('p');
    row.className = `line ${line.kind}`;
    const time = document.createElement('time');
    time.className = 'time';
    time.dateTime = new Date(line.at).toISOString();
    time.textContent = clock.format(line.at);
    row.append(time);
    if (line.tag) {
      const name = document.createElement('span');
      name.className = 'name';
      name.style.setProperty('--tag', tagColorCss(line.tag.color, line.tag.rgb));
      name.textContent = `${line.tag.name}: `;
      row.append(name);
    }
    const said = document.createElement('span');
    said.className = 'said';
    said.textContent = line.text;
    row.append(said);
    fragment.append(row);
  }
  root.replaceChildren(fragment);
  root.scrollTop = pinned ? root.scrollHeight : top;
}

/** Binds once: history updates never rebuild the input or disturb an IME's draft. */
export function mountChat(root: HTMLElement, api: RoomChatApi): () => void {
  const input = root.querySelector<HTMLInputElement>('#message');
  const count = root.querySelector<HTMLElement>('#count');
  const hint = root.querySelector<HTMLElement>('#hint');
  const title = root.querySelector<HTMLElement>('#title');
  const room = root.querySelector<HTMLElement>('#room');
  const messages = root.querySelector<HTMLElement>('#messages');
  const form = root.querySelector<HTMLFormElement>('#compose');
  const send = root.querySelector<HTMLButtonElement>('#send');
  const hide = root.querySelector<HTMLButtonElement>('#hide');
  if (!input || !count || !hint || !title || !room || !messages || !form || !send || !hide) return () => undefined;
  const controller = new AbortController();
  const { signal } = controller;
  let text: Strings | null = null;
  let code: string | null = null;
  let sending = false;
  let composing = false;
  let revision = 0;

  const showHint = (message: string, warn = false): void => {
    hint.textContent = message;
    hint.classList.toggle('warn', warn);
  };
  const clamp = (): void => {
    const points = [...input.value];
    if (points.length > MAX_TEXT) input.value = points.slice(0, MAX_TEXT).join('');
    const used = Math.min(points.length, MAX_TEXT);
    count.hidden = used < MAX_TEXT - 20;
    count.textContent = `${used}/${MAX_TEXT}`;
    count.classList.toggle('full', used >= MAX_TEXT);
    send.disabled = sending || composing || input.value.trim().length === 0;
    if (code !== null) api.draft(input.value);
  };
  const update = (state: RoomChatState): void => {
    revision++;
    text = strings(state.lang);
    document.documentElement.lang = state.lang;
    document.title = text.roomChatTitle;
    title.textContent = text.roomChatTitle;
    room.textContent = `${state.code} · ${state.members}`;
    hide.title = text.roomChatHide;
    hide.setAttribute('aria-label', text.roomChatHide);
    send.textContent = text.roomChatSend;
    input.placeholder = text.textBoxPlaceholder;
    input.setAttribute('aria-label', text.roomChatTitle);
    messages.setAttribute('aria-label', text.panelHistory);
    if (code !== state.code) {
      code = state.code;
      input.value = state.draft ?? '';
      composing = false;
      messages.scrollTop = messages.scrollHeight;
      clamp();
    }
    showHint(text.roomChatHint);
    renderChatHistory(messages, state.history, state.lang);
  };
  const submit = async (): Promise<void> => {
    if (sending || composing || !input.value.trim()) return;
    const draft = input.value;
    const sentIn = code;
    sending = true;
    clamp();
    let answer: TextAnswer;
    try {
      answer = await api.submit(draft);
    } catch {
      sending = false;
      showHint(text?.roomChatFailed ?? '', true);
      clamp();
      return;
    }
    sending = false;
    if (sentIn !== code) return clamp();
    if (answer === 'sent') {
      // A reply can arrive while the user already types the next line: don't erase that newer draft.
      if (input.value === draft) input.value = '';
      showHint(text?.roomChatHint ?? '');
    } else showHint((answer === 'votesOff' ? text?.textBoxVotesOff : text?.textBoxUnknown) ?? '', true);
    clamp();
  };
  input.addEventListener('compositionstart', () => { composing = true; clamp(); }, { signal });
  input.addEventListener('compositionend', () => { composing = false; clamp(); }, { signal });
  input.addEventListener('input', (event) => {
    if (!(event as InputEvent).isComposing && !composing) clamp();
    if (text) showHint(text.roomChatHint);
  }, { signal });
  const hideChat = (): void => {
    api.draft(input.value);
    api.hide();
  };
  root.addEventListener('keydown', (event) => {
    if (event.isComposing || composing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      hideChat();
    } else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      if (!event.repeat) void submit();
    }
  }, { signal });
  form.addEventListener('submit', (event) => { event.preventDefault(); void submit(); }, { signal });
  hide.addEventListener('click', hideChat, { signal });
  window.addEventListener('focus', () => input.focus(), { signal });
  const stop = api.on(update);
  const before = revision;
  void api.get().then((state) => {
    if (state && !signal.aborted && revision === before) update(state);
  }).catch(() => undefined);
  input.focus();
  clamp();
  return () => { controller.abort(); stop(); };
}

// js/board-portal.js
// The board member's side of meeting attendance, at /board.
//
// Signed out: email → 6-digit code → signed in on this phone for 6 months.
// Signed in: their profile, a "Scan meeting QR" button that marks them
// present from the projector's code, and their attendance history.
//
// A QR opened with the phone's own camera app arrives as /board?attend=…;
// it is marked straight after sign-in, so either way of scanning works.

import { el, dayLabel, timeLabel } from './dom.js?v=1.0.0';
import { QrScanner } from './qr-scanner.js?v=1.0.0';

const ATTEND_IN_TEXT = /[?&]attend=(MTG-\d{1,6})\.([A-Za-z0-9_-]{12})(?![A-Za-z0-9_-])/;

/** The meeting and code inside a projector QR (its URL), or null. */
export function parseAttendQr(text) {
  const m = ATTEND_IN_TEXT.exec(String(text || ''));
  return m ? { meetingId: m[1], code: m[2] } : null;
}

const STATUS_CHIP = {
  present: ['board-chip board-chip--present', 'Present'],
  leave: ['board-chip board-chip--leave', 'Leave'],
  absent: ['board-chip board-chip--absent', 'Absent'],
};

export class BoardPortal {
  /** @param {{ root: HTMLElement, store: object, toast: (msg: string, type?: string) => void }} opts */
  constructor({ root, store, toast }) {
    this.root = root;
    this.store = store;
    this.toast = toast;
    this.scanner = null;
    this.pendingAttend = null;
    this.email = '';
    this.busy = false;
  }

  /** @param {{ attend?: {meetingId: string, code: string} | null }} opts */
  async mount({ attend = null } = {}) {
    this.pendingAttend = attend;
    if (this.store.getBoardSession()) await this.showSignedIn();
    else this.showSignIn();
  }

  destroy() {
    this.scanner?.stop();
    this.scanner = null;
  }

  // ── Signed out ─────────────────────────────────────────────────

  showSignIn(step = 'email') {
    this.destroy();
    const message = el('p', { className: 'board-message', role: 'status', 'aria-live': 'polite' });
    const card = el('div', { className: 'board-card board-signin' },
      el('h2', { className: 'board-title', text: 'BCCI Board Portal' }),
      el('p', { className: 'board-lead', text: this.pendingAttend
        ? 'Sign in to mark your attendance for this meeting.'
        : 'Sign in with the email address the BCCI Secretariat registered for you.' }),
    );

    if (step === 'email') {
      const input = el('input', { type: 'email', id: 'boardEmail', className: 'form-control', autocomplete: 'email', inputmode: 'email', required: true, value: this.email, placeholder: 'you@example.com' });
      const button = el('button', { type: 'submit', className: 'btn-primary board-wide-btn', text: 'Send sign-in code' });
      const form = el('form', { className: 'board-form', novalidate: true },
        el('label', { for: 'boardEmail', className: 'form-label', text: 'Email address' }), input, button);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = input.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          this.say(message, 'error', 'Enter a valid email address.');
          input.focus();
          return;
        }
        button.disabled = true;
        button.textContent = 'Sending…';
        try {
          await this.store.apiCall('/api/board?action=request-code', { method: 'POST', body: { email } });
          this.email = email;
          this.showSignIn('code');
        } catch (err) {
          this.say(message, 'error', err.message);
          button.disabled = false;
          button.textContent = 'Send sign-in code';
        }
      });
      card.append(form, message);
      this.root.replaceChildren(card);
      input.focus();
      return;
    }

    const codeInput = el('input', { type: 'text', id: 'boardCode', className: 'form-control board-code-input', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '6', pattern: '\\d{6}', required: true, placeholder: '123456' });
    const button = el('button', { type: 'submit', className: 'btn-primary board-wide-btn', text: 'Sign in' });
    const back = el('button', { type: 'button', className: 'board-link-btn', text: 'Use a different email' });
    const form = el('form', { className: 'board-form', novalidate: true },
      el('p', { className: 'board-lead', text: `If ${this.email} belongs to a board member, a 6-digit code is on its way. It expires in 10 minutes.` }),
      el('label', { for: 'boardCode', className: 'form-label', text: 'Sign-in code' }), codeInput, button, back);
    back.addEventListener('click', () => this.showSignIn('email'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = codeInput.value.replace(/\s/g, '');
      if (!/^\d{6}$/.test(code)) {
        this.say(message, 'error', 'Enter the 6-digit code from the email.');
        codeInput.focus();
        return;
      }
      button.disabled = true;
      button.textContent = 'Signing in…';
      try {
        const result = await this.store.apiCall('/api/board?action=verify-code', { method: 'POST', body: { email: this.email, code } });
        this.store.setBoardSession(result.session, result.member);
        await this.showSignedIn();
      } catch (err) {
        this.say(message, 'error', err.message);
        button.disabled = false;
        button.textContent = 'Sign in';
        codeInput.select();
      }
    });
    card.append(form, message);
    this.root.replaceChildren(card);
    codeInput.focus();
  }

  // ── Signed in ──────────────────────────────────────────────────

  async showSignedIn() {
    this.root.replaceChildren(el('div', { className: 'board-card', text: 'Loading your board profile…' }));
    let data;
    try {
      data = await this.store.apiCall('/api/board?action=me', { auth: 'board' });
    } catch (err) {
      if (err.status === 401) {
        this.showSignIn();
        return;
      }
      this.root.replaceChildren(el('div', { className: 'board-card' },
        el('p', { className: 'board-message board-message--error', text: err.message }),
        el('button', { type: 'button', className: 'btn-secondary', text: 'Try again', id: 'boardRetry' })));
      this.root.querySelector('#boardRetry').addEventListener('click', () => this.showSignedIn());
      return;
    }
    this.data = data;
    this.render();

    if (this.pendingAttend) {
      const pending = this.pendingAttend;
      this.pendingAttend = null;
      await this.attend(pending);
    }
  }

  render() {
    const { member, items, stats } = this.data;
    const initials = member.name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
    const signOut = el('button', { type: 'button', className: 'board-link-btn', text: 'Sign out' });
    signOut.addEventListener('click', async () => {
      await this.store.clearBoardSession();
      this.showSignIn();
    });

    const profile = el('div', { className: 'board-card board-profile' },
      el('div', { className: 'board-avatar', 'aria-hidden': 'true', text: initials || '•' }),
      el('div', { className: 'board-profile-text' },
        el('h2', { className: 'board-name', text: member.name }),
        el('div', { className: 'board-designation', text: member.designation }),
        member.company ? el('div', { className: 'board-meta', text: member.company }) : null,
        el('div', { className: 'board-meta', text: `${member.email} · ${member.mobile}` }),
      ),
      signOut,
    );

    // ── Scan ──
    this.resultBox = el('div', { className: 'board-result', role: 'status', 'aria-live': 'assertive', hidden: true });
    this.video = el('video', { className: 'board-video', playsinline: true, muted: true, hidden: true, 'aria-label': 'Camera view for scanning the meeting QR code' });
    this.scanBtn = el('button', { type: 'button', className: 'btn-primary board-scan-btn' }, el('i', { className: 'fas fa-qrcode', 'aria-hidden': 'true' }), ' Scan meeting QR');
    this.cancelBtn = el('button', { type: 'button', className: 'btn-secondary', text: 'Cancel', hidden: true });
    this.scanBtn.addEventListener('click', () => this.startScan());
    this.cancelBtn.addEventListener('click', () => this.stopScan());

    const open = items.filter((i) => i.meeting.status === 'open');
    const openNote = open.map((i) => el('p', { className: i.status === 'present' ? 'board-open board-open--done' : 'board-open' },
      i.status === 'present'
        ? `${i.meeting.title}: you are marked present (${timeLabel(i.at)}).`
        : `Attendance is open for ${i.meeting.title}. Scan the QR code on the screen.`));

    const scan = el('div', { className: 'board-card board-scan' },
      el('h3', { className: 'board-section-title', text: 'Mark your attendance' }),
      ...openNote,
      this.scanBtn,
      this.video,
      this.cancelBtn,
      this.resultBox,
    );

    // ── History ──
    const held = stats.held;
    const statLine = held
      ? `Attended ${stats.attended} of ${held} meeting${held === 1 ? '' : 's'} (${Math.round(stats.rate * 100)}%)`
      : items.length
        ? 'Your totals update once the secretary closes a meeting.'
        : 'No meetings yet.';
    const list = el('ul', { className: 'board-history' });
    for (const item of items) {
      const m = item.meeting;
      let chip;
      if (m.status === 'scheduled') chip = el('span', { className: 'board-chip board-chip--upcoming', text: 'Upcoming' });
      else if (m.status === 'open' && item.status !== 'present') chip = el('span', { className: 'board-chip board-chip--open', text: 'Open now' });
      else {
        const [cls, label] = STATUS_CHIP[item.status] || STATUS_CHIP.absent;
        chip = el('span', { className: cls, text: label });
      }
      list.append(el('li', { className: 'board-history-row' },
        el('div', {},
          el('strong', { text: m.title }),
          el('small', { text: [dayLabel(m.date), m.time, m.venue].filter(Boolean).join(' · ') })),
        chip));
    }
    if (!items.length) list.append(el('li', { className: 'board-empty', text: 'No meetings yet.' }));

    const history = el('div', { className: 'board-card' },
      el('h3', { className: 'board-section-title', text: 'My attendance' }),
      el('p', { className: 'board-stat', text: statLine }),
      list);

    this.root.replaceChildren(profile, scan, history);
  }

  // ── Scanning ───────────────────────────────────────────────────

  async startScan() {
    this.showResult(null);
    this.scanBtn.disabled = true;
    this.video.hidden = false;
    this.cancelBtn.hidden = false;
    // render() replaces the video element, so a scanner bound to an older one is rebuilt.
    if (!this.scanner || this.scanner.video !== this.video) {
      this.scanner?.stop();
      this.scanner = new QrScanner({ video: this.video, onText: (text) => this.onScanned(text), repeatMs: 2500 });
    }
    this.scanner.reset();
    try {
      await this.scanner.start();
      this.showResult('idle', 'Point your camera at the QR code on the screen.');
    } catch (err) {
      this.stopScan();
      this.showResult('error', `${err.message} You can also scan the screen with your phone's camera app.`);
    }
  }

  stopScan() {
    this.scanner?.stop();
    if (!this.video) return;
    this.video.hidden = true;
    this.cancelBtn.hidden = true;
    this.scanBtn.disabled = false;
  }

  async onScanned(text) {
    const target = parseAttendQr(text);
    if (!target) {
      this.showResult('error', 'That is not a BCCI board meeting QR code. Scan the code on the meeting screen.');
      return;
    }
    await this.attend(target);
  }

  async attend({ meetingId, code }) {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await this.store.apiCall('/api/board?action=attend', {
        method: 'POST', body: { meetingId, code }, auth: 'board', retries: 1,
      });
      this.stopScan();
      const when = timeLabel(result.at);
      if (result.alreadyMarked) this.showResult('warn', `You were already marked present for ${result.meeting.title} at ${when}.`);
      else {
        this.showResult('ok', `You are marked present for ${result.meeting.title} at ${when}.`);
        navigator.vibrate?.(150);
      }
      await this.refreshData();
    } catch (err) {
      const reason = err.data?.code;
      if (err.status === 401) {
        this.stopScan();
        this.pendingAttend = { meetingId, code };
        this.showSignIn();
        return;
      }
      if (reason === 'expired') {
        // The projector moved on to a new code; keep the camera running.
        this.scanner?.reset();
        this.showResult('warn', 'That code just changed. Hold your phone up to the screen again.');
      } else {
        this.stopScan();
        this.showResult('error', err.message || 'Your attendance could not be recorded.');
      }
    } finally {
      this.busy = false;
    }
  }

  async refreshData() {
    try {
      this.data = await this.store.apiCall('/api/board?action=me', { auth: 'board' });
      const result = this.resultBox;
      this.render();
      this.resultBox.replaceWith(result);
      this.resultBox = result;
    } catch (err) {
      console.warn('[BoardPortal] could not refresh history:', err.message);
    }
  }

  showResult(kind, text) {
    if (!this.resultBox) return;
    this.resultBox.hidden = !kind;
    this.resultBox.className = kind ? `board-result board-result--${kind}` : 'board-result';
    this.resultBox.textContent = text || '';
  }

  say(node, kind, text) {
    node.className = `board-message board-message--${kind}`;
    node.textContent = text;
  }
}

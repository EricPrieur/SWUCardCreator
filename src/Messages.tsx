import { useEffect, useState } from 'react'
import { api, type Session } from './api'

// An account's notifications and mail (server/messages.js), as on The Chrome Grid: the site's
// news of its cards, and mail from people. The account's name in the corner counts the unread.

export type Unread = { notification: number; mail: number }
type Message = {
  id: number
  kind: 'notification' | 'mail'
  from: string | null
  fromAdmin: boolean
  to: string | null
  // Written to the admins: each admin has a copy
  toAdmins: boolean
  subject: string
  body: string
  link: string | null
  replyTo: number | null
  read: boolean
  createdAt: string
}

// How often the unread are asked again while the page is open
const UNREAD_EVERY = 60 * 1000

// The unread counts, asked as the page opens, every minute, and when the tab is looked at again.
// `refresh` asks at once, after one is read.
export function useUnread(session: Session | null, online: boolean) {
  const [unread, setUnread] = useState<Unread>({ notification: 0, mail: 0 })
  const [asked, setAsked] = useState(0)
  useEffect(() => {
    if (!session || !online) {
      setUnread({ notification: 0, mail: 0 })
      return
    }
    let live = true
    const ask = () =>
      api<Unread>('/api/messages/unread', { token: session.token })
        .then((found) => live && setUnread(found))
        .catch(() => undefined)
    ask()
    const timer = window.setInterval(ask, UNREAD_EVERY)
    const onFocus = () => document.visibilityState === 'visible' && ask()
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      live = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [session?.token, online, asked])
  return { unread, refresh: () => setAsked((n) => n + 1) }
}

const when = (date: string) => {
  const at = new Date(date)
  const today = new Date().toDateString() === at.toDateString()
  return today ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : at.toLocaleDateString()
}

function useMessages(session: Session, kind: Message['kind'], sent = false) {
  const [list, setList] = useState<Message[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () =>
    api<{ messages: Message[] }>(`/api/messages?kind=${kind}${sent ? '&sent=1' : ''}`, { token: session.token })
      .then((data) => setList(data.messages))
      .catch((err) => setError((err as Error).message))
  useEffect(() => {
    setList(null)
    load()
  }, [session.token, kind, sent])
  return { list, setList, error, setError, load }
}

// The site's news: each opened is read; one with a link goes there
export function NotificationsTab(props: { session: Session; onChange: () => void; onGo: () => void }) {
  const { session, onChange } = props
  const { list, setList, error, setError } = useMessages(session, 'notification')
  const read = async (message: Message) => {
    if (message.read) return
    setList((now) => now && now.map((m) => (m.id === message.id ? { ...m, read: true } : m)))
    await api('/api/messages/read', { method: 'POST', body: { id: message.id }, token: session.token }).catch(() => undefined)
    onChange()
  }
  const readAll = async () => {
    setList((now) => now && now.map((m) => ({ ...m, read: true })))
    await api('/api/messages/read', { method: 'POST', body: { all: 'notification' }, token: session.token }).catch((err) => setError(err.message))
    onChange()
  }
  const remove = async (message: Message) => {
    setList((now) => now && now.filter((m) => m.id !== message.id))
    await api(`/api/messages/${message.id}`, { method: 'DELETE', token: session.token }).catch(() => undefined)
    onChange()
  }
  if (error && !list) return <p className="account-error">{error}</p>
  if (!list) return <p className="account-note">Loading…</p>
  if (!list.length) return <p className="account-note">No notifications. You are told here when a card you submitted for play is supported or declined.</p>
  return (
    <div className="messages">
      {list.some((m) => !m.read) && (
        <div className="messages-bar">
          <button className="chip" type="button" onClick={readAll}>
            Mark all read
          </button>
        </div>
      )}
      <ul className="messages-list">
        {list.map((message) => (
          <li key={message.id} className={message.read ? 'message' : 'message message-unread'}>
            <button
              className="message-open"
              type="button"
              onClick={() => {
                read(message)
                if (message.link) {
                  window.location.hash = message.link
                  props.onGo()
                }
              }}
              title={message.link ? 'Open it' : 'Mark it read'}
            >
              <span className="message-subject">{message.subject}</span>
              <span className="message-when">{when(message.createdAt)}</span>
              {message.body && <span className="message-body">{message.body}</span>}
            </button>
            <button className="message-remove" type="button" title="Delete" aria-label="Delete" onClick={() => remove(message)}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Mail from people: opened, it is read and can be answered. Anyone may write to the admins (each
// has a copy); an admin, to anyone.
export function MailTab(props: { session: Session; onChange: () => void }) {
  const { session, onChange } = props
  const [box, setBox] = useState<'inbox' | 'sent'>('inbox')
  const { list, setList, error, load } = useMessages(session, 'mail', box === 'sent')
  const [open, setOpen] = useState<number | null>(null)
  const [writing, setWriting] = useState<{ to: string; subject: string; body: string; replyTo?: number } | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  const show = async (message: Message) => {
    setOpen(open === message.id ? null : message.id)
    if (message.read || box === 'sent') return
    setList((now) => now && now.map((m) => (m.id === message.id ? { ...m, read: true } : m)))
    await api('/api/messages/read', { method: 'POST', body: { id: message.id }, token: session.token }).catch(() => undefined)
    onChange()
  }
  const remove = async (message: Message) => {
    setList((now) => now && now.filter((m) => m.id !== message.id))
    await api(`/api/messages/${message.id}`, { method: 'DELETE', token: session.token }).catch(() => undefined)
    onChange()
  }
  const send = async () => {
    if (!writing) return
    setSending(true)
    setSendError(null)
    try {
      await api('/api/messages', {
        method: 'POST',
        body: writing.replyTo ? { replyTo: writing.replyTo, body: writing.body } : { to: writing.to, subject: writing.subject, body: writing.body },
        token: session.token,
      })
      setSent(`Sent to ${writing.to}.`)
      setWriting(null)
      if (box === 'sent') load()
    } catch (err) {
      setSendError((err as Error).message)
    }
    setSending(false)
  }

  const compose = writing && (
    <div className="message-compose">
      {writing.replyTo ? (
        <p className="account-note">
          To {writing.to}: {writing.subject}
        </p>
      ) : (
        <>
          {session.user.isAdmin ? (
            <input
              className="message-input"
              placeholder="To: a username, or Admins"
              value={writing.to}
              onChange={(e) => setWriting({ ...writing, to: e.target.value })}
            />
          ) : (
            <p className="account-note">To the Admins: each of them gets it, and their answer comes back here.</p>
          )}
          <input
            className="message-input"
            placeholder="Subject"
            maxLength={120}
            value={writing.subject}
            onChange={(e) => setWriting({ ...writing, subject: e.target.value })}
          />
        </>
      )}
      <textarea
        className="message-input"
        rows={5}
        maxLength={4000}
        placeholder="Your message"
        value={writing.body}
        onChange={(e) => setWriting({ ...writing, body: e.target.value })}
      />
      {sendError && <p className="account-error">{sendError}</p>}
      <div className="account-buttons">
        <button className="button" type="button" onClick={() => setWriting(null)}>
          Cancel
        </button>
        <button
          className="button button-primary"
          type="button"
          disabled={sending || !writing.body.trim() || (!writing.replyTo && (!writing.to.trim() || !writing.subject.trim()))}
          onClick={send}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )

  return (
    <div className="messages">
      <div className="messages-bar">
        <button className="chip" type="button" aria-pressed={box === 'inbox'} onClick={() => (setBox('inbox'), setOpen(null))}>
          Inbox
        </button>
        <button className="chip" type="button" aria-pressed={box === 'sent'} onClick={() => (setBox('sent'), setOpen(null))}>
          Sent
        </button>
        {!writing && (
          <button
            className="chip"
            type="button"
            title={session.user.isAdmin ? 'Write to anyone, or to the Admins' : 'Write to the admins: a question, a bug, an idea'}
            onClick={() => (setSent(null), setWriting({ to: 'Admins', subject: '', body: '' }))}
          >
            {session.user.isAdmin ? 'New mail' : 'Write to the Admins'}
          </button>
        )}
      </div>
      {sent && <p className="account-note">{sent}</p>}
      {compose}
      {error && !list ? (
        <p className="account-error">{error}</p>
      ) : !list ? (
        <p className="account-note">Loading…</p>
      ) : !list.length ? (
        <p className="account-note">{box === 'inbox' ? 'No mail yet.' : 'You have not sent any mail.'}</p>
      ) : (
        <ul className="messages-list">
          {list.map((message) => (
            <li key={message.id} className={message.read || box === 'sent' ? 'message' : 'message message-unread'}>
              <button className="message-open" type="button" onClick={() => show(message)}>
                <span className="message-subject">
                  {box === 'sent' ? `To ${message.to}` : message.from ?? 'Someone'}
                  {box === 'inbox' && message.fromAdmin && <span className="message-tag">Admin</span>}
                  {box === 'inbox' && message.toAdmins && <span className="message-tag">To the Admins</span>} · {message.subject}
                </span>
                <span className="message-when">{when(message.createdAt)}</span>
                {open === message.id && <span className="message-body message-full">{message.body}</span>}
              </button>
              {box === 'inbox' && (
                <button className="message-remove" type="button" title="Delete" aria-label="Delete" onClick={() => remove(message)}>
                  ×
                </button>
              )}
              {open === message.id && box === 'inbox' && message.from && !writing && (
                <div className="message-actions">
                  <button
                    className="button"
                    type="button"
                    onClick={() =>
                      (setSent(null),
                      setWriting({
                        to: message.from!,
                        subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
                        body: '',
                        replyTo: message.id,
                      }))
                    }
                  >
                    Reply
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

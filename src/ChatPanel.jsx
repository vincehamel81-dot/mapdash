import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, isSupabaseConfigured } from './supabaseClient'
import { MODE_CONFIG } from './App'

const MESSAGE_PAGE_SIZE = 100
// Heartbeat writes last_seen every 20s (NameGate.jsx) - a stale row whose owner's tab crashed or
// closed without the beforeunload cleanup firing (the only way it's otherwise removed) will just
// stop getting fresher than this, so treat anything older as offline rather than showing it
// forever. Generous 4.5x margin over the heartbeat interval to tolerate normal network hiccups.
const ONLINE_STALE_MS = 90000

// One merged chat feed instead of separate per-person "walls": friendship is now a request/accept
// flow (not an auto-follow), and once mutual, both people's messages fold into the same single
// timeline - you never "select" a person to view, you just see everything from yourself + anyone
// you're mutually connected to, chronologically. A friend of a friend you're not yourself mutually
// connected to is invisible to you, even inside a message thread they're part of - visibility is
// purely "am I mutually accepted with the sender", nothing more.
export default function ChatPanel({ myName, onRequestJoin }) {
  const [open, setOpen] = useState(false)
  const [onlinePlayers, setOnlinePlayers] = useState([])
  const [friendRows, setFriendRows] = useState([]) // every row where I'm the follower, any status
  const [incomingRequests, setIncomingRequests] = useState([]) // rows where I'm followed, status='pending'
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  // Baseline for the unread badge - only messages newer than this (and not sent by me) count,
  // so opening chat for the first time in a session doesn't dump the entire 100-message history
  // in as "unread". Bumped to now every time chat is opened (marks everything seen).
  const [lastSeenAt, setLastSeenAt] = useState(() => Date.now())

  const myNameLower = myName.toLowerCase()

  useEffect(() => {
    if (!isSupabaseConfigured) return
    let cancelled = false

    const fetchOnline = () =>
      supabase
        .from('online_players')
        .select('name_lower, display_name, room_code, room_mode, room_status, last_seen')
        .neq('name_lower', myNameLower)
        .gte('last_seen', new Date(Date.now() - ONLINE_STALE_MS).toISOString())

    fetchOnline().then(({ data }) => {
      if (!cancelled && data) setOnlinePlayers(data)
    })

    const channel = supabase
      .channel('online_players-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'online_players' }, () => {
        fetchOnline().then(({ data }) => {
          if (data) setOnlinePlayers(data)
        })
      })
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [myNameLower])

  const refreshFriends = useCallback(() => {
    if (!isSupabaseConfigured) return
    supabase
      .from('friends')
      .select('followed_name_lower, followed_display_name, status')
      .eq('follower_name_lower', myNameLower)
      .then(({ data }) => { if (data) setFriendRows(data) })
    supabase
      .from('friends')
      .select('follower_name_lower, status')
      .eq('followed_name_lower', myNameLower)
      .eq('status', 'pending')
      .then(({ data }) => { if (data) setIncomingRequests(data) })
  }, [myNameLower])

  useEffect(() => {
    refreshFriends()
  }, [refreshFriends])

  // Both directions matter now (a request I sent, and a request sent to me), so this subscription
  // watches the whole table rather than filtering by follower_name_lower - there's no single
  // column filter that covers "either side of a row involving me".
  useEffect(() => {
    if (!isSupabaseConfigured) return
    const channel = supabase
      .channel(`friends-${myNameLower}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friends' }, refreshFriends)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [myNameLower, refreshFriends])

  const requestFriend = useCallback((nameLower, displayName) => {
    if (!isSupabaseConfigured) return
    supabase
      .from('friends')
      .upsert({ follower_name_lower: myNameLower, followed_name_lower: nameLower, followed_display_name: displayName, status: 'pending' })
      .then(() => refreshFriends())
  }, [myNameLower, refreshFriends])

  const acceptRequest = useCallback((requesterNameLower, requesterDisplayName) => {
    if (!isSupabaseConfigured) return
    // Confirm the incoming row, and mirror one back the other way so a simple
    // "follower_name_lower = me" query (used everywhere else) finds this friendship too - mutual
    // friendship is represented as both directions existing with status='accepted'.
    supabase
      .from('friends')
      .update({ status: 'accepted' })
      .eq('follower_name_lower', requesterNameLower)
      .eq('followed_name_lower', myNameLower)
      .then(() => {
        supabase
          .from('friends')
          .upsert({ follower_name_lower: myNameLower, followed_name_lower: requesterNameLower, followed_display_name: requesterDisplayName, status: 'accepted' })
          .then(() => refreshFriends())
      })
  }, [myNameLower, refreshFriends])

  const declineRequest = useCallback((requesterNameLower) => {
    if (!isSupabaseConfigured) return
    supabase
      .from('friends')
      .delete()
      .eq('follower_name_lower', requesterNameLower)
      .eq('followed_name_lower', myNameLower)
      .then(() => refreshFriends())
  }, [myNameLower, refreshFriends])

  const removeFriend = useCallback((nameLower) => {
    if (!isSupabaseConfigured) return
    // Removes both directions of an accepted friendship (or a pending request either way).
    Promise.all([
      supabase.from('friends').delete().eq('follower_name_lower', myNameLower).eq('followed_name_lower', nameLower),
      supabase.from('friends').delete().eq('follower_name_lower', nameLower).eq('followed_name_lower', myNameLower)
    ]).then(() => refreshFriends())
  }, [myNameLower, refreshFriends])

  const acceptedFriends = useMemo(() => friendRows.filter((f) => f.status === 'accepted'), [friendRows])
  const pendingSentSet = useMemo(() => new Set(friendRows.filter((f) => f.status === 'pending').map((f) => f.followed_name_lower)), [friendRows])
  const acceptedLowerSet = useMemo(() => new Set(acceptedFriends.map((f) => f.followed_name_lower)), [acceptedFriends])

  // The merged feed: everyone I'm mutually accepted with, plus myself. Re-fetched on any message
  // insert anywhere (no per-sender filter possible for an "IN (...)" style list via postgres_changes)
  // rather than trying to filter server-side - message volume here is low enough that this is fine.
  // Runs regardless of `open` (not gated on the panel being visible) so the unread badge can count
  // new messages while chat is closed, not just while it's open.
  useEffect(() => {
    if (!isSupabaseConfigured) return
    let cancelled = false
    const senders = [myNameLower, ...acceptedLowerSet]

    const load = () => {
      supabase
        .from('messages')
        .select('id, sender_name_lower, sender_display_name, body, created_at')
        .in('sender_name_lower', senders)
        .order('created_at', { ascending: false })
        .limit(MESSAGE_PAGE_SIZE)
        .then(({ data }) => {
          if (!cancelled && data) setMessages(data.slice().reverse())
        })
    }
    load()

    const channel = supabase
      .channel(`messages-${myNameLower}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, load)
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myNameLower, acceptedFriends.length])

  const sendMessage = useCallback((e) => {
    e.preventDefault()
    const body = draft.trim()
    if (!body || !isSupabaseConfigured) return
    supabase.from('messages').insert({ sender_name_lower: myNameLower, sender_display_name: myName, body }).then(() => {
      supabase
        .from('messages')
        .delete()
        .eq('sender_name_lower', myNameLower)
        .lt('created_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())
        .then(() => {})
    })
    setDraft('')
  }, [draft, myNameLower, myName])

  const onlineByName = useMemo(() => new Map(onlinePlayers.map((p) => [p.name_lower, p])), [onlinePlayers])
  // Anyone already shown in Friends shouldn't also show up in Online - same person, same status
  // dot either way, just duplicated real estate.
  const onlineNonFriends = useMemo(() => onlinePlayers.filter((p) => !acceptedLowerSet.has(p.name_lower)), [onlinePlayers, acceptedLowerSet])

  const unreadCount = useMemo(
    () => messages.filter((m) => m.sender_name_lower !== myNameLower && new Date(m.created_at).getTime() > lastSeenAt).length,
    [messages, myNameLower, lastSeenAt]
  )

  const toggleOpen = () => {
    setOpen((o) => {
      if (!o) setLastSeenAt(Date.now())
      return !o
    })
  }

  // green = actively playing a round, yellow = online (in a room's lobby or just browsing), red =
  // not online at all. `online` is undefined for a friend who isn't in the (already
  // staleness-filtered) onlinePlayers list.
  function statusColor(online) {
    if (!online) return 'red'
    if (online.room_code && online.room_status === 'playing') return 'green'
    return 'yellow'
  }

  function statusLabel(online) {
    if (!online) return 'Offline'
    if (online.room_code && online.room_status === 'playing') return `In-game (${MODE_CONFIG[online.room_mode]?.label || online.room_mode})`
    if (online.room_code) return 'Lobby'
    return 'Online'
  }

  function formatTime(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className={`chat-panel ${open ? 'open' : 'collapsed'}`}>
      <button className="chat-toggle" onClick={toggleOpen}>
        {open ? 'Close chat' : 'Chat'}
        {!open && unreadCount ? <span className="chat-unread-badge">{unreadCount > 99 ? '99+' : unreadCount}</span> : null}
      </button>
      {open ? (
        !isSupabaseConfigured ? (
          <div className="chat-body chat-unavailable">Chat isn't connected yet.</div>
        ) : (
          <div className="chat-body">
            <div className="chat-contacts">
              {incomingRequests.length ? (
                <>
                  <div className="chat-section-title">Requests</div>
                  {incomingRequests.map((r) => {
                    const requesterOnline = onlineByName.get(r.follower_name_lower)
                    const displayName = requesterOnline?.display_name || r.follower_name_lower
                    return (
                      <div key={r.follower_name_lower} className="chat-contact-row">
                        <span>{displayName}</span>
                        <button className="chat-join" onClick={() => acceptRequest(r.follower_name_lower, displayName)}>Accept</button>
                        <button className="chat-remove" onClick={() => declineRequest(r.follower_name_lower)} title="Decline">x</button>
                      </div>
                    )
                  })}
                </>
              ) : null}
              <div className="chat-section-title">Friends</div>
              {acceptedFriends.map((f) => {
                const online = onlineByName.get(f.followed_name_lower)
                return (
                  <div key={f.followed_name_lower} className="chat-contact-row">
                    <span className={`chat-status-dot chat-status-${statusColor(online)}`} />
                    <span>{f.followed_display_name}</span>
                    <span className="chat-status-label">{statusLabel(online)}</span>
                    {online?.room_code ? (
                      <button className="chat-join" onClick={() => onRequestJoin?.(online.room_code)} title="Join their room">Join</button>
                    ) : null}
                    <button className="chat-remove" onClick={() => removeFriend(f.followed_name_lower)} title="Remove friend">x</button>
                  </div>
                )
              })}
              <div className="chat-section-title">Online</div>
              {onlineNonFriends.map((p) => (
                <div key={p.name_lower} className="chat-contact-row">
                  <span className={`chat-status-dot chat-status-${statusColor(p)}`} />
                  <span>{p.display_name}</span>
                  <span className="chat-status-label">{statusLabel(p)}</span>
                  {p.room_code ? (
                    <button className="chat-join" onClick={() => onRequestJoin?.(p.room_code)} title="Join their room">Join</button>
                  ) : null}
                  {pendingSentSet.has(p.name_lower) ? (
                    <span className="chat-following">requested</span>
                  ) : (
                    <button onClick={() => requestFriend(p.name_lower, p.display_name)}>+ add</button>
                  )}
                </div>
              ))}
            </div>
            <div className="chat-feed">
              <div className="chat-messages">
                {messages.map((m) => (
                  <div key={m.id} className="chat-message">
                    <div className="chat-message-head">
                      <strong>{m.sender_display_name}</strong>
                      <span className="chat-message-time">{formatTime(m.created_at)}</span>
                    </div>
                    <span>{m.body}</span>
                  </div>
                ))}
              </div>
              <form className="chat-compose" onSubmit={sendMessage}>
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Say something..." maxLength={500} />
                <button type="submit">Send</button>
              </form>
            </div>
          </div>
        )
      ) : null}
    </div>
  )
}

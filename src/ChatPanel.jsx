import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, isSupabaseConfigured } from './supabaseClient'

const MESSAGE_PAGE_SIZE = 100

// Each person has one message "wall" they post to; adding someone as a friend (a one-directional
// follow) lets you read their wall. There's no per-pair DM thread - selecting yourself shows your
// own wall (read+write), selecting a friend shows theirs (read-only), matching the "one feed per
// person, readable by their friends" model.
export default function ChatPanel({ myName, onRequestJoin }) {
  const [open, setOpen] = useState(false)
  const [onlinePlayers, setOnlinePlayers] = useState([])
  const [friends, setFriends] = useState([])
  const [selected, setSelected] = useState('me')
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')

  const myNameLower = myName.toLowerCase()

  useEffect(() => {
    if (!isSupabaseConfigured) return
    let cancelled = false

    supabase.from('online_players').select('name_lower, display_name, room_code').neq('name_lower', myNameLower).then(({ data }) => {
      if (!cancelled && data) setOnlinePlayers(data)
    })

    const channel = supabase
      .channel('online_players-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'online_players' }, () => {
        supabase.from('online_players').select('name_lower, display_name, room_code').neq('name_lower', myNameLower).then(({ data }) => {
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
      .select('followed_name_lower, followed_display_name')
      .eq('follower_name_lower', myNameLower)
      .then(({ data }) => { if (data) setFriends(data) })
  }, [myNameLower])

  useEffect(() => {
    refreshFriends()
  }, [refreshFriends])

  const addFriend = useCallback((nameLower, displayName) => {
    if (!isSupabaseConfigured) return
    supabase
      .from('friends')
      .upsert({ follower_name_lower: myNameLower, followed_name_lower: nameLower, followed_display_name: displayName })
      .then(() => refreshFriends())
  }, [myNameLower, refreshFriends])

  const removeFriend = useCallback((nameLower) => {
    if (!isSupabaseConfigured) return
    supabase
      .from('friends')
      .delete()
      .eq('follower_name_lower', myNameLower)
      .eq('followed_name_lower', nameLower)
      .then(() => {
        refreshFriends()
        setSelected((current) => (current === nameLower ? 'me' : current))
      })
  }, [myNameLower, refreshFriends])

  const canViewSelected = selected === 'me' || friends.some((f) => f.followed_name_lower === selected)

  useEffect(() => {
    if (!isSupabaseConfigured || !open || !canViewSelected) return
    const wallOwner = selected === 'me' ? myNameLower : selected
    let cancelled = false

    const load = () => {
      supabase
        .from('messages')
        .select('id, sender_display_name, body, created_at')
        .eq('sender_name_lower', wallOwner)
        .order('created_at', { ascending: false })
        .limit(MESSAGE_PAGE_SIZE)
        .then(({ data }) => {
          if (!cancelled && data) setMessages(data.slice().reverse())
        })
    }
    load()

    const channel = supabase
      .channel(`messages-${wallOwner}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `sender_name_lower=eq.${wallOwner}` }, load)
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [selected, canViewSelected, open, myNameLower])

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

  const friendLowerSet = useMemo(() => new Set(friends.map((f) => f.followed_name_lower)), [friends])
  const onlineByName = useMemo(() => new Map(onlinePlayers.map((p) => [p.name_lower, p])), [onlinePlayers])

  return (
    <div className={`chat-panel ${open ? 'open' : 'collapsed'}`}>
      <button className="chat-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? 'Close chat' : 'Chat'}
      </button>
      {open ? (
        !isSupabaseConfigured ? (
          <div className="chat-body chat-unavailable">Chat isn't connected yet.</div>
        ) : (
          <div className="chat-body">
            <div className="chat-contacts">
              <button className={selected === 'me' ? 'selected' : ''} onClick={() => setSelected('me')}>Me</button>
              <div className="chat-section-title">Friends</div>
              {friends.map((f) => (
                <div key={f.followed_name_lower} className="chat-contact-row">
                  <button className={selected === f.followed_name_lower ? 'selected' : ''} onClick={() => setSelected(f.followed_name_lower)}>
                    {f.followed_display_name}
                  </button>
                  {onlineByName.get(f.followed_name_lower)?.room_code ? (
                    <button className="chat-join" onClick={() => onRequestJoin?.(onlineByName.get(f.followed_name_lower).room_code)} title="Join their room">Join</button>
                  ) : null}
                  <button className="chat-remove" onClick={() => removeFriend(f.followed_name_lower)} title="Remove friend">x</button>
                </div>
              ))}
              <div className="chat-section-title">Online</div>
              {onlinePlayers.map((p) => (
                <div key={p.name_lower} className="chat-contact-row">
                  <span>{p.display_name}</span>
                  {p.room_code ? (
                    <button className="chat-join" onClick={() => onRequestJoin?.(p.room_code)} title="Join their room">Join</button>
                  ) : null}
                  {friendLowerSet.has(p.name_lower) ? (
                    <span className="chat-following">following</span>
                  ) : (
                    <button onClick={() => addFriend(p.name_lower, p.display_name)}>+ add</button>
                  )}
                </div>
              ))}
            </div>
            <div className="chat-feed">
              <div className="chat-messages">
                {messages.map((m) => (
                  <div key={m.id} className="chat-message">
                    <strong>{m.sender_display_name}</strong>
                    <span>{m.body}</span>
                  </div>
                ))}
              </div>
              {selected === 'me' ? (
                <form className="chat-compose" onSubmit={sendMessage}>
                  <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Say something..." maxLength={500} />
                  <button type="submit">Send</button>
                </form>
              ) : null}
            </div>
          </div>
        )
      ) : null}
    </div>
  )
}

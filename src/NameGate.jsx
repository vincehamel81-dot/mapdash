import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase, isSupabaseConfigured } from './supabaseClient'

const SESSION_KEY = 'mapdashrun_claimed_name'
const HEARTBEAT_MS = 20000
const STALE_AFTER_MS = 60000

function isValidName(raw) {
  const trimmed = raw.trim()
  return trimmed.length >= 2 && trimmed.length <= 20
}

// Claims a case-insensitive-unique display name against `online_players`, keeps it alive with a
// heartbeat, and only then renders the app. Falls back to a purely local name (no backend call)
// when Supabase isn't configured yet, so the rest of the app stays usable/testable without it.
export default function NameGate({ children }) {
  const [claimedName, setClaimedName] = useState(() => sessionStorage.getItem(SESSION_KEY) || null)
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const heartbeatRef = useRef(null)

  const startHeartbeat = useCallback((nameLower) => {
    if (!isSupabaseConfigured) return
    if (heartbeatRef.current) clearInterval(heartbeatRef.current)
    heartbeatRef.current = window.setInterval(() => {
      supabase.from('online_players').update({ last_seen: new Date().toISOString() }).eq('name_lower', nameLower)
    }, HEARTBEAT_MS)
  }, [])

  useEffect(() => {
    if (!claimedName) return
    startHeartbeat(claimedName.toLowerCase())
    const cleanup = () => {
      if (!isSupabaseConfigured) return
      supabase.from('online_players').delete().eq('name_lower', claimedName.toLowerCase())
    }
    window.addEventListener('beforeunload', cleanup)
    return () => {
      window.removeEventListener('beforeunload', cleanup)
      if (heartbeatRef.current) clearInterval(heartbeatRef.current)
    }
  }, [claimedName, startHeartbeat])

  const claimName = useCallback(async (raw) => {
    const displayName = raw.trim()
    if (!isValidName(displayName)) {
      setError('Name must be 2-20 characters.')
      return
    }
    const nameLower = displayName.toLowerCase()

    if (!isSupabaseConfigured) {
      sessionStorage.setItem(SESSION_KEY, displayName)
      setClaimedName(displayName)
      return
    }

    setChecking(true)
    setError('')
    try {
      const { data: existing, error: fetchError } = await supabase
        .from('online_players')
        .select('last_seen')
        .eq('name_lower', nameLower)
        .maybeSingle()
      if (fetchError) throw fetchError

      if (existing) {
        const age = Date.now() - new Date(existing.last_seen).getTime()
        if (age < STALE_AFTER_MS) {
          setError('Name is already in use.')
          setChecking(false)
          return
        }
      }

      const { error: upsertError } = await supabase
        .from('online_players')
        .upsert({ name_lower: nameLower, display_name: displayName, last_seen: new Date().toISOString() })
      if (upsertError) throw upsertError

      sessionStorage.setItem(SESSION_KEY, displayName)
      setClaimedName(displayName)
    } catch (err) {
      setError('Could not reach the server. Try again.')
    } finally {
      setChecking(false)
    }
  }, [])

  // Renames the claimed player: revalidates + re-checks uniqueness exactly like the initial claim,
  // then cascades the new name across every table that stores it by convention (no foreign keys in
  // this schema - see supabase/schema.sql). Deliberately does NOT touch `rooms` - callers are
  // expected to only allow this while the player isn't in an active room, since room state has
  // several scattered name references (host, Tag's itName, Finder-Keeper's foundBy) that a rename
  // could easily leave inconsistent mid-round.
  const renameName = useCallback(async (raw) => {
    const displayName = raw.trim()
    if (!isValidName(displayName)) {
      return { success: false, error: 'Name must be 2-20 characters.' }
    }
    const nameLower = displayName.toLowerCase()
    const oldLower = claimedName.toLowerCase()
    if (nameLower === oldLower) {
      // Same name (possibly different casing/whitespace) - just normalize display locally.
      sessionStorage.setItem(SESSION_KEY, displayName)
      setClaimedName(displayName)
      return { success: true }
    }

    if (!isSupabaseConfigured) {
      sessionStorage.setItem(SESSION_KEY, displayName)
      setClaimedName(displayName)
      return { success: true }
    }

    try {
      const { data: existing, error: fetchError } = await supabase
        .from('online_players')
        .select('last_seen')
        .eq('name_lower', nameLower)
        .maybeSingle()
      if (fetchError) throw fetchError
      if (existing) {
        const age = Date.now() - new Date(existing.last_seen).getTime()
        if (age < STALE_AFTER_MS) {
          return { success: false, error: 'Name is already in use.' }
        }
      }

      const { error: playerError } = await supabase
        .from('online_players')
        .update({ name_lower: nameLower, display_name: displayName })
        .eq('name_lower', oldLower)
      if (playerError) throw playerError

      const { error: followerError } = await supabase
        .from('friends')
        .update({ follower_name_lower: nameLower })
        .eq('follower_name_lower', oldLower)
      if (followerError) throw followerError

      const { error: followedError } = await supabase
        .from('friends')
        .update({ followed_name_lower: nameLower, followed_display_name: displayName })
        .eq('followed_name_lower', oldLower)
      if (followedError) throw followedError

      const { error: messagesError } = await supabase
        .from('messages')
        .update({ sender_name_lower: nameLower, sender_display_name: displayName })
        .eq('sender_name_lower', oldLower)
      if (messagesError) throw messagesError

      sessionStorage.setItem(SESSION_KEY, displayName)
      setClaimedName(displayName)
      return { success: true }
    } catch (err) {
      return { success: false, error: 'Could not rename right now. Try again.' }
    }
  }, [claimedName])

  if (!claimedName) {
    return (
      <div className="name-gate">
        <form
          className="name-gate-form"
          onSubmit={(e) => {
            e.preventDefault()
            claimName(input)
          }}
        >
          <h1>MapDashRun</h1>
          <label htmlFor="name-gate-input">Enter your name</label>
          <input
            id="name-gate-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Your name"
            autoFocus
            maxLength={20}
          />
          {error ? <div className="name-gate-error">{error}</div> : null}
          <button type="submit" disabled={checking}>{checking ? 'Checking...' : 'Continue'}</button>
        </form>
      </div>
    )
  }

  return children(claimedName, renameName)
}
